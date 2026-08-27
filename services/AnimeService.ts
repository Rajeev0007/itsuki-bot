/**
 * @file AnimeService.ts
 * @description Fetches anime data from Jikan (MyAnimeList) and Waifu.pics.
 */

import axios  from 'axios';
import logger from '../utils/Logger';
import fmt    from '../utils/Formatter';
import config from '../config/config';

const JIKAN_BASE = 'https://api.jikan.moe/v4';
const WAIFU_BASE = 'https://api.waifu.pics/sfw';

/**
 * SFW categories waifu.pics serves.
 *
 * Exported so the /waifu command builds its choices from the same list the
 * service validates against — the two used to be maintained separately, which
 * is exactly how a command ends up offering a category the API rejects.
 */
export const WAIFU_CATEGORIES = [
  'waifu', 'neko', 'shinobu', 'megumin', 'bully', 'cuddle', 'cry', 'hug',
  'awoo', 'kiss', 'lick', 'pat', 'smug', 'bonk', 'yeet', 'blush', 'smile',
  'wave', 'highfive', 'handhold', 'nom', 'bite', 'glomp', 'slap', 'happy',
  'wink', 'poke', 'dance', 'cringe',
] as const;

// See GifService.ts — same UA-based blocking issue affects these hosts too.
const http = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; ItsukiBot/1.0; +https://discord.com)',
    'Accept':     'application/json',
  },
});

export interface JikanAnime {
  mal_id: number; title: string; title_english?: string;
  type?: string; episodes?: number; status?: string; score?: number;
  rank?: number; popularity?: number; synopsis?: string; url: string;
  images?: { jpg?: { image_url?: string; large_image_url?: string } };
  genres?: Array<{ name: string }>; studios?: Array<{ name: string }>;
  aired?: { string?: string; from?: string }; year?: number;
}

/**
 * Why searchAnime reports failures instead of returning [].
 *
 * Jikan rate limits at roughly 3 requests/second and 60/minute, and answers with
 * 429. Collapsing that into an empty array made the command tell the user their
 * correctly-spelled title "does not exist" — the one explanation that is
 * definitely wrong. A miss and an outage need to be distinguishable.
 */
export class AnimeServiceError extends Error {
  constructor(
    message: string,
    readonly kind: 'rate_limited' | 'upstream' | 'network',
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'AnimeServiceError';
  }
}

/** Classifies an axios failure into something a command can act on. */
function classify(err: unknown): AnimeServiceError {
  const response = (err as { response?: { status?: number; headers?: Record<string, unknown> } }).response;
  const status = response?.status;

  if (status === 429) {
    // Jikan sends Retry-After in seconds when it throttles.
    const header = response?.headers?.['retry-after'];
    const seconds = Number(Array.isArray(header) ? header[0] : header);
    return new AnimeServiceError(
      'The anime database is rate limiting us. Try again in a moment.',
      'rate_limited',
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000,
    );
  }
  if (typeof status === 'number' && status >= 500) {
    return new AnimeServiceError('The anime database is having problems. Try again shortly.', 'upstream');
  }
  return new AnimeServiceError(`Could not reach the anime database: ${(err as Error).message}`, 'network');
}

