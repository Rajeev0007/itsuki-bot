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

const DICE_FACES = ['','','','','',''];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default new Command({
  data: new SlashCommandBuilder()
    .setName('dice').setDescription('Roll the dice! Highest roll wins.')
    .addStringOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true)),
  category: 'gambling',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const bet = fmt.parseAmount(interaction.options.get('bet')!.value as string, wallet);
    if (!bet || bet < config.gambling.minBet || bet > config.gambling.maxBet)
      return interaction.editReply({ ...CB.errorResponse('Invalid Bet', `Bet between ${fmt.coins(config.gambling.minBet)} and ${fmt.coins(config.gambling.maxBet)}.`) } as never);
    if (bet > wallet) return interaction.editReply({ ...CB.errorResponse('Broke', `You only have ${fmt.coins(wallet)}.`) } as never);

    for (let i = 0; i < 3; i++) {
      await interaction.editReply({ components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Rolling the dice…\n**You:** ${DICE_FACES[Math.floor(Math.random()*6)]} · **House:** ${DICE_FACES[Math.floor(Math.random()*6)]}`) )] });
      await sleep(400);
    }

    const pRoll = fmt.randomInt(1, 6);
    const hRoll = fmt.randomInt(1, 6);
    const won = pRoll > hRoll;
    const tie = pRoll === hRoll;
    const net = tie ? 0 : won ? bet : -bet;
    await UserManager.addWallet(interaction.user.id, net);
    await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
    if (won) await UserManager.incrementStat(interaction.user.id, 'gamesWon');

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
