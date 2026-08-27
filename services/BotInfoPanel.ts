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
import { EMOJI as E } from '../utils/Constants';
import { getStore } from '../database/Store';
import type { Command } from '../structures/Command';

const usersDB = getStore('users');

/* ── Pages ────────────────────────────────────────────────────────────────── */

export const PAGES = [
  { id: 'overview', label: 'Overview',   emoji: 'ℹ️', description: 'What the bot is and how it is doing' },
  { id: 'system',   label: 'System',     emoji: '⚙️', description: 'Host, runtime and latency' },
  { id: 'commands', label: 'Commands',   emoji: '📜', description: 'What is available, by category' },
  { id: 'features', label: 'Features',   emoji: '✨', description: 'A tour of the major modules' },
  { id: 'links',    label: 'Links',      emoji: '🔗', description: 'Invite, support and legal' },
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

export interface ResolvedLink { label: string; url: string; emoji?: string }

export function resolveLinks(): ResolvedLink[] {
  const candidates: Array<ResolvedLink | null> = [
    (() => { const u = inviteUrl(); return u ? { label: 'Add to Server', url: u, emoji: '➕' } : null; })(),
    (() => { const u = validUrl(config.links.support); return u ? { label: 'Support', url: u, emoji: '💬' } : null; })(),
    (() => {
      const u = config.clientId ? `https://top.gg/bot/${config.clientId}/vote` : null;
      return u ? { label: 'Vote', url: u, emoji: '⭐' } : null;
    })(),
    (() => { const u = validUrl(config.links.website); return u ? { label: 'Website', url: u, emoji: '🌐' } : null; })(),
    (() => { const u = validUrl(config.links.github); return u ? { label: 'Source', url: u, emoji: '💻' } : null; })(),
  ];
  // Discord allows at most 5 buttons in one action row.
  return candidates.filter((l): l is ResolvedLink => l !== null).slice(0, 5);
}

/* ── Rendering ────────────────────────────────────────────────────────────── */

function pageBody(page: InfoPage, s: InfoSnapshot): string[] {
  const ping = s.wsPing === null ? 'connecting…' : `${s.wsPing}ms`;
  const dbLine = s.registeredUsers === null
    ? '> Status: **unavailable**'
    : `> Profiles stored: **${fmt.number(s.registeredUsers)}**\n> Read latency: **${s.dbLatencyMs ?? '—'}ms**`;

  switch (page) {
    case 'overview':
      return [
        `**${E.INFO} About**`,
        `> A full economy, gambling, music and anime bot with ${s.commandTotal} public commands.`,
        `> Version **${config.bot.version}** · discord.js **${s.discordVersion}**`,
        '',
        `**${E.CHART} Reach**`,
        `> Servers: **${fmt.number(s.guilds)}**`,
        `> Members: **${fmt.number(s.members)}**`,
        `> Channels: **${fmt.number(s.channels)}**`,
        '',
        `**${E.LIGHTNING} Health**`,
        `> Uptime: **${fmt.duration(s.clientUptimeMs)}**`,
        `> Gateway: **${ping}**`,
      ];

    case 'system':
      return [
        `**${E.LIGHTNING} Runtime**`,
        `> Node.js: **${s.nodeVersion}**`,
        `> discord.js: **v${s.discordVersion}**`,
        `> Platform: **${s.platform}**`,
        `> Shards: **${s.shards}**`,
        '',
        `**${E.CHART} Memory**`,
        `> Heap in use: **${s.heapMB.toFixed(1)} MB**`,
        `> Resident set: **${s.rssMB.toFixed(1)} MB**`,
        '',
        `**${E.CLOCK} Uptime**`,
        `> Gateway session: **${fmt.duration(s.clientUptimeMs)}**`,
        `> Process: **${fmt.duration(s.processUptimeMs)}**`,
        '',
        `**${E.BANK} Database**`,
        dbLine,
      ];

    case 'commands': {
      if (!s.categories.length) {
        return [`**${E.INFO} Commands**`, '> The command registry is still loading — try again in a moment.'];
      }
      const rows = s.categories.map(
        (c) => `> \`${String(c.count).padStart(2, ' ')}\` — ${fmt.capitalize(c.name)}`,
      );
      return [
        `**📜 ${s.commandTotal} public commands, ${s.categories.length} categories**`,
        ...rows,
        '',
        '-# Run `/help` to browse them with descriptions and usage.',
      ];
    }

    case 'features':
      return [
        `**${E.COINS} Economy**`,
        '> Wallet and bank, daily and weekly streaks, work, crime, rob, prestige.',
        '',
        `**${E.SLOTS} Gambling**`,
        '> Blackjack, roulette, slots, crash, mines, dice and coinflip — every stake escrowed before the round starts.',
        '',
        `**${E.ANIME} Anime & Cards**`,
        '> Collect and upgrade character cards, duel them, and trade on the auction house.',
        '',
        '**🎵 Music**',
        '> Queue, loop, shuffle, seek, autoplay and 24/7 mode.',
        '',
        `**${E.SHIELD} Moderation**`,
        '> Ban, kick, timeout, purge, lock, slowmode, verification, welcomer and mod logs.',
        '',
        `**${E.RANK} Profiles**`,
        '> Rendered profile cards with levels, prestige, ranking and badges.',
      ];

    case 'links': {
      const legal: string[] = [];
      const privacy = validUrl(config.links.privacy);
      const terms = validUrl(config.links.terms);
      if (privacy) legal.push(`> [Privacy Policy](${privacy})`);
      if (terms) legal.push(`> [Terms of Service](${terms})`);

      const links = resolveLinks();
      return [
        `**${E.INFO} Where to find us**`,
        links.length
          ? '> Use the buttons below to add the bot, get support or vote.'
          : '> No links are configured yet.',
        ...(legal.length ? ['', '**📄 Legal**', ...legal] : []),
        '',
        `-# Bot ID \`${config.clientId || 'unknown'}\``,
      ];
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
      `-# ${meta.emoji} ${meta.label} · v${config.bot.version}`,
    ].join('\n')))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(pageBody(page, snapshot).join('\n')));

  /* Page select. setDefault marks the current page so the menu reflects state
     instead of always reading "Select a section". */
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`binfo_select:${viewerId}`)
    .setPlaceholder('Jump to a section…')
    .setDisabled(disabled)
    .addOptions(...PAGES.map((p) => new StringSelectMenuOptionBuilder()
      .setLabel(p.label)
      .setDescription(p.description)
      .setEmoji(p.emoji)
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
        .setEmoji(E.REFRESH)
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
        ...links.map((l) => {
          const button = new ButtonBuilder()
            .setLabel(l.label)
            .setStyle(ButtonStyle.Link)
            .setURL(l.url);
          if (l.emoji) button.setEmoji(l.emoji);
          return button;
        }),
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
