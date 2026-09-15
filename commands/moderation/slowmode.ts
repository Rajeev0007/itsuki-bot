import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType,
  type ChatInputCommandInteraction, type TextChannel,
} from 'discord.js';
import { Command } from '../../structures/Command';
import ModerationManager from '../../managers/ModerationManager';
import * as CB from '../../builders/ComponentBuilder';
import { parseDuration, formatDuration } from '../../utils/Duration';

/** Discord's per-channel slowmode ceiling is 6 hours. */
const MAX_SLOWMODE_SECONDS = 21_600;

export default new Command({
  data: new SlashCommandBuilder()
    .setName('slowmode').setDescription('Set a channel\'s slowmode. Use 0 to turn it off.')
    .addStringOption((o) => o.setName('duration')
      .setDescription('e.g. 10s, 5m, 1h — max 6h. Use 0 to disable.').setRequired(true))
    .addChannelOption((o) => o.setName('channel')
      .setDescription('Channel to change (defaults to this one)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  category: 'moderation',
  guildOnly: true,
  permissions: ['ManageChannels'],

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const raw = (interaction.options.getString('duration') ?? '').trim();
    const guild = interaction.guild!;

    if (!ModerationManager.botHas(guild, PermissionFlagsBits.ManageChannels)) {
      return interaction.editReply({ ...CB.errorResponse('Missing Permission', 'I need the **Manage Channels** permission.') } as never);
    }

    // "0" means disable, so it has to be handled before parseDuration (which
    // rejects zero as unparseable).
    let seconds: number;
    if (/^0+$/.test(raw)) {
      seconds = 0;
    } else {
      const ms = parseDuration(raw);
      if (!ms) {
        return interaction.editReply({ ...CB.errorResponse(
          'Invalid Duration',
          'Use a value like `10s`, `5m`, `1h`, or `0` to disable.',
        ) } as never);
      }
      seconds = Math.round(ms / 1000);
    }

    const clamped = seconds > MAX_SLOWMODE_SECONDS;
    seconds = Math.min(seconds, MAX_SLOWMODE_SECONDS);

    const channel = (interaction.options.getChannel('channel') ?? interaction.channel) as TextChannel | null;
    if (!channel || typeof channel.setRateLimitPerUser !== 'function') {
      return interaction.editReply({ ...CB.errorResponse('Unsupported Channel', 'Slowmode cannot be set on that channel type.') } as never);
    }

    try {
      await channel.setRateLimitPerUser(seconds, `Slowmode by ${interaction.user.tag ?? interaction.user.username}`);
    } catch (err) {
      return interaction.editReply({ ...CB.errorResponse('Failed', `Discord rejected the change: ${(err as Error).message}`) } as never);
    }

    await ModerationManager.log(guild, {
      action: 'slowmode', moderator: interaction.user,
      reason: seconds === 0 ? `Disabled slowmode in #${channel.name}` : `Set slowmode to ${formatDuration(seconds * 1000)} in #${channel.name}`,
    });

    return interaction.editReply({ ...CB.successResponse(
      seconds === 0 ? 'Slowmode Disabled' : 'Slowmode Updated',
      [
        seconds === 0
          ? `Slowmode is now **off** in ${channel}.`
          : `Members must wait **${formatDuration(seconds * 1000)}** between messages in ${channel}.`,
        clamped ? '-# Requested value exceeded Discord\'s 6-hour maximum and was capped.' : '',
      ].filter(Boolean).join('\n'),
    ) } as never);
  },
});
