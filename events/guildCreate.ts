import { type Guild } from 'discord.js';
import { Event }    from '../structures/Event';
import { getStore } from '../database/Store';
import logger       from '../utils/Logger';

export default new Event({
  name: 'guildCreate',
  async execute(guild: Guild) {
    logger.info(`[guildCreate] Joined: ${guild.name} (${guild.id}) — ${guild.memberCount} members`);
    const guildsDB = getStore('guilds');
    await guildsDB.ensure(guild.id, {
      guildId: guild.id, name: guild.name, joinedAt: Date.now(), prefix: '!', settings: {},
    });
    const channel =
      guild.systemChannel ??
      guild.channels.cache.filter((c) => c.isTextBased() && c.permissionsFor(guild.members.me!)?.has('SendMessages')).first();
    if (channel && channel.isTextBased()) {
      await (channel as any).send({
        content: [
          '## Thanks for adding me!', '',
          'I\'m a **Premium Economy Bot** with gambling, anime collection, social actions, and more.',
          '', '**Get started:**',
          '• `/help` — View all commands', '• `/balance` — Check your wallet',
          '• `/daily` — Claim your first daily reward', '• `/shop browse` — Browse the item shop',
        ].join('\n'),
      }).catch(() => {});
    }
  },
});
