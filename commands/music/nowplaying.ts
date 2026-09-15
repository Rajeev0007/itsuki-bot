import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { Command } from '../../structures/Command';
import music       from '../../managers/MusicManager';
import { musicCheck, musicError } from '../../utils/MusicUtil';

export default new Command({
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing track with controls.'),
  category: 'music',
  // Voice playback needs a guild voice channel — not available in DMs.
  guildOnly: true,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { error } = musicCheck(interaction, music, { needsPlaying: true });
    if (error) return interaction.editReply(musicError(error) as never);
    return interaction.editReply(music.buildNowPlayingPayload(interaction.guild!.id) as never);
  },
});
