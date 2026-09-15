/**
 * @file EventHandler.ts
 * @description Dynamically loads and registers all event files.
 */

import fs   from 'fs';
import path from 'path';
import { type Client } from 'discord.js';
import { Event } from '../structures/Event';
import logger from '../utils/Logger';

export default class EventHandler {
  client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  load(): void {
    const eventsPath = path.join(__dirname, '../events');
    const files      = fs.readdirSync(eventsPath).filter((f) => f.endsWith('.ts'));
    let count = 0;

    for (const file of files) {
      const filePath = path.join(eventsPath, file);
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(filePath);
        const event = (mod.default ?? mod) as Event;
        if (!event?.name || !event?.execute) {
          logger.warn(`[EventHandler] Skipping ${file} — missing name or execute`);
          continue;
        }
        const handler = (...args: unknown[]) => event.execute(...args, this.client);
        if (event.once) {
          this.client.once(event.name, handler);
        } else {
          this.client.on(event.name, handler);
        }
        count++;
        logger.debug(`[EventHandler] Registered event: ${event.name}`);
      } catch (err) {
        logger.error(`[EventHandler] Failed to load ${file}:`, (err as Error).message);
      }
    }

    logger.info(`[EventHandler] Registered ${count} events`);
  }
}
