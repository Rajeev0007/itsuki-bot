/**
 * @file ContentFilter.ts
 * @description Screens externally-sourced text (music search results in
 * particular) for explicit content before it is echoed into a channel.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * /play accepts a free-text query and searches YouTube/SoundCloud, then prints
 * the resulting title and author. A user could therefore surface pornographic
 * titles and thumbnails in a non-NSFW channel simply by searching for them.
 * That is what got the bot declined from a bot list.
 *
 * Lavalink exposes no "safe search" flag, so results are screened on arrival
 * instead. Filtering at INGESTION rather than at display is deliberate: a
 * blocked track never enters the queue, so /queue, /nowplaying, the now-playing
 * thumbnail and autoplay are all covered by this one check rather than each
 * needing its own.
 *
 * ── Avoiding the Scunthorpe problem ─────────────────────────────────────────
 * Naive substring matching flags innocent words — "analysis" contains "anal",
 * "Sussex" contains "ssex", "grape" contains "rape". Every term is therefore
 * matched on WORD BOUNDARIES, and terms that are common substrings are only
 * matched as standalone words.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Tier 1 — matched ANYWHERE in the text, including inside compounds.
 *
 * Reserved for strings that never occur inside an innocent English word, so
 * substring matching is safe. This tier is what catches "PornStar", "pornhub"
 * and "HentaiHaven", which word-boundary matching misses entirely because the
 * boundary falls in the wrong place.
 */
const LOOSE_TERMS = [
  'porn', 'pron', 'hentai', 'rule34', 'onlyfans', 'brazzers', 'xvideos',
  'xhamster', 'redtube', 'youporn', 'spankbang', 'chaturbate', 'camgirl',
  'camwhore', 'blowjob', 'handjob', 'rimjob', 'footjob', 'titjob',
  'creampie', 'deepthroat', 'gangbang', 'bangbros', 'cumshot', 'bukkake',
  'ahegao', 'masturbat', 'cunnilingus', 'anilingus', 'fellatio',
  'striptease', 'nymphomaniac',
  // Illegal categories — substring so obfuscated compounds are still caught.
  'childporn', 'lolicon', 'shotacon', 'jailbait', 'pedophil', 'bestiality',
  'zoophilia', 'necrophilia', 'molestation',
];

/**
 * Tier 2 — matched as WHOLE WORDS only.
 *
 * These are real words that appear innocently inside longer ones, so substring
 * matching would produce false positives: "anal" in "analysis", "pussy" in
 * "Pussycat Dolls", "sex" in "Sussex".
 *
 * Deliberately EXCLUDED after testing against real artist and track names,
 * because they blocked legitimate music:
 *   dick      — Dick Dale, Moby Dick
 *   cock      — Cock Robin, cocktail, Hitchcock
 *   hardcore  — a music genre (hardcore punk/techno)
 *   softcore  — likewise
 *   xxx       — XXXTentacion
 *   nude/naked/facial — common, non-pornographic song titles
 *   penis/vagina/clitoris — medical register, not porn signals
 *
 * The strong signals in tier 1 carry the actual filtering; this tier only adds
 * unambiguous adult vocabulary.
 */
const STRICT_TERMS = [
  'porno', 'nsfw', 'x-rated', 'doujin', 'ecchi',
  'squirting', 'fingering', 'jerkoff', 'fapping', 'orgasm', 'orgasming',
  'anal', 'sodomy', 'nudes', 'topless', 'boobs', 'titties', 'nipples',
  'pussy', 'genitals', 'cumming', 'jizz', 'semen',
  'bdsm', 'bondage', 'fetish', 'erotica', 'erotic', 'stripper',
  'escort', 'brothel', 'prostitute', 'hooker', 'milf', 'dilf',
  'stepsis', 'stepmom', 'stepbro',
  // Illegal — whole-word forms.
  'cp', 'pedo', 'incest', 'rape', 'raping', 'noncon', 'molest',
];

/** Everything the filter knows about, for the always-blocked cross-check. */
const EXPLICIT_TERMS = [...LOOSE_TERMS, ...STRICT_TERMS];

/**
 * Terms that must NEVER be shown, even in an NSFW channel.
 *
 * NSFW channels permit adult content; they do not permit content depicting
 * minors or non-consent, which is prohibited outright by Discord's terms.
 */
const ALWAYS_BLOCKED = new Set([
  'cp', 'childporn', 'lolicon', 'shotacon', 'jailbait', 'pedo', 'pedophil',
  'bestiality', 'zoophilia', 'necrophilia', 'rape', 'raping', 'noncon',
  'molest', 'molestation', 'incest',
]);

/** Hosts that serve adult content exclusively. */
const EXPLICIT_HOSTS = [
  'pornhub.com', 'xvideos.com', 'xhamster.com', 'redtube.com', 'youporn.com',
  'onlyfans.com', 'brazzers.com', 'spankbang.com', 'xnxx.com', 'chaturbate.com',
  'rule34.xxx', 'e621.net', 'nhentai.net', 'hanime.tv', 'fakku.net',
];

