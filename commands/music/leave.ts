import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { Command } from '../../structures/Command';
import music from '../../managers/MusicManager';
import { musicError, musicSuccess } from '../../utils/MusicUtil';

export default new Command({
  data: new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel and clear the queue.'),
  category: 'music',
  // Voice playback needs a guild voice channel — not available in DMs.
  guildOnly: true,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const member = interaction.member as { voice?: { channel?: { id: string } } };
    if (!member.voice?.channel) return interaction.editReply(musicError('You need to be in a voice channel first.') as never);
    const session = music.getSession(interaction.guild!.id);
    if (!session) return interaction.editReply(musicError("I'm not in a voice channel.") as never);
    if (member.voice.channel.id !== session.voiceChannel.id)
      return interaction.editReply(musicError(`You must be in <#${session.voiceChannel.id}> to use this.`) as never);
    await music.destroyPlayer(interaction.guild!.id);
    return interaction.editReply(musicSuccess('👋 Left the voice channel and cleared the queue.') as never);
  },
});
