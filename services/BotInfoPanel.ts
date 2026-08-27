/**
 * @file BotInfoPanel.ts
 * @description Builds the multi-page bot information panel behind /stats.
 *
 * ── Why the rendering lives here and not in the command ─────────────────────
 * The same panel is produced by three entry points: the command, the page select
 * menu and the refresh button. Keeping `buildPanel` a PURE function of
 * (page, snapshot, viewerId) means all three render identically by construction,
 * and a page can never exist in the menu without something to show for it.
 *
 * ── Global handlers, no collectors ──────────────────────────────────────────
 * The components are routed by InteractionHandler rather than a per-message
 * collector. That is deliberate: a collector dies with the process, so every
 * panel posted before a restart would answer clicks with "This interaction
 * failed" forever. Registered handlers keep working, and there is no collector
 * to leak, time out, or forget to clean up.
 *
 * ── Cost control ────────────────────────────────────────────────────────────
 * The registered-user count is a full collection scan (the store has no
 * indexes), so it is memoised. Everything else is read from caches the client
 * already maintains.
 */

import {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  type Client,
} from 'discord.js';
import config from '../config/config';
import fmt from '../utils/Formatter';
import { getStore } from '../database/Store';
import type { Command } from '../structures/Command';

const usersDB = getStore('users');

/* ── Pages ────────────────────────────────────────────────────────────────── */

/**
 * Sections, in menu order.
 *
 * No emoji anywhere in this panel — not in the headings, the menu, or the
 * buttons. Figures are laid out as aligned monospace tables instead, which reads
 * as a status report rather than a chat message and stays legible on mobile,
 * where a row of emoji wraps badly.
 */
export const PAGES = [
  { id: 'overview', label: 'Overview',    description: 'Identity, reach and current health' },
  { id: 'system',   label: 'System',      description: 'Runtime, memory, uptime and database' },
  { id: 'commands', label: 'Commands',    description: 'Available commands by category' },
  { id: 'features', label: 'Features',    description: 'What each module provides' },
  { id: 'links',    label: 'Links',       description: 'Invite, support and legal documents' },
] as const;

export type InfoPage = typeof PAGES[number]['id'];

const PAGE_IDS = PAGES.map((p) => p.id) as readonly string[];

/** Narrows an untrusted string (a customId segment) to a real page. */
export function asPage(value: string | null | undefined): InfoPage {
  return PAGE_IDS.includes(String(value)) ? (value as InfoPage) : 'overview';
}

/* ── Snapshot ─────────────────────────────────────────────────────────────── */

export interface InfoSnapshot {
  guilds: number;
  members: number;
  channels: number;
  /** null when the gateway has not reported a heartbeat yet. */
  wsPing: number | null;
  clientUptimeMs: number;
  processUptimeMs: number;
  heapMB: number;
  rssMB: number;
  nodeVersion: string;
  discordVersion: string;
  platform: string;
  shards: number;
  /** null when the count could not be read. */
  registeredUsers: number | null;
  /** Round-trip of one store read, in ms; null when it failed. */
  dbLatencyMs: number | null;
  commandTotal: number;
  categories: Array<{ name: string; count: number }>;
}

/** Memo for the two figures that cost a database round trip. */
const DB_TTL_MS = 60_000;
let dbCache: { at: number; users: number | null; latency: number | null } | null = null;

async function dbStats(): Promise<{ users: number | null; latency: number | null }> {
  if (dbCache && Date.now() - dbCache.at < DB_TTL_MS) {
    return { users: dbCache.users, latency: dbCache.latency };
  }
  let users: number | null = null;
  let latency: number | null = null;
  try {
    const started = Date.now();
    const all = await usersDB.all();
    latency = Date.now() - started;
    users = Array.isArray(all) ? all.length : null;
  } catch {
    // A dead database must degrade to "unavailable" on the card, not throw the
    // whole panel away.
    users = null;
    latency = null;
  }
  dbCache = { at: Date.now(), users, latency };
  return { users, latency };
}

/** discord.js exposes its own version; read it defensively in case it moves. */
function discordVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('discord.js') as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Unique commands, keyed by name.
 *
 * CommandHandler registers every ALIAS as its own key in `client.commands`, so
 * iterating the collection directly counts `/balance` once per alias and reports
 * a command total substantially higher than the truth.
 */
function uniqueCommands(client: Client): Command[] {
  const raw = (client as unknown as { commands?: Map<string, Command> }).commands;
  if (!raw) return [];
  const byName = new Map<string, Command>();
  for (const cmd of raw.values()) {
    if (cmd?.name && !byName.has(cmd.name)) byName.set(cmd.name, cmd);
  }
  return [...byName.values()];
}

