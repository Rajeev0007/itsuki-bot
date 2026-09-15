import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { Command } from '../../structures/Command';
import music from '../../managers/MusicManager';
import { musicCheck, musicError, musicSuccess, formatDuration } from '../../utils/MusicUtil';

function parseTime(input: string): number | null {
  const parts = input.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 1) return parts[0] * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return null;
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Seek to a position in the current track.')
    .addStringOption((o) => o.setName('position').setDescription('Time (e.g. 1:30 or 90)').setRequired(true)),
  category: 'music',
  // Voice playback needs a guild voice channel — not available in DMs.
  guildOnly: true,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { error, session, player } = musicCheck(interaction, music, { needsPlaying: true });
    if (error) return interaction.editReply(musicError(error) as never);
    const info = (session!.current?.info ?? {}) as { isSeekable?: boolean; isStream?: boolean; length?: number };
    if (!info.isSeekable || info.isStream)
      return interaction.editReply(musicError('This track is not seekable (live stream or DRM-protected).') as never);
    const input = interaction.options.getString('position');
    if (!input) return interaction.editReply(musicError('Provide a position, e.g. `1:30` or `90`.') as never);
    const ms = parseTime(input);
    if (ms === null) return interaction.editReply(musicError('Invalid time format. Use `MM:SS`, `H:MM:SS`, or plain seconds.') as never);
    if (ms < 0 || ms > (info.length ?? 0))
      return interaction.editReply(musicError(`Position out of range. Track length: \`${formatDuration(info.length ?? 0)}\``) as never);
    await (player as { seek: (ms: number) => Promise<void> }).seek(ms);
    return interaction.editReply(musicSuccess(`⏩ Seeked to \`${formatDuration(ms)}\`.`) as never);
  },
});
