/**
 * @file GameApiService.ts
 * @description Clients for the Minecraft, Valorant and Steam/CS2 lookups.
 *
 * Deliberate split by credential requirement:
 *
 *   KEYLESS (works with no setup)
 *     - Minecraft profiles      → Mojang API
 *     - Minecraft server status → api.mcsrvstat.us
 *     - Valorant game content   → valorant-api.com (agents, weapons, maps)
 *
 *   REQUIRES A KEY (feature is disabled with a clear message when absent)
 *     - Steam / CS2 player data → STEAM_API_KEY
 *     - Valorant player data    → HENRIKDEV_API_KEY
 *
 * Anything key-gated reports "not configured" and names the environment
 * variable, rather than failing with an opaque 401/403.
 */

import axios from 'axios';
import logger from '../utils/Logger';

const http = axios.create({
  timeout: 10_000,
  headers: { 'User-Agent': 'ItsukiBot/1.0', 'Accept': 'application/json' },
});

/** Typed failure so commands can distinguish "not found" from "API down". */
export class GameApiError extends Error {
  constructor(message: string, readonly kind: 'not_found' | 'unconfigured' | 'upstream' = 'upstream') {
    super(message);
    this.name = 'GameApiError';
  }
}

// ── Minecraft ────────────────────────────────────────────────────────────────

export interface McProfile {
  uuid: string;
  /** Dashed UUID, which is what most tools and APIs expect. */
  uuidDashed: string;
  name: string;
  avatarUrl: string;
  bodyUrl: string;
  skinUrl: string;
}

export interface McServer {
  online: boolean;
  host: string;
  port: number | null;
  version: string | null;
  motd: string | null;
  playersOnline: number;
  playersMax: number;
  iconDataUrl: string | null;
  software: string | null;
}

