/**
 * @file help.ts
 * @description Professional help menu with a category select menu inside a V2 container.
 */

import {
  SlashCommandBuilder, MessageFlags,
  ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder,
  SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction, type Client, Collection,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import config      from '../../config/config';
import { getStore } from '../../database/Store';

const guildsDB = getStore('guilds');

// ── Category definitions ──────────────────────────────────────────────────────
// Ordered deliberately: the bot's main draws first (economy/games/social),
// reference/meta categories last. Owner tools are handled separately below
// and only shown to actual bot owners.
const CATEGORIES: Record<string, { label: string; desc: string; color: number; commands: string[] }> = {
  economy:     { label: 'Economy',     desc: 'Earn, spend, and manage your coins',               color: config.colors.gold,    commands: ['balance','daily','weekly','work','crime','rob','beg','search','deposit','withdraw','transfer','prestige','richest'] },
  gambling:    { label: 'Gambling',    desc: 'Risk your coins for big rewards',                   color: config.colors.danger,  commands: ['slots','blackjack','coinflip','dice','roulette','crash','mines'] },
  games:       { label: 'Games',       desc: 'Play against friends or the bot for fun and coins', color: config.colors.teal,    commands: ['akinator','hangman','connect4','tictactoe','rps','trivia'] },
  social:      { label: 'Social',      desc: 'Interact and emote with other users',               color: config.colors.social,  commands: ['hug','kiss','pat','slap','cuddle','bonk','wave','dance','cry','poke'] },
  anime:       { label: 'Anime',       desc: 'Anime images and character search',                 color: config.colors.anime,   commands: ['anime','waifu'] },
  music:       { label: 'Music',       desc: 'Play music in voice channels',                      color: config.colors.purple,  commands: ['play','queue','skip','stop','leave','pause','resume','loop','nowplaying','seek','shuffle','volume','247','autoplay','setvoice'] },
  shop:        { label: 'Shop',        desc: 'Browse and buy items',                              color: config.colors.gold,    commands: ['shop'] },
  inventory:   { label: 'Inventory',   desc: 'View and manage your items',                        color: config.colors.info,    commands: ['inventory'] },
  pets:        { label: 'Pets',        desc: 'Hatch, feed, and level up virtual pets',             color: config.colors.success, commands: ['pet'] },
  profile:     { label: 'Profile',     desc: 'Your stats, XP, levels, and achievements',           color: config.colors.primary, commands: ['profile'] },
  leaderboard: { label: 'Leaderboard', desc: 'Global rankings and top players',                    color: config.colors.primary, commands: ['leaderboard'] },
  cards:       { label: 'Anime Cards', desc: 'Roll, collect, battle and auction anime characters',  color: config.colors.anime,   commands: ['roll','collection','card','upgrade','battle','auction'] },
  stats:       { label: 'Stats',       desc: 'Per-user activity tracking (server only)',            color: config.colors.teal,    commands: ['userstats'] },
  gaming:      { label: 'Game Stats',  desc: 'Minecraft, CS2 and Valorant lookups',                 color: config.colors.info,    commands: ['minecraft','cs2','valorant'] },
  moderation:  { label: 'Moderation',  desc: 'Keep your server in order (server only)',           color: config.colors.danger,  commands: ['ban','unban','kick','timeout','untimeout','warn','purge','slowmode','lock','modlog','verify','backup','welcomer'] },
  utility:     { label: 'Utility',     desc: 'Bot information and server tools',                  color: config.colors.dark,    commands: ['help','ping','stats','botbrand','vote','fetchfile','grab','steal','record','msgbuilder','redeem'] },
};

const OWNER_CATEGORY = {
  label: 'Owner', desc: 'Bot management tools (owners only)', color: config.colors.danger,
  commands: ['panel','botconfig','reload','voteconfig','premiumadmin','premiumkey','maintenance','blacklist','noprefix','eval','shutdown'],
};

function isOwner(userId: string): boolean {
  return config.owners.includes(userId);
}

/**
 * Commands that only work inside a server (they need a voice channel, guild
 * settings, or a second human player). Kept in sync with the server-only flag
 * declared on those commands, so DM users aren't shown things they can't run.
 */
const SERVER_ONLY = new Set([
  'play', 'queue', 'skip', 'stop', 'leave', 'pause', 'resume', 'loop',
  'nowplaying', 'seek', 'shuffle', 'volume', '247', 'autoplay', 'setvoice',
  'botbrand', 'tictactoe',
  // Moderation acts on servers, members and channels.
  'ban', 'unban', 'kick', 'timeout', 'untimeout', 'warn', 'purge',
  'slowmode', 'lock', 'modlog', 'verify', 'backup',
  // Activity is tracked per server.
  'userstats',
  // Needs a voice channel.
  'record',
  // Configures per-server vote channels.
  'voteconfig',
  // Reads server emojis, icons and channel messages.
  'grab',
  // Writes emojis and stickers into a server.
  'steal',
  // Needs a second human player.
  'connect4',
  // Configures per-server join/leave messages and posts into server channels.
  'welcomer', 'msgbuilder',
]);

/** Lists a category's server-only commands, for the DM notice. */
function serverOnlyIn(commands: string[]): string[] {
  return commands.filter((c) => SERVER_ONLY.has(c));
}

// ── Builders ──────────────────────────────────────────────────────────────────

function padName(name: string, width: number): string {
  return name.padEnd(width, ' ');
}

/** Renders a category's commands as an aligned, monospace list. */
function renderCommandList(commands: string[], descMap: Map<string, string>): string {
  const width = Math.max(...commands.map((c) => c.length)) + 1; // +1 for the leading '/'
  const lines = commands.map((name) => {
    const desc = descMap.get(name) ?? '';
    return `${padName('/' + name, width)} ${desc}`;
  });
  return '```\n' + lines.join('\n') + '\n```';
}

function buildOverview(
  botName: string,
  avatarUrl: string,
  about: string | null | undefined,
  viewerIsOwner: boolean,
  inDM = false,
): ContainerBuilder {
  const allCats = viewerIsOwner
    ? [...Object.entries(CATEGORIES), ['owner', OWNER_CATEGORY] as [string, typeof OWNER_CATEGORY]]
    : Object.entries(CATEGORIES);

  const total = allCats.reduce((n, [, c]) => n + c.commands.length, 0);
  const nameWidth = Math.max(...allCats.map(([, c]) => c.label.length));

  const lines = allCats.map(
    ([, c]) => `\`${padName(c.label, nameWidth)}\`  ${c.desc}  · ${c.commands.length}`
  );

  return new ContainerBuilder()
    .setAccentColor(config.colors.primary)
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ${botName}\n*${about ?? 'Your all-in-one Discord economy and fun bot'}*`
          )
        )
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl))
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join('\n'))
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        `-# ${total} commands total · Use \`/command\` or \`${config.prefix}command\` · Select a category below`,
        inDM ? '-# You\'re in DMs — Music, Tic-Tac-Toe and Bot Branding need a server.' : '',
      ].filter(Boolean).join('\n'))
    );
}

