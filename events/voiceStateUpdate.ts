import { type VoiceState, type Client } from 'discord.js';
import { Event } from '../structures/Event';
import logger from '../utils/Logger';
import music from '../managers/MusicManager';
import musicConfig from '../config/music';
import StatsManager from '../managers/StatsManager';

export default new Event({
  name: 'voiceStateUpdate',
  async execute(oldState: VoiceState, newState: VoiceState, client: Client) {
    const guildId = oldState.guild.id;

    // ── Voice activity tracking ─────────────────────────────────────────────
    // Must run BEFORE the music-session early-return below, otherwise voice
    // time would only ever be counted in servers that happen to be playing
    // music through the bot.
    const memberId = (newState.member ?? oldState.member)?.id;
    if (memberId && memberId !== client.user?.id && !(newState.member ?? oldState.member)?.user.bot) {
      const wasIn = Boolean(oldState.channelId);
      const isIn  = Boolean(newState.channelId);

      if (!wasIn && isIn) {
        StatsManager.voiceJoin(guildId, memberId);
      } else if (wasIn && !isIn) {
        StatsManager.voiceLeave(guildId, memberId);
      } else if (wasIn && isIn && oldState.channelId !== newState.channelId) {
        // Moving between channels: bank the previous stretch and restart, so
        // hopping channels doesn't discard the accumulated time.
        StatsManager.voiceLeave(guildId, memberId);
        StatsManager.voiceJoin(guildId, memberId);
      }
    }

    const session = music.getSession(guildId);
    if (!session) return;

    const botId = client.user!.id;

    if (oldState.member?.id === botId) {
      if (!newState.channelId) {
        logger.warn(`[Music] Bot disconnected from VC in guild ${guildId} — destroying queue.`);
        await music.destroyPlayer(guildId).catch(() => {});
        return;
      }
      if (newState.channelId && oldState.channelId !== newState.channelId) {
        const newChannel = newState.channel;
        if (newChannel) session.voiceChannel = newChannel;
      }
      return;
    }

    const botChannel = session.voiceChannel;
    if (!botChannel) return;

    const members = botChannel.members.filter((m) => !m.user.bot);
    const gs = music.getGuildSettings(guildId);

    if (members.size === 0) {
      if (!gs.alwaysOn && !session.leaveTimer) {
        logger.info(`[Music] All users left in guild ${guildId} — auto-leave in ${musicConfig.autoLeaveMs / 1000}s.`);
        session.leaveTimer = setTimeout(async () => {
          const tc = session.textChannel;
          await music.destroyPlayer(guildId).catch(() => {});
          (tc as any).send(
            music._simpleComponents('👋 Everyone left — disconnected from voice.')
          ).catch(() => {});
        }, musicConfig.autoLeaveMs);
      }
    } else {
      if (session.leaveTimer) {
        clearTimeout(session.leaveTimer);
        session.leaveTimer = null;
        logger.info(`[Music] User rejoined in guild ${guildId} — cancelled auto-leave.`);
      }
    }
  },
});
