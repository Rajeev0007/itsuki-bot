/**
 * @file index.ts
 * @description Main entry point. Bootstraps the Discord client and all handlers.
 *              Smart command auto-deployment runs before login — only syncs
 *              when commands have actually changed.
 */

import 'dotenv/config';
import path from 'path';
import { Client, GatewayIntentBits, Partials, Collection } from 'discord.js';
import config             from './config/config';
import logger             from './utils/Logger';
import { autoDeployCommands } from './utils/AutoDeploy';
import { connect as connectMongo, close as closeMongo } from './database/Mongo';
import musicManager       from './managers/MusicManager';
import NoPrefixManager    from './managers/NoPrefixManager';
import BlacklistManager   from './managers/BlacklistManager';
import MaintenanceManager from './managers/MaintenanceManager';
import CommandHandler     from './handlers/CommandHandler';
import EventHandler       from './handlers/EventHandler';
import InteractionHandler from './handlers/InteractionHandler';
import { Command }        from './structures/Command';

logger.banner('Itsuki Bot', '1.0.0', 'Economy · Gambling · Music · Anime · Social');

if (!config.token)    { logger.error('DISCORD_TOKEN is not set. Exiting.'); process.exit(1); }
if (!config.clientId) { logger.error('DISCORD_CLIENT_ID is not set. Exiting.'); process.exit(1); }

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember],
  allowedMentions: { parse: ['users', 'roles'], repliedUser: true },
});

// Extend client with custom collections
(client as unknown as { commands: Collection<string, Command> }).commands = new Collection();
(client as unknown as { musicManager: typeof musicManager }).musicManager = musicManager;
const interactionHandler = new InteractionHandler(client);
(client as unknown as { interactionHandler: InteractionHandler }).interactionHandler = interactionHandler;

client.once('ready', () => {
  try { musicManager.init(client); }
  catch (err) { logger.error('[Startup] Failed to initialise music manager:', (err as Error).message); }
});

const commandHandler = new CommandHandler(client);
const eventHandler   = new EventHandler(client);

commandHandler.load();
eventHandler.load();
interactionHandler.load();

// ── Process handlers ──────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('[Process] Unhandled Promise Rejection:', (reason as Error)?.message ?? reason);
});
process.on('uncaughtException', (err) => {
  logger.error('[Process] Uncaught Exception:', err.message);
  logger.debug(err.stack ?? '');
});

const shutdown = async (signal: string) => {
  logger.info(`[Process] Received ${signal} — shutting down gracefully…`);
  client.destroy();
  // Closing the pool lets in-flight writes finish instead of being cut off
  // mid-operation.
  await closeMongo().catch(() => {});
  process.exit(0);
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  // First, and awaited: every manager below reads from the database, and a bad
  // URI or wrong credentials must stop the bot here rather than surfacing later
  // as individual commands failing.
  try {
    await connectMongo();
  } catch (err) {
    logger.error('[Startup] Could not reach MongoDB:', (err as Error).message);
    logger.error('[Startup] Set MONGO_URI in your .env — see .env.example. Run `npm run migrate` to import existing JSON data.');
    process.exit(1);
  }

  await NoPrefixManager.ready();
  await BlacklistManager.ready();
  await MaintenanceManager.ready();

  // Smart global command sync — only hits Discord API when commands changed
  const commandsDir = path.join(__dirname, 'commands');
  await autoDeployCommands(config.token, config.clientId, commandsDir);

  logger.info('[Startup] Connecting to Discord…');
  client.login(config.token).catch((err) => {
    logger.error('[Startup] Login failed:', (err as Error).message);
    process.exit(1);
  });
})();
