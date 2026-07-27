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

/** opentdb HTML-encodes its text (quotes, apostrophes, ampersands, etc). */
function decodeHtml(str: string): string {
  return str
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&')
    .replace(/&eacute;/g, 'é').replace(/&uuml;/g, 'ü').replace(/&rsquo;/g, '’')
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”').replace(/&hellip;/g, '…')
    .replace(/&ntilde;/g, 'ñ').replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö');
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
