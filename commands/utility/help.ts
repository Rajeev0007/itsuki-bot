/**
 * @file help.ts
 * @description Command browser: an overview, per-category listings, and a
 * per-command detail view.
 *
 * ── Everything is derived from the command registry ─────────────────────────
 * This file used to hold hand-written arrays of command names per category, a
 * hand-written set of server-only commands, and a hand-written DM notice. Three
 * separate lists that all had to be updated by hand every time a command was
 * added, and nothing failed when they were not — a forgotten entry simply made
 * the command invisible in help, and a renamed one left a dead row.
 *
 * Now the only thing written by hand is presentation: a label, a one-line
 * description, a colour and an ordering per category. Which commands exist,
 * which category they belong to, which need a server, which need a vote and
 * what their aliases are all come from the loaded Command objects, so help
 * cannot drift from the bot.
 */

import {
  SlashCommandBuilder, MessageFlags,
  ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder,
  SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction, type Client, type Collection,
  type AutocompleteInteraction, type StringSelectMenuInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import config from '../../config/config';
import { getStore } from '../../database/Store';
import logger from '../../utils/Logger';

const guildsDB = getStore('guilds');

// ── Presentation only ─────────────────────────────────────────────────────────
/**
 * Ordered deliberately: the bot's main draws first, reference and meta last.
 * A category present on a command but missing here still shows up, under
 * FALLBACK_META — so a new category can never hide its commands.
 */
const CATEGORY_META: Record<string, { label: string; desc: string; color: number }> = {
  economy:     { label: 'Economy',     desc: 'Earn, spend and manage your coins',           color: config.colors.gold },
  gambling:    { label: 'Gambling',    desc: 'Risk coins for bigger rewards',               color: config.colors.danger },
  games:       { label: 'Games',       desc: 'Play against friends or the bot',             color: config.colors.teal },
  cards:       { label: 'Anime Cards', desc: 'Roll, collect, battle and trade characters',  color: config.colors.anime },
  social:      { label: 'Social',      desc: 'React to and interact with other people',     color: config.colors.social },
  anime:       { label: 'Anime',       desc: 'Anime images and character search',           color: config.colors.anime },
  music:       { label: 'Music',       desc: 'Play music in a voice channel',               color: config.colors.purple },
  shop:        { label: 'Shop',        desc: 'Browse and buy items',                        color: config.colors.gold },
  inventory:   { label: 'Inventory',   desc: 'View and use what you own',                   color: config.colors.info },
  pets:        { label: 'Pets',        desc: 'Hatch, feed and raise a pet',                 color: config.colors.success },
  profile:     { label: 'Profile',     desc: 'Your level, XP and achievements',             color: config.colors.primary },
  leaderboard: { label: 'Leaderboard', desc: 'Rankings and top players',                    color: config.colors.primary },
  stats:       { label: 'Activity',    desc: 'Per-server message and voice tracking',       color: config.colors.teal },
  gaming:      { label: 'Game Stats',  desc: 'Minecraft, CS2 and Valorant lookups',         color: config.colors.info },
  moderation:  { label: 'Moderation',  desc: 'Keep your server in order',                   color: config.colors.danger },
  utility:     { label: 'Utility',     desc: 'Bot info and server tools',                   color: config.colors.dark },
  owner:       { label: 'Owner',       desc: 'Bot management, owners only',                 color: config.colors.danger },
};

const FALLBACK_META = { label: 'Other', desc: 'Uncategorised commands', color: config.colors.dark };

/** Category render order. Anything not named here is appended alphabetically. */
const ORDER = [
  'economy', 'gambling', 'games', 'cards', 'social', 'anime', 'music',
  'shop', 'inventory', 'pets', 'profile', 'leaderboard', 'stats', 'gaming',
  'moderation', 'utility',
];

/** Discord allows 25 select options; one slot is spent on Overview. */
const MAX_SELECT_CATEGORIES = 24;

function meta(key: string) {
  return CATEGORY_META[key] ?? { ...FALLBACK_META, label: key ? key[0].toUpperCase() + key.slice(1) : FALLBACK_META.label };
}

// ── Registry derived from the loaded commands ────────────────────────────────

interface CmdInfo {
  name: string;
  description: string;
  category: string;
  guildOnly: boolean;
  ownerOnly: boolean;
  voteLocked: boolean;
  premiumOnly: boolean;
  aliases: string[];
  /** Subcommand names, so the detail view can show what a command supports. */
  subcommands: string[];
}

function readCommands(client: Client | undefined): CmdInfo[] {
  const collection = (client as unknown as { commands?: Collection<string, Command> })?.commands;
  if (!collection) return [];

  const out: CmdInfo[] = [];
  for (const [key, cmd] of collection) {
    // Aliases are registered as additional keys pointing at the same command,
    // so without this every aliased command would be listed several times.
    if (!cmd?.data || key !== cmd.name) continue;

    let description = '';
    let subcommands: string[] = [];
    try {
      const json = (cmd.data as { toJSON?: () => { description?: string; options?: Array<{ name: string; type: number }> } }).toJSON?.();
      description = json?.description ?? '';
      subcommands = (json?.options ?? [])
        .filter((o) => o.type === 1 || o.type === 2)   // subcommand / subcommand group
        .map((o) => o.name);
    } catch {
      description = (cmd.data as { description?: string }).description ?? '';
    }

    out.push({
      name: cmd.name,
      description,
      category: cmd.category || 'utility',
      guildOnly: Boolean(cmd.guildOnly),
      ownerOnly: Boolean(cmd.ownerOnly),
      voteLocked: Boolean(cmd.voteLocked),
      premiumOnly: Boolean(cmd.premiumOnly),
      aliases: Array.isArray(cmd.aliases) ? cmd.aliases : [],
      subcommands,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Groups into categories, honouring ORDER and hiding owner tools from others. */
function groupCommands(all: CmdInfo[], viewerIsOwner: boolean): Array<{ key: string; commands: CmdInfo[] }> {
  const buckets = new Map<string, CmdInfo[]>();

  for (const cmd of all) {
    // Owner tools live in their own category regardless of folder, so a
    // misfiled owner command can never leak into a public listing.
    const key = cmd.ownerOnly ? 'owner' : cmd.category;
    if (key === 'owner' && !viewerIsOwner) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(cmd);
  }

  const known = ORDER.filter((k) => buckets.has(k));
  const extra = [...buckets.keys()]
    .filter((k) => !ORDER.includes(k) && k !== 'owner')
    .sort();

  const keys = [...known, ...extra];
  if (buckets.has('owner')) keys.push('owner');   // always last

  return keys.map((key) => ({ key, commands: buckets.get(key)! }));
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Short markers for the gates a command sits behind.
 *
 * Worth showing: someone reading help otherwise discovers a vote lock only by
 * running the command and being refused.
 */
function markers(cmd: CmdInfo, inDM: boolean, hideServerTag = false): string {
  const tags: string[] = [];
  if (cmd.guildOnly && !hideServerTag) tags.push(inDM ? 'server only' : 'server');
  if (cmd.voteLocked) tags.push('vote');
  if (cmd.premiumOnly) tags.push('premium');
  return tags.length ? `  *(${tags.join(', ')})*` : '';
}

/**
 * One line per command.
 *
 * Deliberately NOT a padded monospace table any more. Three reasons: aligned
 * columns need a code block, a code block cannot render markdown so nothing can
 * be emphasised, a single backtick in any command description would break out of
 * it, and it wraps badly on narrow screens. Padding outside a code block does
 * not align at all, because Discord renders body text in a proportional font.
 */
function renderCommands(commands: CmdInfo[], inDM: boolean, hideServerTag = false): string {
  return commands
    .map((c) => `\`/${c.name}\`  ${c.description}${markers(c, inDM, hideServerTag)}`)
    .join('\n');
}

function buildOverview(opts: {
  botName: string;
  avatarUrl: string;
  about?: string | null;
  groups: Array<{ key: string; commands: CmdInfo[] }>;
  total: number;
  inDM: boolean;
  viewerIsOwner: boolean;
}): ContainerBuilder {
  // One line per category. Two lines each read as a wall on a phone, and the
  // description is short enough to sit inline.
  const lines = opts.groups.map(({ key, commands }) => {
    const m = meta(key);
    return `**${m.label}** \`${commands.length}\` — ${m.desc}`;
  });

  const dmBlocked = opts.inDM
    ? opts.groups.reduce((n, g) => n + g.commands.filter((c) => c.guildOnly).length, 0)
    : 0;

  const footer = [
    `-# ${opts.total} commands · \`/\` or \`${config.prefix}\` · pick a category below`,
    `-# \`/help command:name\` shows details for one command`,
    // Counted, not hardcoded. The old notice named three commands while the
    // real number had grown to 37.
    dmBlocked ? `-# ${dmBlocked} commands need a server and are marked below` : '',
    opts.viewerIsOwner ? '-# Owner commands are registered to the dev server only; their prefix forms work anywhere' : '',
  ].filter(Boolean).join('\n');

  return new ContainerBuilder()
    .setAccentColor(config.colors.primary)
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `## ${opts.botName}\n-# ${opts.about ?? 'Economy, games, music and moderation in one bot'}`,
        ))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(opts.avatarUrl)),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));
}

function buildCategory(
  key: string,
  commands: CmdInfo[],
  inDM: boolean,
): ContainerBuilder {
  const m = meta(key);

  // When the whole category shares a gate, say it once in the header rather than
  // stamping the same marker onto all 15 music or 13 moderation lines.
  const allServerOnly = commands.length > 1 && commands.every((c) => c.guildOnly);
  const heading = [
    `## ${m.label}`,
    `-# ${m.desc}`,
    allServerOnly
      ? (inDM ? '-# ⚠️ These all need a server — none of them work here in DMs.' : '-# These all need a server.')
      : '',
  ].filter(Boolean).join('\n');

  const container = new ContainerBuilder()
    .setAccentColor(m.color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(heading))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      commands.length ? renderCommands(commands, inDM, allServerOnly) : '-# No commands here.',
    ));

  const aliased = commands.filter((c) => c.aliases.length);
  const footer = [
    `-# ${commands.length} command${commands.length === 1 ? '' : 's'}`,
    // 17 commands have aliases and none of them were discoverable anywhere.
    aliased.length
      ? `-# Shortcuts: ${aliased.slice(0, 8).map((c) => `\`${config.prefix}${c.aliases[0]}\``).join(' ')}`
      : '',
  ].filter(Boolean).join('\n');

  return container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));
}

/** Detail view for a single command. */
function buildDetail(cmd: CmdInfo, inDM: boolean): ContainerBuilder {
  const m = meta(cmd.ownerOnly ? 'owner' : cmd.category);

  const facts: string[] = [`**Category** ${m.label}`];
  if (cmd.aliases.length) {
    facts.push(`**Shortcuts** ${cmd.aliases.map((a) => `\`${config.prefix}${a}\``).join(' ')}`);
  }
  if (cmd.subcommands.length) {
    facts.push(`**Subcommands** ${cmd.subcommands.map((s) => `\`${s}\``).join(' ')}`);
  }

  const gates: string[] = [];
  if (cmd.guildOnly) gates.push(inDM ? 'Needs a server — not available here in DMs' : 'Needs a server');
  if (cmd.voteLocked) gates.push('Needs a recent vote, or premium');
  if (cmd.premiumOnly) gates.push('Premium only');
  if (cmd.ownerOnly) gates.push('Bot owners only');

  const container = new ContainerBuilder()
    .setAccentColor(m.color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `## /${cmd.name}\n${cmd.description || '-# No description.'}`,
    ))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(facts.join('\n')));

  if (gates.length) {
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        gates.map((g) => `-# ${g}`).join('\n'),
      ));
  }

  return container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `-# Usage: \`/${cmd.name}\` or \`${config.prefix}${cmd.name}\`${cmd.subcommands.length ? ' followed by a subcommand' : ''}`,
    ));
}

