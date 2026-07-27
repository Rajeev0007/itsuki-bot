import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import EconomyManager from '../../managers/EconomyManager';
import UserManager from '../../managers/UserManager';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import { EMOJI as E } from '../../utils/Constants';

export default new Command({
  data: new SlashCommandBuilder().setName('daily').setDescription('Claim your daily coins reward (resets every 24 hours).'),
  category: 'economy', cooldown: 5000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const result = await EconomyManager.daily(interaction.user.id);
    if (!result.success) {
      const container = new ContainerBuilder().addSectionComponents(
        new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([`# ${E.COOLDOWN} Already Claimed`, `Come back in **${fmt.duration(result.remaining)}**.`].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 })))
      );
      return interaction.editReply({ components: [container] });
    }
    const eco = await UserManager.getEconomy(interaction.user.id);
    const streak = eco.dailyStreak ?? 1;
    const container = new ContainerBuilder()
      .addSectionComponents(
        new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([`# ${E.DAILY} Daily Reward`, `${interaction.user} claimed their daily reward!`].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 })))
      )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `${E.COINS} **Earned:** ${fmt.coins(result.amount)}`,
        `**Streak:** ${streak} day${streak !== 1 ? 's' : ''}`,
        streak > 1 ? `> +${Math.min(streak * 5, 50)}% streak bonus applied!` : '',
        '', `${E.WALLET} **New Wallet:** ${fmt.coins(eco.wallet)}`,
      ].filter(Boolean).join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Next daily available ${fmt.relativeTime(Date.now() + config.cooldowns.daily)}`));
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('nav_balance').setLabel('View Balance').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('nav_shop').setLabel('Visit Shop').setStyle(ButtonStyle.Primary),
      ),
    );
    await interaction.editReply({ components: [container] });
  },
});
