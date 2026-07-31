import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder,
  type ChatInputCommandInteraction, type Guild, type Client,
} from 'discord.js';
import { Command } from '../../structures/Command';
import UserManager from '../../managers/UserManager';
import StatsManager from '../../managers/StatsManager';
import CardManager from '../../managers/CardManager';
import { renderLeaderboard, type LeaderboardRow } from '../../services/StatsCanvas';
import { resolveDisplayName } from '../../utils/UserResolver';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import { MEDALS } from '../../utils/Constants';
import logger from '../../utils/Logger';

const PER_PAGE = 10;

type Scope = 'global' | 'guild';

interface Board {
  id: string;
  label: string;
  description: string;
  scope: Scope;
  format: (v: number) => string;
  fetch: (ctx: { guild: Guild | null; limit: number }) => Promise<Array<{ userId: string; value: number }>>;
}

/**
 * Every leaderboard the select menu offers.
 *
 * `scope` matters: economy/level data is global (shared across servers), while
 * activity data is per-guild. Mixing them silently would make the numbers look
 * wrong, so the footer states which is which.
 */
export const BOARDS: Board[] = [
  {
    id: 'netWorth', label: 'Net Worth', description: 'Wallet + bank', scope: 'global',
    format: (v) => fmt.coins(v),
    fetch: ({ limit }) => UserManager.getLeaderboard('netWorth', limit),
  },
  {
    id: 'level', label: 'Level', description: 'Highest level', scope: 'global',
    format: (v) => `Level ${fmt.number(v)}`,
    fetch: ({ limit }) => UserManager.getLeaderboard('level', limit),
  },
  {
    id: 'totalEarned', label: 'Total Earned', description: 'Lifetime coins earned', scope: 'global',
    format: (v) => fmt.coins(v),
    fetch: ({ limit }) => UserManager.getLeaderboard('totalEarned', limit),
  },
  {
    id: 'gamesWon', label: 'Games Won', description: 'Wins across all games', scope: 'global',
    format: (v) => `${fmt.number(v)} wins`,
    fetch: ({ limit }) => UserManager.getLeaderboard('gamesWon', limit),
  },
  {
    id: 'messages', label: 'Messages', description: 'Most messages in this server', scope: 'guild',
    format: (v) => `${fmt.number(v)} msgs`,
    fetch: ({ guild, limit }) => guild ? StatsManager.getLeaderboard(guild.id, 'messages', limit) : Promise.resolve([]),
  },
  {
    id: 'voice', label: 'Voice Time', description: 'Most time in voice channels', scope: 'guild',
    format: (v) => fmt.duration(v * 1000),
    fetch: ({ guild, limit }) => guild ? StatsManager.getLeaderboard(guild.id, 'voiceSeconds', limit) : Promise.resolve([]),
  },
  {
    id: 'messages7d', label: 'Messages (7 days)', description: 'Most active this week', scope: 'guild',
    format: (v) => `${fmt.number(v)} msgs`,
    fetch: ({ guild, limit }) => guild ? StatsManager.getLeaderboard(guild.id, 'messages', limit, 7) : Promise.resolve([]),
  },
  {
    id: 'cardPower', label: 'Card Power', description: 'Strongest card collections', scope: 'global',
    format: (v) => `${fmt.number(v)} PWR`,
    // Card power isn't stored pre-aggregated, so it's summed on demand.
    fetch: ({ limit }) => CardManager.powerLeaderboard(limit),
  },
];

export function findBoard(id: string): Board {
  return BOARDS.find((b) => b.id === id) ?? BOARDS[0];
}

/**
 * Builds a leaderboard page. Exported so the select menu and pagination
 * buttons rebuild it through exactly the same path.
 */
