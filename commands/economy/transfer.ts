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
    .setName('transfer').setDescription('Transfer coins to another user.')
    .addUserOption((o) => o.setName('user').setDescription('Who to send coins to').setRequired(true))
    .addStringOption((o) => o.setName('amount').setDescription('Amount (number, "all", or "half")').setRequired(true)),
  category: 'economy', cooldown: 5000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const target = interaction.options.getUser('user');
    if (!target)                            return interaction.editReply({ ...CB.errorResponse('Missing User', 'Mention the user you want to send coins to.') } as never);
    if (target.id === interaction.user.id) return interaction.editReply({ ...CB.errorResponse('Invalid Target', 'You cannot transfer to yourself.') } as never);
    if (target.bot)                         return interaction.editReply({ ...CB.errorResponse('Invalid Target', 'You cannot transfer to bots.') } as never);
    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const parsed = fmt.parseAmount(interaction.options.getString('amount'), wallet);
    if (!parsed || parsed <= 0) return interaction.editReply({ ...CB.errorResponse('Invalid Amount', 'Please enter a valid positive amount.') } as never);
    const result = await EconomyManager.transfer(interaction.user.id, target.id, parsed);
    if (!result.success) {
      const capacity = 'capacity' in result ? Number(result.capacity ?? 0) : 0;
      const msgs: Record<string, string> = {
        insufficient_funds: "You don't have enough coins.",
        self_transfer: 'You cannot transfer to yourself.',
        invalid_amount: 'Invalid amount.',
        receiver_wallet_full: `${target.username}'s wallet is too full to receive that much. They can hold **${fmt.coins(capacity)}** more.`,
      };
      return interaction.editReply({ ...CB.errorResponse('Transfer Failed', msgs[result.reason] ?? 'Unknown error.') } as never);
    }
    const [sEco, rEco] = await Promise.all([UserManager.getEconomy(interaction.user.id), UserManager.getEconomy(target.id)]);
    const c = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# ${E.TRANSFER} Transfer Complete`, `You sent **${fmt.coins(result.amount)}** to ${target}.`].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(target.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([`**Your Wallet:** ${fmt.coins(sEco.wallet)}`, `**${target.username}'s Wallet:** ${fmt.coins(rEco.wallet)}`].join('\n')));
    await interaction.editReply({ components: [c] });
  },
});
