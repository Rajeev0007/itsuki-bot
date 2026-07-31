/**
 * @file MusicUtil.ts
 * @description Shared helpers for music commands.
 */

import {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import musicConfig from '../config/music';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DefaultSources } = require('lavende') as { DefaultSources: Record<string, string> };

const URL_REGEX = /^https?:\/\//i;
const SOURCE_PREFIX_REGEX = /^([a-z .]+):/i;

export function buildSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (URL_REGEX.test(trimmed)) return trimmed;

  const match = trimmed.match(SOURCE_PREFIX_REGEX);
  if (match && DefaultSources[match[1].toLowerCase()]) {
    const source = DefaultSources[match[1].toLowerCase()];
    const rest = trimmed.slice(match[0].length).trim();
    return `${source}:${rest}`;
  }

  return `${musicConfig.defaultSearchPrefix}${trimmed}`;
}

export function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function progressBar(current: number, total: number, len = 20): string {
  if (!total || total <= 0) return '';
  const progress = Math.min(Math.floor((current / total) * len), len - 1);
  return '▰'.repeat(progress) + '▶' + '▱'.repeat(len - progress - 1);
}

export interface MusicCheckResult {
  error: string | null;
  session: import('../managers/MusicManager').GuildSession | null;
  player: unknown;
}

export function musicCheck(
  interaction: ChatInputCommandInteraction,
  manager: any,
  opts: { needsQueue?: boolean; needsPlaying?: boolean } = {},
): MusicCheckResult {
  const member = interaction.member as { voice?: { channel?: { id: string } } } | null;
  const guild = interaction.guild;

  if (!member?.voice?.channel) {
    return { error: '❌ You need to be in a voice channel first.', session: null, player: null };
  }

  const session = manager.getSession(guild!.id);
  const player = manager.getPlayer(guild!.id);

  if (opts.needsQueue && !session) {
    return { error: '🔇 Nothing is playing right now.', session: null, player: null };
  }
  if (opts.needsPlaying && (!session || !session.current)) {
    return { error: '🔇 Nothing is playing right now.', session: null, player: null };
  }
  if (session && member.voice.channel.id !== session.voiceChannel.id) {
    return {
      error: `You must be in <#${session.voiceChannel.id}> to use music commands.`,
      session: null,
      player: null,
    };
  }

  return { error: null, session, player };
}

export function musicError(msg: string) {
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(String(msg)));
  return { components: [container] };
}

export function musicSuccess(msg: string) {
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(msg));
  return { components: [container] };
}
