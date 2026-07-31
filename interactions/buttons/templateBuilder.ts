/**
 * @file templateBuilder.ts
 * @description Buttons for the message builder panel (`tb_*`).
 *
 * Every action loads the session first, which also enforces that the presser is
 * the person who opened the builder — the panel is ephemeral, but an ephemeral
 * message is not an authorisation boundary.
 */

import {
  MessageFlags, ContainerBuilder, TextDisplayBuilder,
  type ButtonInteraction,
} from 'discord.js';
import {
  getSession, buildModal, refresh, commitSession, closeSession,
  syncPreview, discardPreview,
} from '../../services/TemplateBuilderUI';
import { emptyTemplate } from '../../services/MessageTemplate';
import * as CB from '../../builders/ComponentBuilder';
import logger from '../../utils/Logger';

export const customId = 'tb_:*';

export async function execute(interaction: ButtonInteraction): Promise<void> {
  const [action, sid] = interaction.customId.split(':');

  const { session, reason } = getSession(sid ?? '', interaction.user.id);
  if (!session) {
    await interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });
    return;
  }

  // ── Modal openers ───────────────────────────────────────────────────────
  // A modal must be the FIRST response to the interaction, so these return
  // before any defer/update happens.
  const MODAL_GROUPS: Record<string, string> = {
    tb_open_text: 'text',
    tb_open_media: 'media',
    tb_open_trim: 'trim',
    tb_open_field: 'field',
    tb_open_button: 'button',
  };
  if (action in MODAL_GROUPS) {
    const modal = buildModal(MODAL_GROUPS[action], session);
    if (!modal) {
      await interaction.reply({ content: 'That editor is unavailable.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(modal);
    return;
  }

  // ── Live preview toggle ─────────────────────────────────────────────────
  if (action === 'tb_live') {
    session.livePreview = !session.livePreview;
    // Turning it off removes the tracked preview so no stale copy is left
    // behind claiming to be current.
    if (!session.livePreview) await discardPreview(interaction, session);
    await refresh(interaction, session);
    return;
  }

  // ── Re-post the preview ─────────────────────────────────────────────────
  // Posts it again at the bottom rather than editing in place, so it is
  // findable after being dismissed or scrolled past.
  if (action === 'tb_preview') {
    await interaction.deferUpdate();
    await syncPreview(interaction, session, { force: true });
    return;
  }

  // ── Toggles ─────────────────────────────────────────────────────────────
  if (action === 'tb_style') {
    // Only the style key flips; all content is preserved.
    session.template.style = session.template.style === 'v2' ? 'embed' : 'v2';
    await refresh(interaction, session);
    return;
  }

  if (action === 'tb_timestamp') {
    session.template.timestamp = !session.template.timestamp;
    await refresh(interaction, session);
    return;
  }

  if (action === 'tb_dividers') {
    session.template.separators = session.template.separators === false;
    await refresh(interaction, session);
    return;
  }

  if (action === 'tb_reset') {
    // Style is deliberately kept — resetting content should not also undo the
    // style the user picked.
    session.template = emptyTemplate(session.template.style);
    await refresh(interaction, session);
    return;
  }

  // ── Close ───────────────────────────────────────────────────────────────
  if (action === 'tb_close') {
    // Tidy the preview away before the session is dropped — afterwards we no
    // longer know which message to remove.
    await discardPreview(interaction, session);
    closeSession(sid);
    await interaction.update({
      components: [new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([
          '# Builder closed',
          'Unsaved changes were discarded. Anything you pressed **Save** on is still stored.',
        ].join('\n')),
      )],
      flags: MessageFlags.IsComponentsV2,
    } as never);
    return;
  }

  // ── Save / Send ─────────────────────────────────────────────────────────
  if (action === 'tb_save') {
    await interaction.deferUpdate();
    try {
      const result = await commitSession(session, interaction);
      if (result.ok) {
        await discardPreview(interaction, session);
        closeSession(sid);
      }
      await interaction.editReply({
        ...(result.ok
          ? CB.successResponse(result.title, result.message)
          : CB.errorResponse(result.title, result.message)),
      } as never);
    } catch (err) {
      logger.error(`[Builder] Save failed: ${(err as Error).message}`);
      await interaction.editReply({
        ...CB.errorResponse('Save Failed', `${(err as Error).message}\n-# Your session is still open — try again.`),
      } as never).catch(() => null);
    }
    return;
  }

  await interaction.reply({ content: 'Unknown builder action.', flags: MessageFlags.Ephemeral });
}
