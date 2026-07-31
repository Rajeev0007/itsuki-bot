/**
 * @file PremiumManager.ts
 * @description Premium entitlements for users and guilds.
 *
 * Two independent grants:
 *   - USER premium  → follows the person across every server
 *   - GUILD premium → applies to everyone in that server
 * A member is premium if EITHER applies, which is what makes "boost your
 * server for everyone" and "support the bot personally" both work.
 *
 * Expiry is evaluated on read rather than by a sweeper. A background job that
 * deletes expired grants would silently revoke access if it ran while the bot
 * was mid-restart or the clock was wrong; deriving it from the stored timestamp
 * is always correct and needs no scheduling.
 */

import { getStore } from '../database/Store';
import NoPrefixManager from './NoPrefixManager';
import config from '../config/config';
import logger from '../utils/Logger';

const premiumDB = getStore('premium');

export type PremiumTier = 'none' | 'basic' | 'plus';

export interface PremiumGrant {
  tier: Exclude<PremiumTier, 'none'>;
  /** null = lifetime. */
  expiresAt: number | null;
  grantedBy: string;
  grantedAt: number;
  note?: string;
}

export interface TierPerks {
  label: string;
  /** Multiplier applied to command cooldowns (0.5 = half the wait). */
  cooldownMultiplier: number;
  /** Bypass vote-locked commands. */
  bypassVoteLock: boolean;
  /** Extra daily card rolls. */
  bonusRolls: number;
  /** Multiplier on economy income. */
  earningsMultiplier: number;
  /** Auction listing allowance. */
  maxListings: number;
  /**
   * Run commands without typing the prefix.
   *
   * Materialised into the no-prefix allowlist at grant time rather than read
   * from here on the hot path: NoPrefixManager.has() runs on every message and
   * has to stay synchronous, which an async premium lookup cannot be.
   */
  noPrefix: boolean;
}

export const TIERS: Record<PremiumTier, TierPerks> = {
  none:  { label: 'Free',    cooldownMultiplier: 1,    bypassVoteLock: false, bonusRolls: 0, earningsMultiplier: 1,    maxListings: config.cards.maxListings,     noPrefix: false },
  basic: { label: 'Premium', cooldownMultiplier: 0.5,  bypassVoteLock: true,  bonusRolls: 5, earningsMultiplier: 1.25, maxListings: config.cards.maxListings * 2, noPrefix: true },
  plus:  { label: 'Premium+', cooldownMultiplier: 0.25, bypassVoteLock: true,  bonusRolls: 15, earningsMultiplier: 1.5,  maxListings: config.cards.maxListings * 4, noPrefix: true },
};

/** True when a grant is still valid. */
function isActive(grant: PremiumGrant | null | undefined): boolean {
  if (!grant || typeof grant !== 'object') return false;
  if (!TIERS[grant.tier]) return false;
  return grant.expiresAt === null || Number(grant.expiresAt) > Date.now();
}

