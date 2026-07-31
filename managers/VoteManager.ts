/**
 * @file VoteManager.ts
 * @description Vote tracking for top.gg and Discord Bot List, plus reminders
 * and the vote-lock check.
 *
 * Both sites allow one vote every 12 hours, tracked per provider so a user who
 * voted on only one site still gets credit — and still gets reminded about the
 * other.
 *
 * Reminders are opt-in and fire at most once per vote cycle. The `reminded`
 * flag is what prevents the scheduler re-DMing every time it runs: without it,
 * a user who votes and never returns would be messaged every sweep, forever.
 */

import { getStore } from '../database/JsonStore';
import logger from '../utils/Logger';

const votesDB = getStore('votes');
const guildsDB = getStore('guilds');

export type VoteProvider = 'topgg' | 'dbl';

export const PROVIDERS: Record<VoteProvider, { label: string; url: (botId: string) => string; cooldownMs: number }> = {
  topgg: {
    label: 'Top.gg',
    url: (botId) => `https://top.gg/bot/${botId}/vote`,
    cooldownMs: 12 * 60 * 60 * 1000,
  },
  dbl: {
    label: 'Discord Bot List',
    url: (botId) => `https://discordbotlist.com/bots/${botId}/upvote`,
    cooldownMs: 12 * 60 * 60 * 1000,
  },
};

export interface VoteRecord {
  /** Last vote timestamp per provider. */
  topgg: number;
  dbl: number;
  /** Lifetime totals. */
  totalTopgg: number;
  totalDbl: number;
  /** Consecutive-day streak, for display. */
  streak: number;
  lastStreakDay: string;
  /** Opt-in DM reminders. */
  remindersEnabled: boolean;
  /** Set when a reminder has been sent for the current cycle. */
  remindedTopgg: boolean;
  remindedDbl: boolean;
}

function emptyRecord(): VoteRecord {
  return {
    topgg: 0, dbl: 0, totalTopgg: 0, totalDbl: 0,
    streak: 0, lastStreakDay: '',
    remindersEnabled: true, remindedTopgg: false, remindedDbl: false,
  };
}

/** Per-guild notifier configuration. */
export interface VoteConfig {
  topggChannelId: string | null;
  dblChannelId: string | null;
  /** Role granted for 24h after voting, if set. */
  voterRoleId: string | null;
  enabled: boolean;
}

export function defaultVoteConfig(): VoteConfig {
  return { topggChannelId: null, dblChannelId: null, voterRoleId: null, enabled: true };
}

