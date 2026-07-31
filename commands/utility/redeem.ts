import {
  SlashCommandBuilder, MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import PremiumKeyManager from '../../managers/PremiumKeyManager';
import * as CB from '../../builders/ComponentBuilder';
import config from '../../config/config';
import logger from '../../utils/Logger';

/**
 * Redeems a premium key.
 *
 * Not guild-only: premium is attached to the person, not the server, so this
 * has to work in DMs — which is also where keys are usually received.
 */
export default new Command({
  data: new SlashCommandBuilder()
    .setName('redeem').setDescription('Redeem a premium key.')
    .addStringOption((o) => o.setName('code').setDescription('Your key, e.g. ITSUKI-XXXXX-XXXXX-XXXXX')
      .setRequired(true)),
  category: 'utility',
  guildOnly: false,
  // Keys carry ~74 bits of entropy so guessing is not a concern, but a cooldown
  // keeps failed attempts (and the log noise from them) reasonable.
  cooldown: 5_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });

    const code = interaction.options.getString('code') ?? '';

    let result;
    try {
      result = await PremiumKeyManager.redeem(code, interaction.user.id, interaction.user.username);
    } catch (err) {
      logger.error(`[Redeem] ${interaction.user.id} failed: ${(err as Error).message}`);
      return interaction.editReply({ ...CB.errorResponse(
        'Something Went Wrong', 'Your key was not consumed. Please try again in a moment.',
      ) } as never);
    }

    if (!result.ok) {
      logger.debug(`[Redeem] rejected for ${interaction.user.id}: ${result.reason}`);
      return interaction.editReply({ ...CB.errorResponse('Key Not Accepted', [
        result.reason!,
        '',
        '-# Keys are case-insensitive and the dashes are optional, so paste it however you received it.',
      ].join('\n')) } as never);
    }

    const label = result.tier === 'plus' ? 'Premium+' : 'Premium';
    return interaction.editReply({ ...CB.successResponse(`${label} Activated`, [
      `You now have **${label}**${result.expiresAt === null
        ? ' for **life**.'
        : `, expiring <t:${Math.floor(result.expiresAt! / 1000)}:R>.`}`,
      '',
      '**What you get**',
      '> Reduced cooldowns and higher earnings',
      '> Vote-locked commands unlocked',
      '> Extra card rolls and auction slots',
      `> **No-prefix** — type \`balance\` instead of \`${config.prefix}balance\``,
      '',
      `-# Check anytime with \`/premium\`. Redeeming again later extends rather than replaces this.`,
    ].join('\n')) } as never);
  },
});
