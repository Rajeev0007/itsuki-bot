import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import ModerationManager from '../../managers/ModerationManager';
import * as CB from '../../builders/ComponentBuilder';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('untimeout').setDescription('Remove an active timeout from a member.')
    .addUserOption((o) => o.setName('user').setDescription('Member to release').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  category: 'moderation',
  guildOnly: true,
  permissions: ['ModerateMembers'],

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const target = interaction.options.getUser('user');
    if (!target) return interaction.editReply({ ...CB.errorResponse('Missing User', 'Specify whose timeout to remove.') } as never);

    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const guild = interaction.guild!;

    if (!ModerationManager.botHas(guild, PermissionFlagsBits.ModerateMembers)) {
      return interaction.editReply({ ...CB.errorResponse('Missing Permission', 'I need the **Timeout Members** permission.') } as never);
    }

    const member = guild.members.cache.get(target.id)
      ?? await guild.members.fetch(target.id).catch(() => null);
    if (!member) {
      return interaction.editReply({ ...CB.errorResponse('Not a Member', `**${target.username}** is not in this server.`) } as never);
    }

    // isCommunicationDisabled() is false once the timeout lapses, so this
    // correctly reports "not timed out" for an expired one too.
    if (!member.isCommunicationDisabled()) {
      return interaction.editReply({ ...CB.errorResponse('Not Timed Out', `**${target.username}** is not currently timed out.`) } as never);
    }

    // Lifting a punishment is the safe direction, so this uses the hierarchy
    // checks WITHOUT the 'timeout' capability rules. Routing through
    // canModerate(…, 'timeout') meant a moderator could not clear their own
    // timeout (they were told "You cannot timeout yourself") and could not
    // release anyone ranked above them even though releasing is harmless.
    const denied = member.id === interaction.user.id
      ? null
      : ModerationManager.canTarget(interaction.member as never, member, 'untimeout');
    if (denied) return interaction.editReply({ ...CB.errorResponse('Cannot Modify', denied) } as never);

    // The bot still has to actually be able to do it.
    if (!member.moderatable) {
      return interaction.editReply({ ...CB.errorResponse(
        'Cannot Modify',
        `I can't modify **${target.username}** — their highest role is above mine, or I'm missing Timeout Members.`,
      ) } as never);
    }

    try {
      await member.timeout(null, `${reason} — by ${interaction.user.tag ?? interaction.user.username}`);
    } catch (err) {
      return interaction.editReply({ ...CB.errorResponse('Failed', `Discord rejected the change: ${(err as Error).message}`) } as never);
    }

    await ModerationManager.log(guild, { action: 'untimeout', target, moderator: interaction.user, reason });
    await ModerationManager.notify(target, guild.name, 'released from timeout', reason);

    return interaction.editReply({ ...CB.successResponse(
      'Timeout Removed',
      `**${target.username}** can speak again.\n**Reason:** ${reason}`,
    ) } as never);
  },
});
