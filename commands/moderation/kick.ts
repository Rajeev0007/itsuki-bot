import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import ModerationManager from '../../managers/ModerationManager';
import * as CB from '../../builders/ComponentBuilder';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('kick').setDescription('Kick a member from the server.')
    .addUserOption((o) => o.setName('user').setDescription('Member to kick').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason for the kick').setMaxLength(400))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  category: 'moderation',
  guildOnly: true,
  permissions: ['KickMembers'],

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const target = interaction.options.getUser('user');
    if (!target) return interaction.editReply({ ...CB.errorResponse('Missing User', 'Specify who to kick.') } as never);

    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const guild  = interaction.guild!;

    if (!ModerationManager.botHas(guild, PermissionFlagsBits.KickMembers)) {
      return interaction.editReply({ ...CB.errorResponse('Missing Permission', 'I need the **Kick Members** permission.') } as never);
    }

    // Unlike a ban, a kick requires the user to actually be in the server.
    const member = guild.members.cache.get(target.id)
      ?? await guild.members.fetch(target.id).catch(() => null);
    if (!member) {
      return interaction.editReply({ ...CB.errorResponse('Not a Member', `**${target.username}** is not in this server.`) } as never);
    }

    const denied = ModerationManager.canModerate(interaction.member as never, member, 'kick');
    if (denied) return interaction.editReply({ ...CB.errorResponse('Cannot Kick', denied) } as never);

    // DM before removal, or it will never arrive.
    const notified = await ModerationManager.notify(target, guild.name, 'kicked', reason);

    try {
      await member.kick(`${reason} — by ${interaction.user.tag ?? interaction.user.username}`);
    } catch (err) {
      return interaction.editReply({ ...CB.errorResponse('Kick Failed', `Discord rejected the kick: ${(err as Error).message}`) } as never);
    }

    await ModerationManager.log(guild, { action: 'kick', target, moderator: interaction.user, reason });

    return interaction.editReply({ ...CB.successResponse(
      'Member Kicked',
      [
        `**${target.username}** (\`${target.id}\`) has been kicked.`,
        `**Reason:** ${reason}`,
        notified ? '' : '-# Could not DM them (DMs closed).',
      ].filter(Boolean).join('\n'),
    ) } as never);
  },
});
