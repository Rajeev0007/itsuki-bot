/**
 * @file cardSort.ts
 * @description Handles the sort select menu on /collection.
 */

import { MessageFlags, type StringSelectMenuInteraction } from 'discord.js';
import { buildCollectionPage } from '../../commands/cards/collection';
import type { Rarity } from '../../services/CardService';

export const customId = 'card_sort:*';

export async function execute(interaction: StringSelectMenuInteraction): Promise<void> {
  // card_sort:<ownerId>:<page>:<rarity>
  const [, ownerId, pageRaw, rarityRaw] = interaction.customId.split(':');
  const chosen = interaction.values?.[0];

  if (!chosen) {
    await interaction.reply({ content: 'No sort option received.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();

  const owner = await interaction.client.users.fetch(ownerId).catch(() => null);

  const payload = await buildCollectionPage({
    userId: ownerId,
    username: owner?.username ?? 'Unknown user',
    // Changing the sort returns to page 1 — staying on page 4 of a
    // re-ordered list would be meaningless.
    page: 1,
    sort: chosen as never,
    rarity: (rarityRaw as Rarity | 'all') ?? 'all',
  });

  await interaction.editReply(payload as never);
}
