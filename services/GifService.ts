/**
 * @file GifService.ts
 * @description Fetches anime reaction GIFs from nekos.best (no API key required).
 *
 * ── The bug this replaces ───────────────────────────────────────────────────
 * The previous version gave every action a hardcoded chain of candidate
 * endpoints and walked it until one answered. Three consequences, all of which
 * showed up as "the GIF doesn't match the action":
 *
 *  1. A chain like `bonk -> punch -> slap` served a SLAP for /bonk. The
 *     substitution was silent, and because the chain was ordered by similarity
 *     rather than correctness, an action could show something unrelated.
 *  2. The "endpoint is 404" memo was PERMANENT and keyed by endpoint name, with
 *     no expiry. One bad response — a Cloudflare error page, a brief upstream
 *     blip — disabled that category for the entire process lifetime. That is how
 *     /slap ends up showing nothing at all until the bot is restarted, which no
 *     amount of retrying by the user would fix.
 *  3. Every single invocation hit the network for one GIF. nekos.best rate
 *     limits, so a busy server would start getting no GIF back with nothing in
 *     the logs to explain it.
 *
 * ── How it works now ────────────────────────────────────────────────────────
 *  - The catalogue of real categories is DISCOVERED at runtime from
 *    /api/v2/endpoints and cached, so "does this category exist?" is a fact we
 *    look up rather than an assumption baked into a chain.
 *  - A miss is only ever substituted by a category the action explicitly
 *    declares in config/actions.ts. With none declared the answer is null and
 *    the command posts without a GIF, which is honest.
 *  - Results are pooled: one request fetches a batch, and subsequent calls are
 *    served from it. Far fewer requests, no rate-limit cliff, and instant replies.
 *  - Negative caching is TTL'd, so a transient failure heals itself.
 */

import axios from 'axios';
import logger from '../utils/Logger';

const BASE_URL = 'https://nekos.best/api/v2';

/** How many GIFs to pull per refill. The API's documented maximum is 20. */
const POOL_SIZE = 20;
/** How long a category's pool stays usable before it is refetched for variety. */
const POOL_TTL_MS = 15 * 60_000;
/** How long the discovered endpoint catalogue is trusted. */
const CATALOGUE_TTL_MS = 6 * 60 * 60_000;
/** How long a failing category is skipped before being retried. */
const NEGATIVE_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

// Cloudflare (which fronts nekos.best) blocks axios's default User-Agent
// ('axios/x.x.x') with a 403 that is indistinguishable from a normal failure at
// the call site. A realistic UA avoids that.
const http = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; ItsukiBot/1.0; +https://discord.com)',
    'Accept': 'application/json',
  },
  timeout: REQUEST_TIMEOUT_MS,
  // Non-2xx is handled explicitly below rather than thrown, so a 404 can be told
  // apart from a network fault instead of both arriving as an opaque Error.
  validateStatus: () => true,
});

/**
 * Categories known to exist, used only until the live catalogue is fetched (and
 * as a fallback if that fetch fails).
 *
 * Deliberately NOT the source of truth: a static list is exactly what went stale
 * before. It exists so a first invocation during an upstream outage still works.
 */
const SEED_CATEGORIES = [
  'baka', 'bite', 'blush', 'bored', 'cry', 'cuddle', 'dance', 'facepalm', 'feed',
  'handhold', 'happy', 'highfive', 'hug', 'kick', 'kiss', 'laugh', 'lurk', 'nod',
  'nom', 'nope', 'pat', 'peck', 'poke', 'pout', 'punch', 'run', 'shoot', 'shrug',
  'slap', 'sleep', 'smile', 'smug', 'stare', 'think', 'thumbsup', 'tickle',
  'wave', 'wink', 'yawn', 'yeet',
];

interface NekosResult { url?: string }
interface NekosResponse { results?: NekosResult[] }

/* ── Catalogue ────────────────────────────────────────────────────────────── */

let catalogue: { at: number; names: Set<string> } | null = null;
let catalogueInFlight: Promise<Set<string>> | null = null;

