/**
 * @file BackupManager.ts
 * @description Snapshots and restores a guild's structure.
 *
 * ── The problem that defines this module ─────────────────────────────────────
 * Recreated roles and channels get NEW snowflake IDs. Every permission
 * overwrite in the backup references the OLD role IDs, so restoring them
 * verbatim produces a server where no override applies to anything — channels
 * silently end up with wrong (usually wide-open, or completely locked)
 * permissions.
 *
 * Restore therefore builds an old-ID → new-ID map as it creates roles, and
 * translates every overwrite through it. Member overwrites are passed through
 * unchanged, because user IDs are stable across a restore.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Messages are deliberately NOT backed up. They cannot be faithfully restored —
 * only impersonated via webhooks, losing authorship, reactions, threads and
 * edit history — and storing channel history would balloon the JSON store.
 * This backs up STRUCTURE: settings, roles, channels, overwrites, emojis, bans.
 */

import {
  ChannelType, PermissionFlagsBits, OverwriteType,
  type Guild, type CategoryChannel, type GuildBasedChannel, type Role,
} from 'discord.js';
import { getStore } from '../database/Store';
import { addEmoji } from '../services/ExpressionService';
import logger from '../utils/Logger';

const backupsDB = getStore('backups');

/** Backups per guild. Older ones are pruned to keep the store manageable. */
export const MAX_BACKUPS_PER_GUILD = 5;
/** Spacing between create calls — channel/role creation is rate limited. */
const CREATE_DELAY_MS = 900;
const delay = () => new Promise((r) => setTimeout(r, CREATE_DELAY_MS));

export interface BackupOverwrite {
  /** Role or member snowflake as it existed at backup time. */
  id: string;
  type: number;
  allow: string;
  deny: string;
}

export interface BackupRole {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: string;
  position: number;
  /** Managed roles belong to integrations and cannot be recreated. */
  managed: boolean;
  isEveryone: boolean;
}

export interface BackupChannel {
  id: string;
  name: string;
  type: number;
  position: number;
  parentId: string | null;
  topic: string | null;
  nsfw: boolean;
  rateLimitPerUser: number;
  bitrate: number | null;
  userLimit: number | null;
  overwrites: BackupOverwrite[];
}

export interface BackupEmoji { name: string; url: string; animated: boolean }

export interface BackupData {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
  createdBy: string;
  createdAt: number;
  settings: {
    name: string;
    iconUrl: string | null;
    bannerUrl: string | null;
    verificationLevel: number;
    defaultMessageNotifications: number;
    explicitContentFilter: number;
    afkTimeout: number;
    afkChannelName: string | null;
    systemChannelName: string | null;
  };
  roles: BackupRole[];
  channels: BackupChannel[];
  emojis: BackupEmoji[];
  bans: Array<{ userId: string; reason: string | null }>;
}

export interface RestoreOptions {
  settings: boolean;
  roles: boolean;
  channels: boolean;
  emojis: boolean;
  bans: boolean;
  /** 'merge' adds what's missing; 'replace' deletes existing first. */
  mode: 'merge' | 'replace';
}

export interface RestoreReport {
  rolesCreated: number;
  channelsCreated: number;
  emojisCreated: number;
  bansRestored: number;
  deleted: number;
  settingsApplied: boolean;
  warnings: string[];
}

/** Channel types this can recreate. Threads are excluded — they need a parent
 *  message, and forum/media channels need tag configuration we don't capture. */
const RESTORABLE_TYPES = new Set<number>([
  ChannelType.GuildCategory,
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
]);

