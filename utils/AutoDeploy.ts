/**
 * @file AutoDeploy.ts
 * @description Smart global command sync on startup.
 *
 * On every boot:
 * 1. Load local command definitions from disk.
 * 2. Fetch what Discord already has registered globally.
 * 3. Diff both sets (added / changed / removed).
 * 4. If nothing changed → skip the API call entirely.
 * 5. If anything changed → bulk PUT only what's needed and log what changed.
 */

import { REST, Routes } from 'discord.js';
import fs from 'fs';
import path from 'path';
import logger from './Logger';

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

// ── Load local commands from commands/ ────────────────────────────────────────
function loadLocal(commandsDir: string): Map<string, RawCommand> {
  const map = new Map<string, RawCommand>();
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
          map.set(json.name, json);
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

// ── Main export ───────────────────────────────────────────────────────────────
export async function autoDeployCommands(
  token: string,
  clientId: string,
  commandsDir: string,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);

  // 1. Load local
  const local = loadLocal(commandsDir);
  if (local.size === 0) {
    logger.warn('[AutoDeploy] No local commands found — skipping.');
    return;
  }

  // 2. Fetch registered global commands
  let registered: RawCommand[] = [];
  try {
    registered = (await rest.get(Routes.applicationCommands(clientId))) as RawCommand[];
  } catch (err) {
    logger.error('[AutoDeploy] Could not fetch registered commands:', (err as Error).message);
    return;
  }

  const registeredMap = new Map(registered.map((c) => [c.name, c]));

  // 3. Diff
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [name, localCmd] of local) {
    if (!registeredMap.has(name)) {
      added.push(name);
    } else if (normalize(localCmd) !== normalize(registeredMap.get(name)!)) {
      changed.push(name);
    }
  }
  for (const name of registeredMap.keys()) {
    if (!local.has(name)) removed.push(name);
  }

  // 4. Skip if nothing changed
  if (added.length === 0 && changed.length === 0 && removed.length === 0) {
    logger.info(`[AutoDeploy] All ${local.size} commands are up-to-date — skipping registration.`);
    return;
  }

  // 5. Log what changed, then sync
  if (added.length) logger.info(`[AutoDeploy] New : ${added.join(', ')}`);
  if (changed.length) logger.info(`[AutoDeploy] Updated: ${changed.join(', ')}`);
  if (removed.length) logger.info(`[AutoDeploy] Removed: ${removed.join(', ')}`);

  const bodies = [...local.values()];
  const userInstallable = bodies.filter(
    (c) => (c as RawCommand).integration_types?.includes(1),
  ).length;

  try {
    logger.info(`[AutoDeploy] Syncing ${local.size} commands globally (${userInstallable} available as user installs)…`);
    let result: unknown[];
    try {
      result = (await rest.put(
        Routes.applicationCommands(clientId),
        { body: bodies },
      )) as unknown[];
    } catch (err) {
      if (!isUserInstallRejected(err)) throw err;
      // The app-level "User Install" switch lives in the Developer Portal and
      // cannot be set from code. Rather than refusing to start, fall back to
      // server-install only and say exactly what to change.
      logger.warn('[AutoDeploy] Discord rejected the user-install registration.');
      logger.warn('[AutoDeploy] Enable it at: Developer Portal → your app → Installation → Installation Contexts → tick "User Install".');
      logger.warn('[AutoDeploy] Registering with server install only for now; re-run once it is enabled.');
      result = (await rest.put(
        Routes.applicationCommands(clientId),
        { body: bodies.map(withoutUserInstall) },
      )) as unknown[];
    }
    logger.info(`[AutoDeploy] ${result.length} global commands registered.`);
  } catch (err) {
    logger.error('[AutoDeploy] Registration failed:', (err as Error).message);
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