/**
 * The set of categories the API actually serves.
 *
 * /api/v2/endpoints returns an object keyed by category. Both a bare map and a
 * `{ endpoints: {...} }` wrapper are accepted, because pinning this to one exact
 * shape is the kind of assumption that breaks quietly on an upstream change.
 */
async function loadCatalogue(): Promise<Set<string>> {
  if (catalogue && Date.now() - catalogue.at < CATALOGUE_TTL_MS) return catalogue.names;
  // Collapse concurrent callers onto one request.
  if (catalogueInFlight) return catalogueInFlight;

  catalogueInFlight = (async () => {
    try {
      const res = await http.get(`${BASE_URL}/endpoints`);
      if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
        throw new Error(`HTTP ${res.status}`);
      }
      const raw = res.data as Record<string, unknown>;
      const body = (raw.endpoints && typeof raw.endpoints === 'object')
        ? raw.endpoints as Record<string, unknown>
        : raw;
      const names = Object.keys(body).filter((k) => k && !k.startsWith('$'));
      if (!names.length) throw new Error('empty catalogue');

      catalogue = { at: Date.now(), names: new Set(names) };
      logger.info(`[GifService] Loaded ${names.length} categories from nekos.best.`);
      return catalogue.names;
    } catch (err) {
      // Seed rather than nothing: an unreachable catalogue must not mean "no
      // category exists", which would disable every action.
      logger.warn(`[GifService] Could not load the category catalogue (${(err as Error).message}); using the built-in list.`);
      catalogue = { at: Date.now(), names: new Set(SEED_CATEGORIES) };
      return catalogue.names;
    } finally {
      catalogueInFlight = null;
    }
  })();

  return catalogueInFlight;
}

/* ── Pools and negative cache ─────────────────────────────────────────────── */

/**
 * A category's fetched batch.
 *
 * `all` is the full batch as fetched and is never consumed; `queue` is what is
 * served from. Keeping both means a category that has EVER succeeded can always
 * show something: when the queue empties and the refill fails, the batch is
 * simply reshuffled rather than the user getting no GIF for a transient outage.
 */
interface Pool { all: string[]; queue: string[]; at: number }
const pools = new Map<string, Pool>();

/** Fisher-Yates, so serving sequentially from the queue is still random. */
function shuffled(urls: string[]): string[] {
  const out = [...urls];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
/** category -> when it may be retried. */
const cooldowns = new Map<string, number>();

function onCooldown(category: string): boolean {
  const until = cooldowns.get(category);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    // Expired — clear it so a recovered category is used again. This self-healing
    // is the whole point: the previous permanent memo needed a restart.
    cooldowns.delete(category);
    return false;
  }
  return true;
}

function penalise(category: string, reason: string): void {
  cooldowns.set(category, Date.now() + NEGATIVE_TTL_MS);
  logger.warn(`[GifService] "${category}" unavailable (${reason}); retrying in ${NEGATIVE_TTL_MS / 60_000} min.`);
}

/** A URL Discord will actually render as an image. */
function usableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    // nekos.best serves .gif/.png; anything without an image extension would
    // render as a broken embed, so it is rejected here rather than posted.
    return /\.(gif|png|jpe?g|webp)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

/** Fetches a batch for one category. Returns [] on any failure. */
async function refill(category: string): Promise<string[]> {
  try {
    const res = await http.get<NekosResponse>(`${BASE_URL}/${encodeURIComponent(category)}`, {
      params: { amount: POOL_SIZE },
    });

    if (res.status === 404) { penalise(category, 'no such category upstream'); return []; }
    if (res.status === 429) { penalise(category, 'rate limited'); return []; }
    if (res.status !== 200) { penalise(category, `HTTP ${res.status}`); return []; }

    const urls = (res.data?.results ?? [])
      .map((r) => r?.url)
      .filter(usableUrl);

    if (!urls.length) { penalise(category, 'no usable URLs in the response'); return []; }
    return urls;
  } catch (err) {
    penalise(category, (err as Error).message);
    return [];
  }
}

