import { type Guild } from 'discord.js';
import { Event }  from '../structures/Event';
import logger     from '../utils/Logger';

export default new Event({
  name: 'guildDelete',
  async execute(guild: Guild) {
    logger.info(`[guildDelete] Removed from: ${guild.name} (${guild.id})`);
  },
});
