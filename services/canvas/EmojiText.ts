/**
 * @file EmojiText.ts
 * @description Emoji-aware text drawing for node-canvas.
 *
 * ── Why this is needed ──────────────────────────────────────────────────────
 * node-canvas renders through Cairo/Pango, which has no support for colour
 * emoji fonts (CBDT/COLR/sbix). Installing Noto Color Emoji does not help: the
 * glyphs are bitmap tables Cairo cannot read, so every emoji comes out as a
 * blank box. And nothing in this project ever called registerFont, so the only
 * fonts available were whatever fontconfig happened to expose — which on a bare
 * container is usually one sans family with no emoji coverage at all.
 *
 * The reliable fix is not a font. Emoji are drawn as IMAGES, composited into the
 * text run at the right position and size, which is what every service that
 * renders emoji server-side ends up doing.
 *
 * ── Sync drawing, async loading ─────────────────────────────────────────────
 * Images have to be fetched, but making every draw call async would mean
 * rewriting every canvas renderer around awaits in the middle of layout code.
 * Instead `preloadEmoji()` warms the cache once per render, and the draw/measure
 * helpers stay synchronous. An emoji that failed to load is SKIPPED rather than
 * drawn as a box, so worst case the text is missing a glyph instead of being
 * peppered with tofu.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { CanvasImage } from './CanvasKit';
import logger from '../../utils/Logger';

/**
 * CanvasKit re-exports this module's helpers, so importing it at module scope
 * would create a require cycle and leave one side undefined at init. Resolving
 * it lazily inside the functions avoids that entirely — `import type` above is
 * erased at compile time and costs nothing at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const kit = () => require('./CanvasKit') as typeof import('./CanvasKit');

/**
 * Matches a grapheme that should be drawn as an emoji image.
 *
 * `Extended_Pictographic` covers the vast majority. Regional indicators (flags)
 * and U+20E3 (the combining enclosing keycap, as in 1️⃣) are added because they
 * are not pictographic on their own.
 */
const EMOJI_TEST = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u20E3/u;

/** Local override directory, so emoji can be bundled and never fetched. */
const LOCAL_DIR = path.resolve(__dirname, '..', '..', 'assets', 'emoji');
/** Downloaded copies, so a restart does not refetch everything. */
const CACHE_DIR = path.resolve(__dirname, '..', '..', 'assets', 'emoji-cache');

/**
 * Twemoji asset bases, tried in order.
 *
 * jdecked/twemoji is the maintained fork; twitter/twemoji is archived but still
 * served, and is kept as a fallback in case the first host is unavailable.
 */
const SOURCES = [
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72',
  'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72',
];

/** Loaded images by codepoint sequence. `null` means "known to be unavailable". */
const cache = new Map<string, CanvasImage | null>();
/** In-flight loads, so the same emoji is not fetched twice concurrently. */
const inFlight = new Map<string, Promise<CanvasImage | null>>();

/**
 * The minimum a context must provide.
 *
 * Deliberately narrower than CanvasKit's `Ctx`: ProfileCanvas predates it and
 * declares its own context interface, and demanding the full shape would reject
 * it for members text drawing never touches.
 */
export interface TextCtx {
  fillText: (t: string, x: number, y: number, maxWidth?: number) => void;
  measureText: (t: string) => { width: number };
}

export interface TextRun {
  emoji: boolean;
  /** The characters, for text runs; the codepoint key for emoji runs. */
  value: string;
}

// ── Segmentation ─────────────────────────────────────────────────────────────

/**
 * Splits into grapheme clusters so multi-codepoint emoji stay intact.
 *
 * A family emoji is 7 codepoints; iterating by code point would split it into
 * unrelated pieces and render nonsense.
 */
