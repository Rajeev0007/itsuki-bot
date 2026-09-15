/**
 * @file UserManager.ts
 * @description Manages user profiles, XP, levels, achievements, and stats.
 */

import { getStore }  from '../database/Store';
import config        from '../config/config';
import logger        from '../utils/Logger';

const usersDB        = getStore('users');
const economyDB      = getStore('economy');
const achievementsDB = getStore('achievements');
const profilesDB     = getStore('profiles');
const actionsDB      = getStore('actions');

export interface UserData {
  userId: string; guildId: string; username: string; createdAt: number;
  level: number; xp: number; totalXp: number; prestige: number;
  reputation: number; title: string; badges: string[]; achievements: string[];
  stats: {
    commandsUsed: number; gamesPlayed: number; gamesWon: number;
    socialActions: number; crimeCount: number; crimeSuccess: number;
    robCount: number; robSuccess: number; fishCount: number; mineCount: number;
    huntCount: number; farmCount: number; chopCount: number; craftCount: number;
  };
  lastSeen: number;
}

export interface EconomyData {
  userId: string; wallet: number; bank: number; netWorth: number;
  totalEarned: number; totalSpent: number; dailyStreak?: number;
  lastDaily: number; lastWeekly: number; lastMonthly: number; lastYearly: number;
  lastWork: number; lastCrime: number; lastRob: number; lastBeg: number;
  lastSearch: number; lastHunt: number; lastFish: number; lastMine: number;
  lastFarm: number; lastChop: number;
  transactions: Array<{ type: string; amount: number; description: string; timestamp: number }>;
}

function defaultUser(userId: string, guildId: string): UserData {
  return {
    userId, guildId, username: '', createdAt: Date.now(),
    level: 1, xp: 0, totalXp: 0, prestige: 0, reputation: 0,
    title: 'Newcomer', badges: [], achievements: [],
    stats: {
      commandsUsed: 0, gamesPlayed: 0, gamesWon: 0, socialActions: 0,
      crimeCount: 0, crimeSuccess: 0, robCount: 0, robSuccess: 0,
      fishCount: 0, mineCount: 0, huntCount: 0, farmCount: 0,
      chopCount: 0, craftCount: 0,
    },
    lastSeen: Date.now(),
  };
}

function defaultEconomy(userId: string): EconomyData {
  return {
    userId, wallet: config.economy.startingBalance, bank: config.economy.startingBank,
    netWorth: config.economy.startingBalance, totalEarned: 0, totalSpent: 0,
    lastDaily: 0, lastWeekly: 0, lastMonthly: 0, lastYearly: 0,
    lastWork: 0, lastCrime: 0, lastRob: 0, lastBeg: 0, lastSearch: 0,
    lastHunt: 0, lastFish: 0, lastMine: 0, lastFarm: 0, lastChop: 0,
    transactions: [],
  };
}

