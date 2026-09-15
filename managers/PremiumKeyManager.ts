/**
 * @file PremiumKeyManager.ts
 * @description Generates and redeems premium keys.
 *
 * ── Keys are stored HASHED ───────────────────────────────────────────────────
 * Only a SHA-256 of the key is persisted, so a leaked `premiumkeys.json` (or a
 * database backup, which `/backup` will happily include) cannot be turned back
 * into working keys. The consequence is that a key is shown exactly once, at
 * generation — there is no way to look it up again, by design.
 *
 * Each key also gets a short public `id`, unrelated to the key itself, so
 * owners can list, inspect and revoke without the plaintext ever being stored
 * or displayed again.
 */

import { randomBytes, createHash } from 'node:crypto';
import { getStore } from '../database/Store';
import PremiumManager, { type PremiumTier } from './PremiumManager';
import NoPrefixManager from './NoPrefixManager';
import logger from '../utils/Logger';

const keysDB = getStore('premiumkeys');

/** Excludes I, L, O, 0 and 1 so keys can be read aloud and retyped. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUPS = 3;
const GROUP_LEN = 5;
const KEY_PREFIX = 'ITSUKI';

export type KeyTier = Exclude<PremiumTier, 'none'>;

export interface PremiumKey {
  /** Public identifier, safe to display. Not derived from the key. */
  id: string;
  /** SHA-256 of the normalised key. The key itself is never stored. */
  hash: string;
  tier: KeyTier;
  /** Days of premium granted on redemption. null = lifetime. */
  days: number | null;
  maxUses: number;
  uses: number;
  redeemedBy: Array<{ userId: string; at: number }>;
  createdBy: string;
  createdAt: number;
  /** The key stops working after this, independent of what it grants. */
  validUntil: number | null;
  note: string | null;
  revoked: boolean;
}

export interface RedeemResult {
  ok: boolean;
  reason?: string;
  tier?: KeyTier;
  days?: number | null;
  expiresAt?: number | null;
  keyId?: string;
}

/**
 * Uniform random characters from ALPHABET.
 *
 * Rejection sampling rather than `byte % length`: 256 is not a multiple of 31,
 * so plain modulo would make the first few letters measurably more likely.
 */
function randomChars(count: number): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < count) {
    for (const byte of randomBytes(count * 2)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === count) break;
    }
  }
  return out;
}

function formatKey(core: string): string {
  const groups: string[] = [];
  for (let i = 0; i < core.length; i += GROUP_LEN) groups.push(core.slice(i, i + GROUP_LEN));
  return `${KEY_PREFIX}-${groups.join('-')}`;
}

/**
 * Reduces user input to the canonical core so formatting never matters.
 *
 * Accepts the key with or without the `ITSUKI-` prefix, any casing, and any
 * mix of spaces or dashes — people paste keys out of chat messages and DMs.
 * The leading-prefix strip is unambiguous because `I` is not in the alphabet,
 * so a core can never itself begin with "ITSUKI".
 */