function buildCategory(
  key: string,
  descMap: Map<string, string>,
  viewerIsOwner: boolean,
  inDM = false,
): ContainerBuilder {
  const cat = key === 'owner' && viewerIsOwner ? OWNER_CATEGORY : CATEGORIES[key];

  const container = new ContainerBuilder()
    .setAccentColor(cat.color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${cat.label}\n${cat.desc}`)
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(renderCommandList(cat.commands, descMap))
    );

  // Called from a DM: point out which of these need a server, so nobody tries
  // to run /play here and wonders why it doesn't respond.
  const blocked = inDM ? serverOnlyIn(cat.commands) : [];
  if (blocked.length) {
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        blocked.length === cat.commands.length
          ? '-# ⚠️ These commands need a server and are unavailable in DMs.'
          : `-# ⚠️ Server only, unavailable here: ${blocked.map((c) => `\`/${c}\``).join(', ')}`,
      ));
  }

  return container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${cat.commands.length} command${cat.commands.length !== 1 ? 's' : ''} · Works with slash \`/\` and prefix \`${config.prefix}\``
      )
    );
}

function buildSelectMenu(active: string, viewerIsOwner: boolean, disabled = false): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_select')
    .setPlaceholder('Browse categories…')
    .setDisabled(disabled)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setValue('overview')
        .setLabel('Overview')
        .setDescription('All categories at a glance')
        .setDefault(active === 'overview'),
      ...Object.entries(CATEGORIES).map(([key, cat]) =>
        new StringSelectMenuOptionBuilder()
          .setValue(key)
          .setLabel(cat.label)
          .setDescription(cat.desc.slice(0, 100))
          .setDefault(key === active)
      ),
      ...(viewerIsOwner
        ? [new StringSelectMenuOptionBuilder()
            .setValue('owner')
            .setLabel(OWNER_CATEGORY.label)
            .setDescription(OWNER_CATEGORY.desc.slice(0, 100))
            .setDefault(active === 'owner')]
        : []),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

