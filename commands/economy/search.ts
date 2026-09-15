import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command }    from '../../structures/Command';
import EconomyManager from '../../managers/EconomyManager';
import UserManager    from '../../managers/UserManager';
import fmt            from '../../utils/Formatter';
import { EMOJI as E } from '../../utils/Constants';

export default new Command({
  data: new SlashCommandBuilder().setName('search').setDescription('Search a random location for coins. (2 min cooldown)'),
  category: 'economy',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const result = await EconomyManager.search(interaction.user.id);
    const av = interaction.user.displayAvatarURL({ size: 256 });
    if (!result.success && 'remaining' in result && result.remaining) {
      const c = new ContainerBuilder().addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# ${E.COOLDOWN} Cooldown`, `You can search again ${fmt.relativeTime(Date.now() + result.remaining)}.`].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)));
      return interaction.editReply({ components: [c] });
    }
    const eco = await UserManager.getEconomy(interaction.user.id);
    if (result.success && 'amount' in result) {
      const c = new ContainerBuilder()
        .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([`# ${E.SEARCH} Found Something!`, `You searched **${result.location}** and found coins!`].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([`${E.COINS} **Found:** ${fmt.coins(result.amount)}`, `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`].join('\n')));
      return interaction.editReply({ components: [c] });
    }
    const loc = 'location' in result ? result.location : 'somewhere';
    const c = new ContainerBuilder().addSectionComponents(new SectionBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent([`# Nothing Found`, `You searched **${loc}** but found nothing.`].join('\n'))
    ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)));
    await interaction.editReply({ components: [c] });
  },
});
