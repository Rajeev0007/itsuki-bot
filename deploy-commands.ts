/**
 * @file deploy-commands.ts
 * @description Registers slash commands with Discord's API.
 *
 * Usage:
 * npm run deploy → register all commands GLOBALLY (public bot, up to 1 h to propagate)
 * npm run deploy:guild → register to DISCORD_GUILD_ID only (instant, for dev/testing)
 * npm run deploy:clear-guild → wipe guild-specific commands (removes duplicates)
 *
 * Discord limits:
 * Global commands : 100 (we use ~56 — well within limit)
 * Guild commands : 100 per guild
 */

import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import fs from 'fs';
import path from 'path';

const token = process.env.DISCORD_TOKEN ?? '';
const clientId = process.env.DISCORD_CLIENT_ID ?? '';
const guildId = process.env.DISCORD_GUILD_ID ?? '';

if (!token || !clientId) {
  console.error(' DISCORD_TOKEN and DISCORD_CLIENT_ID must be set.');
  process.exit(1);
}

const mode = process.argv[2] ?? 'global'; // 'global' | 'guild' | 'clear-guild'

// ── Load commands ─────────────────────────────────────────────────────────────
const commands: unknown[] = [];

if (mode !== 'clear-guild') {
  const commandsPath = path.join(__dirname, 'commands');
  const categories = fs.readdirSync(commandsPath).filter(
    (f) => fs.statSync(path.join(commandsPath, f)).isDirectory()
  );

  for (const category of categories) {
    const files = fs.readdirSync(path.join(commandsPath, category)).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const raw = require(path.join(commandsPath, category, file));
        const command = raw.default ?? raw;
        if (command?.data?.toJSON) {
          commands.push(command.data.toJSON());
          console.log(` ${command.data.name}`);
        }
      } catch (err) {
        console.error(` Failed to load ${category}/${file}:`, (err as Error).message);
      }
    }
  }
}

// ── Deploy ────────────────────────────────────────────────────────────────────
const rest = new REST({ version: '10' }).setToken(token);

/**
 * Downgrades a command body to server-install only.
 *
 * Needed in two places:
 *  - guild-scoped commands, which are inherently server-installed; sending
 *    `integration_types` or the PrivateChannel context on them is invalid and
 *    fails the whole deploy
 *  - as a retry when the app has not enabled "User Install" in the Developer
 *    Portal, which is a portal setting that cannot be set from code
 */
function withoutUserInstall(cmd: unknown): unknown {
  const body = { ...(cmd as Record<string, unknown>) };
  delete body.integration_types;
  if (Array.isArray(body.contexts)) {
    body.contexts = (body.contexts as unknown[]).map(Number).filter((n) => n !== 2);
  }
  return body;
}

function isUserInstallRejected(err: unknown): boolean {
  const detail = JSON.stringify((err as { rawError?: unknown })?.rawError ?? '');
  const message = (err as Error)?.message ?? '';
  return /integration_types|user[_ ]?install|cannot be installed/i.test(`${detail} ${message}`);
}

(async () => {
  try {
    switch (mode) {

      case 'guild': {
        if (!guildId) { console.error(' DISCORD_GUILD_ID must be set for guild deployment.'); process.exit(1); }
        console.log(`\n Deploying ${commands.length} commands to guild ${guildId} (instant)…`);
        // Guild-scoped commands are server-installed by definition, so the
        // user-install fields must be removed or Discord rejects the request.
        const guildBodies = commands.map(withoutUserInstall);
        const data = await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: guildBodies }) as unknown[];
        console.log(` Registered ${data.length} guild commands.`);
        console.log(' Note: guild commands are never available as user (account) installs — use the global deploy for that.');
        break;
      }

      case 'clear-guild': {
        if (!guildId) { console.error(' DISCORD_GUILD_ID must be set to clear guild commands.'); process.exit(1); }
        console.log(`\n Clearing all guild-specific commands from guild ${guildId}…`);
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
        console.log(' Guild commands cleared. Only global commands will appear.');
        break;
      }

      default: { // 'global'
        const userInstallable = commands.filter(
          (c) => (c as { integration_types?: number[] }).integration_types?.includes(1),
        ).length;
        console.log(`\n Deploying ${commands.length} commands globally (${userInstallable} as user installs; may take up to 1 hour to propagate)…`);

        let data: unknown[];
        try {
          data = await rest.put(Routes.applicationCommands(clientId), { body: commands }) as unknown[];
        } catch (err) {
          if (!isUserInstallRejected(err)) throw err;
          console.warn('\n Discord rejected the user-install registration.');
          console.warn(' Enable it at: Developer Portal → your app → Installation → Installation Contexts → tick "User Install".');
          console.warn(' Deploying with server install only for now.\n');
          data = await rest.put(Routes.applicationCommands(clientId), { body: commands.map(withoutUserInstall) }) as unknown[];
        }
        console.log(` Registered ${data.length} global commands.`);
        console.log('\n Tip: run npm run deploy:clear-guild to remove any duplicate guild commands.');
        break;
      }
    }
  } catch (err) {
    console.error(' Deploy failed:', (err as Error).message);
    process.exit(1);
  }
})();