/** Mojang returns undashed UUIDs; most renderers want the dashed form. */
function dashUuid(raw: string): string {
  const id = String(raw).replace(/-/g, '');
  if (id.length !== 32) return raw;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export const Minecraft = {
  /** Resolves a username to a profile. Throws not_found for unknown names. */
  async getProfile(username: string): Promise<McProfile> {
    const name = String(username ?? '').trim();
    if (!/^[A-Za-z0-9_]{2,16}$/.test(name)) {
      throw new GameApiError('Minecraft usernames are 2-16 characters, letters, numbers and underscores only.', 'not_found');
    }

    let res;
    try {
      res = await http.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {
        validateStatus: () => true,
      } as never);
    } catch (err) {
      throw new GameApiError(`Could not reach Mojang: ${(err as Error).message}`);
    }

    // Mojang answers an unknown name with 204 or 404 depending on the edge node,
    // so both must be treated as "no such player".
    if (res.status === 204 || res.status === 404) {
      throw new GameApiError(`No Minecraft account named **${name}** exists.`, 'not_found');
    }
    if (res.status === 429) {
      throw new GameApiError('Mojang is rate-limiting requests. Try again shortly.');
    }
    if (res.status !== 200 || !res.data?.id) {
      throw new GameApiError(`Mojang returned HTTP ${res.status}.`);
    }

    const uuid = String(res.data.id);
    return {
      uuid,
      uuidDashed: dashUuid(uuid),
      name: String(res.data.name ?? name),
      // mc-heads renders from the UUID and needs no key.
      avatarUrl: `https://mc-heads.net/avatar/${uuid}/128`,
      bodyUrl: `https://mc-heads.net/body/${uuid}/256`,
      skinUrl: `https://mc-heads.net/skin/${uuid}`,
    };
  },

  /** Server status via mcsrvstat (keyless). Returns offline rather than throwing. */
  async getServer(address: string): Promise<McServer> {
    const host = String(address ?? '').trim().replace(/^https?:\/\//, '');
    if (!host || /\s/.test(host) || host.length > 253) {
      throw new GameApiError('Provide a server address like `mc.hypixel.net` or `1.2.3.4:25565`.', 'not_found');
    }

    let res;
    try {
      res = await http.get(`https://api.mcsrvstat.us/3/${encodeURIComponent(host)}`, {
        validateStatus: () => true,
      } as never);
    } catch (err) {
      throw new GameApiError(`Could not reach the status service: ${(err as Error).message}`);
    }
    if (res.status !== 200 || !res.data) {
      throw new GameApiError(`Status service returned HTTP ${res.status}.`);
    }

    const d = res.data as Record<string, never>;
    const motdLines = (d.motd as { clean?: string[] } | undefined)?.clean;

    return {
      online: Boolean(d.online),
      host: String(d.hostname ?? d.ip ?? host),
      port: Number(d.port) || null,
      version: (d.version as string | undefined) ?? null,
      motd: Array.isArray(motdLines) ? motdLines.join('\n').trim() || null : null,
      playersOnline: Number((d.players as { online?: number } | undefined)?.online) || 0,
      playersMax: Number((d.players as { max?: number } | undefined)?.max) || 0,
      iconDataUrl: typeof d.icon === 'string' ? d.icon : null,
      software: (d.software as string | undefined) ?? null,
    };
  },
};

// ── Valorant ─────────────────────────────────────────────────────────────────

export interface ValAgent {
  name: string;
  role: string | null;
  description: string;
  iconUrl: string | null;
  portraitUrl: string | null;
  abilities: Array<{ slot: string; name: string; description: string }>;
}

export interface ValWeapon {
  name: string;
  category: string;
  cost: number | null;
  magazine: number | null;
  fireRate: number | null;
  iconUrl: string | null;
  damage: Array<{ range: string; head: number; body: number; leg: number }>;
}

export interface ValMap {
  name: string;
  coordinates: string | null;
  splashUrl: string | null;
  minimapUrl: string | null;
}

/** valorant-api.com content cache — static data, so cache for the process. */
const valCache = new Map<string, unknown>();

async function valGet<T>(path: string): Promise<T> {
  const cached = valCache.get(path);
  if (cached) return cached as T;

  let res;
  try {
    res = await http.get(`https://valorant-api.com/v1/${path}`, { validateStatus: () => true } as never);
  } catch (err) {
    throw new GameApiError(`Could not reach valorant-api: ${(err as Error).message}`);
  }
  if (res.status !== 200 || res.data?.status !== 200) {
    throw new GameApiError(`valorant-api returned HTTP ${res.status}.`);
  }
  valCache.set(path, res.data.data);
  return res.data.data as T;
}

function cleanHtml(s: unknown): string {
  return String(s ?? '').replace(/<[^>]+>/g, '').trim();
}

export const Valorant = {
  /** Playable agents only — the endpoint otherwise includes an unused NPC. */
  async getAgents(): Promise<ValAgent[]> {
    const raw = await valGet<Array<Record<string, never>>>('agents?isPlayableCharacter=true');
    return (raw ?? []).map((a) => ({
      name: String(a.displayName ?? 'Unknown'),
      role: (a.role as { displayName?: string } | null)?.displayName ?? null,
      description: cleanHtml(a.description),
      iconUrl: (a.displayIcon as string | null) ?? null,
      portraitUrl: (a.fullPortrait as string | null) ?? (a.displayIcon as string | null) ?? null,
      abilities: ((a.abilities as Array<Record<string, never>> | undefined) ?? [])
        .filter((ab) => ab.displayName)
        .map((ab) => ({
          slot: String(ab.slot ?? '').replace('Ability', 'Ability '),
          name: String(ab.displayName),
          description: cleanHtml(ab.description),
        })),
    }));
  },

  async findAgent(query: string): Promise<ValAgent> {
    const q = String(query ?? '').trim().toLowerCase();
    const agents = await this.getAgents();
    // Exact match first so "Sova" doesn't resolve to something else.
    const hit = agents.find((a) => a.name.toLowerCase() === q)
      ?? agents.find((a) => a.name.toLowerCase().startsWith(q))
      ?? agents.find((a) => a.name.toLowerCase().includes(q));
    if (!hit) {
      throw new GameApiError(
        `No agent named \`${query}\`. Try: ${agents.slice(0, 8).map((a) => a.name).join(', ')}…`,
        'not_found',
      );
    }
    return hit;
  },

  async getWeapons(): Promise<ValWeapon[]> {
    const raw = await valGet<Array<Record<string, never>>>('weapons');
    return (raw ?? []).map((w) => {
      const stats = w.weaponStats as Record<string, never> | null;
      const ranges = (stats?.damageRanges as Array<Record<string, never>> | undefined) ?? [];
      return {
        name: String(w.displayName ?? 'Unknown'),
        category: String(w.category ?? '').split('::').pop() ?? 'Unknown',
        cost: Number((w.shopData as { cost?: number } | null)?.cost) || null,
        magazine: Number(stats?.magazineSize) || null,
        fireRate: Number(stats?.fireRate) || null,
        iconUrl: (w.displayIcon as string | null) ?? null,
        damage: ranges.map((r) => ({
          range: `${Number(r.rangeStartMeters) || 0}-${Number(r.rangeEndMeters) || 0}m`,
          head: Math.round(Number(r.headDamage) || 0),
          body: Math.round(Number(r.bodyDamage) || 0),
          leg: Math.round(Number(r.legDamage) || 0),
        })),
      };
    });
  },

  async findWeapon(query: string): Promise<ValWeapon> {
    const q = String(query ?? '').trim().toLowerCase();
    const weapons = await this.getWeapons();
    const hit = weapons.find((w) => w.name.toLowerCase() === q)
      ?? weapons.find((w) => w.name.toLowerCase().startsWith(q))
      ?? weapons.find((w) => w.name.toLowerCase().includes(q));
    if (!hit) {
      throw new GameApiError(
        `No weapon named \`${query}\`. Try: ${weapons.slice(0, 8).map((w) => w.name).join(', ')}…`,
        'not_found',
      );
    }
    return hit;
  },

  async getMaps(): Promise<ValMap[]> {
    const raw = await valGet<Array<Record<string, never>>>('maps');
    return (raw ?? [])
      // The list includes non-playable entries with no coordinates.
      .filter((m) => m.displayName && m.displayName !== 'The Range')
      .map((m) => ({
        name: String(m.displayName),
        coordinates: (m.coordinates as string | null) ?? null,
        splashUrl: (m.splash as string | null) ?? null,
        minimapUrl: (m.displayIcon as string | null) ?? null,
      }));
  },

  async findMap(query: string): Promise<ValMap> {
    const q = String(query ?? '').trim().toLowerCase();
    const maps = await this.getMaps();
    const hit = maps.find((m) => m.name.toLowerCase() === q)
      ?? maps.find((m) => m.name.toLowerCase().includes(q));
    if (!hit) {
      throw new GameApiError(
        `No map named \`${query}\`. Try: ${maps.map((m) => m.name).join(', ')}.`,
        'not_found',
      );
    }
    return hit;
  },

  /** Player lookup — needs HENRIKDEV_API_KEY. */
  async getPlayer(name: string, tag: string): Promise<{
    name: string; tag: string; region: string; level: number; cardUrl: string | null;
    rank: string | null; rr: number | null; elo: number | null;
  }> {
    const key = process.env.HENRIKDEV_API_KEY;
    if (!key) {
      throw new GameApiError(
        'Valorant player lookup needs an API key. Add `HENRIKDEV_API_KEY` to your `.env` (free from https://docs.henrikdev.xyz) and restart. Agent, weapon and map lookups work without one.',
        'unconfigured',
      );
    }

    const headers = { Authorization: key };
    let account;
    try {
      account = await http.get(
        `https://api.henrikdev.xyz/valorant/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
        { headers, validateStatus: () => true } as never,
      );
    } catch (err) {
      throw new GameApiError(`Could not reach the Valorant API: ${(err as Error).message}`);
    }

    if (account.status === 404) {
      throw new GameApiError(`No Valorant account **${name}#${tag}** found.`, 'not_found');
    }
    if (account.status === 401 || account.status === 403) {
      throw new GameApiError('The configured `HENRIKDEV_API_KEY` was rejected.', 'unconfigured');
    }
    if (account.status !== 200 || !account.data?.data) {
      throw new GameApiError(`Valorant API returned HTTP ${account.status}.`);
    }

    const acc = account.data.data as Record<string, never>;
    const region = String(acc.region ?? 'eu');

    // Rank is a separate endpoint; a missing rank is normal for unranked
    // players, so it must not fail the whole lookup.
    let rank: string | null = null, rr: number | null = null, elo: number | null = null;
    try {
      const mmr = await http.get(
        `https://api.henrikdev.xyz/valorant/v2/mmr/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
        { headers, validateStatus: () => true } as never,
      );
      const cur = (mmr.data?.data as { current_data?: Record<string, never> } | undefined)?.current_data;
      if (cur) {
        rank = (cur.currenttierpatched as string | null) ?? null;
        rr = Number(cur.ranking_in_tier);
        elo = Number(cur.elo);
        if (!Number.isFinite(rr)) rr = null;
        if (!Number.isFinite(elo)) elo = null;
      }
    } catch {
      /* rank is optional */
    }

    return {
      name: String(acc.name ?? name),
      tag: String(acc.tag ?? tag),
      region: region.toUpperCase(),
      level: Number(acc.account_level) || 0,
      cardUrl: (acc.card as { wide?: string } | undefined)?.wide ?? null,
      rank, rr, elo,
    };
  },
};

// ── Steam / CS2 ──────────────────────────────────────────────────────────────

export interface SteamProfile {
  steamId: string;
  name: string;
  avatarUrl: string | null;
  profileUrl: string;
  countryCode: string | null;
  createdAt: number | null;
  /** 0 offline, 1 online, 2 busy, 3 away, 4 snooze… */
  state: number;
}

export interface Cs2Stats {
  kills: number; deaths: number; wins: number; rounds: number;
  headshots: number; mvps: number; timePlayedHours: number;
  accuracy: number | null; kd: number | null; hsPercent: number | null;
}

const CS2_APPID = 730;

export const Steam = {
  isConfigured(): boolean {
    return Boolean(process.env.STEAM_API_KEY);
  },

  requireKey(): string {
    const key = process.env.STEAM_API_KEY;
    if (!key) {
      throw new GameApiError(
        'CS2 lookups need a Steam Web API key. Add `STEAM_API_KEY` to your `.env` (free from https://steamcommunity.com/dev/apikey) and restart.',
        'unconfigured',
      );
    }
    return key;
  },

  /** Accepts a 17-digit SteamID64 or a vanity URL name. */
  async resolveSteamId(input: string): Promise<string> {
    const key = this.requireKey();
    const raw = String(input ?? '').trim()
      // Tolerate a pasted profile URL.
      .replace(/^https?:\/\/steamcommunity\.com\/(id|profiles)\//i, '')
      .replace(/\/+$/, '');

    if (/^\d{17}$/.test(raw)) return raw;
    if (!raw) throw new GameApiError('Provide a SteamID64 or a profile name.', 'not_found');

    const res = await http.get('https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/', {
      params: { key, vanityurl: raw },
      validateStatus: () => true,
    } as never);

    // success === 1 means resolved; anything else means no such vanity name.
    const data = res.data?.response as { success?: number; steamid?: string } | undefined;
    if (res.status !== 200 || data?.success !== 1 || !data?.steamid) {
      throw new GameApiError(`Could not find a Steam profile for \`${raw}\`.`, 'not_found');
    }
    return data.steamid;
  },

  async getProfile(steamId: string): Promise<SteamProfile> {
    const key = this.requireKey();
    const res = await http.get('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/', {
      params: { key, steamids: steamId },
      validateStatus: () => true,
    } as never);

    const players = (res.data?.response as { players?: Array<Record<string, never>> } | undefined)?.players;
    if (res.status !== 200 || !players?.length) {
      throw new GameApiError(`No Steam profile found for \`${steamId}\`.`, 'not_found');
    }

    const p = players[0];
    return {
      steamId: String(p.steamid),
      name: String(p.personaname ?? 'Unknown'),
      avatarUrl: (p.avatarfull as string | null) ?? null,
      profileUrl: String(p.profileurl ?? `https://steamcommunity.com/profiles/${steamId}`),
      countryCode: (p.loccountrycode as string | null) ?? null,
      createdAt: Number(p.timecreated) ? Number(p.timecreated) * 1000 : null,
      state: Number(p.personastate) || 0,
    };
  },

  /**
   * CS2 stats. Returns null when the profile hides its game details, which is
   * the common case and not an error.
   */
  async getCs2Stats(steamId: string): Promise<Cs2Stats | null> {
    const key = this.requireKey();
    const res = await http.get('https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/', {
      params: { key, appid: CS2_APPID, steamid: steamId },
      validateStatus: () => true,
    } as never);

    // Steam answers 403 for private profiles and 400 when the user has never
    // played — neither is an error worth surfacing as a failure.
    if (res.status === 403 || res.status === 400) return null;
    if (res.status !== 200) throw new GameApiError(`Steam returned HTTP ${res.status}.`);

    const raw = (res.data?.playerstats as { stats?: Array<{ name: string; value: number }> } | undefined)?.stats;
    if (!Array.isArray(raw) || !raw.length) return null;

    const get = (name: string): number => Number(raw.find((s) => s.name === name)?.value) || 0;

    const kills = get('total_kills');
    const deaths = get('total_deaths');
    const shots = get('total_shots_fired');
    const hits = get('total_shots_hit');
    const headshots = get('total_kills_headshot');

    return {
      kills, deaths,
      wins: get('total_wins'),
      rounds: get('total_rounds_played'),
      headshots,
      mvps: get('total_mvps'),
      timePlayedHours: Math.round(get('total_time_played') / 3600),
      // Guard every divisor — a fresh account has zeroes everywhere.
      accuracy: shots > 0 ? Math.round((hits / shots) * 1000) / 10 : null,
      kd: deaths > 0 ? Math.round((kills / deaths) * 100) / 100 : null,
      hsPercent: kills > 0 ? Math.round((headshots / kills) * 1000) / 10 : null,
    };
  },
};

export default { Minecraft, Valorant, Steam, GameApiError };
