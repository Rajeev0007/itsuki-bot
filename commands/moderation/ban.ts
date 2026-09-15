import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import ModerationManager from '../../managers/ModerationManager';
import * as CB from '../../builders/ComponentBuilder';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('ban').setDescription('Ban a user from the server.')
    .addUserOption((o) => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason for the ban').setMaxLength(400))
    .addIntegerOption((o) => o.setName('delete_days')
      .setDescription('Delete this user\'s messages from the last N days (0-7)')
      .setMinValue(0).setMaxValue(7))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  category: 'moderation',
  guildOnly: true,
  permissions: ['BanMembers'],

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const target = interaction.options.getUser('user');
    if (!target) return interaction.editReply({ ...CB.errorResponse('Missing User', 'Specify who to ban.') } as never);

    const reason     = interaction.options.getString('reason') ?? 'No reason provided';
    const deleteDays = interaction.options.getInteger('delete_days') ?? 0;
    const guild      = interaction.guild!;

    if (!ModerationManager.botHas(guild, PermissionFlagsBits.BanMembers)) {
      return interaction.editReply({ ...CB.errorResponse('Missing Permission', 'I need the **Ban Members** permission.') } as never);
    }

    // The target may not be in the guild — banning by ID is still valid, and is
    // the whole point of pre-emptive bans. Only run member checks if present.
    const member = guild.members.cache.get(target.id)
      ?? await guild.members.fetch(target.id).catch(() => null);

    if (member) {
      const moderator = interaction.member as never;
      const denied = ModerationManager.canModerate(moderator, member, 'ban');
      if (denied) return interaction.editReply({ ...CB.errorResponse('Cannot Ban', denied) } as never);
    } else {
      const existing = await guild.bans.fetch(target.id).catch(() => null);
      if (existing) {
        return interaction.editReply({ ...CB.errorResponse('Already Banned', `**${target.username}** is already banned.`) } as never);
      }
    }

    // DM first: after the ban we no longer share a guild and the DM is rejected.
    const notified = member
      ? await ModerationManager.notify(target, guild.name, 'banned', reason)
      : false;

    try {
      await guild.bans.create(target.id, {
        reason: `${reason} — by ${interaction.user.tag ?? interaction.user.username}`,
        // The API takes seconds, not days.
        deleteMessageSeconds: deleteDays * 86_400,
      });
    } catch (err) {
      return interaction.editReply({ ...CB.errorResponse('Ban Failed', `Discord rejected the ban: ${(err as Error).message}`) } as never);
    }

    await ModerationManager.log(guild, {
      action: 'ban', target, moderator: interaction.user, reason,
      extra: deleteDays > 0 ? [`**Messages deleted:** last ${deleteDays} day(s)`] : [],
    });

    return interaction.editReply({ ...CB.successResponse(
      'User Banned',
      [
        `**${target.username}** (\`${target.id}\`) has been banned.`,
        `**Reason:** ${reason}`,
        deleteDays > 0 ? `**Messages deleted:** last ${deleteDays} day(s)` : '',
        member && !notified ? '-# Could not DM them (DMs closed).' : '',
        !member ? '-# They were not in the server — banned pre-emptively by ID.' : '',
      ].filter(Boolean).join('\n'),
    ) } as never);
  },
});
