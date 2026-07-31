/**
 * @file GifService.ts
 * @description Fetches anime reaction GIFs from nekos.best (no API key required).
 *
 * Resilience matters here: nekos.best does not host an endpoint for every
 * action name a bot might want (`bonk` in particular is not one of its
 * categories), and a 404 previously just produced `null` — so the roleplay
 * command still posted, silently missing its GIF, with no clue why.
 *
 * Each action therefore declares a chain of candidate endpoints. The first that
 * responds wins; endpoints that come back 404 are remembered so we skip them on
 * subsequent calls instead of re-requesting a URL we know doesn't exist.
 */

import axios  from 'axios';
import logger from '../utils/Logger';

const BASE_URL = 'https://nekos.best/api/v2';

// Cloudflare (which fronts nekos.best) blocks axios's default User-Agent
// ('axios/x.x.x') with a 403 that is indistinguishable from a normal failure
// at the call site. A realistic UA avoids that.
const http = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; ItsukiBot/1.0; +https://discord.com)',
    'Accept':     'application/json',
  },
});

/**
 * action → ordered endpoint candidates.
 *
 * Where an action has no dedicated category upstream, the closest available
 * reaction is used as a stand-in so the command still shows something.
 */
const ACTION_ENDPOINTS: Record<string, string[]> = {
  hug:     ['hug'],
  kiss:    ['kiss'],
  pat:     ['pat'],
  slap:    ['slap'],
  cuddle:  ['cuddle'],
  poke:    ['poke'],
  wave:    ['wave'],
  dance:   ['dance'],
  cry:     ['cry'],
  // nekos.best has no `bonk` category — fall back to a comparable hit reaction.
  bonk:    ['bonk', 'punch', 'slap'],
  punch:   ['punch'],
  bite:    ['bite'],
  tickle:  ['tickle'],
  smile:   ['smile'],
  blush:   ['blush'],
  laugh:   ['laugh'],
  sleep:   ['sleep'],
  feed:    ['feed'],
  stare:   ['stare'],
  wink:    ['wink'],
  nod:     ['nod'],
  shoot:   ['shoot'],
  kick:    ['kick'],
  happy:   ['happy'],
  pout:    ['pout'],
  yeet:    ['yeet'],
  nom:     ['nom'],
  handhold:['handhold'],
  highfive:['highfive'],
  facepalm:['facepalm'],
  shrug:   ['shrug'],
  thumbsup:['thumbsup'],
  baka:    ['baka'],
  angry:   ['angry'],
};

/** Endpoints that returned 404 this run — don't ask again. */
const unavailable = new Set<string>();

interface NekosResult { url?: string }
interface NekosResponse { results?: NekosResult[] }

/** Ordered endpoint candidates for an action, skipping known-dead ones. */
function candidatesFor(action: string): string[] {
  const chain = ACTION_ENDPOINTS[action] ?? [action];
  const live = chain.filter((e) => !unavailable.has(e));
  // If everything in the chain is known-dead there's nothing to try.
  return live;
}

function pickUrl(data: NekosResponse | undefined): string | null {
  const results = data?.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const chosen = results[Math.floor(Math.random() * results.length)];
  return typeof chosen?.url === 'string' && chosen.url ? chosen.url : null;
}

const GifService = {
  /** A random GIF for the action, or null if every candidate failed. */
  async getGif(action: string): Promise<string | null> {
    const candidates = candidatesFor(action);
    if (!candidates.length) return null;

    for (const endpoint of candidates) {
      try {
        const res = await http.get<NekosResponse>(`${BASE_URL}/${endpoint}`, { timeout: 5000 });
        const url = pickUrl(res.data);
        if (url) return url;
        logger.debug(`[GifService] "${endpoint}" returned no results for "${action}"`);
      } catch (err) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 404) {
          // Permanent for this process — stop retrying it.
          unavailable.add(endpoint);
          logger.warn(`[GifService] Endpoint "${endpoint}" does not exist upstream; using a fallback for "${action}".`);
        } else {
          logger.warn(`[GifService] "${endpoint}" failed for "${action}": ${(err as Error).message}`);
        }
      }
    }
    return null;
  },

  async getGifs(action: string, amount = 1): Promise<string[]> {
    const count = Math.max(1, Math.min(20, Math.floor(amount) || 1));
    for (const endpoint of candidatesFor(action)) {
      try {
        const res = await http.get<NekosResponse>(
          `${BASE_URL}/${endpoint}`, { params: { amount: count }, timeout: 5000 },
        );
        const urls = (res.data?.results ?? [])
          .map((r) => r.url)
          .filter((u): u is string => typeof u === 'string' && u.length > 0);
        if (urls.length) return urls;
      } catch (err) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 404) unavailable.add(endpoint);
      }
    }
    return [];
  },

  supports(action: string): boolean { return action in ACTION_ENDPOINTS; },
  list():     string[]              { return Object.keys(ACTION_ENDPOINTS); },
};

export default GifService;
