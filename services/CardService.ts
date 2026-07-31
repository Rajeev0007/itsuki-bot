/**
 * @file CardService.ts
 * @description Sources anime character cards from the Jikan (MyAnimeList) API.
 *
 * Design note — why Jikan and not an image API:
 *   A collectible card needs a STABLE identity. Endpoints that hand back a
 *   random image (waifu.pics, nekos.best) can't provide that: the same "card"
 *   would show a different picture every time and there'd be nothing to trade
 *   or duplicate-check against.
 *
 *   Jikan exposes characters with a permanent `mal_id`, a canonical name, a
 *   stable image URL and a `favorites` count. The mal_id becomes the card id and
 *   the favourites count drives rarity, which means rarity reflects genuine
 *   popularity rather than an arbitrary roll.
 *
 * Combat stats are derived deterministically from the mal_id, so a given
 * character always has the same base stats for everyone.
 */

import axios from 'axios';
import logger from '../utils/Logger';

const JIKAN_BASE = 'https://api.jikan.moe/v4';

const http = axios.create({
  headers: { 'Accept': 'application/json', 'User-Agent': 'ItsukiBot/1.0' },
  timeout: 9000,
});

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export interface RarityMeta {
  id: Rarity;
  label: string;
  colour: string;
  emoji: string;
  /** Multiplier applied to base combat stats. */
  statMul: number;
  /** Base coin value, used by upgrades and auction price floors. */
  value: number;
}

export const RARITIES: Record<Rarity, RarityMeta> = {
  common:    { id: 'common',    label: 'Common',    colour: '#9AA0A6', emoji: '⚪', statMul: 1.0, value: 250 },
  uncommon:  { id: 'uncommon',  label: 'Uncommon',  colour: '#4CAF50', emoji: '🟢', statMul: 1.25, value: 750 },
  rare:      { id: 'rare',      label: 'Rare',      colour: '#2196F3', emoji: '🔵', statMul: 1.6, value: 2_500 },
  epic:      { id: 'epic',      label: 'Epic',      colour: '#9C27B0', emoji: '🟣', statMul: 2.1, value: 8_000 },
  legendary: { id: 'legendary', label: 'Legendary', colour: '#FFC107', emoji: '🟡', statMul: 3.0, value: 25_000 },
};

export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export interface CardTemplate {
  /** MAL character id — the permanent card identity. */
  id: number;
  name: string;
  imageUrl: string;
  animeName: string | null;
  favorites: number;
  rarity: Rarity;
  baseAttack: number;
  baseHealth: number;
}

/** Rarity from MAL favourites — popularity-driven rather than arbitrary. */
export function rarityFromFavorites(favorites: number): Rarity {
  const f = Number(favorites) || 0;
  if (f >= 20_000) return 'legendary';
  if (f >= 8_000)  return 'epic';
  if (f >= 2_000)  return 'rare';
  if (f >= 300)    return 'uncommon';
  return 'common';
}

/**
 * Deterministic hash → the same mal_id always yields the same stats.
 * (xorshift-style mix; only needs to be well-distributed, not secure.)
 */
function seededValue(seed: number, salt: number): number {
  let x = (seed ^ (salt * 0x9E3779B1)) >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5;  x >>>= 0;
  return x / 0xFFFFFFFF;
}

export function statsFor(malId: number, rarity: Rarity): { baseAttack: number; baseHealth: number } {
  const mul = RARITIES[rarity].statMul;
  // Spread within a band so same-rarity cards still differ.
  const atk = 40 + Math.floor(seededValue(malId, 1) * 25);
  const hp  = 180 + Math.floor(seededValue(malId, 2) * 70);
  return {
    baseAttack: Math.round(atk * mul),
    baseHealth: Math.round(hp * mul),
  };
}

interface JikanCharacter {
  mal_id?: number;
  name?: string;
  favorites?: number;
  images?: { jpg?: { image_url?: string }; webp?: { image_url?: string } };
  anime?: Array<{ anime?: { title?: string } }>;
}