/** Coerces a possibly-missing stored timestamp into a usable number. */
function ts(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const UserManager = {
  /**
   * Returns the user record with defaults merged in.
   *
   * Merging matters: records written by older versions of the bot are missing
   * fields added later, and reading an absent field straight out of the store
   * yields `undefined`. Arithmetic on that produces NaN, and `NaN > 0` is
   * false — which silently disabled cooldowns and stat checks.
   */
  async getUser(userId: string, guildId = 'global'): Promise<UserData> {
    const defaults = defaultUser(userId, guildId);
    const stored = (await usersDB.get(`${userId}`)) as Partial<UserData> | undefined;
    if (!stored || typeof stored !== 'object') {
      await usersDB.set(`${userId}`, defaults);
      return defaults;
    }
    return {
      ...defaults,
      ...stored,
      stats: { ...defaults.stats, ...(stored.stats ?? {}) },
    } as UserData;
  },

  /** Returns the economy record with defaults merged in (see getUser). */
  async getEconomy(userId: string): Promise<EconomyData> {
    const defaults = defaultEconomy(userId);
    const stored = (await economyDB.get(`${userId}`)) as Partial<EconomyData> | undefined;
    if (!stored || typeof stored !== 'object') {
      await economyDB.set(`${userId}`, defaults);
      return defaults;
    }
    const merged = { ...defaults, ...stored } as EconomyData;
    // Normalise every cooldown timestamp so callers can do plain arithmetic.
    merged.lastDaily   = ts(merged.lastDaily);
    merged.lastWeekly  = ts(merged.lastWeekly);
    merged.lastMonthly = ts(merged.lastMonthly);
    merged.lastYearly  = ts(merged.lastYearly);
    merged.lastWork    = ts(merged.lastWork);
    merged.lastCrime   = ts(merged.lastCrime);
    merged.lastRob     = ts(merged.lastRob);
    merged.lastBeg     = ts(merged.lastBeg);
    merged.lastSearch  = ts(merged.lastSearch);
    merged.wallet      = Number(merged.wallet) || 0;
    merged.bank        = Number(merged.bank) || 0;
    return merged;
  },

  async updateUsername(userId: string, username: string): Promise<void> {
    const has = await usersDB.has(`${userId}`);
    if (has) await usersDB.set(`${userId}.username`, username);
  },

  /**
   * XP required to advance FROM `level` to `level + 1`.
   *
   * Every caller must use the same convention — display code used to call
   * `xpNeeded(level + 1)` while the level-up check used `xpNeeded(level)`, so
   * progress bars never lined up with the point a user actually levelled.
   */
  xpNeeded(level: number): number {
    return config.economy.xpToLevelUp(Math.max(1, level));
  },

  async addXp(userId: string, amount: number): Promise<{ leveledUp: boolean; newLevel?: number }> {
    const gain = Math.max(0, Math.floor(Number(amount) || 0));
    if (gain === 0) return { leveledUp: false };

    const user = await this.getUser(userId);
    const maxLevel = config.economy.maxLevel;

    let level = Math.max(1, Math.floor(Number(user.level) || 1));
    let xp = Math.max(0, Math.floor(Number(user.xp) || 0)) + gain;
    let leveledUp = false;

    // Loop: a single large XP grant can span several levels. The old code only
    // ever advanced one level per call and discarded the rest of the overflow.
    while (level < maxLevel) {
      const needed = this.xpNeeded(level);
      if (needed <= 0 || xp < needed) break;
      xp -= needed;
      level++;
      leveledUp = true;
    }
    // At max level XP stops accumulating instead of growing forever.
    if (level >= maxLevel) {
      level = maxLevel;
      xp = Math.min(xp, this.xpNeeded(maxLevel));
    }

    await usersDB.set(`${userId}.level`, level);
    await usersDB.set(`${userId}.xp`, xp);
    await usersDB.add(`${userId}.totalXp`, gain);

    return leveledUp ? { leveledUp: true, newLevel: level } : { leveledUp: false };
  },

  /** Permanent earnings multiplier granted by prestige (1.0 = no bonus). */
  async earningsMultiplier(userId: string): Promise<number> {
    const user = await this.getUser(userId);
    const prestige = Math.max(0, Number(user.prestige) || 0);
    return 1 + prestige * config.economy.prestigeBonus;
  },

  /**
   * Credits earned income, applying the prestige bonus the UI advertises.
   * Returns the amount actually credited so callers can report the real figure.
   *
   * Use this for income (work/daily/crime/…); use addWallet directly for
   * gambling payouts, transfers and fines, which must not be scaled.
   */
  async addEarnings(userId: string, baseAmount: number): Promise<number> {
    const base = Math.max(0, Math.floor(Number(baseAmount) || 0));
    if (base === 0) return 0;
    const total = Math.floor(base * (await this.earningsMultiplier(userId)));
    await this.addWallet(userId, total);
    return total;
  },

  async getBalance(userId: string): Promise<{ wallet: number; bank: number }> {
    const eco = await this.getEconomy(userId);
    return { wallet: eco.wallet, bank: eco.bank };
  },

  /**
   * Adds to (or subtracts from) the wallet, clamped to `[0, maxWallet]`.
   *
   * The clamp is the important part: nothing previously stopped a wallet going
   * negative, and `maxWallet` was only ever enforced inside /withdraw.
   * totalEarned/totalSpent are updated from the delta that actually landed, so
   * a clamped transaction no longer inflates lifetime totals.
   */
  async addWallet(userId: string, amount: number): Promise<number> {
    const delta = Math.floor(Number(amount) || 0);
    await economyDB.ensure(`${userId}`, defaultEconomy(userId));
    const current = Number(await economyDB.get(`${userId}.wallet`, 0)) || 0;
    const next = Math.max(0, Math.min(current + delta, config.economy.maxWallet));
    const applied = next - current;

    await economyDB.set(`${userId}.wallet`, next);
    if (applied > 0)      await economyDB.add(`${userId}.totalEarned`, applied);
    else if (applied < 0) await economyDB.add(`${userId}.totalSpent`, -applied);
    await this._updateNetWorth(userId);
    return next;
  },

  async setWallet(userId: string, amount: number): Promise<void> {
    await economyDB.ensure(`${userId}`, defaultEconomy(userId));
    const value = Math.max(0, Math.min(Math.floor(Number(amount) || 0), config.economy.maxWallet));
    await economyDB.set(`${userId}.wallet`, value);
    await this._updateNetWorth(userId);
  },

  /** Adds to (or subtracts from) the bank, clamped to `[0, bankLimit]`. */
  async addBank(userId: string, amount: number): Promise<number> {
    const delta = Math.floor(Number(amount) || 0);
    await economyDB.ensure(`${userId}`, defaultEconomy(userId));
    const current = Number(await economyDB.get(`${userId}.bank`, 0)) || 0;
    const next = Math.max(0, Math.min(current + delta, config.economy.bankLimit));
    await economyDB.set(`${userId}.bank`, next);
    await this._updateNetWorth(userId);
    return next;
  },

  async setBank(userId: string, amount: number): Promise<void> {
    await economyDB.ensure(`${userId}`, defaultEconomy(userId));
    const value = Math.max(0, Math.min(Math.floor(Number(amount) || 0), config.economy.bankLimit));
    await economyDB.set(`${userId}.bank`, value);
    await this._updateNetWorth(userId);
  },

  async _updateNetWorth(userId: string): Promise<void> {
    const eco = await economyDB.get(`${userId}`) as EconomyData | null;
    if (!eco) return;
    await economyDB.set(`${userId}.netWorth`, eco.wallet + eco.bank);
  },

  async recordTransaction(userId: string, type: string, amount: number, description: string): Promise<void> {
    await economyDB.ensure(`${userId}`, defaultEconomy(userId));
    const tx = { type, amount, description, timestamp: Date.now() };
    const txs = (await economyDB.get(`${userId}.transactions`) ?? []) as typeof tx[];
    txs.unshift(tx);
    if (txs.length > 20) txs.splice(20);
    await economyDB.set(`${userId}.transactions`, txs);
  },

  async incrementStat(userId: string, statKey: string, by = 1): Promise<number> {
    await usersDB.ensure(`${userId}`, defaultUser(userId, 'global'));
    return usersDB.add(`${userId}.stats.${statKey}`, by);
  },

  async grantAchievement(userId: string, achievementId: string): Promise<boolean> {
    await usersDB.ensure(`${userId}`, defaultUser(userId, 'global'));
    const existing = (await usersDB.get(`${userId}.achievements`) ?? []) as string[];
    if (existing.includes(achievementId)) return false;
    existing.push(achievementId);
    await usersDB.set(`${userId}.achievements`, existing);
    const ach = Object.values(config.achievements).find((a) => a.id === achievementId);
    if (ach?.reward) await this.addWallet(userId, ach.reward);
    logger.info(`Achievement unlocked: ${achievementId} → ${userId}`);
    return true;
  },

  async checkAchievements(userId: string): Promise<string[]> {
    const eco  = await this.getEconomy(userId);
    const user = await this.getUser(userId);
    const unlocked: string[] = [];
    const grant = async (id: string) => { if (await this.grantAchievement(userId, id)) unlocked.push(id); };
    if (eco.wallet >= 100_000)              await grant('richie');
    if (user.level >= 10)                   await grant('level_10');
    if (user.level >= 50)                   await grant('level_50');
    if (user.level >= 100)                  await grant('level_100');
    if ((user.prestige ?? 0) >= 1)          await grant('first_prestige');
    if ((user.stats?.gamesWon ?? 0) >= 50)  await grant('gambling_addict');
    if ((user.stats?.socialActions ?? 0) >= 100) await grant('social_butterfly');
    if ((user.stats?.crimeSuccess ?? 0) >= 25)   await grant('crime_lord');
    if (eco.bank >= config.economy.bankLimit)     await grant('bank_full');
    return unlocked;
  },

  async prestige(userId: string): Promise<number | false> {
    const user = await this.getUser(userId);
    if (user.level < config.economy.maxLevel) return false;
    const newPrestige = (user.prestige ?? 0) + 1;
    await usersDB.set(`${userId}.prestige`, newPrestige);
    await usersDB.set(`${userId}.level`, 1);
    await usersDB.set(`${userId}.xp`, 0);
    await this.setWallet(userId, config.economy.startingBalance);
    await this.grantAchievement(userId, 'first_prestige');
    return newPrestige;
  },

  /**
   * Records a social action and bumps the `socialActions` stat.
   *
   * The stat bump is what makes the "Social Butterfly" achievement reachable —
   * nothing incremented `socialActions`, so the check in checkAchievements
   * could never fire.
   */
  async recordSocialAction(userId: string, targetId: string, action: string): Promise<void> {
    await actionsDB.ensure(userId, {});
    const key = `${userId}.${action}`;
    await actionsDB.ensure(key, { count: 0, lastUsed: 0, targets: [] });
    await actionsDB.add(`${key}.count`, 1);
    await actionsDB.set(`${key}.lastUsed`, Date.now());
    const targets = (await actionsDB.get(`${key}.targets`) ?? []) as string[];
    if (!targets.includes(targetId)) {
      targets.unshift(targetId);
      if (targets.length > 5) targets.splice(5);
      await actionsDB.set(`${key}.targets`, targets);
    }
    await this.incrementStat(userId, 'socialActions');
  },

  async getSocialStats(userId: string, action: string): Promise<{ count: number; lastUsed: number; targets: string[] }> {
    return (await actionsDB.get(`${userId}.${action}`)) as { count: number; lastUsed: number; targets: string[] }
      ?? { count: 0, lastUsed: 0, targets: [] };
  },

  async getLeaderboard(type = 'netWorth', limit = 10): Promise<Array<{ userId: string; value: number }>> {
    const rank = (entries: Array<[string, unknown]>, pick: (data: Record<string, unknown>) => unknown) =>
      entries
        .filter(([, data]) => data !== null && typeof data === 'object')
        .map(([id, data]) => ({ userId: id, value: Number(pick(data as Record<string, unknown>)) || 0 }))
        .sort((a, b) => b.value - a.value)
        .slice(0, limit);

    if (type === 'level') {
      return rank(await usersDB.all(), (d) => d.level ?? 1);
    }
    if (type === 'gamesWon') {
      return rank(await usersDB.all(), (d) => (d.stats as Record<string, unknown> | undefined)?.gamesWon ?? 0);
    }
    return rank(await economyDB.all(), (d) => d[type] ?? 0);
  },

  async getLevelLeaderboard(limit = 10): Promise<Array<{ userId: string; level: number; xp: number }>> {
    const entries = await usersDB.all();
    return entries
      .map(([id, data]) => ({ userId: id, level: (data as UserData).level ?? 1, xp: (data as UserData).xp ?? 0 }))
      .sort((a, b) => b.level !== a.level ? b.level - a.level : b.xp - a.xp)
      .slice(0, limit);
  },

  async getRank(userId: string): Promise<number | null> {
    const lb  = await this.getLeaderboard('netWorth', 9999);
    const idx = lb.findIndex((e) => e.userId === userId);
    return idx === -1 ? null : idx + 1;
  },
};

export default UserManager;
