/**
 * @file backup.ts
 * @description Confirm / cancel buttons for a backup restore.
 *
 * The pending restore is single-use and bound to the user who requested it, so a
 * leaked customId cannot be replayed by someone else or fired twice.
 */

import {
  MessageFlags, PermissionFlagsBits, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize,
  type ButtonInteraction,
} from 'discord.js';
import BackupManager from '../../managers/BackupManager';
import { takePending } from '../../commands/moderation/backup';
import * as CB from '../../builders/ComponentBuilder';
import logger from '../../utils/Logger';

export const customId = 'backup_:*';

export async function execute(interaction: ButtonInteraction): Promise<void> {
  const [action, guildId, token] = interaction.customId.split(':');

  if (!interaction.guild || interaction.guild.id !== guildId) {
    await interaction.reply({ content: 'That button is for another server.', flags: MessageFlags.Ephemeral });
    return;
  }
  // Re-check rather than trusting that only an admin could see the message.
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'You need Administrator to do that.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'backup_cancel') {
    // Consume the token so the confirm button can't be pressed afterwards.
    takePending(guildId, token, interaction.user.id);
    await interaction.update({
      ...CB.successResponse('Cancelled', 'Nothing was changed.'),
    } as never);
    return;
  }

  const request = takePending(guildId, token, interaction.user.id);
  if (!request) {
    await interaction.update({
      ...CB.errorResponse(
        'Expired',
        'That confirmation is no longer valid — it expires after 2 minutes, is single-use, and only works for the person who ran the command. Run `/backup load` again.',
      ),
    } as never);
    return;
  }

  const backup = await BackupManager.get(guildId, request.backupId);
  if (!backup) {
    await interaction.update({
      ...CB.errorResponse('Backup Missing', 'That backup was deleted before the restore started.'),
    } as never);
    return;
  }

  // A restore takes minutes, well past the 15-minute interaction token window
  // for follow-ups but far past the 3-second ack window — so acknowledge now
  // and report progress by editing.
  await interaction.update({
    components: [new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        '# ⏳ Restoring…',
        `**${backup.name}** is being applied to this server.`,
        '-# Creation is rate limited, so this takes a while. Do not run it again.',
      ].join('\n')),
    )],
  } as never);

  try {
    const report = await BackupManager.restore(interaction.guild, backup, request.options);

    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        '# ✅ Restore Complete',
        `**${backup.name}** has been applied.`,
      ].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `**Roles created:** ${report.rolesCreated}`,
        `**Channels created:** ${report.channelsCreated}`,
        report.emojisCreated ? `**Emojis added:** ${report.emojisCreated}` : '',
        report.bansRestored ? `**Bans restored:** ${report.bansRestored}` : '',
        report.deleted ? `**Deleted first:** ${report.deleted}` : '',
        `**Settings applied:** ${report.settingsApplied ? 'yes' : 'no'}`,
      ].filter(Boolean).join('\n')));

    if (report.warnings.length) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          [`**${report.warnings.length} warning(s)**`, ...report.warnings.slice(0, 8).map((w) => `> ${w}`)]
            .join('\n').slice(0, 1800),
        ));
    }

    // editReply targets the same ephemeral message the button was on.
    await interaction.editReply({ components: [container] } as never);
  } catch (err) {
    logger.error(`[Backup] Restore failed in ${guildId}: ${(err as Error).message}`);
    await interaction.editReply({
      ...CB.errorResponse(
        'Restore Failed',
        `${(err as Error).message}\n-# Anything already created has been left in place — re-running in merge mode will fill the gaps.`,
      ),
    } as never).catch(() => { /* token may have expired */ });
  }
}
