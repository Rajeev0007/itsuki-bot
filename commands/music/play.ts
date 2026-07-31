import { SlashCommandBuilder, PermissionsBitField, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { Command }   from '../../structures/Command';
import music         from '../../managers/MusicManager';
import { formatDuration, musicError, musicSuccess, buildSearchQuery } from '../../utils/MusicUtil';
import logger        from '../../utils/Logger';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or add it to the queue.')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song name or URL (YouTube / SoundCloud / Spotify)').setRequired(true)),
  category: 'music',

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { member, guild } = interaction as { member: { voice?: { channel?: unknown } }; guild: { id: string; channels: { cache: Map<string, { id: string }> }; members: { me: unknown } } };

    let voiceChannel = (member.voice?.channel as { id: string; permissionsFor?: (m: unknown) => { has: (f: unknown) => boolean } } | undefined);

    const gs = music.getGuildSettings(guild.id);
    if (gs.lockedChannelId) {
      const locked = (guild as { channels: { cache: Map<string, unknown> } }).channels.cache.get(gs.lockedChannelId) as typeof voiceChannel;
      if (locked) voiceChannel = locked;
    }

    if (!voiceChannel) return interaction.editReply(musicError('You need to be in a voice channel first.') as never);

    const perms = voiceChannel.permissionsFor?.(guild.members.me);
    if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) {
      return interaction.editReply(musicError('I need **Connect** and **Speak** permissions in your voice channel.') as never);
    }

    const existingSession = music.getSession(guild.id);
    const memberVcId = (member.voice?.channel as { id?: string })?.id;
    if (existingSession && memberVcId && memberVcId !== existingSession.voiceChannel.id) {
      return interaction.editReply(musicError(`You must be in <#${existingSession.voiceChannel.id}> to add songs.`) as never);
    }

    const query = interaction.options.getString('query');
    if (!query || !query.trim())
      return interaction.editReply(musicError('Give me something to play — a song name or a URL.') as never);
    let player;
    try {
      player = music.createPlayer(guild as never, voiceChannel as never, (interaction as { channel: unknown }).channel as never);
    } catch (err) {
      return interaction.editReply(musicError(`Could not set up the player: ${(err as Error).message}`) as never);
    }

    const searchQuery = buildSearchQuery(query);
    let result;
    try {
      result = await (player as { search: (q: string, u: unknown) => Promise<{ loadType: string; tracks: unknown[]; playlistInfo?: { name?: string } }> })
        .search(searchQuery, (interaction as { user: unknown }).user);
    } catch (err) {
      logger.error(`[Music] search() threw for query "${query}": ${(err as Error)?.stack ?? err}`);
      return interaction.editReply(musicError(`Search failed: ${(err as Error).message}`) as never);
    }

    if (!result || result.loadType === 'empty' || !result.tracks?.length) {
      return interaction.editReply(musicError('No results found. Try a different search term or URL.') as never);
    }

    const session  = music.getSession(guild.id)!;
    const p        = player as { queue: { add: (t: unknown | unknown[]) => void }; connect: () => Promise<void>; play: () => Promise<void>; playing: boolean };
    const wasIdle  = !session.current && !p.playing;

    try {
      if (result.loadType === 'playlist') {
        p.queue.add(result.tracks);
        session.queueList.push(...result.tracks as never[]);
        if (wasIdle) { await p.connect(); await p.play(); }
        const name = result.playlistInfo?.name ?? 'Playlist';
        return interaction.editReply(musicSuccess(`Added **${result.tracks.length}** tracks from **${name}** to the queue.`) as never);
      }
      const track = result.tracks[0];
      p.queue.add(track);
      session.queueList.push(track as never);
      if (wasIdle) {
        await p.connect(); await p.play();
        return interaction.editReply(musicSuccess(`Starting **${(track as { info?: { title?: string } }).info?.title ?? 'Unknown'}**…`) as never);
      }
      const info = (track as { info?: { isStream?: boolean; length?: number; title?: string } }).info;
      const dur  = info?.isStream ? 'LIVE' : formatDuration(info?.length ?? 0);
      return interaction.editReply(musicSuccess(`Added to queue at position **#${session.queueList.length}**: **${info?.title ?? 'Unknown'}** \`[${dur}]\``) as never);
    } catch (err) {
      logger.error(`[Music] connect()/play() failed: ${(err as Error)?.stack ?? err}`);
      return interaction.editReply(musicError(`Failed to start playback: ${(err as Error).message}`) as never);
    }
  },
});
