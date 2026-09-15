import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command }    from '../../structures/Command';
import EconomyManager from '../../managers/EconomyManager';
import UserManager    from '../../managers/UserManager';
import * as CB        from '../../builders/ComponentBuilder';
import fmt            from '../../utils/Formatter';
import { EMOJI as E } from '../../utils/Constants';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('withdraw').setDescription('Withdraw coins from your bank into your wallet.')
    .addStringOption((o) => o.setName('amount').setDescription('Amount (number, "all", or "half")').setRequired(true)),
  category: 'economy', cooldown: 3000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { bank } = await UserManager.getBalance(interaction.user.id);
    const parsed   = fmt.parseAmount(interaction.options.getString('amount'), bank);
    if (!parsed || parsed <= 0) return interaction.editReply({ ...CB.errorResponse('Invalid Amount', 'Please provide a valid positive amount — a number, `half`, or `all`.') } as never);
    const result = await EconomyManager.withdraw(interaction.user.id, parsed);
    if (!result.success) {
      const msgs: Record<string, string> = { insufficient_bank: "You don't have enough in your bank.", wallet_full: 'Your wallet is full.', invalid_amount: 'Invalid amount.' };
      return interaction.editReply({ ...CB.errorResponse('Withdrawal Failed', msgs[result.reason] ?? 'Unknown error.') } as never);
    }
    const eco = await UserManager.getEconomy(interaction.user.id);
    const c = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# ${E.WITHDRAW} Withdrawal Successful`, `Moved **${fmt.coins(result.amount)}** to your wallet.`].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([`${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`, `${E.BANK} **Bank:** ${fmt.coins(eco.bank)}`].join('\n')));
    await interaction.editReply({ components: [c] });
  },
});
