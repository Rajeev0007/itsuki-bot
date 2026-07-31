import { type GuildMember } from 'discord.js';
import { Event }  from '../structures/Event';
import logger     from '../utils/Logger';
import WelcomerManager from '../managers/WelcomerManager';

export default new Event({
  name: 'guildMemberRemove',
  async execute(member: GuildMember) {
    if (member.user.bot) return;
    logger.debug(`[guildMemberRemove] ${member.user.tag} left ${member.guild.name}`);

    try {
      await WelcomerManager.fire(member, 'goodbye');
    } catch (err) {
      logger.warn(`[guildMemberRemove] Goodbye message failed: ${(err as Error).message}`);
    }
  },
});
