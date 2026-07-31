/**
 * @file StatsManager.ts
 * @description Per-user activity tracking (messages, voice time, commands) with
 * a rolling daily breakdown, plus the leaderboard queries behind /leaderboard.
 *
 * Storage shape, per guild+user:
 *   stats.<guildId>.<userId> = {
 *     messages, voiceSeconds, commands, firstSeen, lastSeen,
 *     daily: { 'YYYY-MM-DD': { messages, voiceSeconds } }
 *   }
 *
 * Two things this deliberately avoids:
 *  - Writing on every single message. Message counts are buffered in memory and
 *    flushed periodically; a busy server would otherwise rewrite the whole JSON
 *    store hundreds of times a minute.
 *  - Unbounded growth. Only the last 30 days of daily buckets are kept.
 */

import { getStore } from '../database/JsonStore';
import logger from '../utils/Logger';

const statsDB = getStore('stats');

const DAILY_RETENTION_DAYS = 30;
const FLUSH_INTERVAL_MS = 30_000;

export interface UserStats {
  messages: number;
  voiceSeconds: number;
  commands: number;
  firstSeen: number;
  lastSeen: number;
  daily: Record<string, { messages: number; voiceSeconds: number }>;
}

export type StatMetric = 'messages' | 'voiceSeconds' | 'commands';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyStats(): UserStats {
  return { messages: 0, voiceSeconds: 0, commands: 0, firstSeen: Date.now(), lastSeen: Date.now(), daily: {} };
}

/** Pending increments, keyed `guildId:userId`. */
interface Pending { messages: number; voiceSeconds: number; commands: number }
const buffer = new Map<string, Pending>();

/** Voice session starts, keyed `guildId:userId`. */
const voiceSince = new Map<string, number>();

// ReturnType<> avoids depending on the NodeJS namespace (@types/node).
let flushTimer: ReturnType<typeof setInterval> | null = null;

function bump(guildId: string, userId: string, field: keyof Pending, amount: number): void {
  if (!guildId || !userId || amount <= 0) return;
  const key = `${guildId}:${userId}`;
  const entry = buffer.get(key) ?? { messages: 0, voiceSeconds: 0, commands: 0 };
  entry[field] += amount;
  buffer.set(key, entry);
}

