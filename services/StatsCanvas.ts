/**
 * @file StatsCanvas.ts
 * @description Renders leaderboard tables and per-user activity charts.
 *
 * May throw if the native `canvas` binding is unavailable — callers must have a
 * text fallback.
 */

import {
  createCanvas, roundRect, fitText, fmtNum, tryLoadImage, drawImageCover,
  drawText, preloadEmoji, collectStrings,
  type Ctx,
} from './canvas/CanvasKit';

const BG     = '#14161B';
const PANEL  = '#1D2027';
const TEXT   = '#F2F3F5';
const MUTED  = '#9AA0A6';
const ACCENT = '#5865F2';
const GOLD   = '#FFD700';
const SILVER = '#C0C0C0';
const BRONZE = '#CD7F32';

export interface LeaderboardRow {
  rank: number;
  name: string;
  value: string;
  avatarUrl?: string | null;
  /** Highlights the viewer's own row. */
  isViewer?: boolean;
}

function rankColour(rank: number): string {
  if (rank === 1) return GOLD;
  if (rank === 2) return SILVER;
  if (rank === 3) return BRONZE;
  return MUTED;
}

/** Renders one page of a leaderboard as a table with avatars. */
export async function renderLeaderboard(opts: {
  title: string;
  subtitle: string;
  rows: LeaderboardRow[];
  page: number;
  totalPages: number;
}): Promise<Buffer> {
  const PAD = 28;
  // Emoji must be fetched before drawing, because the draw helpers are
  // synchronous. Collected generically from the options so adding a field later
  // cannot silently leave its emoji unrendered.
  await preloadEmoji(...collectStrings(opts));
  const ROW_H = 62;
  const HEADER = 96;
  const W = 900;
  const H = HEADER + PAD + Math.max(1, opts.rows.length) * ROW_H + PAD + 26;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Header
  ctx.fillStyle = TEXT;
  ctx.font = 'bold 34px sans-serif';
  ctx.textBaseline = 'alphabetic';
  drawText(ctx, fitText(ctx, opts.title, W - PAD * 2), PAD, 52);
  ctx.fillStyle = MUTED;
  ctx.font = '17px sans-serif';
  drawText(ctx, fitText(ctx, opts.subtitle, W - PAD * 2), PAD, 80);

  ctx.strokeStyle = '#2A2E36';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, HEADER - 8);
  ctx.lineTo(W - PAD, HEADER - 8);
  ctx.stroke();

  // Avatars in parallel — one request per row serially made this very slow.
  const avatars = await Promise.all(opts.rows.map((r) => tryLoadImage(r.avatarUrl)));

  for (let i = 0; i < opts.rows.length; i++) {
    const row = opts.rows[i];
    const y = HEADER + PAD + i * ROW_H;
    const h = ROW_H - 10;

    ctx.fillStyle = row.isViewer ? '#252A38' : PANEL;
    roundRect(ctx, PAD, y, W - PAD * 2, h, 10);
    ctx.fill();

    if (row.isViewer) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      roundRect(ctx, PAD, y, W - PAD * 2, h, 10);
      ctx.stroke();
    }

    // Rank
    ctx.fillStyle = rankColour(row.rank);
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    drawText(ctx, `#${row.rank}`, PAD + 42, y + h / 2 + 8);
    ctx.textAlign = 'left';

    // Avatar (circular)
    const avSize = 38;
    const avX = PAD + 82;
    const avY = y + (h - avSize) / 2;
    const img = avatars[i];
    ctx.save();
    ctx.beginPath();
    ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (img) {
      drawImageCover(ctx, img, avX, avY, avSize, avSize);
    } else {
      ctx.fillStyle = '#2A2E36';
      ctx.fillRect(avX, avY, avSize, avSize);
    }
    ctx.restore();

    // Name (left) and value (right), with the name clipped so it can never
    // collide with the value column.
    ctx.fillStyle = TEXT;
    ctx.font = 'bold 20px sans-serif';
    const valueText = row.value;
    ctx.font = 'bold 20px sans-serif';
    const valueW = ctx.measureText(valueText).width;
    const nameMax = W - PAD * 2 - 150 - valueW - 40;
    drawText(ctx, fitText(ctx, row.name, nameMax), avX + avSize + 16, y + h / 2 + 7);

    ctx.fillStyle = ACCENT;
    ctx.textAlign = 'right';
    drawText(ctx, valueText, W - PAD - 18, y + h / 2 + 7);
    ctx.textAlign = 'left';
  }

  if (!opts.rows.length) {
    ctx.fillStyle = MUTED;
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    drawText(ctx, 'No data yet', W / 2, HEADER + PAD + 34);
    ctx.textAlign = 'left';
  }

  ctx.fillStyle = MUTED;
  ctx.font = '14px sans-serif';
  drawText(ctx, `Page ${opts.page} of ${opts.totalPages}`, PAD, H - 14);

  return canvas.toBuffer('image/png');
}