const BackupManager = {
  MAX_BACKUPS_PER_GUILD,

  // ── Create ───────────────────────────────────────────────────────────────

  async create(guild: Guild, createdBy: string, label?: string): Promise<BackupData> {
    // Fetch so the caches are complete — a partially cached guild produces a
    // backup that silently omits channels or roles.
    await guild.roles.fetch().catch(() => null);
    await guild.channels.fetch().catch(() => null);
    await guild.emojis.fetch().catch(() => null);

    const roles: BackupRole[] = [...guild.roles.cache.values()]
      .sort((a, b) => b.position - a.position)
      .map((role) => ({
        id: role.id,
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: role.permissions.bitfield.toString(),
        position: role.position,
        managed: role.managed,
        isEveryone: role.id === guild.id,
      }));

    const channels: BackupChannel[] = [...guild.channels.cache.values()]
      .filter((c): c is GuildBasedChannel => Boolean(c) && RESTORABLE_TYPES.has(c.type))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((channel) => {
        const c = channel as GuildBasedChannel & {
          topic?: string | null; nsfw?: boolean; rateLimitPerUser?: number;
          bitrate?: number; userLimit?: number;
        };
        return {
          id: channel.id,
          name: channel.name,
          type: channel.type,
          position: channel.position ?? 0,
          parentId: channel.parentId ?? null,
          topic: c.topic ?? null,
          nsfw: Boolean(c.nsfw),
          rateLimitPerUser: Number(c.rateLimitPerUser) || 0,
          bitrate: Number(c.bitrate) || null,
          userLimit: Number.isFinite(c.userLimit) ? Number(c.userLimit) : null,
          overwrites: [...(channel.permissionOverwrites?.cache.values() ?? [])].map((o) => ({
            id: o.id,
            type: Number(o.type),
            allow: o.allow.bitfield.toString(),
            deny: o.deny.bitfield.toString(),
          })),
        };
      });

    const emojis: BackupEmoji[] = [...guild.emojis.cache.values()].map((e) => ({
      name: e.name ?? 'emoji',
      url: e.imageURL({ size: 256 }),
      animated: Boolean(e.animated),
    }));

    // Bans need a permission and can be a large list; failure is non-fatal.
    let bans: BackupData['bans'] = [];
    if (guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      try {
        const fetched = await guild.bans.fetch();
        bans = [...fetched.values()].slice(0, 1000)
          .map((b) => ({ userId: b.user.id, reason: b.reason ?? null }));
      } catch (err) {
        logger.debug(`[Backup] Could not fetch bans: ${(err as Error).message}`);
      }
    }

    const afkChannel = guild.afkChannelId ? guild.channels.cache.get(guild.afkChannelId) : null;
    const systemChannel = guild.systemChannelId ? guild.channels.cache.get(guild.systemChannelId) : null;

    const backup: BackupData = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: (label ?? '').trim().slice(0, 60) || `${guild.name} — ${new Date().toISOString().slice(0, 10)}`,
      guildId: guild.id,
      guildName: guild.name,
      createdBy,
      createdAt: Date.now(),
      settings: {
        name: guild.name,
        iconUrl: guild.iconURL({ size: 512, extension: 'png' }),
        bannerUrl: guild.bannerURL({ size: 512, extension: 'png' }),
        verificationLevel: Number(guild.verificationLevel) || 0,
        defaultMessageNotifications: Number(guild.defaultMessageNotifications) || 0,
        explicitContentFilter: Number(guild.explicitContentFilter) || 0,
        afkTimeout: Number(guild.afkTimeout) || 300,
        // Stored by NAME, since the channel ID won't exist after a restore.
        afkChannelName: afkChannel?.name ?? null,
        systemChannelName: systemChannel?.name ?? null,
      },
      roles, channels, emojis, bans,
    };

    const existing = await this.list(guild.id);
    // Newest first, pruned to the cap.
    const next = [backup, ...existing].slice(0, MAX_BACKUPS_PER_GUILD);
    await backupsDB.set(`${guild.id}`, next);

    logger.info(
      `[Backup] Created ${backup.id} for ${guild.id}: `
      + `${roles.length} roles, ${channels.length} channels, ${emojis.length} emojis, ${bans.length} bans`,
    );
    return backup;
  },

  // ── Storage ──────────────────────────────────────────────────────────────

  async list(guildId: string): Promise<BackupData[]> {
    const stored = await backupsDB.get(`${guildId}`);
    return Array.isArray(stored) ? stored as BackupData[] : [];
  },

  async get(guildId: string, backupId: string): Promise<BackupData | null> {
    const all = await this.list(guildId);
    return all.find((b) => b.id === backupId) ?? null;
  },

  async remove(guildId: string, backupId: string): Promise<boolean> {
    const all = await this.list(guildId);
    const next = all.filter((b) => b.id !== backupId);
    if (next.length === all.length) return false;
    await backupsDB.set(`${guildId}`, next);
    return true;
  },

  /** Stores an externally supplied backup (from /backup import). */
  async adopt(guildId: string, data: BackupData): Promise<BackupData> {
    const adopted: BackupData = {
      ...data,
      // Re-key so an imported file can't collide with an existing backup.
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      guildId,
    };
    const existing = await this.list(guildId);
    await backupsDB.set(`${guildId}`, [adopted, ...existing].slice(0, MAX_BACKUPS_PER_GUILD));
    return adopted;
  },

  /** Validates a parsed JSON object well enough to restore from it. */
  validate(raw: unknown): { ok: boolean; reason?: string; data?: BackupData } {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'That file is not a JSON object.' };
    const d = raw as Partial<BackupData>;
    if (!Array.isArray(d.roles) || !Array.isArray(d.channels)) {
      return { ok: false, reason: 'Missing `roles` or `channels` — that does not look like a backup file.' };
    }
    if (!d.settings || typeof d.settings !== 'object') {
      return { ok: false, reason: 'Missing `settings`.' };
    }
    return {
      ok: true,
      data: {
        ...d,
        emojis: Array.isArray(d.emojis) ? d.emojis : [],
        bans: Array.isArray(d.bans) ? d.bans : [],
      } as BackupData,
    };
  },

  // ── Restore ──────────────────────────────────────────────────────────────

  /**
   * Restores a backup into a guild.
   *
   * Ordering is not incidental:
   *   1. roles first — channel overwrites reference them
   *   2. categories before channels — children need a parent to attach to
   *   3. overwrites translated through the role map as each channel is made
   *   4. positions applied last, since creation order doesn't guarantee them
   */
  async restore(guild: Guild, backup: BackupData, options: RestoreOptions): Promise<RestoreReport> {
    const report: RestoreReport = {
      rolesCreated: 0, channelsCreated: 0, emojisCreated: 0,
      bansRestored: 0, deleted: 0, settingsApplied: false, warnings: [],
    };

    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.Administrator)) {
      report.warnings.push('I do not have Administrator, so some operations may be skipped.');
    }
    const botHighest = me?.roles.highest.position ?? 0;

    // old role id → newly created role
    const roleMap = new Map<string, Role>();
    // @everyone is never recreated; it maps to the live one.
    roleMap.set(backup.roles.find((r) => r.isEveryone)?.id ?? backup.guildId, guild.roles.everyone);

    // ── Destructive phase ──────────────────────────────────────────────────
    if (options.mode === 'replace') {
      if (options.channels) {
        for (const channel of [...guild.channels.cache.values()]) {
          try { await channel.delete('Backup restore (replace mode)'); report.deleted++; }
          catch { /* undeletable — e.g. community rules channel */ }
        }
      }
      if (options.roles) {
        for (const role of [...guild.roles.cache.values()]) {
          // Skip @everyone, integration-managed roles, and anything at or above
          // the bot — Discord refuses those and it isn't an error worth failing on.
          if (role.id === guild.id || role.managed || role.position >= botHighest) continue;
          try { await role.delete('Backup restore (replace mode)'); report.deleted++; }
          catch { /* ignore */ }
        }
      }
    }

    // ── Roles ──────────────────────────────────────────────────────────────
    if (options.roles) {
      // Lowest position first, so each new role stacks above the previous one
      // and the original hierarchy order is preserved.
      const creatable = backup.roles
        .filter((r) => !r.isEveryone && !r.managed)
        .sort((a, b) => a.position - b.position);

      for (const roleData of creatable) {
        try {
          const created = await guild.roles.create({
            name: roleData.name,
            color: roleData.color,
            hoist: roleData.hoist,
            mentionable: roleData.mentionable,
            permissions: BigInt(roleData.permissions),
            reason: `Backup restore ${backup.id}`,
          });
          roleMap.set(roleData.id, created);
          report.rolesCreated++;
        } catch (err) {
          report.warnings.push(`Role \`${roleData.name}\`: ${(err as Error).message}`);
        }
        await delay();
      }

      // @everyone's permissions are restored in place rather than recreated.
      const everyoneData = backup.roles.find((r) => r.isEveryone);
      if (everyoneData) {
        try {
          await guild.roles.everyone.setPermissions(BigInt(everyoneData.permissions), `Backup restore ${backup.id}`);
        } catch (err) {
          report.warnings.push(`@everyone permissions: ${(err as Error).message}`);
        }
      }
    }

    /** Translates stored overwrites onto live role/member IDs. */
    const mapOverwrites = (overwrites: BackupOverwrite[]) => {
      const out: Array<{ id: string; allow: bigint; deny: bigint; type?: number }> = [];
      for (const o of overwrites) {
        if (Number(o.type) === Number(OverwriteType.Member)) {
          // User IDs survive a restore, so member overwrites pass through.
          out.push({ id: o.id, allow: BigInt(o.allow), deny: BigInt(o.deny), type: OverwriteType.Member });
          continue;
        }
        const mapped = roleMap.get(o.id);
        // A role we couldn't recreate (managed, or restore skipped roles) has no
        // target — dropping the overwrite is correct, since applying it to a
        // stale ID would silently do nothing.
        if (!mapped) continue;
        out.push({ id: mapped.id, allow: BigInt(o.allow), deny: BigInt(o.deny), type: OverwriteType.Role });
      }
      return out;
    };

    // ── Channels ───────────────────────────────────────────────────────────
    if (options.channels) {
      // old channel id → new category, for reparenting children.
      const categoryMap = new Map<string, CategoryChannel>();

      const categories = backup.channels
        .filter((c) => c.type === ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position);

      for (const cat of categories) {
        try {
          const created = await guild.channels.create({
            name: cat.name,
            type: ChannelType.GuildCategory,
            permissionOverwrites: mapOverwrites(cat.overwrites) as never,
            reason: `Backup restore ${backup.id}`,
          });
          categoryMap.set(cat.id, created as CategoryChannel);
          report.channelsCreated++;
        } catch (err) {
          report.warnings.push(`Category \`${cat.name}\`: ${(err as Error).message}`);
        }
        await delay();
      }

      const nonCategories = backup.channels
        .filter((c) => c.type !== ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position);

      for (const ch of nonCategories) {
        try {
          const isVoice = ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice;
          const created = await guild.channels.create({
            name: ch.name,
            type: ch.type as never,
            parent: ch.parentId ? categoryMap.get(ch.parentId)?.id : undefined,
            // Only send fields the channel type actually supports; Discord
            // rejects a topic on a voice channel and a bitrate on a text one.
            ...(isVoice
              ? {
                  bitrate: ch.bitrate ? Math.min(ch.bitrate, guild.maximumBitrate) : undefined,
                  userLimit: ch.userLimit ?? undefined,
                }
              : {
                  topic: ch.topic ?? undefined,
                  nsfw: ch.nsfw,
                  rateLimitPerUser: ch.rateLimitPerUser || undefined,
                }),
            permissionOverwrites: mapOverwrites(ch.overwrites) as never,
            reason: `Backup restore ${backup.id}`,
          });
          report.channelsCreated++;

          // Re-point AFK / system channels by name, since their IDs changed.
          if (options.settings && ch.name === backup.settings.afkChannelName && isVoice) {
            await guild.setAFKChannel(created.id).catch(() => null);
          }
          if (options.settings && ch.name === backup.settings.systemChannelName && !isVoice) {
            await guild.setSystemChannel(created.id).catch(() => null);
          }
        } catch (err) {
          report.warnings.push(`Channel \`${ch.name}\`: ${(err as Error).message}`);
        }
        await delay();
      }
    }

    // ── Settings ───────────────────────────────────────────────────────────
    if (options.settings) {
      try {
        await guild.edit({
          name: backup.settings.name,
          verificationLevel: backup.settings.verificationLevel as never,
          defaultMessageNotifications: backup.settings.defaultMessageNotifications as never,
          explicitContentFilter: backup.settings.explicitContentFilter as never,
          afkTimeout: backup.settings.afkTimeout as never,
          reason: `Backup restore ${backup.id}`,
        });
        report.settingsApplied = true;
      } catch (err) {
        report.warnings.push(`Server settings: ${(err as Error).message}`);
      }
      if (backup.settings.iconUrl) {
        await guild.setIcon(backup.settings.iconUrl).catch(() => report.warnings.push('Could not restore the server icon.'));
      }
    }

    // ── Emojis ─────────────────────────────────────────────────────────────
    if (options.emojis && backup.emojis.length) {
      // Reuses the expression service, so slot and size limits are enforced the
      // same way as /steal rather than duplicated here.
      for (const emoji of backup.emojis.slice(0, 50)) {
        const outcome = await addEmoji(guild, emoji.url, emoji.name, `Backup restore ${backup.id}`);
        if (outcome.ok) report.emojisCreated++;
        else if (report.warnings.length < 20) report.warnings.push(`Emoji \`${emoji.name}\`: ${outcome.reason}`);
        await delay();
      }
    }

    // ── Bans ───────────────────────────────────────────────────────────────
    if (options.bans && backup.bans.length) {
      if (!me?.permissions.has(PermissionFlagsBits.BanMembers)) {
        report.warnings.push('Skipped bans — I need the Ban Members permission.');
      } else {
        for (const ban of backup.bans.slice(0, 200)) {
          try {
            await guild.bans.create(ban.userId, { reason: ban.reason ?? `Backup restore ${backup.id}` });
            report.bansRestored++;
          } catch { /* already banned, or unknown user */ }
        }
      }
    }

    logger.info(
      `[Backup] Restored ${backup.id} into ${guild.id}: `
      + `${report.rolesCreated} roles, ${report.channelsCreated} channels, `
      + `${report.emojisCreated} emojis, ${report.bansRestored} bans, ${report.warnings.length} warnings`,
    );
    return report;
  },

  /** Rough time estimate, so the user knows a restore isn't instant. */
  estimateSeconds(backup: BackupData, options: RestoreOptions): number {
    let ops = 0;
    if (options.roles) ops += backup.roles.filter((r) => !r.isEveryone && !r.managed).length;
    if (options.channels) ops += backup.channels.length;
    if (options.emojis) ops += Math.min(backup.emojis.length, 50);
    return Math.ceil((ops * CREATE_DELAY_MS) / 1000);
  },
};

export default BackupManager;
