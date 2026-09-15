/**
 * @file Logger.ts
 * @description Premium terminal logger — coloured level badges, module tags, aligned columns.
 */

import fs   from 'fs';
import path from 'path';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const R  = '\x1b[0m';                               // reset
const B  = '\x1b[1m';                               // bold
const DIM = '\x1b[2m';                              // dim

const fg = (n: number) => `\x1b[38;5;${n}m`;       // 256-colour fg
const bg = (n: number) => `\x1b[48;5;${n}m`;       // 256-colour bg

const C = {
  // neutrals
  ts:      fg(240),   // timestamp dim grey
  pipe:    fg(238),   // separator very dark grey
  reset:   R,

  // message text
  msgInfo:  fg(252),
  msgWarn:  fg(222),
  msgError: fg(210),
  msgDebug: fg(242),
  msgReady: fg(121),
  msgCmd:   fg(183),

  // module name
  module: `${B}${fg(75)}`,   // bold sky-blue

  // level badge backgrounds + foregrounds
  badgeError:   `${bg(196)}${fg(255)}${B}`,   // bright red  / white bold
  badgeWarn:    `${bg(214)}${fg(16)}${B}`,    // orange      / black bold
  badgeInfo:    `${bg(33)}${fg(255)}${B}`,    // cobalt blue / white bold
  badgeDebug:   `${bg(238)}${fg(247)}${B}`,   // dark grey   / light grey bold
  badgeReady:   `${bg(35)}${fg(255)}${B}`,    // emerald     / white bold
  badgeSuccess: `${bg(40)}${fg(16)}${B}`,     // green       / black bold
  badgeCmd:     `${bg(93)}${fg(255)}${B}`,    // purple      / white bold
  badgeMusic:   `${bg(21)}${fg(255)}${B}`,    // deep blue   / white bold
};

// ── Constants ─────────────────────────────────────────────────────────────────
const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const MODULE_RE = /^\[([^\]]+)\]\s*/;

// ── Utility ───────────────────────────────────────────────────────────────────
function pad(str: string, len: number): string {
  // visible-length pad — strip ANSI before measuring
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, len - visible.length));
}

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ── Badge definitions ─────────────────────────────────────────────────────────
const BADGES: Record<string, { badge: string; msgColor: string; label: string }> = {
  error:   { badge: C.badgeError,   msgColor: C.msgError,  label: ' ERROR ' },
  warn:    { badge: C.badgeWarn,    msgColor: C.msgWarn,   label: '  WARN ' },
  info:    { badge: C.badgeInfo,    msgColor: C.msgInfo,   label: '  INFO ' },
  debug:   { badge: C.badgeDebug,   msgColor: C.msgDebug,  label: ' DEBUG ' },
  ready:   { badge: C.badgeReady,   msgColor: C.msgReady,  label: ' READY ' },
  success: { badge: C.badgeSuccess, msgColor: C.msgReady,  label: '  DONE ' },
  cmd:     { badge: C.badgeCmd,     msgColor: C.msgCmd,    label: '   CMD ' },
  music:   { badge: C.badgeMusic,   msgColor: C.msgInfo,   label: ' MUSIC ' },
};

// ── Logger class ──────────────────────────────────────────────────────────────
class Logger {
  private _level:   number;
  private _logFile: string | null;

  constructor(options: { level?: string; logFile?: string } = {}) {
    this._level   = LEVELS[options.level ?? 'info'] ?? 2;
    this._logFile = options.logFile ?? null;
    if (this._logFile) {
      fs.mkdirSync(path.dirname(path.resolve(this._logFile)), { recursive: true });
    }
  }

