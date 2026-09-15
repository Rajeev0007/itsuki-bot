/**
 * @file GifService.ts
 * @description Fetches anime reaction GIFs from multiple providers with
 * automatic fallback.
 *
 * Provider chain (tried in order):
 *  1. OtakuGIFs  — broadest coverage, fast CDN, no auth
 *  2. Gifukai    — covers niche actions OtakuGIFs lacks (bonk, feed, nod…)
 *  3. nekos.best — legacy fallback, kept for completeness
 *
 * nekos.best was previously the only provider but its Cloudflare protection
 * now blocks both the bot's API requests AND Discord's image proxy, so
 * MediaGallery components rendered empty — the text showed but the GIF never
 * loaded. Both OtakuGIFs and Gifukai serve from unprotected CDNs that Discord
 * can proxy without issue.
 */

import axios  from 'axios';
import logger from '../utils/Logger';

// ── HTTP client ──────────────────────────────────────────────────────────────
const http = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; ItsukiBot/1.0; +https://discord.com)',
    'Accept':     'application/json',
  },
  timeout: 5000,
});

// ── Provider interfaces ──────────────────────────────────────────────────────

interface Provider {
  name: string;
  /** Returns a GIF URL or null on failure. */
  fetch(action: string): Promise<string | null>;
  /** Actions this provider is known NOT to support (cached at runtime). */
  deadActions: Set<string>;
}

// ── OtakuGIFs ────────────────────────────────────────────────────────────────
// https://api.otakugifs.xyz  —  response: { url: string }
const OTAKU_BASE = 'https://api.otakugifs.xyz/gif';

/** Maps bot action names → OtakuGIFs reaction names where they differ. */
const OTAKU_ALIASES: Record<string, string> = {
  angry: 'mad',
};

const otakuGifs: Provider = {
  name: 'OtakuGIFs',
  deadActions: new Set<string>(),

  async fetch(action) {
    const reaction = OTAKU_ALIASES[action] ?? action;
    if (this.deadActions.has(reaction)) return null;
    try {
      const { data } = await http.get<{ url?: string }>(`${OTAKU_BASE}?reaction=${reaction}`);
      const url = typeof data?.url === 'string' && data.url ? data.url : null;
      if (!url) logger.debug(`[GifService] OtakuGIFs returned no URL for "${action}"`);
      return url;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 400 || status === 404) {
        this.deadActions.add(reaction);
        logger.debug(`[GifService] OtakuGIFs does not support "${reaction}" (${status})`);
      } else {
        logger.warn(`[GifService] OtakuGIFs failed for "${action}": ${(err as Error).message}`);
      }
      return null;
    }
  },
};

// ── Gifukai ──────────────────────────────────────────────────────────────────
// https://api.gifukai.com/v1/<action>  —  response: { url: string, … }
const GIFUKAI_BASE = 'https://api.gifukai.com/v1';

const gifukai: Provider = {
  name: 'Gifukai',
  deadActions: new Set<string>(),

  async fetch(action) {
    if (this.deadActions.has(action)) return null;
    try {
      const { data } = await http.get<{ url?: string }>(`${GIFUKAI_BASE}/${action}`);
      const url = typeof data?.url === 'string' && data.url ? data.url : null;
      if (!url) logger.debug(`[GifService] Gifukai returned no URL for "${action}"`);
      return url;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) {
        this.deadActions.add(action);
        logger.debug(`[GifService] Gifukai does not support "${action}"`);
      } else {
        logger.warn(`[GifService] Gifukai failed for "${action}": ${(err as Error).message}`);
      }
      return null;
    }
  },
};

// ── nekos.best (legacy fallback) ─────────────────────────────────────────────
// https://nekos.best/api/v2/<action>  —  response: { results: [{ url }] }
const NEKOS_BASE = 'https://nekos.best/api/v2';

/** nekos.best action → endpoint chain (some actions need fallback names). */
const NEKOS_ENDPOINTS: Record<string, string[]> = {
  bonk: ['bonk', 'punch', 'slap'],
};

interface NekosResponse { results?: Array<{ url?: string }> }

const nekosBest: Provider = {
  name: 'nekos.best',
  deadActions: new Set<string>(),

  async fetch(action) {
    const chain = NEKOS_ENDPOINTS[action] ?? [action];
    for (const endpoint of chain) {
      if (this.deadActions.has(endpoint)) continue;
      try {
        const { data } = await http.get<NekosResponse>(`${NEKOS_BASE}/${endpoint}`);
        const results = data?.results;
        if (!Array.isArray(results) || results.length === 0) continue;
        const chosen = results[Math.floor(Math.random() * results.length)];
        const url = typeof chosen?.url === 'string' && chosen.url ? chosen.url : null;
        if (url) return url;
      } catch (err) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 404) {
          this.deadActions.add(endpoint);
          logger.debug(`[GifService] nekos.best endpoint "${endpoint}" does not exist`);
        } else {
          // Cloudflare challenges come back as 403 — don't retry all session.
          if (status === 403) this.deadActions.add(endpoint);
          logger.debug(`[GifService] nekos.best "${endpoint}" failed (${status}): ${(err as Error).message}`);
        }
      }
    }
    return null;
  },
};

// ── Provider chain ───────────────────────────────────────────────────────────

const PROVIDERS: Provider[] = [otakuGifs, gifukai, nekosBest];

/**
 * All action names the bot knows about.
 */
const KNOWN_ACTIONS = [
  'hug', 'kiss', 'pat', 'slap', 'cuddle', 'poke', 'wave', 'dance', 'cry',
  'bonk', 'punch', 'bite', 'tickle', 'smile', 'blush', 'laugh', 'sleep',
  'feed', 'stare', 'wink', 'nod', 'shoot', 'kick', 'happy', 'pout', 'yeet',
  'nom', 'handhold', 'highfive', 'facepalm', 'shrug', 'thumbsup', 'baka',
  'angry',
] as const;

const GifService = {
  /** A random GIF for the action, or null if every provider failed. */
  async getGif(action: string): Promise<string | null> {
    for (const provider of PROVIDERS) {
      const url = await provider.fetch(action);
      if (url) {
        logger.debug(`[GifService] "${action}" served by ${provider.name}`);
        return url;
      }
    }
    logger.warn(`[GifService] All providers failed for "${action}"`);
    return null;
  },

  /** Fetch multiple GIFs. Falls back to sequential single-fetches. */
  async getGifs(action: string, amount = 1): Promise<string[]> {
    const count = Math.max(1, Math.min(20, Math.floor(amount) || 1));
    const urls: string[] = [];
    for (let i = 0; i < count; i++) {
      const url = await this.getGif(action);
      if (url) urls.push(url);
    }
    return urls;
  },

  supports(action: string): boolean {
    return (KNOWN_ACTIONS as readonly string[]).includes(action);
  },

  list(): string[] {
    return [...KNOWN_ACTIONS];
  },
};

export default GifService;
