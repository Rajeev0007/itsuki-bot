/**
 * @file guildDelete.ts
 * @description Releases per-guild state when the bot is removed from a server.
 *
 * Without this, every map keyed by guild id kept its entry forever: a music
 * session holding cached channel and message objects (and a lavende player), the
 * guild's music settings, and a recording session holding a preallocated audio
 * buffer that can be well over a hundred megabytes. On re-invite, getSession()
 * would then hand back a stale session whose player is dead — the exact
 * session-without-a-player case that made every music command throw.
 */

import { type Guild } from 'discord.js';
import { Event } from '../structures/Event';
import musicManager from '../managers/MusicManager';
import RecordingManager from '../managers/RecordingManager';
import logger from '../utils/Logger';

export default new Event({
  name: 'guildDelete',
  async execute(guild: Guild) {
    logger.info(`[guildDelete] Removed from: ${guild.name} (${guild.id})`);

    // A recording holds the largest allocation, so stop it first.
    try {
      if (RecordingManager.isRecording(guild.id)) {
        await RecordingManager.stop(guild.id);
        logger.info(`[guildDelete] Stopped an active recording in ${guild.id}.`);
      }
    } catch (err) {
      logger.warn(`[guildDelete] Could not stop the recording for ${guild.id}: ${(err as Error).message}`);
    }

    // Tears down the player, clears the leave timer and deletes the session.
    try {
      await musicManager.destroyPlayer(guild.id);
    } catch (err) {
      logger.warn(`[guildDelete] Could not destroy the player for ${guild.id}: ${(err as Error).message}`);
    }

    // Cached settings are rebuilt from the database on demand, so dropping them
    // frees memory without losing anything — the guild's stored config is
    // deliberately left in place so a re-invite keeps its 24/7 and autoplay
    // preferences.
    musicManager.guildSettings.delete(guild.id);
  },
});
