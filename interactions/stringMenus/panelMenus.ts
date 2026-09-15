/**
 * @file panelMenus.ts
 * @description Select menus on the owner control panel: view navigation,
 * online status, and activity type.
 */

import { MessageFlags, type StringSelectMenuInteraction, type PresenceStatusData } from 'discord.js';
import { buildPanel, type PanelView } from '../../commands/owner/panel';
import PresenceManager, { ACTIVITY_TYPES, STATUS_CHOICES } from '../../managers/PresenceManager';
import config from '../../config/config';
import logger from '../../utils/Logger';

/**
 * Registered as the `panel_` prefix, not `panel_nav`.
 *
 * The router matches a wildcard key by stripping the trailing `:*` and testing
 * `startsWith`, so `panel_nav:*` would ONLY have matched navigation — the
 * status and activity-type menus would have gone unhandled.
 */
export const customId = 'panel_:*';

/** One module handles all three panel menus; dispatch on the real action. */
export async function execute(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!config.owners.includes(interaction.user.id)) {
    await interaction.reply({
      content: 'This panel is restricted to bot owners.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const action = interaction.customId.split(':')[0];
  const chosen = interaction.values?.[0];
  const ownerId = interaction.user.id;

  if (!chosen) {
    await interaction.reply({ content: 'Nothing selected.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();

  // ── Online status ─────────────────────────────────────────────────────────
  if (action === 'panel_status') {
    if (!STATUS_CHOICES.some((s) => s.id === chosen)) {
      await interaction.followUp({ content: `Unknown status \`${chosen}\`.`, flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    await PresenceManager.setStatus(chosen as PresenceStatusData);
    logger.info(`[Panel] Status set to ${chosen} by ${interaction.user.tag}`);
    await interaction.editReply(buildPanel('presence', ownerId, interaction.client) as never);
    return;
  }

  // ── Activity type ─────────────────────────────────────────────────────────
  if (action === 'panel_acttype') {
    if (!ACTIVITY_TYPES.some((t) => t.id === chosen)) {
      await interaction.followUp({ content: `Unknown activity type \`${chosen}\`.`, flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    // Choosing a type switches to custom mode, otherwise the rotation would
    // overwrite it on the next tick and the change would look ignored.
    const state = await PresenceManager.setCustom({ activityType: chosen });
    logger.info(`[Panel] Activity type set to ${chosen} by ${interaction.user.tag}`);

    await interaction.editReply(buildPanel('presence', ownerId, interaction.client) as never);

    // Nudge the owner when the type needs input it doesn't have yet.
    if (!state.activityName) {
      await interaction.followUp({
        content: 'Now set the activity text with the **Set activity text** button.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    } else if (chosen === 'streaming' && !state.streamUrl) {
      await interaction.followUp({
        content: '**Streaming** also needs a Twitch or YouTube URL — add one via **Set activity text**.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
    return;
  }

  // ── View navigation ───────────────────────────────────────────────────────
  await interaction.editReply(buildPanel(chosen as PanelView, ownerId, interaction.client) as never);
}
