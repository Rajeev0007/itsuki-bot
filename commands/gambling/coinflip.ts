import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import { EMOJI as E } from '../../utils/Constants';
import { getStore } from '../../database/JsonStore';

const gamblingDB = getStore('gambling');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRAMES = ['*The coin soars into the air…*', '*Spinning fast…*', '*Almost there…*', '*It\'s coming down!*'];

export default new Command({
  data: new SlashCommandBuilder()
    .setName('coinflip').setDescription('Flip a coin — bet on heads or tails.')
    .addStringOption((o) => o.setName('choice').setDescription('heads or tails').setRequired(true)
      .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' }))
    .addStringOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true)),
  category: 'gambling',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const choice = (interaction.options.getString('choice') ?? '').toLowerCase();
    if (choice !== 'heads' && choice !== 'tails')
      return interaction.editReply({ ...CB.errorResponse('Invalid Choice', 'Pick either `heads` or `tails`.') } as never);
    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const rawBet = interaction.options.getString('bet');
    if (!rawBet)
      return interaction.editReply({ ...CB.errorResponse('Missing Bet', 'Tell me how much to bet, e.g. `500`, `10k`, `half` or `all`.') } as never);
    const bet = fmt.parseAmount(rawBet, wallet);
    if (!bet || bet < config.gambling.minBet || bet > config.gambling.maxBet)
      return interaction.editReply({ ...CB.errorResponse('Invalid Bet', `Bet between ${fmt.coins(config.gambling.minBet)} and ${fmt.coins(config.gambling.maxBet)}.`) } as never);
    if (bet > wallet) return interaction.editReply({ ...CB.errorResponse('Insufficient Funds', `You only have ${fmt.coins(wallet)}.`) } as never);

    for (const f of FRAMES) {
      await interaction.editReply({ components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${f}`))] });
      await sleep(500);
    }

    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    const won = result === choice;
    const net = won ? bet : -bet;
    await UserManager.addWallet(interaction.user.id, net);
    await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
    if (won) await UserManager.incrementStat(interaction.user.id, 'gamesWon');
    await UserManager.recordTransaction(
      interaction.user.id, won ? 'gambling_win' : 'gambling_loss', net, 'Coinflip',
    );
    await gamblingDB.ensure(interaction.user.id, { coinflip: { wins: 0, losses: 0 } });
    if (won) await gamblingDB.add(`${interaction.user.id}.coinflip.wins`, 1);
    else await gamblingDB.add(`${interaction.user.id}.coinflip.losses`, 1);

    const eco = await UserManager.getEconomy(interaction.user.id);
    const c = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([won ? `# ${E.WIN} You Won!` : `# ${E.LOSE} You Lost!`, `The coin landed on **${result === 'heads' ? 'Heads' : 'Tails'}**`].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `${E.COINFLIP} **Your Choice:** ${choice}`, `${E.COINFLIP} **Result:** ${result}`,
        `${E.COINS} **${won ? 'Won' : 'Lost'}:** ${fmt.coins(bet)}`, `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`,
      ].join('\n')));
    await interaction.editReply({ components: [c] });
  },
});
