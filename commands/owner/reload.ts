/**
 * @file reload.ts
 * @description Owner-only hot reload of command modules — no process restart.
 *
 * How it works: command files are loaded with `require`, so Node caches them.
 * Deleting the cache entry and re-requiring picks up the file from disk. The
 * fresh module replaces the entry in `client.commands`.
 *
 * Limits worth knowing:
 *  - Only COMMAND modules are reloaded. Managers and services are cached by
 *    other modules that already hold a reference, so swapping them would leave
 *    two copies of the same state — that genuinely needs a restart.
 *  - Reloading does NOT re-register slash commands with Discord. Changing a
 *    command's name/description/options still needs a deploy; this refreshes
 *    the executed code.
 */

import fs from 'fs';
import path from 'path';
import {
  SlashCommandBuilder, MessageFlags,
  type ChatInputCommandInteraction, type Client, type Collection,
} from 'discord.js';
import { Command } from '../../structures/Command';
import * as CB from '../../builders/ComponentBuilder';
import logger from '../../utils/Logger';

const COMMANDS_ROOT = path.join(__dirname, '..');

/** Finds a command file by command name, searching every category folder. */
function findCommandFile(name: string): string | null {
  const categories = fs.readdirSync(COMMANDS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const category of categories) {
    const dir = path.join(COMMANDS_ROOT, category);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.js'))) {
      const full = path.join(dir, file);
      // Match on the declared command name, not the filename — they differ
      // (pets.ts declares /pet, for example).
      try {
        const cached = require.cache[require.resolve(full)];
        const existing = cached?.exports?.default as Command | undefined;
        if (existing && (existing as Command).name === name) return full;
      } catch { /* fall through to filename match */ }
      if (path.basename(file).replace(/\.(ts|js)$/, '') === name) return full;
    }
  }
  return null;
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('reload').setDescription('(Owner) Reload a command from disk without restarting.')
    .addStringOption((o) => o.setName('command')
      .setDescription('Command name, or "all" to reload everything').setRequired(true)),
  category: 'owner',
  ownerOnly: true,
  cooldown: 0,

  async execute(interaction: ChatInputCommandInteraction, client?: Client) {
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });

    const bot = (client ?? interaction.client) as Client & { commands?: Collection<string, Command> };
    if (!bot.commands) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unavailable', 'The command collection is not attached to the client.',
      ) } as never);
    }

    const target = (interaction.options.getString('command') ?? '').trim().toLowerCase();

    // ── Reload everything ───────────────────────────────────────────────────
    if (target === 'all') {
      const names = [...bot.commands.keys()];
      let ok = 0;
      const failures: string[] = [];

      for (const name of names) {
        const file = findCommandFile(name);
        if (!file) { failures.push(`${name} (file not found)`); continue; }
        try {
          delete require.cache[require.resolve(file)];
          const mod = require(file);
          const fresh = (mod.default ?? mod) as Command;
          if (!fresh?.name) throw new Error('module has no default Command export');
          bot.commands.set(fresh.name, fresh);
          ok++;
        } catch (err) {
          failures.push(`${name} (${(err as Error).message})`);
        }
      }

      logger.info(`[Reload] ${interaction.user.tag} reloaded ${ok}/${names.length} commands`);
      return interaction.editReply({ ...CB.successResponse(
        'Reloaded',
        [
          `**${ok}** of ${names.length} command(s) reloaded.`,
          failures.length ? `\n**Failed:**\n${failures.slice(0, 8).map((f) => `> ${f}`).join('\n')}` : '',
          '-# Slash definitions are unchanged — run a deploy if you edited names or options.',
        ].filter(Boolean).join('\n'),
      ) } as never);
    }

    // ── Reload one ──────────────────────────────────────────────────────────
    const file = findCommandFile(target);
    if (!file) {
      return interaction.editReply({ ...CB.errorResponse(
        'Not Found', `No command file found for \`${target}\`.`,
      ) } as never);
    }

    try {
      delete require.cache[require.resolve(file)];
      const mod = require(file);
      const fresh = (mod.default ?? mod) as Command;
      if (!fresh?.name) throw new Error('module has no default Command export');

      bot.commands.set(fresh.name, fresh);
      logger.info(`[Reload] ${interaction.user.tag} reloaded /${fresh.name}`);

      return interaction.editReply({ ...CB.successResponse(
        'Command Reloaded',
        [
          `\`/${fresh.name}\` was reloaded from disk.`,
          `-# ${path.relative(process.cwd(), file)}`,
        ].join('\n'),
      ) } as never);
    } catch (err) {
      // The old module is already evicted from cache at this point, but the
      // in-memory command object is untouched, so the previous version keeps
      // working until a successful reload.
      logger.error(`[Reload] Failed for "${target}": ${(err as Error).message}`);
      return interaction.editReply({ ...CB.errorResponse(
        'Reload Failed',
        `\`\`\`js\n${(err as Error).message.slice(0, 800)}\n\`\`\`\n-# The previously loaded version is still active.`,
      ) } as never);
    }
  },
});
