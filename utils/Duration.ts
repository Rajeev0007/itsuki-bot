/**
 * @file Duration.ts
 * @description Parses and formats human-readable durations for moderation.
 */

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Discord's hard cap on communication_disabled_until is 28 days. */
export const MAX_TIMEOUT_MS = 28 * 86_400_000;

/**
 * Parses durations like `10m`, `1h30m`, `7d`, `45` (bare = seconds).
 * Returns null when nothing could be parsed.
 */
export function parseDuration(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().toLowerCase().replace(/\s+/g, '');
  if (!raw) return null;

  // A bare number is treated as seconds.
  if (/^\d+$/.test(raw)) {
    const secs = Number(raw);
    return Number.isFinite(secs) && secs > 0 ? secs * 1_000 : null;
  }

  // Support compound values: 1h30m, 2d12h…
  const matches = raw.match(/\d+[smhdw]/g);
  if (!matches) return null;

  let total = 0;
  for (const part of matches) {
    const value = Number(part.slice(0, -1));
    const unit = UNITS[part.slice(-1)];
    if (!Number.isFinite(value) || !unit) return null;
    total += value * unit;
  }
  // Reject anything that overflowed into nonsense.
  return total > 0 && Number.isSafeInteger(total) ? total : null;
}

/** Formats a millisecond duration as "1d 2h 30m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(Number(ms) || 0));
  if (total < 1_000) return '0s';

  const days    = Math.floor(total / 86_400_000);
  const hours   = Math.floor((total % 86_400_000) / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);

  const parts: string[] = [];
  if (days)    parts.push(`${days}d`);
  if (hours)   parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds && !days) parts.push(`${seconds}s`);
  return parts.join(' ') || '0s';
}
