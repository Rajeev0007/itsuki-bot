/**
 * @file CanvasKit.ts
 * @description Shared node-canvas primitives for the image renderers.
 *
 * `canvas` is a native module with no bundled types here, so the surface we use
 * is declared explicitly rather than reaching for `any`. Centralising it means
 * the card and leaderboard renderers don't each re-declare the shim.
 *
 * Every renderer that uses this should be prepared for it to throw: the native
 * binding may be missing on a host where the build failed, so callers need a
 * non-image fallback path.
 */

import https from 'https';
import http  from 'http';

export interface CanvasImage { width: number; height: number }

export interface CanvasGradient {
  addColorStop: (offset: number, color: string) => void;
}

export interface Ctx {
  fillStyle: string | CanvasGradient;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  globalAlpha: number;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  clearRect: (x: number, y: number, w: number, h: number) => void;
  fillText: (t: string, x: number, y: number, maxWidth?: number) => void;
  strokeText: (t: string, x: number, y: number) => void;
  measureText: (t: string) => { width: number };
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
  createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => CanvasGradient;
}

export interface Canvas {
  getContext: (type: '2d') => Ctx;
  toBuffer: (mime: string) => Buffer;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nativeCanvas = require('canvas') as {
  createCanvas: (w: number, h: number) => Canvas;
  loadImage: (src: Buffer | string) => Promise<CanvasImage>;
};

export const createCanvas = nativeCanvas.createCanvas;
export const loadImage    = nativeCanvas.loadImage;

/** Downloads a URL to a Buffer, following redirects (CDNs use them heavily). */
export function fetchBuffer(url: string, redirectsLeft = 3): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 8000 }, (res) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        return fetchBuffer(new URL(res.headers.location, url).toString(), redirectsLeft - 1)
          .then(resolve, reject);
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${status} for ${url}`));
      }

      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Image request timed out')));
    req.on('error', reject);
  });
}

/** Loads a remote image, resolving to null instead of throwing. */
export async function tryLoadImage(url: string | null | undefined): Promise<CanvasImage | null> {
  if (!url) return null;
  try {
    return await loadImage(await fetchBuffer(url));
  } catch {
    return null;
  }
}

export function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
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

/** Compact number formatting for stat blocks (1.2K / 3.4M). */
export function fmtNum(n: number | null | undefined): string {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000)     return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000)        return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return v.toLocaleString('en-US');
}

/**
 * Emoji-aware text helpers.
 *
 * Re-exported here so every renderer keeps importing from one place. Cairo
 * cannot render colour emoji fonts at all, so emoji are composited as images —
 * see EmojiText for the detail.
 */
export {
  drawText, measureText, preloadEmoji, collectStrings, hasEmoji, splitRuns,
} from './EmojiText';

/**
 * Truncates text to fit `maxWidth` at the context's current font, appending an
 * ellipsis. Measuring matters here — anime character names are long and would
 * otherwise run straight off the edge of a card.
 *
 * Delegates to the emoji-aware implementation: the previous binary search sliced
 * by string index, which cuts multi-codepoint emoji in half and leaves a
 * fragment that renders as garbage. It also measured with ctx.measureText, which
 * reports roughly zero width for an emoji Cairo cannot draw, so a name full of
 * them was never considered too long.
 */
export { fitText } from './EmojiText';

/** Draws an image cropped to fill a box, preserving aspect ratio (CSS cover). */
export function drawImageCover(
  ctx: Ctx, img: CanvasImage, x: number, y: number, w: number, h: number,
): void {
  const scale = Math.max(w / img.width, h / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  ctx.drawImage(img, x + (w - drawW) / 2, y + (h - drawH) / 2, drawW, drawH);
}
