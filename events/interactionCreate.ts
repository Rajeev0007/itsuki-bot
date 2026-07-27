/**
 * @file interactionCreate.ts
 * @description Central router for all incoming Discord interactions.
 */

import {
  type Interaction, type Client, Collection,
  MessageFlags, type ChatInputCommandInteraction,
} from 'discord.js';
import { Event } from '../structures/Event';
import { Command } from '../structures/Command';
import config from '../config/config';
import logger from '../utils/Logger';
import cooldowns from '../managers/CooldownManager';
import BlacklistManager from '../managers/BlacklistManager';
import MaintenanceManager from '../managers/MaintenanceManager';
import * as CB from '../builders/ComponentBuilder';
import { patchReplies } from '../utils/V2Flag';

const V2_EPHEMERAL = (MessageFlags.IsComponentsV2 as number) | (MessageFlags.Ephemeral as number);

export default new Event({
  name: 'interactionCreate',
  async execute(
    interaction: Interaction,
    client: Client & {
      commands?: Collection<string, Command>;
      interactionHandler?: { handle: (i: Interaction) => Promise<void> };
    },
  ) {
    // Blacklisted users get nothing — no autocomplete, no component interactions, no commands.
    if (BlacklistManager.has(interaction.user.id)) return;

    // ── Autocomplete ─────────────────────────────────────────────────────────
    if (interaction.isAutocomplete()) {
      try {
        const cmd = client.commands?.get(interaction.commandName);
        if (cmd?.autocomplete) await cmd.autocomplete(interaction as never, client);
      } catch (err) {
        logger.error(`[interactionCreate] Autocomplete error for /${interaction.commandName}:`, (err as Error).message);
      }
      return;
    }

    // ── Buttons / Modals / Select Menus ──────────────────────────────────────
    if (!interaction.isChatInputCommand()) {
      // Patch reply methods BEFORE the button/modal handler runs
      patchReplies(interaction);
      try {
        await client.interactionHandler?.handle(interaction);
      } catch (err) {
        logger.error('[interactionCreate] Interaction handler error:', (err as Error).message);
        try {
          const i = interaction as unknown as Record<string, unknown>;
          if (!i.replied && !i.deferred) {
            await (i.reply as (o: unknown) => Promise<void>)({ content: ' An error occurred.', ephemeral: true });
          }
        } catch { /* ignore */ }
      }
      return;
    }

    // ── Slash Commands ────────────────────────────────────────────────────────
    const cmdInteraction = interaction as ChatInputCommandInteraction;
    const cmdName = cmdInteraction.commandName;
    const command = client.commands?.get(cmdName);

    if (!command) {
      logger.warn(`[interactionCreate] Unknown command: /${cmdName}`);
      await cmdInteraction.reply({ content: ' Unknown command.', ephemeral: true }).catch(() => {});
      return;
    }

    const guild = cmdInteraction.guild;
    const userId = cmdInteraction.user.id;

    // ── Guards ────────────────────────────────────────────────────────────────

    if (command.guildOnly && !guild) {
      await cmdInteraction.reply({
        ...CB.errorResponse('Server Only', 'This command can only be used inside a server.'),
        flags: V2_EPHEMERAL,
      } as never).catch(() => {});
      return;
    }

    if (command.ownerOnly && !config.owners.includes(userId)) {
      await cmdInteraction.reply({
        ...CB.errorResponse('Owner Only', 'This command is restricted to bot owners.'),
        flags: V2_EPHEMERAL,
      } as never).catch(() => {});
      return;
    }

    if (MaintenanceManager.isEnabled() && !config.owners.includes(userId)) {
      await cmdInteraction.reply({
        ...CB.errorResponse(
          'Maintenance Mode',
          MaintenanceManager.reason() ?? 'The bot is currently undergoing maintenance. Please try again later.',
        ),
        flags: V2_EPHEMERAL,
      } as never).catch(() => {});
      return;
    }

    if (command.maintenance) {
      await cmdInteraction.reply({
        ...CB.errorResponse('Maintenance', 'This command is temporarily disabled.'),
        flags: V2_EPHEMERAL,
      } as never).catch(() => {});
      return;
    }

    if (command.permissions.length && guild) {
      const member = cmdInteraction.member as { permissions?: { has: (p: string) => boolean } } | null;
      const missing = command.permissions.filter((p) => !member?.permissions?.has(p));
      if (missing.length) {
        await cmdInteraction.reply({
          ...CB.errorResponse('Missing Permissions', `You need: ${missing.join(', ')}`),
          flags: V2_EPHEMERAL,
        } as never).catch(() => {});
        return;
      }
    }

    // ── Cooldown ──────────────────────────────────────────────────────────────
    const cdKey = command.cooldown
      ? command.name
      : ['economy', 'gambling', 'social'].includes(command.category)
        ? command.name
        : null;

    if (cdKey) {
      const duration = command.cooldown
        ?? (config.cooldowns as Record<string, number>)[command.name]
        ?? 3000;

      const { onCooldown, remaining } = cooldowns.check(userId, command.name);
      if (onCooldown) {
        await cmdInteraction.reply({
          ...CB.cooldownResponse(command.name, remaining),
          flags: V2_EPHEMERAL,
        } as never).catch(() => {});
        return;
      }
      cooldowns.set(userId, command.name, duration);
    }

    // ── Patch reply methods → IS_COMPONENTS_V2 auto-injected ─────────────────
    patchReplies(cmdInteraction);

    // ── Execute ───────────────────────────────────────────────────────────────
    try {
      logger.command(command.name, cmdInteraction.user.tag, guild?.name ?? 'DM');
      await command.execute(cmdInteraction, client);
    } catch (err) {
      logger.error(`[interactionCreate] /${command.name} threw:`, (err as Error).message);
      logger.debug((err as Error).stack ?? '');

      const errContent = `Something went wrong.\n\`\`\`${(err as Error).message?.slice(0, 200)}\`\`\``;
      try {
        if (cmdInteraction.replied || cmdInteraction.deferred) {
          await cmdInteraction.followUp({
            ...CB.errorResponse('Unexpected Error', errContent),
            flags: V2_EPHEMERAL,
          } as never);
        } else {
          await cmdInteraction.reply({
            ...CB.errorResponse('Unexpected Error', errContent),
            flags: V2_EPHEMERAL,
          } as never);
        }
      } catch (replyErr) {
        logger.error('[interactionCreate] Failed to send error reply:', (replyErr as Error).message);
      }
    }
  },
});
