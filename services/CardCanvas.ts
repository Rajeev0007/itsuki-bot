/**
 * @file CardCanvas.ts
 * @description Renders anime cards and collection grids with node-canvas.
 *
 * Both entry points may throw (the native `canvas` binding can be missing, and
 * remote artwork can fail to load). Callers must handle that — the commands all
 * fall back to a text layout rather than failing outright.
 */

import {
  createCanvas, roundRect, fitText, fmtNum, tryLoadImage, drawImageCover,
  drawText, preloadEmoji, collectStrings,
  type Ctx,
} from './canvas/CanvasKit';
import { RARITIES } from './CardService';
import { effectiveStats, type OwnedCard } from '../managers/CardManager';

const BG       = '#14161B';
const PANEL    = '#1D2027';
const TEXT     = '#F2F3F5';
const MUTED    = '#9AA0A6';

/** Single card: 400x580 portrait. */
const CARD_W = 400, CARD_H = 580;

function drawRarityBorder(ctx: Ctx, x: number, y: number, w: number, h: number, colour: string): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 4;
  roundRect(ctx, x + 2, y + 2, w - 4, h - 4, 16);
  ctx.stroke();
}

/** Renders one card at full size — used by /card view and flexing. */
export async function renderCard(card: OwnedCard): Promise<Buffer> {
  // Emoji must be fetched before drawing, because the draw helpers are
  // synchronous. Collected generically from the options so adding a field later
  // cannot silently leave its emoji unrendered.
  await preloadEmoji(...collectStrings(card));
  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext('2d');
  const meta = RARITIES[card.rarity] ?? RARITIES.common;
  const stats = effectiveStats(card);

  ctx.fillStyle = BG;
  roundRect(ctx, 0, 0, CARD_W, CARD_H, 18);
  ctx.fill();

  // ── Artwork ──────────────────────────────────────────────────────────────
  const artH = 380;
  const img = await tryLoadImage(card.imageUrl);
  ctx.save();
  roundRect(ctx, 12, 12, CARD_W - 24, artH, 12);
  ctx.clip();
  if (img) {
    drawImageCover(ctx, img, 12, 12, CARD_W - 24, artH);
  } else {
    // Placeholder keeps the layout intact when artwork can't be fetched.
    ctx.fillStyle = PANEL;
    ctx.fillRect(12, 12, CARD_W - 24, artH);
    ctx.fillStyle = MUTED;
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    drawText(ctx, 'Artwork unavailable', CARD_W / 2, 12 + artH / 2);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  // Rarity ribbon
  const ribbonW = ctx.measureText(meta.label).width;
  ctx.fillStyle = meta.colour;
  roundRect(ctx, 24, 24, Math.max(88, ribbonW + 40), 30, 8);
  ctx.fill();
  ctx.fillStyle = '#101216';
  ctx.font = 'bold 15px sans-serif';
  ctx.textBaseline = 'middle';
  drawText(ctx, meta.label.toUpperCase(), 38, 40);

  // Level badge (right)
  const lvlText = `Lv.${Math.max(1, card.level)}`;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  roundRect(ctx, CARD_W - 92, 24, 68, 30, 8);
  ctx.fill();
  ctx.fillStyle = TEXT;
  ctx.textAlign = 'center';
  drawText(ctx, lvlText, CARD_W - 58, 40);
  ctx.textAlign = 'left';

  // ── Name + source ────────────────────────────────────────────────────────
  ctx.fillStyle = TEXT;
  ctx.font = 'bold 27px sans-serif';
  ctx.textBaseline = 'alphabetic';
  drawText(ctx, fitText(ctx, card.name, CARD_W - 48), 24, 430);

  if (card.animeName) {
    ctx.fillStyle = MUTED;
    ctx.font = '16px sans-serif';
    drawText(ctx, fitText(ctx, card.animeName, CARD_W - 48), 24, 454);
  }

  // ── Stat row ─────────────────────────────────────────────────────────────
  const statY = 478;
  const cells: Array<[string, string]> = [
    ['ATK', fmtNum(stats.attack)],
    ['HP',  fmtNum(stats.health)],
    ['PWR', fmtNum(stats.power)],
  ];
  const cellW = (CARD_W - 48 - 16) / 3;
  cells.forEach(([label, value], i) => {
    const x = 24 + i * (cellW + 8);
    ctx.fillStyle = PANEL;
    roundRect(ctx, x, statY, cellW, 60, 10);
    ctx.fill();

    ctx.fillStyle = MUTED;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    drawText(ctx, label, x + cellW / 2, statY + 22);

    ctx.fillStyle = TEXT;
    ctx.font = 'bold 21px sans-serif';
    drawText(ctx, value, x + cellW / 2, statY + 48);
  });
  ctx.textAlign = 'left';

  // ── Footer ───────────────────────────────────────────────────────────────
  ctx.fillStyle = MUTED;
  ctx.font = '13px sans-serif';
  const extras = [`#${card.id}`, `${fmtNum(card.favorites)} favourites`];
  if ((card.copies ?? 0) > 0) extras.push(`x${card.copies + 1} copies`);
  if (card.locked) extras.push('locked');
  drawText(ctx, fitText(ctx, extras.join(' · '), CARD_W - 48), 24, 560);

  drawRarityBorder(ctx, 0, 0, CARD_W, CARD_H, meta.colour);
  return canvas.toBuffer('image/png');
}

/** Renders a 3-column collection page. */
export async function renderCollection(opts: {
  username: string;
  cards: OwnedCard[];
  page: number;
  totalPages: number;
  totalCards: number;
}): Promise<Buffer> {
  const COLS = 3;
  // Emoji must be fetched before drawing, because the draw helpers are
  // synchronous. Collected generically from the options so adding a field later
  // cannot silently leave its emoji unrendered.
  await preloadEmoji(...collectStrings(opts));
  const TILE_W = 210, TILE_H = 290, GAP = 16, PAD = 24;
  const HEADER = 84;
  const rows = Math.max(1, Math.ceil(opts.cards.length / COLS));

  const W = PAD * 2 + COLS * TILE_W + (COLS - 1) * GAP;
  const H = HEADER + PAD + rows * TILE_H + (rows - 1) * GAP + PAD + 28;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = TEXT;
  ctx.font = 'bold 30px sans-serif';
  drawText(ctx, fitText(ctx, `${opts.username}'s Collection`, W - PAD * 2), PAD, 50);
  ctx.fillStyle = MUTED;
  ctx.font = '16px sans-serif';
  drawText(ctx, `${opts.totalCards} card${opts.totalCards !== 1 ? 's' : ''} · page ${opts.page} of ${opts.totalPages}`, PAD, 74);

  // Load all artwork in parallel — sequential fetches made a 9-card page slow.
  const images = await Promise.all(opts.cards.map((c) => tryLoadImage(c.imageUrl)));

  for (let i = 0; i < opts.cards.length; i++) {
    const card = opts.cards[i];
    const meta = RARITIES[card.rarity] ?? RARITIES.common;
    const stats = effectiveStats(card);
    const col = i % COLS, row = Math.floor(i / COLS);
    const x = PAD + col * (TILE_W + GAP);
    const y = HEADER + PAD + row * (TILE_H + GAP);

    ctx.fillStyle = PANEL;
    roundRect(ctx, x, y, TILE_W, TILE_H, 12);
    ctx.fill();

    const artH = 190;
    ctx.save();
    roundRect(ctx, x + 8, y + 8, TILE_W - 16, artH, 8);
    ctx.clip();
    const img = images[i];
    if (img) {
      drawImageCover(ctx, img, x + 8, y + 8, TILE_W - 16, artH);
    } else {
      ctx.fillStyle = '#2A2E36';
      ctx.fillRect(x + 8, y + 8, TILE_W - 16, artH);
    }
    ctx.restore();

    // Rarity + level pills
    ctx.fillStyle = meta.colour;
    roundRect(ctx, x + 14, y + 14, 16, 16, 4);
    ctx.fill();

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    roundRect(ctx, x + TILE_W - 62, y + 14, 48, 20, 5);
    ctx.fill();
    ctx.fillStyle = TEXT;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    drawText(ctx, `Lv.${Math.max(1, card.level)}`, x + TILE_W - 38, y + 28);
    ctx.textAlign = 'left';

    ctx.fillStyle = TEXT;
    ctx.font = 'bold 16px sans-serif';
    drawText(ctx, fitText(ctx, card.name, TILE_W - 24), x + 12, y + artH + 34);

    ctx.fillStyle = MUTED;
    ctx.font = '13px sans-serif';
    drawText(ctx, `ATK ${fmtNum(stats.attack)} · HP ${fmtNum(stats.health)}`, x + 12, y + artH + 56);
    ctx.fillStyle = meta.colour;
    ctx.font = 'bold 12px sans-serif';
    drawText(ctx, meta.label.toUpperCase(), x + 12, y + artH + 76);

    ctx.strokeStyle = meta.colour;
    ctx.lineWidth = 2;
    roundRect(ctx, x + 1, y + 1, TILE_W - 2, TILE_H - 2, 12);
    ctx.stroke();
  }

  ctx.fillStyle = MUTED;
  ctx.font = '13px sans-serif';
  drawText(ctx, '/card view <name> to inspect · /auction list to sell', PAD, H - 18);

  return canvas.toBuffer('image/png');
}
