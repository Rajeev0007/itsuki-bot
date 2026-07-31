/**
 * @file MusicManager.ts
 * @description Singleton music manager. Owns the native Lavende engine and all guild sessions.
 */

import {
  ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, MessageFlags, ActivityType,
  type Client, type VoiceBasedChannel, type TextBasedChannel, type Message,
} from 'discord.js';
import musicConfig from '../config/music';
import logger from '../utils/Logger';
import { formatDuration } from '../utils/MusicUtil';
import { filterTracks } from '../utils/ContentFilter';
import { getStore } from '../database/JsonStore';

const guildsDB = getStore('guilds');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LavendeManager } = require('lavende') as {
  LavendeManager: new (opts: {
    sendToShard: (guildId: string, payload: unknown) => void;
    client: { id: string; username: string };
  }) => {
    init: () => void;
    players: Map<string, LavendePlayer>;
    createPlayer: (opts: {
      guildId: string; voiceChannelId: string;
      textChannelId: string; volume: number;
    }) => LavendePlayer;
    sendRawData: (packet: unknown) => void;
  };
};

interface LavendeTrack {
  info?: {
    title?: string; uri?: string; author?: string;
    artworkUrl?: string; length?: number; isStream?: boolean; isSeekable?: boolean;
  };
  requester?: { id: string; username?: string; displayName?: string; displayAvatarURL?: (opts: { size: number }) => string };
}

interface LavendePlayer {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  connect: () => Promise<void>;
  play: () => Promise<void>;
  pause: (v: boolean) => Promise<void>;
  resume: () => Promise<void>;
  skip: () => Promise<void>;
  stop: () => Promise<void>;
  destroy: () => Promise<void>;
  seek: (ms: number) => Promise<void>;
  setVolume: (v: number) => Promise<void>;
  setRepeatMode: (mode: string) => Promise<void>;
  move: (channelId: string) => Promise<void>;
  search: (query: string, requester: unknown) => Promise<{ loadType: string; tracks: LavendeTrack[]; playlistInfo?: { name?: string } }>;
  queue: { add: (track: LavendeTrack | LavendeTrack[]) => void; shuffle: () => void };
  paused: boolean;
  playing: boolean;
  volume: number;
}

export interface GuildSession {
  voiceChannel: VoiceBasedChannel;
  textChannel: TextBasedChannel;
  loop: 'off' | 'track' | 'queue';
  current: LavendeTrack | null;
  lastTrack: LavendeTrack | null;
  queueList: LavendeTrack[];
  npMessage: Message | null;
  leaveTimer: ReturnType<typeof setTimeout> | null;
  alwaysOn: boolean;
  autoplay: boolean;
}

export interface GuildSettings {
  alwaysOn: boolean;
  autoplay: boolean;
  lockedChannelId: string | null;
}

class MusicManager {
  manager: any;
  sessions = new Map<string, GuildSession>();
  guildSettings = new Map<string, GuildSettings>();
  _client: Client | null = null;

  /* Bootstrap */
  init(client: Client): void {
    this._client = client;
    this.manager = new LavendeManager({
      sendToShard: (guildId, payload) => {
        client.guilds.cache.get(guildId)?.shard?.send(payload);
      },
      client: { id: client.user!.id, username: client.user!.username },
    });

    (this.manager as { init: () => void }).init();

    client.on('raw', (packet: unknown) => {
      try {
        (this.manager as { sendRawData: (p: unknown) => void }).sendRawData(packet);
      } catch (err) {
        logger.error(`[Music] Failed to forward raw packet: ${(err as Error)?.message ?? err}`);
      }
    });

    // Bring back 24/7, autoplay and locked-channel settings from disk.
    void this.loadAllGuildSettings();

    logger.info('[Music] Lavende native engine initialised.');
  }

  /* Guild settings
   *
   * These live in memory for fast access but are mirrored to guilds.json.
   * They used to be memory-only, so /247, /autoplay and /setvoice silently
   * reset on every restart — a server would enable 24/7, the bot would be
   * redeployed, and it would then leave the channel as if nothing was set.
   */

