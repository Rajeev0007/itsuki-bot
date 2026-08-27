/**
 * @file botInfo.ts
 * @description The section select menu on the /stats panel.
 *
 * A globally registered handler rather than a per-message collector: a collector
 * dies with the process, so every panel posted before a restart would answer
 * clicks with "This interaction failed" for the rest of the message's life.
 *
 * Someone other than the person who ran /stats is NOT refused — they get their own
 * ephemeral copy of the section they asked for. Editing the shared message on
 * their behalf would yank the page out from under the original viewer, and a bare
 * "this isn't yours" is a dead end for what is public information.
 */

import { MessageFlags, type StringSelectMenuInteraction } from 'discord.js';
import { renderPanel, asPage } from '../../services/BotInfoPanel';
import logger from '../../utils/Logger';

export const customId = 'binfo_select:*';

export async function execute(interaction: StringSelectMenuInteraction): Promise<void> {
  // binfo_select:<viewerId>
  const viewerId = interaction.customId.split(':')[1] ?? '';
  const page = asPage(interaction.values?.[0]);
  const isOwner = viewerId === interaction.user.id;

  try {
    if (isOwner) {
      // deferUpdate first: collectSnapshot touches the database, which can exceed
      // the 3-second window Discord allows for acknowledging a component.
      await interaction.deferUpdate();
      const payload = await renderPanel(interaction.client, page, interaction.user.id);
      await interaction.editReply(payload as never);
      return;
    }

    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });
    // Rendered against the clicker's id so their private copy is theirs to drive.
    const payload = await renderPanel(interaction.client, page, interaction.user.id);
    await interaction.editReply(payload as never);
  } catch (err) {
    // Already acknowledged above, so the only thing left is to say so — and never
    // to let this reject inside the handler.
    logger.warn(`[botinfo] Section switch failed: ${(err as Error).message}`);
    await interaction.followUp({
      content: 'Could not load that section — try again in a moment.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
}
