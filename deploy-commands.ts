/**
 * @file deploy-commands.ts
 * @description Registers slash commands with Discord's API.
 *
 * Usage:
 * npm run deploy → public commands GLOBALLY + owner tools to DISCORD_GUILD_ID
 *                             (global can take up to an hour to propagate)
 * npm run deploy:guild → EVERYTHING to DISCORD_GUILD_ID only (instant, for dev)
 * npm run deploy:clear-guild → wipe guild-specific commands
 *
 * ── Discord limits ─────────────────────────────────────────────────────────
 * 100 chat-input commands per scope: 100 global, and 100 per guild. Going over
 * does not truncate — the ENTIRE registration is rejected, leaving whatever was
 * registered last.
 *
 * The bot has more than 100 commands, so `npm run deploy` sends owner-only tools
 * to the dev guild instead of globally. That is where they belong anyway (they
 * are useless to normal users and appear instantly), and it keeps real headroom
 * under the global cap.
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

/** Discord's hard cap on chat-input commands, per scope. */
const COMMAND_LIMIT = 100;

// ── Load commands ─────────────────────────────────────────────────────────────
interface Loaded { name: string; json: unknown; ownerOnly: boolean }
const loaded: Loaded[] = [];

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
          // Split on the command's own flag, not the folder: /noprefix lives
          // under utility but is owner-only.
          loaded.push({
            name: command.data.name,
            json: command.data.toJSON(),
            ownerOnly: Boolean(command.ownerOnly),
          });
          console.log(` ${command.data.name}${command.ownerOnly ? '  (owner → dev guild)' : ''}`);
        }
      } catch (err) {
        console.error(` Failed to load ${category}/${file}:`, (err as Error).message);
      }
    }
  }
}

const commands: unknown[] = loaded.map((c) => c.json);
const ownerCommands: unknown[] = loaded.filter((c) => c.ownerOnly).map((c) => c.json);
const publicCommands: unknown[] = loaded.filter((c) => !c.ownerOnly).map((c) => c.json);

/**
 * Refuses to send a scope that Discord would reject wholesale.
 *
 * Checked locally because the API does not partially apply an over-limit PUT —
 * it discards the request, so the failure would otherwise be an opaque 400.
 */
function assertWithinLimit(bodies: unknown[], label: string): void {
  if (bodies.length <= COMMAND_LIMIT) return;
  const names = loaded.map((c) => c.name);
  console.error(`\n ${label}: ${bodies.length} commands exceeds Discord's limit of ${COMMAND_LIMIT}.`);
  console.error(' Discord rejects the entire registration when this happens, so nothing was sent.');
  console.error(` ${bodies.length - COMMAND_LIMIT} over. Last few: ${names.slice(-5).join(', ')}`);
  console.error(' Set DISCORD_GUILD_ID and use `npm run deploy` so owner tools register to your dev guild,');
  console.error(' or merge related commands into subcommands to reduce the count.\n');
  process.exit(1);
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
        assertWithinLimit(commands, `guild ${guildId}`);
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
        // Owner tools are sent to the dev guild so they stay off the global cap.
        const splitOwner = Boolean(guildId) && ownerCommands.length > 0;

        let globalBodies: unknown[];
        if (splitOwner) {
          globalBodies = publicCommands;
        } else if (commands.length > COMMAND_LIMIT) {
          // Keep the public bot working rather than having Discord reject the
          // whole payload. Owner prefix commands are unaffected.
          globalBodies = publicCommands;
          console.warn(`\n ${commands.length} commands exceeds the global cap of ${COMMAND_LIMIT}, and DISCORD_GUILD_ID is not set.`);
          console.warn(` Registering the ${publicCommands.length} public commands only; skipping ${ownerCommands.length} owner command(s).`);
          console.warn(' Set DISCORD_GUILD_ID to register those to your dev guild. Their prefix forms work regardless.\n');
        } else {
          globalBodies = commands;
        }
        assertWithinLimit(globalBodies, 'global');

        const userInstallable = globalBodies.filter(
          (c) => (c as { integration_types?: number[] }).integration_types?.includes(1),
        ).length;
        console.log(`\n Deploying ${globalBodies.length} commands globally (${userInstallable} as user installs; may take up to 1 hour to propagate)…`);

        let data: unknown[];
        try {
          data = await rest.put(Routes.applicationCommands(clientId), { body: globalBodies }) as unknown[];
        } catch (err) {
          if (!isUserInstallRejected(err)) throw err;
          console.warn('\n Discord rejected the user-install registration.');
          console.warn(' Enable it at: Developer Portal → your app → Installation → Installation Contexts → tick "User Install".');
          console.warn(' Deploying with server install only for now.\n');
          data = await rest.put(Routes.applicationCommands(clientId), { body: globalBodies.map(withoutUserInstall) }) as unknown[];
        }
        console.log(` Registered ${data.length} global commands.`);

        if (splitOwner) {
          assertWithinLimit(ownerCommands, `guild ${guildId}`);
          console.log(`\n Deploying ${ownerCommands.length} owner command(s) to dev guild ${guildId}…`);
          const ownerData = await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body: ownerCommands.map(withoutUserInstall) },
          ) as unknown[];
          console.log(` Registered ${ownerData.length} owner commands to the dev guild.`);
          console.log(' Their prefix forms still work everywhere, including DMs.');
        }
        console.log('\n Tip: run npm run deploy:clear-guild to remove any duplicate guild commands.');
        break;
      }
    }
  } catch (err) {
    console.error(' Deploy failed:', (err as Error).message);
    process.exit(1);
  }
})();
