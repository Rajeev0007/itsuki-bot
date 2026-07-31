/**
 * @file AkinatorService.ts
 * @description Client for Akinator's web game.
 *
 * IMPORTANT — read before debugging:
 *   Akinator publishes no public API. This drives the same endpoints its
 *   website uses, which means the session bootstrap is HTML scraping and the
 *   contract can change without notice. Everything here is therefore written
 *   defensively: every field is validated, parse failures produce a typed error
 *   instead of a crash, and the caller is expected to surface a clear message
 *   rather than hang.
 *
 * Flow:
 *   1. POST /game            → HTML containing `session`, `signature` and the
 *                              first question.
 *   2. POST /answer          → JSON with the next question, or a guess.
 *   3. POST /exclusion       → "keep going" after rejecting a guess.
 *
 * If Akinator changes its markup, step 1 is what breaks first. The regexes are
 * deliberately loose (attribute order independent) to survive minor changes.
 */

import axios, { type AxiosInstance } from 'axios';
import logger from '../utils/Logger';

/** Answer indices Akinator expects. */
export const ANSWERS = [
  { id: 'yes',           label: 'Yes',           value: 0 },
  { id: 'no',            label: 'No',            value: 1 },
  { id: 'dont_know',     label: "Don't know",    value: 2 },
  { id: 'probably',      label: 'Probably',      value: 3 },
  { id: 'probably_not',  label: 'Probably not',  value: 4 },
] as const;

export type AnswerId = typeof ANSWERS[number]['id'];

export interface AkiSession {
  region: string;
  session: string;
  signature: string;
  step: number;
  progression: number;
  stepLastProposition: string;
}

export interface AkiQuestion {
  kind: 'question';
  question: string;
  step: number;
  progression: number;
}

export interface AkiGuess {
  kind: 'guess';
  name: string;
  description: string;
  photo: string | null;
  /** Akinator's confidence, 0-100. */
  progression: number;
}

export type AkiTurn = AkiQuestion | AkiGuess;

export class AkinatorError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = 'AkinatorError';
  }
}

/** Supported regions → Akinator subdomain. */
const REGIONS: Record<string, string> = {
  en: 'en', fr: 'fr', de: 'de', es: 'es', it: 'it',
  pt: 'pt', nl: 'nl', ru: 'ru', jp: 'jp', ar: 'ar',
};

function makeClient(region: string): AxiosInstance {
  const base = `https://${region}.akinator.com`;
  return axios.create({
    baseURL: base,
    timeout: 12_000,
    // Akinator rejects non-browser clients, and follows form-encoded POSTs.
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': 'application/json, text/html;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin': base,
      'Referer': `${base}/game`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    // 4xx/5xx are handled explicitly rather than thrown, so the error message
    // can say what actually happened.
    validateStatus: () => true,
  } as never);
}

/** Extracts a hidden form input's value, tolerant of attribute order. */
function extractInput(html: string, name: string): string | null {
  const patterns = [
    new RegExp(`<input[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i'),
    new RegExp(`<input[^>]*value=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1] !== undefined) return m[1];
  }
  return null;
}

