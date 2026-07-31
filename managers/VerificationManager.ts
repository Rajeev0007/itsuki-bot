/**
 * @file VerificationManager.ts
 * @description Server verification: per-guild config, challenge issuing and
 * answer checking.
 *
 * SECURITY NOTE — why challenges are held in memory:
 *   Component customIds are fully visible to the client. Putting the expected
 *   captcha/maths answer in a customId (a common shortcut) means anyone can read
 *   it straight out of the payload and bypass verification entirely. Challenges
 *   are therefore stored server-side, keyed by guild+user, with a TTL, and the
 *   customId carries nothing but the guild id.
 *
 * Attempts are rate limited per user so a code can't be brute forced, and the
 * bot's own role position is validated before a method is offered — otherwise
 * verification appears to succeed while the role assignment silently fails.
 */

import { PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import { getStore } from '../database/JsonStore';
import logger from '../utils/Logger';

const guildsDB = getStore('guilds');

export type VerifyMethod = 'button' | 'captcha' | 'math' | 'passphrase' | 'age';

export const METHODS: Array<{ id: VerifyMethod; label: string; description: string }> = [
  { id: 'button',     label: 'One-click button', description: 'Simplest — click to verify' },
  { id: 'captcha',    label: 'Image captcha',    description: 'Read a distorted code and type it' },
  { id: 'math',       label: 'Maths question',   description: 'Solve a simple sum' },
  { id: 'passphrase', label: 'Passphrase',       description: 'Enter a phrase you choose (e.g. from rules)' },
  { id: 'age',        label: 'Account age gate', description: 'Auto-approve accounts older than N days' },
];

export interface VerifyConfig {
  enabled: boolean;
  method: VerifyMethod;
  roleId: string | null;
  channelId: string | null;
  messageId: string | null;
  /** Used by the 'age' method, and as an extra gate on every other method. */
  minAccountAgeDays: number;
  /** Used by the 'passphrase' method. */
  passphrase: string | null;
  logChannelId: string | null;
  /** Remove this role once verified (for "unverified" role setups). */
  removeRoleId: string | null;
}

export function defaultConfig(): VerifyConfig {
  return {
    enabled: false,
    method: 'button',
    roleId: null,
    channelId: null,
    messageId: null,
    minAccountAgeDays: 0,
    passphrase: null,
    logChannelId: null,
    removeRoleId: null,
  };
}

/** Issued challenge, held only in memory. */
interface Challenge {
  answer: string;
  expiresAt: number;
  attempts: number;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
/** Cooldown after exhausting attempts, to stop brute forcing. */
const LOCKOUT_MS = 10 * 60_000;

const challenges = new Map<string, Challenge>();
const lockouts = new Map<string, number>();

function key(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/** Drops expired challenges and lockouts so the maps can't grow unbounded. */
function sweep(): void {
  const now = Date.now();
  for (const [k, c] of challenges) if (c.expiresAt <= now) challenges.delete(k);
  for (const [k, until] of lockouts) if (until <= now) lockouts.delete(k);
}
setInterval(sweep, 60_000).unref?.();

/**
 * Single optional-field shape rather than an `{ ok: true } | { ok: false }`
 * union: this project compiles with `strict: false`, where narrowing on a
 * boolean discriminant doesn't expose the failure branch's fields.
 */
export interface VerifyOutcome {
  ok: boolean;
  reason?: string;
  alreadyVerified?: boolean;
  lockedOut?: boolean;
}

const VerificationManager = {
  METHODS,

  async getConfig(guildId: string): Promise<VerifyConfig> {
    const stored = await guildsDB.get(`${guildId}.verification`) as Partial<VerifyConfig> | undefined;
    return stored && typeof stored === 'object'
      ? { ...defaultConfig(), ...stored }
      : defaultConfig();
  },

  async setConfig(guildId: string, patch: Partial<VerifyConfig>): Promise<VerifyConfig> {
    const next = { ...(await this.getConfig(guildId)), ...patch };
    await guildsDB.set(`${guildId}.verification`, next);
    return next;
  },

  /**
   * Checks the bot can actually grant the configured role.
   *
   * Returns a reason string when it can't. Verifying this at setup time — and
   * again before granting — is what prevents "verified!" messages that didn't
   * assign anything.
   */
  canAssign(guild: Guild, roleId: string): string | null {
    const me = guild.members.me;
    if (!me) return 'I could not resolve my own membership in this server.';
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return 'I need the **Manage Roles** permission.';
    }
    const role = guild.roles.cache.get(roleId);
    if (!role) return 'That role no longer exists.';
    if (role.managed) return 'That role is managed by an integration and cannot be assigned manually.';
    if (role.id === guild.id) return 'The @everyone role cannot be used for verification.';
    // Discord refuses to assign a role at or above the bot's highest.
    if (me.roles.highest.comparePositionTo(role) <= 0) {
      return `My highest role must be **above** ${role.name}. Move it up in Server Settings → Roles.`;
    }
    return null;
  },

  // ── Challenges ───────────────────────────────────────────────────────────

  /** Random captcha text. Avoids characters that are easy to confuse. */
  generateCaptchaText(length = 6): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < length; i++) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
  },

  /** Simple arithmetic that stays unambiguous (no division, no negatives). */
  generateMathChallenge(): { question: string; answer: string } {
    const ops = ['+', '-', '×'] as const;
    const op = ops[Math.floor(Math.random() * ops.length)];
    let a = Math.floor(Math.random() * 20) + 1;
    let b = Math.floor(Math.random() * 20) + 1;

    if (op === '-' && b > a) [a, b] = [b, a]; // keep the result positive
    if (op === '×') { a = Math.floor(Math.random() * 9) + 2; b = Math.floor(Math.random() * 9) + 2; }

    const answer = op === '+' ? a + b : op === '-' ? a - b : a * b;
    return { question: `${a} ${op} ${b}`, answer: String(answer) };
  },

  /** Stores a challenge answer for a user. */
  issueChallenge(guildId: string, userId: string, answer: string): void {
    challenges.set(key(guildId, userId), {
      answer: answer.trim().toUpperCase(),
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
      attempts: 0,
    });
  },

  isLockedOut(guildId: string, userId: string): number {
    const until = lockouts.get(key(guildId, userId));
    if (!until) return 0;
    const remaining = until - Date.now();
    if (remaining <= 0) { lockouts.delete(key(guildId, userId)); return 0; }
    return remaining;
  },

  /**
   * Validates a submitted answer.
   *
   * Comparison is case-insensitive and whitespace-trimmed, because a captcha
   * that rejects lowercase input is just a worse captcha.
   */
  checkChallenge(guildId: string, userId: string, submitted: string): VerifyOutcome {
    const k = key(guildId, userId);
    const challenge = challenges.get(k);

    if (!challenge || challenge.expiresAt <= Date.now()) {
      challenges.delete(k);
      return { ok: false, reason: 'That challenge expired. Press the verify button again for a new one.' };
    }

    const given = String(submitted ?? '').trim().toUpperCase().replace(/\s+/g, '');
    if (given === challenge.answer.replace(/\s+/g, '')) {
      challenges.delete(k);
      return { ok: true };
    }

    challenge.attempts++;
    const left = MAX_ATTEMPTS - challenge.attempts;
    if (left <= 0) {
      challenges.delete(k);
      lockouts.set(k, Date.now() + LOCKOUT_MS);
      return {
        ok: false,
        lockedOut: true,
        reason: `Too many incorrect attempts. Try again in ${Math.round(LOCKOUT_MS / 60_000)} minutes.`,
      };
    }
    return { ok: false, reason: `That's not right. **${left}** attempt${left !== 1 ? 's' : ''} remaining.` };
  },

  // ── Granting ─────────────────────────────────────────────────────────────

  /** Account age in whole days. */
  accountAgeDays(member: GuildMember): number {
    return Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000);
  },

  /**
   * Applies verification to a member: grants the verified role and removes the
   * unverified one if configured.
   */
  async grant(member: GuildMember, config: VerifyConfig): Promise<VerifyOutcome> {
    if (!config.roleId) return { ok: false, reason: 'No verification role is configured.' };

    const denial = this.canAssign(member.guild, config.roleId);
    if (denial) return { ok: false, reason: denial };

    // Idempotent: re-clicking must not error or re-log.
    if (member.roles.cache.has(config.roleId)) {
      return { ok: true, alreadyVerified: true };
    }

    try {
      await member.roles.add(config.roleId, 'Verification passed');
    } catch (err) {
      logger.warn(`[Verify] Failed to add role in ${member.guild.id}: ${(err as Error).message}`);
      return { ok: false, reason: `Could not assign the role: ${(err as Error).message}` };
    }

    // Removing the gate role is secondary — never fail a successful
    // verification because this part didn't work.
    if (config.removeRoleId && member.roles.cache.has(config.removeRoleId)) {
      try {
        await member.roles.remove(config.removeRoleId, 'Verification passed');
      } catch (err) {
        logger.debug(`[Verify] Could not remove gate role: ${(err as Error).message}`);
      }
    }

    return { ok: true };
  },

  /** Writes a verification event to the configured log channel, best-effort. */
  async log(guild: Guild, config: VerifyConfig, content: string): Promise<void> {
    if (!config.logChannelId) return;
    try {
      const channel = guild.channels.cache.get(config.logChannelId)
        ?? await guild.channels.fetch(config.logChannelId).catch(() => null);
      if (channel && 'send' in channel) {
        await (channel as { send: (o: unknown) => Promise<unknown> }).send({ content });
      }
    } catch (err) {
      logger.debug(`[Verify] Log write failed: ${(err as Error).message}`);
    }
  },
};

export default VerificationManager;
