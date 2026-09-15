/**
 * @file cards.ts
 * @description Pagination and sorting for /collection.
 *
 * The card-claim button is deliberately NOT handled here — it's owned by a
 * per-message collector in /roll, which is what lets the claim race resolve
 * against that specific rolled card.
 */

import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { buildCollectionPage } from '../../commands/cards/collection';
import type { Rarity } from '../../services/CardService';

export const customId = 'card_page:*';

export async function execute(interaction: ButtonInteraction): Promise<void> {
  // card_page:<ownerId>:<page>:<sort>:<rarity>
  const [, ownerId, pageRaw, sortRaw, rarityRaw] = interaction.customId.split(':');

  const page = Number(pageRaw);
  if (!Number.isInteger(page) || page < 1) {
    await interaction.reply({ content: 'That page button is malformed.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();

  // Anyone may page through a public collection; buildCollectionPage always
  // reads the OWNER's cards, so this can't leak another user's collection.
  const owner = await interaction.client.users.fetch(ownerId).catch(() => null);

  const payload = await buildCollectionPage({
    userId: ownerId,
    username: owner?.username ?? 'Unknown user',
    page,
    sort: (sortRaw as never) ?? 'power',
    rarity: (rarityRaw as Rarity | 'all') ?? 'all',
  });

  await interaction.editReply(payload as never);
}
