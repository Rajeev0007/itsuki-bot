import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ThumbnailBuilder,
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

function spin(): string[] {
  const { symbols, weights } = config.gambling.slots;
  return [fmt.weightedRandom([...symbols], weights), fmt.weightedRandom([...symbols], weights), fmt.weightedRandom([...symbols], weights)];
}

function calcPayout(reels: string[], bet: number): number {
  const key = reels.join('');
  const p = config.gambling.slots.payouts;
  if (p[key]) return Math.floor(bet * p[key]);
  if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2])
    return Math.floor(bet * config.gambling.slots.twoMatch);
  return 0;
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('slots').setDescription('Spin the slot machine and test your luck!')
    .addStringOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true)),
  category: 'gambling',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const bet = fmt.parseAmount(interaction.options.get('bet')!.value as string, wallet);
    if (!bet || bet < config.gambling.minBet || bet > config.gambling.maxBet)
      return interaction.editReply({ ...CB.errorResponse('Invalid Bet', `Bet between ${fmt.coins(config.gambling.minBet)} and ${fmt.coins(config.gambling.maxBet)}.`) } as never);
    if (bet > wallet) return interaction.editReply({ ...CB.errorResponse('Broke', `You only have ${fmt.coins(wallet)}.`) } as never);

    const reels = spin();
    const { symbols } = config.gambling.slots;
    const frame = (r1: string, r2: string, r3: string, status: string) => ({
      components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${status}\n\`\`\`\n ${r1} ${r2} ${r3} \n\`\`\``))],
    });

    await interaction.editReply(frame('', '', '', 'Spinning…'));
    await sleep(700);
    await interaction.editReply(frame(reels[0], symbols[Math.floor(Math.random() * symbols.length)], symbols[Math.floor(Math.random() * symbols.length)], 'Spinning…'));
    await sleep(700);
    await interaction.editReply(frame(reels[0], reels[1], symbols[Math.floor(Math.random() * symbols.length)], 'Spinning…'));
    await sleep(700);

    const payout = calcPayout(reels, bet);
    const won = payout > 0;
    const net = payout - bet;

    await UserManager.addWallet(interaction.user.id, net);
    await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
    if (won) await UserManager.incrementStat(interaction.user.id, 'gamesWon');
    await UserManager.recordTransaction(interaction.user.id, won ? 'gambling_win' : 'gambling_loss', net, 'Slots');
    await gamblingDB.ensure(interaction.user.id, { slots: { wins: 0, losses: 0 } });
    if (won) await gamblingDB.add(`${interaction.user.id}.slots.wins`, 1);
    else await gamblingDB.add(`${interaction.user.id}.slots.losses`, 1);

    const eco = await UserManager.getEconomy(interaction.user.id);
    const title = won ? `# ${E.WIN} Winner!` : `# ${E.LOSE} No Match`;
    const c = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`${title}\n\`\`\`\n ${reels[0]} ${reels[1]} ${reels[2]} \n\`\`\``)
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `${E.COINS} **Bet:** ${fmt.coins(bet)}`,
        won ? `${E.WIN} **Payout:** ${fmt.coins(payout)} (${(payout / bet).toFixed(1)}x)` : `${E.LOSE} **Lost:** ${fmt.coins(bet)}`,
        `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`,
      ].join('\n')));
    c.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`slots_spin:${interaction.user.id}:${bet}`).setLabel('Spin Again').setStyle(ButtonStyle.Primary),
      ),
    );
    await interaction.editReply({ components: [c] });
  },
});
