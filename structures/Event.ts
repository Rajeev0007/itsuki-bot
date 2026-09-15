/**
 * @file Event.ts
 * @description Base class for all Discord gateway events.
 */

import type { Client } from 'discord.js';

export interface EventOptions {
  name: string;
  execute: (...args: unknown[]) => Promise<void> | void;
  once?: boolean;
}

export class Event {
  name: string;
  execute: (...args: unknown[]) => Promise<void> | void;
  once: boolean;

  constructor(options: EventOptions) {
    if (!options.name)    throw new Error('[Event] "name" is required.');
    if (!options.execute) throw new Error('[Event] "execute" function is required.');

    this.name    = options.name;
    this.execute = options.execute;
    this.once    = options.once ?? false;
  }
}
