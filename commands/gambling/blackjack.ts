import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
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
const COLLECTOR_MS = 60_000;

interface Card { suit: string; val: string }

function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (const val of CARD_VALUES) deck.push({ suit, val });
  // Fisher-Yates — `sort(() => Math.random() - 0.5)` is a biased shuffle.
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function cardValue(c: Card): number { if (['J','Q','K'].includes(c.val)) return 10; if (c.val === 'A') return 11; return parseInt(c.val); }
function handValue(hand: Card[]): number { let t = hand.reduce((s, c) => s + cardValue(c), 0); let aces = hand.filter(c => c.val === 'A').length; while (t > 21 && aces > 0) { t -= 10; aces--; } return t; }
function renderHand(hand: Card[]): string { return hand.map(c => `${c.val}${c.suit}`).join(' '); }

function buildContainer(pHand: Card[], dHand: Card[], bet: number, wallet: number, status: string, hideDealer = false): ContainerBuilder {
  const pv = handValue(pHand);
  const dCards = hideDealer ? [`${dHand[0].val}${dHand[0].suit}`, '??'] : dHand.map(c => `${c.val}${c.suit}`);
  const dv = hideDealer ? cardValue(dHand[0]) : handValue(dHand);
  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([`# ${E.CARDS} Blackjack`, status].join('\n')))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      `**Dealer** — ${hideDealer ? `${dv}+?` : dv}`, `> ${dCards.join(' ')}`, '',
      `**You** — **${pv}** ${pv > 21 ? '· BUST' : pv === 21 ? '· 21!' : ''}`, `> ${renderHand(pHand)}`, '',
      `${E.COINS} **Bet:** ${fmt.coins(bet)} • ${E.WALLET} **Wallet:** ${fmt.coins(wallet)}`,
    ].join('\n')));
}

