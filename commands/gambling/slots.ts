import {
  SlashCommandBuilder, MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import * as Slots from '../../utils/SlotMachine';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default new Command({
  data: new SlashCommandBuilder()
    .setName('slots').setDescription('Spin the slot machine and test your luck!')
    .addStringOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true)),
  category: 'gambling',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const { wallet } = await UserManager.getBalance(interaction.user.id);
    // getString() rather than get('bet')!.value — the prefix adapter returns
    // null for a missing option, and the non-null assertion turned "no bet
    // given" into an unhandled TypeError instead of a friendly message.
    const rawBet = interaction.options.getString('bet');
    if (!rawBet)
      return interaction.editReply({ ...CB.errorResponse('Missing Bet', 'Tell me how much to bet, e.g. `500`, `10k`, `half` or `all`.') } as never);

    const bet = fmt.parseAmount(rawBet, wallet);
    if (!bet || bet < config.gambling.minBet || bet > config.gambling.maxBet)
      return interaction.editReply({ ...CB.errorResponse('Invalid Bet', `Bet between ${fmt.coins(config.gambling.minBet)} and ${fmt.coins(config.gambling.maxBet)}.`) } as never);
    if (bet > wallet)
      return interaction.editReply({ ...CB.errorResponse('Broke', `You only have ${fmt.coins(wallet)}.`) } as never);

    const reels = Slots.spin();

    await interaction.editReply(Slots.spinFrame('?', '?', '?', 'Spinning…'));
    await sleep(700);
    await interaction.editReply(Slots.spinFrame(reels[0], Slots.randomSymbol(), Slots.randomSymbol(), 'Spinning…'));
    await sleep(700);
    await interaction.editReply(Slots.spinFrame(reels[0], reels[1], Slots.randomSymbol(), 'Spinning…'));
    await sleep(700);

    const settlement = await Slots.settleSpin(interaction.user.id, reels, bet);

    await interaction.editReply({
      components: [Slots.buildResult({
        userId: interaction.user.id,
        avatarUrl: interaction.user.displayAvatarURL({ size: 256 }),
        reels, bet, settlement,
      })],
    });
  },
});
