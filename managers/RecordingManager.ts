/**
 * @file RecordingManager.ts
 * @description Voice channel recording: consent tracking, per-speaker capture,
 * time-aligned mixing and WAV output.
 *
 * ── Design decisions worth knowing ──────────────────────────────────────────
 *
 * NO ffmpeg. Discord delivers 48 kHz stereo Opus; we decode to PCM, downmix to
 * mono, downsample to 24 kHz and emit a WAV file (a 44-byte header plus raw
 * PCM). That removes ffmpeg and any Opus *encoder* from the dependency list —
 * only a decoder is needed. Voice at 24 kHz mono is ~2.9 MB/minute, which keeps
 * a sensible recording inside Discord's upload limit.
 *
 * TIME-ALIGNED MIXING. Discord only sends packets while a user is actually
 * speaking, so naively concatenating a user's stream collapses every silent gap
 * and desynchronises them from everyone else. Each speaking burst is instead
 * written at a byte offset derived from wall-clock elapsed time, into a shared
 * Int32 accumulator. Summing in Int32 avoids clipping mid-mix; the result is
 * clamped to Int16 once at the end.
 *
 * CONSENT IS STRUCTURAL. A user's audio stream is never subscribed to unless
 * they have opted in. Non-consenting speakers aren't recorded-then-discarded —
 * they are never captured in the first place.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import prism from 'prism-media';
import type { Guild, GuildMember, VoiceBasedChannel } from 'discord.js';
import logger from '../utils/Logger';
import musicManager from './MusicManager';

/** Discord's voice output format. */
const SOURCE_RATE = 48_000;
const SOURCE_CHANNELS = 2;
/** Output: mono at 24 kHz — /2 rate and /2 channels are both integer factors. */
const OUT_RATE = 24_000;
const RATE_DIVISOR = SOURCE_RATE / OUT_RATE; // 2

export const DEFAULT_MAX_MINUTES = 5;
export const MAX_MAX_MINUTES = 30;

export interface RecordingSession {
  guildId: string;
  channelId: string;
  channelName: string;
  requesterId: string;
  startedAt: number;
  maxDurationMs: number;
  /** Users who have explicitly opted in. */
  consented: Set<string>;
  /** Users seen speaking who had NOT consented, for the summary. */
  skipped: Set<string>;
  /** Users actually captured. */
  captured: Set<string>;
  /** Mono Int32 accumulator at OUT_RATE. */
  mix: Int32Array;
  /** Highest sample index written, so trailing silence isn't emitted. */
  written: number;
  /** Per-user active subscription guard. */
  active: Set<string>;
  connection: unknown;
  timer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
}

/**
 * Minimal readable-stream shape.
 *
 * Declared locally rather than using `NodeJS.ReadableStream` so this module
 * doesn't depend on the @types/node namespace being in scope.
 */
interface ReadableLike {
  on: (event: string, cb: (...args: never[]) => void) => unknown;
  pipe: (destination: unknown) => ReadableLike;
}

const sessions = new Map<string, RecordingSession>();

export type RecordResult = { ok: boolean; reason?: string; session?: RecordingSession };

/** Builds a 16-bit mono PCM WAV file from Int32 accumulated samples. */
export function encodeWav(mix: Int32Array, sampleCount: number, sampleRate = OUT_RATE): Buffer {
  const samples = Math.max(0, Math.min(sampleCount, mix.length));
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);          // fmt chunk size
  buffer.writeUInt16LE(1, 20);           // PCM
  buffer.writeUInt16LE(1, 22);           // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 2 bytes)
  buffer.writeUInt16LE(2, 32);           // block align
  buffer.writeUInt16LE(16, 34);          // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  // Clamp the summed Int32 mix into Int16 once, at the end.
  for (let i = 0; i < samples; i++) {
    const v = mix[i];
    buffer.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, 44 + i * 2);
  }
  return buffer;
}

/**
 * Downmixes 48 kHz stereo s16le to 24 kHz mono and adds it into the mix at
 * `startSample`.
 *
 * Both conversions are integer-factor, so this is a straight average of the two
 * channels followed by an average of adjacent frame pairs — no resampler needed.
 */
