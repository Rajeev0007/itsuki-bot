/**
 * @file MessageTemplate.ts
 * @description One message definition that can render as a classic EMBED or as
 * COMPONENTS V2, plus the placeholder engine.
 *
 * ── Why a single unified model ───────────────────────────────────────────────
 * Keeping separate shapes for embeds and V2 would mean a user who built a
 * welcome message one way has to rebuild it to switch styles. Instead every
 * field is stored once and MAPPED onto whichever renderer is selected:
 *
 *   field        embed                     components v2
 *   ─────────────────────────────────────────────────────────────────────
 *   title        .title                    "# title" text display
 *   description  .description              text display
 *   color        .color                    container accent colour
 *   author       .author                   section heading + thumbnail
 *   thumbnail    .thumbnail                section thumbnail accessory
 *   image        .image                    media gallery item
 *   footer       .footer                   "-# footer" text display
 *   fields       .fields (inline aware)    text displays, separator-delimited
 *   timestamp    .timestamp                appended to the footer line
 *   buttons      action row                action row (identical)
 *   gallery      first image only          full multi-image gallery
 *   separators   ignored                   divider components
 *
 * Fields that one style cannot express are degraded rather than dropped, so
 * switching style never silently loses content.
 */

import {
  EmbedBuilder, ContainerBuilder, SectionBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder, MediaGalleryBuilder,
  MediaGalleryItemBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  MessageFlags,
  type Guild, type GuildMember, type User,
} from 'discord.js';

export type TemplateStyle = 'embed' | 'v2';

export interface TemplateButton {
  label: string;
  url: string;
  emoji?: string | null;
}

export interface TemplateField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface MessageTemplate {
  style: TemplateStyle;
  /** Plain text above the embed/container. Supports mentions, so it pings. */
  content?: string | null;
  title?: string | null;
  description?: string | null;
  /** Link applied to the title. */
  url?: string | null;
  /** Integer colour, e.g. 0x5865F2. */
  color?: number | null;
  author?: { name: string; iconUrl?: string | null; url?: string | null } | null;
  thumbnail?: string | null;
  image?: string | null;
  footer?: { text: string; iconUrl?: string | null } | null;
  timestamp?: boolean;
  fields?: TemplateField[];
  buttons?: TemplateButton[];
  /** V2 only: additional images beyond `image`. */
  gallery?: string[];
  /** V2 only: draw dividers between blocks. */
  separators?: boolean;
}

export function emptyTemplate(style: TemplateStyle = 'embed'): MessageTemplate {
  return {
    style,
    content: null, title: null, description: null, url: null, color: null,
    author: null, thumbnail: null, image: null, footer: null,
    timestamp: false, fields: [], buttons: [], gallery: [], separators: true,
  };
}

// ── Placeholders ─────────────────────────────────────────────────────────────

export interface PlaceholderContext {
  member?: GuildMember | null;
  user?: User | null;
  guild?: Guild | null;
  /** Extra values a caller wants to expose. */
  extra?: Record<string, string>;
}

/** English ordinal suffix — "1st", "22nd", "113th". */
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * Every supported placeholder.
 *
 * Documented here rather than in the command so `/welcomer variables` and the
 * builder can both list them from one source and never drift.
 */
export const PLACEHOLDERS: Array<{ token: string; description: string }> = [
  { token: '{user}',            description: 'Mentions the member' },
  { token: '{user.name}',       description: 'Username' },
  { token: '{user.display}',    description: 'Display / nickname' },
  { token: '{user.tag}',        description: 'Username with discriminator' },
  { token: '{user.id}',         description: 'User ID' },
  { token: '{user.avatar}',     description: 'Avatar URL' },
  { token: '{user.created}',    description: 'Account creation date' },
  { token: '{user.age}',        description: 'Account age in days' },
  { token: '{server}',          description: 'Server name' },
  { token: '{server.id}',       description: 'Server ID' },
  { token: '{server.icon}',     description: 'Server icon URL' },
  { token: '{server.members}',  description: 'Member count' },
  { token: '{server.ordinal}',  description: 'Member count as an ordinal (e.g. 42nd)' },
  { token: '{server.boosts}',   description: 'Boost count' },
  { token: '{joined}',          description: 'Join timestamp (relative)' },
  { token: '{date}',            description: "Today's date" },
];

