/**
 * @file BadgeManager.ts
 * @description Awards, revokes and resolves profile badges.
 *
 * Manually-granted badge ids live on the existing `users.<id>.badges` array —
 * the field was already in UserData but nothing ever wrote to or read from it.
 *
 * Writes use the store's atomic set operations rather than read-modify-write:
 * `addToSet` reports whether the badge was actually new (so a double grant is
 * reported honestly instead of silently succeeding), and `pull` removes without
 * rewriting the whole array, which would drop a concurrent grant.
 */

import { getStore } from '../database/Store';
import {
  BADGES, getBadge, manualBadges,
  type BadgeContext, type BadgeDef,
} from '../config/badges';
import UserManager from './UserManager';
import logger from '../utils/Logger';

const usersDB = getStore('users');

export type GrantResult =
  | { ok: true; badge: BadgeDef }
  | { ok: false; reason: string };

const BadgeManager = {
  /** The whole catalogue. */
  all(): BadgeDef[] {
    return [...BADGES].sort((a, b) => a.order - b.order);
  },

  grantable(): BadgeDef[] {
    return manualBadges();
  },

  /**
   * Ids stored on the user, filtered to badges that still exist and are still
   * manual.
   *
   * Filtering matters on both counts: a badge removed from the catalogue would
   * otherwise render as an unnamed tile, and one converted from manual to
   * automatic would be counted twice.
   */
  async storedIds(userId: string): Promise<string[]> {
    const raw = (await usersDB.get(`${userId}.badges`)) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((id): id is string => typeof id === 'string')
      .filter((id) => getBadge(id)?.source === 'manual');
  },

  /** Grants a manual badge. Returns ok:false when it was already held. */
  async grant(userId: string, badgeId: string): Promise<GrantResult> {
    const badge = getBadge(badgeId);
    if (!badge) {
      return { ok: false, reason: `There is no badge with the id \`${badgeId}\`.` };
    }
    if (badge.source !== 'manual') {
      // Writing the id would achieve nothing: resolve() derives automatic badges
      // from account state and ignores whatever is stored.
      return {
        ok: false,
        reason: `**${badge.name}** is earned automatically (${badge.description}) and cannot be granted by hand.`,
      };
    }

    await usersDB.ensure(`${userId}.badges`, []);
    const added = await usersDB.addToSet(`${userId}.badges`, badge.id);
    if (!added) return { ok: false, reason: `That user already has **${badge.name}**.` };

    logger.info(`[Badges] Granted "${badge.id}" to ${userId}`);
    return { ok: true, badge };
  },

  /** Removes a manual badge. Returns ok:false when the user did not have it. */
  async revoke(userId: string, badgeId: string): Promise<GrantResult> {
    const badge = getBadge(badgeId);
    if (!badge) {
      return { ok: false, reason: `There is no badge with the id \`${badgeId}\`.` };
    }
    if (badge.source !== 'manual') {
      return {
        ok: false,
        reason: `**${badge.name}** is earned automatically and cannot be revoked. `
          + 'It disappears on its own if the account no longer qualifies.',
      };
    }

    // The removal itself reports whether the badge was there, so there is no
    // check-then-act window between "do they have it?" and taking it away.
    const removed = await usersDB.removeFromSet(`${userId}.badges`, badge.id);
    if (!removed) {
      return { ok: false, reason: `That user does not have **${badge.name}**.` };
    }

    logger.info(`[Badges] Revoked "${badge.id}" from ${userId}`);
    return { ok: true, badge };
  },

  /** Removes every manual badge from a user. Returns how many were cleared. */
  async clear(userId: string): Promise<number> {
    const held = await this.storedIds(userId);
    if (!held.length) return 0;
    await usersDB.set(`${userId}.badges`, []);
    logger.info(`[Badges] Cleared ${held.length} badge(s) from ${userId}`);
    return held.length;
  },

  /**
   * Every badge a user currently displays: manual grants plus whatever the
   * account state qualifies for, in catalogue order.
   *
   * `ctx` can be supplied by a caller that has already loaded the user and
   * economy records (the profile command has), avoiding a second round trip.
   */
  async resolve(userId: string, ctx?: Partial<BadgeContext>): Promise<BadgeDef[]> {
    const stored = await this.storedIds(userId);

    let context: BadgeContext;
    if (ctx && ctx.achievements && ctx.level !== undefined) {
      context = {
        level: ctx.level ?? 1,
        prestige: ctx.prestige ?? 0,
        netWorth: ctx.netWorth ?? 0,
        gamesWon: ctx.gamesWon ?? 0,
        achievements: ctx.achievements,
      };
    } else {
      const [user, eco] = await Promise.all([
        UserManager.getUser(userId),
        UserManager.getEconomy(userId),
      ]);
      context = {
        level: user.level,
        prestige: user.prestige ?? 0,
        netWorth: eco.wallet + eco.bank,
        gamesWon: user.stats?.gamesWon ?? 0,
        achievements: user.achievements ?? [],
      };
    }

    const earned = BADGES.filter((b) => b.source === 'automatic' && b.qualifies?.(context));
    const manual = stored.map((id) => getBadge(id)).filter((b): b is BadgeDef => b !== null);

    return [...manual, ...earned].sort((a, b) => a.order - b.order);
  },
};

export default BadgeManager;
