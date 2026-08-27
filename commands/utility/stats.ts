/**
 * @file stats.ts
 * @description The bot information panel — /stats (also ,botinfo / ,about).
 *
 * All rendering lives in services/BotInfoPanel so the command, the section select
 * menu and the refresh button cannot drift apart.
 */

import {
  SlashCommandBuilder, MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import { renderPanel, asPage, PAGES } from '../../services/BotInfoPanel';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Bot information, statistics and links.')
    .addStringOption((o) => o.setName('section')
      .setDescription('Open straight to a section')
      .addChoices(...PAGES.map((p) => ({ name: p.label, value: p.id })))),
  category: 'utility',
  // Prefix-only aliases, so `,botinfo` and `,about` work without spending any of
  // the 100 global slash-command slots.
  aliases: ['botinfo', 'about', 'info', 'bot'],
  cooldown: 10_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    // asPage narrows whatever arrives: the slash choices are constrained, but the
    // prefix adapter passes free text straight through.
    const page = asPage(interaction.options.getString('section'));
    const payload = await renderPanel(interaction.client, page, interaction.user.id);

    await interaction.editReply(payload as never);
  },
});