function mixInto(session: RecordingSession, pcm: Buffer, startSample: number): number {
  const frameBytes = 2 * SOURCE_CHANNELS;           // 4
  const frames = Math.floor(pcm.length / frameBytes);
  const outFrames = Math.floor(frames / RATE_DIVISOR);
  const mix = session.mix;

  let written = 0;
  for (let o = 0; o < outFrames; o++) {
    const target = startSample + o;
    // Ran past the allocated ceiling — stop rather than grow unboundedly.
    if (target >= mix.length) break;

    let acc = 0;
    for (let s = 0; s < RATE_DIVISOR; s++) {
      const base = (o * RATE_DIVISOR + s) * frameBytes;
      // Average the stereo pair into mono.
      acc += (pcm.readInt16LE(base) + pcm.readInt16LE(base + 2)) / 2;
    }
    mix[target] += Math.round(acc / RATE_DIVISOR);
    written = target + 1;
  }
  return written;
}

const RecordingManager = {
  DEFAULT_MAX_MINUTES, MAX_MAX_MINUTES,

  get(guildId: string): RecordingSession | null {
    return sessions.get(guildId) ?? null;
  },

  isRecording(guildId: string): boolean {
    return sessions.has(guildId);
  },

  /**
   * Starts a session.
   *
   * Refuses when music is active: a guild has exactly one voice connection, so
   * lavende's playback connection and a receive connection cannot coexist.
   */
  async start(opts: {
    guild: Guild;
    channel: VoiceBasedChannel;
    requesterId: string;
    maxMinutes: number;
  }): Promise<RecordResult> {
    const { guild, channel, requesterId } = opts;

    if (sessions.has(guild.id)) {
      return { ok: false, reason: 'A recording is already running in this server. Use `/record stop` first.' };
    }
    if (musicManager.getSession(guild.id)?.current) {
      return {
        ok: false,
        reason: 'I am currently playing music here. A guild only supports one voice connection, so stop playback first (`/stop`).',
      };
    }

    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has('Connect')) {
      return { ok: false, reason: `I need **Connect** permission in ${channel}.` };
    }

    const maxMinutes = Math.max(1, Math.min(Math.floor(opts.maxMinutes) || DEFAULT_MAX_MINUTES, MAX_MAX_MINUTES));
    const maxDurationMs = maxMinutes * 60_000;
    // Preallocated so mixing never has to reallocate mid-stream.
    const mix = new Int32Array(Math.ceil((maxDurationMs / 1000) * OUT_RATE) + OUT_RATE);

    let connection;
    try {
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator as never,
        // MUST be false. A self-deafened connection receives no audio at all,
        // which is the single most common reason recording silently produces an
        // empty file.
        selfDeaf: false,
        selfMute: true,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      try { (connection as { destroy?: () => void } | undefined)?.destroy?.(); } catch { /* ignore */ }
      return { ok: false, reason: `Could not join the voice channel: ${(err as Error).message}` };
    }

    const session: RecordingSession = {
      guildId: guild.id,
      channelId: channel.id,
      channelName: channel.name,
      requesterId,
      startedAt: Date.now(),
      maxDurationMs,
      consented: new Set<string>(),
      skipped: new Set<string>(),
      captured: new Set<string>(),
      mix,
      written: 0,
      active: new Set<string>(),
      connection,
      timer: null,
      stopping: false,
    };
    sessions.set(guild.id, session);

    this._attach(session);

    // Hard stop at the cap so a forgotten recording can't run indefinitely.
    session.timer = setTimeout(() => {
      logger.info(`[Record] Auto-stopping ${guild.id} at the ${maxMinutes} minute cap.`);
      void this.stop(guild.id).catch(() => { /* handled by caller */ });
    }, maxDurationMs);
    if (typeof session.timer.unref === 'function') session.timer.unref();

    logger.info(`[Record] Started in ${guild.id}/${channel.id} (cap ${maxMinutes}m) by ${requesterId}`);
    return { ok: true, session };
  },

  /** Subscribes to consenting speakers as they start talking. */
  _attach(session: RecordingSession): void {
    const receiver = (session.connection as {
      receiver: {
        speaking: { on: (e: 'start', cb: (userId: string) => void) => void };
        subscribe: (userId: string, opts: unknown) => ReadableLike;
      };
    }).receiver;

    receiver.speaking.on('start', (userId: string) => {
      if (session.stopping) return;

      // Consent gate — the stream is never subscribed to without opt-in.
      if (!session.consented.has(userId)) {
        session.skipped.add(userId);
        return;
      }
      // One subscription per user; 'start' fires again on every burst.
      if (session.active.has(userId)) return;
      session.active.add(userId);

      // Offset is computed from elapsed time, which is what keeps speakers
      // aligned with each other across their silent gaps.
      const burstStartSample = Math.floor(((Date.now() - session.startedAt) / 1000) * OUT_RATE);

      let opusStream: ReadableLike;
      try {
        opusStream = receiver.subscribe(userId, {
          // Close the stream after a short silence so the next burst gets a
          // fresh, correctly-offset subscription.
          end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
        });
      } catch (err) {
        logger.debug(`[Record] subscribe failed for ${userId}: ${(err as Error).message}`);
        session.active.delete(userId);
        return;
      }

      const decoder = new prism.opus.Decoder({
        rate: SOURCE_RATE, channels: SOURCE_CHANNELS, frameSize: 960,
      });

      let cursor = burstStartSample;
      const pcmStream = opusStream.pipe(decoder);

      pcmStream.on('data', ((chunk: Buffer) => {
        if (session.stopping) return;
        // Within a burst the audio is continuous, so advance sequentially from
        // the burst's start offset rather than re-reading the clock (which
        // would jitter and drop samples).
        const end = mixInto(session, chunk, cursor);
        if (end > 0) {
          cursor += Math.floor(chunk.length / (2 * SOURCE_CHANNELS) / RATE_DIVISOR);
          if (end > session.written) session.written = end;
        }
        session.captured.add(userId);
      }) as never);

      const cleanup = () => { session.active.delete(userId); };
      pcmStream.on('end', cleanup as never);
      pcmStream.on('error', ((err: Error) => {
        logger.debug(`[Record] decode error for ${userId}: ${err.message}`);
        cleanup();
      }) as never);
      // Also release the slot if the opus source itself errors, or a user who
      // disconnects mid-burst would never be re-subscribable.
      opusStream.on('error', cleanup as never);
    });
  },

  /** Marks a user as consenting. Returns false if already opted in. */
  consent(guildId: string, userId: string): boolean {
    const session = sessions.get(guildId);
    if (!session) return false;
    if (session.consented.has(userId)) return false;
    session.consented.add(userId);
    session.skipped.delete(userId);
    return true;
  },

  /** Withdraws consent. Already-captured audio stays, future audio does not. */
  revoke(guildId: string, userId: string): boolean {
    const session = sessions.get(guildId);
    if (!session) return false;
    return session.consented.delete(userId);
  },

  /**
   * Stops the session and returns the encoded WAV.
   *
   * Returns null audio when nothing was captured, which is the normal outcome
   * if nobody consented.
   */
  async stop(guildId: string): Promise<{
    ok: boolean; reason?: string;
    audio?: Buffer | null; session?: RecordingSession; durationMs?: number;
  }> {
    const session = sessions.get(guildId);
    if (!session) return { ok: false, reason: 'Nothing is being recorded in this server.' };
    if (session.stopping) return { ok: false, reason: 'That recording is already stopping.' };

    session.stopping = true;
    if (session.timer) clearTimeout(session.timer);

    // Give in-flight decoder chunks a moment to land before encoding.
    await new Promise((r) => setTimeout(r, 300));

    try {
      (session.connection as { destroy: () => void }).destroy();
    } catch (err) {
      logger.debug(`[Record] connection destroy: ${(err as Error).message}`);
    }
    sessions.delete(guildId);

    const durationMs = Date.now() - session.startedAt;
    const audio = session.written > 0
      ? encodeWav(session.mix, session.written)
      : null;

    logger.info(
      `[Record] Stopped ${guildId} — ${(durationMs / 1000).toFixed(0)}s, `
      + `${session.captured.size} captured, ${session.skipped.size} skipped, `
      + `${audio ? `${(audio.length / 1024 / 1024).toFixed(2)} MB` : 'no audio'}`,
    );

    return { ok: true, audio, session, durationMs };
  },

  /** Stops every session — used on shutdown so connections aren't orphaned. */
  async stopAll(): Promise<number> {
    const ids = [...sessions.keys()];
    for (const id of ids) await this.stop(id).catch(() => { /* best effort */ });
    return ids.length;
  },

  /** Members currently in the recorded channel, excluding bots. */
  humanListeners(guild: Guild, channelId: string): GuildMember[] {
    const channel = guild.channels.cache.get(channelId);
    const members = (channel as VoiceBasedChannel | undefined)?.members;
    if (!members) return [];
    return [...members.values()].filter((m) => !m.user.bot);
  },
};

export default RecordingManager;
