import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { Command } from '../../structures/Command';
import music from '../../managers/MusicManager';
import { musicSuccess } from '../../utils/MusicUtil';

export default new Command({
  data: new SlashCommandBuilder().setName('autoplay').setDescription('Toggle autoplay — queues a related track when the queue runs out.'),
  category: 'music',
  // Voice playback needs a guild voice channel — not available in DMs.
  guildOnly: true,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const enabled = music.toggleAutoplay(interaction.guild!.id);
    const session = music.getSession(interaction.guild!.id);
    if (session) session.autoplay = enabled;
    return interaction.editReply(musicSuccess(
      enabled
        ? '🎶 **Autoplay enabled.** I will queue a related song when the queue ends.'
        : '🎶 **Autoplay disabled.** Playback will stop when the queue runs out.'
    ) as never);
  },
});
