/**
 * @file shutdown.ts
 * @description Owner-only command to gracefully shut down the bot process.
 * On hosts that auto-restart crashed/exited processes (like most Discord
 * bot panels), this effectively acts as a restart.
 */

import {
  SlashCommandBuilder, MessageFlags,
  type ChatInputCommandInteraction, type Client,
} from 'discord.js';
import { Command } from '../../structures/Command';
import logger       from '../../utils/Logger';
import * as CB       from '../../builders/ComponentBuilder';

const IS_V2 = Number(MessageFlags.IsComponentsV2);

export default new Command({
  data: new SlashCommandBuilder()
    .setName('shutdown')
    .setDescription('(Owner) Gracefully shut down the bot.'),

  category:  'owner',
  ownerOnly: true,
  aliases:   ['restart'],
  cooldown:  0,

  async execute(interaction: ChatInputCommandInteraction, client?: Client) {
    await interaction.reply({
      ...CB.successResponse('Shutting Down', 'Disconnecting from Discord and exiting…'),
      flags: IS_V2 as never,
    } as never);

    logger.info(`[Shutdown] Requested by ${interaction.user.tag} (${interaction.user.id}).`);

    setTimeout(() => {
      client?.destroy();
      process.exit(0);
    }, 500); // give the reply time to actually send before the process exits
  },
});
