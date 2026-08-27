/**
 * @file ModerationManager.ts
 * @description Shared logic for the moderation commands: authorisation checks,
 * the warning store, and mod-log dispatch.
 *
 * The `canModerate` check here is the part that actually matters. Getting it
 * wrong is how moderation bots end up letting a member time out an admin, or
 * failing with a raw "Missing Permissions" API error because nobody checked the
 * bot's own role position first. Every command routes through it.
 */

import {
  PermissionFlagsBits, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, MessageFlags,
  type Guild, type GuildMember, type User, type TextBasedChannel,
} from 'discord.js';
import { getStore } from '../database/Store';
import logger from '../utils/Logger';

const guildsDB = getStore('guilds');
const modDB    = getStore('moderation');

export interface WarnEntry {
  id: string;
  userId: string;
  moderatorId: string;
  reason: string;
  timestamp: number;
}

export type ModAction =
  | 'ban' | 'unban' | 'kick' | 'timeout' | 'untimeout'
  | 'warn' | 'clearwarns' | 'purge' | 'slowmode' | 'lock' | 'unlock';

/**
 * Result of an authorisation check: `null` when allowed, otherwise a
 * user-facing reason for the refusal.
 *
 * A `{ ok: boolean; reason: string }` discriminated union would read a little
 * nicer, but this project compiles with `strict: false`, and narrowing a union
 * on a boolean discriminant is unreliable without `strictNullChecks` — the
 * refused branch's `reason` isn't visible to the compiler. A plain nullable
 * string needs no narrowing at all.
 */
export type ModDenial = string | null;

