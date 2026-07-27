/**
 * @file GifService.ts
 * @description Fetches anime GIFs from nekos.best (no API key required).
 */

import axios  from 'axios';
import logger from '../utils/Logger';

const BASE_URL = 'https://nekos.best/api/v2';

// Cloudflare (which fronts nekos.best) silently blocks requests carrying
// axios's default User-Agent ('axios/x.x.x'), returning a 403 that looks
// identical to a normal failure from the caller's side — the command just
// quietly renders without a gif. A realistic UA avoids that.
const http = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; ItsukiBot/1.0; +https://discord.com)',
    'Accept':     'application/json',
  },
});

const ACTION_MAP: Record<string, string> = {
  hug: 'hug', kiss: 'kiss', pat: 'pat', slap: 'slap', cuddle: 'cuddle',
  punch: 'punch', bite: 'bite', wave: 'wave', smile: 'smile', blush: 'blush',
  cry: 'cry', laugh: 'laugh', dance: 'dance', sleep: 'sleep', bonk: 'bonk',
  poke: 'poke', feed: 'feed', tickle: 'tickle', stare: 'stare', lick: 'lick',
  wink: 'wink', nod: 'nod', shoot: 'shoot', kick: 'kick',
};

interface NekosResult { url: string }
interface NekosResponse { results: NekosResult[] }

const GifService = {
  async getGif(action: string): Promise<string | null> {
    const endpoint = ACTION_MAP[action] ?? action;
    try {
      const res  = await http.get<NekosResponse>(`${BASE_URL}/${endpoint}`, { timeout: 5000 });
      const results = res.data?.results;
      if (!results?.length) return null;
      return results[Math.floor(Math.random() * results.length)].url ?? null;
    } catch (err) {
      logger.warn(`[GifService] Failed to fetch gif for "${action}": ${(err as Error).message}`);
      return null;
    }
  },

  async getGifs(action: string, amount = 1): Promise<string[]> {
    const endpoint = ACTION_MAP[action] ?? action;
    try {
      const res = await http.get<NekosResponse>(`${BASE_URL}/${endpoint}?amount=${amount}`, { timeout: 5000 });
      return (res.data?.results ?? []).map((r) => r.url).filter(Boolean);
    } catch {
      return [];
    }
  },

  supports(action: string): boolean { return action in ACTION_MAP; },
  list():     string[]              { return Object.keys(ACTION_MAP); },
};

export default GifService;
