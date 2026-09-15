import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import ModerationManager from '../../managers/ModerationManager';
import * as CB from '../../builders/ComponentBuilder';
import { parseDuration, formatDuration, MAX_TIMEOUT_MS } from '../../utils/Duration';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('timeout').setDescription('Temporarily mute a member (Discord timeout).')
    .addUserOption((o) => o.setName('user').setDescription('Member to time out').setRequired(true))
    .addStringOption((o) => o.setName('duration')
      .setDescription('e.g. 10m, 1h30m, 7d — max 28 days').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason for the timeout').setMaxLength(400))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  category: 'moderation',
  guildOnly: true,
  permissions: ['ModerateMembers'],

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const target = interaction.options.getUser('user');
    if (!target) return interaction.editReply({ ...CB.errorResponse('Missing User', 'Specify who to time out.') } as never);

    const rawDuration = interaction.options.getString('duration');
    const parsed = parseDuration(rawDuration);
    if (!parsed) {
      return interaction.editReply({ ...CB.errorResponse(
        'Invalid Duration',
        'Use a value like `10m`, `1h30m`, `2d`, or a bare number of seconds.',
      ) } as never);
    }

    // Discord rejects anything over 28 days outright, so clamp and say so.
    const duration = Math.min(parsed, MAX_TIMEOUT_MS);
    const clamped  = parsed > MAX_TIMEOUT_MS;

    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const guild  = interaction.guild!;

    if (!ModerationManager.botHas(guild, PermissionFlagsBits.ModerateMembers)) {
      return interaction.editReply({ ...CB.errorResponse('Missing Permission', 'I need the **Timeout Members** permission.') } as never);
    }

    const member = guild.members.cache.get(target.id)
      ?? await guild.members.fetch(target.id).catch(() => null);
    if (!member) {
      return interaction.editReply({ ...CB.errorResponse('Not a Member', `**${target.username}** is not in this server.`) } as never);
    }

    const denied = ModerationManager.canModerate(interaction.member as never, member, 'timeout');
    if (denied) return interaction.editReply({ ...CB.errorResponse('Cannot Time Out', denied) } as never);

    const until = Date.now() + duration;
    try {
      await member.timeout(duration, `${reason} — by ${interaction.user.tag ?? interaction.user.username}`);
    } catch (err) {
      return interaction.editReply({ ...CB.errorResponse('Timeout Failed', `Discord rejected the timeout: ${(err as Error).message}`) } as never);
    }

    // Timeouts don't remove the member, so the DM can go out afterwards.
    const notified = await ModerationManager.notify(
      target, guild.name, `timed out for ${formatDuration(duration)}`, reason,
      `Expires <t:${Math.floor(until / 1000)}:R>.`,
    );

    await ModerationManager.log(guild, {
      action: 'timeout', target, moderator: interaction.user, reason,
      extra: [`**Duration:** ${formatDuration(duration)}`, `**Expires:** <t:${Math.floor(until / 1000)}:F>`],
    });

    return interaction.editReply({ ...CB.successResponse(
      'Member Timed Out',
      [
        `**${target.username}** has been timed out for **${formatDuration(duration)}**.`,
        `**Expires:** <t:${Math.floor(until / 1000)}:R>`,
        `**Reason:** ${reason}`,
        clamped ? '-# Requested duration exceeded Discord\'s 28-day maximum and was capped.' : '',
        notified ? '' : '-# Could not DM them (DMs closed).',
      ].filter(Boolean).join('\n'),
    ) } as never);
  },
});