  /** Loads persisted settings for a guild into the in-memory cache. */
  private async _loadGuildSettings(guildId: string): Promise<void> {
    try {
      const stored = await guildsDB.get(`${guildId}.music`) as Partial<GuildSettings> | undefined;
      if (stored && typeof stored === 'object') {
        this.guildSettings.set(guildId, {
          alwaysOn:        Boolean(stored.alwaysOn),
          autoplay:        Boolean(stored.autoplay),
          lockedChannelId: typeof stored.lockedChannelId === 'string' ? stored.lockedChannelId : null,
        });
      }
    } catch (err) {
      logger.debug(`[Music] Could not load settings for ${guildId}: ${(err as Error).message}`);
    }
  }

  /** Restores every guild's persisted music settings. Called once on startup. */
  async loadAllGuildSettings(): Promise<void> {
    try {
      const entries = await guildsDB.all();
      let restored = 0;
      for (const [guildId, data] of entries) {
        const music = (data as { music?: Partial<GuildSettings> } | null)?.music;
        if (!music || typeof music !== 'object') continue;
        this.guildSettings.set(guildId, {
          alwaysOn:        Boolean(music.alwaysOn),
          autoplay:        Boolean(music.autoplay),
          lockedChannelId: typeof music.lockedChannelId === 'string' ? music.lockedChannelId : null,
        });
        restored++;
      }
      if (restored) logger.info(`[Music] Restored music settings for ${restored} guild(s).`);
    } catch (err) {
      logger.warn(`[Music] Failed to restore guild settings: ${(err as Error).message}`);
    }
  }

  private _persist(guildId: string): void {
    const s = this.guildSettings.get(guildId);
    if (!s) return;
    // Fire-and-forget: never block a music command on a disk write.
    void guildsDB.set(`${guildId}.music`, {
      alwaysOn: s.alwaysOn, autoplay: s.autoplay, lockedChannelId: s.lockedChannelId,
    }).catch((err: Error) => logger.warn(`[Music] Failed to persist settings for ${guildId}: ${err.message}`));
  }

  getGuildSettings(guildId: string): GuildSettings {
    if (!this.guildSettings.has(guildId)) {
      this.guildSettings.set(guildId, { alwaysOn: false, autoplay: false, lockedChannelId: null });
      // Pull anything persisted in the background; the default is returned now.
      void this._loadGuildSettings(guildId);
    }
    return this.guildSettings.get(guildId)!;
  }

  toggleAlwaysOn(guildId: string): boolean {
    const s = this.getGuildSettings(guildId);
    s.alwaysOn = !s.alwaysOn;
    this._persist(guildId);
    return s.alwaysOn;
  }

  toggleAutoplay(guildId: string): boolean {
    const s = this.getGuildSettings(guildId);
    s.autoplay = !s.autoplay;
    this._persist(guildId);
    return s.autoplay;
  }

  setLockedChannel(guildId: string, channelId: string | null): void {
    this.getGuildSettings(guildId).lockedChannelId = channelId;
    this._persist(guildId);
  }

  /* Session / player management */
  getPlayer(guildId: string): LavendePlayer | null {
    return (this.manager as { players: Map<string, LavendePlayer> })?.players.get(guildId) ?? null;
  }

  getSession(guildId: string): GuildSession | null {
    return this.sessions.get(guildId) ?? null;
  }

  /** Creates (or reuses) the guild's player, always leaving a session in place. */
  createPlayer(guild: { id: string }, voiceChannel: VoiceBasedChannel, textChannel: TextBasedChannel): LavendePlayer {
    if (!this.manager) throw new Error('MusicManager is not initialised yet.');
    const existing = (this.manager as { players: Map<string, LavendePlayer> }).players.get(guild.id);
    if (existing) {
      // destroyPlayer() removes the session before destroying the player, so a
      // failed destroy leaves a player with no session. Callers then did
      // `getSession(id)!` and crashed on null. Re-create the session instead.
      if (!this.sessions.has(guild.id)) {
        const settings = this.getGuildSettings(guild.id);
        this.sessions.set(guild.id, {
          voiceChannel, textChannel, loop: 'off', current: null, lastTrack: null,
          queueList: [], npMessage: null, leaveTimer: null,
          alwaysOn: settings.alwaysOn, autoplay: settings.autoplay,
        });
        this._attachPlayerEvents(guild.id, existing);
      }
      return existing;
    }

    const player = (this.manager as {
      createPlayer: (opts: { guildId: string; voiceChannelId: string; textChannelId: string; volume: number }) => LavendePlayer;
    }).createPlayer({
      guildId: guild.id,
      voiceChannelId: voiceChannel.id,
      textChannelId: textChannel.id,
      volume: musicConfig.defaultVolume,
    });

    const gs = this.getGuildSettings(guild.id);
    this.sessions.set(guild.id, {
      voiceChannel, textChannel, loop: 'off', current: null, lastTrack: null,
      queueList: [], npMessage: null, leaveTimer: null,
      alwaysOn: gs.alwaysOn, autoplay: gs.autoplay,
    });

    this._attachPlayerEvents(guild.id, player);
    return player;
  }

