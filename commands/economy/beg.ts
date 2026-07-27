import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import EconomyManager from '../../managers/EconomyManager';
import UserManager from '../../managers/UserManager';
import fmt from '../../utils/Formatter';
import { EMOJI as E } from '../../utils/Constants';

const BEG_SUCCESS = ['A generous stranger tossed you some coins!','Someone felt sorry for you and donated.','A rich passerby dropped some change.'];
const BEG_FAIL = ['Everyone ignored you.','Someone told you to get a job.','Nobody had spare change.'];

export default new Command({
  data: new SlashCommandBuilder().setName('beg').setDescription('Beg for coins. (1 min cooldown)'),
  category: 'economy',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const result = await EconomyManager.beg(interaction.user.id);
    const av = interaction.user.displayAvatarURL({ size: 256 });
    if (!result.success && 'remaining' in result && result.remaining) {
      const c = new ContainerBuilder().addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# ${E.COOLDOWN} Cooldown`, `Try begging again ${fmt.relativeTime(Date.now() + result.remaining)}.`].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)));
      return interaction.editReply({ components: [c] });
    }
    const eco = await UserManager.getEconomy(interaction.user.id);
    if (result.success && 'amount' in result) {
      const c = new ContainerBuilder()
        .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([`# Someone Helped!`, fmt.randomItem(BEG_SUCCESS)].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([`${E.COINS} **Received:** ${fmt.coins(result.amount)}`, `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`].join('\n')));
      return interaction.editReply({ components: [c] });
    }
    const c = new ContainerBuilder().addSectionComponents(new SectionBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent([`# No Luck`, fmt.randomItem(BEG_FAIL)].join('\n'))
    ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)));
    await interaction.editReply({ components: [c] });
  },
});
