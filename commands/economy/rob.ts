import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import EconomyManager from '../../managers/EconomyManager';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import { EMOJI as E } from '../../utils/Constants';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default new Command({
  data: new SlashCommandBuilder()
    .setName('rob').setDescription("Attempt to rob another user's wallet. (1 hour cooldown)")
    .addUserOption((o) => o.setName('target').setDescription('Who to rob').setRequired(true)),
  category: 'economy',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const target = interaction.options.getUser('target');
    if (!target) return interaction.editReply({ ...CB.errorResponse('Missing Target', 'Mention the user you want to rob.') } as never);
    if (target.id === interaction.user.id) return interaction.editReply({ ...CB.errorResponse('Invalid Target', 'You cannot rob yourself.') } as never);
    if (target.bot) return interaction.editReply({ ...CB.errorResponse('Invalid Target', 'Bots carry no coins!') } as never);
    const result = await EconomyManager.rob(interaction.user.id, target.id);
    const av = interaction.user.displayAvatarURL({ size: 256 });
    if (!result.success && 'remaining' in result && result.remaining) {
      const c = new ContainerBuilder().addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# ${E.COOLDOWN} Laying Low`, `Cops are watching. Return ${fmt.relativeTime(Date.now() + result.remaining)}.`].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)));
      return interaction.editReply({ components: [c] });
    }
    if (!result.success && 'reason' in result && result.reason === 'too_poor')
      return interaction.editReply({ ...CB.errorResponse('Broke Target', `${target.username} doesn't have enough coins (min ${fmt.coins(config.economy.robMinWallet)}).`) } as never);
    if (!result.success && 'reason' in result && result.reason === 'no_collateral')
      return interaction.editReply({ ...CB.errorResponse(
        'Nothing to Lose',
        `You need at least ${fmt.coins(config.economy.robFine.min)} in your wallet to cover the fine if you get caught.`,
      ) } as never);
    const frames = ['Locating **' + target.username + '**…', 'Sneaking up…', 'Making your move…'];
    for (const f of frames) {
      await interaction.editReply({ components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Robbery in Progress\n> ${f}`))] });
      await sleep(550);
    }
    const eco = await UserManager.getEconomy(interaction.user.id);
    if (result.success && 'stolen' in result) {
      const c = new ContainerBuilder()
        .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([`# Successful Robbery!`, `You robbed ${target} and escaped!`].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([`${E.COINS} **Stolen:** ${fmt.coins(result.stolen)}`, `${E.WALLET} **Your Wallet:** ${fmt.coins(eco.wallet)}`].join('\n')));
      return interaction.editReply({ components: [c] });
    }
    const fine = 'fine' in result ? result.fine : 0;
    const c = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# Caught in the Act!`, `${target.username} fought back and the police arrived.`].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([`${E.COINS} **Fine Paid:** ${fmt.coins(fine ?? 0)}`, `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`].join('\n')));
    await interaction.editReply({ components: [c] });
  },
});
