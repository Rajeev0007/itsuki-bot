/**
 * @file AutoDeploy.ts
 * @description Smart command sync on startup.
 *
 * Per scope (global, and the dev guild for owner tools):
 * 1. Load local command definitions from disk.
 * 2. Fetch what Discord already has registered for that scope.
 * 3. Diff both sets (added / changed / removed).
 * 4. If nothing changed → skip the API call entirely.
 * 5. If anything changed → bulk PUT and log what changed.
 *
 * ── The 100-command ceiling ─────────────────────────────────────────────────
 * Discord allows 100 chat-input commands per scope: 100 global, and 100 per
 * guild. Exceeding it does not truncate — the ENTIRE registration is rejected,
 * so one command too many leaves the bot with whatever was registered last.
 *
 * The bot has more than 100 commands, so owner-only tools are registered to the
 * dev guild instead of globally. That is where they belong anyway: they are
 * useless to normal users, they clutter every server's command list, and guild
 * commands appear instantly rather than taking up to an hour. It also leaves
 * real headroom under the global cap.
 */

import { REST, Routes } from 'discord.js';
import fs from 'fs';
import path from 'path';
import logger from './Logger';
import config from '../config/config';

/** Discord's hard cap on chat-input commands, per scope. */
const COMMAND_LIMIT = 100;
/** Warn once the headroom gets thin enough to matter. */
const COMMAND_WARN_AT = 95;

// ── Types ─────────────────────────────────────────────────────────────────────
interface RawCommand {
  name: string;
  description?: string;
  options?: unknown[];
  default_member_permissions?: string | null;
  dm_permission?: boolean;
  nsfw?: boolean;
  /** Where the command may be used: 0 = Guild, 1 = Bot DM, 2 = Private channel. */
  contexts?: number[] | null;
  /** How the app may be installed: 0 = Guild install, 1 = User install. */
  integration_types?: number[] | null;
}

interface LocalCommand {
  json: RawCommand;
  /** Owner tools are registered to the dev guild, not globally. */
  ownerOnly: boolean;
}

// ── Load local commands from commands/ ────────────────────────────────────────
function loadLocal(commandsDir: string): Map<string, LocalCommand> {
  const map = new Map<string, LocalCommand>();
  if (!fs.existsSync(commandsDir)) return map;

  const categories = fs.readdirSync(commandsDir).filter(
    (f) => fs.statSync(path.join(commandsDir, f)).isDirectory(),
  );

  for (const cat of categories) {
    const files = fs.readdirSync(path.join(commandsDir, cat)).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const raw = require(path.join(commandsDir, cat, file));
        const cmd = raw.default ?? raw;
        if (cmd?.data?.toJSON) {
          const json = cmd.data.toJSON() as RawCommand;
          // Read from the command's own flag rather than the folder name:
          // /noprefix lives under utility but is owner-only.
          map.set(json.name, { json, ownerOnly: Boolean(cmd.ownerOnly) });
        }
      } catch { /* skip unloadable file */ }
    }
  }
  return map;
}

