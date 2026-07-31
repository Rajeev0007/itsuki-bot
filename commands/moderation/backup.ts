import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, AttachmentBuilder,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import BackupManager, {
  MAX_BACKUPS_PER_GUILD, type BackupData, type RestoreOptions,
} from '../../managers/BackupManager';
import { downloadMedia } from '../../services/SafeDownloader';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import { resolveDisplayName } from '../../utils/UserResolver';
import logger from '../../utils/Logger';

/**
 * Pending restores, keyed by `guildId:token`.
 *
 * Held in memory on purpose: a restore is destructive, so a confirmation must
 * not survive a restart and fire against a server whose state has since
 * changed. Entries expire after two minutes.
 */
interface PendingRestore { backupId: string; options: RestoreOptions; userId: string; expiresAt: number }
const pending = new Map<string, PendingRestore>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k);
}, 30_000).unref?.();

export function takePending(guildId: string, token: string, userId: string): PendingRestore | null {
  const key = `${guildId}:${token}`;
  const entry = pending.get(key);
  if (!entry) return null;
  // Single use, and only by the person who asked for it.
  if (entry.userId !== userId) return null;
  pending.delete(key);
  return entry.expiresAt > Date.now() ? entry : null;
}

function summariseBackup(b: BackupData): string {
  const categories = b.channels.filter((c) => c.type === 4).length;
  const overwrites = b.channels.reduce((n, c) => n + c.overwrites.length, 0);
  return [
    `**Server:** ${b.guildName}`,
    `**Roles:** ${b.roles.length}`,
    `**Channels:** ${b.channels.length} (${categories} categor${categories === 1 ? 'y' : 'ies'})`,
    `**Permission overwrites:** ${overwrites}`,
    `**Emojis:** ${b.emojis.length}`,
    `**Bans:** ${b.bans.length}`,
  ].join('\n');
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('backup').setDescription('Snapshot and restore this server\'s structure.')
    .addSubcommand((s) => s.setName('create').setDescription('Take a snapshot of this server')
      .addStringOption((o) => o.setName('name').setDescription('Label for this backup')))
    .addSubcommand((s) => s.setName('list').setDescription('Show saved backups'))
    .addSubcommand((s) => s.setName('info').setDescription('What a backup contains')
      .addStringOption((o) => o.setName('id').setDescription('Backup ID').setRequired(true)))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a backup')
      .addStringOption((o) => o.setName('id').setDescription('Backup ID').setRequired(true)))
    .addSubcommand((s) => s.setName('export').setDescription('Download a backup as JSON')
      .addStringOption((o) => o.setName('id').setDescription('Backup ID').setRequired(true)))
    .addSubcommand((s) => s.setName('import').setDescription('Upload a backup JSON file')
      .addAttachmentOption((o) => o.setName('file').setDescription('Backup JSON').setRequired(true)))
    .addSubcommand((s) => s.setName('load').setDescription('Restore a backup into this server')
      .addStringOption((o) => o.setName('id').setDescription('Backup ID').setRequired(true))
      .addStringOption((o) => o.setName('mode').setDescription('How to apply it')
        .addChoices(
          { name: 'Merge — add what is missing (safe)', value: 'merge' },
          { name: 'Replace — DELETE existing first (destructive)', value: 'replace' },
        ))
      .addBooleanOption((o) => o.setName('roles').setDescription('Restore roles (default: yes)'))
      .addBooleanOption((o) => o.setName('channels').setDescription('Restore channels (default: yes)'))
      .addBooleanOption((o) => o.setName('settings').setDescription('Restore server settings (default: yes)'))
      .addBooleanOption((o) => o.setName('emojis').setDescription('Restore emojis (default: no)'))
      .addBooleanOption((o) => o.setName('bans').setDescription('Restore bans (default: no)')))
    // Administrator, not just Manage Guild: a replace-mode restore can delete
    // every channel and role in the server.
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  category: 'moderation',
  guildOnly: true,
  permissions: ['Administrator'],
  cooldown: 10_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['create', 'list', 'info', 'delete', 'export', 'import', 'load'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const guild = interaction.guild!;

    // ── create ──────────────────────────────────────────────────────────────
    if (sub === 'create') {
      try {
        const backup = await BackupManager.create(
          guild, interaction.user.id, interaction.options.getString('name') ?? undefined,
        );
        return interaction.editReply({ ...CB.successResponse(
          'Backup Created',
          [
            `**\`${backup.id}\`** — ${backup.name}`,
            '',
            summariseBackup(backup),
            '',
            `-# Keeping the ${MAX_BACKUPS_PER_GUILD} most recent backups · restore with \`/backup load id:${backup.id}\``,
            '-# Messages are not included — they cannot be faithfully restored.',
          ].join('\n'),
        ) } as never);
      } catch (err) {
        logger.error(`[Backup] create failed for ${guild.id}: ${(err as Error).message}`);
        return interaction.editReply({ ...CB.errorResponse('Backup Failed', (err as Error).message) } as never);
      }
    }

    // ── list ────────────────────────────────────────────────────────────────
    if (sub === 'list') {
      const all = await BackupManager.list(guild.id);
      if (!all.length) {
        return interaction.editReply({ ...CB.successResponse(
          'No Backups', 'Nothing saved yet. Use `/backup create` to take a snapshot.',
        ) } as never);
      }

      const lines = await Promise.all(all.map(async (b) => {
        const who = await resolveDisplayName(b.createdBy, { guild, client: interaction.client });
        return [
          `**\`${b.id}\`** — ${b.name}`,
          `> ${b.roles.length} roles · ${b.channels.length} channels · ${b.emojis.length} emojis`,
          `> -# <t:${Math.floor(b.createdAt / 1000)}:R> by ${who}`,
        ].join('\n');
      }));

      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `# 💾 Backups\n**${all.length}** of ${MAX_BACKUPS_PER_GUILD} slots used`,
        ))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n\n')));
      return interaction.editReply({ components: [c] });
    }

    // ── info / delete / export ──────────────────────────────────────────────
    if (sub === 'info' || sub === 'delete' || sub === 'export') {
      const id = (interaction.options.getString('id') ?? '').trim();
      const backup = await BackupManager.get(guild.id, id);
      if (!backup) {
        return interaction.editReply({ ...CB.errorResponse(
          'Not Found', `No backup with ID \`${id}\`. Run \`/backup list\`.`,
        ) } as never);
      }

      if (sub === 'delete') {
        await BackupManager.remove(guild.id, id);
        return interaction.editReply({ ...CB.successResponse(
          'Backup Deleted', `Removed **${backup.name}** (\`${id}\`).`,
        ) } as never);
      }

      if (sub === 'export') {
        const json = Buffer.from(JSON.stringify(backup, null, 2), 'utf8');
        const limit = Math.max(10 * 1024 * 1024, guild.maximumUploadLimit ?? 0);
        if (json.length > limit - 128 * 1024) {
          return interaction.editReply({ ...CB.errorResponse(
            'Too Large', `That backup is ${(json.length / 1024 / 1024).toFixed(1)} MB, above this server's upload limit.`,
          ) } as never);
        }
        return interaction.editReply({
          components: [new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent([
              `### 💾 ${backup.name}`,
              `-# \`${backup.id}\` · ${(json.length / 1024).toFixed(0)} KB`,
              '-# Keep this file private — it contains your role permissions and ban list.',
            ].join('\n')),
          )],
          files: [new AttachmentBuilder(json, { name: `backup-${backup.id}.json` })],
        } as never);
      }

      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `# 💾 ${backup.name}`,
          `-# \`${backup.id}\` · created <t:${Math.floor(backup.createdAt / 1000)}:F>`,
        ].join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(summariseBackup(backup)))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '**Roles** (highest first)',
          backup.roles.filter((r) => !r.isEveryone).slice(0, 15)
            .map((r) => `> ${r.managed ? '🔒' : '•'} ${r.name}`).join('\n') || '> none',
          backup.roles.length > 16 ? `> -# +${backup.roles.length - 16} more` : '',
          '-# 🔒 = integration-managed, cannot be recreated',
        ].filter(Boolean).join('\n')));
      return interaction.editReply({ components: [c] });
    }

    // ── import ──────────────────────────────────────────────────────────────
    if (sub === 'import') {
      const attachment = interaction.options.getAttachment('file');
      if (!attachment) {
        return interaction.editReply({ ...CB.errorResponse('Missing File', 'Attach a backup JSON file.') } as never);
      }
      // 8 MB ceiling, and routed through SafeDownloader so the MIME allowlist
      // and size cap apply to the attachment CDN like any other host.
      let raw;
      try {
        raw = await downloadMedia(attachment.url, 8 * 1024 * 1024);
      } catch (err) {
        return interaction.editReply({ ...CB.errorResponse('Could Not Read File', (err as Error).message) } as never);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.buffer.toString('utf8'));
      } catch {
        return interaction.editReply({ ...CB.errorResponse('Invalid JSON', 'That file is not valid JSON.') } as never);
      }

      const check = BackupManager.validate(parsed);
      if (!check.ok || !check.data) {
        return interaction.editReply({ ...CB.errorResponse('Invalid Backup', check.reason ?? 'Unrecognised format.') } as never);
      }

      const adopted = await BackupManager.adopt(guild.id, check.data);
      return interaction.editReply({ ...CB.successResponse(
        'Backup Imported',
        [
          `**\`${adopted.id}\`** — ${adopted.name}`,
          '',
          summariseBackup(adopted),
          '',
          `-# Restore with \`/backup load id:${adopted.id}\``,
        ].join('\n'),
      ) } as never);
    }

    // ── load (confirmation gate) ────────────────────────────────────────────
    const id = (interaction.options.getString('id') ?? '').trim();
    const backup = await BackupManager.get(guild.id, id);
    if (!backup) {
      return interaction.editReply({ ...CB.errorResponse(
        'Not Found', `No backup with ID \`${id}\`. Run \`/backup list\`.`,
      ) } as never);
    }

    const options: RestoreOptions = {
      mode: (interaction.options.getString('mode') ?? 'merge') as 'merge' | 'replace',
      roles: interaction.options.getBoolean('roles') ?? true,
      channels: interaction.options.getBoolean('channels') ?? true,
      settings: interaction.options.getBoolean('settings') ?? true,
      // Off by default: both consume limited slots and can't be undone easily.
      emojis: interaction.options.getBoolean('emojis') ?? false,
      bans: interaction.options.getBoolean('bans') ?? false,
    };

    if (!options.roles && !options.channels && !options.settings && !options.emojis && !options.bans) {
      return interaction.editReply({ ...CB.errorResponse(
        'Nothing Selected', 'Every restore option was set to false, so there is nothing to do.',
      ) } as never);
    }

    // Only the guild owner may run a destructive replace. Administrator is
    // enough to add things; wiping every channel and role is not something a
    // second-tier admin should be able to do from a slash command.
    if (options.mode === 'replace' && interaction.user.id !== guild.ownerId) {
      return interaction.editReply({ ...CB.errorResponse(
        'Owner Only',
        'Replace mode **deletes every existing channel and role** before restoring, so only the server owner can run it.\nUse `mode: merge` to add missing items without deleting anything.',
      ) } as never);
    }

    const token = Math.random().toString(36).slice(2, 10);
    pending.set(`${guild.id}:${token}`, {
      backupId: backup.id, options, userId: interaction.user.id,
      expiresAt: Date.now() + 2 * 60_000,
    });

    const eta = BackupManager.estimateSeconds(backup, options);
    const selected = [
      options.roles && 'roles', options.channels && 'channels',
      options.settings && 'settings', options.emojis && 'emojis', options.bans && 'bans',
    ].filter(Boolean).join(', ');

    const confirm = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        options.mode === 'replace' ? '# ⚠️ Confirm Destructive Restore' : '# Confirm Restore',
        `**Backup:** ${backup.name} (\`${backup.id}\`)`,
        `**Mode:** ${options.mode === 'replace' ? '**REPLACE** — existing channels and roles will be **deleted** first' : 'Merge — nothing is deleted'}`,
        `**Restoring:** ${selected}`,
      ].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        summariseBackup(backup),
        '',
        `-# Estimated time: **~${fmt.duration(eta * 1000)}** (creation is rate limited).`,
        '-# Recreated roles get new IDs; overwrites are remapped automatically.',
        options.mode === 'replace' ? '\n**This cannot be undone.** Take a fresh `/backup create` first if unsure.' : '',
      ].filter(Boolean).join('\n')))
      .addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`backup_confirm:${guild.id}:${token}`)
            .setLabel(options.mode === 'replace' ? 'Delete and restore' : 'Restore')
            .setStyle(options.mode === 'replace' ? ButtonStyle.Danger : ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`backup_cancel:${guild.id}:${token}`)
            .setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        ),
      );

    return interaction.editReply({ components: [confirm] } as never);
  },
});
