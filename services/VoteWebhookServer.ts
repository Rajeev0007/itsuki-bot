/**
 * @file VoteWebhookServer.ts
 * @description HTTP endpoint that receives vote webhooks from top.gg and
 * Discord Bot List.
 *
 * ── This is the bot's only inbound network surface ───────────────────────────
 * Everything else in the bot makes outbound requests. This listens, which means
 * it is reachable by anyone who finds the port. The hardening below is therefore
 * not optional:
 *
 *   - Authorization is compared with timingSafeEqual, not `===`. A plain
 *     comparison leaks the secret one byte at a time to an attacker measuring
 *     response times.
 *   - Length is checked before the timing-safe compare, because
 *     timingSafeEqual throws on a length mismatch.
 *   - The body is capped mid-stream. Without it, a single request advertising no
 *     Content-Length can exhaust memory.
 *   - Only POST to the two known paths is answered; everything else gets 404
 *     without touching the body.
 *   - A provider with no configured secret is DISABLED rather than left open.
 *     Defaulting to "accept anything" would let anyone forge votes.
 *   - Per-IP rate limiting, so a failed-auth loop can't be used to brute force.
 *
 * Endpoints (configure these URLs in each site's dashboard):
 *   POST /vote/topgg
 *   POST /vote/dbl
 */

import http from 'http';
import crypto from 'crypto';
import type { Client } from 'discord.js';
import VoteManager, { type VoteProvider } from '../managers/VoteManager';
import logger from '../utils/Logger';

const MAX_BODY_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 60;

let server: http.Server | null = null;
const hits = new Map<string, { count: number; resetAt: number }>();

/** Constant-time secret comparison. */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on differing lengths, so that must be checked first.
  // The length itself is not secret.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_MAX_REQUESTS;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (e.resetAt <= now) hits.delete(ip);
}, RATE_WINDOW_MS).unref?.();

/** Reads the body with a hard byte ceiling. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Destroying the socket is the only way to stop an unbounded stream.
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function respond(res: http.ServerResponse, status: number, body = ''): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body);
}

/** Extracts the voter's user ID from either provider's payload shape. */
function extractUserId(provider: VoteProvider, payload: Record<string, unknown>): string | null {
  // top.gg sends { user, bot, type, isWeekend }; DBL sends { id, username, ... }
  const raw = provider === 'topgg' ? payload.user : payload.id;
  const id = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : null;
  return id && /^\d{15,25}$/.test(id) ? id : null;
}

export interface VoteEvent {
  provider: VoteProvider;
  userId: string;
  isWeekend: boolean;
  isTest: boolean;
}

const VoteWebhookServer = {
  isRunning(): boolean {
    return server !== null;
  },

  /** Which providers have a secret configured and are therefore active. */
  configuredProviders(): VoteProvider[] {
    const out: VoteProvider[] = [];
    if (process.env.TOPGG_WEBHOOK_AUTH) out.push('topgg');
    if (process.env.DBL_WEBHOOK_AUTH) out.push('dbl');
    return out;
  },

  /**
   * Starts the listener. Returns false when nothing is configured — the bot
   * runs perfectly well without vote webhooks, so this is not an error.
   */
  start(client: Client, onVote: (event: VoteEvent) => Promise<void>): boolean {
    if (server) return true;

    const active = this.configuredProviders();
    if (!active.length) {
      logger.info('[Votes] No webhook secrets set — vote notifier disabled. See .env.example.');
      return false;
    }

    const port = Number(process.env.VOTE_SERVER_PORT) || 3001;

    server = http.createServer((req, res) => {
      void (async () => {
        const ip = String(req.socket.remoteAddress ?? 'unknown');
        if (rateLimited(ip)) return respond(res, 429, 'Too many requests');

        // Cheap health check for uptime monitors, before any auth work.
        if (req.method === 'GET' && req.url === '/vote/health') {
          return respond(res, 200, 'ok');
        }
        if (req.method !== 'POST') return respond(res, 404);

        const provider: VoteProvider | null =
          req.url === '/vote/topgg' ? 'topgg'
          : req.url === '/vote/dbl' ? 'dbl'
          : null;
        if (!provider) return respond(res, 404);

        const expected = provider === 'topgg'
          ? process.env.TOPGG_WEBHOOK_AUTH
          : process.env.DBL_WEBHOOK_AUTH;

        // No secret configured for this provider → refuse, never accept blindly.
        if (!expected) return respond(res, 503, 'Provider not configured');

        const header = req.headers.authorization;
        if (!secretMatches(Array.isArray(header) ? header[0] : header, expected)) {
          logger.warn(`[Votes] Rejected ${provider} webhook from ${ip} — bad Authorization`);
          return respond(res, 401, 'Unauthorized');
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch (err) {
          return respond(res, 400, `Bad payload: ${(err as Error).message}`);
        }

        const userId = extractUserId(provider, payload);
        if (!userId) {
          logger.warn(`[Votes] ${provider} payload had no usable user id`);
          return respond(res, 400, 'Missing user id');
        }

        // Acknowledge immediately. Both providers retry on a slow or failed
        // response, which would double-count the vote if we processed first.
        respond(res, 200, 'ok');

        const event: VoteEvent = {
          provider,
          userId,
          isWeekend: payload.isWeekend === true,
          isTest: payload.type === 'test',
        };

        try {
          await onVote(event);
        } catch (err) {
          logger.error(`[Votes] Handler failed for ${userId}: ${(err as Error).message}`);
        }
      })();
    });

    server.on('error', (err) => {
      logger.error(`[Votes] Webhook server error: ${err.message}`);
      // A port clash means the listener never came up; clear it so isRunning()
      // reports the truth. Typed inline to avoid depending on the NodeJS
      // namespace being in scope.
      if ((err as { code?: string }).code === 'EADDRINUSE') server = null;
    });

    server.listen(port, () => {
      logger.info(
        `[Votes] Webhook server listening on :${port} — active providers: ${active.join(', ')}`,
      );
      for (const p of active) {
        logger.info(`[Votes]   POST /vote/${p}`);
      }
    });

    return true;
  },

  stop(): void {
    if (!server) return;
    server.close();
    server = null;
    logger.info('[Votes] Webhook server stopped.');
  },
};

export default VoteWebhookServer;
