/**
 * @file ready.ts
 * @description Fires once when the bot connects and is ready.
 */

import { type Client } from 'discord.js';
import { Event }   from '../structures/Event';
import logger      from '../utils/Logger';
import { getStore } from '../database/JsonStore';
import PresenceManager from '../managers/PresenceManager';
import StatsManager from '../managers/StatsManager';
import CardManager from '../managers/CardManager';
import CardService from '../services/CardService';

export default new Event({
  name: 'ready',
  once: true,
  async execute(client: Client) {
    logger.ready(`Logged in as ${client.user!.tag} | ${client.guilds.cache.size} guild(s)`);
    logger.info(`Serving ${client.users.cache.size} users | ${client.channels.cache.size} channels`);

    // Presence is owned by PresenceManager so the owner panel can change it
    // live and have it survive a restart. It restores any saved custom presence
    // and starts the rotation loop itself.
    await PresenceManager.init(client);

    // ── Activity tracking ───────────────────────────────────────────────────
    // Counters are buffered in memory; this starts the periodic disk flush.
    StatsManager.start();

    // ── Card game upkeep ────────────────────────────────────────────────────
    // Warm the character cache so the first /roll isn't waiting on Jikan.
    void CardService.preload().catch(() => { /* non-fatal */ });

    // Return expired auction listings to their sellers. Runs on boot and then
    // every 10 minutes, so a card can never be stranded in escrow.
    void CardManager.expireListings().catch(() => { /* non-fatal */ });
    setInterval(() => {
      void CardManager.expireListings().catch(() => { /* non-fatal */ });
    }, 10 * 60_000);

    // Only stores the bot actually uses. 'anime' and 'marriages' don't exist —
    // naming them here made getStore() create two empty JSON files on the first
    // backup pass and then dutifully back them up forever.
    const STORES = [
      'users', 'economy', 'inventory', 'pets', 'gambling',
      'guilds', 'social', 'actions', 'profiles', 'moderation',
      'cards', 'auctions', 'stats',
    ];
    setInterval(async () => {
      for (const name of STORES) {
        try { await getStore(name).backup(); } catch { /* ignore */ }
      }
      logger.debug('[Ready] Periodic DB backup completed');
    }, 6 * 60 * 60 * 1000);
  },
});
