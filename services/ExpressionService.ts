/**
 * @file ExpressionService.ts
 * @description Adding emojis and stickers to a guild, with Discord's real
 * limits enforced up front.
 *
 * Why the limits are checked BEFORE downloading and uploading:
 *   Discord rejects an over-quota or oversized expression with a generic
 *   50035 form-body error. Bulk-adding then produces a run of identical,
 *   meaningless failures. Checking slots and byte size first means the caller
 *   can be told exactly which constraint was hit — "3 static slots left, you
 *   gave 7" is actionable, "Invalid Form Body" is not.
 *
 * Static and animated emojis occupy SEPARATE pools of the same size, which is
 * the detail most implementations miss when counting free slots.
 */

import { GuildPremiumTier, PermissionFlagsBits, type Guild } from 'discord.js';
import { downloadMedia, DownloadError } from './SafeDownloader';
import logger from '../utils/Logger';

/** Emoji slots per pool (static and animated each get this many). */
const EMOJI_SLOTS: Record<number, number> = {
  [GuildPremiumTier.None]: 50,
  [GuildPremiumTier.Tier1]: 100,
  [GuildPremiumTier.Tier2]: 150,
  [GuildPremiumTier.Tier3]: 250,
};

/** Total sticker slots per tier. */
const STICKER_SLOTS: Record<number, number> = {
  [GuildPremiumTier.None]: 5,
  [GuildPremiumTier.Tier1]: 15,
  [GuildPremiumTier.Tier2]: 30,
  [GuildPremiumTier.Tier3]: 60,
};

/** Discord's hard byte ceilings. */
export const MAX_EMOJI_BYTES = 256 * 1024;
export const MAX_STICKER_BYTES = 512 * 1024;

/**
 * Emoji creation is rate limited far more tightly than normal requests, so bulk
 * adds are spaced out and capped per invocation.
 */
export const BULK_LIMIT = 10;
const CREATE_DELAY_MS = 1_200;

export interface SlotInfo {
  staticUsed: number; staticMax: number; staticFree: number;
  animatedUsed: number; animatedMax: number; animatedFree: number;
  stickersUsed: number; stickersMax: number; stickersFree: number;
  tier: number;
}

export function getSlots(guild: Guild): SlotInfo {
  const tier = Number(guild.premiumTier) || 0;
  const emojiMax = EMOJI_SLOTS[tier] ?? 50;
  const stickerMax = STICKER_SLOTS[tier] ?? 5;

  let staticUsed = 0, animatedUsed = 0;
  for (const emoji of guild.emojis.cache.values()) {
    if (emoji.animated) animatedUsed++;
    else staticUsed++;
  }
  const stickersUsed = guild.stickers.cache.size;

  return {
    staticUsed, staticMax: emojiMax, staticFree: Math.max(0, emojiMax - staticUsed),
    animatedUsed, animatedMax: emojiMax, animatedFree: Math.max(0, emojiMax - animatedUsed),
    stickersUsed, stickersMax: stickerMax, stickersFree: Math.max(0, stickerMax - stickersUsed),
    tier,
  };
}

/**
 * Normalises a name to Discord's rules: 2-32 characters, alphanumerics and
 * underscores only. Returns null when nothing usable remains.
 */
export function sanitiseName(raw: string | null | undefined, fallback = 'stolen'): string | null {
  let name = String(raw ?? '')
    .trim()
    .replace(/[^\w]/g, '_')   // anything else becomes an underscore
    .replace(/_{2,}/g, '_')   // collapse runs
    .replace(/^_+|_+$/g, '')  // trim edges
    .slice(0, 32);

  if (name.length < 2) name = fallback.replace(/[^\w]/g, '_').slice(0, 32);
  if (name.length < 2) return null;
  return name;
}

/** Both the caller and the bot need the permission. */
export function checkExpressionPerms(guild: Guild, callerHasPerm: boolean): string | null {
  if (!callerHasPerm) return 'You need the **Manage Expressions** permission.';
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
    return 'I need the **Manage Expressions** permission.';
  }
  return null;
}

export interface AddOutcome {
  ok: boolean;
  name: string;
  /** Rendered mention on success, so the reply can show the result. */
  mention?: string;
  reason?: string;
  animated?: boolean;
  bytes?: number;
}