function graphemes(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: new (l: string, o: object) => { segment: (s: string) => Iterable<{ segment: string }> } }).Segmenter;
  if (Segmenter) {
    try {
      const seg = new Segmenter('en', { granularity: 'grapheme' });
      return [...seg.segment(text)].map((s) => s.segment);
    } catch { /* fall through */ }
  }
  // Code-point split is wrong for ZWJ sequences but is only reached on a
  // runtime without Intl.Segmenter, where the alternative is crashing.
  return [...text];
}

/**
 * Twemoji filename for a grapheme: lowercase hex codepoints joined by `-`.
 *
 * U+FE0F (variation selector-16) is stripped because Twemoji omits it from
 * filenames — except for keycaps, where it is part of the name.
 */
export function emojiKey(grapheme: string): string {
  const points = [...grapheme].map((c) => c.codePointAt(0) ?? 0);
  const isKeycap = points.includes(0x20E3);
  const kept = isKeycap ? points : points.filter((cp) => cp !== 0xFE0F);
  return kept.map((cp) => cp.toString(16)).join('-');
}

/** Splits text into alternating text and emoji runs. */
export function splitRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let buffer = '';

  for (const g of graphemes(String(text ?? ''))) {
    if (EMOJI_TEST.test(g)) {
      if (buffer) { runs.push({ emoji: false, value: buffer }); buffer = ''; }
      runs.push({ emoji: true, value: emojiKey(g) });
    } else {
      buffer += g;
    }
  }
  if (buffer) runs.push({ emoji: false, value: buffer });
  return runs;
}

export function hasEmoji(text: string): boolean {
  return EMOJI_TEST.test(String(text ?? ''));
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function loadOne(key: string): Promise<CanvasImage | null> {
  // 1. Bundled asset — no network, always preferred.
  for (const dir of [LOCAL_DIR, CACHE_DIR]) {
    const file = path.join(dir, `${key}.png`);
    try {
      const buf = await fs.readFile(file);
      return await kit().loadImage(buf);
    } catch { /* not present */ }
  }

  // 2. Fetch, then persist so the next boot is offline-capable.
  for (const base of SOURCES) {
    try {
      const buf = await kit().fetchBuffer(`${base}/${key}.png`);
      const img = await kit().loadImage(buf);
      // Best-effort: a read-only filesystem must not break rendering.
      fs.mkdir(CACHE_DIR, { recursive: true })
        .then(() => fs.writeFile(path.join(CACHE_DIR, `${key}.png`), buf))
        .catch(() => undefined);
      return img;
    } catch { /* try the next source */ }
  }

  logger.debug(`[EmojiText] No image for emoji ${key} — it will be skipped.`);
  return null;
}

/**
 * Warms the cache for every emoji in the given strings.
 *
 * Call once before drawing. Failures are cached as null so a missing emoji is
 * not retried on every frame.
 */
export async function preloadEmoji(...texts: Array<string | null | undefined>): Promise<void> {
  const keys = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const run of splitRuns(text)) if (run.emoji) keys.add(run.value);
  }
  if (!keys.size) return;

  await Promise.all([...keys].map(async (key) => {
    if (cache.has(key)) return;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = loadOne(key).then((img) => { cache.set(key, img); inFlight.delete(key); return img; });
      inFlight.set(key, pending);
    }
    await pending;
  }));
}

/**
 * Every string value inside an object, recursively.
 *
 * Lets a renderer preload with `preloadEmoji(...collectStrings(opts))` instead
 * of enumerating fields by hand — a list that would quietly go stale the next
 * time a field is added.
 */
export function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((v) => collectStrings(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((v) => collectStrings(v, depth + 1));
  }
  return [];
}

/**
 * Seeds the image cache directly.
 *
 * @internal Exists so the drawing and measuring logic can be exercised without
 * network access — the alternative is leaving the positioning maths untested.
 */
export function __setCached(key: string, image: CanvasImage | null): void {
  cache.set(key, image);
}

// ── Measuring and drawing ────────────────────────────────────────────────────

/** Pixel size of the context's current font, used as the emoji box size. */
function fontSize(ctx: TextCtx): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(String((ctx as { font?: string }).font ?? ''));
  return match ? Number(match[1]) : 16;
}