function buildNav(
  active: string,
  groups: Array<{ key: string; commands: CmdInfo[] }>,
  disabled = false,
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_select')
    .setPlaceholder('Browse categories…')
    .setDisabled(disabled)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setValue('overview').setLabel('Overview')
        .setDescription('All categories at a glance')
        .setDefault(active === 'overview'),
      // Sliced because Discord rejects a menu with more than 25 options; without
      // it, adding categories would eventually fail the whole message.
      ...groups.slice(0, MAX_SELECT_CATEGORIES).map(({ key, commands }) => {
        const m = meta(key);
        return new StringSelectMenuOptionBuilder()
          .setValue(key).setLabel(m.label)
          .setDescription(`${commands.length} · ${m.desc}`.slice(0, 100))
          .setDefault(key === active);
      }),
    );

  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
}

/** Shown only when the user has navigated away from the overview. */
function buildHomeRow(disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('help_home').setLabel('Overview')
      .setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

// ── Command ───────────────────────────────────────────────────────────────────
export default new Command({
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Browse every command, or look one up.')
    .addStringOption((o) => o.setName('category')
      .setDescription('Jump straight to a category')
      .setAutocomplete(true))
    .addStringOption((o) => o.setName('command')
      .setDescription('Show details for one command')
      .setAutocomplete(true)),
  category: 'utility',
  aliases: ['h', 'commands', 'cmds'],
  cooldown: 3000,

  async autocomplete(interaction: AutocompleteInteraction, client?: Client) {
    try {
      const focused = interaction.options.getFocused(true) as unknown as { name: string; value: string };
      const query = String(focused?.value ?? '').toLowerCase();
      const viewerIsOwner = config.owners.includes(interaction.user.id);
      const all = readCommands(client ?? interaction.client);

      if (focused?.name === 'command') {
        const pool = all.filter((c) => viewerIsOwner || !c.ownerOnly);
        return interaction.respond(
          pool.filter((c) => c.name.includes(query) || c.aliases.some((a) => a.includes(query)))
            .slice(0, 25)
            .map((c) => ({ name: `/${c.name} — ${c.description}`.slice(0, 100), value: c.name })),
        );
      }

      const groups = groupCommands(all, viewerIsOwner);
      return interaction.respond(
        [{ key: 'overview', commands: [] }, ...groups]
          .filter(({ key }) => key.includes(query) || meta(key).label.toLowerCase().includes(query))
          .slice(0, 25)
          .map(({ key, commands }) => ({
            name: key === 'overview' ? 'Overview' : `${meta(key).label} (${commands.length})`,
            value: key,
          })),
      );
    } catch {
      // Autocomplete must always answer, or the client shows a spinner forever.
      return interaction.respond([]).catch(() => null);
    }
  },

  async execute(interaction: ChatInputCommandInteraction, client?: Client) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const viewerIsOwner = config.owners.includes(interaction.user.id);
    const inDM = !interaction.guild;
    const all = readCommands(client ?? interaction.client);
    const groups = groupCommands(all, viewerIsOwner);
    const total = groups.reduce((n, g) => n + g.commands.length, 0);

    const branding = interaction.guild
      ? (await guildsDB.get(`${interaction.guild.id}.branding`) as { nickname?: string | null; about?: string | null } | undefined)
      : undefined;
    const botName = branding?.nickname || config.bot.name;
    // client.user is null until READY, and a null here would throw inside the
    // deferred reply rather than just omitting a thumbnail.
    const botUser = client?.user ?? interaction.client.user;
    const avatarUrl = botUser?.displayAvatarURL({ size: 256 })
      ?? 'https://cdn.discordapp.com/embed/avatars/0.png';

    const overview = () => buildOverview({
      botName, avatarUrl, about: branding?.about, groups, total, inDM, viewerIsOwner,
    });

    // ── /help command:<name> ────────────────────────────────────────────────
    const wanted = (interaction.options.getString('command') ?? '').trim().toLowerCase();
    if (wanted) {
      const found = all.find((c) => c.name === wanted)
        ?? all.find((c) => c.aliases.includes(wanted));

      // Owner commands are not acknowledged to non-owners: confirming they
      // exist is information the listing deliberately withholds.
      if (!found || (found.ownerOnly && !viewerIsOwner)) {
        const container = overview()
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `-# No command called \`${wanted.slice(0, 40)}\`. Browse below, or try \`/help command:\` for suggestions.`,
          ));
        container.addActionRowComponents(...buildNav('overview', groups));
        return interaction.editReply({ components: [container] });
      }

      const container = buildDetail(found, inDM);
      container.addActionRowComponents(...buildNav('overview', groups));
      container.addActionRowComponents(buildHomeRow());
      return startCollector(container);
    }

    // ── Category resolution ─────────────────────────────────────────────────
    const requested = (interaction.options.getString('category') ?? 'overview').trim().toLowerCase();

    // The prefix router does not restrict a value to the slash choices, so
    // `,help garbage` — and `,help Economy`, purely a capitalisation
    // difference — used to reach `CATEGORIES[key].color` on undefined. That
    // threw inside the deferred reply, leaving the message stuck on "thinking"
    // with nothing logged.
    const resolved = requested === 'overview'
      ? 'overview'
      : (groups.find((g) => g.key === requested)?.key
        ?? groups.find((g) => meta(g.key).label.toLowerCase() === requested)?.key);

    // A prefix invocation has no named options, so `,help balance` puts a COMMAND
    // name into `category`. Falling back to the overview there would be a
    // regression from what people actually type, so resolve it as a command.
    if (!resolved && requested) {
      const asCommand = all.find((c) => c.name === requested)
        ?? all.find((c) => c.aliases.includes(requested));
      if (asCommand && (!asCommand.ownerOnly || viewerIsOwner)) {
        const detail = buildDetail(asCommand, inDM);
        detail.addActionRowComponents(...buildNav('overview', groups));
        detail.addActionRowComponents(buildHomeRow());
        return startCollector(detail);
      }
    }

    let current = resolved ?? 'overview';

    const first = current === 'overview'
      ? overview()
      : buildCategory(current, groups.find((g) => g.key === current)!.commands, inDM);

    if (!resolved) {
      first.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `-# \`${requested.slice(0, 40)}\` isn't a category — showing the overview instead.`,
        ));
    }

    first.addActionRowComponents(...buildNav(current, groups));
    if (current !== 'overview') first.addActionRowComponents(buildHomeRow());
    return startCollector(first);

    // ── Navigation ──────────────────────────────────────────────────────────
    async function startCollector(container: ContainerBuilder): Promise<unknown> {
      const msg = await interaction.editReply({ components: [container] });

      const collector = (msg as {
        createMessageComponentCollector: (opts: {
          filter: (i: { user: { id: string }; customId: string }) => boolean;
          time: number;
        }) => { on: (event: string, cb: (i: StringSelectMenuInteraction) => void) => void };
      }).createMessageComponentCollector({
        filter: (i) => i.user.id === interaction.user.id
          && (i.customId === 'help_select' || i.customId === 'help_home'),
        time: 180_000,
      });

      const render = (key: string): ContainerBuilder => {
        const group = groups.find((g) => g.key === key);
        // Falls back rather than throwing: the menu is built from `groups`, but a
        // reload between render and click could remove a category.
        const c = key === 'overview' || !group
          ? overview()
          : buildCategory(key, group.commands, inDM);
        c.addActionRowComponents(...buildNav(group ? key : 'overview', groups));
        if (group && key !== 'overview') c.addActionRowComponents(buildHomeRow());
        return c;
      };

      collector.on('collect', async (i: StringSelectMenuInteraction) => {
        // Wrapped because an expired or already-acknowledged interaction would
        // otherwise surface as an unhandled rejection and take the process
        // handler with it.
        try {
          const next = i.customId === 'help_home' ? 'overview' : (i.values as string[])[0];
          current = next;
          await i.update({
            flags: MessageFlags.IsComponentsV2 as never,
            components: [render(next)],
          });
        } catch (err) {
          logger.debug(`[help] navigation failed: ${(err as Error).message}`);
        }
      });

      collector.on('end', () => {
        // Leave the view the user was last on, with the controls greyed out.
        const group = groups.find((g) => g.key === current);
        const c = current === 'overview' || !group ? overview() : buildCategory(current, group.commands, inDM);
        c.addActionRowComponents(...buildNav(current, groups, true));
        if (group && current !== 'overview') c.addActionRowComponents(buildHomeRow(true));
        interaction.editReply({ components: [c] }).catch(() => {});
      });

      return msg;
    }
  },
});
