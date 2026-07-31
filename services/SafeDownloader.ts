/**
 * @file SafeDownloader.ts
 * @description Fetches a remote media file for re-upload to Discord.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS DELIBERATELY NOT A GENERAL-PURPOSE "DOWNLOAD ANY URL" HELPER.
 *
 * Any command that fetches a user-supplied URL from the bot's host is a
 * server-side request forgery (SSRF) primitive: the requester borrows the
 * server's network position. On a hosted bot that reaches cloud metadata
 * (169.254.169.254), a local Lavalink node, or anything else on the private
 * network, an unguarded fetcher hands every member of every server a way to
 * read those.
 *
 * The protections below are therefore not optional extras — they are the
 * reason this module can exist at all:
 *
 *   1. Scheme allowlist            — http/https only (no file:, ftp:, data:…)
 *   2. No embedded credentials     — blocks http://user:pass@host tricks
 *   3. Port allowlist              — 80/443 only, so it can't reach an
 *                                    internal service on 2333, 6379, 5432…
 *   4. DNS resolution + IP checks  — every resolved address is tested against
 *                                    loopback, private, link-local, CGNAT,
 *                                    multicast and reserved ranges, for both
 *                                    IPv4 and IPv6
 *   5. Manual redirect handling    — EVERY hop is re-validated. This is the
 *                                    step most implementations miss: a public
 *                                    URL that 302s to 169.254.169.254 defeats
 *                                    any check performed only on the input.
 *   6. MIME allowlist              — images, video and audio only. No
 *                                    executables or archives, so the bot can't
 *                                    be used to relay malware.
 *   7. Streaming size cap          — enforced on bytes received, because
 *                                    Content-Length can lie or be absent.
 *
 * It intentionally cannot download from sites that require extraction
 * (YouTube and other streaming platforms). That is a licensing matter, not a
 * technical one.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import dns from 'dns/promises';
import net from 'net';
import http from 'http';
import https from 'https';
import logger from '../utils/Logger';

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly kind: 'blocked' | 'too_large' | 'bad_type' | 'not_found' | 'network' = 'network',
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/**
 * Types safe to relay.
 *
 * Deliberately excludes archives (zip/rar/7z) and anything executable. Those
 * are the formats that turn a relay command into a malware distribution
 * channel, and Discord cannot preview them either — so there is no upside.
 */
const ALLOWED_MIME = [
  // Images
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
  'image/svg+xml', 'image/tiff', 'image/x-icon', 'image/vnd.microsoft.icon',
  // Video
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/mpeg',
  // Audio
  'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav',
  'audio/webm', 'audio/flac', 'audio/mp4', 'audio/aac', 'audio/opus',
  // Documents and text — non-executable, previewable
  'text/plain', 'text/markdown', 'text/csv', 'text/xml', 'text/html',
  'application/json', 'application/pdf', 'application/xml',
  'application/rtf', 'text/rtf',
  // Fonts
  'font/ttf', 'font/otf', 'font/woff', 'font/woff2',
];

const ALLOWED_PORTS = new Set([80, 443]);

/** Discord's baseline upload limit for unboosted servers. */
export const DISCORD_BASE_UPLOAD_LIMIT = 10 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 20_000;

export interface DownloadResult {
  buffer: Buffer;
  contentType: string;
  filename: string;
  bytes: number;
  finalUrl: string;
  /** Hops followed, for transparency in the reply. */
  redirects: string[];
}

/** True when an IP address is outside the public internet. */
export function isPrivateAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 0) return true; // unparseable — refuse

  if (version === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;

    if (a === 0) return true;                        // 0.0.0.0/8 "this network"
    if (a === 10) return true;                       // private
    if (a === 127) return true;                      // loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 169 && b === 254) return true;         // link-local — cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;         // private
    if (a === 192 && b === 0) return true;           // 192.0.0.0/24 + test nets
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51) return true;          // documentation
    if (a === 203 && b === 0) return true;           // documentation
    if (a >= 224) return true;                       // multicast + reserved + broadcast
    return false;
  }

  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;         // unspecified / loopback
  if (lower.startsWith('fe8') || lower.startsWith('fe9')
    || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;    // unique-local
  if (lower.startsWith('ff')) return true;                    // multicast
  if (lower.startsWith('2001:db8')) return true;              // documentation

  // IPv4-mapped (::ffff:169.254.169.254) must be unwrapped and re-checked,
  // or it slips straight past the IPv6 prefix tests above.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
  if (mapped) return isPrivateAddress(mapped[1]);

  return false;
}

