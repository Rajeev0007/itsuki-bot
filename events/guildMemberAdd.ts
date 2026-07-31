import { type GuildMember } from 'discord.js';
import { Event }       from '../structures/Event';
import UserManager     from '../managers/UserManager';
import WelcomerManager from '../managers/WelcomerManager';
import logger          from '../utils/Logger';

export default new Event({
  name: 'guildMemberAdd',
  async execute(member: GuildMember) {
    if (member.user.bot) return;
    logger.debug(`[guildMemberAdd] ${member.user.tag} joined ${member.guild.name}`);
    try {
      // Just provision the records. Do NOT grant 'first_balance' here — that
      // achievement is for actually running /balance, and awarding it on join
      // handed every new member its coin reward for doing nothing.
      await UserManager.getUser(member.user.id, member.guild.id);
      await UserManager.getEconomy(member.user.id);
      await UserManager.updateUsername(member.user.id, member.user.username);
    } catch (err) {
      logger.error('[guildMemberAdd] Failed to init user:', (err as Error).message);
    }

    // Kept separate from the record provisioning above: a database hiccup must
    // not stop the welcome message, and vice versa.
    try {
      await WelcomerManager.fire(member, 'welcome');
    } catch (err) {
      logger.warn(`[guildMemberAdd] Welcomer failed: ${(err as Error).message}`);
    }
  },
});
