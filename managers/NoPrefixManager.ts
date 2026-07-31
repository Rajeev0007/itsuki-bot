/**
 * @file NoPrefixManager.ts
 * @description The no-prefix allowlist — users who can run commands without
 * typing the bot prefix, e.g. `balance` instead of `,balance`.
 *
 * `has()` is deliberately synchronous because it runs on EVERY message. The
 * allowlist is mirrored into a Map at boot and kept in sync on write, so the
 * hot path never touches disk.
 *
 * Expiry is evaluated on read rather than by a sweeper, matching
 * PremiumManager: a background job would revoke access if it happened to run
 * during a restart or with a skewed clock, whereas deriving it from the stored
 * timestamp is always correct.
 */

import { getStore } from '../database/Store';
import config from '../config/config';
import logger from '../utils/Logger';

export type NoPrefixSource = 'manual' | 'premium';

export interface NoPrefixEntry {
  username: string;
  addedAt: number;
  /** null = never expires. */
  expiresAt: number | null;
  /** `premium` entries are removed automatically when premium is revoked. */
  source: NoPrefixSource;
  grantedBy: string | null;
}

export interface AddOptions {
  /** Absolute timestamp, or null for permanent. Omit for permanent. */
  expiresAt?: number | null;
  source?: NoPrefixSource;
  grantedBy?: string;
}

/**
 * Results use optional fields rather than a discriminated union: this project
 * compiles with `strict: false`, where TypeScript will not narrow
 * `{ok:true}|{ok:false}`.
 */
export interface AddResult {
  ok: boolean;
  reason?: string;
  entry?: NoPrefixEntry;
  /** True when the user was already listed and the grant was extended. */
  extended?: boolean;
}

class NoPrefixManager {
  private readonly _db = getStore('noprefix');
  private readonly _cache = new Map<string, NoPrefixEntry>();
  private _loadPromise: Promise<void>;

  constructor() {
    this._loadPromise = this._load();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /**
   * Repairs a stored record instead of discarding it.
   *
   * The previous version only checked `typeof entry === 'object'`, so a
   * half-written or hand-edited record was cached as-is and rendered as
   * `undefined` / `Invalid Date` in the listing. Anything that failed the check
   * was skipped entirely, which also made it impossible to remove.
   */
  private _normalize(raw: unknown): NoPrefixEntry | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const e = raw as Partial<NoPrefixEntry>;
    return {
      username: typeof e.username === 'string' && e.username ? e.username : 'unknown user',
      addedAt: Number.isFinite(Number(e.addedAt)) ? Number(e.addedAt) : Date.now(),
      // Records written before expiry existed were permanent in practice, so
      // that is what a missing field means.
      expiresAt: typeof e.expiresAt === 'number' ? e.expiresAt : null,
      source: e.source === 'premium' ? 'premium' : 'manual',
      grantedBy: typeof e.grantedBy === 'string' ? e.grantedBy : null,
    };
  }

  private async _load(): Promise<void> {
    try {
      const raw = (await this._db.get()) as Record<string, unknown> | null;
      if (raw && typeof raw === 'object') {
        for (const [id, value] of Object.entries(raw)) {
          const entry = this._normalize(value);
          if (entry) this._cache.set(id, entry);
          else logger.warn(`[NoPrefix] Discarded unreadable entry for ${id}.`);
        }
      }
      logger.debug(`[NoPrefix] Loaded ${this._cache.size} entries from disk.`);
    } catch (err) {
      // The cache stays empty, so no-prefix simply does not apply. Loud on
      // purpose: silently dropping everyone's perk is very hard to diagnose.
      logger.error('[NoPrefix] Failed to load noprefix.json — no-prefix is INACTIVE this session:', (err as Error).message);
    }
  }

  /** Call once on startup so the cache is warm before messageCreate runs. */
  async ready(): Promise<void> {
    return this._loadPromise;
  }

  private _isOwner(userId: string): boolean {
    return config.owners.includes(userId);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Synchronous O(1) check — safe to call inside messageCreate with no await.
   *
   * Owners are always included. The `/noprefix` command has always claimed
   * "bot owners always have NoPrefix by default", but this was never
   * implemented and `add()` also refused to add an owner, so owners were the
   * one group who could never obtain the perk at all.
   */
  has(userId: string): boolean {
    if (this._isOwner(userId)) return true;

    const entry = this._cache.get(userId);
    if (!entry) return false;

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      // Lazily drop it so the listing and count stay honest.
      this._cache.delete(userId);
      void this._db.delete(userId).catch((err: Error) =>
        logger.debug(`[NoPrefix] Could not delete expired entry ${userId}: ${err.message}`));
      return false;
    }
    return true;
  }

  /** The active entry for a user, or null. Owners have no stored entry. */
  entry(userId: string): NoPrefixEntry | null {
    const entry = this._cache.get(userId);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) return null;
    return entry;
  }

  async add(userId: string, username: string, opts: AddOptions = {}): Promise<AddResult> {
    const existing = this.entry(userId);
    const requested = opts.expiresAt === undefined ? null : opts.expiresAt;

    // Never shorten an existing grant: renewing should extend, and a permanent
    // grant must not be downgraded into a time-limited one by a later premium
    // redemption.
    let expiresAt = requested;
    if (existing) {
      if (existing.expiresAt === null || requested === null) expiresAt = null;
      else expiresAt = Math.max(existing.expiresAt, requested);
    }

    const entry: NoPrefixEntry = {
      username: username || existing?.username || 'unknown user',
      addedAt: existing?.addedAt ?? Date.now(),
      expiresAt,
      source: opts.source ?? existing?.source ?? 'manual',
      grantedBy: opts.grantedBy ?? existing?.grantedBy ?? null,
    };

    const previous = this._cache.get(userId);
    this._cache.set(userId, entry);
    try {
      await this._db.set(userId, entry);
    } catch (err) {
      // Roll back so memory and disk agree. Previously the cache was written
      // first and never reverted, so a failed write still reported success and
      // the grant disappeared on the next restart.
      if (previous) this._cache.set(userId, previous);
      else this._cache.delete(userId);
      return { ok: false, reason: `Could not save to disk: ${(err as Error).message}` };
    }

    return { ok: true, entry, extended: Boolean(existing) };
  }

  async remove(userId: string): Promise<{ ok: boolean; reason?: string }> {
    const inCache = this._cache.has(userId);
    // Also check disk: a record that failed normalisation, or one added by hand
    // to noprefix.json, previously could never be removed because the method
    // returned early on the cache miss.
    let onDisk = false;
    try {
      onDisk = Boolean(await this._db.get(userId));
    } catch {
      onDisk = false;
    }
    if (!inCache && !onDisk) return { ok: false, reason: 'not-listed' };

    this._cache.delete(userId);
    try {
      await this._db.delete(userId);
    } catch (err) {
      if (inCache) return { ok: false, reason: `Could not save to disk: ${(err as Error).message}` };
    }
    return { ok: true };
  }

  /** Active entries only, newest grant first. */
  list(): Array<{ userId: string } & NoPrefixEntry> {
    const now = Date.now();
    return [...this._cache.entries()]
      .filter(([, e]) => e.expiresAt === null || e.expiresAt > now)
      .map(([userId, entry]) => ({ userId, ...entry }))
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  /** Count of active entries. Excludes owners, who are implicit. */
  count(): number {
    return this.list().length;
  }
}

export default new NoPrefixManager();