const ModerationManager = {
  /**
   * Decides whether `moderator` may apply `action` to `target`.
   *
   * Checks, in order of how commonly they're missed:
   *  1. self-moderation and moderating the bot
   *  2. the guild owner (nobody can action them)
   *  3. role hierarchy vs the MODERATOR — you cannot action a peer or superior
   *  4. role hierarchy vs the BOT — Discord rejects this at the API level
   *  5. discord.js's own `bannable` / `kickable` / `moderatable` flags, which
   *     fold in the bot's permissions and position
   *
   * The guild owner bypasses (3) because their highest role can sit below a
   * moderator's while they still outrank everyone.
   */
  canModerate(
    moderator: GuildMember,
    target: GuildMember,
    action: 'ban' | 'kick' | 'timeout',
  ): ModDenial {
    if (target.id === moderator.id)          return `You cannot ${action} yourself.`;
    if (target.id === target.client.user.id) return `I cannot ${action} myself.`;
    if (target.id === target.guild.ownerId)  return `You cannot ${action} the server owner.`;

    // The owner outranks everyone regardless of role position.
    const moderatorIsOwner = moderator.id === moderator.guild.ownerId;
    if (!moderatorIsOwner && moderator.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
      return `You cannot ${action} **${target.user.username}** — their highest role is the same as or above yours.`;
    }

    const me = target.guild.members.me;
    if (!me) return 'I could not resolve my own membership in this server.';
    if (me.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
      return `I cannot ${action} **${target.user.username}** — their highest role is the same as or above mine. Move my role higher in Server Settings → Roles.`;
    }

    // discord.js precomputes these from permissions + position.
    if (action === 'ban'     && !target.bannable)    return `I don't have permission to ban **${target.user.username}**.`;
    if (action === 'kick'    && !target.kickable)    return `I don't have permission to kick **${target.user.username}**.`;
    if (action === 'timeout' && !target.moderatable) return `I don't have permission to time out **${target.user.username}**.`;

    return null;
  },

  /**
   * Hierarchy and target checks WITHOUT any bot-capability requirement.
   *
   * For actions that touch no Discord API — recording a warning is just a
   * datastore write — and for lifting a punishment, where the bot's ability to
   * apply one is irrelevant.
   *
   * /warn used to call `canModerate(…, 'timeout')`, which meant a bot lacking
   * Timeout Members could not record a warning at all (reporting the nonsensical
   * "I don't have permission to time out X"), and nobody above the bot's role
   * could be warned even by a moderator who legitimately outranked them.
   */
  canTarget(moderator: GuildMember, target: GuildMember, action: string): ModDenial {
    if (target.id === moderator.id)          return `You cannot ${action} yourself.`;
    if (target.id === target.client.user.id) return `I cannot ${action} myself.`;
    if (target.id === target.guild.ownerId)  return `You cannot ${action} the server owner.`;

    const moderatorIsOwner = moderator.id === moderator.guild.ownerId;
    if (!moderatorIsOwner && moderator.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
      return `You cannot ${action} **${target.user.username}** — their highest role is the same as or above yours.`;
    }
    return null;
  },

  /** Confirms the bot itself holds a permission before attempting an action. */
  botHas(guild: Guild, permission: bigint): boolean {
    return guild.members.me?.permissions.has(permission) ?? false;
  },

  // ── Warnings ─────────────────────────────────────────────────────────────

  async addWarn(guildId: string, userId: string, moderatorId: string, reason: string): Promise<WarnEntry> {
    const entry: WarnEntry = {
      // Short random id is enough to reference a single warning in a command.
      id: Math.random().toString(36).slice(2, 8),
      userId, moderatorId, reason,
      timestamp: Date.now(),
    };
    const key = `${guildId}.${userId}`;
    const existing = (await modDB.get(key) ?? []) as WarnEntry[];
    const list = Array.isArray(existing) ? existing : [];
    list.push(entry);
    await modDB.set(key, list);
    return entry;
  },

  async getWarns(guildId: string, userId: string): Promise<WarnEntry[]> {
    const list = await modDB.get(`${guildId}.${userId}`);
    return Array.isArray(list) ? list as WarnEntry[] : [];
  },

  async clearWarns(guildId: string, userId: string): Promise<number> {
    const list = await this.getWarns(guildId, userId);
    await modDB.set(`${guildId}.${userId}`, []);
    return list.length;
  },

  /** Removes a single warning by id. Returns true when one was removed. */
  async removeWarn(guildId: string, userId: string, warnId: string): Promise<boolean> {
    const list = await this.getWarns(guildId, userId);
    const next = list.filter((w) => w.id !== warnId);
    if (next.length === list.length) return false;
    await modDB.set(`${guildId}.${userId}`, next);
    return true;
  },

  // ── Mod log ──────────────────────────────────────────────────────────────

  async getLogChannelId(guildId: string): Promise<string | null> {
    const id = await guildsDB.get(`${guildId}.moderation.logChannelId`);
    return typeof id === 'string' && id ? id : null;
  },

  async setLogChannelId(guildId: string, channelId: string | null): Promise<void> {
    await guildsDB.set(`${guildId}.moderation.logChannelId`, channelId);
  },

  /**
   * Posts an entry to the configured mod-log channel.
   *
   * Deliberately best-effort: a missing channel or revoked permission must
   * never make the moderation action itself appear to have failed.
   */
  async log(guild: Guild, opts: {
    action: ModAction;
    target?: User | null;
    moderator: User;
    reason?: string | null;
    extra?: string[];
  }): Promise<void> {
    try {
      const channelId = await this.getLogChannelId(guild.id);
      if (!channelId) return;

      const channel = guild.channels.cache.get(channelId)
        ?? await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !('send' in channel)) return;

      const lines = [
        `**Action:** ${opts.action}`,
        opts.target ? `**User:** ${opts.target.tag ?? opts.target.username} (\`${opts.target.id}\`)` : '',
        `**Moderator:** ${opts.moderator.tag ?? opts.moderator.username}`,
        `**Reason:** ${opts.reason?.trim() || 'No reason provided'}`,
        ...(opts.extra ?? []),
        `-# <t:${Math.floor(Date.now() / 1000)}:F>`,
      ].filter(Boolean);

      const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### Moderation — ${opts.action}`))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

      await (channel as TextBasedChannel & { send: (o: unknown) => Promise<unknown> }).send({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (err) {
      logger.debug(`[Moderation] Mod-log write failed: ${(err as Error).message}`);
    }
  },

  /**
   * Notifies a user about an action taken against them.
   *
   * Must be called BEFORE a ban or kick — once the member is gone the bot no
   * longer shares a guild with them and the DM is rejected.
   */
  async notify(user: User, guildName: string, action: string, reason?: string | null, extra?: string): Promise<boolean> {
    try {
      const lines = [
        `You were **${action}** in **${guildName}**.`,
        `**Reason:** ${reason?.trim() || 'No reason provided'}`,
        extra ?? '',
      ].filter(Boolean);
      await user.send({ content: lines.join('\n') });
      return true;
    } catch {
      // Closed DMs are normal and not an error worth surfacing loudly.
      return false;
    }
  },

  PERMS: {
    ban:      PermissionFlagsBits.BanMembers,
    kick:     PermissionFlagsBits.KickMembers,
    timeout:  PermissionFlagsBits.ModerateMembers,
    messages: PermissionFlagsBits.ManageMessages,
    channels: PermissionFlagsBits.ManageChannels,
  },
};

export default ModerationManager;
