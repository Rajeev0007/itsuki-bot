import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { Command } from '../../structures/Command';
import music from '../../managers/MusicManager';
import { musicCheck, musicError, musicSuccess } from '../../utils/MusicUtil';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set the loop mode for the queue.')
    .addStringOption((o) =>
      o.setName('mode').setDescription('Loop mode').setRequired(true)
        .addChoices({ name: 'Off', value: 'off' }, { name: 'Track', value: 'track' }, { name: 'Queue', value: 'queue' })),
  category: 'music',
  // Voice playback needs a guild voice channel — not available in DMs.
  guildOnly: true,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { error, session, player } = musicCheck(interaction, music, { needsQueue: true });
    if (error) return interaction.editReply(musicError(error) as never);
    const mode = interaction.options.getString('mode') as 'off' | 'track' | 'queue' | null;
    if (mode !== 'off' && mode !== 'track' && mode !== 'queue')
      return interaction.editReply(musicError('Choose a loop mode: `off`, `track`, or `queue`.') as never);
    session!.loop = mode;
    await (player as { setRepeatMode: (m: string) => Promise<void> }).setRepeatMode(mode);
    const labels = { off: '➡️ Loop **off**.', track: '🔂 Looping current **track**.', queue: '🔁 Looping the entire **queue**.' };
    return interaction.editReply(musicSuccess(labels[mode]) as never);
  },
});