export async function buildLeaderboardPage(opts: {
  boardId: string;
  page: number;
  viewerId: string;
  guild: Guild | null;
  client: Client;
}): Promise<{ components: ContainerBuilder[]; files: AttachmentBuilder[] }> {
  const board = findBoard(opts.boardId);

  if (board.scope === 'guild' && !opts.guild) {
    return {
      components: CB.errorResponse(
        'Server Only Leaderboard',
        `**${board.label}** tracks activity in a specific server, so it isn't available in DMs. Try a global board like Net Worth or Level.`,
      ).components,
      files: [],
    };
  }

  // Fetch more than one page so pagination has something to move through.
  const entries = await board.fetch({ guild: opts.guild, limit: PER_PAGE * 5 });
  const totalPages = Math.max(1, Math.ceil(entries.length / PER_PAGE));
  const page = Math.min(Math.max(1, opts.page), totalPages);
  const slice = entries.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const container = new ContainerBuilder();

  if (!slice.length) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `# 🏆 ${board.label}\n-# No data recorded yet.`,
    ));
    container.addActionRowComponents(buildSelect(board.id, opts.viewerId));
    return { components: [container], files: [] };
  }

  // Resolve names and avatars once, reused by both the canvas and text paths.
  const resolved = await Promise.all(slice.map(async (entry, i) => {
    const name = await resolveDisplayName(entry.userId, { guild: opts.guild, client: opts.client });
    const user = opts.client.users.cache.get(entry.userId);
    return {
      rank: (page - 1) * PER_PAGE + i + 1,
      name,
      value: board.format(entry.value),
      avatarUrl: user?.displayAvatarURL({ extension: 'png', size: 64 }) ?? null,
      isViewer: entry.userId === opts.viewerId,
    } satisfies LeaderboardRow;
  }));

  const scopeNote = board.scope === 'guild'
    ? `Activity in ${opts.guild?.name ?? 'this server'}`
    : 'Across every server';

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `# 🏆 ${board.label}\n-# ${board.description} · ${scopeNote}`,
  ));

  const files: AttachmentBuilder[] = [];
  try {
    const png = await renderLeaderboard({
      title: board.label, subtitle: scopeNote, rows: resolved, page, totalPages,
    });
    files.push(new AttachmentBuilder(png, { name: 'leaderboard.png' }));
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://leaderboard.png')),
    );
  } catch (err) {
    logger.warn(`[leaderboard] Canvas render failed, using text table: ${(err as Error).message}`);
    const lines = resolved.map((r) =>
      `${MEDALS[r.rank - 1] ?? `\`#${r.rank}\``} **${r.name}** — ${r.value}${r.isViewer ? '  ← you' : ''}`,
    );
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
  }

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Page ${page} of ${totalPages}`));

  container.addActionRowComponents(buildSelect(board.id, opts.viewerId));

  if (totalPages > 1) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`lb_page:${board.id}:${page - 1}:${opts.viewerId}`)
          .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
        new ButtonBuilder().setCustomId('lb_page_display').setLabel(`${page} / ${totalPages}`)
          .setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId(`lb_page:${board.id}:${page + 1}:${opts.viewerId}`)
          .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages),
      ),
    );
  }

  return { components: [container], files };
}

function buildSelect(currentId: string, viewerId: string): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`lb_select:${viewerId}`)
      .setPlaceholder('Choose a leaderboard…')
      .addOptions(BOARDS.map((b) => ({
        label: b.label,
        description: b.description.slice(0, 100),
        value: b.id,
        default: b.id === currentId,
      }))),
  );
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('leaderboard').setDescription('Server and global rankings.')
    .addStringOption((o) => o.setName('board').setDescription('Which leaderboard to show')
      .addChoices(...BOARDS.map((b) => ({ name: b.label, value: b.id }))))
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  category: 'leaderboard',
  aliases: ['lb', 'top'],
  cooldown: 5_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const boardId = interaction.options.getString('board') ?? BOARDS[0].id;
    const page = interaction.options.getInteger('page') ?? 1;

    const payload = await buildLeaderboardPage({
      boardId, page,
      viewerId: interaction.user.id,
      guild: interaction.guild,
      client: interaction.client,
    });
    await interaction.editReply(payload as never);
  },
});
