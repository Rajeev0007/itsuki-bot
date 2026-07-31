import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { Command } from '../../structures/Command';
import music from '../../managers/MusicManager';
import { musicCheck, musicError, musicSuccess } from '../../utils/MusicUtil';

export default new Command({
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming tracks in the queue.'),
  category: 'music',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { error, session, player } = musicCheck(interaction, music, { needsQueue: true });
    if (error) return interaction.editReply(musicError(error) as never);
    if (session!.queueList.length < 2)
      return interaction.editReply(musicError('Need at least 2 tracks in the queue to shuffle.') as never);
    (player as { queue: { shuffle: () => void } }).queue.shuffle();
    for (let i = session!.queueList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [session!.queueList[i], session!.queueList[j]] = [session!.queueList[j], session!.queueList[i]];
    }
    return interaction.editReply(musicSuccess(`🔀 Shuffled **${session!.queueList.length}** tracks in the queue.`) as never);
  },
});
