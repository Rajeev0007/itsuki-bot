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

const REDS = new Set(config.gambling.roulette.reds);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRAMES = ['*The wheel starts spinning…*','*Picking up speed…*','*Slowing down…*','*Almost there…*'];

function getBetPayout(betType: string, betValue: number | null, result: number): number {
  const isRed = REDS.has(result);
  const isEven = result !== 0 && result % 2 === 0;
  switch (betType) {
    case 'red': return isRed ? 2 : 0;
    case 'black': return !isRed && result !== 0 ? 2 : 0;
    case 'even': return isEven ? 2 : 0;
    case 'odd': return !isEven && result !== 0 ? 2 : 0;
    case 'low': return result >= 1 && result <= 18 ? 2 : 0;
    case 'high': return result >= 19 && result <= 36 ? 2 : 0;
    case 'number': return result === betValue ? 36 : 0;
    default: return 0;
  }
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('roulette').setDescription('Spin the roulette wheel.')
    .addStringOption((o) => o.setName('bet_type').setDescription('Type of bet').setRequired(true)
      .addChoices(
        { name: 'Red', value: 'red' }, { name: 'Black', value: 'black' },
        { name: 'Even', value: 'even' }, { name: 'Odd', value: 'odd' },
        { name: '1-18 (Low)', value: 'low' }, { name: '19-36 (High)', value: 'high' },
        { name: 'Exact Number (0-36)', value: 'number' },
      ))
    .addStringOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true))
    .addIntegerOption((o) => o.setName('number').setDescription('Number (0-36) if betting exact').setMinValue(0).setMaxValue(36)),
  category: 'gambling',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const betType = interaction.options.get('bet_type')!.value as string;
    const numChoice = interaction.options.get('number')?.value as number | null ?? null;
    if (betType === 'number' && numChoice === null)
      return interaction.editReply({ ...CB.errorResponse('Missing Number', 'Provide a number (0-36) when betting exact.') } as never);
    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const bet = fmt.parseAmount(interaction.options.get('bet')!.value as string, wallet);
    if (!bet || bet < config.gambling.minBet || bet > config.gambling.maxBet)
      return interaction.editReply({ ...CB.errorResponse('Invalid Bet', `Bet between ${fmt.coins(config.gambling.minBet)} and ${fmt.coins(config.gambling.maxBet)}.`) } as never);
    if (bet > wallet) return interaction.editReply({ ...CB.errorResponse('Broke', `You only have ${fmt.coins(wallet)}.`) } as never);

    for (const f of FRAMES) {
      const passing = Array.from({ length: 5 }, () => fmt.randomInt(0, 36)).join(' ');
      await interaction.editReply({ components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Roulette\n${f}\n> \`${passing}\``))] });
      await sleep(500);
    }

    const result = fmt.randomInt(0, 36);
    const isRed = REDS.has(result);
    const color = result === 0 ? 'Green' : isRed ? 'Red' : 'Black';
    const mult = getBetPayout(betType, numChoice, result);
    const payout = Math.floor(bet * mult);
    const net = payout - bet;
    const won = payout > 0;
    await UserManager.addWallet(interaction.user.id, net);
    await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
    if (won) await UserManager.incrementStat(interaction.user.id, 'gamesWon');

    const eco = await UserManager.getEconomy(interaction.user.id);
    const c = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([won ? `# ${E.WIN} You Win!` : `# ${E.LOSE} You Lose!`, `The ball landed on **${color} ${result}**!`].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `**Your Bet:** ${betType === 'number' ? `Number ${numChoice}` : betType}`,
        `${E.COINS} **Wagered:** ${fmt.coins(bet)}`,
        won ? `${E.WIN} **Payout:** ${fmt.coins(payout)} (${mult}x)` : `${E.LOSE} **Lost:** ${fmt.coins(bet)}`,
        `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`,
      ].join('\n')));
    await interaction.editReply({ components: [c] });
  },
});
