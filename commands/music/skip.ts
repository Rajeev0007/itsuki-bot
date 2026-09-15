import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { Command } from '../../structures/Command';
import music       from '../../managers/MusicManager';
import { musicCheck, musicError, musicSuccess } from '../../utils/MusicUtil';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track (or multiple tracks).')
    .addIntegerOption((o) => o.setName('amount').setDescription('Number of tracks to skip').setMinValue(1).setMaxValue(100)),
  category: 'music',
  // Voice playback needs a guild voice channel — not available in DMs.
  guildOnly: true,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { error, session, player } = musicCheck(interaction, music, { needsPlaying: true });
    if (error) return interaction.editReply(musicError(error) as never);
    const requested = Math.max(1, Math.min(
      Number(interaction.options.getInteger('amount') ?? 1) || 1,
      session!.queueList.length + 1,
    ));
    const title = (session!.current?.info as { title?: string })?.title ?? 'Unknown';

    // Skip one track at a time so the player's real queue and session.queueList
    // stay in step. The old code spliced (amount - 1) entries straight out of
    // session.queueList and then called skip() once — the displayed queue lost
    // N tracks while playback only advanced by one, so from then on the queue
    // shown to users no longer matched what actually played.
    let skipped = 0;
    for (let i = 0; i < requested; i++) {
      try {
        await (player as { skip: () => Promise<void> }).skip();
        skipped++;
      } catch {
        // Queue ran dry mid-skip (the player may have been torn down).
        break;
      }
    }

    if (skipped === 0) return interaction.editReply(musicError('Nothing could be skipped.') as never);
    const msg = skipped > 1 ? `Skipped **${skipped}** tracks.` : `Skipped **${title}**.`;
    return interaction.editReply(musicSuccess(msg) as never);
  },
});