function extractQuestion(html: string): string | null {
  const patterns = [
    /id=["']question-label["'][^>]*>([^<]+)</i,
    /class=["'][^"']*question-text[^"']*["'][^>]*>([^<]+)</i,
    /<p[^>]*id=["']question["'][^>]*>([^<]+)</i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]?.trim()) return decodeEntities(m[1].trim());
  }
  return null;
}

/** Akinator HTML-escapes its questions. */
function decodeEntities(str: string): string {
  const named: Record<string, string> = {
    quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', nbsp: ' ',
    eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', ccedil: 'ç',
    rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D', hellip: '…',
  };
  return str
    .replace(/&#(\d+);/g, (_m, d) => {
      const code = Number(d);
      return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      const code = parseInt(h, 16);
      return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : _m;
    })
    .replace(/&([a-z]+);/gi, (m, n) => named[String(n).toLowerCase()] ?? m);
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

interface AkiAnswerResponse {
  completion?: string;
  question?: string;
  step?: string | number;
  progression?: string | number;
  id_proposition?: string;
  name_proposition?: string;
  description_proposition?: string;
  photo?: string;
  step_last_proposition?: string;
}

/**
 * Interprets an /answer or /exclusion payload.
 *
 * A guess is signalled by a populated `id_proposition`; a question by a
 * populated `question`. Anything else means the contract changed or the session
 * expired, both of which must be reported rather than silently retried.
 */
function interpret(data: AkiAnswerResponse, session: AkiSession): AkiTurn {
  const completion = String(data?.completion ?? '').toUpperCase();

  // Akinator uses completion for soft errors too, e.g. "KO - TIMEOUT".
  if (completion.startsWith('KO')) {
    throw new AkinatorError(`Akinator ended the session (${data.completion}).`, false);
  }

  const guessId = String(data?.id_proposition ?? '').trim();
  const guessName = String(data?.name_proposition ?? '').trim();

  if (guessId && guessName) {
    session.stepLastProposition = String(data?.step_last_proposition ?? session.step);
    return {
      kind: 'guess',
      name: guessName,
      description: String(data?.description_proposition ?? '').trim(),
      photo: typeof data?.photo === 'string' && /^https?:\/\//.test(data.photo) ? data.photo : null,
      progression: Math.min(100, Math.max(0, toNumber(data?.progression, session.progression))),
    };
  }

  const question = String(data?.question ?? '').trim();
  if (!question) {
    throw new AkinatorError('Akinator returned neither a question nor a guess. The service may have changed.', false);
  }

  session.step = toNumber(data?.step, session.step + 1);
  session.progression = toNumber(data?.progression, session.progression);

  return {
    kind: 'question',
    question: decodeEntities(question),
    step: session.step,
    progression: session.progression,
  };
}

const AkinatorService = {
  ANSWERS,

  isValidRegion(region: string): boolean {
    return region in REGIONS;
  },

  regions(): string[] {
    return Object.keys(REGIONS);
  },

  /** Starts a game, returning the session plus the first question. */
  async start(region = 'en'): Promise<{ session: AkiSession; turn: AkiTurn }> {
    const lang = REGIONS[region] ?? 'en';
    const http = makeClient(lang);

    let res;
    try {
      res = await http.post('/game', new URLSearchParams({ sid: '1', cm: 'false' }).toString());
    } catch (err) {
      throw new AkinatorError(`Could not reach Akinator: ${(err as Error).message}`);
    }

    if (res.status !== 200 || typeof res.data !== 'string') {
      throw new AkinatorError(`Akinator returned HTTP ${res.status} when starting a game.`);
    }

    const html = res.data;
    const sessionId = extractInput(html, 'session');
    const signature = extractInput(html, 'signature');
    const question = extractQuestion(html);

    if (!sessionId || !signature) {
      logger.warn('[Akinator] Could not find session/signature in the page — markup likely changed.');
      throw new AkinatorError(
        'Akinator changed its website and the session could not be started.',
        false,
      );
    }
    if (!question) {
      throw new AkinatorError('Akinator did not return a first question.', false);
    }

    const session: AkiSession = {
      region: lang,
      session: sessionId,
      signature,
      step: 0,
      progression: 0,
      stepLastProposition: '',
    };

    return { session, turn: { kind: 'question', question, step: 0, progression: 0 } };
  },

  /** Submits an answer and returns the next question or a guess. */
  async answer(session: AkiSession, answerId: AnswerId): Promise<AkiTurn> {
    const choice = ANSWERS.find((a) => a.id === answerId);
    if (!choice) throw new AkinatorError(`Unknown answer "${answerId}".`, false);

    const http = makeClient(session.region);
    const body = new URLSearchParams({
      step: String(session.step),
      progression: String(session.progression),
      sid: '1',
      cm: 'false',
      answer: String(choice.value),
      step_last_proposition: session.stepLastProposition,
      session: session.session,
      signature: session.signature,
    }).toString();

    let res;
    try {
      res = await http.post('/answer', body);
    } catch (err) {
      throw new AkinatorError(`Could not reach Akinator: ${(err as Error).message}`);
    }
    if (res.status !== 200) {
      throw new AkinatorError(`Akinator returned HTTP ${res.status}.`);
    }

    // Some deployments return the JSON as a string body.
    const data = typeof res.data === 'string' ? safeJson(res.data) : res.data;
    if (!data) throw new AkinatorError('Akinator sent an unreadable response.', false);

    return interpret(data as AkiAnswerResponse, session);
  },

  /**
   * Rejects the current guess and continues.
   *
   * Akinator calls this "exclusion" — it eliminates the proposed answer and
   * resumes questioning rather than starting over.
   */
  async reject(session: AkiSession): Promise<AkiTurn> {
    const http = makeClient(session.region);
    const body = new URLSearchParams({
      step: String(session.step),
      progression: String(session.progression),
      sid: '1',
      cm: 'false',
      forward_answer: '1',
      session: session.session,
      signature: session.signature,
    }).toString();

    let res;
    try {
      res = await http.post('/exclusion', body);
    } catch (err) {
      throw new AkinatorError(`Could not reach Akinator: ${(err as Error).message}`);
    }
    if (res.status !== 200) {
      throw new AkinatorError(`Akinator returned HTTP ${res.status}.`);
    }

    const data = typeof res.data === 'string' ? safeJson(res.data) : res.data;
    if (!data) throw new AkinatorError('Akinator sent an unreadable response.', false);
    return interpret(data as AkiAnswerResponse, session);
  },
};

function safeJson(raw: string): unknown | null {
  try { return JSON.parse(raw); } catch { return null; }
}

export default AkinatorService;