export function normalizeKey(input: string | null | undefined): string {
  const cleaned = (input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.startsWith(KEY_PREFIX) ? cleaned.slice(KEY_PREFIX.length) : cleaned;
}

function hashKey(core: string): string {
  return createHash('sha256').update(core).digest('hex');
}

/**
 * Redemptions in flight, by key id.
 *
 * The store is async, so two people submitting the same single-use key at the
 * same moment could both read `uses: 0` and both be granted premium. This
 * closes that window within the process.
 */
const inFlight = new Set<string>();

const PremiumKeyManager = {
  KEY_PREFIX,
  normalizeKey,

  /** Creates a key. The plaintext is returned here and never stored. */
  async generate(opts: {
    tier: KeyTier;
    days: number | null;
    maxUses?: number;
    validDays?: number | null;
    createdBy: string;
    note?: string | null;
  }): Promise<{ key: string; record: PremiumKey }> {
    const core = randomChars(GROUPS * GROUP_LEN);
    const hash = hashKey(core);

    // Ids are short for readability, so check for the (very unlikely) clash
    // rather than assuming.
    let id = randomBytes(3).toString('hex');
    while (await keysDB.get(`keys.${id}`)) id = randomBytes(3).toString('hex');

    const record: PremiumKey = {
      id,
      hash,
      tier: opts.tier,
      days: opts.days,
      maxUses: Math.max(1, Math.floor(opts.maxUses ?? 1)),
      uses: 0,
      redeemedBy: [],
      createdBy: opts.createdBy,
      createdAt: Date.now(),
      validUntil: opts.validDays && opts.validDays > 0
        ? Date.now() + opts.validDays * 86_400_000
        : null,
      note: opts.note?.trim() || null,
      revoked: false,
    };

    await keysDB.set(`keys.${id}`, record);
    // Reverse index so redemption is a direct lookup instead of a scan.
    await keysDB.set(`index.${hash}`, id);

    logger.info(`[PremiumKey] ${opts.createdBy} generated key ${id} (${opts.tier}, ${opts.days === null ? 'lifetime' : `${opts.days}d`}, ${record.maxUses} use(s))`);
    return { key: formatKey(core), record };
  },

  async byId(id: string): Promise<PremiumKey | null> {
    const record = await keysDB.get(`keys.${id}`) as PremiumKey | undefined;
    return record && typeof record === 'object' ? record : null;
  },

  /** Redeems a key for a user, granting premium and the no-prefix perk. */
  async redeem(input: string, userId: string, username: string): Promise<RedeemResult> {
    const core = normalizeKey(input);

    if (core.length !== GROUPS * GROUP_LEN) {
      return {
        ok: false,
        reason: `That doesn't look like a key. They look like \`${KEY_PREFIX}-XXXXX-XXXXX-XXXXX\`.`,
      };
    }
    if ([...core].some((c) => !ALPHABET.includes(c))) {
      return {
        ok: false,
        reason: 'That key contains characters we never use. Keys avoid `I`, `L`, `O`, `0` and `1` — check for lookalikes.',
      };
    }

    const id = await keysDB.get(`index.${hashKey(core)}`) as string | undefined;
    if (!id) return { ok: false, reason: 'That key is not valid.' };

    if (inFlight.has(id)) {
      return { ok: false, reason: 'That key is being redeemed right now. Try again in a moment.' };
    }
    inFlight.add(id);
    try {
      const record = await this.byId(id);
      if (!record) return { ok: false, reason: 'That key is not valid.' };
      if (record.revoked) return { ok: false, reason: 'That key has been revoked.' };
      if (record.validUntil !== null && record.validUntil <= Date.now()) {
        return { ok: false, reason: 'That key has expired.' };
      }
      if (record.redeemedBy.some((r) => r.userId === userId)) {
        return { ok: false, reason: 'You have already redeemed that key.' };
      }
      if (record.uses >= record.maxUses) {
        return { ok: false, reason: 'That key has already been fully redeemed.' };
      }

      // Consume the use BEFORE granting. If the grant then fails the user has
      // lost a use, which is recoverable by an owner; the reverse order would
      // let one key be redeemed repeatedly.
      record.uses += 1;
      record.redeemedBy.push({ userId, at: Date.now() });
      await keysDB.set(`keys.${id}`, record);

      const grant = await PremiumManager.grantUser(
        userId, record.tier, record.days, `key:${id}`, record.note ?? 'Redeemed key',
      );

      // No-prefix is materialised into the allowlist rather than derived from
      // premium on the fly, because NoPrefixManager.has() must stay synchronous
      // — it runs on every message. Expiry is kept in step with the grant.
      const np = await NoPrefixManager.add(userId, username, {
        expiresAt: grant.expiresAt,
        source: 'premium',
        grantedBy: `key:${id}`,
      });
      if (!np.ok) {
        // Premium still applies; only the convenience perk failed.
        logger.warn(`[PremiumKey] Granted premium to ${userId} but no-prefix failed: ${np.reason}`);
      }

      logger.info(`[PremiumKey] ${userId} redeemed ${id} (${record.tier}) — ${record.uses}/${record.maxUses} used`);
      return {
        ok: true, tier: record.tier, days: record.days,
        expiresAt: grant.expiresAt, keyId: id,
      };
    } finally {
      inFlight.delete(id);
    }
  },

  async revoke(id: string): Promise<{ ok: boolean; reason?: string }> {
    const record = await this.byId(id);
    if (!record) return { ok: false, reason: 'No key with that id.' };
    if (record.revoked) return { ok: false, reason: 'That key is already revoked.' };
    record.revoked = true;
    await keysDB.set(`keys.${id}`, record);
    logger.info(`[PremiumKey] Key ${id} revoked.`);
    return { ok: true };
  },

  /** Permanently forgets a key, including its hash index. */
  async delete(id: string): Promise<boolean> {
    const record = await this.byId(id);
    if (!record) return false;
    await keysDB.delete(`keys.${id}`);
    await keysDB.delete(`index.${record.hash}`);
    return true;
  },

  async list(): Promise<PremiumKey[]> {
    const all = (await keysDB.get('keys') ?? {}) as Record<string, PremiumKey>;
    return Object.values(all)
      .filter((k) => k && typeof k === 'object')
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  /** Human-readable state for a listing. */
  statusOf(key: PremiumKey): string {
    if (key.revoked) return 'revoked';
    if (key.validUntil !== null && key.validUntil <= Date.now()) return 'expired';
    if (key.uses >= key.maxUses) return 'used up';
    return key.uses > 0 ? 'partly used' : 'unused';
  },
};

export default PremiumKeyManager;
