/**
 * @file leaderboardSelect.ts
 * @description The "choose a leaderboard" select menu on /leaderboard.
 */

import { MessageFlags, type StringSelectMenuInteraction } from 'discord.js';
import { buildLeaderboardPage } from '../../commands/leaderboard/leaderboard';

export const customId = 'lb_select:*';

export async function execute(interaction: StringSelectMenuInteraction): Promise<void> {
  // lb_select:<viewerId>
  const [, viewerId] = interaction.customId.split(':');
  const chosen = interaction.values?.[0];

  if (!chosen) {
    await interaction.reply({ content: 'No leaderboard selected.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Same ownership rule as the pagination buttons — this edits the message.
  if (viewerId && viewerId !== interaction.user.id) {
    await interaction.reply({
      content: 'Run `/leaderboard` yourself to browse it.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  const payload = await buildLeaderboardPage({
    boardId: chosen,
    // Switching boards always starts at page 1.
    page: 1,
    viewerId: interaction.user.id,
    guild: interaction.guild,
    client: interaction.client,
  });

  await interaction.editReply(payload as never);
}