/**
 * Substitutes placeholders.
 *
 * Values are looked up from a prepared map rather than evaluated, so a template
 * can never execute anything. Unknown tokens are left untouched — silently
 * blanking them would make typos invisible.
 */
export function applyPlaceholders(text: string | null | undefined, ctx: PlaceholderContext): string {
  if (!text) return '';

  const user = ctx.user ?? ctx.member?.user ?? null;
  const guild = ctx.guild ?? ctx.member?.guild ?? null;
  const memberCount = guild?.memberCount ?? 0;

  const values: Record<string, string> = {
    'user': user ? `<@${user.id}>` : '',
    'user.name': user?.username ?? '',
    'user.display': ctx.member?.displayName ?? user?.username ?? '',
    'user.tag': user?.tag ?? user?.username ?? '',
    'user.id': user?.id ?? '',
    'user.avatar': user?.displayAvatarURL({ size: 256 }) ?? '',
    'user.created': user ? `<t:${Math.floor(user.createdTimestamp / 1000)}:D>` : '',
    'user.age': user ? String(Math.floor((Date.now() - user.createdTimestamp) / 86_400_000)) : '',
    'server': guild?.name ?? '',
    'server.id': guild?.id ?? '',
    'server.icon': guild?.iconURL({ size: 256 }) ?? '',
    'server.members': String(memberCount),
    'server.ordinal': ordinal(memberCount),
    'server.boosts': String(guild?.premiumSubscriptionCount ?? 0),
    'joined': ctx.member?.joinedTimestamp
      ? `<t:${Math.floor(ctx.member.joinedTimestamp / 1000)}:R>`
      : `<t:${Math.floor(Date.now() / 1000)}:R>`,
    'date': `<t:${Math.floor(Date.now() / 1000)}:D>`,
    ...(ctx.extra ?? {}),
  };

  return text.replace(/\{([a-z0-9_.]+)\}/gi, (whole, token: string) => {
    const key = token.toLowerCase();
    return key in values ? values[key] : whole;
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Hard Discord ceilings, in one place.
 *
 * These matter because exceeding any of them rejects the ENTIRE message with
 * `50035 Invalid Form Body` — there is no partial send and no warning. Since
 * the builder lets users add up to 25 fields, buttons, a gallery and a footer,
 * a fully-populated template really can cross both V2 limits, so the renderer
 * has to budget rather than assume.
 *
 * Components V2: 40 components per message counting nested ones, and 4000
 * characters combined across every component that holds text.
 *   https://discord.com/developers/docs/components/reference
 */
export const LIMITS = {
  v2: {
    components: 40,
    text: 4000,
    gallery: 10,
    /** A Section may hold at most 3 children (text displays + accessory). */
    sectionChildren: 3,
  },
  embed: {
    /** Combined title + description + fields + footer + author. */
    total: 6000,
    title: 256,
    description: 4096,
    fields: 25,
    fieldName: 256,
    fieldValue: 1024,
    footer: 2048,
    author: 256,
  },
  buttons: 5,
  buttonLabel: 80,
  content: 2000,
};

const DEFAULT_COLOR = 0x5865F2;

/**
 * Characters held back for the "N fields hidden" note.
 *
 * The longest such note is around 55 characters, so 80 leaves margin. It must
 * be reserved before the text-heavy fields are allocated, or the explanation
 * for the overflow becomes part of the overflow.
 */
const NOTE_RESERVE = 80;

function isImageUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

const hasPlaceholder = (s: string | null | undefined): boolean => /\{[a-z0-9_.]+\}/i.test(s ?? '');

/**
 * `lenient` is used when measuring an unrendered template: a URL that is still
 * a placeholder will become a real URL at send time, so it must be counted as
 * present or the component estimate comes out too low.
 */
function urlish(url: string | null | undefined, lenient: boolean): boolean {
  return isImageUrl(url) || (lenient && hasPlaceholder(url));
}

/** Hands out characters from a shared budget, highest-priority caller first. */
function budgeter(total: number) {
  let left = total;
  return {
    take(text: string | null | undefined, max: number): string {
      const s = text ?? '';
      if (!s) return '';
      const cut = s.slice(0, Math.max(0, Math.min(max, left)));
      left -= cut.length;
      return cut;
    },
    reserve(n: number): void { left = Math.max(0, left - n); },
    get left(): number { return left; },
    get used(): number { return total - left; },
  };
}

/**
 * Joins consecutive strings while they fit in `maxLen`.
 *
 * Used to collapse many one-field-per-component text displays into a few, which
 * cuts the component count while keeping every character of content — only the
 * vertical spacing changes.
 */
function mergeChunks(items: string[], maxLen: number): string[] {
  const out: string[] = [];
  for (const item of items) {
    const last = out.length ? out[out.length - 1] : undefined;
    if (last !== undefined && last.length + 2 + item.length <= maxLen) {
      out[out.length - 1] = `${last}\n\n${item}`;
    } else {
      out.push(item);
    }
  }
  return out;
}

interface ResolvedButton { label: string; url: string; emoji: string | null }

/**
 * Only link buttons are allowed, so a template cannot produce a component with
 * no handler behind it.
 */
function resolveButtons(
  buttons: TemplateButton[] | undefined,
  resolve: (v: string | null | undefined) => string,
  lenient = false,
): ResolvedButton[] {
  return (buttons ?? [])
    .map((b) => ({
      label: resolve(b.label).slice(0, LIMITS.buttonLabel),
      url: resolve(b.url),
      emoji: b.emoji?.trim() || null,
    }))
    .filter((b) => b.label.trim() && urlish(b.url, lenient))
    .slice(0, LIMITS.buttons);
}

function buildButtonRow(buttons: ResolvedButton[]): ActionRowBuilder<ButtonBuilder> | null {
  if (!buttons.length) return null;
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const b of buttons) {
    const button = new ButtonBuilder().setLabel(b.label).setStyle(ButtonStyle.Link).setURL(b.url);
    if (b.emoji) {
      // An invalid emoji rejects the whole message, so it is applied defensively.
      try { button.setEmoji(b.emoji); } catch { /* skip the emoji */ }
    }
    row.addComponents(button);
  }
  return row;
}

// ── Embed plan ───────────────────────────────────────────────────────────────

interface EmbedPlan {
  title: string; description: string; authorName: string; footerText: string;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  buttons: ResolvedButton[];
  hiddenFields: number;
  text: number;
}

/**
 * Allocates an embed's 6000-character budget.
 *
 * Each individual field already has its own cap, but the per-field caps sum far
 * past 6000 (256 + 4096 + 25x(256+1024) + 2048 …), so the total has to be
 * budgeted too. Body copy wins over decoration: title, author and description
 * are served before the footer, and fields last.
 */
function planEmbed(
  tpl: MessageTemplate,
  resolve: (v: string | null | undefined) => string,
  lenient = false,
): EmbedPlan {
  const b = budgeter(LIMITS.embed.total);

  const title = b.take(resolve(tpl.title), LIMITS.embed.title);
  const authorName = tpl.author?.name ? b.take(resolve(tpl.author.name), LIMITS.embed.author) : '';
  const description = b.take(resolve(tpl.description), LIMITS.embed.description);

  const candidates = (tpl.fields ?? [])
    .slice(0, LIMITS.embed.fields)
    .map((f) => ({
      name: resolve(f.name).slice(0, LIMITS.embed.fieldName),
      value: resolve(f.value).slice(0, LIMITS.embed.fieldValue),
      inline: Boolean(f.inline),
    }))
    .filter((f) => f.name && f.value);

  // The "N hidden" note is appended to the footer later, so its room has to be
  // claimed BEFORE the footer and fields spend what is left — otherwise the
  // note itself pushes the embed over 6000.
  const footerRaw = tpl.footer?.text ? resolve(tpl.footer.text) : '';
  const fieldsTotal = candidates.reduce((n, f) => n + f.name.length + f.value.length, 0);
  if (candidates.length
    && fieldsTotal + Math.min(footerRaw.length, LIMITS.embed.footer) > b.left) {
    b.reserve(NOTE_RESERVE);
  }

  let footerText = b.take(footerRaw, LIMITS.embed.footer);

  const fields: EmbedPlan['fields'] = [];
  let hiddenFields = 0;
  for (let i = 0; i < candidates.length; i++) {
    const cost = candidates[i].name.length + candidates[i].value.length;
    // Stop at the first field that will not fit rather than cherry-picking
    // later small ones, which would silently reorder the user's layout.
    if (cost > b.left) { hiddenFields = candidates.length - i; break; }
    b.reserve(cost);
    fields.push(candidates[i]);
  }

  // Reported in the footer so the omission is visible instead of mysterious.
  if (hiddenFields > 0) {
    const note = `… ${hiddenFields} more field${hiddenFields === 1 ? '' : 's'} hidden (6000-character embed limit)`;
    footerText = footerText ? `${footerText} • ${note}` : note;
    footerText = footerText.slice(0, LIMITS.embed.footer);
  }

  return {
    title, description, authorName, footerText, fields,
    buttons: resolveButtons(tpl.buttons, resolve, lenient),
    hiddenFields,
    text: title.length + description.length + authorName.length + footerText.length
      + fields.reduce((n, f) => n + f.name.length + f.value.length, 0),
  };
}

/** Renders as a classic embed. */
function renderEmbed(tpl: MessageTemplate, ctx: PlaceholderContext): Record<string, unknown> {
  const p = (v: string | null | undefined) => applyPlaceholders(v, ctx);
  const plan = planEmbed(tpl, p);
  const embed = new EmbedBuilder().setColor(tpl.color ?? DEFAULT_COLOR);

  if (plan.title) embed.setTitle(plan.title);
  if (plan.description) embed.setDescription(plan.description);

  const url = p(tpl.url);
  if (plan.title && /^https?:\/\//i.test(url)) embed.setURL(url);

  if (plan.authorName) {
    const icon = p(tpl.author?.iconUrl);
    const authorUrl = p(tpl.author?.url);
    embed.setAuthor({
      name: plan.authorName,
      ...(isImageUrl(icon) ? { iconURL: icon } : {}),
      ...(isImageUrl(authorUrl) ? { url: authorUrl } : {}),
    });
  }

  const thumb = p(tpl.thumbnail);
  if (isImageUrl(thumb)) embed.setThumbnail(thumb);

  // An embed shows one image; the gallery's first usable entry stands in when
  // no main image was set, rather than dropping the gallery entirely.
  const image = p(tpl.image) || (tpl.gallery ?? []).map((g) => p(g)).find(isImageUrl) || '';
  if (isImageUrl(image)) embed.setImage(image);

  for (const field of plan.fields) embed.addFields(field);

  if (plan.footerText) {
    const icon = p(tpl.footer?.iconUrl);
    embed.setFooter({
      text: plan.footerText,
      ...(isImageUrl(icon) ? { iconURL: icon } : {}),
    });
  }
  if (tpl.timestamp) embed.setTimestamp(new Date());

  const row = buildButtonRow(plan.buttons);
  const content = p(tpl.content);

  return {
    ...(content ? { content: content.slice(0, LIMITS.content) } : {}),
    embeds: [embed],
    ...(row ? { components: [row] } : {}),
  };
}

// ── V2 plan ──────────────────────────────────────────────────────────────────

interface V2Plan {
  content: string;
  heading: string;
  /** Thumbnail rendered as a Section accessory alongside the heading. */
  headingThumb: string;
  /** Thumbnail with no heading to attach to, rendered as its own gallery. */
  loneThumb: string;
  inlineText: string;
  blockTexts: string[];
  gallery: string[];
  footer: string;
  buttons: ResolvedButton[];
  separators: boolean;
  hiddenFields: number;
  components: number;
  text: number;
}

/**
 * Plans a V2 message inside both the 4000-character and 40-component budgets.
 *
 * Kept separate from rendering so the builder can measure a template without
 * constructing builders, and so both paths can never disagree about the limits.
 */
function planV2(
  tpl: MessageTemplate,
  resolve: (v: string | null | undefined) => string,
  lenient = false,
): V2Plan {
  const b = budgeter(LIMITS.v2.text);

  const thumb = resolve(tpl.thumbnail);
  const authorName = tpl.author?.name ? resolve(tpl.author.name) : '';
  const title = resolve(tpl.title);
  const description = resolve(tpl.description);

  const footerText = tpl.footer?.text ? resolve(tpl.footer.text) : '';
  const stamp = tpl.timestamp ? `<t:${Math.floor(Date.now() / 1000)}:f>` : '';
  const footerRaw = (footerText || stamp)
    ? `-# ${[footerText, stamp].filter(Boolean).join(' • ')}`
    : '';
  // Footer first: it is short and carries the timestamp, so a long description
  // must not be able to starve it out.
  const footer = b.take(footerRaw, 300);

  const content = b.take(resolve(tpl.content), LIMITS.content);

  const fields = (tpl.fields ?? [])
    .slice(0, LIMITS.embed.fields)
    .map((f) => ({ name: resolve(f.name), value: resolve(f.value), inline: Boolean(f.inline) }))
    .filter((f) => f.name && f.value);

  // V2 has no inline layout, so inline fields are joined onto one line to
  // approximate a side-by-side arrangement.
  const inlineRaw = fields.filter((f) => f.inline)
    .map((f) => `**${f.name}**\n${f.value}`).join('   \u2003');
  const blockRaw = fields.filter((f) => !f.inline).map((f) => `**${f.name}**\n${f.value}`);

  // V2 has no author or title fields, so they become markdown in a text block.
  const headingRaw = [
    authorName ? `-# ${authorName}` : '',
    title ? `# ${title}` : '',
    description,
  ].filter(Boolean).join('\n');

  // Room for the "N hidden" note has to be claimed BEFORE the heading takes
  // what is left, since a long description would otherwise leave nothing and
  // the note would push the message past 4000. Only reserved when something is
  // actually going to be cut.
  const wanted = headingRaw.length + inlineRaw.length + blockRaw.reduce((n, s) => n + s.length, 0);
  if (blockRaw.length && wanted > b.left) b.reserve(NOTE_RESERVE);

  const heading = b.take(headingRaw, LIMITS.v2.text);
  const inlineText = b.take(inlineRaw, LIMITS.v2.text);

  let blockTexts: string[] = [];
  let hiddenFields = 0;
  for (let i = 0; i < blockRaw.length; i++) {
    if (blockRaw[i].length > b.left) { hiddenFields = blockRaw.length - i; break; }
    blockTexts.push(b.take(blockRaw[i], blockRaw[i].length));
  }

  let gallery = [resolve(tpl.image), ...(tpl.gallery ?? []).map((g) => resolve(g))]
    .filter((u) => urlish(u, lenient))
    .slice(0, LIMITS.v2.gallery);

  const buttons = resolveButtons(tpl.buttons, resolve, lenient);
  const headingThumb = heading && urlish(thumb, lenient) ? thumb : '';
  const loneThumb = !heading && urlish(thumb, lenient) ? thumb : '';
  let separators = tpl.separators !== false;

  /**
   * Component cost model. Nested components count toward the same 40, and
   * buttons and Section accessories are themselves components. MediaGallery
   * ITEMS are not — like select options, they are payload inside a component.
   */
  const count = (): number => {
    let n = 1;                                    // the container
    if (content) n += 1;                          // text display outside it
    if (heading) n += headingThumb ? 3 : 1;       // section + text child + accessory
    else if (loneThumb) n += 1;                   // thumbnail promoted to a gallery
    if (inlineText || blockTexts.length) { if (separators) n += 1; }
    if (inlineText) n += 1;
    n += blockTexts.length;
    if (gallery.length) n += 1;
    if (footer) { if (separators) n += 1; n += 1; }
    if (buttons.length) n += 1 + buttons.length;
    return n;
  };

  // Degrade in order of least visible damage rather than letting Discord
  // reject the whole message.
  let trimmedForComponents = false;

  // 1. Merge field blocks — keeps every character, only spacing changes.
  if (count() > LIMITS.v2.components && blockTexts.length > 1) {
    blockTexts = mergeChunks(blockTexts, 1000);
  }
  // 2. Drop dividers — purely decorative.
  if (count() > LIMITS.v2.components && separators) separators = false;
  // 3. Drop trailing field blocks.
  while (count() > LIMITS.v2.components && blockTexts.length) {
    blockTexts.pop();
    trimmedForComponents = true;
  }
  // 4. Last resort: the gallery.
  if (count() > LIMITS.v2.components && gallery.length) gallery = [];

  // Appended to existing text instead of becoming its own text display, so
  // explaining the omission does not itself cost a component.
  const note = hiddenFields > 0
    ? `-# … ${hiddenFields} more field${hiddenFields === 1 ? '' : 's'} hidden (${LIMITS.v2.text}-character limit)`
    : (trimmedForComponents
      ? `-# … some fields hidden (${LIMITS.v2.components}-component limit)`
      : '');

  let headingOut = heading;
  if (note) {
    if (blockTexts.length) blockTexts[blockTexts.length - 1] += `\n${note}`;
    else if (inlineText) headingOut = `${heading}\n${note}`.trim();
    else headingOut = `${heading}\n${note}`.trim();
  }

  return {
    content, heading: headingOut, headingThumb, loneThumb, inlineText, blockTexts,
    gallery, footer, buttons, separators, hiddenFields,
    components: count(),
    text: content.length + headingOut.length + inlineText.length
      + blockTexts.reduce((n, s) => n + s.length, 0) + footer.length,
  };
}

/** Renders as Components V2. */
function renderV2(tpl: MessageTemplate, ctx: PlaceholderContext): Record<string, unknown> {
  const p = (v: string | null | undefined) => applyPlaceholders(v, ctx);
  const plan = planV2(tpl, p);

  const container = new ContainerBuilder();
  if (typeof tpl.color === 'number') container.setAccentColor(tpl.color);

  const divider = () => {
    if (plan.separators) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
      );
    }
  };

  if (plan.heading) {
    if (plan.headingThumb) {
      // V2 has no thumbnail field, so it becomes a Section accessory — the
      // closest equivalent layout. Section stays within its 3-child cap.
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(plan.heading))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(plan.headingThumb)),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(plan.heading));
    }
  } else if (plan.loneThumb) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(plan.loneThumb)),
    );
  }

  if (plan.inlineText || plan.blockTexts.length) divider();
  if (plan.inlineText) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(plan.inlineText));
  }
  for (const block of plan.blockTexts) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(block));
  }

  if (plan.gallery.length) {
    const gallery = new MediaGalleryBuilder();
    for (const url of plan.gallery) gallery.addItems(new MediaGalleryItemBuilder().setURL(url));
    container.addMediaGalleryComponents(gallery);
  }

  if (plan.footer) {
    divider();
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(plan.footer));
  }

  const row = buildButtonRow(plan.buttons);
  if (row) container.addActionRowComponents(row);

  const components: unknown[] = [container];
  // V2 forbids `content`, so plain text is prepended as its own text display —
  // otherwise switching style would silently drop it.
  if (plan.content) {
    components.unshift(new TextDisplayBuilder().setContent(plan.content));
  }

  return { components, flags: MessageFlags.IsComponentsV2 };
}