// ── Normalize a command for stable comparison ────────────────────────────────
// Produces a deterministic string for a command definition so a local build can
// be compared against what Discord echoes back.
//
// This has to be aggressive about noise, because Discord's response is NOT a
// verbatim copy of what was sent. It adds bookkeeping fields (id,
// application_id, version), newer permission fields the builders don't emit
// (contexts, integration_types), and null-valued localization keys — while
// omitting defaults such as `required: false`. Comparing any of that verbatim
// made every command look "changed" on every boot, so the bot re-registered all
// of its global commands each time it started, burning through the daily
// command-creation rate limit for no reason.
export function normalize(cmd: unknown): string {
  const STRIP = new Set([
    // Discord bookkeeping
    'id', 'application_id', 'version', 'guild_id',
    // Echo-only fields we never send, so comparing them is a permanent diff
    'default_permission', 'handler',
    // Superseded by `contexts`; Discord stops reporting it once contexts are set
    'dm_permission',
    // Localization maps — echoed back as null when unset
    'name_localizations', 'description_localizations',
  ]);

  /** Fields Discord omits when they hold their default value. */
  const DEFAULTS: Record<string, unknown> = {
    required: false,
    autocomplete: false,
    nsfw: false,
  };

  function clean(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(clean);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k, val]) => {
            if (STRIP.has(k)) return false;
            // Drop null/undefined and default-valued keys so "absent" and
            // "explicitly default" compare equal.
            if (val === null || val === undefined) return false;
            if (k in DEFAULTS && val === DEFAULTS[k]) return false;
            return true;
          })
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, clean(val)]),
      );
    }
    return v;
  }

  // Normalise missing optional fields to their Discord defaults so we don't
  // trigger a false-positive diff when Discord echoes them back.
  const base = cmd as RawCommand;
  const normalised: Record<string, unknown> = {
    name: base.name,
    description: base.description ?? '',
    options: base.options ?? [],
    default_member_permissions: base.default_member_permissions ?? null,
    nsfw: base.nsfw ?? false,
    // `contexts` decides whether a command is usable in DMs, so it MUST take
    // part in the diff — otherwise a change to a command's DM availability
    // would be silently skipped and never registered. Sorted because the array
    // order carries no meaning.
    contexts: [...(base.contexts ?? [])].map(Number).sort((a, b) => a - b),
    // MUST be compared for the same reason as `contexts`, and this one bit us:
    // it used to sit in STRIP, so turning on user installs changed nothing in
    // the signature, the diff came back empty, AutoDeploy logged
    // "up-to-date — skipping registration", and the change was never sent to
    // Discord. A user with the app installed to their account saw no commands
    // and there was nothing in the log to suggest why.
    integration_types: [...(base.integration_types ?? [])].map(Number).sort((a, b) => a - b),
  };

  return JSON.stringify(clean(normalised));
}

// ── Scope sync ────────────────────────────────────────────────────────────────
/**
 * Syncs one scope (global, or a single guild) and reports whether it succeeded.
 *
 * Each scope is diffed and PUT independently: a change to an owner tool must not
 * force a global re-registration, and vice versa.
 */
