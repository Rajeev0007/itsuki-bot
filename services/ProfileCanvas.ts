/**
 * @file ProfileCanvas.ts
 * @description Generates a profile card image using node-canvas.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createCanvas, loadImage } = require('canvas') as {
  createCanvas: (w: number, h: number) => Canvas;
  loadImage: (src: Buffer | string) => Promise<CanvasImage>;
};
import { fetchBuffer } from './canvas/CanvasKit';
import { drawText, preloadEmoji, collectStrings } from './canvas/EmojiText';

interface Canvas {
  getContext: (type: '2d') => CanvasRenderingContext2D;
  toBuffer: (mime: string) => Buffer;
}
interface CanvasImage { width: number; height: number }
interface CanvasRenderingContext2D {
  fillStyle: string | CanvasGradient;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  fillText: (t: string, x: number, y: number) => void;
  strokeText: (t: string, x: number, y: number) => void;
  stroke: () => void;
  fill: () => void;
  beginPath: () => void;
  closePath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  arc: (x: number, y: number, r: number, start: number, end: number) => void;
  quadraticCurveTo: (cpx: number, cpy: number, x: number, y: number) => void;
  clip: () => void;
  save: () => void;
  restore: () => void;
  drawImage: (img: CanvasImage, x: number, y: number, w: number, h: number) => void;
  measureText: (t: string) => { width: number };
  createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => CanvasGradient;
}
interface CanvasGradient { addColorStop: (offset: number, color: string) => void }

const W = 900, H = 300;

const COLORS = {
  bg: '#0f0f1a', bgCard: '#16162a', accent: '#5865f2',
  accentGlow: 'rgba(88,101,242,0.25)', bar: '#2d2d4e', barFill: '#5865f2',
  text: '#ffffff', textMuted: '#8b8ba7', textDim: '#4a4a6a',
  gold: '#ffd700', stat: '#e0e0ff',
};

/*
 * The local fetchBuffer that used to live here has been removed in favour of the
 * shared one in ./canvas/CanvasKit, which this was an un-migrated copy of.
 *
 * The copy could HANG FOREVER: Node's `timeout` option only arms
 * socket.setTimeout and emits 'timeout' — it does not abort the request — and no
 * 'timeout' listener or req.destroy() was registered. On a stalled connection the
 * promise never settled, so /profile never replied at all and the user just saw
 * the interaction time out ("application did not respond"). A hang is not an
 * exception, so the try/catch around the call could not save it.
 *
 * It also had no status check (a 404 HTML body was handed to loadImage), no
 * redirect limit (two hosts pointing at each other recursed forever), no byte
 * cap, and it leaked the socket on redirects by not draining the response.
 */

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

export interface ProfileOptions {
  username: string; avatarURL: string;
  level: number; xp: number; xpNeeded: number; prestige: number;
  wallet: number; bank: number; gamesWon: number; gamesPlayed: number;
  title: string; memberSince: number | string;
}

