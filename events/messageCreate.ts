/**
 * @file messageCreate.ts
 * @description Handles incoming messages:
 * - Awards passive XP (fire-and-forget — never blocks command dispatch)
 * - Routes prefix commands to the same execute() functions as slash commands
 * - NoPrefix: users on the premium list can run commands without the prefix
 */

import { type Message, type Client, Collection, MessageFlags } from 'discord.js';
import { Event } from '../structures/Event';
import { Command } from '../structures/Command';
import { MessageCommandAdapter } from '../structures/MessageAdapter';
import UserManager from '../managers/UserManager';
import NoPrefixManager from '../managers/NoPrefixManager';
import BlacklistManager from '../managers/BlacklistManager';
import MaintenanceManager from '../managers/MaintenanceManager';
import cooldowns from '../managers/CooldownManager';
import config from '../config/config';
import logger from '../utils/Logger';
import fmt from '../utils/Formatter';
import * as CB from '../builders/ComponentBuilder';

const IS_V2 = Number((MessageFlags as Record<string, unknown>).IsComponentsV2 ?? 32768);
const V2_FLAGS = IS_V2;

// Per-user XP cooldown (in-memory, 60 s)
const _xpCooldown = new Map<string, number>();
const XP_COOLDOWN_MS = 60_000;

async function replyError(message: Message, title: string, desc: string): Promise<void> {
  try {
    await message.reply({
      ...(CB.errorResponse(title, desc) as object),
      flags: V2_FLAGS,
    } as never);
  } catch {
    await message.reply(`❌ **${title}:** ${desc}`).catch(() => {});
  }
}