  async destroyPlayer(guildId: string): Promise<void> {
    const session = this.sessions.get(guildId);
    const player = this.getPlayer(guildId);
    if (session?.leaveTimer) clearTimeout(session.leaveTimer);
    if (session?.npMessage) await session.npMessage.delete().catch(() => {});
    this.sessions.delete(guildId);
    if (player) await player.destroy().catch(() => {});
  }

  /* Now Playing UI */
  buildNowPlayingPayload(guildId: string): { components: unknown[]; flags: number } {
    const session = this.getSession(guildId);
    const player = this.getPlayer(guildId);
    if (!session?.current) return this._simpleComponents('🔇 Nothing is playing right now.');

    const track = session.current;
    const info = track.info ?? {};
    const isLive = !!info.isStream;
    const dur = isLive ? '🔴 LIVE' : formatDuration(info.length ?? 0);
    const loopIcon = session.loop === 'track' ? ' (Track Loop)' : session.loop === 'queue' ? ' (Queue Loop)' : '';
    const vol = player?.volume ?? musicConfig.defaultVolume;
    const requester = track.requester;

    const lines = [
      `# Now Playing${loopIcon}`,
      `**[${info.title ?? 'Unknown Track'}](${info.uri ?? 'https://discord.com'})**`,
      `by **${info.author ?? 'Unknown'}**`,
    ];

    const meta = [];
    if (!isLive) meta.push(`\`${dur}\``);
    meta.push(`**${vol}%** • Queue: **${session.queueList.length}** track${session.queueList.length !== 1 ? 's' : ''}`);
    meta.push(`-# Requested by ${requester?.displayName ?? requester?.username ?? 'Unknown'}`);

    const thumbnail = info.artworkUrl
      ?? requester?.displayAvatarURL?.({ size: 256 })
      ?? 'https://discord.com';

    const container = new ContainerBuilder()
      .addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnail))
      )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(meta.join('\n')));

    const loopNext = session.loop === 'off' ? 'track' : session.loop === 'track' ? 'queue' : 'off';
    const loopLabel = loopNext === 'off' ? 'Loop Off' : loopNext === 'track' ? 'Loop: Track' : 'Loop: Queue';

    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`music_pause:${guildId}`).setLabel(player?.paused ? 'Resume' : 'Pause').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`music_skip:${guildId}`).setLabel('Skip').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`music_loop:${guildId}`).setLabel(loopLabel).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`music_stop:${guildId}`).setLabel('Stop').setStyle(ButtonStyle.Danger),
    );

    container.addActionRowComponents(controls);
    return { components: [container], flags: MessageFlags.IsComponentsV2 as any };
  }

  _simpleComponents(content: string): { components: unknown[]; flags: number } {
    const c = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
    return { components: [c], flags: MessageFlags.IsComponentsV2 as any };
  }

  /* Dynamic presence */
  _updatePresencePlaying(guildId: string): void {
    if (!this._client) return;
    const session = this.sessions.get(guildId);
    if (!session?.current) return;
    const title = session.current.info?.title ?? 'Music';
    try {
      this._client.user!.setPresence({
        status: 'online',
        activities: [{ name: title, type: ActivityType.Listening }],
      });
    } catch { /* ignore */ }
  }

  _revertPresence(): void {
    if (!this._client) return;
    for (const [, session] of this.sessions) {
      if (session.current) return;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require('../config/config').default as typeof import('../config/config').default;
    const acts = cfg.presence.activities;
    if (!acts?.length) return;
    const act = acts[0];
    try {
      this._client.user!.setPresence({
        status: cfg.presence.status ?? 'online',
        activities: [{ name: act.name, type: act.type ?? ActivityType.Playing }],
      });
    } catch { /* ignore */ }
  }

  /* Player event wiring */
  _attachPlayerEvents(guildId: string, player: LavendePlayer): void {
    player.on('trackStart', async (_p: unknown, track: unknown) => {
      const t = track as LavendeTrack;
      const session = this.sessions.get(guildId);
      if (!session) return;

      if (session.leaveTimer) { clearTimeout(session.leaveTimer); session.leaveTimer = null; }

      const head = session.queueList[0];
      const matches = head && (
        head === t ||
        (head.info?.uri && head.info.uri === t.info?.uri) ||
        head.info?.title === t.info?.title
      );
      if (matches) session.queueList.shift();

      session.current = t;
      this._updatePresencePlaying(guildId);

      try {
        if (session.npMessage) await session.npMessage.delete().catch(() => {});
        session.npMessage = await (session.textChannel as any).send(
          this.buildNowPlayingPayload(guildId) as any
        );
      } catch (err) {
        logger.warn(`[Music] Could not send now-playing message: ${(err as Error).message}`);
      }
    });

    player.on('trackEnd', async (_p: unknown, track: unknown, reason: unknown) => {
      const session = this.sessions.get(guildId);
      if (!session) return;
      session.lastTrack = track as LavendeTrack;
      session.current = null;
      this._revertPresence();
      if (reason === 'stopped' || reason === 'replaced') return;
      if (reason === 'loadFailed') {
        (session.textChannel as any).send(
          this._simpleComponents(`Failed to load \`${(track as LavendeTrack)?.info?.title ?? 'track'}\` — skipping…`) as any
        ).catch(() => {});
      }
    });

    player.on('queueEnd', async () => {
      const session = this.sessions.get(guildId);
      if (!session) return;
      if (session.leaveTimer) clearTimeout(session.leaveTimer);

      const gs = this.getGuildSettings(guildId);

      /* Autoplay */
      if (gs.autoplay && session.lastTrack) {
        try {
          const query = `${session.lastTrack.info?.author ?? ''} ${session.lastTrack.info?.title ?? ''}`.trim();
          const result = await player.search(`ytsearch:${query}`, this._client?.user);
          // Autoplay runs unattended, so it screens strictly: no NSFW-channel
          // allowance, since nobody explicitly asked for this track.
          const related = result?.tracks?.filter(t => t.info?.uri !== session.lastTrack?.info?.uri);
          const tracks = filterTracks(related ?? [], false).allowed;
          if (tracks?.length) {
            const pick = tracks[Math.floor(Math.random() * Math.min(tracks.length, 5))];
            player.queue.add(pick);
            session.queueList.push(pick);
            await player.play();
            (session.textChannel as any).send(
              this._simpleComponents(`🎶 Autoplay: queuing **${pick.info?.title ?? 'Unknown'}**…`) as any
            ).catch(() => {});
            return;
          }
        } catch (err) {
          logger.warn(`[Music] Autoplay search failed: ${(err as Error).message}`);
        }
      }

      /* 24/7 mode */
      if (gs.alwaysOn) {
        this._revertPresence();
        (session.textChannel as any).send(
          this._simpleComponents('♻️ Queue finished. 24/7 mode is **on** — staying in the voice channel.') as any
        ).catch(() => {});
        return;
      }

      /* Normal: leave after timeout */
      this._revertPresence();
      session.leaveTimer = setTimeout(async () => {
        const tc = session.textChannel;
        await this.destroyPlayer(guildId);
        (tc as any).send(
          this._simpleComponents('👋 Queue finished — left the voice channel after 30 seconds of silence.') as any
        ).catch(() => {});
      }, musicConfig.autoLeaveMs);
    });

    player.on('error', async (_p: unknown, err: unknown) => {
      logger.error(`[Music] Native error in guild ${guildId}: ${(err as Error)?.message ?? err}`);
      const session = this.sessions.get(guildId);
      (session?.textChannel as any)?.send(
        this._simpleComponents(`Playback error: \`${(err as Error)?.message ?? 'unknown'}\``) as any
      ).catch(() => {});
    });
  }
}

export default new MusicManager();
