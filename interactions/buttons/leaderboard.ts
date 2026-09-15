/**
 * @file leaderboard.ts
 * @description Pagination buttons for /leaderboard.
 */

import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { buildLeaderboardPage } from '../../commands/leaderboard/leaderboard';

export const customId = 'lb_page:*';

export async function execute(interaction: ButtonInteraction): Promise<void> {
  // lb_page:<boardId>:<page>:<viewerId>
  const [, boardId, pageRaw, viewerId] = interaction.customId.split(':');

  const page = Number(pageRaw);
  if (!Number.isInteger(page) || page < 1) {
    await interaction.reply({ content: 'That page button is malformed.', flags: MessageFlags.Ephemeral });
    return;
  }

  // These buttons EDIT the original message, so only the person who ran the
  // command may drive it — otherwise anyone could page someone else's view.
  if (viewerId && viewerId !== interaction.user.id) {
    await interaction.reply({
      content: 'Run `/leaderboard` yourself to browse it.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  const payload = await buildLeaderboardPage({
    boardId, page,
    viewerId: interaction.user.id,
    guild: interaction.guild,
    client: interaction.client,
  });

  await interaction.editReply(payload as never);
}
