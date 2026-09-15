/**
 * @file record.ts
 * @description Consent / withdraw buttons on the recording notice.
 *
 * Consent is per-session and never persisted: a new recording always requires
 * fresh opt-in, so nobody is silently recorded on the strength of an agreement
 * they gave weeks ago.
 */

import { MessageFlags, type ButtonInteraction } from 'discord.js';
import RecordingManager from '../../managers/RecordingManager';
import { buildConsentPanel } from '../../commands/utility/record';
import logger from '../../utils/Logger';

export const customId = 'record_:*';

export async function execute(interaction: ButtonInteraction): Promise<void> {
  const [action, guildId] = interaction.customId.split(':');

  if (!interaction.guild || interaction.guild.id !== guildId) {
    await interaction.reply({
      content: 'That button belongs to a different server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = RecordingManager.get(guildId);
  if (!session) {
    await interaction.reply({
      content: 'That recording has already finished.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ── Withdraw ──────────────────────────────────────────────────────────────
  if (action === 'record_revoke') {
    const removed = RecordingManager.revoke(guildId, interaction.user.id);
    await interaction.reply({
      content: removed
        ? '✅ Consent withdrawn — nothing further from you will be recorded.\n-# Audio already captured before now remains in this recording.'
        : 'You had not opted in, so nothing of yours is being recorded.',
      flags: MessageFlags.Ephemeral,
    });
    if (removed) await refreshPanel(interaction, session);
    return;
  }

  // ── Consent ───────────────────────────────────────────────────────────────
  // Requiring presence in the recorded channel stops someone consenting on
  // behalf of a conversation they aren't part of.
  const inChannel = RecordingManager.humanListeners(interaction.guild, session.channelId)
    .some((m) => m.id === interaction.user.id);
  if (!inChannel) {
    await interaction.reply({
      content: `You need to be in <#${session.channelId}> to consent to that recording.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const added = RecordingManager.consent(guildId, interaction.user.id);
  await interaction.reply({
    content: added
      ? '🎙️ Thanks — your audio will be included from now on. Press **Withdraw** to stop at any time.'
      : 'You have already opted in.',
    flags: MessageFlags.Ephemeral,
  });

  if (added) {
    logger.debug(`[Record] ${interaction.user.tag} consented in ${guildId}`);
    await refreshPanel(interaction, session);
  }
}

/** Keeps the opted-in counter on the public notice current. */
async function refreshPanel(
  interaction: ButtonInteraction,
  session: { channelName: string; maxDurationMs: number; consented: Set<string> },
): Promise<void> {
  try {
    await interaction.message.edit({
      components: [buildConsentPanel(
        interaction.guild!.id,
        session.channelName,
        Math.round(session.maxDurationMs / 60_000),
        session.consented.size,
      )],
      flags: MessageFlags.IsComponentsV2,
    } as never);
  } catch (err) {
    // Cosmetic only — never surface this as a consent failure.
    logger.debug(`[Record] Panel refresh failed: ${(err as Error).message}`);
  }
}
