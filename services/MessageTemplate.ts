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

const DEFAULT_COLOR = 0x5865F2;

function isImageUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** Buttons are identical in both styles; only link buttons are allowed here so
 *  a template can't create a component with no handler behind it. */
function buildButtonRow(
  buttons: TemplateButton[] | undefined, ctx: PlaceholderContext,
): ActionRowBuilder<ButtonBuilder> | null {
  const valid = (buttons ?? [])
    .map((b) => ({ ...b, url: applyPlaceholders(b.url, ctx) }))
    .filter((b) => b.label?.trim() && /^https?:\/\//i.test(b.url))
    .slice(0, 5);
  if (!valid.length) return null;

  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const b of valid) {
    const button = new ButtonBuilder()
      .setLabel(applyPlaceholders(b.label, ctx).slice(0, 80))
      .setStyle(ButtonStyle.Link)
      .setURL(b.url);
    if (b.emoji?.trim()) {
      // An invalid emoji rejects the whole message, so it's applied defensively.
      try { button.setEmoji(b.emoji.trim()); } catch { /* skip the emoji */ }
    }
    row.addComponents(button);
  }
  return row;
}

/** Renders as a classic embed. */
function renderEmbed(tpl: MessageTemplate, ctx: PlaceholderContext): Record<string, unknown> {
  const p = (v: string | null | undefined) => applyPlaceholders(v, ctx);
  const embed = new EmbedBuilder().setColor(tpl.color ?? DEFAULT_COLOR);

  const title = p(tpl.title);
  if (title) embed.setTitle(title.slice(0, 256));

  const description = p(tpl.description);
  if (description) embed.setDescription(description.slice(0, 4096));

  const url = p(tpl.url);
  if (title && /^https?:\/\//i.test(url)) embed.setURL(url);

  if (tpl.author?.name) {
    const icon = p(tpl.author.iconUrl);
    const authorUrl = p(tpl.author.url);
    embed.setAuthor({
      name: p(tpl.author.name).slice(0, 256) || 'Unknown',
      ...(isImageUrl(icon) ? { iconURL: icon } : {}),
      ...(isImageUrl(authorUrl) ? { url: authorUrl } : {}),
    });
  }

  const thumb = p(tpl.thumbnail);
  if (isImageUrl(thumb)) embed.setThumbnail(thumb);

  // Embeds show one image; extra gallery entries are surfaced as links in the
  // footer area rather than being dropped.
  const image = p(tpl.image) || (tpl.gallery ?? []).map((g) => p(g)).find(isImageUrl) || '';
  if (isImageUrl(image)) embed.setImage(image);

  for (const field of (tpl.fields ?? []).slice(0, 25)) {
    const name = p(field.name).slice(0, 256);
    const value = p(field.value).slice(0, 1024);
    if (!name || !value) continue;
    embed.addFields({ name, value, inline: Boolean(field.inline) });
  }

  if (tpl.footer?.text) {
    const icon = p(tpl.footer.iconUrl);
    embed.setFooter({
      text: p(tpl.footer.text).slice(0, 2048),
      ...(isImageUrl(icon) ? { iconURL: icon } : {}),
    });
  }
  if (tpl.timestamp) embed.setTimestamp(new Date());

  const row = buildButtonRow(tpl.buttons, ctx);
  const content = p(tpl.content);

  return {
    ...(content ? { content: content.slice(0, 2000) } : {}),
    embeds: [embed],
    ...(row ? { components: [row] } : {}),
  };
}

/** Renders as Components V2. */
function renderV2(tpl: MessageTemplate, ctx: PlaceholderContext): Record<string, unknown> {
  const p = (v: string | null | undefined) => applyPlaceholders(v, ctx);
  const container = new ContainerBuilder();
  if (typeof tpl.color === 'number') container.setAccentColor(tpl.color);

  const divider = () => {
    if (tpl.separators !== false) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
      );
    }
  };

  // ── Heading block ───────────────────────────────────────────────────────
  const title = p(tpl.title);
  const description = p(tpl.description);
  const authorName = tpl.author?.name ? p(tpl.author.name) : '';
  const thumb = p(tpl.thumbnail);

  const headingLines = [
    authorName ? `-# ${authorName}` : '',
    title ? `# ${title}` : '',
    description,
  ].filter(Boolean).join('\n');

  if (headingLines) {
    // V2 has no author/thumbnail fields, so a thumbnail becomes a Section
    // accessory — the closest equivalent layout.
    if (isImageUrl(thumb)) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(headingLines.slice(0, 4000)))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headingLines.slice(0, 4000)));
    }
  } else if (isImageUrl(thumb)) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(thumb)),
    );
  }

  // ── Fields ──────────────────────────────────────────────────────────────
  const fields = (tpl.fields ?? []).slice(0, 25)
    .map((f) => ({ name: p(f.name), value: p(f.value), inline: Boolean(f.inline) }))
    .filter((f) => f.name && f.value);

  if (fields.length) {
    divider();
    // V2 has no inline layout, so inline fields are grouped onto one line to
    // approximate the side-by-side arrangement.
    const inlineGroup = fields.filter((f) => f.inline);
    const blockGroup = fields.filter((f) => !f.inline);

    if (inlineGroup.length) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        inlineGroup.map((f) => `**${f.name}**\n${f.value}`).join('   \u2003'),
      ));
    }
    for (const f of blockGroup) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${f.name}**\n${f.value}`));
    }
  }

  // ── Images ──────────────────────────────────────────────────────────────
  const images = [p(tpl.image), ...(tpl.gallery ?? []).map((g) => p(g))]
    .filter(isImageUrl)
    .slice(0, 10);
  if (images.length) {
    const gallery = new MediaGalleryBuilder();
    for (const url of images) gallery.addItems(new MediaGalleryItemBuilder().setURL(url));
    container.addMediaGalleryComponents(gallery);
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  const footerText = tpl.footer?.text ? p(tpl.footer.text) : '';
  if (footerText || tpl.timestamp) {
    divider();
    const stamp = tpl.timestamp ? `<t:${Math.floor(Date.now() / 1000)}:f>` : '';
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `-# ${[footerText, stamp].filter(Boolean).join(' • ')}`.slice(0, 2000),
    ));
  }

  const row = buildButtonRow(tpl.buttons, ctx);
  if (row) container.addActionRowComponents(row);

  const content = p(tpl.content);
  const components: unknown[] = [container];

  // V2 forbids `content`, so plain text is prepended as its own text display —
  // otherwise switching style would silently drop it.
  if (content) {
    components.unshift(new TextDisplayBuilder().setContent(content.slice(0, 2000)));
  }

  return { components, flags: MessageFlags.IsComponentsV2 };
}

/** Renders a template into a sendable payload in the configured style. */
export function renderTemplate(tpl: MessageTemplate, ctx: PlaceholderContext): Record<string, unknown> {
  const safe: MessageTemplate = { ...emptyTemplate(tpl.style ?? 'embed'), ...tpl };
  return safe.style === 'v2' ? renderV2(safe, ctx) : renderEmbed(safe, ctx);
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