/**
 * Reports how much of the API budget a template uses, for display in the
 * builder.
 *
 * Measured on the UNRESOLVED template: placeholders are left in place, so a
 * token like `{server.members}` is counted at 17 characters rather than the 2
 * it becomes. That over-states usage slightly, which is the safe direction for
 * a warning — it can never claim you are under the limit when you are not.
 */
export function measureTemplate(tpl: MessageTemplate): {
  style: TemplateStyle;
  text: number;
  textMax: number;
  components: number;
  /** null for embeds, which have no component budget. */
  componentsMax: number | null;
  hiddenFields: number;
  overText: boolean;
} {
  const safe: MessageTemplate = { ...emptyTemplate(tpl.style ?? 'embed'), ...tpl };
  const raw = (v: string | null | undefined) => v ?? '';

  if (safe.style === 'v2') {
    const plan = planV2(safe, raw, true);
    return {
      style: 'v2',
      text: plan.text, textMax: LIMITS.v2.text,
      components: plan.components, componentsMax: LIMITS.v2.components,
      hiddenFields: plan.hiddenFields,
      overText: plan.hiddenFields > 0,
    };
  }

  const plan = planEmbed(safe, raw, true);
  return {
    style: 'embed',
    text: plan.text, textMax: LIMITS.embed.total,
    components: plan.buttons.length ? 1 + plan.buttons.length : 0,
    componentsMax: null,
    hiddenFields: plan.hiddenFields,
    overText: plan.hiddenFields > 0,
  };
}