/** Downloads a URL and adds it as a guild emoji. */
export async function addEmoji(
  guild: Guild, url: string, rawName: string, reason: string,
): Promise<AddOutcome> {
  const name = sanitiseName(rawName);
  if (!name) return { ok: false, name: rawName, reason: 'Name must contain at least 2 letters, numbers or underscores.' };

  let file;
  try {
    // Cap the download at the emoji ceiling so an oversized asset fails fast
    // rather than after transferring several megabytes.
    file = await downloadMedia(url, MAX_EMOJI_BYTES);
  } catch (err) {
    if (err instanceof DownloadError && err.kind === 'too_large') {
      return { ok: false, name, reason: `Larger than Discord's 256 KB emoji limit.` };
    }
    return { ok: false, name, reason: err instanceof DownloadError ? err.message : 'Download failed.' };
  }

  if (!file.contentType.startsWith('image/')) {
    return { ok: false, name, reason: `\`${file.contentType}\` is not an image.` };
  }

  const animated = file.contentType === 'image/gif';
  const slots = getSlots(guild);
  // Static and animated draw on separate pools.
  if (animated && slots.animatedFree <= 0) {
    return { ok: false, name, reason: `No animated emoji slots left (${slots.animatedUsed}/${slots.animatedMax}).` };
  }
  if (!animated && slots.staticFree <= 0) {
    return { ok: false, name, reason: `No static emoji slots left (${slots.staticUsed}/${slots.staticMax}).` };
  }

  try {
    const created = await guild.emojis.create({ attachment: file.buffer, name, reason });
    return { ok: true, name: created.name ?? name, mention: created.toString(), animated, bytes: file.bytes };
  } catch (err) {
    logger.debug(`[Expressions] emoji create failed for "${name}": ${(err as Error).message}`);
    return { ok: false, name, reason: (err as Error).message };
  }
}

/** Downloads a URL and adds it as a guild sticker. */
export async function addSticker(
  guild: Guild, url: string, rawName: string, tags: string, reason: string,
): Promise<AddOutcome> {
  const name = sanitiseName(rawName);
  if (!name) return { ok: false, name: rawName, reason: 'Name must contain at least 2 letters, numbers or underscores.' };

  const slots = getSlots(guild);
  if (slots.stickersFree <= 0) {
    return { ok: false, name, reason: `No sticker slots left (${slots.stickersUsed}/${slots.stickersMax}).` };
  }

  let file;
  try {
    file = await downloadMedia(url, MAX_STICKER_BYTES);
  } catch (err) {
    if (err instanceof DownloadError && err.kind === 'too_large') {
      return { ok: false, name, reason: `Larger than Discord's 512 KB sticker limit.` };
    }
    return { ok: false, name, reason: err instanceof DownloadError ? err.message : 'Download failed.' };
  }

  // Discord only accepts PNG/APNG/GIF for uploaded stickers. A Lottie sticker
  // is JSON and can only be added by partnered servers, so it is rejected with
  // an explanation rather than a generic API error.
  if (file.contentType === 'application/json') {
    return { ok: false, name, reason: 'That is a Lottie (animated JSON) sticker — Discord does not allow those to be re-uploaded.' };
  }
  if (!['image/png', 'image/gif', 'image/apng'].includes(file.contentType)) {
    return { ok: false, name, reason: `Stickers must be PNG, APNG or GIF (got \`${file.contentType}\`).` };
  }

  try {
    const created = await guild.stickers.create({
      file: file.buffer,
      name,
      // `tags` is required by the API — it drives emoji-based autocomplete.
      tags: sanitiseName(tags, 'sticker') ?? 'sticker',
      reason,
    });
    return { ok: true, name: created.name ?? name, bytes: file.bytes };
  } catch (err) {
    logger.debug(`[Expressions] sticker create failed for "${name}": ${(err as Error).message}`);
    return { ok: false, name, reason: (err as Error).message };
  }
}

/** Spacing helper for bulk operations, to stay clear of the creation limit. */
export function creationDelay(): Promise<void> {
  return new Promise((r) => setTimeout(r, CREATE_DELAY_MS));
}

export default {
  getSlots, sanitiseName, checkExpressionPerms, addEmoji, addSticker,
  creationDelay, MAX_EMOJI_BYTES, MAX_STICKER_BYTES, BULK_LIMIT,
};
