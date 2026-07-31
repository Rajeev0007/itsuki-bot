import { type VoiceState, type Client } from 'discord.js';
import { Event } from '../structures/Event';
import logger from '../utils/Logger';
import music from '../managers/MusicManager';
import musicConfig from '../config/music';

export default new Event({
  name: 'voiceStateUpdate',
  async execute(oldState: VoiceState, newState: VoiceState, client: Client) {
    const guildId = oldState.guild.id;
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
