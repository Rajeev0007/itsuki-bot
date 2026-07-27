/**
 * @file maintenance.ts
 * @description Owner-only command to toggle global maintenance mode.
 * While enabled, every command is blocked for everyone except bot owners.
 */

import {
  SlashCommandBuilder, MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command }         from '../../structures/Command';
import MaintenanceManager  from '../../managers/MaintenanceManager';
import * as CB             from '../../builders/ComponentBuilder';

const IS_V2 = Number(MessageFlags.IsComponentsV2);

export default new Command({
  data: new SlashCommandBuilder()
    .setName('maintenance')
    .setDescription('(Owner) Toggle global maintenance mode.')
    .addSubcommand((s) =>
      s.setName('on')
        .setDescription('Enable maintenance mode — blocks the bot for everyone but owners.')
        .addStringOption((o) => o.setName('reason').setDescription('Reason shown to users.').setRequired(false))
    )
    .addSubcommand((s) => s.setName('off').setDescription('Disable maintenance mode.'))
    .addSubcommand((s) => s.setName('status').setDescription('Show current maintenance status.')),

  category:  'owner',
  ownerOnly: true,
  aliases:   ['maint'],
  cooldown:  1000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: IS_V2 as never });
    const sub = interaction.options.getSubcommand();

    if (sub === 'on') {
      const reason = interaction.options.getString('reason');
      await MaintenanceManager.enable(reason, interaction.user.id);
      return interaction.editReply(
        CB.successResponse(
          'Maintenance Mode Enabled',
          `Only bot owners can use commands now.${reason ? `\n**Reason:** ${reason}` : ''}`,
        ) as never,
      );
    }

    if (sub === 'off') {
      await MaintenanceManager.disable();
      return interaction.editReply(
        CB.successResponse('Maintenance Mode Disabled', 'The bot is available to everyone again.') as never,
      );
    }

    // ── status ───────────────────────────────────────────────────────────────
    const enabled = MaintenanceManager.isEnabled();
    const reason  = MaintenanceManager.reason();
    return interaction.editReply(
      enabled
        ? CB.successResponse('Maintenance Mode: ON', reason ?? 'No reason set.') as never
        : CB.successResponse('Maintenance Mode: OFF', 'The bot is available to everyone.') as never,
    );
  },
});
