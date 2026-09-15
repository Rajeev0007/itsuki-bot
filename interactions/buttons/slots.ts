/**
 * @file slots.ts
 * @description Handles the "Spin Again" button from the /slots command.
 * All spin/payout/settlement logic is shared with the command itself via
 * utils/SlotMachine so the two can never drift apart again.
 */

import { MessageFlags, type ButtonInteraction } from 'discord.js';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import * as Slots from '../../utils/SlotMachine';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const customId = 'slots_spin:*';

export async function execute(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(':');
  const userId = parts[1];
  const bet = parseInt(parts[2], 10);

  if (userId !== interaction.user.id) {
    await interaction.reply({
      content: 'This button is not for you — run `/slots` to play your own spin.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!bet || bet < config.gambling.minBet || bet > config.gambling.maxBet) {
    await interaction.reply({
      ...CB.errorResponse('Invalid Bet', 'Something went wrong with the bet amount.'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  const { wallet } = await UserManager.getBalance(interaction.user.id);
  if (bet > wallet) {
    await interaction.followUp({
      ...CB.errorResponse('Insufficient Funds', `You only have ${fmt.coins(wallet)}.`),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

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
}
