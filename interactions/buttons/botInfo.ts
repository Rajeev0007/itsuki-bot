/**
 * @file botInfo.ts
 * @description The Refresh button on the /stats panel.
 *
 * The link buttons alongside it are ButtonStyle.Link — they carry a URL and no
 * customId, so Discord opens them client-side and they never reach this handler.
 * That is why they keep working after a restart, and why they must be validated
 * at build time instead: an unusable URL is rejected when the message is sent.
 */

import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { renderPanel, asPage } from '../../services/BotInfoPanel';
import logger from '../../utils/Logger';

export const customId = 'binfo_refresh:*';

export async function execute(interaction: ButtonInteraction): Promise<void> {
  // binfo_refresh:<viewerId>:<page>
  const [, viewerId = '', rawPage] = interaction.customId.split(':');
  const page = asPage(rawPage);
  const isOwner = viewerId === interaction.user.id;

  try {
    if (isOwner) {
      // Acknowledge before collecting: the snapshot reads the database, which can
      // outlast the 3-second component acknowledgement window.
      await interaction.deferUpdate();
      const payload = await renderPanel(interaction.client, page, interaction.user.id);
      await interaction.editReply(payload as never);
      return;
    }

    // Anyone else refreshing gets their own copy rather than being turned away —
    // editing the shared message would move it under the original viewer.
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });
    const payload = await renderPanel(interaction.client, page, interaction.user.id);
    await interaction.editReply(payload as never);
  } catch (err) {
    logger.warn(`[botinfo] Refresh failed: ${(err as Error).message}`);
    await interaction.followUp({
      content: 'Could not refresh right now — try again in a moment.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
}