/** Width of `text` with emoji counted as squares of the font size. */
export function measureText(ctx: TextCtx, text: string): number {
  const size = fontSize(ctx);
  let width = 0;
  for (const run of splitRuns(text)) {
    // An emoji still occupies its slot even when the image is unavailable would
    // leave a gap, so unavailable ones contribute nothing — matching what is
    // actually drawn.
    if (run.emoji) width += cache.get(run.value) ? size * 1.15 : 0;
    else width += ctx.measureText(run.value).width;
  }
  return width;
}

/** Where the top of an emoji box goes for the context's current baseline. */
function emojiTop(ctx: TextCtx, y: number, size: number): number {
  switch (String((ctx as { textBaseline?: string }).textBaseline ?? 'alphabetic')) {
    case 'top':
    case 'hanging':
      return y;
    case 'middle':
      return y - size / 2;
    case 'bottom':
    case 'ideographic':
      return y - size;
    default:
      // Alphabetic: the baseline sits near 80% down the em box, so lifting by
      // that much lines emoji up with the surrounding capitals.
      return y - size * 0.8;
  }
}

/**
 * Draws text with emoji composited in, honouring the context's `textAlign` and
 * `textBaseline`.
 *
 * Drop-in for `ctx.fillText(text, x, y)`. Alignment is applied by measuring the
 * whole string first and then drawing runs left to right, because per-run
 * alignment would stack every run at the same anchor.
 */
export function drawText(ctx: TextCtx, text: string, x: number, y: number, maxWidth?: number): void {
  const str = String(text ?? '');
  if (!str) return;

  // Fast path: no emoji, so let the native renderer do everything.
  if (!hasEmoji(str)) {
    if (maxWidth !== undefined) ctx.fillText(str, x, y, maxWidth);
    else ctx.fillText(str, x, y);
    return;
  }

  const size = fontSize(ctx);
  const runs = splitRuns(str);
  const total = measureText(ctx, str);

  const align = String((ctx as { textAlign?: string }).textAlign ?? 'left');
  let cursor = x;
  if (align === 'center') cursor = x - total / 2;
  else if (align === 'right' || align === 'end') cursor = x - total;

  // Runs are positioned explicitly, so alignment must be neutral while drawing
  // and restored afterwards — callers reuse the context.
  const previousAlign = (ctx as { textAlign?: string }).textAlign;
  (ctx as { textAlign?: string }).textAlign = 'left';

  try {
    for (const run of runs) {
      if (run.emoji) {
        const img = cache.get(run.value);
        if (!img) continue;   // never draw a placeholder box
        // Cast because the two context interfaces in this project declare
        // drawImage with different image types, and neither is in TextCtx.
        (ctx as unknown as {
          drawImage: (i: unknown, x: number, y: number, w: number, h: number) => void;
        }).drawImage(img, cursor, emojiTop(ctx, y, size), size, size);
        cursor += size * 1.15;
      } else {
        ctx.fillText(run.value, cursor, y);
        cursor += ctx.measureText(run.value).width;
      }
    }
  } finally {
    (ctx as { textAlign?: string }).textAlign = previousAlign;
  }
}

/**
 * Truncates to `maxWidth`, cutting on grapheme boundaries.
 *
 * Slicing by string index would split a multi-codepoint emoji and leave a
 * fragment that renders as garbage.
 */
export function fitText(ctx: TextCtx, text: string, maxWidth: number): string {
  const str = String(text ?? '');
  if (measureText(ctx, str) <= maxWidth) return str;

  const parts = graphemes(str);
  let out = '';
  for (const g of parts) {
    if (measureText(ctx, `${out}${g}…`) > maxWidth) break;
    out += g;
  }
  return out ? `${out}…` : '…';
}

export default { preloadEmoji, drawText, measureText, fitText, splitRuns, hasEmoji, emojiKey, collectStrings };
