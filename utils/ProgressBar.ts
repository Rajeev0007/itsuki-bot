/**
 * @file ProgressBar.ts
 * @description Generate ASCII/emoji progress bars for use in Discord messages.
 */

const ProgressBar = {
  /** Ratio guarded against max <= 0, which otherwise yields NaN or Infinity. */
  ratio(current: number, max: number): number {
    const c = Number(current) || 0;
    const m = Number(max) || 0;
    if (m <= 0) return 0;
    return Math.min(Math.max(c / m, 0), 1);
  },

  bar(current: number, max: number, length = 10, filled = '█', empty = '░'): string {
    const pct = this.ratio(current, max);
    const filledN = Math.round(pct * length);
    const emptyN = Math.max(0, length - filledN);
    return filled.repeat(filledN) + empty.repeat(emptyN);
  },

  labeled(current: number, max: number, length = 10): string {
    const pct = this.ratio(current, max);
    return `${this.bar(current, max, length)} **${Math.round(pct * 100)}%**`;
  },

  xpBar(xp: number, needed: number, length = 12): string {
    const bar = this.bar(xp, needed, length, '▰', '▱');
    return `${bar} \`${xp.toLocaleString()}/${needed.toLocaleString()} XP\``;
  },

  /** Both halves used empty strings, so this always returned "". */
  heartBar(current: number, max: number): string {
    const filled = Math.round(this.ratio(current, max) * 5);
    return '❤️'.repeat(filled) + '🖤'.repeat(Math.max(0, 5 - filled));
  },

  /** Alias used by some commands */
  create(current: number, max: number, length = 10): string {
    return this.bar(current, max, length);
  },
};

export default ProgressBar;
