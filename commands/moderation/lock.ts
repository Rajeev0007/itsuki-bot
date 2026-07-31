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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  category: 'moderation',
  guildOnly: true,
  permissions: ['ManageChannels'],

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

    if (!ModerationManager.botHas(guild, PermissionFlagsBits.ManageChannels)) {
      return interaction.editReply({ ...CB.errorResponse('Missing Permission', 'I need the **Manage Channels** permission.') } as never);
    }

    const channel = (interaction.options.getChannel('channel') ?? interaction.channel) as TextChannel | null;
    if (!channel || typeof channel.permissionOverwrites?.edit !== 'function') {
      return interaction.editReply({ ...CB.errorResponse('Unsupported Channel', 'That channel type cannot be locked.') } as never);
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
