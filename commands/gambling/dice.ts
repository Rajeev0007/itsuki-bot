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

// Was six empty strings, so the rolled dice were completely invisible and the
// result read "**Your Roll:** 4" with a blank where the die should be.
const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default new Command({
  data: new SlashCommandBuilder()
    .setName('dice').setDescription('Roll the dice! Highest roll wins.')
    .addStringOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true)),
  category: 'gambling',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const rawBet = interaction.options.getString('bet');
    if (!rawBet)
      return interaction.editReply({ ...CB.errorResponse('Missing Bet', 'Tell me how much to bet, e.g. `500`, `10k`, `half` or `all`.') } as never);
    const bet = fmt.parseAmount(rawBet, wallet);
    if (!bet || bet < config.gambling.minBet || bet > config.gambling.maxBet)
      return interaction.editReply({ ...CB.errorResponse('Invalid Bet', `Bet between ${fmt.coins(config.gambling.minBet)} and ${fmt.coins(config.gambling.maxBet)}.`) } as never);
    if (bet > wallet) return interaction.editReply({ ...CB.errorResponse('Broke', `You only have ${fmt.coins(wallet)}.`) } as never);

    // Escrow the stake before the roll animation — see roulette/coinflip for the
    // exploit that netting it off afterwards allowed.
    if (!await UserManager.debitWallet(interaction.user.id, bet)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Insufficient Funds', 'Your balance changed before the dice were rolled — nothing was wagered.',
      ) } as never);
    }

    for (let i = 0; i < 3; i++) {
      await interaction.editReply({ components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Rolling the dice…\n**You:** ${DICE_FACES[Math.floor(Math.random()*6)]} · **House:** ${DICE_FACES[Math.floor(Math.random()*6)]}`) )] });
      await sleep(400);
    }

    const pRoll = fmt.randomInt(1, 6);
    const hRoll = fmt.randomInt(1, 6);
    const won = pRoll > hRoll;
    const tie = pRoll === hRoll;
    const net = tie ? 0 : won ? bet : -bet;
    // Stake already escrowed: a tie returns it, a win returns it doubled.
    if (tie)      await UserManager.creditWallet(interaction.user.id, bet);
    else if (won) await UserManager.creditWallet(interaction.user.id, bet * 2);
    await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
    if (won) await UserManager.incrementStat(interaction.user.id, 'gamesWon');
    // Dice never recorded anything in the transaction history, unlike every
    // other gambling command.
    if (!tie) {
      await UserManager.recordTransaction(
        interaction.user.id, won ? 'gambling_win' : 'gambling_loss', net, 'Dice',
      );
    }

    const eco = await UserManager.getEconomy(interaction.user.id);
    const title = tie ? '# Tie!' : won ? `# ${E.WIN} You Win!` : `# ${E.LOSE} House Wins!`;
    const c = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([title, 'The dice have spoken!'].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `${DICE_FACES[pRoll-1]} **Your Roll:** ${pRoll}`, `${DICE_FACES[hRoll-1]} **House Roll:** ${hRoll}`, '',
        tie ? `${E.COINS} **Bet returned:** ${fmt.coins(bet)}` : won ? `${E.WIN} **Won:** ${fmt.coins(bet)}` : `${E.LOSE} **Lost:** ${fmt.coins(bet)}`,
        `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`,
      ].join('\n')));
    await interaction.editReply({ components: [c] });
  },
});
