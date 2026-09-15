/**
 * @file Formatter.ts
 * @description Utility functions for formatting numbers, time, and text.
 */

import config from '../config/config';

const Formatter = {
  coins(n: number): string {
    return `${Number(n).toLocaleString('en-US')} ${config.economy.currency}`;
  },

  number(n: number): string {
    return Number(n).toLocaleString('en-US');
  },

  /** Short form (1.2K / 3.4M). Handles negatives, which used to fall through. */
  compact(n: number): string {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
    if (abs >= 1_000_000)     return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000)         return `${sign}${(abs / 1_000).toFixed(1)}K`;
    return String(v);
  },

  duration(ms: number): string {
    const secs = Math.floor(ms / 1000);
    const mins = Math.floor(secs / 60);
    const hrs  = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    if (days > 0) return `${days}d ${hrs % 24}h ${mins % 60}m`;
    if (hrs  > 0) return `${hrs}h ${mins % 60}m ${secs % 60}s`;
    if (mins > 0) return `${mins}m ${secs % 60}s`;
    return `${secs}s`;
  },

  relativeTime(date: Date | number): string {
    const ts = Math.floor(new Date(date).getTime() / 1000);
    return `<t:${ts}:R>`;
  },

  fullTime(date: Date | number): string {
    const ts = Math.floor(new Date(date).getTime() / 1000);
    return `<t:${ts}:F>`;
  },

  capitalize(str: string): string {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  },

  truncate(str: string, max = 100): string {
    return str.length > max ? str.slice(0, max - 3) + '...' : str;
  },

  randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  },

  randomItem<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  },

  weightedRandom<T>(items: T[], weights: number[]): T {
    const total = weights.reduce((a, b) => a + b, 0);
    let rand    = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
      rand -= weights[i];
      if (rand <= 0) return items[i];
    }
    return items[items.length - 1];
  },

  ordinal(n: number): string {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  },

  /**
   * Parses a user-supplied amount: a plain number, shorthand (`10k`, `2.5m`),
   * or the keywords `all` / `half` relative to `max`.
   * Returns null when the input can't be interpreted.
   */
  parseAmount(input: string | null | undefined, max: number): number | null {
    if (input === null || input === undefined) return null;
    const s = String(input).toLowerCase().trim().replace(/[,_]/g, '');
    if (!s) return null;
    const cap = Math.max(0, Math.floor(Number(max) || 0));
    if (s === 'all' || s === 'max')  return cap;
    if (s === 'half') return Math.floor(cap / 2);
    const m = s.match(/^(\d+(?:\.\d+)?)(k|m|b)?$/);
    if (!m) return null;
    const num = parseFloat(m[1]);
    if (!Number.isFinite(num)) return null;
    const mul = ({ k: 1_000, m: 1_000_000, b: 1_000_000_000 } as Record<string, number>)[m[2]] ?? 1;
    const value = Math.floor(num * mul);
    // Guard against overflow to Infinity from absurd input like "999999999b".
    return Number.isSafeInteger(value) ? value : null;
  },
};

export default Formatter;