const AnimeService = {
  /**
   * Searches for anime.
   *
   * Returns [] ONLY for a genuine no-results answer. Anything else throws an
   * AnimeServiceError so the caller can say what actually went wrong.
   */
  async searchAnime(query: string): Promise<JikanAnime[]> {
    try {
      const res = await http.get<{ data: JikanAnime[] }>(`${JIKAN_BASE}/anime`, {
        params: { q: query, limit: 5, sfw: true }, timeout: 8000,
      });
      // A 200 with no data is a real "not found".
      return res.data?.data ?? [];
    } catch (err) {
      const error = classify(err);
      logger.warn(`[AnimeService] searchAnime(${query}) failed: ${error.kind} — ${(err as Error).message}`);
      throw error;
    }
  },

  async getAnimeById(id: number): Promise<JikanAnime | null> {
    try {
      const res = await http.get<{ data: JikanAnime }>(`${JIKAN_BASE}/anime/${id}`, { timeout: 8000 });
      return res.data?.data ?? null;
    } catch { return null; }
  },

  async getTopAnime(limit = 10): Promise<JikanAnime[]> {
    try {
      const res = await http.get<{ data: JikanAnime[] }>(`${JIKAN_BASE}/top/anime`, { params: { limit }, timeout: 8000 });
      return res.data?.data ?? [];
    } catch { return []; }
  },

  async getRandomAnime(): Promise<JikanAnime | null> {
    try {
      const res = await http.get<{ data: JikanAnime }>(`${JIKAN_BASE}/random/anime`, { timeout: 8000 });
      return res.data?.data ?? null;
    } catch { return null; }
  },

  async searchCharacter(query: string): Promise<unknown[]> {
    try {
      const res = await http.get<{ data: unknown[] }>(`${JIKAN_BASE}/characters`, {
        params: { q: query, limit: 5 }, timeout: 8000,
      });
      return res.data?.data ?? [];
    } catch { return []; }
  },

  async getSeasonalAnime(): Promise<JikanAnime[]> {
    try {
      const res = await http.get<{ data: JikanAnime[] }>(`${JIKAN_BASE}/seasons/now`, { params: { limit: 10 }, timeout: 8000 });
      return res.data?.data ?? [];
    } catch { return []; }
  },

  /** True when waifu.pics actually serves this category. */
  isValidWaifuCategory(type: string): boolean {
    return (WAIFU_CATEGORIES as readonly string[]).includes(type);
  },

  async getWaifuImage(type = 'waifu'): Promise<string | null> {
    const t = this.isValidWaifuCategory(type) ? type : 'waifu';
    try {
      const res = await http.get<{ url: string }>(`${WAIFU_BASE}/${t}`, { timeout: 5000 });
      return res.data?.url ?? null;
    } catch (err) {
      logger.warn(`[AnimeService] getWaifuImage("${t}") failed: ${(err as Error).message}`);
      return null;
    }
  },

  async drawCard(): Promise<{
    id: string; animeId: number; name: string; rarity: string;
    imageUrl: string | null; score: number; episodes: number; drawnAt: number;
  }> {
    const rarity = fmt.weightedRandom(
      [...config.anime.cardRarities],
      config.anime.rarityWeights,
    );
    try {
      const anime = await this.getRandomAnime();
      if (!anime) throw new Error('No anime data');
      return {
        id: `${anime.mal_id}_${Date.now()}`, animeId: anime.mal_id, name: anime.title,
        rarity, imageUrl: anime.images?.jpg?.image_url ?? null,
        score: anime.score ?? 0, episodes: anime.episodes ?? 0, drawnAt: Date.now(),
      };
    } catch {
      return {
        id: `card_${Date.now()}`, animeId: 0, name: 'Mystery Anime',
        rarity, imageUrl: null, score: 0, episodes: 0, drawnAt: Date.now(),
      };
    }
  },

  formatAnime(anime: JikanAnime) {
    return {
      title:    anime.title ?? 'Unknown',
      titleEn:  anime.title_english ?? anime.title,
      type:     anime.type ?? 'Unknown',
      episodes: anime.episodes ?? '?',
      status:   anime.status ?? 'Unknown',
      score:    anime.score ?? 'N/A',
      rank:     anime.rank ?? 'N/A',
      synopsis: anime.synopsis ? fmt.truncate(anime.synopsis, 300) : 'No synopsis available.',
      imageUrl: anime.images?.jpg?.large_image_url ?? anime.images?.jpg?.image_url ?? null,
      url:      anime.url ?? null,
      genres:   (anime.genres ?? []).map((g) => g.name).join(', ') || 'Unknown',
      studios:  (anime.studios ?? []).map((s) => s.name).join(', ') || 'Unknown',
      year:     anime.year ?? (anime.aired?.from ? new Date(anime.aired.from).getFullYear() : 'Unknown'),
      mal_id:   anime.mal_id,
    };
  },
};

export default AnimeService;
