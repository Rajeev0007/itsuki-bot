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
import { SUITS, CARD_VALUES } from '../../utils/Constants';
import { getStore } from '../../database/JsonStore';

const gamblingDB = getStore('gambling');

interface Card { suit: string; val: string }

function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (const val of CARD_VALUES) deck.push({ suit, val });
  return deck.sort(() => Math.random() - 0.5);
}
function cardValue(c: Card): number { if (['J','Q','K'].includes(c.val)) return 10; if (c.val === 'A') return 11; return parseInt(c.val); }
function handValue(hand: Card[]): number { let t = hand.reduce((s, c) => s + cardValue(c), 0); let aces = hand.filter(c => c.val === 'A').length; while (t > 21 && aces > 0) { t -= 10; aces--; } return t; }
function renderHand(hand: Card[]): string { return hand.map(c => `${c.val}${c.suit}`).join(' '); }

function buildContainer(pHand: Card[], dHand: Card[], bet: number, wallet: number, status: string, hideDealer = false): ContainerBuilder {
  const pv = handValue(pHand);
  const dCards = hideDealer ? [`${dHand[0].val}${dHand[0].suit}`, ''] : dHand.map(c => `${c.val}${c.suit}`);
  const dv = hideDealer ? cardValue(dHand[0]) : handValue(dHand);
  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([`# ${E.CARDS} Blackjack`, status].join('\n')))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      `**Dealer** — ${hideDealer ? `${dv}+?` : dv}`, `> ${dCards.join(' ')}`, '',
      `**You** — **${pv}** ${pv > 21 ? ' BUST' : pv === 21 ? ' 21!' : ''}`, `> ${renderHand(pHand)}`, '',
      `${E.COINS} **Bet:** ${fmt.coins(bet)} • ${E.WALLET} **Wallet:** ${fmt.coins(wallet)}`,
    ].join('\n')));
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('blackjack').setDescription('Play a game of blackjack against the dealer.')
    .addStringOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true)),
  category: 'gambling',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const bet = fmt.parseAmount(interaction.options.get('bet')!.value as string, wallet);
    if (!bet || bet < config.gambling.minBet || bet > config.gambling.maxBet)
      return interaction.editReply({ ...CB.errorResponse('Invalid Bet', `Bet between ${fmt.coins(config.gambling.minBet)} and ${fmt.coins(config.gambling.maxBet)}.`) } as never);
    if (bet > wallet) return interaction.editReply({ ...CB.errorResponse('Broke', `You only have ${fmt.coins(wallet)}.`) } as never);

    const deck = buildDeck();
    const player = [deck.pop()!, deck.pop()!];
    const dealer = [deck.pop()!, deck.pop()!];
    await UserManager.addWallet(interaction.user.id, -bet);
    const eco0 = await UserManager.getEconomy(interaction.user.id);

    const pBJ = handValue(player) === 21, dBJ = handValue(dealer) === 21;
    if (pBJ || dBJ) {
      let payout = 0, txt = '';
      if (pBJ && dBJ) { payout = bet; txt = ' Both have Blackjack — Push!'; }
      else if (pBJ) { payout = Math.floor(bet * 2.5); txt = `# Blackjack! You win ${fmt.coins(payout)}!`; }
      else { txt = `# Dealer has Blackjack. You lose ${fmt.coins(bet)}.`; }
      if (payout > 0) await UserManager.addWallet(interaction.user.id, payout);
      const fe = await UserManager.getEconomy(interaction.user.id);
      return interaction.editReply({ components: [buildContainer(player, dealer, bet, fe.wallet, txt, false)] });
    }

    const gs = { player, dealer, deck, bet, userId: interaction.user.id };
    const btns = () => new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`bj_hit:${interaction.user.id}`).setLabel('Hit').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`bj_stand:${interaction.user.id}`).setLabel('Stand').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`bj_double:${interaction.user.id}`).setLabel('Double Down').setStyle(ButtonStyle.Danger).setDisabled(eco0.wallet < bet),
    );

    const msg = await interaction.editReply({ components: [buildContainer(player, dealer, bet, eco0.wallet, '**Your turn.** Hit or Stand?', true).addActionRowComponents(btns())] });
    const collector = (msg as { createMessageComponentCollector: (o: { filter: (i: { user: { id: string }; customId: string }) => boolean; time: number }) => { on: (e: string, cb: (i: { customId: string; update: (o: unknown) => Promise<void>; reply: (o: unknown) => Promise<void> }) => void) => void; stop: () => void } }).createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith('bj_'), time: 60_000,
    });

    const endGame = async (i: { update: (o: unknown) => Promise<void> }, fp: Card[], fd: Card[], action: string) => {
      collector.stop();
      const pv = handValue(fp), dv = handValue(fd);
      let payout = 0, resultMsg = '';
      if (action === 'bust') { resultMsg = `# Bust! You lose ${fmt.coins(gs.bet)}.`; }
      else if (dv > 21) { payout = gs.bet * 2; resultMsg = `# Dealer busts! You win ${fmt.coins(gs.bet)}!`; }
      else if (pv > dv) { payout = gs.bet * 2; resultMsg = `# You win ${fmt.coins(gs.bet)}!`; }
      else if (pv === dv) { payout = gs.bet; resultMsg = '# Push! Bet returned.'; }
      else { resultMsg = `# Dealer wins. You lose ${fmt.coins(gs.bet)}.`; }
      if (payout > 0) await UserManager.addWallet(gs.userId, payout);
      const won = payout > gs.bet;
      await UserManager.incrementStat(gs.userId, 'gamesPlayed');
      if (won) await UserManager.incrementStat(gs.userId, 'gamesWon');
      await gamblingDB.ensure(gs.userId, { blackjack: { wins: 0, losses: 0 } });
      if (won) await gamblingDB.add(`${gs.userId}.blackjack.wins`, 1); else await gamblingDB.add(`${gs.userId}.blackjack.losses`, 1);
      const fe = await UserManager.getEconomy(gs.userId);
      await i.update({ components: [buildContainer(fp, fd, gs.bet, fe.wallet, resultMsg, false)] });
    };

    const dealerPlay = (d: Card[], dk: Card[]) => { while (handValue(d) < config.gambling.blackjack.dealerStandsAt) d.push(dk.pop()!); return d; };

    collector.on('collect', async (i) => {
      const action = i.customId.split(':')[0];
      if (action === 'bj_hit') {
        gs.player.push(gs.deck.pop()!);
        if (handValue(gs.player) > 21) { await endGame(i, gs.player, gs.dealer, 'bust'); return; }
        const e2 = await UserManager.getEconomy(interaction.user.id);
        await i.update({ components: [buildContainer(gs.player, gs.dealer, gs.bet, e2.wallet, '**Hit or Stand?**', true).addActionRowComponents(btns())] });
      } else if (action === 'bj_stand') {
        await endGame(i, gs.player, dealerPlay([...gs.dealer], gs.deck), 'stand');
      } else if (action === 'bj_double') {
        const { wallet: w } = await UserManager.getBalance(gs.userId);
        if (w < gs.bet) { await i.reply({ ...CB.errorResponse('Insufficient Funds', 'Not enough to double down.'), ephemeral: true }); return; }
        await UserManager.addWallet(gs.userId, -gs.bet); gs.bet *= 2;
        gs.player.push(gs.deck.pop()!);
        if (handValue(gs.player) > 21) await endGame(i, gs.player, gs.dealer, 'bust');
        else await endGame(i, gs.player, dealerPlay([...gs.dealer], gs.deck), 'stand');
      }
    });
    (collector as any).on('end', (_: any, reason: any) => {
      if (reason === 'time') interaction.editReply({ ...CB.errorResponse('Timed Out', 'Game expired. Your bet was forfeited.'), components: [] }).catch(() => {});
    });
  },
});
