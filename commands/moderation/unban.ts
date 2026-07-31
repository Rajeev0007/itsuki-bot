import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import ModerationManager from '../../managers/ModerationManager';
import * as CB from '../../builders/ComponentBuilder';

const SNOWFLAKE = /^\d{15,25}$/;

export default new Command({
  data: new SlashCommandBuilder()
    .setName('unban').setDescription('Lift a ban using the user\'s ID.')
    .addStringOption((o) => o.setName('user_id').setDescription('ID of the banned user').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason for the unban').setMaxLength(400))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  category: 'moderation',
  guildOnly: true,
  permissions: ['BanMembers'],

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    // A banned user cannot be picked with a user option — they're not a member,
    // so the ID has to be entered manually.
    const rawId = (interaction.options.getString('user_id') ?? '').trim().replace(/[<@!>]/g, '');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const guild = interaction.guild!;

    if (!SNOWFLAKE.test(rawId)) {
      return interaction.editReply({ ...CB.errorResponse('Invalid ID', 'Provide a numeric user ID (enable Developer Mode to copy one).') } as never);
    }
    if (!ModerationManager.botHas(guild, PermissionFlagsBits.BanMembers)) {
      return interaction.editReply({ ...CB.errorResponse('Missing Permission', 'I need the **Ban Members** permission.') } as never);
    }

    const ban = await guild.bans.fetch(rawId).catch(() => null);
    if (!ban) {
      return interaction.editReply({ ...CB.errorResponse('Not Banned', `No active ban found for \`${rawId}\`.`) } as never);
    }

    try {
      await guild.bans.remove(rawId, `${reason} — by ${interaction.user.tag ?? interaction.user.username}`);
    } catch (err) {
      return interaction.editReply({ ...CB.errorResponse('Unban Failed', `Discord rejected the unban: ${(err as Error).message}`) } as never);
    }

    await ModerationManager.log(guild, {
      action: 'unban', target: ban.user, moderator: interaction.user, reason,
    });

    return interaction.editReply({ ...CB.successResponse(
      'Ban Lifted',
      `**${ban.user.username}** (\`${rawId}\`) has been unbanned.\n**Reason:** ${reason}`,
    ) } as never);
  },
});