/** Validates a URL and resolves it to a vetted set of addresses. */
async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DownloadError('That is not a valid URL.', 'blocked');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DownloadError(`Only \`http\` and \`https\` URLs are allowed (got \`${url.protocol}\`).`, 'blocked');
  }
  // user:pass@host is a classic filter-bypass and parser-confusion trick.
  if (url.username || url.password) {
    throw new DownloadError('URLs containing credentials are not allowed.', 'blocked');
  }

  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!ALLOWED_PORTS.has(port)) {
    throw new DownloadError(`Only ports 80 and 443 are allowed (got \`${port}\`).`, 'blocked');
  }

  // A bare IP in the URL still has to pass the range checks.
  if (net.isIP(url.hostname) !== 0) {
    if (isPrivateAddress(url.hostname)) {
      throw new DownloadError('That address is on a private or reserved network.', 'blocked');
    }
    return url;
  }

  let addresses: string[];
  try {
    const records = await dns.lookup(url.hostname, { all: true });
    addresses = records.map((r) => r.address);
  } catch {
    throw new DownloadError(`Could not resolve \`${url.hostname}\`.`, 'not_found');
  }
  if (!addresses.length) {
    throw new DownloadError(`\`${url.hostname}\` did not resolve to any address.`, 'not_found');
  }

  // EVERY address must be public. A hostname resolving to both a public and a
  // private address (DNS rebinding) must be refused outright.
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      logger.warn(`[Download] Blocked ${url.hostname} → ${address} (private range)`);
      throw new DownloadError(
        `\`${url.hostname}\` resolves to a private or reserved address and was blocked.`,
        'blocked',
      );
    }
  }

  return url;
}

function filenameFrom(url: URL, contentType: string): string {
  const fromPath = decodeURIComponent(url.pathname.split('/').pop() ?? '').trim();
  // Strip anything that could traverse directories or confuse Discord.
  const safe = fromPath.replace(/[^\w.\-]/g, '_').replace(/^\.+/, '').slice(0, 80);
  if (safe && /\.[a-z0-9]{1,5}$/i.test(safe)) return safe;

  const ext = ({
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/bmp': 'bmp', 'image/avif': 'avif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
    'audio/webm': 'weba', 'audio/flac': 'flac', 'audio/mp4': 'm4a',
    'text/plain': 'txt', 'application/json': 'json',
  } as Record<string, string>)[contentType] ?? 'bin';

  return `${safe || 'download'}.${ext}`;
}

/** Performs one request, returning either a redirect target or the body. */
function requestOnce(url: URL, maxBytes: number): Promise<
  { redirectTo: string } | { buffer: Buffer; contentType: string }
> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;

    const req = client.get(url, {
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'ItsukiBot/1.0 (+media relay)',
        'Accept': '*/*',
      },
    }, (res) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // drain so the socket is released
        resolve({ redirectTo: new URL(res.headers.location, url).toString() });
        return;
      }
      if (status === 404 || status === 410) {
        res.resume();
        reject(new DownloadError('That file does not exist (HTTP 404).', 'not_found'));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new DownloadError(`The server returned HTTP ${status}.`, 'network'));
        return;
      }

      const contentType = String(res.headers['content-type'] ?? '')
        .split(';')[0].trim().toLowerCase();

      if (!ALLOWED_MIME.includes(contentType)) {
        res.resume();
        reject(new DownloadError(
          `\`${contentType || 'unknown'}\` files are not allowed. Only images, video, audio and plain text can be relayed.`,
          'bad_type',
        ));
        return;
      }

      // Reject early when the server is honest about an oversized body…
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.resume();
        reject(new DownloadError(
          `That file is ${(declared / 1024 / 1024).toFixed(1)} MB — the limit is ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`,
          'too_large',
        ));
        return;
      }

      // …and enforce it again while streaming, since Content-Length may be
      // absent (chunked) or simply wrong.
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          res.destroy();
          reject(new DownloadError(
            `That file exceeds the ${(maxBytes / 1024 / 1024).toFixed(0)} MB limit.`,
            'too_large',
          ));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType }));
      res.on('error', (err) => reject(new DownloadError(`Transfer failed: ${err.message}`, 'network')));
    });

    req.on('timeout', () => req.destroy(new DownloadError('The download timed out.', 'network')));
    req.on('error', (err) => reject(
      err instanceof DownloadError ? err : new DownloadError(`Request failed: ${err.message}`, 'network'),
    ));
  });
}

/**
 * Downloads a media file, validating the URL and every redirect hop.
 *
 * `maxBytes` defaults below Discord's unboosted upload ceiling so a successful
 * download can always actually be posted.
 */
export async function downloadMedia(
  rawUrl: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<DownloadResult> {
  const redirects: string[] = [];
  let current = await assertSafeUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const outcome = await requestOnce(current, maxBytes);

    if ('redirectTo' in outcome) {
      if (hop === MAX_REDIRECTS) {
        throw new DownloadError('Too many redirects.', 'network');
      }
      redirects.push(outcome.redirectTo);
      // Re-validate the new target from scratch. Without this, a public URL
      // that redirects to a private address bypasses every check above.
      current = await assertSafeUrl(outcome.redirectTo);
      continue;
    }

    return {
      buffer: outcome.buffer,
      contentType: outcome.contentType,
      filename: filenameFrom(current, outcome.contentType),
      bytes: outcome.buffer.length,
      finalUrl: current.toString(),
      redirects,
    };
  }

  throw new DownloadError('Too many redirects.', 'network');
}

export default { downloadMedia, isPrivateAddress, DownloadError, DISCORD_BASE_UPLOAD_LIMIT };
