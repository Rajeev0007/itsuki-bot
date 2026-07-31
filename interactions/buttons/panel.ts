/**
 * @file panel.ts
 * @description Buttons on the owner control panel.
 *
 * Every handler re-checks ownership independently. The panel is ephemeral, but
 * customIds are guessable, so authorisation cannot rest on "only the owner can
 * see the message" — it's verified against config.owners on every click.
 */

import {
  MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  type ButtonInteraction,
} from 'discord.js';
import { buildPanel, type PanelView } from '../../commands/owner/panel';
import PresenceManager from '../../managers/PresenceManager';
import MaintenanceManager from '../../managers/MaintenanceManager';
import { getStore } from '../../database/JsonStore';
import config from '../../config/config';
import logger from '../../utils/Logger';

export const customId = 'panel_:*';

const BACKUP_STORES = [
  'users', 'economy', 'inventory', 'pets', 'gambling', 'guilds', 'social',
  'actions', 'profiles', 'moderation', 'cards', 'auctions', 'stats', 'settings',
];

function isOwner(userId: string): boolean {
  return config.owners.includes(userId);
}

export async function execute(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(':');
  const action = parts[0];

  if (!isOwner(interaction.user.id)) {
    await interaction.reply({
      content: 'This panel is restricted to bot owners.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ownerId = interaction.user.id;

  // ── Modal: activity text ──────────────────────────────────────────────────
  // Shown BEFORE any defer — a modal is itself the initial response, so
  // deferring first would make showModal fail.
  if (action === 'panel_settext') {
    const current = PresenceManager.getState();
    const modal = new ModalBuilder()
      .setCustomId(`panel_presence_modal:${ownerId}`)
      .setTitle('Set Activity Text')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('activity_name')
            .setLabel('Activity text')
            .setPlaceholder('e.g. with 50,000 users')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(128)
            .setRequired(true)
            .setValue(current.activityName.slice(0, 128)),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('stream_url')
            .setLabel('Stream URL (only for Streaming type)')
            .setPlaceholder('https://twitch.tv/…')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(current.streamUrl ?? ''),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  await interaction.deferUpdate();

  // ── Resume rotation ───────────────────────────────────────────────────────
  if (action === 'panel_rotate') {
    await PresenceManager.setRotate();
    await interaction.editReply(buildPanel('presence', ownerId, interaction.client) as never);
    return;
  }

  // ── Maintenance toggle ────────────────────────────────────────────────────
  if (action === 'panel_maint') {
    const desired = parts[1];
    if (desired === 'on') await MaintenanceManager.enable('Toggled from the owner panel', ownerId);
    else                  await MaintenanceManager.disable();
    logger.info(`[Panel] Maintenance ${desired} by ${interaction.user.tag}`);
    await interaction.editReply(buildPanel('system', ownerId, interaction.client) as never);
    return;
  }

  // ── Force a database backup ───────────────────────────────────────────────
  if (action === 'panel_backup') {
    let ok = 0, failed = 0;
    for (const name of BACKUP_STORES) {
      try { await getStore(name).backup(); ok++; }
      catch { failed++; }
    }
    logger.info(`[Panel] Manual backup by ${interaction.user.tag}: ${ok} ok, ${failed} failed`);

    const panel = buildPanel('system', ownerId, interaction.client);
    await interaction.editReply(panel as never);
    // Reported separately so the panel itself stays a clean, stable view.
    await interaction.followUp({
      content: `Backup complete — ${ok} store(s) saved${failed ? `, ${failed} failed` : ''}.`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return;
  }

  // ── Refresh a view ────────────────────────────────────────────────────────
  if (action === 'panel_refresh') {
    const view = (parts[1] ?? 'home') as PanelView;
    await interaction.editReply(buildPanel(view, ownerId, interaction.client) as never);
    return;
  }
}