export default new Event({
  name: 'messageCreate',

  async execute(message: Message, client: Client & {
    commands?: Collection<string, Command>;
  }) {
    if (message.author.bot) return;
    // NOTE: DMs are deliberately allowed through. This used to return early on
    // `!message.guild`, which blocked every prefix command in DMs regardless of
    // the command's own guildOnly setting. Individual commands are still gated
    // by the `command.guildOnly` guard further down.

    const userId = message.author.id;
    const prefix = config.prefix;

    // Blacklisted users get nothing at all — no XP, no mention reply, no commands.
    if (BlacklistManager.has(userId)) return;

    // ── Passive XP (fire-and-forget — never delays command processing) ───────
    const lastXp = _xpCooldown.get(userId) ?? 0;
    if (Date.now() - lastXp >= XP_COOLDOWN_MS) {
      _xpCooldown.set(userId, Date.now());
      void UserManager.addXp(userId, fmt.randomInt(2, 8))
        .then(({ leveledUp, newLevel }) => {
          if (leveledUp) {
            (message.channel as { send: (m: string) => Promise<unknown> })
              .send(`🎉 ${message.author} leveled up to **Level ${newLevel}**!`)
              .catch(() => {});
          }
        })
        .catch((err: Error) => logger.debug('[messageCreate] XP error:', err.message));
    }

    // ── Mention shortcut ──────────────────────────────────────────────────────
    // Only a message that is *just* a ping of the bot gets the greeting, and it
    // returns immediately afterwards.
    //
    // `message.mentions.has(client.user)` was far too broad: it also matched
    // replies to the bot and @everyone/role mentions that happen to include it.
    // Worse, it didn't return — so ",hug @Bot" sent the greeting AND then ran
    // the command.
    const content = message.content.trim();
    if (new RegExp(`^<@!?${client.user!.id}>$`).test(content)) {
      await message.reply(
        `Hi! Use \`${prefix}help\` or \`/help\` to see all commands.`
      ).catch(() => {});
      return;
    }

    // ── Determine whether this message should be treated as a command ─────────
    const hasPrefix = content.startsWith(prefix);
    const hasNoPrefix = NoPrefixManager.has(userId); // sync O(1) — no await

    if (!hasPrefix && !hasNoPrefix) return;

    // Strip prefix if present; NoPrefix users send raw command names
    const raw = (hasPrefix ? content.slice(prefix.length) : content).trim();
    if (!raw) return;

    const parts = raw.split(/\s+/);
    const commandName = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (!client.commands) return;

    // Look up by primary name first, then by alias
    let command = client.commands.get(commandName);
    if (!command) {
      command = [...client.commands.values()].find(
        (c) => c.aliases.includes(commandName)
      );
    }
    if (!command) return; // Unknown — stay silent

    // ── Guards ────────────────────────────────────────────────────────────────
    if (command.guildOnly && !message.guild)
      return void replyError(
        message,
        'Server Only',
        `\`${prefix}${command.name}\` needs a server — it relies on voice channels, server settings, or other members. Most other commands work here in DMs.`,
      );

    if (command.ownerOnly && !config.owners.includes(userId))
      return void replyError(message, 'Owner Only', 'This command is restricted to bot owners.');

    if (MaintenanceManager.isEnabled() && !config.owners.includes(userId)) {
      return void replyError(
        message,
        'Maintenance Mode',
        MaintenanceManager.reason() ?? 'The bot is currently undergoing maintenance. Please try again later.',
      );
    }

    if (command.maintenance)
      return void replyError(message, 'Maintenance', 'This command is temporarily disabled.');

    // Permission checks only make sense inside a guild — in a DM there is no
    // member and no role permissions, and `message.member` is null, so an
    // unguarded check would report every permission as missing.
    if (command.permissions.length && message.guild) {
      const missing = command.permissions.filter(
        (p) => !message.member?.permissions.has(p as never)
      );
      if (missing.length)
        return void replyError(message, 'Missing Permissions', `You need: ${missing.join(', ')}`);
    }

    // ── Cooldown ──────────────────────────────────────────────────────────────
    const hasCd = command.cooldown
      || ['economy', 'gambling', 'social'].includes(command.category);

    if (hasCd) {
      const duration = command.cooldown
        ?? (config.cooldowns as Record<string, number>)[command.name]
        ?? 3000;

      const { onCooldown, remaining } = cooldowns.check(userId, command.name);
      if (onCooldown) {
        try {
          await message.reply({
            ...(CB.cooldownResponse(command.name, remaining) as object),
            flags: V2_FLAGS,
          } as never);
        } catch {
          await message.reply(
            `⏰ You can use \`${prefix}${command.name}\` again in **${Math.ceil(remaining / 1000)}s**.`
          ).catch(() => {});
        }
        return;
      }
      cooldowns.set(userId, command.name, duration);
    }

    // ── Execute ───────────────────────────────────────────────────────────────
    const adapter = new MessageCommandAdapter(message, command.data, args);

    try {
      logger.command(command.name, message.author.tag, message.guild?.name ?? 'DM');
      await command.execute(adapter as never, client);
      // Same safety net as the slash router: never leave a deferred prefix
      // command sitting on its "Working…" placeholder with no result.
      if (adapter.deferred && !adapter.replied) {
        logger.warn(`[Prefix] ${command.name} deferred but never responded — sending a fallback.`);
        await adapter.sendError(
          CB.errorResponse('Nothing to Show', 'That command finished without a result. Please check your input and try again.'),
        ).catch(() => {});
      }
    } catch (err) {
      logger.error(`[Prefix] ${command.name} threw:`, (err as Error).message);
      logger.debug((err as Error).stack ?? '');

      // The command never completed — release the cooldown it reserved.
      if (hasCd) cooldowns.clear(userId, command.name);

      const errMsg = (err as Error).message?.slice(0, 200) ?? 'Unknown error';
      try {
        await adapter.sendError({
          ...(CB.errorResponse('Unexpected Error', errMsg) as object),
          flags: V2_FLAGS,
        });
      } catch {
        await message.reply(`❌ Something went wrong: ${errMsg}`).catch(() => {});
      }
    }
  },
});
