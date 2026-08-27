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
import PremiumManager from '../managers/PremiumManager';
import VoteManager from '../managers/VoteManager';
import StatsManager from '../managers/StatsManager';
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

/**
 * Whether a command declares any options or subcommands, i.e. whether trailing
 * words could plausibly be arguments.
 *
 * Memoised by command name because this is on the per-message path and
 * `toJSON()` rebuilds the whole payload each call.
 */
const _acceptsInput = new Map<string, boolean>();

export function commandAcceptsInput(command: Command): boolean {
  const cached = _acceptsInput.get(command.name);
  if (cached !== undefined) return cached;

  let accepts: boolean;
  try {
    const data = command.data as {
      options?: unknown[];
      toJSON?: () => { options?: unknown[] };
    };
    // `.options` is read first because builders expose it directly and, unlike
    // toJSON(), reading it cannot throw — toJSON() validates the whole builder.
    const options = Array.isArray(data.options) ? data.options : data.toJSON?.().options;

    // "No options" is only meaningful when the option list was actually
    // readable. If neither form is available we genuinely cannot tell, and
    // refusing to run a command the user deliberately typed is worse than an
    // occasional false trigger — so assume it takes input.
    accepts = Array.isArray(options) ? options.length > 0 : true;
  } catch {
    accepts = true;
  }
  _acceptsInput.set(command.name, accepts);
  return accepts;
}

/**
 * Intent checks that apply ONLY to the no-prefix path.
 *
 * A prefix is an unambiguous "this is a command" signal. Without one, any
 * sentence whose first word happened to match a command name ran that command:
 * "stop it" stopped the music for the whole server, "help me with this" opened
 * the help menu, and "work is hard" burned the work cooldown. Two rules remove
 * the damaging cases while leaving real usage untouched:
 */
export function noPrefixLooksIntentional(command: Command, token: string, args: string[]): boolean {
  // 1. One- and two-letter aliases (h, v, w, np, lb, c4, ah, mc, us) collide
  //    with ordinary words and typos far too readily to fire silently. They
  //    still work when the prefix is typed.
  if (token.length < 3) return false;

  // 2. A command that takes no input at all should BE the entire message.
  //    "daily" runs; "daily routine sucks" is conversation. This is what
  //    protects the costly and disruptive ones — work, beg, crime, search,
  //    roll, balance, stop, skip, pause, resume, leave, shuffle — none of
  //    which declare options.
  if (args.length > 0 && !commandAcceptsInput(command)) return false;

  return true;
}

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
      // Buffered in memory and flushed periodically — see StatsManager.
      if (message.guild) StatsManager.recordMessage(message.guild.id, userId);

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
    // Trailing punctuation is stripped so "work?" and "balance!" behave like
    // "work" and "balance". Without this the feature felt intermittent to
    // no-prefix users for no discoverable reason.
    const commandName = parts[0].toLowerCase().replace(/[^\p{L}\p{N}]+$/u, '');
    const args = parts.slice(1);
    if (!commandName) return;

    if (!client.commands) return;

    // A single lookup is correct AND sufficient: CommandHandler already
    // registers every alias as its own key, and it deliberately SKIPS aliases
    // that collide with a real command name. The old fallback re-scanned
    // `c.aliases` and so resurrected exactly those skipped aliases,
    // reintroducing the collision the loader had avoided — with first match in
    // insertion order silently winning.
    const command = client.commands.get(commandName);
    if (!command) return; // Unknown — stay silent

    // Without a prefix there is no explicit signal of intent, so ordinary
    // conversation was running commands. See noPrefixLooksIntentional.
    if (!hasPrefix && !noPrefixLooksIntentional(command, commandName, args)) return;

    // ── Guards ────────────────────────────────────────────────────────────────
    // ── Premium / vote gating (mirrors the slash router) ────────────────────
    if (command.premiumOnly && !(await PremiumManager.isPremium(userId, message.guild?.id ?? null))) {
      return void replyError(
        message, 'Premium Only',
        `\`${prefix}${command.name}\` is a premium command. Run \`${prefix}premium\` to see what's included.`,
      );
    }
    if (command.voteLocked) {
      const perks = await PremiumManager.perksFor(userId, message.guild?.id ?? null);
      if (!perks.bypassVoteLock && !(await VoteManager.hasVotedRecently(userId))) {
        const botId = client.user?.id ?? config.clientId;
        return void replyError(
          message, 'Vote to Unlock',
          [
            `\`${prefix}${command.name}\` needs a vote — votes reset every 12 hours.`,
            `Top.gg: ${VoteManager.PROVIDERS.topgg.url(botId)}`,
            `Discord Bot List: ${VoteManager.PROVIDERS.dbl.url(botId)}`,
            'Voting on either site unlocks it. Premium members skip this.',
          ].join('\n'),
        );
      }
    }

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
      // Channel-aware, matching what Discord itself enforces for slash commands.
      // member.permissions is role-only, so per-channel DENY overwrites were
      // ignored on the prefix path — `,purge` worked in a channel where the
      // moderator's Manage Messages had been explicitly revoked.
      const perms = (message.member && message.channel && 'permissionsFor' in message.channel
        ? (message.channel as { permissionsFor: (m: unknown) => { has: (p: never) => boolean } | null })
          .permissionsFor(message.member)
        : null) ?? message.member?.permissions ?? null;
      const missing = command.permissions.filter((p) => !perms?.has(p as never));
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
      if (message.guild) StatsManager.recordCommand(message.guild.id, userId);
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
