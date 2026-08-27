import { type ButtonInteraction, type Client } from 'discord.js';
import music from '../../managers/MusicManager';
import { musicError, musicSuccess } from '../../utils/MusicUtil';

export const customId = 'music_:*';

export async function execute(interaction: ButtonInteraction, client: Client): Promise<void> {
  const rawId = interaction.customId;
  const guildId = interaction.guild?.id;

  if (!guildId) {
    await interaction.reply({ ...musicError('This can only be used in a server.'), ephemeral: true });
    return;
  }

  const session = music.getSession(guildId);
  const player = music.getPlayer(guildId);

  if (rawId.startsWith('music_qpage:')) {
    const parts = rawId.split(':');
    const page = parseInt(parts[2], 10);
    if (!session) { await interaction.reply({ ...musicError('Nothing is playing.'), ephemeral: true }); return; }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildQueuePage } = require('../../commands/music/queue') as { buildQueuePage: (s: unknown, p: number) => unknown };
    await interaction.update(buildQueuePage(session, page) as Parameters<typeof interaction.update>[0]);
    return;
  }

  const member = interaction.member as { voice?: { channel?: { id: string } } } | null;
  if (!member?.voice?.channel) {
    await interaction.reply({ ...musicError('Join the voice channel first.'), ephemeral: true });
    return;
  }
  if (session && member.voice.channel.id !== session.voiceChannel.id) {
    await interaction.reply({ ...musicError(`You must be in <#${session.voiceChannel.id}>.`), ephemeral: true });
    return;
  }
  if (!session || !session.current || !player) {
    await interaction.reply({ ...musicError('Nothing is playing right now.'), ephemeral: true });
    return;
  }

  const p = player as { paused: boolean; pause: (v: boolean) => Promise<void>; resume: () => Promise<void>; skip: () => Promise<void>; setRepeatMode: (m: string) => Promise<void> };

  if (rawId.startsWith('music_pause:')) {
    if (p.paused) await p.resume(); else await p.pause(true);
    await interaction.update(music.buildNowPlayingPayload(guildId) as Parameters<typeof interaction.update>[0]);
    return;
  }
  if (rawId.startsWith('music_skip:')) {
    // Acknowledge BEFORE skipping. skip() fires trackStart, which deletes this
    // now-playing message and sends a new one, so updating afterwards raced
    // against its own side effect and often targeted a deleted message.
    await interaction.update(musicSuccess('⏭️ Skipped.') as Parameters<typeof interaction.update>[0])
      .catch(() => {});
    await p.skip();
    return;
  }
  if (rawId.startsWith('music_loop:')) {
    const next = session.loop === 'off' ? 'track' : session.loop === 'track' ? 'queue' : 'off';
    session.loop = next as 'off' | 'track' | 'queue';
    await p.setRepeatMode(next);
    await interaction.update(music.buildNowPlayingPayload(guildId) as Parameters<typeof interaction.update>[0]);
    return;
  }
  if (rawId.startsWith('music_stop:')) {
    // This button lives ON the now-playing message, and destroyPlayer deletes
    // that message — so updating afterwards always targeted a deleted message and
    // reported "An error occurred processing this interaction" even though the
    // stop had succeeded. Update first, then tear down.
    await interaction.update(
      musicSuccess('⏹️ Stopped playback and cleared the queue.') as Parameters<typeof interaction.update>[0],
    ).catch(() => {});
    // Hand off ownership of this message before tearing down, or destroyPlayer
    // deletes the very confirmation just rendered into it.
    session.npMessage = null;
    await music.destroyPlayer(guildId);
    return;
  }
}
