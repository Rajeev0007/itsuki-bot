/**
 * @file TriviaService.ts
 * @description Fetches trivia questions from the Open Trivia Database
 * (opentdb.com) — free, no API key required.
 */

import axios  from 'axios';
import logger from '../utils/Logger';

// Same lesson as GifService/AnimeService: a realistic User-Agent avoids
// being silently blocked by hosts that reject default axios/x.x.x UAs.
const http = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; ItsukiBot/1.0; +https://discord.com)',
    'Accept':     'application/json',
  },
});

const BASE_URL = 'https://opentdb.com/api.php';

export interface TriviaQuestion {
  category:      string;
  difficulty:    'easy' | 'medium' | 'hard';
  question:      string;
  correctAnswer: string;
  answers:       string[]; // correct + incorrect, shuffled
}

/** Named entities opentdb emits that have no numeric form in its output. */
const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', nbsp: ' ',
  hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  ndash: '–', mdash: '—', deg: '°', shy: '', laquo: '«', raquo: '»',
  eacute: 'é', egrave: 'è', ecirc: 'ê', uuml: 'ü', ouml: 'ö', auml: 'ä',
  ntilde: 'ñ', ccedil: 'ç', aacute: 'á', iacute: 'í', oacute: 'ó',
  uacute: 'ú', agrave: 'à', acirc: 'â', ocirc: 'ô', szlig: 'ß',
  aring: 'å', oslash: 'ø', aelig: 'æ', middot: '·', prime: '′',
  trade: '™', copy: '©', reg: '®', euro: '€', pound: '£', yen: '¥',
  sup2: '²', sup3: '³', frac12: '½', times: '×', divide: '÷',
};

/**
 * opentdb HTML-encodes its text. The previous version hand-listed a dozen
 * entities, so anything else (`&#233;`, `&Uuml;`, `&sup2;`, `&ccedil;`…) leaked
 * through as raw markup in the question and answer buttons.
 *
 * Numeric entities are decoded first and named ones resolved in a single pass,
 * so a double-encoded sequence like `&amp;lt;` correctly yields `&lt;` rather
 * than being decoded twice.
 */
function decodeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : _m;
    })
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => {
      const key = name.toLowerCase();
      return key in NAMED_ENTITIES ? NAMED_ENTITIES[key] : m;
    });
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

interface OpenTdbResult {
  response_code: number;
  results: Array<{
    category: string;
    type: 'multiple' | 'boolean';
    difficulty: 'easy' | 'medium' | 'hard';
    question: string;
    correct_answer: string;
    incorrect_answers: string[];
  }>;
}

const TriviaService = {
  async getQuestion(difficulty?: 'easy' | 'medium' | 'hard'): Promise<TriviaQuestion | null> {
    try {
      const params: Record<string, string> = { amount: '1' };
      if (difficulty) params.difficulty = difficulty;

      const res = await http.get<OpenTdbResult>(BASE_URL, { params, timeout: 6000 });
      const q = res.data?.results?.[0];
      if (!q) return null;

      const correctAnswer = decodeHtml(q.correct_answer);
      const answers = shuffle([correctAnswer, ...q.incorrect_answers.map(decodeHtml)]);

      return {
        category:   decodeHtml(q.category),
        difficulty: q.difficulty,
        question:   decodeHtml(q.question),
        correctAnswer,
        answers,
      };
    } catch (err) {
      logger.warn(`[TriviaService] Failed to fetch question: ${(err as Error).message}`);
      return null;
    }
  },
};

export default TriviaService;
