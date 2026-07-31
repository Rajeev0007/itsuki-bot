/**
 * @file V2Flag.ts
 * @description Patches Discord interaction reply methods so IS_COMPONENTS_V2
 * is automatically included on payloads that actually need it.
 *
 * Why this is needed:
 *   Discord validates component types against the IS_COMPONENTS_V2 flag that
 *   is present in the request body, NOT the existing message flags. If
 *   editReply omits the flag, Discord treats it as a V1 message and rejects
 *   Container / TextDisplay / Section etc. (type != 1).
 *
 * Why it is CONDITIONAL:
 *   A message may not use `content` or `embeds` while IS_COMPONENTS_V2 is set —
 *   Discord returns `50035 Invalid Form Body` if it does. Blindly adding the
 *   flag to every payload therefore broke every plain-text reply in the bot
 *   ("This button is not for you.", "It's not your turn.", error fallbacks…).
 *   So the flag is only added when the payload really carries V2 components.
 */

import { MessageFlags } from 'discord.js';

const IS_V2 = Number(MessageFlags.IsComponentsV2); // 32768
const EPHEMERAL = Number(MessageFlags.Ephemeral);  // 64

/**
 * Component types that only exist under Components V2. Anything in this set
 * requires the IS_COMPONENTS_V2 flag; ActionRow (1) / Button (2) / selects
 * (3-8) are valid in both modes and must NOT force the flag on their own.
 */
const V2_COMPONENT_TYPES = new Set([
  9,  // Section
  10, // TextDisplay
  11, // Thumbnail
  12, // MediaGallery
  13, // File
  14, // Separator
  17, // Container
]);

/** Reads a component's type from a builder (`.data.type`) or a raw API object. */
function componentType(component: unknown): number | undefined {
  if (!component || typeof component !== 'object') return undefined;
  const c = component as { data?: { type?: unknown }; type?: unknown };
  const raw = c.data?.type ?? c.type;
  return typeof raw === 'number' ? raw : undefined;
}

/** True when `payload.components` contains at least one V2-only component. */
export function hasV2Components(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const components = (payload as { components?: unknown }).components;
  if (!Array.isArray(components) || components.length === 0) return false;
  return components.some((c) => {
    const type = componentType(c);
    return type !== undefined && V2_COMPONENT_TYPES.has(type);
  });
}

/** True when the payload carries a non-empty `content` or `embeds` field. */
function hasTextBody(payload: Record<string, unknown>): boolean {
  const content = payload.content;
  if (typeof content === 'string' && content.length > 0) return true;
  const embeds = payload.embeds;
  return Array.isArray(embeds) && embeds.length > 0;
}

/**
 * Normalises a reply payload:
 * - converts the deprecated `ephemeral: true` shorthand into the Ephemeral flag
 * - adds IS_COMPONENTS_V2 whenever V2 components are present
 * - strips IS_COMPONENTS_V2 from `content`/`embeds` payloads, which Discord
 *   rejects outright with `50035 Invalid Form Body`
 *
 * A payload with neither V2 components nor a text body (a bare `deferReply()`,
 * for example) keeps whatever flags the caller set. That matters: Discord will
 * not let a message add IS_COMPONENTS_V2 after creation, so the flag on the
 * initial deferral is what makes the later V2 `editReply` legal.
 */
export function normalizeV2Payload(options: unknown): unknown {
  if (options === null || options === undefined) return {};
  if (typeof options !== 'object') return options;

  const o = { ...(options as Record<string, unknown>) };
  let flags = typeof o.flags === 'number' ? o.flags : 0;

  // `ephemeral` is deprecated in discord.js v14 — translate it to a flag.
  if ('ephemeral' in o) {
    if (o.ephemeral === true) flags |= EPHEMERAL;
    delete o.ephemeral;
  }

  if (hasV2Components(o)) {
    flags |= IS_V2;
    // Components V2 messages may not carry content or embeds.
    delete o.content;
    delete o.embeds;
  } else if (hasTextBody(o)) {
    // Plain text/embed reply — an IS_COMPONENTS_V2 flag here is an instant 400.
    flags &= ~IS_V2;
  }

  if (flags !== 0) o.flags = flags;
  else delete o.flags;

  return o;
}

/**
 * Wraps deferReply / editReply / reply / followUp / update on any
 * interaction-like object so every call is normalised as described above.
 * Mutates in place and returns the same reference for chaining.
 */
export function patchReplies<T extends object>(interaction: T): T {
  const i = interaction as Record<string, unknown> & { __v2Patched?: boolean };
  if (i.__v2Patched) return interaction; // never double-wrap
  for (const name of ['deferReply', 'editReply', 'reply', 'followUp', 'update']) {
    if (typeof i[name] === 'function') {
      const orig = (i[name] as (...a: unknown[]) => unknown).bind(interaction);
      // deferReply carries no components — only normalise ephemeral/flags there.
      i[name] = (opts?: unknown) => orig(normalizeV2Payload(opts));
    }
  }
  i.__v2Patched = true;
  return interaction;
}
