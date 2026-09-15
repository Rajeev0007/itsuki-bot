import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { Command } from '../../structures/Command';
import music from '../../managers/MusicManager';
import { musicCheck, musicError, musicSuccess } from '../../utils/MusicUtil';

export default new Command({
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume paused playback.'),
  category: 'music',
  // Voice playback needs a guild voice channel — not available in DMs.
  guildOnly: true,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { error, player } = musicCheck(interaction, music, { needsPlaying: true });
    if (error) return interaction.editReply(musicError(error) as never);
    const p = player as { paused: boolean; resume: () => Promise<void> };
    if (!p.paused) return interaction.editReply(musicError('Playback is not paused.') as never);
    await p.resume();
    return interaction.editReply(musicSuccess('▶ Resumed playback.') as never);
  },
});