/** One URL for a category, from the pool, refilling when empty or stale. */
async function fromPool(category: string): Promise<string | null> {
  const existing = pools.get(category);
  const fresh = existing && Date.now() - existing.at < POOL_TTL_MS;

  // Serve straight from the queue while the batch is fresh and unexhausted.
  if (existing && fresh && existing.queue.length) {
    return existing.queue.pop() ?? null;
  }

  // A cooling-down category is not requested again, but anything already fetched
  // is still perfectly good to show.
  if (onCooldown(category)) {
    return existing?.all.length ? shuffled(existing.all)[0] : null;
  }

  const urls = await refill(category);
  if (urls.length) {
    const queue = shuffled(urls);
    const url = queue.pop() ?? null;
    pools.set(category, { all: urls, queue, at: Date.now() });
    return url;
  }

  // Refill failed. Reuse the last known batch rather than showing nothing — a
  // brief upstream outage should not make an action appear broken.
  if (existing?.all.length) {
    existing.queue = shuffled(existing.all);
    return existing.queue.pop() ?? null;
  }
  pools.delete(category);
  return null;
}

/* ── Public API ───────────────────────────────────────────────────────────── */

export interface GifResult {
  url: string | null;
  /** The category the URL actually came from. */
  category: string | null;
  /** True when `category` is not the action's own — a declared substitution. */
  substituted: boolean;
}

const GifService = {
  /**
   * Resolves a GIF for an action.
   *
   * `category` and `fallbacks` come from the caller (config/actions.ts) so this
   * service never guesses which category an action belongs to — the mistake that
   * made /bonk show a slap.
   */
  async resolve(category: string, fallbacks: string[] = []): Promise<GifResult> {
    const known = await loadCatalogue();

    // The action's own category first, and only if it genuinely exists.
    if (known.has(category)) {
      const url = await fromPool(category);
      if (url) return { url, category, substituted: false };
    } else {
      logger.debug(`[GifService] "${category}" is not a live category.`);
    }

    for (const alt of fallbacks) {
      if (alt === category || !known.has(alt)) continue;
      const url = await fromPool(alt);
      if (url) return { url, category: alt, substituted: true };
    }

    return { url: null, category: null, substituted: false };
  },

  /** Convenience wrapper for callers that only need the URL. */
  async getGif(category: string, fallbacks: string[] = []): Promise<string | null> {
    return (await this.resolve(category, fallbacks)).url;
  },

  /** Several distinct URLs for one category. */
  async getGifs(category: string, amount = 1): Promise<string[]> {
    const want = Math.max(1, Math.min(POOL_SIZE, Math.floor(amount) || 1));
    const known = await loadCatalogue();
    if (!known.has(category) || onCooldown(category)) return [];

    const out: string[] = [];
    const seen = new Set<string>();
    // Bounded so a category with fewer unique GIFs than requested cannot loop.
    for (let attempts = 0; out.length < want && attempts < want * 3; attempts++) {
      const url = await fromPool(category);
      if (!url) break;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  },

  /** Is this a live category? Answers from the cache; call warm() first at boot. */
  supports(category: string): boolean {
    return catalogue ? catalogue.names.has(category) : SEED_CATEGORIES.includes(category);
  },

  /** Every live category. */
  async categories(): Promise<string[]> {
    return [...await loadCatalogue()].sort();
  },

  /** Loads the catalogue up front so the first action command is not slowed by it. */
  async warm(): Promise<void> {
    await loadCatalogue();
  },

  /** Diagnostics for scripts/test-gifs.ts. */
  _state() {
    return {
      catalogueSize: catalogue?.names.size ?? 0,
      pooled: [...pools.entries()].map(([k, v]) => ({ category: k, remaining: v.queue.length, batch: v.all.length })),
      cooldowns: [...cooldowns.entries()].map(([k, v]) => ({ category: k, msLeft: Math.max(0, v - Date.now()) })),
    };
  },
};

export default GifService;