export async function collectSnapshot(client: Client): Promise<InfoSnapshot> {
  const { users, latency } = await dbStats();

  // memberCount is undefined for an unavailable guild (an outage), which would
  // turn the whole sum into NaN.
  const members = client.guilds.cache.reduce((sum, g) => sum + (g.memberCount || 0), 0);

  const commands = uniqueCommands(client);
  // Owner tooling is not public, so it is left out of the counts users see.
  const publicCommands = commands.filter((c) => !c.ownerOnly);
  const grouped = new Map<string, number>();
  for (const cmd of publicCommands) {
    const key = cmd.category || 'misc';
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }

  const mem = process.memoryUsage();

  return {
    guilds: client.guilds.cache.size,
    members,
    channels: client.channels.cache.size,
    // ws.ping is -1 until the first heartbeat ack; showing "-1ms" looks broken.
    wsPing: Number.isFinite(client.ws.ping) && client.ws.ping >= 0 ? Math.round(client.ws.ping) : null,
    clientUptimeMs: client.uptime ?? 0,
    processUptimeMs: Math.floor(process.uptime() * 1000),
    heapMB: mem.heapUsed / 1024 / 1024,
    rssMB: mem.rss / 1024 / 1024,
    nodeVersion: process.version,
    discordVersion: discordVersion(),
    platform: `${process.platform} ${process.arch}`,
    shards: client.shard?.count ?? 1,
    registeredUsers: users,
    dbLatencyMs: latency,
    commandTotal: publicCommands.length,
    categories: [...grouped.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

/* ── Links ────────────────────────────────────────────────────────────────── */

/**
 * A link button is only rendered when its URL is genuinely usable.
 *
 * Discord rejects a link button whose URL is empty or not http(s) — with a 400
 * that takes down the entire message, not just the button. Validating here is
 * what lets every link be optional.
 */
function validUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  // Discord's own ceiling for a button URL.
  if (value.length > 512) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') ? value : null;
  } catch {
    return null;
  }
}

/** Falls back to a scope-only invite so no permission bitfield is asserted here. */
function inviteUrl(): string | null {
  const configured = validUrl(config.links.invite);
  if (configured) return configured;
  if (!config.clientId) return null;
  return `https://discord.com/oauth2/authorize?client_id=${config.clientId}`
    + '&scope=bot%20applications.commands';
}

export interface ResolvedLink { label: string; url: string }

export function resolveLinks(): ResolvedLink[] {
  const candidates: Array<ResolvedLink | null> = [
    (() => { const u = inviteUrl(); return u ? { label: 'Add to Server', url: u } : null; })(),
    (() => { const u = validUrl(config.links.support); return u ? { label: 'Support Server', url: u } : null; })(),
    (() => {
      const u = config.clientId ? `https://top.gg/bot/${config.clientId}/vote` : null;
      return u ? { label: 'Vote', url: u } : null;
    })(),
    (() => { const u = validUrl(config.links.website); return u ? { label: 'Website', url: u } : null; })(),
    (() => { const u = validUrl(config.links.github); return u ? { label: 'Source Code', url: u } : null; })(),
  ];
  // Discord allows at most 5 buttons in one action row.
  return candidates.filter((l): l is ResolvedLink => l !== null).slice(0, 5);
}

/* ── Rendering ────────────────────────────────────────────────────────────── */

/**
 * Renders label/value pairs as an aligned monospace block.
 *
 * Labels are left-aligned and values right-aligned to a common width, so figures
 * line up into a column that can be read down. Discord's proportional font makes
 * that impossible outside a code block, which is why this wraps one.
 *
 * The width is measured from the content rather than fixed, so a long value
 * cannot silently push a row out of alignment.
 */
function table(rows: Array<[string, string]>): string {
  if (!rows.length) return '';
  const labelW = Math.max(...rows.map(([l]) => l.length));
  const valueW = Math.max(...rows.map(([, v]) => v.length));
  const body = rows
    .map(([l, v]) => `${l.padEnd(labelW)}   ${v.padStart(valueW)}`)
    .join('\n');
  return `\`\`\`\n${body}\n\`\`\``;
}

/** A section heading. Bold rather than a markdown header, which is oversized here. */
function heading(text: string): string {
  return `**${text.toUpperCase()}**`;
}

function pageBody(page: InfoPage, s: InfoSnapshot): string[] {
  switch (page) {
    case 'overview':
      return [
        heading('Identity'),
        table([
          ['Version', config.bot.version],
          ['Library', `discord.js v${s.discordVersion}`],
          ['Commands', `${fmt.number(s.commandTotal)} public`],
          ['Bot ID', config.clientId || 'unknown'],
        ]),
        heading('Reach'),
        table([
          ['Servers', fmt.number(s.guilds)],
          ['Members', fmt.number(s.members)],
          ['Channels', fmt.number(s.channels)],
        ]),
        heading('Health'),
        table([
          ['Uptime', fmt.duration(s.clientUptimeMs)],
          // "connecting" rather than "-1ms": ws.ping is -1 until the first
          // heartbeat acknowledgement, which is a state, not a measurement.
          ['Gateway latency', s.wsPing === null ? 'connecting' : `${s.wsPing} ms`],
          ['Shards', String(s.shards)],
        ]),
      ];

    case 'system':
      return [
        heading('Runtime'),
        table([
          ['Node.js', s.nodeVersion],
          ['discord.js', `v${s.discordVersion}`],
          ['Platform', s.platform],
          ['Shards', String(s.shards)],
        ]),
        heading('Memory'),
        table([
          ['Heap in use', `${s.heapMB.toFixed(1)} MB`],
          ['Resident set', `${s.rssMB.toFixed(1)} MB`],
        ]),
        heading('Uptime'),
        table([
          ['Gateway session', fmt.duration(s.clientUptimeMs)],
          ['Process', fmt.duration(s.processUptimeMs)],
        ]),
        heading('Database'),
        table(
          s.registeredUsers === null
            ? [['Status', 'unavailable']]
            : [
              ['Status', 'connected'],
              ['Profiles stored', fmt.number(s.registeredUsers)],
              ['Read latency', `${s.dbLatencyMs ?? 0} ms`],
            ],
        ),
      ];

    case 'commands': {
      if (!s.categories.length) {
        return [
          heading('Commands'),
          'The command registry is still loading. Try again in a moment.',
        ];
      }
      return [
        heading(`${s.commandTotal} public commands across ${s.categories.length} categories`),
        table(s.categories.map((c) => [fmt.capitalize(c.name), String(c.count)] as [string, string])),
        '-# Run `/help` for descriptions and usage of each command.',
      ];
    }

    case 'features':
      return [
        heading('Economy'),
        'Wallet and bank accounts, daily and weekly streaks, work, crime, robbery and prestige.',
        heading('Gambling'),
        'Blackjack, roulette, slots, crash, mines, dice and coinflip. Every stake is taken before the round begins.',
        heading('Anime and cards'),
        'Collect and upgrade character cards, duel them, and trade on the auction house.',
        heading('Music'),
        'Queue management, loop modes, shuffle, seek, autoplay and 24/7 playback.',
        heading('Moderation'),
        'Ban, kick, timeout, purge, channel locking, slowmode, member verification, welcome messages and audit logging.',
        heading('Profiles'),
        'Rendered profile cards with levels, prestige, server ranking and badges.',
        heading('Social'),
        'Roleplay reactions with anime GIFs, plus per-action sent and received counters.',
      ];

    case 'links': {
      const privacy = validUrl(config.links.privacy);
      const terms = validUrl(config.links.terms);
      const links = resolveLinks();

      const out: string[] = [
        heading('Where to find us'),
        links.length
          ? 'Use the buttons below to add the bot, get support, or vote for it.'
          : 'No links have been configured yet.',
      ];
      if (privacy || terms) {
        out.push(heading('Legal'));
        if (privacy) out.push(`[Privacy Policy](${privacy})`);
        if (terms) out.push(`[Terms of Service](${terms})`);
      }
      out.push(`-# Bot ID \`${config.clientId || 'unknown'}\``);
      return out;
    }

    default:
      return [];
  }
}

export interface PanelOptions {
  page: InfoPage;
  snapshot: InfoSnapshot;
  /** Whose panel this is — embedded in the customIds for the ownership check. */
  viewerId: string;
  /** Renders the controls inert, for a panel that can no longer be driven. */
  disabled?: boolean;
}

export function buildPanel(opts: PanelOptions): { components: ContainerBuilder[] } {
  const { page, snapshot, viewerId, disabled = false } = opts;
  const meta = PAGES.find((p) => p.id === page) ?? PAGES[0];

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      `# ${config.bot.name}`,
      `-# ${meta.label.toUpperCase()}  ·  v${config.bot.version}  ·  ${fmt.number(snapshot.guilds)} servers`,
    ].join('\n')))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(pageBody(page, snapshot).join('\n')));

  /* Page select. setDefault marks the current page so the menu reflects state
     instead of always reading "Select a section". */
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`binfo_select:${viewerId}`)
    .setPlaceholder('Select a section')
    .setDisabled(disabled)
    .addOptions(...PAGES.map((p) => new StringSelectMenuOptionBuilder()
      .setLabel(p.label)
      .setDescription(p.description)
      .setValue(p.id)
      .setDefault(p.id === page)));

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
  container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));

  /* Refresh re-reads the snapshot for the page in view. The page is carried in
     the customId so the handler does not have to parse it back out of the
     rendered text. */
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`binfo_refresh:${viewerId}:${page}`)
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  );

  /* Link buttons. Style.Link carries a URL and no customId, so these need no
     handler and keep working forever — including after a restart. */
  const links = resolveLinks();
  if (links.length) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...links.map((l) => new ButtonBuilder()
          .setLabel(l.label)
          .setStyle(ButtonStyle.Link)
          .setURL(l.url)),
      ),
    );
  }

  return { components: [container] };
}

/** Convenience for the three entry points: collect, then render. */
export async function renderPanel(
  client: Client,
  page: InfoPage,
  viewerId: string,
): Promise<{ components: ContainerBuilder[] }> {
  const snapshot = await collectSnapshot(client);
  return buildPanel({ page, snapshot, viewerId });
}

export default { PAGES, asPage, collectSnapshot, buildPanel, renderPanel, resolveLinks };
