import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, AttachmentBuilder,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  type ChatInputCommandInteraction, type GuildMember, type VoiceBasedChannel,
} from 'discord.js';
import { Command } from '../../structures/Command';
import RecordingManager, { DEFAULT_MAX_MINUTES, MAX_MAX_MINUTES } from '../../managers/RecordingManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import logger from '../../utils/Logger';

/** Consent panel posted into the channel when a recording starts. */
export function buildConsentPanel(guildId: string, channelName: string, minutes: number, consentedCount: number): ContainerBuilder {
  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      '# 🔴 Recording in progress',
      `Voice channel **${channelName}** is being recorded (up to **${minutes} minutes**).`,
    ].join('\n')))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      '**Your audio is NOT being recorded unless you opt in.**',
      'Press **I consent** below to be included. You can withdraw at any time.',
      '',
      `-# Opted in so far: **${consentedCount}**`,
    ].join('\n')))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`record_consent:${guildId}`)
          .setLabel('I consent').setStyle(ButtonStyle.Success).setEmoji('🎙️'),
        new ButtonBuilder().setCustomId(`record_revoke:${guildId}`)
          .setLabel('Withdraw').setStyle(ButtonStyle.Secondary),
      ),
    );
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('record').setDescription('Record a voice channel (consenting participants only).')
    .addSubcommand((s) => s.setName('start').setDescription('Start recording your current voice channel')
      .addIntegerOption((o) => o.setName('minutes')
        .setDescription(`Max length, 1-${MAX_MAX_MINUTES} (default ${DEFAULT_MAX_MINUTES})`)
        .setMinValue(1).setMaxValue(MAX_MAX_MINUTES)))
    .addSubcommand((s) => s.setName('stop').setDescription('Stop and receive the recording'))
    .addSubcommand((s) => s.setName('status').setDescription('Show the current recording status'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  category: 'utility',
  // Voice channels only exist in servers.
  guildOnly: true,
  permissions: ['ManageGuild'],
  cooldown: 5_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['start', 'stop', 'status'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const guild = interaction.guild!;

    // ── status ──────────────────────────────────────────────────────────────
    if (sub === 'status') {
      const session = RecordingManager.get(guild.id);
      if (!session) {
        return interaction.editReply({ ...CB.successResponse(
          'Not Recording', 'No recording is active. Use `/record start` in a voice channel.',
        ) } as never);
      }
      const elapsed = Date.now() - session.startedAt;
      return interaction.editReply({ ...CB.successResponse(
        '🔴 Recording Active',
        [
          `**Channel:** <#${session.channelId}>`,
          `**Elapsed:** ${fmt.duration(elapsed)} / ${fmt.duration(session.maxDurationMs)}`,
          `**Consented:** ${session.consented.size}`,
          `**Captured audio from:** ${session.captured.size}`,
          session.skipped.size ? `**Skipped (no consent):** ${session.skipped.size}` : '',
          `**Started by:** <@${session.requesterId}>`,
        ].filter(Boolean).join('\n'),
      ) } as never);
    }

    // ── stop ────────────────────────────────────────────────────────────────
    if (sub === 'stop') {
      const result = await RecordingManager.stop(guild.id);
      if (!result.ok) {
        return interaction.editReply({ ...CB.errorResponse('Cannot Stop', result.reason ?? 'Unknown error.') } as never);
      }

      const session = result.session!;
      const durationMs = result.durationMs ?? 0;

      if (!result.audio) {
        return interaction.editReply({ ...CB.errorResponse(
          'No Audio Captured',
          [
            `Recording stopped after ${fmt.duration(durationMs)}, but nothing was captured.`,
            session.consented.size === 0
              ? '-# Nobody pressed **I consent**, so no audio was recorded.'
              : '-# Consenting participants did not speak.',
          ].join('\n'),
        ) } as never);
      }

      const mb = result.audio.length / 1024 / 1024;
      const limit = Math.max(10 * 1024 * 1024, guild.maximumUploadLimit ?? 0) / 1024 / 1024;

      if (mb > limit - 0.25) {
        // Refuse rather than attempt an upload Discord will reject.
        return interaction.editReply({ ...CB.errorResponse(
          'Recording Too Large',
          [
            `The recording is **${mb.toFixed(1)} MB** but this server's upload limit is **${limit.toFixed(0)} MB**.`,
            '-# Record a shorter session with `/record start minutes:<n>`.',
          ].join('\n'),
        ) } as never);
      }

      const stamp = new Date(session.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = new AttachmentBuilder(result.audio, {
        name: `recording-${session.channelName.replace(/[^\w-]/g, '_')}-${stamp}.wav`,
      });

      const summary = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '# ⏹️ Recording Finished',
          `**Channel:** ${session.channelName}`,
          `**Duration:** ${fmt.duration(durationMs)}`,
          `**Size:** ${mb.toFixed(2)} MB · 24 kHz mono WAV`,
          `**Participants recorded:** ${session.captured.size}`,
          session.skipped.size
            ? `-# ${session.skipped.size} speaker(s) were excluded because they did not consent.`
            : '',
        ].filter(Boolean).join('\n')));

      // Delivered privately to whoever ran the command — a recording of people's
      // voices shouldn't be dropped into a public channel by default.
      try {
        await interaction.user.send({ content: '🎙️ Your voice recording:', files: [file] });
        return interaction.editReply({
          components: [summary.addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
          ).addTextDisplayComponents(new TextDisplayBuilder().setContent(
            '✅ Sent to your DMs.',
          ))],
        } as never);
      } catch {
        // DMs closed — fall back to the ephemeral reply, still not public.
        return interaction.editReply({
          components: [summary.addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
          ).addTextDisplayComponents(new TextDisplayBuilder().setContent(
            '-# Could not DM you, so the file is attached here (visible only to you).',
          ))],
          files: [file],
        } as never);
      }
    }

    // ── start ───────────────────────────────────────────────────────────────
    const member = interaction.member as GuildMember | null;
    const channel = member?.voice?.channel as VoiceBasedChannel | null;
    if (!channel) {
      return interaction.editReply({ ...CB.errorResponse(
        'Not in Voice', 'Join the voice channel you want to record first.',
      ) } as never);
    }

    const minutes = interaction.options.getInteger('minutes') ?? DEFAULT_MAX_MINUTES;
    const result = await RecordingManager.start({
      guild, channel, requesterId: interaction.user.id, maxMinutes: minutes,
    });

    if (!result.ok) {
      return interaction.editReply({ ...CB.errorResponse('Cannot Start', result.reason ?? 'Unknown error.') } as never);
    }

    // Announce publicly in the invoking channel. A recording that isn't visible
    // to participants is the thing to avoid, both ethically and legally.
    let announced = false;
    try {
      const textChannel = interaction.channel as { send?: (o: unknown) => Promise<unknown> } | null;
      if (textChannel?.send) {
        await textChannel.send({
          components: [buildConsentPanel(guild.id, channel.name, minutes, 0)],
          flags: MessageFlags.IsComponentsV2,
        } as never);
        announced = true;
      }
    } catch (err) {
      logger.warn(`[Record] Could not post consent panel: ${(err as Error).message}`);
    }

    if (!announced) {
      // Without a visible notice, participants can't consent — so don't record.
      await RecordingManager.stop(guild.id);
      return interaction.editReply({ ...CB.errorResponse(
        'Cannot Announce Recording',
        'I could not post the consent notice in this channel, so the recording was cancelled. Grant me **Send Messages** here and try again.',
      ) } as never);
    }

    const listeners = RecordingManager.humanListeners(guild, channel.id).length;
    return interaction.editReply({ ...CB.successResponse(
      '🔴 Recording Started',
      [
        `Recording **${channel.name}** for up to **${minutes} minutes**.`,
        `**${listeners}** person(s) in the channel.`,
        '',
        'A consent notice has been posted. **Only people who opt in are recorded.**',
        'Use `/record stop` to finish — the file is sent to you privately.',
      ].join('\n'),
    ) } as never);
  },
});