const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Tier 1: substring, no boundaries. */
const LOOSE_PATTERN = new RegExp(`(${LOOSE_TERMS.map(escape).join('|')})`, 'i');

/**
 * Tier 2: whole words only. The optional trailing "s"/"es" catches simple
 * plurals without reaching into unrelated longer words.
 */
const STRICT_PATTERN = new RegExp(`\\b(${STRICT_TERMS.map(escape).join('|')})(?:es|s)?\\b`, 'i');

export interface ScreenResult {
  /** True when the content should not be shown in the current channel. */
  blocked: boolean;
  /** The matched term, for logging. Never shown to users verbatim. */
  match?: string;
  /** True when it is disallowed regardless of channel NSFW status. */
  alwaysBlocked?: boolean;
}

/**
 * Normalises text before matching, to defeat trivial evasion.
 *
 * Handles leetspeak digit substitution, and strips separators inserted between
 * letters (p.o.r.n, p-o-r-n, p o r n) — though the spaced form is only
 * collapsed when every group is a single character, so ordinary titles are
 * unaffected.
 */
function normalise(text: string): string[] {
  const lower = String(text ?? '').toLowerCase();

  const deleet = lower
    .replace(/[0]/g, 'o').replace(/[1!|]/g, 'i').replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/[7]/g, 't');

  // Collapse single-character-separated runs: "p.o.r.n" -> "porn"
  const collapsed = deleet.replace(/\b(?:[a-z][^a-z0-9]){2,}[a-z]\b/g, (m) => m.replace(/[^a-z]/g, ''));

  return [lower, deleet, collapsed];
}

/** Screens arbitrary text against both tiers. */
export function screenText(text: string): ScreenResult {
  for (const variant of normalise(text)) {
    const loose = LOOSE_PATTERN.exec(variant);
    if (loose) {
      const term = loose[1].toLowerCase();
      return { blocked: true, match: term, alwaysBlocked: ALWAYS_BLOCKED.has(term) };
    }
    const strict = STRICT_PATTERN.exec(variant);
    if (strict) {
      const term = strict[1].toLowerCase();
      return { blocked: true, match: term, alwaysBlocked: ALWAYS_BLOCKED.has(term) };
    }
  }
  return { blocked: false };
}

/** Exposed for tests and diagnostics. */
export const knownTermCount = EXPLICIT_TERMS.length;

/** Screens a URL, checking the host against known adult sites. */
export function screenUrl(url: string): ScreenResult {
  const raw = String(url ?? '').toLowerCase();
  for (const host of EXPLICIT_HOSTS) {
    // Match the host portion specifically, so a title mentioning a site name
    // in passing isn't treated as a link to it.
    if (new RegExp(`//(?:[\\w-]+\\.)*${host.replace(/\./g, '\\.')}(?:[/:?#]|$)`).test(raw)) {
      return { blocked: true, match: host };
    }
  }
  return screenText(raw.replace(/[/_-]+/g, ' '));
}

export interface TrackLike {
  info?: { title?: string; author?: string; uri?: string };
}

/**
 * Screens a music track across its title, author and URI.
 *
 * `allowExplicit` reflects whether the destination channel is marked NSFW.
 * Content in ALWAYS_BLOCKED is refused even then.
 */
export function screenTrack(track: TrackLike, allowExplicit = false): ScreenResult {
  const info = track?.info ?? {};

  for (const field of [info.title, info.author]) {
    if (!field) continue;
    const result = screenText(field);
    if (result.blocked) {
      if (result.alwaysBlocked) return result;
      if (!allowExplicit) return result;
    }
  }

  if (info.uri) {
    const result = screenUrl(info.uri);
    if (result.blocked) {
      if (result.alwaysBlocked) return result;
      if (!allowExplicit) return result;
    }
  }

  return { blocked: false };
}

/**
 * Filters a track list, returning the survivors and how many were removed.
 *
 * Used by /play so a blocked result never reaches the queue.
 */
export function filterTracks<T extends TrackLike>(
  tracks: T[], allowExplicit = false,
): { allowed: T[]; removed: number; sawAlwaysBlocked: boolean } {
  const allowed: T[] = [];
  let removed = 0;
  let sawAlwaysBlocked = false;

  for (const track of tracks ?? []) {
    const result = screenTrack(track, allowExplicit);
    if (result.blocked) {
      removed++;
      if (result.alwaysBlocked) sawAlwaysBlocked = true;
      continue;
    }
    allowed.push(track);
  }
  return { allowed, removed, sawAlwaysBlocked };
}

/** True when the query itself is an obvious attempt to find adult content. */
export function screenQuery(query: string, allowExplicit = false): ScreenResult {
  const result = screenText(query);
  if (!result.blocked) return { blocked: false };
  if (result.alwaysBlocked) return result;
  return allowExplicit ? { blocked: false } : result;
}

export default { screenText, screenUrl, screenTrack, filterTracks, screenQuery };
