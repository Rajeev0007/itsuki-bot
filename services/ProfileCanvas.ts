/**
 * @file ProfileCanvas.ts
 * @description Generates a profile card image using node-canvas.
 *
 * ── Layout ──────────────────────────────────────────────────────────────────
 * 1000x620, three bands:
 *
 *   HEADER  banner artwork (the user's Discord banner when they have one,
 *           otherwise a gradient built from their accent colour) behind a
 *           scrim so overlaid text stays readable on any image.
 *   IDENTITY large avatar straddling the header seam, name, title, level pill
 *           and the XP bar.
 *   BODY    four stat panels, then the badge shelf.
 *
 * Every value is laid out from named constants rather than magic offsets, and
 * the bands are drawn top-to-bottom so adding a row means moving one cursor.
 *
 * ── Text is drawn through EmojiText, never ctx.fillText ─────────────────────
 * Cairo cannot render colour emoji, so drawText() composites them as images.
 * Badge icons are emoji, which is what lets a new badge be a one-line registry
 * entry instead of a new asset. Anything drawn with the raw context would show
 * a blank box for those, so every string here goes through drawText/measureText.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createCanvas, loadImage } = require('canvas') as {
  createCanvas: (w: number, h: number) => Canvas;
  loadImage: (src: Buffer | string) => Promise<CanvasImage>;
};
import { fetchBuffer } from './canvas/CanvasKit';
import { drawText, measureText, fitText, preloadEmoji, collectStrings } from './canvas/EmojiText';

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
  globalAlpha: number;
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
  /** 5-arg destination form, and the 9-arg form used to cover-crop the banner. */
  drawImage: {
    (img: CanvasImage, x: number, y: number, w: number, h: number): void;
    (img: CanvasImage, sx: number, sy: number, sw: number, sh: number,
      dx: number, dy: number, dw: number, dh: number): void;
  };
  measureText: (t: string) => { width: number };
  createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => CanvasGradient;
}
interface CanvasGradient { addColorStop: (offset: number, color: string) => void }

/* ── Geometry ─────────────────────────────────────────────────────────────── */

const W = 1000;
const PAD = 34;
const RADIUS = 24;

/**
 * Every vertical measurement, in draw order.
 *
 * Kept in one table because the card height has to be known BEFORE anything is
 * drawn — node-canvas fixes the surface size at creation — while the badge shelf
 * only knows how tall it is once the badge count is in. Both the running draw
 * cursor and `shelfTop()` add up these same numbers, so a spacing change moves
 * the content and resizes the canvas together instead of silently pushing the
 * shelf through the footer.
 */
const L = {
  headerH: 200,
  gapAfterHeader: 34,
  titleChipH: 32,
  gapAfterTitle: 22,
  xpLabelH: 12,
  xpBarH: 14,
  gapAfterXp: 26,
  statsH: 92,
  gapAfterStats: 26,
  shelfLabelH: 14,
  tile: 78,
  tileGap: 14,
  /** Space under a tile for its name. */
  tileLabelH: 18,
  footerH: 46,
} as const;

/** Avatar radius — the "big picture". */
const AVATAR_R = 84;
const AVATAR_X = PAD + AVATAR_R + 6;
const AVATAR_Y = L.headerH + 12;

const BAR_W = W - PAD * 2;
/** Tiles that fit on one row at this width. */
const BADGE_PER_ROW = Math.max(1, Math.floor((BAR_W + L.tileGap) / (L.tile + L.tileGap)));
/** Two rows maximum; the last slot is reserved for the "+N" overflow tile. */
const BADGE_MAX = BADGE_PER_ROW * 2 - 1;

/** Y of the first badge tile. */
const SHELF_TOP = L.headerH + L.gapAfterHeader + L.titleChipH + L.gapAfterTitle
  + L.xpLabelH + L.xpBarH + L.gapAfterXp + L.statsH + L.gapAfterStats + L.shelfLabelH;

/** Card height for a given number of shelf rows. */
function cardHeight(rows: number): number {
  return SHELF_TOP
    + rows * (L.tile + L.tileLabelH)
    + Math.max(0, rows - 1) * L.tileGap
    + L.footerH;
}

