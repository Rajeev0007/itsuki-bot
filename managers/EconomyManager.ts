/**
 * @file EconomyManager.ts
 * @description High-level economy operations: income, banking, transfers.
 */

import UserManager  from './UserManager';
import config       from '../config/config';
import fmt          from '../utils/Formatter';
import { getStore } from '../database/Store';

const economyDB = getStore('economy');

/**
 * A daily streak survives a grace period of one extra day. Claim within
 * 48 h of the last claim and the streak continues; miss that window and it
 * restarts at 1. Previously the streak only ever went up, so every long-term
 * user sat permanently at the +50% cap.
 */
const STREAK_GRACE_MS = config.cooldowns.daily * 2;

const EconomyManager = {
  async daily(userId: string) {
    const eco       = await UserManager.getEconomy(userId);
    const now       = Date.now();
    const remaining = config.cooldowns.daily - (now - eco.lastDaily);
    if (remaining > 0) return { success: false as const, remaining };

    const previous = Math.max(0, Number(eco.dailyStreak) || 0);
    const missed   = eco.lastDaily > 0 && (now - eco.lastDaily) > STREAK_GRACE_MS;
    const streak   = missed ? 1 : previous + 1;

    const bonus  = Math.min(streak * 0.05, 0.5);
    const base   = fmt.randomInt(config.economy.daily.min, config.economy.daily.max);
    // addEarnings layers the prestige bonus on top of the streak bonus.
    const amount = await UserManager.addEarnings(userId, Math.floor(base * (1 + bonus)));

    await economyDB.set(`${userId}.lastDaily`, now);
    await economyDB.set(`${userId}.dailyStreak`, streak);
    await UserManager.recordTransaction(userId, 'daily', amount, 'Daily reward');
    await UserManager.grantAchievement(userId, 'first_daily');
    await UserManager.checkAchievements(userId);
    return { success: true as const, amount, streak, streakReset: missed && previous > 0 };
  },

  async weekly(userId: string) {
    const eco       = await UserManager.getEconomy(userId);
    const now       = Date.now();
    const remaining = config.cooldowns.weekly - (now - eco.lastWeekly);
    if (remaining > 0) return { success: false as const, remaining };

    const amount = await UserManager.addEarnings(
      userId, fmt.randomInt(config.economy.weekly.min, config.economy.weekly.max),
    );
    await economyDB.set(`${userId}.lastWeekly`, now);
    await UserManager.recordTransaction(userId, 'weekly', amount, 'Weekly reward');
    await UserManager.checkAchievements(userId);
    return { success: true as const, amount };
  },

  async monthly(userId: string) {
    const eco       = await UserManager.getEconomy(userId);
    const now       = Date.now();
    const remaining = config.cooldowns.monthly - (now - eco.lastMonthly);
    if (remaining > 0) return { success: false as const, remaining };

    const amount = await UserManager.addEarnings(
      userId, fmt.randomInt(config.economy.monthly.min, config.economy.monthly.max),
    );
    await economyDB.set(`${userId}.lastMonthly`, now);
    await UserManager.recordTransaction(userId, 'monthly', amount, 'Monthly reward');
    await UserManager.checkAchievements(userId);
    return { success: true as const, amount };
  },

  async work(userId: string) {
    const eco       = await UserManager.getEconomy(userId);
    const now       = Date.now();
    const remaining = config.cooldowns.work - (now - eco.lastWork);
    if (remaining > 0) return { success: false as const, remaining };

    const job    = fmt.randomItem(config.economy.workJobs);
    const amount = await UserManager.addEarnings(userId, fmt.randomInt(job.min, job.max));
    await economyDB.set(`${userId}.lastWork`, now);
    await UserManager.recordTransaction(userId, 'work', amount, `Worked as ${job.name}`);
    await UserManager.checkAchievements(userId);
    return { success: true as const, amount, job: job.name };
  },

  async crime(userId: string) {
    const eco       = await UserManager.getEconomy(userId);
    const now       = Date.now();
    const remaining = config.cooldowns.crime - (now - eco.lastCrime);
    if (remaining > 0) return { success: false as const, remaining };

    await economyDB.set(`${userId}.lastCrime`, now);
    await UserManager.incrementStat(userId, 'crimeCount');

    if (Math.random() < config.economy.crimeSuccessRate) {
      const amount = await UserManager.addEarnings(
        userId, fmt.randomInt(config.economy.crimeRewards.min, config.economy.crimeRewards.max),
      );
      await UserManager.recordTransaction(userId, 'crime', amount, 'Successful crime');
      await UserManager.incrementStat(userId, 'crimeSuccess');
      await UserManager.checkAchievements(userId);
      return { success: true as const, amount };
    } else {
      const fine       = fmt.randomInt(config.economy.crimeFines.min, config.economy.crimeFines.max);
      const current    = (await UserManager.getBalance(userId)).wallet;
      const actualFine = Math.min(fine, current);
      await UserManager.addWallet(userId, -actualFine);
      await UserManager.recordTransaction(userId, 'fine', -actualFine, 'Crime fine');
      return { success: false as const, fine: actualFine };
    }
  },

  async beg(userId: string) {
    const eco       = await UserManager.getEconomy(userId);
    const now       = Date.now();
    const remaining = config.cooldowns.beg - (now - eco.lastBeg);
    if (remaining > 0) return { success: false as const, remaining };

    await economyDB.set(`${userId}.lastBeg`, now);

    if (Math.random() < config.economy.begChance) {
      const amount = await UserManager.addEarnings(
        userId, fmt.randomInt(config.economy.begRewards.min, config.economy.begRewards.max),
      );
      await UserManager.recordTransaction(userId, 'beg', amount, 'Begged for coins');
      return { success: true as const, amount };
    }
    return { success: false as const };
  },

  async search(userId: string) {
    const eco       = await UserManager.getEconomy(userId);
    const now       = Date.now();
    const remaining = config.cooldowns.search - (now - eco.lastSearch);
    if (remaining > 0) return { success: false as const, remaining };

    const location  = fmt.randomItem(config.economy.searchLocations);
    const found     = Math.random() > config.economy.searchFailChance;
    await economyDB.set(`${userId}.lastSearch`, now);

    if (found) {
      const amount = await UserManager.addEarnings(
        userId, fmt.randomInt(config.economy.searchRewards.min, config.economy.searchRewards.max),
      );
      await UserManager.recordTransaction(userId, 'search', amount, `Found coins in ${location}`);
      return { success: true as const, amount, location };
    }
    return { success: false as const, location };
  },

  async rob(attackerId: string, targetId: string) {
    if (attackerId === targetId) return { success: false as const, reason: 'self' as const };

    const attackerEco = await UserManager.getEconomy(attackerId);
    const targetEco   = await UserManager.getEconomy(targetId);
    const now         = Date.now();
    const remaining   = config.cooldowns.rob - (now - attackerEco.lastRob);
    if (remaining > 0) return { success: false as const, remaining, reason: 'cooldown' as const };
    if (targetEco.wallet < config.economy.robMinWallet)
      return { success: false as const, reason: 'too_poor' as const };

    // The attacker has to be able to cover the fine they risk. Without this a
    // broke user could spam robs for a completely free roll, because the fine
    // was clamped down to whatever they had — i.e. zero.
    if (attackerEco.wallet < config.economy.robFine.min)
      return {
        success: false as const,
        reason: 'no_collateral' as const,
        needed: config.economy.robFine.min,
      };

    await UserManager.incrementStat(attackerId, 'robCount');
    await economyDB.set(`${attackerId}.lastRob`, now);

    if (Math.random() < config.economy.robChance) {
      const pct = fmt.randomInt(Math.floor(config.economy.robPercent.min * 100), Math.floor(config.economy.robPercent.max * 100)) / 100;
      // Re-read the victim's wallet immediately before taking from it. The
      // percentage used to be applied to the snapshot taken at the top of this
      // function, so if the victim banked their coins (or another attacker got
      // there first) the debit clamped to what was left while the attacker was
      // still credited the full stale figure — minting the difference.
      const victimWallet = (await UserManager.getBalance(targetId)).wallet;
      const stolen = Math.floor(victimWallet * pct);
      if (stolen <= 0) return { success: false as const, reason: 'too_poor' as const };

      // Only pay out what was actually taken.
      if (!await UserManager.debitWallet(targetId, stolen)) {
        return { success: false as const, reason: 'too_poor' as const };
      }
      const gained = await UserManager.creditWallet(attackerId, stolen);
      await UserManager.recordTransaction(attackerId, 'rob',   gained,  `Robbed <@${targetId}>`);
      await UserManager.recordTransaction(targetId,   'robbed', -stolen, `Robbed by <@${attackerId}>`);
      await UserManager.incrementStat(attackerId, 'robSuccess');
      return { success: true as const, stolen: gained };
    } else {
      const fine = fmt.randomInt(config.economy.robFine.min, config.economy.robFine.max);
      // Take as much of the fine as the attacker can actually cover, decided by
      // the wallet at THIS moment rather than the earlier snapshot.
      const wallet     = (await UserManager.getBalance(attackerId)).wallet;
      const actualFine = Math.min(fine, wallet);
      if (actualFine > 0) await UserManager.debitWallet(attackerId, actualFine);
      await UserManager.recordTransaction(attackerId, 'fine', -actualFine, 'Failed rob attempt');
      return { success: false as const, reason: 'caught' as const, fine: actualFine };
    }
  },

  /**
   * Moves coins wallet → bank.
   *
   * The balance read below is only for the friendly error messages and the
   * bank-capacity check; the MOVE itself is guarded by the atomic debit. That
   * ordering matters: with the old check-then-act, running /deposit all
   * concurrently with /transfer all made both pass validation on the same
   * starting wallet, and the clamped second debit created coins out of nothing.
   */
  async deposit(userId: string, amount: number) {
    const { wallet, bank } = await UserManager.getBalance(userId);
    if (amount <= 0)             return { success: false as const, reason: 'invalid_amount' as const };
    if (amount > wallet)         return { success: false as const, reason: 'insufficient_funds' as const };
    if (bank + amount > config.economy.bankLimit)
      return { success: false as const, reason: 'bank_full' as const, maxDeposit: config.economy.bankLimit - bank };

    // Take first, and only credit what was genuinely taken.
    if (!await UserManager.debitWallet(userId, amount)) {
      return { success: false as const, reason: 'insufficient_funds' as const };
    }
    const landed = await UserManager.creditBank(userId, amount);
    if (landed < amount) {
      // The bank filled up in the meantime. Give back the remainder rather than
      // burning it.
      await UserManager.creditWallet(userId, amount - landed);
      if (landed === 0) {
        return { success: false as const, reason: 'bank_full' as const, maxDeposit: 0 };
      }
    }
    await UserManager.recordTransaction(userId, 'deposit', landed, 'Deposited to bank');
    return { success: true as const, amount: landed };
  },

  async withdraw(userId: string, amount: number) {
    const { wallet, bank } = await UserManager.getBalance(userId);
    if (amount <= 0)                             return { success: false as const, reason: 'invalid_amount' as const };
    if (amount > bank)                           return { success: false as const, reason: 'insufficient_bank' as const };
    if (wallet + amount > config.economy.maxWallet) return { success: false as const, reason: 'wallet_full' as const };

    if (!await UserManager.debitBank(userId, amount)) {
      return { success: false as const, reason: 'insufficient_bank' as const };
    }
    const landed = await UserManager.creditWallet(userId, amount);
    if (landed < amount) {
      // Wallet cap reached mid-flight — return the overflow to the bank.
      await UserManager.creditBank(userId, amount - landed);
      if (landed === 0) return { success: false as const, reason: 'wallet_full' as const };
    }
    await UserManager.recordTransaction(userId, 'withdraw', landed, 'Withdrew from bank');
    return { success: true as const, amount: landed };
  },

  async transfer(senderId: string, receiverId: string, amount: number) {
    if (senderId === receiverId) return { success: false as const, reason: 'self_transfer' as const };
    if (!Number.isFinite(amount) || amount <= 0)
      return { success: false as const, reason: 'invalid_amount' as const };

    const sendAmount = Math.floor(amount);
    const senderBal  = (await UserManager.getBalance(senderId)).wallet;
    if (sendAmount > senderBal) return { success: false as const, reason: 'insufficient_funds' as const };

    // Wallets are clamped to maxWallet, so transferring into a nearly-full
    // wallet would silently destroy the overflow. Reject instead of burning it.
    const receiverBal = (await UserManager.getBalance(receiverId)).wallet;
    const capacity    = config.economy.maxWallet - receiverBal;
    if (sendAmount > capacity) {
      return { success: false as const, reason: 'receiver_wallet_full' as const, capacity: Math.max(0, capacity) };
    }

    // Debit the sender FIRST and abort if it fails. Previously the receiver was
    // credited unconditionally, so a sender whose wallet had been drained since
    // the read above paid nothing while the receiver still got the full amount —
    // a two-client money printer.
    if (!await UserManager.debitWallet(senderId, sendAmount)) {
      return { success: false as const, reason: 'insufficient_funds' as const };
    }
    const landed = await UserManager.creditWallet(receiverId, sendAmount);
    if (landed < sendAmount) {
      // Refund whatever would not fit instead of destroying it.
      await UserManager.creditWallet(senderId, sendAmount - landed);
      if (landed === 0) {
        return { success: false as const, reason: 'receiver_wallet_full' as const, capacity: 0 };
      }
    }
    await UserManager.recordTransaction(senderId,   'transfer_out', -landed, `Sent to <@${receiverId}>`);
    await UserManager.recordTransaction(receiverId, 'transfer_in',  landed,  `Received from <@${senderId}>`);
    return { success: true as const, amount: landed };
  },
};

export default EconomyManager;