  // ── Core output ─────────────────────────────────────────────────────────────
  private _print(levelKey: string, rawMsg: string): void {
    const def = BADGES[levelKey] ?? BADGES.info;

    // Extract optional [Module] prefix
    const match = rawMsg.match(MODULE_RE);
    const module  = match ? match[1] : '';
    const content = match ? rawMsg.slice(match[0].length) : rawMsg;

    const ts         = `${C.ts}${timestamp()}${R}`;
    const badge      = `${def.badge}${def.label}${R}`;
    const sep        = `${C.pipe} │ ${R}`;
    const modulePart = module
      ? pad(`${C.module}${module}${R}`, 26)
      : ' '.repeat(18);
    const msg        = `${def.msgColor}${content}${R}`;

    const line = `  ${ts}  ${badge}${sep}${modulePart}  ${msg}`;
    process.stdout.write(line + '\n');

    // Plain file write
    if (this._logFile) {
      const plain = `[${timestamp()}] [${levelKey.toUpperCase().padStart(5)}] ${module ? `[${module}] ` : ''}${content}\n`;
      fs.appendFile(path.resolve(this._logFile), plain, () => {});
    }
  }

  private _log(level: string, ...args: unknown[]): void {
    if (LEVELS[level] > this._level) return;
    const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ');
    this._print(level, msg);
  }

  // ── Public methods ──────────────────────────────────────────────────────────
  error(...args: unknown[]): void { this._log('error', ...args); }
  warn(...args: unknown[]):  void { this._log('warn',  ...args); }
  info(...args: unknown[]):  void { this._log('info',  ...args); }
  debug(...args: unknown[]): void { this._log('debug', ...args); }

  success(msg: string): void {
    this._print('success', msg);
  }

  ready(msg: string): void {
    this._print('ready', msg);
  }

  music(msg: string): void {
    this._print('music', msg);
  }

  command(name: string, user: string, guild: string): void {
    this._print('cmd', `${B}/${name}${R}${C.msgCmd}  ›  ${user}  @  ${guild}`);
  }

  // ── Divider ─────────────────────────────────────────────────────────────────
  divider(label?: string): void {
    const line = '─'.repeat(56);
    if (label) {
      const half = Math.floor((56 - label.length - 2) / 2);
      const bar  = '─'.repeat(half) + ` ${label} ` + '─'.repeat(56 - half - label.length - 2);
      process.stdout.write(`\n  ${C.pipe}${bar}${R}\n\n`);
    } else {
      process.stdout.write(`\n  ${C.pipe}${DIM}${line}${R}\n\n`);
    }
  }

  // ── Startup banner ──────────────────────────────────────────────────────────
  banner(name: string, version: string, extra?: string): void {
    const inner  = 44;
    const top    = `╔${'═'.repeat(inner)}╗`;
    const bot    = `╚${'═'.repeat(inner)}╝`;
    const blank  = `║${' '.repeat(inner)}║`;
    const centre = (s: string) => {
      const vis = s.replace(/\x1b\[[0-9;]*m/g, '');
      const pad = Math.max(0, inner - vis.length);
      const l   = Math.floor(pad / 2);
      const r   = pad - l;
      return `║${' '.repeat(l)}${s}${' '.repeat(r)}║`;
    };

    const title   = `${fg(75)}${B}${name}${R}`;
    const ver     = `${fg(245)}v${version}${R}`;
    const subtitle = `${fg(245)}Discord.js v14  ·  TypeScript${R}`;

    process.stdout.write('\n');
    process.stdout.write(`  ${fg(33)}${top}${R}\n`);
    process.stdout.write(`  ${fg(33)}${blank}${R}\n`);
    process.stdout.write(`  ${fg(33)}${centre(`${title}  ${ver}`)}${R}\n`);
    process.stdout.write(`  ${fg(33)}${centre(subtitle)}${R}\n`);
    if (extra) {
      process.stdout.write(`  ${fg(33)}${centre(`${fg(242)}${extra}${R}`)}${R}\n`);
    }
    process.stdout.write(`  ${fg(33)}${blank}${R}\n`);
    process.stdout.write(`  ${fg(33)}${bot}${R}\n`);
    process.stdout.write('\n');
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
export default new Logger({
  level:   process.env.LOG_LEVEL ?? 'info',
  logFile: 'logs/bot.log',
});