/** Records stats/history for a finished hand. `payout` is the gross return. */
async function recordResult(userId: string, payout: number, bet: number): Promise<void> {
  const won = payout > bet;
  await UserManager.incrementStat(userId, 'gamesPlayed');
  if (won) await UserManager.incrementStat(userId, 'gamesWon');
  await UserManager.recordTransaction(
    userId, won ? 'gambling_win' : 'gambling_loss', payout - bet, 'Blackjack',
  );
  await gamblingDB.ensure(userId, { blackjack: { wins: 0, losses: 0 } });
  if (won) await gamblingDB.add(`${userId}.blackjack.wins`, 1);
  else     await gamblingDB.add(`${userId}.blackjack.losses`, 1);
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('blackjack').setDescription('Play a game of blackjack against the dealer.')
    .addStringOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true)),
  category: 'gambling',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const rawBet = interaction.options.getString('bet');
    if (!rawBet)
      return interaction.editReply({ ...CB.errorResponse('Missing Bet', 'Tell me how much to bet, e.g. `500`, `10k`, `half` or `all`.') } as never);

    const bet0 = fmt.parseAmount(rawBet, wallet);
    if (!bet0 || bet0 < config.gambling.minBet || bet0 > config.gambling.maxBet)
      return interaction.editReply({ ...CB.errorResponse('Invalid Bet', `Bet between ${fmt.coins(config.gambling.minBet)} and ${fmt.coins(config.gambling.maxBet)}.`) } as never);
    if (bet0 > wallet)
      return interaction.editReply({ ...CB.errorResponse('Broke', `You only have ${fmt.coins(wallet)}.`) } as never);

    const deck = buildDeck();
    const player = [deck.pop()!, deck.pop()!];
    const dealer = [deck.pop()!, deck.pop()!];
    await UserManager.addWallet(interaction.user.id, -bet0);
    const eco0 = await UserManager.getEconomy(interaction.user.id);

    // ── Naturals ────────────────────────────────────────────────────────────
    const pBJ = handValue(player) === 21, dBJ = handValue(dealer) === 21;
    if (pBJ || dBJ) {
      let payout = 0, txt = '';
      if (pBJ && dBJ) { payout = bet0; txt = '# Both have Blackjack — Push!'; }
      else if (pBJ) {
        payout = Math.floor(bet0 * (1 + config.gambling.blackjack.blackjackPayout));
        txt = `# Blackjack! You win ${fmt.coins(payout - bet0)}!`;
      } else {
        txt = `# Dealer has Blackjack. You lose ${fmt.coins(bet0)}.`;
      }
      if (payout > 0) await UserManager.addWallet(interaction.user.id, payout);
      // These hands used to skip stat tracking entirely, so an instant
      // blackjack never counted as a game played or won.
      await recordResult(interaction.user.id, payout, bet0);
      const fe = await UserManager.getEconomy(interaction.user.id);
      return interaction.editReply({ components: [buildContainer(player, dealer, bet0, fe.wallet, txt, false)] });
    }

    const gs = { player, dealer, deck, bet: bet0, userId: interaction.user.id };
    let settled = false;

    const btns = (walletNow: number) => new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`bj_hit:${interaction.user.id}`).setLabel('Hit').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`bj_stand:${interaction.user.id}`).setLabel('Stand').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`bj_double:${interaction.user.id}`).setLabel('Double Down').setStyle(ButtonStyle.Danger)
        // Recomputed every render — a stale snapshot from deal time left the
        // button enabled (or disabled) incorrectly after a hit.
        .setDisabled(walletNow < gs.bet || gs.player.length > 2),
    );

    const msg = await interaction.editReply({
      components: [buildContainer(player, dealer, bet0, eco0.wallet, '**Your turn.** Hit or Stand?', true)
        .addActionRowComponents(btns(eco0.wallet))],
    });

    const collector = (msg as unknown as {
      createMessageComponentCollector: (o: { filter: (i: { user: { id: string }; customId: string }) => boolean; time: number }) =>
        { on: (e: string, cb: (...a: never[]) => void) => void; stop: (r?: string) => void };
    }).createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith('bj_'), time: COLLECTOR_MS,
    });

    const dealerPlay = (d: Card[], dk: Card[]) => {
      while (handValue(d) < config.gambling.blackjack.dealerStandsAt && dk.length > 0) d.push(dk.pop()!);
      return d;
    };

    /**
     * Settles the hand. `render` lets the same code path finish the game from a
     * button click (i.update) or from the timeout handler (editReply).
     */
    const endGame = async (
      render: (payload: { components: ContainerBuilder[] }) => Promise<unknown>,
      fp: Card[], fd: Card[], action: 'bust' | 'stand',
      note = '',
    ) => {
      if (settled) return;
      settled = true;
      collector.stop('settled');

      const pv = handValue(fp), dv = handValue(fd);
      let payout = 0, resultMsg = '';
      if (action === 'bust')   { resultMsg = `# Bust! You lose ${fmt.coins(gs.bet)}.`; }
      else if (dv > 21)        { payout = gs.bet * 2; resultMsg = `# Dealer busts! You win ${fmt.coins(gs.bet)}!`; }
      else if (pv > dv)        { payout = gs.bet * 2; resultMsg = `# You win ${fmt.coins(gs.bet)}!`; }
      else if (pv === dv)      { payout = gs.bet;     resultMsg = '# Push! Bet returned.'; }
      else                     { resultMsg = `# Dealer wins. You lose ${fmt.coins(gs.bet)}.`; }
      if (note) resultMsg += `\n${note}`;

      if (payout > 0) await UserManager.addWallet(gs.userId, payout);
      await recordResult(gs.userId, payout, gs.bet);

      const fe = await UserManager.getEconomy(gs.userId);
      await render({ components: [buildContainer(fp, fd, gs.bet, fe.wallet, resultMsg, false)] });
    };

    collector.on('collect', async (i: {
      customId: string;
      update: (o: unknown) => Promise<void>;
      reply: (o: unknown) => Promise<void>;
    }) => {
      if (settled) return;
      const action = i.customId.split(':')[0];

      if (action === 'bj_hit') {
        gs.player.push(gs.deck.pop()!);
        if (handValue(gs.player) > 21) { await endGame((p) => i.update(p), gs.player, gs.dealer, 'bust'); return; }
        const e2 = await UserManager.getEconomy(gs.userId);
        await i.update({
          components: [buildContainer(gs.player, gs.dealer, gs.bet, e2.wallet, '**Hit or Stand?**', true)
            .addActionRowComponents(btns(e2.wallet))],
        });
        return;
      }

      if (action === 'bj_stand') {
        await endGame((p) => i.update(p), gs.player, dealerPlay([...gs.dealer], gs.deck), 'stand');
        return;
      }

      if (action === 'bj_double') {
        const { wallet: w } = await UserManager.getBalance(gs.userId);
        if (w < gs.bet) {
          await i.reply({ ...CB.errorResponse('Insufficient Funds', 'Not enough to double down.'), flags: MessageFlags.Ephemeral });
          return;
        }
        await UserManager.addWallet(gs.userId, -gs.bet);
        gs.bet *= 2;
        gs.player.push(gs.deck.pop()!);
        if (handValue(gs.player) > 21) await endGame((p) => i.update(p), gs.player, gs.dealer, 'bust');
        else await endGame((p) => i.update(p), gs.player, dealerPlay([...gs.dealer], gs.deck), 'stand');
      }
    });

    collector.on('end', async (_c: unknown, reason: string) => {
      // An abandoned hand is auto-stood rather than forfeited. Simply keeping
      // the bet punished connection drops and, worse, let a player walk away
      // from a bad hand knowing the loss was identical either way.
      if (reason === 'time' && !settled) {
        await endGame(
          (p) => interaction.editReply(p as never).then(() => undefined),
          gs.player, dealerPlay([...gs.dealer], gs.deck), 'stand',
          '-# Timed out — your hand was automatically stood.',
        ).catch(() => {});
      }
    });
  },
});
