/**
 * @file confirm.ts
 * @description Handles generic confirm/cancel buttons.
 */

import { type ButtonInteraction } from 'discord.js';
import * as CB from '../../builders/ComponentBuilder';

export const customId = 'confirm_cancel';

export async function execute(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();
  // NOTE: do not spread the response and then override `components: []` —
  // that sends an empty component list, which Discord rejects. The cancelled
  // container IS the replacement content, so pass it through unchanged.
  await interaction.editReply(CB.errorResponse('Cancelled', 'Action was cancelled.'));
}
