/**
 * @file panelPresence.ts
 * @description Handles the "Set Activity Text" modal from the owner panel.
 *
 * Submitting text switches presence into custom mode, which stops the rotation
 * from overwriting it on the next tick.
 */

import { MessageFlags, type ModalSubmitInteraction } from 'discord.js';
import { buildPanel } from '../../commands/owner/panel';
import PresenceManager from '../../managers/PresenceManager';
import config from '../../config/config';
import logger from '../../utils/Logger';

export const customId = 'panel_presence_modal:*';

/** Discord only accepts a stream URL from these hosts. */
const STREAM_URL_RE = /^https?:\/\/(www\.)?(twitch\.tv|youtube\.com|youtu\.be)\/.+/i;

export async function execute(interaction: ModalSubmitInteraction): Promise<void> {
  if (!config.owners.includes(interaction.user.id)) {
    await interaction.reply({
      content: 'This panel is restricted to bot owners.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const name = interaction.fields.getTextInputValue('activity_name')?.trim() ?? '';
  const rawUrl = interaction.fields.getTextInputValue('stream_url')?.trim() ?? '';

  if (!name) {
    await interaction.reply({
      content: 'Activity text cannot be empty.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const state = PresenceManager.getState();

  // Discord silently drops a Streaming activity whose URL isn't Twitch/YouTube,
  // which looks like "the panel did nothing". Reject it up front instead.
  if (state.activityType === 'streaming') {
    if (!rawUrl) {
      await interaction.reply({
        content: 'The **Streaming** activity type needs a Twitch or YouTube URL. Add one in the second field, or pick a different activity type.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!STREAM_URL_RE.test(rawUrl)) {
      await interaction.reply({
        content: 'Discord only accepts Twitch or YouTube URLs for the Streaming status.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  await interaction.deferUpdate();

  await PresenceManager.setCustom({
    activityName: name,
    streamUrl: rawUrl || null,
  });
  logger.info(`[Panel] Presence set to "${name}" by ${interaction.user.tag}`);

  await interaction.editReply(
    buildPanel('presence', interaction.user.id, interaction.client) as never,
  );
}
