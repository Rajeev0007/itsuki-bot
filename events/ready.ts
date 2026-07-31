/**
 * @file ready.ts
 * @description Fires once when the bot connects and is ready.
 */

import { ActivityType, type Client } from 'discord.js';
import { Event }   from '../structures/Event';
import config      from '../config/config';
import logger      from '../utils/Logger';
import { getStore } from '../database/JsonStore';
import musicManager from '../managers/MusicManager';

export default new Event({
  name: 'ready',
  once: true,
  async execute(client: Client) {
    logger.ready(`Logged in as ${client.user!.tag} | ${client.guilds.cache.size} guild(s)`);
    logger.info(`Serving ${client.users.cache.size} users | ${client.channels.cache.size} channels`);

    const activities = config.presence.activities;
    let idx = 0;

    const setPresence = () => {
      for (const [, session] of musicManager.sessions) {
        if (session.current) return;
      }
      const act = activities[idx % activities.length];
      client.user!.setPresence({
        status: config.presence.status,
        activities: [{ name: act.name, type: act.type ?? ActivityType.Playing }],
      });
      idx++;
    };

    setPresence();
    setInterval(setPresence, config.presence.activityInterval);

    // Only stores the bot actually uses. 'anime' and 'marriages' don't exist —
    // naming them here made getStore() create two empty JSON files on the first
    // backup pass and then dutifully back them up forever.
    const STORES = [
      'users', 'economy', 'inventory', 'pets', 'gambling',
      'guilds', 'social', 'actions', 'profiles', 'moderation',
    ];
    setInterval(async () => {
      for (const name of STORES) {
        try { await getStore(name).backup(); } catch { /* ignore */ }
      }
      logger.debug('[Ready] Periodic DB backup completed');
    }, 6 * 60 * 60 * 1000);
  },
});
