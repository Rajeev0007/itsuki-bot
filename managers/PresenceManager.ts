/**
 * @file PresenceManager.ts
 * @description Owns the bot's presence (status + activity) so it can be changed
 * live from the owner panel and survive a restart.
 *
 * Why this exists:
 *   The presence rotation used to live inline in the ready event, driven purely
 *   by `config.presence`. That meant the only way to change the bot's status or
 *   activity was to edit the config file and restart — and any live change made
 *   via `client.user.setPresence()` was silently overwritten by the next
 *   rotation tick.
 *
 * Behaviour:
 *   - mode 'rotate' → cycles config.presence.activities, yielding while music
 *     is playing (MusicManager sets its own now-playing presence).
 *   - mode 'custom' → applies the owner's fixed presence and takes precedence
 *     over both the rotation and the music override, because it was set
 *     deliberately.
 *   State is persisted to settings.json and restored on boot.
 */

import { ActivityType, type Client, type PresenceStatusData } from 'discord.js';
import { getStore } from '../database/Store';
import config from '../config/config';
import logger from '../utils/Logger';
import musicManager from './MusicManager';

const settingsDB = getStore('settings');

export type PresenceMode = 'rotate' | 'custom';

/** Activity types the panel can set, mapped to discord.js enum values. */
export const ACTIVITY_TYPES: Array<{ id: string; label: string; value: number }> = [
  { id: 'playing',   label: 'Playing',     value: Number(ActivityType.Playing) },
  { id: 'listening', label: 'Listening to', value: Number(ActivityType.Listening) },
  { id: 'watching',  label: 'Watching',    value: Number(ActivityType.Watching) },
  { id: 'competing', label: 'Competing in', value: Number(ActivityType.Competing) },
  { id: 'streaming', label: 'Streaming',   value: Number(ActivityType.Streaming) },
  { id: 'custom',    label: 'Custom Status', value: Number(ActivityType.Custom) },
];

export const STATUS_CHOICES: Array<{ id: PresenceStatusData; label: string }> = [
  { id: 'online',    label: 'Online' },
  { id: 'idle',      label: 'Idle' },
  { id: 'dnd',       label: 'Do Not Disturb' },
  { id: 'invisible', label: 'Invisible' },
];

export interface PresenceState {
  mode: PresenceMode;
  status: PresenceStatusData;
  /** Activity type id from ACTIVITY_TYPES. */
  activityType: string;
  activityName: string;
  /** Only used by the Streaming type; Discord requires a Twitch/YT URL. */
  streamUrl: string | null;
}

function defaultState(): PresenceState {
  return {
    mode: 'rotate',
    status: (config.presence.status as PresenceStatusData) ?? 'online',
    activityType: 'playing',
    activityName: '',
    streamUrl: null,
  };
}

let state: PresenceState = defaultState();
let client: Client | null = null;
let rotationTimer: ReturnType<typeof setInterval> | null = null;
let rotationIndex = 0;

function activityTypeValue(id: string): number {
  return ACTIVITY_TYPES.find((t) => t.id === id)?.value ?? Number(ActivityType.Playing);
}

/** True while any guild is actively playing a track. */
function musicIsPlaying(): boolean {
  for (const [, session] of musicManager.sessions) {
    if (session.current) return true;
  }
  return false;
}

const PresenceManager = {
  ACTIVITY_TYPES, STATUS_CHOICES,

  getState(): PresenceState {
    return { ...state };
  },

  /** Loads persisted state, applies it, and starts the rotation loop. */
  async init(c: Client): Promise<void> {
    client = c;
    try {
      const stored = await settingsDB.get('presence') as Partial<PresenceState> | undefined;
      if (stored && typeof stored === 'object') {
        state = { ...defaultState(), ...stored };
      }
    } catch (err) {
      logger.warn(`[Presence] Could not load saved presence: ${(err as Error).message}`);
    }

    this.apply();
    if (rotationTimer) clearInterval(rotationTimer);
    rotationTimer = setInterval(() => this.tick(), config.presence.activityInterval);
    if (typeof rotationTimer.unref === 'function') rotationTimer.unref();

    logger.info(`[Presence] Mode: ${state.mode}${state.mode === 'custom' ? ` — "${state.activityName}"` : ''}`);
  },

  async persist(): Promise<void> {
    try {
      await settingsDB.set('presence', state);
    } catch (err) {
      logger.warn(`[Presence] Failed to save presence: ${(err as Error).message}`);
    }
  },

  /** Applies the current state to the gateway immediately. */
  apply(): void {
    if (!client?.user) return;

    if (state.mode === 'custom') {
      // A deliberate override wins over the music presence.
      const type = activityTypeValue(state.activityType);
      const name = state.activityName || 'Itsuki';
      try {
        client.user.setPresence({
          status: state.status,
          activities: [{
            name,
            type: type as never,
            // Streaming is the only type Discord accepts a URL for, and it
            // rejects the activity outright if the URL isn't Twitch/YouTube.
            ...(state.activityType === 'streaming' && state.streamUrl
              ? { url: state.streamUrl }
              : {}),
          }],
        });
      } catch (err) {
        logger.warn(`[Presence] setPresence failed: ${(err as Error).message}`);
      }
      return;
    }

    // Rotation mode — yield to the music now-playing presence.
    if (musicIsPlaying()) return;
    const activities = config.presence.activities;
    if (!activities.length) {
      client.user.setPresence({ status: state.status, activities: [] });
      return;
    }
    const act = activities[rotationIndex % activities.length];
    client.user.setPresence({
      status: state.status,
      activities: [{ name: act.name, type: (act.type ?? ActivityType.Playing) as never }],
    });
  },

  /** Rotation tick. Advances only when a rotation frame was actually shown. */
  tick(): void {
    if (state.mode === 'custom') {
      // Re-assert periodically: Discord occasionally drops presence on
      // reconnect, and this restores the owner's choice without a restart.
      this.apply();
      return;
    }
    if (musicIsPlaying()) return;
    this.apply();
    // Incrementing only here means the rotation doesn't silently skip entries
    // while music is playing.
    rotationIndex++;
  },

  /** Sets a fixed presence and stops the rotation. */
  async setCustom(opts: {
    activityType?: string;
    activityName?: string;
    streamUrl?: string | null;
    status?: PresenceStatusData;
  }): Promise<PresenceState> {
    state = {
      ...state,
      mode: 'custom',
      activityType: opts.activityType ?? state.activityType,
      activityName: opts.activityName ?? state.activityName,
      streamUrl: opts.streamUrl !== undefined ? opts.streamUrl : state.streamUrl,
      status: opts.status ?? state.status,
    };
    this.apply();
    await this.persist();
    return this.getState();
  },

  /** Returns to cycling config.presence.activities. */
  async setRotate(): Promise<PresenceState> {
    state = { ...state, mode: 'rotate' };
    this.apply();
    await this.persist();
    return this.getState();
  },

  /** Changes only the online status, keeping the current mode. */
  async setStatus(status: PresenceStatusData): Promise<PresenceState> {
    state = { ...state, status };
    this.apply();
    await this.persist();
    return this.getState();
  },

  /** Human-readable summary for the panel. */
  describe(): string {
    if (state.mode === 'rotate') {
      const count = config.presence.activities.length;
      return `Rotating ${count} preset activit${count === 1 ? 'y' : 'ies'}`;
    }
    const label = ACTIVITY_TYPES.find((t) => t.id === state.activityType)?.label ?? 'Playing';
    return state.activityName
      ? `${label} ${state.activityName}`
      : `${label} (no text set)`;
  },
};

export default PresenceManager;