const COLORS = {
  bgTop: '#12121f',
  bgBottom: '#0a0a14',
  panel: 'rgba(255,255,255,0.045)',
  panelBorder: 'rgba(255,255,255,0.08)',
  accent: '#5865f2',
  text: '#ffffff',
  textMuted: '#9a9ab5',
  textDim: '#5a5a78',
  gold: '#ffd700',
  bar: 'rgba(255,255,255,0.10)',
};

/* ── Primitives ───────────────────────────────────────────────────────────── */

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function fillRound(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient): void {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

function strokeRound(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, stroke: string, width = 1): void {
  roundRect(ctx, x, y, w, h, r);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.stroke();
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString('en-US');
}

/** `#rrggbb` -> `rgba(r,g,b,alpha)`, falling back to the brand accent. */
function withAlpha(hex: string, alpha: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!match) return `rgba(88,101,242,${alpha})`;
  const int = parseInt(match[1], 16);
  return `rgba(${(int >> 16) & 255},${(int >> 8) & 255},${int & 255},${alpha})`;
}

/**
 * Loads an image, returning null instead of throwing.
 *
 * Every remote asset on this card is decorative — a missing banner or avatar
 * must degrade to the placeholder, never fail the whole render, because the
 * command's only other option is a plain-text card.
 */
async function tryImage(url: string | null | undefined): Promise<CanvasImage | null> {
  if (!url) return null;
  try {
    return await loadImage(await fetchBuffer(url));
  } catch {
    return null;
  }
}

/**
 * Draws `img` covering the box, cropping the overflow and preserving aspect
 * ratio (CSS `object-fit: cover`).
 *
 * Banners are 600x240-ish but users can upload anything; scaling to the box
 * directly would stretch faces, which looks broken rather than stylised.
 */