const VoteManager = {
  PROVIDERS,

  async getRecord(userId: string): Promise<VoteRecord> {
    const stored = await votesDB.get(`users.${userId}`) as Partial<VoteRecord> | undefined;
    return stored && typeof stored === 'object'
      ? { ...emptyRecord(), ...stored }
      : emptyRecord();
  },

  /** Milliseconds until the user may vote again on a provider; 0 if now. */
  async cooldownRemaining(userId: string, provider: VoteProvider): Promise<number> {
    const record = await this.getRecord(userId);
    const last = Number(record[provider]) || 0;
    const remaining = PROVIDERS[provider].cooldownMs - (Date.now() - last);
    return remaining > 0 ? remaining : 0;
  },

  /**
   * The vote-lock check: has the user voted on ANY provider recently?
   *
   * Deliberately generous — requiring a vote on both sites to use a command
   * would be hostile, and one vote is enough to help the bot's ranking.
   */
  async hasVotedRecently(userId: string): Promise<boolean> {
    const record = await this.getRecord(userId);
    const now = Date.now();
    return (now - (Number(record.topgg) || 0) < PROVIDERS.topgg.cooldownMs)
      || (now - (Number(record.dbl) || 0) < PROVIDERS.dbl.cooldownMs);
  },

  /** Records a vote and returns the updated record plus streak information. */
  async recordVote(userId: string, provider: VoteProvider): Promise<{ record: VoteRecord; streakIncreased: boolean }> {
    const record = await this.getRecord(userId);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    // Streak advances once per calendar day, continues from yesterday, and
    // resets after a gap. Voting twice in one day must not double-count.
    let streakIncreased = false;
    if (record.lastStreakDay !== today) {
      record.streak = record.lastStreakDay === yesterday ? record.streak + 1 : 1;
      record.lastStreakDay = today;
      streakIncreased = true;
    }

    record[provider] = Date.now();
    if (provider === 'topgg') { record.totalTopgg++; record.remindedTopgg = false; }
    else                      { record.totalDbl++;   record.remindedDbl = false; }

    await votesDB.set(`users.${userId}`, record);
    return { record, streakIncreased };
  },

  async setReminders(userId: string, enabled: boolean): Promise<VoteRecord> {
    const record = await this.getRecord(userId);
    record.remindersEnabled = enabled;
    await votesDB.set(`users.${userId}`, record);
    return record;
  },

  /**
   * Users whose vote cooldown has elapsed and who haven't been reminded yet.
   *
   * Only considers people who have voted at least once — nobody gets an
   * unsolicited DM.
   */
  async dueForReminder(): Promise<Array<{ userId: string; provider: VoteProvider }>> {
    const all = (await votesDB.get('users') ?? {}) as Record<string, VoteRecord>;
    const due: Array<{ userId: string; provider: VoteProvider }> = [];
    const now = Date.now();

    for (const [userId, raw] of Object.entries(all)) {
      const record = { ...emptyRecord(), ...raw };
      if (!record.remindersEnabled) continue;

      for (const provider of ['topgg', 'dbl'] as VoteProvider[]) {
        const last = Number(record[provider]) || 0;
        // Never voted here — no reminder to give.
        if (last === 0) continue;
        const remindedKey = provider === 'topgg' ? 'remindedTopgg' : 'remindedDbl';
        if (record[remindedKey]) continue;
        if (now - last >= PROVIDERS[provider].cooldownMs) {
          due.push({ userId, provider });
        }
      }
    }
    return due;
  },

  /** Marks a reminder as sent so it isn't repeated this cycle. */
  async markReminded(userId: string, provider: VoteProvider): Promise<void> {
    const record = await this.getRecord(userId);
    if (provider === 'topgg') record.remindedTopgg = true;
    else record.remindedDbl = true;
    await votesDB.set(`users.${userId}`, record);
  },

  // ── Guild notifier config ────────────────────────────────────────────────

  async getConfig(guildId: string): Promise<VoteConfig> {
    const stored = await guildsDB.get(`${guildId}.votes`) as Partial<VoteConfig> | undefined;
    return stored && typeof stored === 'object'
      ? { ...defaultVoteConfig(), ...stored }
      : defaultVoteConfig();
  },

  async setConfig(guildId: string, patch: Partial<VoteConfig>): Promise<VoteConfig> {
    const next = { ...(await this.getConfig(guildId)), ...patch };
    await guildsDB.set(`${guildId}.votes`, next);
    return next;
  },

  /** Every guild with a notifier channel configured, for broadcasting a vote. */
  async guildsWithNotifier(provider: VoteProvider): Promise<Array<{ guildId: string; channelId: string; config: VoteConfig }>> {
    const all = await guildsDB.all();
    const out: Array<{ guildId: string; channelId: string; config: VoteConfig }> = [];

    for (const [guildId, data] of all) {
      const raw = (data as { votes?: Partial<VoteConfig> } | null)?.votes;
      if (!raw || typeof raw !== 'object') continue;
      const cfg = { ...defaultVoteConfig(), ...raw };
      if (!cfg.enabled) continue;
      const channelId = provider === 'topgg' ? cfg.topggChannelId : cfg.dblChannelId;
      if (channelId) out.push({ guildId, channelId, config: cfg });
    }
    return out;
  },

  /** Total votes across both providers, for display. */
  async totals(userId: string): Promise<{ topgg: number; dbl: number; all: number; streak: number }> {
    const r = await this.getRecord(userId);
    return {
      topgg: Number(r.totalTopgg) || 0,
      dbl: Number(r.totalDbl) || 0,
      all: (Number(r.totalTopgg) || 0) + (Number(r.totalDbl) || 0),
      streak: Number(r.streak) || 0,
    };
  },

  /** Leaderboard of the most prolific voters. */
  async leaderboard(limit = 10): Promise<Array<{ userId: string; value: number }>> {
    const all = (await votesDB.get('users') ?? {}) as Record<string, VoteRecord>;
    return Object.entries(all)
      .map(([userId, r]) => ({
        userId,
        value: (Number(r?.totalTopgg) || 0) + (Number(r?.totalDbl) || 0),
      }))
      .filter((e) => e.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
  },
};

export default VoteManager;