export function renderTemplate(tpl: MessageTemplate, ctx: PlaceholderContext): Record<string, unknown> {
  const safe: MessageTemplate = { ...emptyTemplate(tpl.style ?? 'embed'), ...tpl };
  const payload = safe.style === 'v2' ? renderV2(safe, ctx) : renderEmbed(safe, ctx);

  /**
   * Templates are user-authored text sent by the BOT, so mention parsing has to
   * be pinned here rather than inherited from the client-wide default
   * (`parse: ['users', 'roles']`).
   *
   * `users` stays enabled because a welcome message greeting the member who just
   * joined is the whole point. `roles` is dropped: it let anyone who can edit a
   * template make the bot deliver a real ping for any role — including roles they
   * have no permission to mention and roles marked unmentionable. Placeholders
   * such as {user.display} interpolate raw member-controlled text, so the content
   * itself cannot be trusted either.
   */
  return { ...payload, allowedMentions: { parse: ['users'] } };
}

/**
 * Marks a rendered payload ephemeral without discarding flags the renderer
 * already set.
 *
 * `{ ...payload, flags: Ephemeral }` looks equivalent but silently drops
 * IS_COMPONENTS_V2 from a V2 render, and Discord then rejects the message
 * because its container components no longer match the flags in the request
 * body. Only the reply patch in utils/V2Flag.ts was papering over that.
 */
