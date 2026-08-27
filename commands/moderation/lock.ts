import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType,
  type ChatInputCommandInteraction, type TextChannel,
} from 'discord.js';
import { Command } from '../../structures/Command';
import ModerationManager from '../../managers/ModerationManager';
import * as CB from '../../builders/ComponentBuilder';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('lock').setDescription('Stop members from sending messages in a channel.')
    .addSubcommand((s) => s.setName('on').setDescription('Lock the channel')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel (defaults to this one)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400)))
    .addSubcommand((s) => s.setName('off').setDescription('Unlock the channel')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel (defaults to this one)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400)))
    // Locking edits the @everyone permission overwrite, which the API gates
    // behind ManageRoles ("Manage Permissions" on a channel) — NOT
    // ManageChannels. Declare only what is actually used.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  category: 'moderation',
  guildOnly: true,
  permissions: ['ManageRoles'],

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['on', 'off'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', 'Use `/lock on` or `/lock off`.',
      ) } as never);
    }

    const guild = interaction.guild!;
    const reason = interaction.options.getString('reason') ?? 'No reason provided';

    const channel = (interaction.options.getChannel('channel') ?? interaction.channel) as TextChannel | null;
    if (!channel || typeof channel.permissionOverwrites?.edit !== 'function') {
      return interaction.editReply({ ...CB.errorResponse('Unsupported Channel', 'That channel type cannot be locked.') } as never);
    }

    // ManageRoles is surfaced as "Manage Permissions" inside a channel and can
    // be granted per-channel, so check it on the target channel rather than
    // guild-wide — otherwise a bot given the permission only where it needs it
    // would be rejected here.
    const me = guild.members.me;
    if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Missing Permission',
        `I need the **Manage Permissions** permission in ${channel} to change who can send messages there.`,
      ) } as never);
    }

    // The CALLER must be able to manage permissions in the TARGET channel. The
    // slash gate Discord applies is channel-aware, but the prefix router's is
    // not, so `,lock on channel:#staff` could otherwise be run by a moderator
    // who is explicitly denied that permission in #staff.
    const callerMember = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!callerMember || !channel.permissionsFor(callerMember)?.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.editReply({ ...CB.errorResponse(
        'No Access', `You need the **Manage Permissions** permission in ${channel}.`,
      ) } as never);
    }

    const everyone = guild.roles.everyone;
    const locking = sub === 'on';

    // `null` clears the override rather than explicitly allowing it, so
    // unlocking restores whatever the category/role defaults were instead of
    // granting SendMessages to @everyone in a channel that never had it.
    try {
      await channel.permissionOverwrites.edit(
        everyone,
        { SendMessages: locking ? false : null, SendMessagesInThreads: locking ? false : null },
        { reason: `${locking ? 'Locked' : 'Unlocked'} by ${interaction.user.tag ?? interaction.user.username}: ${reason}` },
      );
    } catch (err) {
      return interaction.editReply({ ...CB.errorResponse('Failed', `Discord rejected the change: ${(err as Error).message}`) } as never);
    }

    await ModerationManager.log(guild, {
      action: locking ? 'lock' : 'unlock', moderator: interaction.user, reason,
      extra: [`**Channel:** #${channel.name}`],
    });

    return interaction.editReply({ ...CB.successResponse(
      locking ? 'Channel Locked' : 'Channel Unlocked',
      [
        locking
          ? `Members can no longer send messages in ${channel}.`
          : `Members can send messages in ${channel} again.`,
        `**Reason:** ${reason}`,
      ].join('\n'),
    ) } as never);
  },
});
