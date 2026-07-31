/**
 * @file WelcomerManager.ts
 * @description Per-guild welcome and goodbye configuration.
 *
 * Both events share one shape and one renderer, so a server can use an embed
 * welcome and a V2 goodbye (or vice versa) without any special handling.
 *
 * Templates are stored, not rendered strings — placeholders are resolved at SEND
 * time so {server.members} reflects the count at the moment someone joined
 * rather than when the message was configured.
 */

import type { Guild, GuildMember, TextChannel } from 'discord.js';
import { getStore } from '../database/Store';
import {
  emptyTemplate, renderTemplate, isRenderable,
  type MessageTemplate, type TemplateStyle,
} from '../services/MessageTemplate';
import logger from '../utils/Logger';

const guildsDB = getStore('guilds');

export type WelcomerEvent = 'welcome' | 'goodbye';

export interface WelcomerConfig {
  enabled: boolean;
  channelId: string | null;
  template: MessageTemplate;
  /** Also DM the member (welcome only — a leaver can't be DMed reliably). */
  dmEnabled: boolean;
  dmTemplate: MessageTemplate | null;
  /** Roles auto-assigned on join (welcome only). */
  autoRoleIds: string[];
  /** Delete the message after N seconds; 0 = keep. */
  deleteAfter: number;
}

/** A ready-to-use default so `/welcomer quick` produces something sensible. */
function defaultTemplate(event: WelcomerEvent, style: TemplateStyle): MessageTemplate {
  const base = emptyTemplate(style);
  if (event === 'welcome') {
    return {
      ...base,
      color: 0x57F287,
      title: 'Welcome to {server}!',
      description: 'Hey {user}, glad you\'re here!\nYou\'re our **{server.ordinal}** member.',
      thumbnail: '{user.avatar}',
      footer: { text: 'Joined {date}', iconUrl: '{server.icon}' },
      timestamp: true,
    };
  }
  return {
    ...base,
    color: 0xED4245,
    title: 'Goodbye',
    description: '**{user.name}** just left {server}.\nWe\'re now at **{server.members}** members.',
    thumbnail: '{user.avatar}',
    timestamp: true,
  };
}

export function defaultConfig(event: WelcomerEvent): WelcomerConfig {
  return {
    enabled: false,
    channelId: null,
    template: defaultTemplate(event, 'embed'),
    dmEnabled: false,
    dmTemplate: null,
    autoRoleIds: [],
    deleteAfter: 0,
  };
}

const WelcomerManager = {
  defaultTemplate,

  async getConfig(guildId: string, event: WelcomerEvent): Promise<WelcomerConfig> {
    const stored = await guildsDB.get(`${guildId}.${event}`) as Partial<WelcomerConfig> | undefined;
    if (!stored || typeof stored !== 'object') return defaultConfig(event);
    const base = defaultConfig(event);
    return {
      ...base,
      ...stored,
      // Merge the template too, so a config saved before a field existed still
      // has every key present.
      template: { ...base.template, ...(stored.template ?? {}) },
      dmTemplate: stored.dmTemplate
        // Seed from the stored style, not a hardcoded one, or reloading a V2 DM
        // template would reset it to embed defaults.
        ? { ...emptyTemplate(stored.dmTemplate.style ?? 'embed'), ...stored.dmTemplate }
        : null,
      autoRoleIds: Array.isArray(stored.autoRoleIds) ? stored.autoRoleIds : [],
    };
  },

  async setConfig(guildId: string, event: WelcomerEvent, patch: Partial<WelcomerConfig>): Promise<WelcomerConfig> {
    const next = { ...(await this.getConfig(guildId, event)), ...patch };
    await guildsDB.set(`${guildId}.${event}`, next);
    return next;
  },

  async setTemplate(guildId: string, event: WelcomerEvent, template: MessageTemplate): Promise<WelcomerConfig> {
    return this.setConfig(guildId, event, { template });
  },

  async setDmTemplate(guildId: string, event: WelcomerEvent, dmTemplate: MessageTemplate): Promise<WelcomerConfig> {
    return this.setConfig(guildId, event, { dmTemplate });
  },

  /** A sensible starting point for a DM welcome. */
  defaultDmTemplate(style: TemplateStyle = 'embed'): MessageTemplate {
    return {
      ...emptyTemplate(style),
      color: 0x5865F2,
      title: 'Welcome to {server}!',
      description: 'Hey {user.name}, thanks for joining **{server}**.\nHave a look around and enjoy your stay!',
      thumbnail: '{server.icon}',
      footer: { text: 'You are member #{server.members}' },
    };
  },

  /**
   * Fires the configured message for a member event.
   *
   * Every step is independently guarded: a missing channel must not stop
   * auto-roles, and a failed auto-role must not stop the message.
   */
  async fire(member: GuildMember, event: WelcomerEvent): Promise<void> {
    const guild = member.guild;
    let config: WelcomerConfig;
    try {
      config = await this.getConfig(guild.id, event);
    } catch (err) {
      logger.debug(`[Welcomer] Could not load ${event} config: ${(err as Error).message}`);
      return;
    }
    if (!config.enabled) return;

    // ── Auto-roles (welcome only) ──────────────────────────────────────────
    if (event === 'welcome' && config.autoRoleIds.length) {
      const me = guild.members.me;
      for (const roleId of config.autoRoleIds.slice(0, 5)) {
        const role = guild.roles.cache.get(roleId);
        // Silently skip roles the bot cannot grant rather than throwing on each.
        if (!role || role.managed) continue;
        if (!me || me.roles.highest.comparePositionTo(role) <= 0) continue;
        await member.roles.add(role, 'Welcomer auto-role').catch(() => null);
      }
    }

    const ctx = { member, user: member.user, guild };

    // ── Channel message ────────────────────────────────────────────────────
    if (config.channelId && isRenderable(config.template)) {
      // Fall back to a fetch: an uncached channel would otherwise make the
      // welcome silently never fire, which is very hard to diagnose.
      let channel = guild.channels.cache.get(config.channelId) as TextChannel | undefined;
      if (!channel) {
        channel = await guild.channels.fetch(config.channelId).catch(() => null) as TextChannel | undefined;
      }
      if (channel?.send) {
        try {
          const payload = renderTemplate(config.template, ctx);
          const sent = await channel.send(payload as never);

          if (config.deleteAfter > 0) {
            const ms = Math.min(config.deleteAfter, 3600) * 1000;
            const timer = setTimeout(() => { void sent.delete().catch(() => null); }, ms);
            // Don't hold the process open for a pending deletion.
            if (typeof timer.unref === 'function') timer.unref();
          }
        } catch (err) {
          logger.warn(`[Welcomer] ${event} send failed in ${guild.id}: ${(err as Error).message}`);
        }
      }
    }

    // ── DM (welcome only) ──────────────────────────────────────────────────
    // A leaving member no longer shares a guild with the bot, so a goodbye DM
    // would always be rejected.
    if (event === 'welcome' && config.dmEnabled && config.dmTemplate && isRenderable(config.dmTemplate)) {
      try {
        await member.user.send(renderTemplate(config.dmTemplate, ctx) as never);
      } catch {
        // Closed DMs are normal and not worth logging loudly.
      }
    }
  },
};

export default WelcomerManager;