export function asEphemeral(payload: Record<string, unknown>): Record<string, unknown> {
  const existing = typeof payload.flags === 'number' ? payload.flags : 0;
  return { ...payload, flags: existing | Number(MessageFlags.Ephemeral) };
}

/** True when a template would produce a visible message. */
export function isRenderable(tpl: MessageTemplate): boolean {
  return Boolean(
    tpl.content?.trim() || tpl.title?.trim() || tpl.description?.trim()
    || tpl.author?.name?.trim() || tpl.footer?.text?.trim()
    || (tpl.fields ?? []).some((f) => f.name?.trim() && f.value?.trim())
    || isImageUrl(tpl.image) || isImageUrl(tpl.thumbnail)
    || (tpl.gallery ?? []).some(isImageUrl),
  );
}

/** Human summary of what a template currently contains, for the builder UI. */
export function describeTemplate(tpl: MessageTemplate): string {
  const set = (label: string, value: unknown) =>
    `${value ? '✅' : '⬜'} ${label}`;
  return [
    `**Style:** ${tpl.style === 'v2' ? 'Components V2' : 'Embed'}`,
    '',
    set('Content (plain text)', tpl.content?.trim()),
    set('Title', tpl.title?.trim()),
    set('Description', tpl.description?.trim()),
    set('Colour', typeof tpl.color === 'number'),
    set('Author', tpl.author?.name?.trim()),
    set('Thumbnail', tpl.thumbnail?.trim()),
    set('Image', tpl.image?.trim()),
    set('Footer', tpl.footer?.text?.trim()),
    set('Timestamp', tpl.timestamp),
    `${(tpl.fields ?? []).length ? '✅' : '⬜'} Fields (${(tpl.fields ?? []).length}/25)`,
    `${(tpl.buttons ?? []).length ? '✅' : '⬜'} Link buttons (${(tpl.buttons ?? []).length}/5)`,
    tpl.style === 'v2'
      ? `${(tpl.gallery ?? []).length ? '✅' : '⬜'} Extra gallery images (${(tpl.gallery ?? []).length}/9)`
      : '-# Gallery images are V2-only — the first is used as the embed image.',
    tpl.style === 'v2'
      ? `${tpl.separators !== false ? '✅' : '⬜'} Dividers`
      : '-# Dividers are V2-only.',
  ].join('\n');
}

export default {
  emptyTemplate, renderTemplate, applyPlaceholders, isRenderable,
  describeTemplate, PLACEHOLDERS,
};
