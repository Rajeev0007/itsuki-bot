/**
 * @file BlacklistManager.ts
 * @description Manages the global user blacklist. Blacklisted users cannot
 * run any command (slash or prefix), anywhere.
 *
 * Same pattern as NoPrefixManager: mirrored to an in-memory Set so `has()`
 * lookups are synchronous (O(1)) with zero DB overhead on every message.
 */

import { getStore } from '../database/Store';
import logger       from '../utils/Logger';

interface BlacklistEntry {
  reason:      string;
  blacklistedBy: string;
  addedAt:     number;
}

class BlacklistManager {
  private readonly _db    = getStore('blacklist');
  private readonly _cache = new Map<string, BlacklistEntry>(); // userId → entry
  private _loadPromise: Promise<void>;

  constructor() {
    this._loadPromise = this._load();
  }

  private async _load(): Promise<void> {
    try {
      const raw = (await this._db.get()) as Record<string, BlacklistEntry> | null;
      if (raw && typeof raw === 'object') {
        for (const [id, entry] of Object.entries(raw)) {
          if (entry && typeof entry === 'object') this._cache.set(id, entry);
        }
      }
      logger.debug(`[Blacklist] Loaded ${this._cache.size} entries from disk.`);
    } catch (err) {
      logger.error('[Blacklist] Failed to load blacklist.json:', (err as Error).message);
    }
  }

  /** Call once on startup so the cache is warm before any command can run. */
  async ready(): Promise<void> {
    return this._loadPromise;
  }

  /** Synchronous O(1) check — safe to call inside messageCreate/interactionCreate. */
  has(userId: string): boolean {
    return this._cache.has(userId);
  }

  get(userId: string): BlacklistEntry | undefined {
    return this._cache.get(userId);
  }

  async add(userId: string, reason: string, blacklistedBy: string): Promise<boolean> {
    if (this._cache.has(userId)) return false;
    const entry: BlacklistEntry = { reason, blacklistedBy, addedAt: Date.now() };
    this._cache.set(userId, entry);
    await this._db.set(userId, entry);
    return true;
  }

  async remove(userId: string): Promise<boolean> {
    if (!this._cache.has(userId)) return false;
    this._cache.delete(userId);
    await this._db.delete(userId);
    return true;
  }

  list(): Array<{ userId: string } & BlacklistEntry> {
    return [...this._cache.entries()].map(([userId, entry]) => ({ userId, ...entry }));
  }

  count(): number {
    return this._cache.size;
  }
}

export default new BlacklistManager();