function drawCover(ctx: CanvasRenderingContext2D, img: CanvasImage, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

/* ── Options ──────────────────────────────────────────────────────────────── */

export interface ProfileBadge {
  name: string;
  icon: string;
  color: string;
}

export interface ProfileOptions {
  username: string;
  /** Shown under the name when the member has a server nickname. */
  displayName?: string | null;
  avatarURL: string;
  /** The user's Discord banner, when they have one. */
  bannerURL?: string | null;
  /** Their profile accent colour as `#rrggbb`, used when there is no banner. */
  accentColor?: string | null;
  level: number; xp: number; xpNeeded: number; prestige: number;
  wallet: number; bank: number; gamesWon: number; gamesPlayed: number;
  title: string; memberSince: number | string;
  /** Leaderboard position by net worth, when known. */
  rank?: number | null;
  badges?: ProfileBadge[];
}

/* ── Render ───────────────────────────────────────────────────────────────── */

export async function generateProfile(opts: ProfileOptions): Promise<Buffer> {
  // Emoji must be fetched before drawing, because the draw helpers are
  // synchronous. Collected generically from the options — including every badge
  // icon — so adding a field later cannot silently leave its emoji unrendered.
  await preloadEmoji(...collectStrings(opts));

  // Work out the shelf size first: the canvas cannot be resized after creation,
  // so a user with 12 badges needs a taller card than one with none.
  const badges = (opts.badges ?? []).slice(0, BADGE_MAX);
  const hidden = Math.max(0, (opts.badges?.length ?? 0) - badges.length);
  const tileCount = badges.length + (hidden > 0 ? 1 : 0);
  const shelfRows = Math.max(1, Math.ceil(tileCount / BADGE_PER_ROW));
  const H = cardHeight(shelfRows);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const accent = opts.accentColor && /^#?[0-9a-f]{6}$/i.test(opts.accentColor)
    ? (opts.accentColor.startsWith('#') ? opts.accentColor : `#${opts.accentColor}`)
    : COLORS.accent;

  const [avatarImg, bannerImg] = await Promise.all([
    tryImage(opts.avatarURL),
    tryImage(opts.bannerURL),
  ]);

  /* ── Card body ─────────────────────────────────────────────────────────── */
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, COLORS.bgTop);
  bg.addColorStop(1, COLORS.bgBottom);
  fillRound(ctx, 0, 0, W, H, RADIUS, bg);

  /* ── Header band ───────────────────────────────────────────────────────── */
  ctx.save();
  // Clip to the card's rounded top so banner artwork cannot spill over the
  // corners.
  roundRect(ctx, 0, 0, W, L.headerH, RADIUS);
  ctx.clip();

  if (bannerImg) {
    drawCover(ctx, bannerImg, 0, 0, W, L.headerH);
  } else {
    // No banner: a diagonal wash from the accent colour, so the card still feels
    // personal rather than showing an empty grey slab.
    const wash = ctx.createLinearGradient(0, 0, W, L.headerH);
    wash.addColorStop(0, withAlpha(accent, 0.55));
    wash.addColorStop(0.55, withAlpha(accent, 0.18));
    wash.addColorStop(1, 'rgba(10,10,20,0.05)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, L.headerH);
  }

  // Scrim: darkens towards the bottom so the name and level pill stay legible
  // over a bright banner.
  const scrim = ctx.createLinearGradient(0, 0, 0, L.headerH);
  scrim.addColorStop(0, 'rgba(10,10,20,0.15)');
  scrim.addColorStop(0.6, 'rgba(10,10,20,0.55)');
  scrim.addColorStop(1, 'rgba(10,10,20,0.92)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, W, L.headerH);
  ctx.restore();

  /* Level pill, top-right over the banner */
  const levelLabel = `LEVEL ${opts.level}`;
  ctx.font = 'bold 16px Sans';
  const pillW = measureText(ctx, levelLabel) + 32;
  const pillH = 36;
  const pillX = W - PAD - pillW;
  const pillY = PAD - 6;
  fillRound(ctx, pillX, pillY, pillW, pillH, pillH / 2, 'rgba(10,10,20,0.72)');
  strokeRound(ctx, pillX, pillY, pillW, pillH, pillH / 2, withAlpha(accent, 0.9), 2);
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawText(ctx, levelLabel, pillX + pillW / 2, pillY + pillH / 2 + 1);

  /* Rank pill, under the level pill */
  if (opts.rank && opts.rank > 0) {
    const rankLabel = `RANK #${opts.rank}`;
    ctx.font = 'bold 13px Sans';
    const rw = measureText(ctx, rankLabel) + 26;
    const rx = W - PAD - rw;
    const ry = pillY + pillH + 10;
    fillRound(ctx, rx, ry, rw, 28, 14, 'rgba(10,10,20,0.6)');
    strokeRound(ctx, rx, ry, rw, 28, 14, 'rgba(255,255,255,0.16)', 1);
    ctx.fillStyle = COLORS.gold;
    drawText(ctx, rankLabel, rx + rw / 2, ry + 15);
  }

  /* ── Avatar ────────────────────────────────────────────────────────────── */
  // Ring sits behind the image so the stroke is never clipped by it.
  ctx.beginPath();
  ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_R + 7, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.bgTop;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_R + 4, 0, Math.PI * 2);
  ctx.strokeStyle = opts.prestige > 0 ? COLORS.gold : accent;
  ctx.lineWidth = 5;
  ctx.stroke();

  if (avatarImg) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_R, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    drawCover(ctx, avatarImg, AVATAR_X - AVATAR_R, AVATAR_Y - AVATAR_R, AVATAR_R * 2, AVATAR_R * 2);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_R, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(accent, 0.28);
    ctx.fill();
    ctx.font = 'bold 62px Sans';
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawText(ctx, (opts.username[0] ?? '?').toUpperCase(), AVATAR_X, AVATAR_Y + 2);
  }

  /* Prestige chip on the avatar rim */
  if (opts.prestige > 0) {
    const cx = AVATAR_X + AVATAR_R * 0.72;
    const cy = AVATAR_Y + AVATAR_R * 0.72;
    ctx.beginPath();
    ctx.arc(cx, cy, 21, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.bgTop;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, 21, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.gold;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.font = 'bold 15px Sans';
    ctx.fillStyle = COLORS.gold;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawText(ctx, `P${opts.prestige}`, cx, cy + 1);
  }

  /* ── Identity block ────────────────────────────────────────────────────── */
  const IX = AVATAR_X + AVATAR_R + 30;
  const identityRight = W - PAD;
  const identityW = identityRight - IX;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.font = 'bold 38px Sans';
  ctx.fillStyle = COLORS.text;
  drawText(ctx, fitText(ctx, opts.displayName || opts.username, identityW), IX, L.headerH - 44);

  // The @handle only earns its line when it differs from the display name.
  if (opts.displayName && opts.displayName !== opts.username) {
    ctx.font = '17px Sans';
    ctx.fillStyle = COLORS.textMuted;
    drawText(ctx, fitText(ctx, `@${opts.username}`, identityW), IX, L.headerH - 18);
  }

  let cy = L.headerH + L.gapAfterHeader;

  /* Title chip */
  const title = opts.title || 'Newcomer';
  ctx.font = 'bold 15px Sans';
  const titleW = measureText(ctx, fitText(ctx, title, identityW - 24)) + 26;
  fillRound(ctx, IX, cy, titleW, L.titleChipH, 16, withAlpha(accent, 0.16));
  strokeRound(ctx, IX, cy, titleW, L.titleChipH, 16, withAlpha(accent, 0.45), 1);
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawText(ctx, fitText(ctx, title, identityW - 24), IX + titleW / 2, cy + L.titleChipH / 2 + 1);
  ctx.textAlign = 'left';
  cy += L.titleChipH + L.gapAfterTitle;

  /* ── XP bar ────────────────────────────────────────────────────────────── */
  const barX = PAD;
  const barW = BAR_W;
  const barH = L.xpBarH;
  const needed = Math.max(opts.xpNeeded, 1);
  const ratio = Math.max(0, Math.min(opts.xp / needed, 1));

  ctx.font = '14px Sans';
  ctx.fillStyle = COLORS.textMuted;
  ctx.textBaseline = 'alphabetic';
  drawText(ctx, 'PROGRESS', barX, cy);
  const xpLabel = `${fmtNum(opts.xp)} / ${fmtNum(needed)} XP  ·  ${Math.round(ratio * 100)}%`;
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.textDim;
  drawText(ctx, xpLabel, barX + barW, cy);
  ctx.textAlign = 'left';
  cy += L.xpLabelH;

  fillRound(ctx, barX, cy, barW, barH, barH / 2, COLORS.bar);
  if (ratio > 0) {
    const fillW = Math.max(barH, ratio * barW);
    const grad = ctx.createLinearGradient(barX, 0, barX + fillW, 0);
    grad.addColorStop(0, withAlpha(accent, 0.85));
    grad.addColorStop(1, opts.prestige > 0 ? COLORS.gold : '#8b9bff');
    fillRound(ctx, barX, cy, fillW, barH, barH / 2, grad);
  }
  cy += barH + L.gapAfterXp;

  /* ── Stat panels ───────────────────────────────────────────────────────── */
  const winRate = opts.gamesPlayed > 0
    ? `${Math.round((opts.gamesWon / opts.gamesPlayed) * 100)}%`
    : '—';
  const STATS = [
    { label: 'NET WORTH', value: fmtNum(opts.wallet + opts.bank), tint: COLORS.gold },
    { label: 'WALLET', value: fmtNum(opts.wallet), tint: '#57f287' },
    { label: 'BANK', value: fmtNum(opts.bank), tint: '#00b0f4' },
    { label: 'WIN RATE', value: winRate, tint: '#eb459e' },
  ];
  const panelGap = 16;
  const panelW = (barW - panelGap * (STATS.length - 1)) / STATS.length;

  STATS.forEach((s, i) => {
    const px = barX + i * (panelW + panelGap);
    fillRound(ctx, px, cy, panelW, L.statsH, 16, COLORS.panel);
    strokeRound(ctx, px, cy, panelW, L.statsH, 16, COLORS.panelBorder, 1);
    // Accent strip, so the four panels read as distinct at a glance.
    fillRound(ctx, px, cy, 4, L.statsH, 2, withAlpha(s.tint, 0.85));

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '12px Sans';
    ctx.fillStyle = COLORS.textMuted;
    drawText(ctx, s.label, px + 18, cy + 30);
    ctx.font = 'bold 27px Sans';
    ctx.fillStyle = COLORS.text;
    drawText(ctx, fitText(ctx, s.value, panelW - 30), px + 18, cy + 66);
  });
  cy += L.statsH + L.gapAfterStats;

  /* ── Badge shelf ───────────────────────────────────────────────────────── */
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '14px Sans';
  ctx.fillStyle = COLORS.textMuted;
  drawText(ctx, 'BADGES', barX, cy);
  if (opts.badges?.length) {
    const count = `${opts.badges.length} earned`;
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.textDim;
    drawText(ctx, count, barX + barW, cy);
    ctx.textAlign = 'left';
  }
  cy += L.shelfLabelH;

  if (!badges.length) {
    // An empty shelf is drawn as a hint rather than left blank, so the feature is
    // discoverable from the card itself.
    fillRound(ctx, barX, cy, barW, L.tile, 16, 'rgba(255,255,255,0.025)');
    strokeRound(ctx, barX, cy, barW, L.tile, 16, COLORS.panelBorder, 1);
    ctx.font = '15px Sans';
    ctx.fillStyle = COLORS.textDim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawText(ctx, 'No badges yet — level up, prestige or hit an achievement to earn one.',
      barX + barW / 2, cy + L.tile / 2);
    ctx.textAlign = 'left';
  } else {
    badges.forEach((badge, i) => {
      const col = i % BADGE_PER_ROW;
      const row = Math.floor(i / BADGE_PER_ROW);
      const bx = barX + col * (L.tile + L.tileGap);
      const by = cy + row * (L.tile + L.tileGap + L.tileLabelH);

      fillRound(ctx, bx, by, L.tile, L.tile, 18, withAlpha(badge.color, 0.14));
      strokeRound(ctx, bx, by, L.tile, L.tile, 18, withAlpha(badge.color, 0.55), 2);

      // The icon is an emoji, composited as an image by drawText — the font size
      // is what sets the image box, so this is how the tile art is sized.
      ctx.font = '38px Sans';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.text;
      // measureText reports 0 for an emoji whose image could not be loaded,
      // because drawText skips those rather than drawing a tofu box. Detecting it
      // here is the difference between a lettered tile and an empty one.
      if (measureText(ctx, badge.icon) > 0) {
        drawText(ctx, badge.icon, bx + L.tile / 2, by + L.tile / 2);
      } else {
        ctx.font = 'bold 30px Sans';
        ctx.fillStyle = withAlpha(badge.color, 0.95);
        drawText(ctx, (badge.name[0] ?? '?').toUpperCase(), bx + L.tile / 2, by + L.tile / 2 + 1);
      }

      ctx.font = '11px Sans';
      ctx.fillStyle = COLORS.textMuted;
      ctx.textBaseline = 'top';
      drawText(ctx, fitText(ctx, badge.name, L.tile + L.tileGap - 2),
        bx + L.tile / 2, by + L.tile + 5);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    });

    if (hidden > 0) {
      const used = badges.length;
      const col = used % BADGE_PER_ROW;
      const row = Math.floor(used / BADGE_PER_ROW);
      const bx = barX + col * (L.tile + L.tileGap);
      const by = cy + row * (L.tile + L.tileGap + L.tileLabelH);
      fillRound(ctx, bx, by, L.tile, L.tile, 18, 'rgba(255,255,255,0.05)');
      strokeRound(ctx, bx, by, L.tile, L.tile, 18, COLORS.panelBorder, 2);
      ctx.font = 'bold 22px Sans';
      ctx.fillStyle = COLORS.textMuted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      drawText(ctx, `+${hidden}`, bx + L.tile / 2, by + L.tile / 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }

  /* ── Footer ────────────────────────────────────────────────────────────── */
  const memberDate = opts.memberSince
    ? new Date(opts.memberSince).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Unknown';
  ctx.font = '12px Sans';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = COLORS.textDim;
  ctx.textAlign = 'left';
  drawText(ctx, `Member since ${memberDate}`, PAD, H - 16);
  ctx.textAlign = 'right';
  ctx.fillStyle = withAlpha(accent, 0.55);
  drawText(ctx, `${fmtNum(opts.gamesWon)} wins · ${fmtNum(opts.gamesPlayed)} games played`, W - PAD, H - 16);

  /* Outer border, drawn last so nothing overlaps it. */
  strokeRound(ctx, 1, 1, W - 2, H - 2, RADIUS, 'rgba(255,255,255,0.07)', 2);

  return canvas.toBuffer('image/png');
}