const PremiumManager = {
  TIERS,

  async getUserGrant(userId: string): Promise<PremiumGrant | null> {
    const grant = await premiumDB.get(`users.${userId}`) as PremiumGrant | undefined;
    return isActive(grant) ? grant! : null;
  },

  async getGuildGrant(guildId: string): Promise<PremiumGrant | null> {
    const grant = await premiumDB.get(`guilds.${guildId}`) as PremiumGrant | undefined;
    return isActive(grant) ? grant! : null;
  },

  /**
   * Effective tier for a member, taking the HIGHER of their personal grant and
   * their server's. Bot owners are always treated as top tier so they can test
   * premium paths without granting themselves anything.
   */
  async resolveTier(userId: string, guildId?: string | null): Promise<PremiumTier> {
    if (config.owners.includes(userId)) return 'plus';

    const [user, guild] = await Promise.all([
      this.getUserGrant(userId),
      guildId ? this.getGuildGrant(guildId) : Promise.resolve(null),
    ]);

    const rank: PremiumTier[] = ['none', 'basic', 'plus'];
    const best = [user?.tier, guild?.tier]
      .filter((t): t is Exclude<PremiumTier, 'none'> => Boolean(t))
      .sort((a, b) => rank.indexOf(b) - rank.indexOf(a))[0];

    return best ?? 'none';
  },

  async perksFor(userId: string, guildId?: string | null): Promise<TierPerks & { tier: PremiumTier }> {
    const tier = await this.resolveTier(userId, guildId);
    return { ...TIERS[tier], tier };
  },

  async isPremium(userId: string, guildId?: string | null): Promise<boolean> {
    return (await this.resolveTier(userId, guildId)) !== 'none';
  },

  // ── Granting ─────────────────────────────────────────────────────────────

  async grantUser(
    userId: string, tier: Exclude<PremiumTier, 'none'>, days: number | null,
    grantedBy: string, note?: string,
  ): Promise<PremiumGrant> {
    // Stack onto an existing grant rather than truncating it — renewing should
    // extend, not reset.
    const existing = await this.getUserGrant(userId);
    const base = existing?.expiresAt && existing.expiresAt > Date.now() ? existing.expiresAt : Date.now();

    const grant: PremiumGrant = {
      tier,
      expiresAt: days === null ? null : base + days * 86_400_000,
      grantedBy,
      grantedAt: Date.now(),
      note,
    };
    await premiumDB.set(`users.${userId}`, grant);
    logger.info(`[Premium] ${grantedBy} granted ${tier} to user ${userId} (${days === null ? 'lifetime' : `${days}d`})`);
    return grant;
  },

  async grantGuild(
    guildId: string, tier: Exclude<PremiumTier, 'none'>, days: number | null,
    grantedBy: string, note?: string,
  ): Promise<PremiumGrant> {
    const existing = await this.getGuildGrant(guildId);
    const base = existing?.expiresAt && existing.expiresAt > Date.now() ? existing.expiresAt : Date.now();

    const grant: PremiumGrant = {
      tier,
      expiresAt: days === null ? null : base + days * 86_400_000,
      grantedBy,
      grantedAt: Date.now(),
      note,
    };
    await premiumDB.set(`guilds.${guildId}`, grant);
    logger.info(`[Premium] ${grantedBy} granted ${tier} to guild ${guildId}`);
    return grant;
  },

  async revokeUser(userId: string): Promise<boolean> {
    const had = Boolean(await premiumDB.get(`users.${userId}`));
    if (had) await premiumDB.delete(`users.${userId}`);

    // The no-prefix perk is a separate stored grant (see TierPerks.noPrefix),
    // so revoking premium has to clear it as well — otherwise the perk outlives
    // the grant that paid for it. Manually-added entries are left alone: an
    // owner who granted no-prefix by hand did not intend premium to own it.
    const np = NoPrefixManager.entry(userId);
    if (np?.source === 'premium') await NoPrefixManager.remove(userId);

    return had;
  },

  async revokeGuild(guildId: string): Promise<boolean> {
    const had = Boolean(await premiumDB.get(`guilds.${guildId}`));
    if (had) await premiumDB.delete(`guilds.${guildId}`);
    return had;
  },

  /** Active grants, for the owner listing. Expired entries are filtered out. */
  async listActive(): Promise<{ users: Array<[string, PremiumGrant]>; guilds: Array<[string, PremiumGrant]> }> {
    const users = (await premiumDB.get('users') ?? {}) as Record<string, PremiumGrant>;
    const guilds = (await premiumDB.get('guilds') ?? {}) as Record<string, PremiumGrant>;
    return {
      users: Object.entries(users).filter(([, g]) => isActive(g)),
      guilds: Object.entries(guilds).filter(([, g]) => isActive(g)),
    };
  },
};

export default PremiumManager;
