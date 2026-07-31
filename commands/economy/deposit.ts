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
    .setName('deposit').setDescription('Deposit coins from your wallet into your bank.')
    .addStringOption((o) => o.setName('amount').setDescription('Amount to deposit (number, "all", or "half")').setRequired(true)),
  category: 'economy', cooldown: 3000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const parsed = fmt.parseAmount(interaction.options.getString('amount'), wallet);
    if (!parsed || parsed <= 0) return interaction.editReply({ ...CB.errorResponse('Invalid Amount', 'Please provide a valid positive amount — a number, `half`, or `all`.') } as never);
    const result = await EconomyManager.deposit(interaction.user.id, parsed);
    if (!result.success) {
      const msgs: Record<string, string> = {
        insufficient_funds: "You don't have enough in your wallet.",
        bank_full: `Your bank is full. Max deposit: **${fmt.coins('maxDeposit' in result ? result.maxDeposit ?? 0 : 0)}**.`,
        invalid_amount: 'Invalid amount.',
      };
      return interaction.editReply({ ...CB.errorResponse('Deposit Failed', msgs[result.reason] ?? 'Unknown error.') } as never);
    }
    const eco = await UserManager.getEconomy(interaction.user.id);
    const c = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# ${E.DEPOSIT} Deposit Successful`, `You deposited **${fmt.coins(result.amount)}** into your bank.`].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([`${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`, `${E.BANK} **Bank:** ${fmt.coins(eco.bank)}`].join('\n')));
    await interaction.editReply({ components: [c] });
  },
});
