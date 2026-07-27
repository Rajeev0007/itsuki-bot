import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { Command } from '../../structures/Command';
import music from '../../managers/MusicManager';
import { musicCheck, musicError, musicSuccess } from '../../utils/MusicUtil';
import musicConfig from '../../config/music';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set or check the playback volume.')
    .addIntegerOption((o) => o.setName('level').setDescription('Volume level (1–150)').setMinValue(1).setMaxValue(150)),
  category: 'music',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { error, player } = musicCheck(interaction, music, { needsQueue: true });
    if (error) return interaction.editReply(musicError(error) as never);
    const p = player as { volume: number; setVolume: (v: number) => Promise<void> };
    const level = interaction.options.get('level')?.value as number | null;
    if (level === null || level === undefined) {
      const v = p.volume;
      return interaction.editReply(musicSuccess(`Current volume: **${v}%**`) as never);
    }
    await p.setVolume(level);
    return interaction.editReply(musicSuccess(`Volume set to **${level}%**.`) as never);
  },
});
