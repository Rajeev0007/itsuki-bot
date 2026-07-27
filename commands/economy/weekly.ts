import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import EconomyManager from '../../managers/EconomyManager';
import UserManager from '../../managers/UserManager';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import { EMOJI as E } from '../../utils/Constants';

export default new Command({
  data: new SlashCommandBuilder().setName('weekly').setDescription('Claim your weekly coins reward (resets every 7 days).'),
  category: 'economy', cooldown: 5000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const result = await EconomyManager.weekly(interaction.user.id);
    if (!result.success) {
      const c = new ContainerBuilder().addSectionComponents(
        new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([`# ${E.COOLDOWN} Already Claimed`, `Your weekly resets ${fmt.relativeTime(Date.now() + result.remaining)}.`].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 })))
      );
      return interaction.editReply({ components: [c] });
    }
    const eco = await UserManager.getEconomy(interaction.user.id);
    const c = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# Weekly Reward`, `${interaction.user} claimed their weekly reward!`].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `${E.COINS} **Earned:** ${fmt.coins(result.amount)}`,
        `${E.WALLET} **New Wallet:** ${fmt.coins(eco.wallet)}`,
        '', `-# Next weekly ${fmt.relativeTime(Date.now() + config.cooldowns.weekly)}`,
      ].join('\n')));
    await interaction.editReply({ components: [c] });
  },
});