const StatsManager = {
  /** Starts the periodic flush. Called once from the ready event. */
  start(): void {
    if (flushTimer) return;
    flushTimer = setInterval(() => { void this.flush(); }, FLUSH_INTERVAL_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
    logger.debug('[Stats] Activity buffer flushing every 30s.');
  },

  recordMessage(guildId: string, userId: string): void {
    bump(guildId, userId, 'messages', 1);
  },

  recordCommand(guildId: string, userId: string): void {
    bump(guildId, userId, 'commands', 1);
  },

  /** Marks the start of a voice session. */
  voiceJoin(guildId: string, userId: string): void {
    voiceSince.set(`${guildId}:${userId}`, Date.now());
  },

  /**
   * Closes a voice session and banks the elapsed time.
   *
   * Returns 0 when there was no recorded join — which happens for anyone
   * already in a channel when the bot started, so it must not be treated as an
   * error or produce a negative duration.
   */
  voiceLeave(guildId: string, userId: string): number {
    const key = `${guildId}:${userId}`;
    const since = voiceSince.get(key);
    if (!since) return 0;
    voiceSince.delete(key);

    const seconds = Math.floor((Date.now() - since) / 1000);
    // Ignore nonsense values (clock changes, or a sub-second in/out).
    if (seconds <= 0 || seconds > 86_400) return 0;
    bump(guildId, userId, 'voiceSeconds', seconds);
    return seconds;
  },

  /** Writes buffered counters to disk. */
  async flush(): Promise<void> {
    if (!buffer.size) return;
    // Swap the buffer out first so counts recorded during the await aren't lost.
    const pending = new Map(buffer);
    buffer.clear();

    const day = today();
    for (const [key, delta] of pending) {
      const [guildId, userId] = key.split(':');
      try {
        const path = `${guildId}.${userId}`;
        const existing = await statsDB.get(path) as Partial<UserStats> | undefined;
        const stats: UserStats = existing && typeof existing === 'object'
          ? { ...emptyStats(), ...existing, daily: { ...(existing.daily ?? {}) } }
          : emptyStats();

        stats.messages     += delta.messages;
        stats.voiceSeconds += delta.voiceSeconds;
        stats.commands     += delta.commands;
        stats.lastSeen      = Date.now();

        const bucket = stats.daily[day] ?? { messages: 0, voiceSeconds: 0 };
        bucket.messages     += delta.messages;
        bucket.voiceSeconds += delta.voiceSeconds;
        stats.daily[day] = bucket;

        // Trim old buckets so the store can't grow without bound.
        const cutoff = new Date(Date.now() - DAILY_RETENTION_DAYS * 86_400_000)
          .toISOString().slice(0, 10);
        for (const d of Object.keys(stats.daily)) {
          if (d < cutoff) delete stats.daily[d];
        }

        await statsDB.set(path, stats);
      } catch (err) {
        logger.warn(`[Stats] Flush failed for ${key}: ${(err as Error).message}`);
      }
    }
  },

  async getStats(guildId: string, userId: string): Promise<UserStats> {
    const stored = await statsDB.get(`${guildId}.${userId}`) as Partial<UserStats> | undefined;
    // Explicit annotation: without it the ternary widens and `daily` loses its
    // value type, making Object.entries() yield `unknown`.
    const base: UserStats = stored && typeof stored === 'object'
      ? { ...emptyStats(), ...stored, daily: { ...(stored.daily ?? {}) } }
      : emptyStats();

    // Fold in anything still buffered so /userstats never looks stale.
    const delta = buffer.get(`${guildId}:${userId}`);
    if (delta) {
      base.messages     += delta.messages;
      base.voiceSeconds += delta.voiceSeconds;
      base.commands     += delta.commands;
    }
    // Include an in-progress voice session.
    const since = voiceSince.get(`${guildId}:${userId}`);
    if (since) base.voiceSeconds += Math.max(0, Math.floor((Date.now() - since) / 1000));

    return base;
  },

  /** Totals over the last N days from the daily buckets. */
  async getRecent(guildId: string, userId: string, days: number): Promise<{ messages: number; voiceSeconds: number }> {
    const stats = await this.getStats(guildId, userId);
    const cutoff = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString().slice(0, 10);
    // `?? {}` here would widen the union and make the entry values `unknown`;
    // getStats always returns a populated `daily` object, so use it directly.
    const daily: UserStats['daily'] = stats.daily;
    let messages = 0, voiceSeconds = 0;
    for (const [day, bucket] of Object.entries(daily)) {
      if (day < cutoff) continue;
      messages     += Number(bucket?.messages) || 0;
      voiceSeconds += Number(bucket?.voiceSeconds) || 0;
    }
    return { messages, voiceSeconds };
  },

  /** Per-day series for the last N days, oldest first — for charts. */
  async getSeries(guildId: string, userId: string, days = 14): Promise<Array<{ day: string; messages: number; voiceSeconds: number }>> {
    const stats = await this.getStats(guildId, userId);
    const out: Array<{ day: string; messages: number; voiceSeconds: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const bucket = stats.daily?.[day];
      out.push({
        day,
        messages: Number(bucket?.messages) || 0,
        voiceSeconds: Number(bucket?.voiceSeconds) || 0,
      });
    }
    return out;
  },

  /**
   * Activity leaderboard for a guild.
   *
   * `days` restricts to the daily buckets; omit it for all-time.
   */
  async getLeaderboard(
    guildId: string, metric: StatMetric, limit = 10, days?: number,
  ): Promise<Array<{ userId: string; value: number }>> {
    // Flush first so the ranking reflects activity from the current window.
    await this.flush();

    const guildStats = await statsDB.get(`${guildId}`) as Record<string, UserStats> | undefined;
    if (!guildStats || typeof guildStats !== 'object') return [];

    const cutoff = days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : null;

    return Object.entries(guildStats)
      .filter(([, s]) => s && typeof s === 'object')
      .map(([userId, s]) => {
        if (!cutoff) return { userId, value: Number(s[metric]) || 0 };
        if (metric === 'commands') return { userId, value: Number(s.commands) || 0 };
        let value = 0;
        for (const [day, bucket] of Object.entries(s.daily ?? {})) {
          if (day < cutoff) continue;
          value += Number((bucket as { messages: number; voiceSeconds: number })?.[metric as 'messages' | 'voiceSeconds']) || 0;
        }
        return { userId, value };
      })
      .filter((e) => e.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
  },

  /** A user's 1-based rank for a metric, or null when unranked. */
  async getRank(guildId: string, userId: string, metric: StatMetric): Promise<number | null> {
    const board = await this.getLeaderboard(guildId, metric, 1000);
    const idx = board.findIndex((e) => e.userId === userId);
    return idx === -1 ? null : idx + 1;
  },
};

export default StatsManager;