async function syncScope(
  rest: REST,
  route: `/${string}`,
  bodies: RawCommand[],
  label: string,
): Promise<boolean> {
  // Guard BEFORE calling Discord. Over the limit the API rejects the whole
  // request, so the failure would otherwise arrive as an opaque 400 with the
  // bot left holding whatever set was registered previously.
  if (bodies.length > COMMAND_LIMIT) {
    const overflow = bodies.slice(COMMAND_LIMIT).map((c) => c.name);
    logger.error(`[AutoDeploy] ${label}: ${bodies.length} commands exceeds Discord's limit of ${COMMAND_LIMIT}.`);
    logger.error(`[AutoDeploy] Discord rejects the ENTIRE registration when this happens, so nothing was sent.`);
    logger.error(`[AutoDeploy] ${overflow.length} over: ${overflow.join(', ')}`);
    logger.error('[AutoDeploy] Fix by setting DISCORD_GUILD_ID (moves owner tools off the global scope), or by merging related commands into subcommands.');
    return false;
  }
  if (bodies.length >= COMMAND_WARN_AT) {
    logger.warn(`[AutoDeploy] ${label}: ${bodies.length}/${COMMAND_LIMIT} commands — ${COMMAND_LIMIT - bodies.length} slot(s) left.`);
  }

  let registered: RawCommand[] = [];
  try {
    registered = (await rest.get(route)) as RawCommand[];
  } catch (err) {
    logger.error(`[AutoDeploy] ${label}: could not fetch registered commands:`, (err as Error).message);
    return false;
  }

  const registeredMap = new Map(registered.map((c) => [c.name, c]));
  const localMap = new Map(bodies.map((c) => [c.name, c]));

  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [name, localCmd] of localMap) {
    if (!registeredMap.has(name)) added.push(name);
    else if (normalize(localCmd) !== normalize(registeredMap.get(name)!)) changed.push(name);
  }
  for (const name of registeredMap.keys()) {
    if (!localMap.has(name)) removed.push(name);
  }

  if (!added.length && !changed.length && !removed.length) {
    logger.info(`[AutoDeploy] ${label}: all ${bodies.length} commands up-to-date — skipping registration.`);
    return true;
  }

  if (added.length) logger.info(`[AutoDeploy] ${label} new: ${added.join(', ')}`);
  if (changed.length) logger.info(`[AutoDeploy] ${label} updated: ${changed.join(', ')}`);
  if (removed.length) logger.info(`[AutoDeploy] ${label} removed: ${removed.join(', ')}`);

  const userInstallable = bodies.filter((c) => c.integration_types?.includes(1)).length;

  try {
    logger.info(`[AutoDeploy] ${label}: syncing ${bodies.length} commands (${userInstallable} as user installs)…`);
    let result: unknown[];
    try {
      result = (await rest.put(route, { body: bodies })) as unknown[];
    } catch (err) {
      if (!isUserInstallRejected(err)) throw err;
      // The app-level "User Install" switch lives in the Developer Portal and
      // cannot be set from code. Rather than refusing to start, fall back to
      // server-install only and say exactly what to change.
      logger.warn('[AutoDeploy] Discord rejected the user-install registration.');
      logger.warn('[AutoDeploy] Enable it at: Developer Portal → your app → Installation → Installation Contexts → tick "User Install".');
      logger.warn('[AutoDeploy] Registering with server install only for now; re-run once it is enabled.');
      result = (await rest.put(route, { body: bodies.map(withoutUserInstall) })) as unknown[];
    }
    logger.info(`[AutoDeploy] ${label}: ${result.length} commands registered.`);
    return true;
  } catch (err) {
    logger.error(`[AutoDeploy] ${label}: registration failed:`, (err as Error).message);
    return false;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function autoDeployCommands(
  token: string,
  clientId: string,
  commandsDir: string,
  guildId: string = config.guildId,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);

  const local = loadLocal(commandsDir);
  if (local.size === 0) {
    logger.warn('[AutoDeploy] No local commands found — skipping.');
    return;
  }

  const all = [...local.values()];
  const ownerCmds = all.filter((c) => c.ownerOnly).map((c) => c.json);
  const publicCmds = all.filter((c) => !c.ownerOnly).map((c) => c.json);

  // Owner tools go to the dev guild when one is configured. Without it they have
  // to stay global, which may push the global scope over the cap — syncScope
  // then reports exactly that instead of letting Discord fail obscurely.
  const splitOwnerCommands = Boolean(guildId) && ownerCmds.length > 0;

  let globalBodies: RawCommand[];
  if (splitOwnerCommands) {
    globalBodies = publicCmds;
  } else if (all.length > COMMAND_LIMIT) {
    // No dev guild configured and too many commands for one scope. Dropping the
    // owner tools keeps the PUBLIC bot fully working, which matters far more
    // than owner slash commands — and their prefix forms (",panel") are routed
    // by messageCreate, so they are unaffected. Registering all of them instead
    // would have Discord reject everything and leave the bot with no commands.
    globalBodies = publicCmds;
    logger.warn(`[AutoDeploy] ${all.length} commands exceeds the global cap of ${COMMAND_LIMIT}, and DISCORD_GUILD_ID is not set.`);
    logger.warn(`[AutoDeploy] Registering the ${publicCmds.length} public commands only; the ${ownerCmds.length} owner command(s) are being skipped.`);
    logger.warn('[AutoDeploy] Set DISCORD_GUILD_ID to register them to your dev guild instead. Their prefix forms work regardless.');
  } else {
    globalBodies = all.map((c) => c.json);
  }
  await syncScope(rest, Routes.applicationCommands(clientId), globalBodies, 'global');

  if (splitOwnerCommands) {
    // Owner commands are guild-scoped, so the slash versions only appear in the
    // dev guild. The prefix forms (",panel") are routed by messageCreate and are
    // unaffected, so they still work in DMs.
    logger.info(`[AutoDeploy] ${ownerCmds.length} owner command(s) → dev guild ${guildId} (kept off the global ${COMMAND_LIMIT}-command cap).`);
    await syncScope(rest, Routes.applicationGuildCommands(clientId, guildId), ownerCmds, `guild ${guildId}`);
  }
}

/**
 * Downgrades a command body to server-install only.
 *
 * `PrivateChannel` (2) has to go with it: Discord only accepts that context on a
 * user-installable command, so leaving it would fail the retry for a second,
 * more confusing reason.
 */
export function withoutUserInstall(cmd: unknown): unknown {
  const body = { ...(cmd as Record<string, unknown>) };
  body.integration_types = [0];
  if (Array.isArray(body.contexts)) {
    body.contexts = (body.contexts as unknown[]).map(Number).filter((n) => n !== 2);
  }
  return body;
}

/** Whether a registration failure was about user installs specifically. */
export function isUserInstallRejected(err: unknown): boolean {
  const detail = JSON.stringify((err as { rawError?: unknown })?.rawError ?? '');
  const message = (err as Error)?.message ?? '';
  return /integration_types|user[_ ]?install|cannot be installed/i.test(`${detail} ${message}`);
}
