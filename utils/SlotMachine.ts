/**
 * @file SlotMachine.ts
 * @description Shared slot-machine engine used by both `/slots` and the
 * "Spin Again" button.
 *
 * These two code paths used to carry byte-identical copies of the spin, payout
 * and settlement logic, which is how they ended up sharing the same bug: a
 * two-symbol match pays `twoMatch` (0.5x) — i.e. HALF the stake back — yet it
 * was reported as "Winner!", counted towards the `gamesWon` stat and towards
 * the "High Roller" achievement, even though the player lost money on it.
 *
 * A spin is only a win when the payout actually exceeds the stake.
 */

import {
  ContainerBuilder, SectionBuilder, TextDisplayBuilder, SeparatorBuilder,
  SeparatorSpacingSize, ThumbnailBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import UserManager from '../managers/UserManager';
import fmt from './Formatter';
import config from '../config/config';
import { EMOJI as E } from './Constants';
import { getStore } from '../database/JsonStore';

const gamblingDB = getStore('gambling');

/** win = ahead on the spin · refund = paid out but still down · loss = nothing. */
export type SlotOutcome = 'win' | 'refund' | 'loss';

export function spin(): string[] {
  const { symbols, weights } = config.gambling.slots;
  return [
    fmt.weightedRandom([...symbols], weights),
    fmt.weightedRandom([...symbols], weights),
    fmt.weightedRandom([...symbols], weights),
  ];
}

export function calcPayout(reels: string[], bet: number): number {
  const key = reels.join('');
  const payouts = config.gambling.slots.payouts;
  if (payouts[key]) return Math.floor(bet * payouts[key]);
  if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2])
    return Math.floor(bet * config.gambling.slots.twoMatch);
  return 0;
}

export function outcomeOf(payout: number, bet: number): SlotOutcome {
  if (payout > bet) return 'win';
  if (payout > 0) return 'refund';
  return 'loss';
}

/** Intermediate "reels are spinning" frame. */
export function spinFrame(r1: string, r2: string, r3: string, status: string) {
  return {
    components: [
      new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`# ${status}\n\`\`\`\n ${r1} ${r2} ${r3} \n\`\`\``),
      ),
    ],
  };
}

/** A placeholder reel used while the spin animates. */
export function randomSymbol(): string {
  const { symbols } = config.gambling.slots;
  return symbols[Math.floor(Math.random() * symbols.length)];
}

export interface SlotSettlement {
  payout: number;
  net: number;
  outcome: SlotOutcome;
  wallet: number;
}

/** Applies the result of a spin to the user's balance and stats. */
export async function settleSpin(userId: string, reels: string[], bet: number): Promise<SlotSettlement> {
  const payout = calcPayout(reels, bet);
  const net = payout - bet;
  const outcome = outcomeOf(payout, bet);

  await UserManager.addWallet(userId, net);
  await UserManager.incrementStat(userId, 'gamesPlayed');
  // Only a genuine profit counts as a win.
  if (outcome === 'win') await UserManager.incrementStat(userId, 'gamesWon');

  await UserManager.recordTransaction(
    userId, net > 0 ? 'gambling_win' : 'gambling_loss', net, 'Slots',
  );
  await gamblingDB.ensure(userId, { slots: { wins: 0, losses: 0 } });
  if (outcome === 'win') await gamblingDB.add(`${userId}.slots.wins`, 1);
  else                   await gamblingDB.add(`${userId}.slots.losses`, 1);

  const eco = await UserManager.getEconomy(userId);
  return { payout, net, outcome, wallet: eco.wallet };
}

/** Builds the final result message, including the "Spin Again" button. */
export function buildResult(opts: {
  userId: string;
  avatarUrl: string;
  reels: string[];
  bet: number;
  settlement: SlotSettlement;
}): ContainerBuilder {
  const { userId, avatarUrl, reels, bet, settlement } = opts;
  const { payout, net, outcome, wallet } = settlement;

  const heading =
    outcome === 'win'     ? `# ${E.WIN} Winner!`
    : outcome === 'refund' ? `# ${E.SLOTS} Two of a Kind`
    :                        `# ${E.LOSE} No Match`;

  const resultLine =
    outcome === 'win'
      ? `${E.WIN} **Payout:** ${fmt.coins(payout)} (${(payout / bet).toFixed(2)}x) — up ${fmt.coins(net)}`
      : outcome === 'refund'
        // Be explicit that a partial payout is still a net loss.
        ? `${E.SLOTS} **Partial payout:** ${fmt.coins(payout)} (${(payout / bet).toFixed(2)}x) — still down ${fmt.coins(-net)}`
        : `${E.LOSE} **Lost:** ${fmt.coins(bet)}`;

  const container = new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`${heading}\n\`\`\`\n ${reels[0]} ${reels[1]} ${reels[2]} \n\`\`\``),
        )
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl)),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      `${E.COINS} **Bet:** ${fmt.coins(bet)}`,
      resultLine,
      `${E.WALLET} **Wallet:** ${fmt.coins(wallet)}`,
    ].join('\n')));

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`slots_spin:${userId}:${bet}`)
        .setLabel('Spin Again')
        .setStyle(ButtonStyle.Primary),
    ),
  );

  return container;
}