export async function generateProfile(opts: ProfileOptions): Promise<Buffer> {
  // Emoji must be fetched before drawing, because the draw helpers are
  // synchronous. Collected generically from the options so adding a field later
  // cannot silently leave its emoji unrendered.
  await preloadEmoji(...collectStrings(opts));
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  /* Background */
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, '#0d0d1f');
  bgGrad.addColorStop(0.5, '#111128');
  bgGrad.addColorStop(1, '#0a0a18');
  ctx.fillStyle = bgGrad;
  roundRect(ctx, 0, 0, W, H, 18);
  ctx.fill();

  const sideGlow = ctx.createLinearGradient(0, 0, 220, 0);
  sideGlow.addColorStop(0, 'rgba(88,101,242,0.12)');
  sideGlow.addColorStop(1, 'rgba(88,101,242,0)');
  ctx.fillStyle = sideGlow;
  roundRect(ctx, 0, 0, 220, H, 18);
  ctx.fill();

  ctx.strokeStyle = 'rgba(88,101,242,0.30)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(210, 24);
  ctx.lineTo(210, H - 24);
  ctx.stroke();

  /* Avatar */
  const AX = 105, AY = H / 2, AR = 66;
  let avatarImg: CanvasImage | null = null;
  try {
    // No '?size=256' appended here: displayAvatarURL({ size }) already returns
    // "…/avatar.png?size=256", so adding it again produced
    // "?size=256?size=256" — a malformed query the CDN rejected, which is why
    // every profile card silently fell back to the letter placeholder.
    const buf = await fetchBuffer(opts.avatarURL);
    avatarImg = await loadImage(buf);
  } catch { avatarImg = null; }

  if (avatarImg) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(AX, AY, AR + 4, 0, Math.PI * 2);
    ctx.strokeStyle = opts.prestige > 0 ? COLORS.gold : COLORS.accent;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(AX, AY, AR, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatarImg, AX - AR, AY - AR, AR * 2, AR * 2);
    ctx.restore();
  } else {
    ctx.fillStyle = COLORS.bgCard;
    ctx.beginPath();
    ctx.arc(AX, AY, AR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = 'bold 40px Sans';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawText(ctx, (opts.username[0] ?? '?').toUpperCase(), AX, AY);
  }

  if (opts.prestige > 0) {
    const bx = AX + AR * 0.65, by = AY + AR * 0.65;
    ctx.fillStyle = '#0d0d1f';
    ctx.beginPath();
    ctx.arc(bx, by, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.gold;
    ctx.font = 'bold 11px Sans';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawText(ctx, `P${opts.prestige}`, bx, by);
  }

  /* Right panel */
  ctx.textAlign = 'left';
  const RX = 232;
  let cy = 38;

  ctx.font = 'bold 28px Sans';
  ctx.fillStyle = COLORS.text;
  ctx.textBaseline = 'top';
  drawText(ctx, opts.username, RX, cy);

  const lvlLabel = `LVL ${opts.level}`;
  ctx.font = 'bold 14px Sans';
  const lvlW = ctx.measureText(lvlLabel).width + 20;
  const lvlX = W - lvlW - 20;
  roundRect(ctx, lvlX, cy, lvlW, 26, 6);
  ctx.fillStyle = COLORS.accentGlow;
  ctx.fill();
  ctx.fillStyle = COLORS.accent;
  drawText(ctx, lvlLabel, lvlX + 10, cy + 6);
  cy += 36;

  ctx.font = '16px Sans';
  ctx.fillStyle = COLORS.textMuted;
  drawText(ctx, opts.title || 'Newcomer', RX, cy);
  cy += 26;

  /* XP bar */
  const barX = RX, barY = cy, barW = W - RX - 24, barH = 10;
  const ratio = Math.min(opts.xp / Math.max(opts.xpNeeded, 1), 1);
  roundRect(ctx, barX, barY, barW, barH, 5);
  ctx.fillStyle = COLORS.bar;
  ctx.fill();
  if (ratio > 0) {
    const fillW = Math.max(barH, ratio * barW);
    const barGrad = ctx.createLinearGradient(barX, 0, barX + fillW, 0);
    barGrad.addColorStop(0, '#4752c4');
    barGrad.addColorStop(1, '#7289da');
    roundRect(ctx, barX, barY, fillW, barH, 5);
    ctx.fillStyle = barGrad;
    ctx.fill();
  }
  cy += barH + 6;

  ctx.font = '13px Sans';
  ctx.fillStyle = COLORS.textDim;
  drawText(ctx, `${fmtNum(opts.xp)} / ${fmtNum(opts.xpNeeded)} XP`, barX, cy);
  const pctLabel = `${Math.round(ratio * 100)}%`;
  drawText(ctx, pctLabel, W - ctx.measureText(pctLabel).width - 24, cy);
  cy += 26;

  /* Stats row */
  const STATS = [
    { label: 'Net Worth', value: fmtNum(opts.wallet + opts.bank) },
    { label: 'Wallet', value: fmtNum(opts.wallet) },
    { label: 'Bank', value: fmtNum(opts.bank) },
    { label: 'Wins', value: fmtNum(opts.gamesWon) },
  ];
  const statW = (W - RX - 24) / STATS.length;
  STATS.forEach((s, i) => {
    const sx = RX + i * statW;
    if (i > 0) { ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(sx, cy, 1, 52); }
    ctx.font = '13px Sans';
    ctx.fillStyle = COLORS.textMuted;
    drawText(ctx, s.label, sx + (i === 0 ? 0 : 12), cy + 4);
    ctx.font = 'bold 18px Sans';
    ctx.fillStyle = COLORS.stat;
    drawText(ctx, s.value, sx + (i === 0 ? 0 : 12), cy + 24);
  });

  /* Footer */
  const memberDate = opts.memberSince
    ? new Date(opts.memberSince).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Unknown';
  ctx.font = '12px Sans';
  ctx.fillStyle = COLORS.textDim;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  drawText(ctx, `Member since ${memberDate}`, W - 18, H - 12);
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(88,101,242,0.35)';
  drawText(ctx, 'Economy Bot', 18, H - 12);

  return canvas.toBuffer('image/png');
}
