/**
 * @file botconfig.ts
 * @description Owner-only management of the bot's own identity and servers.
 *
 * Deliberately separate from /panel: these actions are rate-limited or
 * destructive, so they're explicit commands with confirmation rather than
 * one-click buttons.
 */

import {
  SlashCommandBuilder, MessageFlags,
  type ChatInputCommandInteraction, type Client,
} from 'discord.js';
import { Command } from '../../structures/Command';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import logger from '../../utils/Logger';

const IMAGE_URL_RE = /^https?:\/\/.+\.(png|jpe?g|gif|webp)(\?.*)?$/i;

export default new Command({
  data: new SlashCommandBuilder()
    .setName('botconfig').setDescription('(Owner) Manage the bot account and servers.')
    .addSubcommand((s) => s.setName('avatar').setDescription("Change the bot's avatar")
      .addStringOption((o) => o.setName('url').setDescription('Direct image URL').setRequired(true)))
    .addSubcommand((s) => s.setName('username').setDescription("Change the bot's username")
      .addStringOption((o) => o.setName('name').setDescription('New username (2-32 chars)').setRequired(true)))
    .addSubcommand((s) => s.setName('leaveguild').setDescription('Make the bot leave a server')
      .addStringOption((o) => o.setName('guild_id').setDescription('Server ID').setRequired(true)))
    .addSubcommand((s) => s.setName('info').setDescription('Show bot account details')),
  category: 'owner',
  ownerOnly: true,
  cooldown: 0,

  async execute(interaction: ChatInputCommandInteraction, client?: Client) {
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['avatar', 'username', 'leaveguild', 'info'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const bot = client ?? interaction.client;

    if (sub === 'info') {
      const totalMembers = bot.guilds.cache.reduce((sum, g) => sum + (g.memberCount ?? 0), 0);
      return interaction.editReply({ ...CB.successResponse(
        bot.user?.tag ?? 'Bot',
        [
          `**ID:** \`${bot.user?.id}\``,
          `**Servers:** ${bot.guilds.cache.size}`,
          `**Reach:** ${fmt.number(totalMembers)} members`,
          `**Created:** <t:${Math.floor((bot.user?.createdTimestamp ?? 0) / 1000)}:D>`,
          `**Uptime:** ${fmt.duration(process.uptime() * 1000)}`,
        ].join('\n'),
      ) } as never);
    }

    if (sub === 'avatar') {
      const url = (interaction.options.getString('url') ?? '').trim();
      if (!IMAGE_URL_RE.test(url)) {
        return interaction.editReply({ ...CB.errorResponse(
          'Invalid URL', 'Provide a direct image URL ending in `.png`, `.jpg`, `.gif` or `.webp`.',
        ) } as never);
      }
      try {
        await bot.user!.setAvatar(url);
        logger.info(`[BotConfig] Avatar changed by ${interaction.user.tag}`);
        return interaction.editReply({ ...CB.successResponse(
          'Avatar Updated', 'The new avatar is live. It may take a moment to appear everywhere.',
        ) } as never);
      } catch (err) {
        // Discord rate-limits avatar changes aggressively; surface the real
        // reason rather than a generic failure.
        return interaction.editReply({ ...CB.errorResponse(
          'Avatar Change Failed',
          `${(err as Error).message}\n-# Discord rate-limits avatar changes — wait a few minutes and retry.`,
        ) } as never);
      }
    }

    if (sub === 'username') {
      const name = (interaction.options.getString('name') ?? '').trim();
      if (name.length < 2 || name.length > 32) {
        return interaction.editReply({ ...CB.errorResponse(
          'Invalid Name', 'Usernames must be 2-32 characters.',
        ) } as never);
      }
      try {
        await bot.user!.setUsername(name);
        logger.info(`[BotConfig] Username changed to "${name}" by ${interaction.user.tag}`);
        return interaction.editReply({ ...CB.successResponse(
          'Username Updated', `The bot is now **${name}**.`,
        ) } as never);
      } catch (err) {
        return interaction.editReply({ ...CB.errorResponse(
          'Username Change Failed',
          `${(err as Error).message}\n-# Discord allows only 2 username changes per hour.`,
        ) } as never);
      }
    }

    // ── leaveguild ──────────────────────────────────────────────────────────
    const guildId = (interaction.options.getString('guild_id') ?? '').trim();
    const guild = bot.guilds.cache.get(guildId);
    if (!guild) {
      return interaction.editReply({ ...CB.errorResponse(
        'Not Found', `The bot is not in a server with ID \`${guildId}\`.`,
      ) } as never);
    }
    // Refuse to leave the server the command was run from — that would kill the
    // ability to respond and is almost always a mistake.
    if (guildId === interaction.guildId) {
      return interaction.editReply({ ...CB.errorResponse(
        'Not From Here', 'Run this from another server (or a DM) to make the bot leave this one.',
      ) } as never);
    }

    const name = guild.name;
    try {
      await guild.leave();
      logger.warn(`[BotConfig] Left guild "${name}" (${guildId}) at ${interaction.user.tag}'s request`);
      return interaction.editReply({ ...CB.successResponse(
        'Left Server', `The bot has left **${name}** (\`${guildId}\`).`,
      ) } as never);
    } catch (err) {
      return interaction.editReply({ ...CB.errorResponse(
        'Could Not Leave', (err as Error).message,
      ) } as never);
    }
  },
});
