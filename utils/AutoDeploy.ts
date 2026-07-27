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
// Strips Discord-added fields (id, application_id, version, guild_id, etc.)
// and sorts object keys so JSON.stringify gives a deterministic string.
function normalize(cmd: unknown): string {
  const STRIP = new Set([
    'id', 'application_id', 'version', 'guild_id',
  ]);

  function clean(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(clean);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => !STRIP.has(k))
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
    dm_permission: base.dm_permission ?? true,
    nsfw: base.nsfw ?? false,
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

  try {
    logger.info(`[AutoDeploy] Syncing ${local.size} commands globally…`);
    const result = (await rest.put(
      Routes.applicationCommands(clientId),
      { body: [...local.values()] },
    )) as unknown[];
    logger.info(`[AutoDeploy] ${result.length} global commands registered.`);
  } catch (err) {
    logger.error('[AutoDeploy] Registration failed:', (err as Error).message);
  }
}
