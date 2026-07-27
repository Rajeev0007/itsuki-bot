/**
 * @file ProgressBar.ts
 * @description Generate ASCII/emoji progress bars for use in Discord messages.
 */

const ProgressBar = {
  bar(current: number, max: number, length = 10, filled = '█', empty = '░'): string {
    const pct = Math.min(Math.max(current / max, 0), 1);
    const filledN = Math.round(pct * length);
    const emptyN = length - filledN;
    return filled.repeat(filledN) + empty.repeat(emptyN);
  },

  labeled(current: number, max: number, length = 10): string {
    const pct = Math.min(Math.max(current / max, 0), 1);
    return `${this.bar(current, max, length)} **${Math.round(pct * 100)}%**`;
  },

  xpBar(xp: number, needed: number, length = 12): string {
    const bar = this.bar(xp, needed, length, '▰', '▱');
    return `${bar} \`${xp.toLocaleString()}/${needed.toLocaleString()} XP\``;
  },

  heartBar(current: number, max: number): string {
    const filled = Math.round((current / max) * 5);
    return ''.repeat(filled) + ''.repeat(5 - filled);
  },

  /** Alias used by some commands */
  create(current: number, max: number, length = 10): string {
    return this.bar(current, max, length);
  },
};

export default ProgressBar;
