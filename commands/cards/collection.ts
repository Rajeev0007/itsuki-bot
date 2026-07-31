import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import CardManager, { effectiveStats, type OwnedCard } from '../../managers/CardManager';
import { RARITIES, RARITY_ORDER, type Rarity } from '../../services/CardService';
import { renderCollection } from '../../services/CardCanvas';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import logger from '../../utils/Logger';

type SortKey = 'power' | 'rarity' | 'level' | 'name' | 'recent';

const SORTS: Array<{ id: SortKey; label: string }> = [
  { id: 'power',  label: 'Strongest first' },
  { id: 'rarity', label: 'Rarest first' },
  { id: 'level',  label: 'Highest level' },
  { id: 'recent', label: 'Recently claimed' },
  { id: 'name',   label: 'Name (A-Z)' },
];

export function sortCards(cards: OwnedCard[], key: SortKey): OwnedCard[] {
  const copy = [...cards];
  switch (key) {
    case 'rarity':
      return copy.sort((a, b) =>
        RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity)
        || effectiveStats(b).power - effectiveStats(a).power);
    case 'level':  return copy.sort((a, b) => (b.level || 1) - (a.level || 1));
    case 'recent': return copy.sort((a, b) => (b.claimedAt || 0) - (a.claimedAt || 0));
    case 'name':   return copy.sort((a, b) => a.name.localeCompare(b.name));
    case 'power':
    default:       return copy.sort((a, b) => effectiveStats(b).power - effectiveStats(a).power);
  }
}

/**
 * Builds one page of a collection.
 *
 * Exported so the pagination/sort buttons can rebuild a page without
 * duplicating any of this.
 */
export async function buildCollectionPage(opts: {
  userId: string;
  username: string;
  page: number;
  sort: SortKey;
  rarity: Rarity | 'all';
}): Promise<{ components: ContainerBuilder[]; files: AttachmentBuilder[] }> {
  const all = await CardManager.getCollection(opts.userId);
  const filtered = opts.rarity === 'all' ? all : all.filter((c) => c.rarity === opts.rarity);
  const sorted = sortCards(filtered, opts.sort);

  const perPage = config.cards.perPage;
  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  // Clamp so a stale button can't scroll past the end after cards are sold.
  const page = Math.min(Math.max(1, opts.page), totalPages);
  const slice = sorted.slice((page - 1) * perPage, page * perPage);

  const summary = await CardManager.summarise(opts.userId);
  const rarityLine = RARITY_ORDER
    .slice().reverse()
    .map((r) => `${RARITIES[r].emoji} ${summary.byRarity[r] ?? 0}`)
    .join('  ');

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      `# 🎴 ${opts.username}'s Collection`,
      `**${all.length}** unique · total power **${fmt.number(summary.power)}**`,
      rarityLine,
      opts.rarity !== 'all' ? `-# Filtered to ${RARITIES[opts.rarity].label}` : '',
    ].filter(Boolean).join('\n')));

  if (!slice.length) {
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        all.length
          ? '-# No cards match this filter.'
          : '-# No cards yet — use `/roll` to draw one!',
      ));
    return { components: [container], files: [] };
  }

  // Rendered grid, with a text list as the fallback.
  const files: AttachmentBuilder[] = [];
  try {
    const png = await renderCollection({
      username: opts.username, cards: slice, page, totalPages, totalCards: all.length,
    });
    files.push(new AttachmentBuilder(png, { name: 'collection.png' }));
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://collection.png')),
    );
  } catch (err) {
    logger.warn(`[collection] Grid render failed, using text list: ${(err as Error).message}`);
    const lines = slice.map((c) => {
      const s = effectiveStats(c);
      return `${RARITIES[c.rarity].emoji} **${c.name}** — Lv.${c.level} · ATK ${fmt.number(s.attack)} · HP ${fmt.number(s.health)}`;
    });
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
  }

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Page ${page} of ${totalPages}`));

  // Sort selector
  container.addActionRowComponents(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`card_sort:${opts.userId}:${page}:${opts.rarity}`)
        .setPlaceholder('Sort by…')
        .addOptions(SORTS.map((s) => ({
          label: s.label, value: s.id, default: s.id === opts.sort,
        }))),
    ),
  );

  // Pagination — only when there's more than one page.
  if (totalPages > 1) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`card_page:${opts.userId}:${page - 1}:${opts.sort}:${opts.rarity}`)
          .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
        new ButtonBuilder().setCustomId('card_page_display').setLabel(`${page} / ${totalPages}`)
          .setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId(`card_page:${opts.userId}:${page + 1}:${opts.sort}:${opts.rarity}`)
          .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages),
      ),
    );
  }

  return { components: [container], files };
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('collection').setDescription('View your anime card collection.')
    .addUserOption((o) => o.setName('user').setDescription('Whose collection to view'))
    .addStringOption((o) => o.setName('rarity').setDescription('Only show one rarity')
      .addChoices(...RARITY_ORDER.map((r) => ({ name: RARITIES[r].label, value: r }))))
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  category: 'cards',
  aliases: ['cards', 'col'],
  cooldown: 4_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const target = interaction.options.getUser('user') ?? interaction.user;
    const rarity = (interaction.options.getString('rarity') ?? 'all') as Rarity | 'all';
    const page   = interaction.options.getInteger('page') ?? 1;

    if (rarity !== 'all' && !RARITY_ORDER.includes(rarity)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Rarity',
        `Pick one of: ${RARITY_ORDER.map((r) => `\`${r}\``).join(', ')}.`,
      ) } as never);
    }

    const payload = await buildCollectionPage({
      userId: target.id, username: target.username, page, sort: 'power', rarity,
    });
    await interaction.editReply(payload as never);
  },
});