function toTemplate(c: JikanCharacter): CardTemplate | null {
  const id = Number(c?.mal_id);
  const name = typeof c?.name === 'string' ? c.name.trim() : '';
  const imageUrl = c?.images?.jpg?.image_url ?? c?.images?.webp?.image_url ?? '';

  // A card with no id, name or artwork is useless — reject rather than ship a
  // broken entry into someone's collection.
  if (!Number.isInteger(id) || id <= 0 || !name || !imageUrl) return null;
  // Jikan serves a placeholder for characters with no artwork.
  if (/questionmark|apple-touch-icon/i.test(imageUrl)) return null;

  const favorites = Math.max(0, Number(c?.favorites) || 0);
  const rarity = rarityFromFavorites(favorites);
  const { baseAttack, baseHealth } = statsFor(id, rarity);

  return {
    id, name, imageUrl, favorites, rarity, baseAttack, baseHealth,
    animeName: c?.anime?.[0]?.anime?.title ?? null,
  };
}

/**
 * Pool of popular characters, cached in memory.
 *
 * Jikan is rate limited (roughly 3 req/s, 60/min), and /roll is a hot command,
 * so pages are cached for the process lifetime rather than re-fetched per roll.
 */
const pageCache = new Map<number, CardTemplate[]>();
const MAX_POOL_PAGE = 40; // ~1000 characters, ordered by favourites

const CardService = {
  RARITIES, RARITY_ORDER,

  /** Fetches (and caches) one page of characters ordered by popularity. */
  async fetchPage(page: number): Promise<CardTemplate[]> {
    const p = Math.max(1, Math.min(Math.floor(page) || 1, MAX_POOL_PAGE));
    const cached = pageCache.get(p);
    if (cached) return cached;

    try {
      const res = await http.get<{ data?: JikanCharacter[] }>(`${JIKAN_BASE}/characters`, {
        params: { page: p, limit: 25, order_by: 'favorites', sort: 'desc' },
      });
      const templates = (res.data?.data ?? [])
        .map(toTemplate)
        .filter((t): t is CardTemplate => t !== null);

      if (templates.length) pageCache.set(p, templates);
      return templates;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      logger.warn(`[CardService] Jikan page ${p} failed${status ? ` (HTTP ${status})` : ''}: ${(err as Error).message}`);
      return [];
    }
  },

  /**
   * Draws a random card.
   *
   * Page choice is weighted toward later pages so that legendaries (which
   * cluster on page 1) stay scarce — otherwise every roll would be top-tier.
   */
  async randomCard(): Promise<CardTemplate | null> {
    const weighted = Math.floor(Math.pow(Math.random(), 0.45) * MAX_POOL_PAGE) + 1;

    for (const page of [weighted, 1 + Math.floor(Math.random() * MAX_POOL_PAGE), 1]) {
      const pool = await this.fetchPage(page);
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    }
    return null;
  },

  /** Looks up a single character by MAL id (used to repair stored cards). */
  async fetchById(malId: number): Promise<CardTemplate | null> {
    for (const [, pool] of pageCache) {
      const hit = pool.find((c) => c.id === malId);
      if (hit) return hit;
    }
    try {
      const res = await http.get<{ data?: JikanCharacter }>(`${JIKAN_BASE}/characters/${malId}`);
      return res.data?.data ? toTemplate(res.data.data) : null;
    } catch {
      return null;
    }
  },

  /** Warms the cache so the first /roll isn't slow. Safe to call on startup. */
  async preload(): Promise<number> {
    const pages = [1, 2, 3];
    let loaded = 0;
    for (const p of pages) {
      const pool = await this.fetchPage(p);
      loaded += pool.length;
      // Stay well inside Jikan's rate limit.
      await new Promise((r) => setTimeout(r, 400));
    }
    if (loaded) logger.info(`[CardService] Preloaded ${loaded} character templates.`);
    return loaded;
  },
};

export default CardService;
