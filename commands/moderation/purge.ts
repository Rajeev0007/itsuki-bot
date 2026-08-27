import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits,
  type ChatInputCommandInteraction, type TextChannel, type Message,
} from 'discord.js';
import { Command } from '../../structures/Command';
import ModerationManager from '../../managers/ModerationManager';
import * as CB from '../../builders/ComponentBuilder';

/**
 * Discord refuses to bulk-delete messages older than 14 days. Attempting it
 * fails the ENTIRE call, so older messages must be filtered out first —
 * otherwise `/purge` in a quiet channel just errors out with nothing deleted.
 */
const BULK_DELETE_MAX_AGE_MS = 14 * 86_400_000;

export default new Command({
  data: new SlashCommandBuilder()
    .setName('purge').setDescription('Bulk-delete recent messages in this channel.')
    .addIntegerOption((o) => o.setName('amount')
      .setDescription('How many messages to scan (1-100)')
      .setMinValue(1).setMaxValue(100).setRequired(true))
    .addUserOption((o) => o.setName('user').setDescription('Only delete messages from this user'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  category: 'moderation',
  guildOnly: true,
  permissions: ['ManageMessages'],

  async execute(interaction: ChatInputCommandInteraction) {
    // Ephemeral: a purge confirmation shouldn't linger in the channel it cleaned.
    await interaction.deferReply({ flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never });

    const amount = interaction.options.getInteger('amount') ?? 0;
    const onlyUser = interaction.options.getUser('user');
    const guild = interaction.guild!;

    const channel = interaction.channel as TextChannel | null;
    if (!channel || typeof channel.bulkDelete !== 'function') {
      return interaction.editReply({ ...CB.errorResponse('Unsupported Channel', 'I cannot bulk-delete messages in this channel type.') } as never);
    }

    // Checked on THIS channel, not guild-wide. Manage Messages is overwritable
    // per channel, so a guild-level check passed for a channel where the bot is
    // explicitly denied — and the failure then surfaced as a raw Discord
    // "Missing Permissions" string from the catch below.
    const me = guild.members.me;
    if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Missing Permission', `I need the **Manage Messages** permission in ${channel}.`,
      ) } as never);
    }

    let fetched;
    try {
      fetched = await channel.messages.fetch({ limit: amount });
    } catch (err) {
      return interaction.editReply({ ...CB.errorResponse('Fetch Failed', `Could not read the channel history: ${(err as Error).message}`) } as never);
    }

    const cutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;
    let tooOld = 0;
    let wrongUser = 0;

    const deletable = [...fetched.values()].filter((m: Message) => {
      if (onlyUser && m.author.id !== onlyUser.id) { wrongUser++; return false; }
      if (m.createdTimestamp < cutoff) { tooOld++; return false; }
      // Pinned messages are usually deliberate; leave them alone.
      if (m.pinned) return false;
      return true;
    });

    if (!deletable.length) {
      return interaction.editReply({ ...CB.errorResponse(
        'Nothing to Delete',
        [
          'No messages matched.',
          tooOld    > 0 ? `${tooOld} were older than 14 days (Discord cannot bulk-delete those).` : '',
          wrongUser > 0 ? `${wrongUser} were from other users.` : '',
        ].filter(Boolean).join('\n'),
      ) } as never);
    }

    let deleted = 0;
    try {
      const removed = await channel.bulkDelete(deletable, true);
      deleted = removed.size;
    } catch (err) {
      return interaction.editReply({ ...CB.errorResponse('Purge Failed', `Discord rejected the delete: ${(err as Error).message}`) } as never);
    }

    await ModerationManager.log(guild, {
      action: 'purge', target: onlyUser, moderator: interaction.user,
      reason: `Purged ${deleted} message(s) in #${channel.name}`,
      extra: tooOld > 0 ? [`**Skipped:** ${tooOld} older than 14 days`] : [],
    });

    return interaction.editReply({ ...CB.successResponse(
      'Messages Purged',
      [
        `Deleted **${deleted}** message${deleted !== 1 ? 's' : ''}${onlyUser ? ` from **${onlyUser.username}**` : ''}.`,
        tooOld > 0 ? `-# Skipped ${tooOld} message(s) older than 14 days — Discord does not allow bulk-deleting those.` : '',
      ].filter(Boolean).join('\n'),
    ) } as never);
  },
});
