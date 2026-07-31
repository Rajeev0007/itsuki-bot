/**
 * @file shutdown.ts
 * @description Owner-only command to gracefully shut down the bot process.
 * On hosts that auto-restart crashed/exited processes (like most Discord
 * bot panels), this effectively acts as a restart.
 */

import {
  SlashCommandBuilder, MessageFlags,
  type ChatInputCommandInteraction, type Client,
} from 'discord.js';
import { Command } from '../../structures/Command';
import logger       from '../../utils/Logger';
import * as CB       from '../../builders/ComponentBuilder';
import StatsManager  from '../../managers/StatsManager';
import CardManager   from '../../managers/CardManager';
import RecordingManager from '../../managers/RecordingManager';

const IS_V2 = Number(MessageFlags.IsComponentsV2);

export default new Command({
  data: new SlashCommandBuilder()
    .setName('shutdown')
    .setDescription('(Owner) Gracefully shut down the bot.'),

  category:  'owner',
  ownerOnly: true,
  aliases:   ['restart'],
  cooldown:  0,

  async execute(interaction: ChatInputCommandInteraction, client?: Client) {
    await interaction.reply({
      ...CB.successResponse('Shutting Down', 'Disconnecting from Discord and exiting…'),
      flags: IS_V2 as never,
    } as never);

    logger.info(`[Shutdown] Requested by ${interaction.user.tag} (${interaction.user.id}).`);

    // Flush buffered state BEFORE exiting. StatsManager holds message and voice
    // counters in memory between periodic flushes, so exiting straight away
    // discarded up to 30 seconds of activity on every restart.
    try {
      await StatsManager.flush();
      logger.info('[Shutdown] Activity buffer flushed.');
    } catch (err) {
      logger.warn(`[Shutdown] Could not flush activity buffer: ${(err as Error).message}`);
    }

    // Close any in-progress voice sessions so their elapsed time is banked too.
    try {
      await CardManager.expireListings();
    } catch { /* non-fatal */ }

    // Tear down voice recordings so connections aren't orphaned on exit, and
    // participants aren't left looking at a "recording in progress" notice.
    try {
      const stopped = await RecordingManager.stopAll();
      if (stopped) logger.info(`[Shutdown] Stopped ${stopped} active recording(s).`);
    } catch { /* non-fatal */ }

    setTimeout(() => {
      // destroy() is async; give it a moment to close the gateway cleanly
      // rather than racing process.exit against it.
      void Promise.resolve(client?.destroy()).finally(() => process.exit(0));
    }, 500); // give the reply time to actually send before the process exits
  },
});