/** Renders a per-user activity card with a 14-day bar chart. */
export async function renderUserStats(opts: {
  username: string;
  avatarUrl: string;
  messages: number;
  voiceSeconds: number;
  commands: number;
  messageRank: number | null;
  voiceRank: number | null;
  series: Array<{ day: string; messages: number }>;
}): Promise<Buffer> {
  // Emoji must be fetched before drawing, because the draw helpers are
  // synchronous. Collected generically from the options so adding a field later
  // cannot silently leave its emoji unrendered.
  await preloadEmoji(...collectStrings(opts));
  const W = 860, H = 420;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Header with avatar
  const avatar = await tryLoadImage(opts.avatarUrl);
  const avSize = 72;
  ctx.save();
  ctx.beginPath();
  ctx.arc(28 + avSize / 2, 28 + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (avatar) drawImageCover(ctx, avatar, 28, 28, avSize, avSize);
  else { ctx.fillStyle = PANEL; ctx.fillRect(28, 28, avSize, avSize); }
  ctx.restore();

  ctx.fillStyle = TEXT;
  ctx.font = 'bold 30px sans-serif';
  drawText(ctx, fitText(ctx, opts.username, W - 160), 116, 58);
  ctx.fillStyle = MUTED;
  ctx.font = '16px sans-serif';
  const rankBits = [
    opts.messageRank ? `#${opts.messageRank} messages` : null,
    opts.voiceRank ? `#${opts.voiceRank} voice` : null,
  ].filter(Boolean);
  drawText(ctx, rankBits.length ? `Server rank — ${rankBits.join(' · ')}` : 'Server activity', 116, 84);

  // Stat tiles
  const tiles: Array<[string, string]> = [
    ['MESSAGES', fmtNum(opts.messages)],
    ['VOICE',    `${Math.floor(opts.voiceSeconds / 3600)}h ${Math.floor((opts.voiceSeconds % 3600) / 60)}m`],
    ['COMMANDS', fmtNum(opts.commands)],
  ];
  const tileW = (W - 56 - 24) / 3;
  tiles.forEach(([label, value], i) => {
    const x = 28 + i * (tileW + 12);
    ctx.fillStyle = PANEL;
    roundRect(ctx, x, 118, tileW, 78, 12);
    ctx.fill();
    ctx.fillStyle = MUTED;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    drawText(ctx, label, x + tileW / 2, 144);
    ctx.fillStyle = TEXT;
    ctx.font = 'bold 27px sans-serif';
    drawText(ctx, value, x + tileW / 2, 178);
    ctx.textAlign = 'left';
  });

  // 14-day message chart
  const chartX = 28, chartY = 226, chartW = W - 56, chartH = 148;
  ctx.fillStyle = PANEL;
  roundRect(ctx, chartX, chartY, chartW, chartH, 12);
  ctx.fill();

  ctx.fillStyle = MUTED;
  ctx.font = 'bold 12px sans-serif';
  drawText(ctx, 'MESSAGES — LAST 14 DAYS', chartX + 16, chartY + 24);

  const series = opts.series.slice(-14);
  // Guard the divisor: an all-zero series would otherwise divide by zero and
  // produce NaN bar heights.
  const peak = Math.max(1, ...series.map((s) => s.messages));
  const plotY = chartY + 36;
  const plotH = chartH - 56;
  const barGap = 6;
  const barW = series.length ? (chartW - 32 - (series.length - 1) * barGap) / series.length : 0;

  series.forEach((point, i) => {
    const barH = Math.max(2, Math.round((point.messages / peak) * plotH));
    const x = chartX + 16 + i * (barW + barGap);
    const y = plotY + (plotH - barH);
    ctx.fillStyle = point.messages > 0 ? ACCENT : '#2A2E36';
    roundRect(ctx, x, y, barW, barH, 4);
    ctx.fill();
  });

  ctx.fillStyle = MUTED;
  ctx.font = '11px sans-serif';
  drawText(ctx, `peak ${fmtNum(peak)}/day`, chartX + 16, chartY + chartH - 8);
  ctx.textAlign = 'right';
  drawText(ctx, 'today', chartX + chartW - 16, chartY + chartH - 8);
  ctx.textAlign = 'left';

  return canvas.toBuffer('image/png');
}