// ── Command ───────────────────────────────────────────────────────────────────
export default new Command({
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Browse all bot commands by category.')
    .addStringOption((o) =>
      o.setName('category')
        .setDescription('Jump straight to a category')
        .addChoices(
          { name: 'Overview', value: 'overview' },
          ...Object.entries(CATEGORIES).map(([k, c]) => ({ name: c.label, value: k })),
        )
    ),
  category: 'utility',
  aliases: ['h', 'commands', 'cmds'],
  cooldown: 3000,

  async execute(interaction: ChatInputCommandInteraction, client?: Client) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    // Build a name→description map from loaded commands
    const cmdCollection = (client as unknown as { commands?: Collection<string, Command> })?.commands;
    const descMap = new Map<string, string>();
    if (cmdCollection) {
      for (const [name, cmd] of cmdCollection) {
        descMap.set(name, (cmd.data as { description?: string }).description ?? '');
      }
    }

    const viewerIsOwner = isOwner(interaction.user.id);

    const branding = interaction.guild
      ? (await guildsDB.get(`${interaction.guild.id}.branding`) as { nickname?: string | null; about?: string | null } | undefined)
      : undefined;
    const brandedName = branding?.nickname || config.bot.name;
    const avatarUrl = (client?.user ?? interaction.client.user).displayAvatarURL({ size: 256 });

    const initCatRaw = interaction.options.getString('category') ?? 'overview';
    // Guard against a user requesting the owner category directly without permission
    const initCat = initCatRaw === 'owner' && !viewerIsOwner ? 'overview' : initCatRaw;

    const inDM = !interaction.guild;

    const container = initCat === 'overview'
      ? buildOverview(brandedName, avatarUrl, branding?.about, viewerIsOwner, inDM)
      : buildCategory(initCat, descMap, viewerIsOwner, inDM);

    container.addActionRowComponents(buildSelectMenu(initCat, viewerIsOwner));
    const msg = await interaction.editReply({ components: [container] });

    // ── Collector: handle select menu interactions ──────────────────────────
    const collector = (msg as {
      createMessageComponentCollector: (opts: {
        filter: (i: { user: { id: string }; customId: string }) => boolean;
        time: number;
      }) => {
        on: (
          event: string,
          cb: (i: StringSelectMenuInteraction) => void
        ) => void;
      };
    }).createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id && i.customId === 'help_select',
      time: 120_000,
    });

    let currentCat = initCat;
    collector.on('collect', async (i: StringSelectMenuInteraction) => {
      const value = (i.values as string[])[0];
      // Re-check ownership on every navigation — a stale owners list should
      // never leave the owner category reachable after a permission change.
      const safeValue = value === 'owner' && !viewerIsOwner ? 'overview' : value;
      currentCat = safeValue;
      const newContainer = safeValue === 'overview'
        ? buildOverview(brandedName, avatarUrl, branding?.about, viewerIsOwner, inDM)
        : buildCategory(safeValue, descMap, viewerIsOwner, inDM);

      newContainer.addActionRowComponents(buildSelectMenu(safeValue, viewerIsOwner));
      await i.update({
        flags: MessageFlags.IsComponentsV2 as never,
        components: [newContainer],
      });
    });

    collector.on('end', async () => {
      // Disable the menu when the 2-minute window closes — keep whatever
      // category the user last navigated to, not the original one.
      const disabledContainer = currentCat === 'overview'
        ? buildOverview(brandedName, avatarUrl, branding?.about, viewerIsOwner, inDM)
        : buildCategory(currentCat, descMap, viewerIsOwner, inDM);
      disabledContainer.addActionRowComponents(buildSelectMenu(currentCat, viewerIsOwner, true));
      interaction.editReply({ components: [disabledContainer] }).catch(() => {});
    });
  },
});
