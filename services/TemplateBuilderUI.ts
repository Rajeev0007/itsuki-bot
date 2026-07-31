/**
 * @file TemplateBuilderUI.ts
 * @description The interactive panel that edits a MessageTemplate.
 *
 * ── Why sessions instead of encoding state in customIds ──────────────────────
 * A customId is capped at 100 characters and is visible to (and forgeable by)
 * the client. A full template with fields, buttons and a gallery does not fit,
 * and round-tripping it through the client would let anyone hand us arbitrary
 * content. So the work-in-progress template lives server side in a Map and the
 * customId carries only a short opaque session id.
 *
 * Sessions expire after 14 minutes, just inside the 15-minute interaction token
 * window — past that the panel could not be edited anyway.
 */

import {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
  type ChatInputCommandInteraction, type ButtonInteraction,
  type StringSelectMenuInteraction, type ModalSubmitInteraction,
  type TextChannel,
} from 'discord.js';
import { randomBytes } from 'node:crypto';
import {
  emptyTemplate, renderTemplate, describeTemplate, isRenderable,
  type MessageTemplate,
} from './MessageTemplate';
import WelcomerManager, { type WelcomerEvent } from '../managers/WelcomerManager';
import { getStore } from '../database/JsonStore';
import logger from '../utils/Logger';

const templatesDB = getStore('templates');

const SESSION_TTL_MS = 14 * 60 * 1000;

export interface BuilderSession {
  sid: string;
  ownerId: string;
  /** Where a save goes. One of:
   *   `welcomer:welcome` | `welcomer:goodbye` | `msg:<name>` | `send:<channelId>` */
  target: string;
  guildId: string | null;
  template: MessageTemplate;
  expiresAt: number;
}

const sessions = new Map<string, BuilderSession>();

/** Drops expired sessions so the Map cannot grow without bound. */
function sweep(): void {
  const now = Date.now();
  for (const [sid, s] of sessions) if (s.expiresAt <= now) sessions.delete(sid);
}

/**
 * Looks up a session and verifies the presser owns it.
 *
 * Returns an optional-field result rather than a discriminated union — with
 * `strict: false` TypeScript will not narrow `{ok:true}|{ok:false}` unions.
 */
export function getSession(sid: string, userId: string): { session?: BuilderSession; reason?: string } {
  sweep();
  const session = sessions.get(sid);
  if (!session) {
    return { reason: 'This builder session expired. Re-open the builder to continue — your last **saved** version is safe.' };
  }
  if (session.ownerId !== userId) {
    return { reason: 'This builder belongs to someone else. Open your own with the command.' };
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { session };
}

function createSession(ownerId: string, target: string, guildId: string | null, template: MessageTemplate): BuilderSession {
  sweep();
  // One session per user+target: re-opening the same builder replaces the old
  // one instead of leaving a stale panel that could overwrite newer edits.
  for (const [sid, s] of sessions) {
    if (s.ownerId === ownerId && s.target === target) sessions.delete(sid);
  }
  const sid = randomBytes(6).toString('hex');
  const session: BuilderSession = {
    sid, ownerId, target, guildId,
    template: { ...emptyTemplate(template?.style ?? 'embed'), ...(template ?? {}) },
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(sid, session);
  return session;
}

// ── Colour parsing ───────────────────────────────────────────────────────────

const COLOR_NAMES: Record<string, number> = {
  red: 0xED4245, green: 0x57F287, blue: 0x3498DB, yellow: 0xFEE75C,
  orange: 0xE67E22, purple: 0x9B59B6, pink: 0xEB459E, blurple: 0x5865F2,
  white: 0xFFFFFF, black: 0x000000, grey: 0x95A5A6, gray: 0x95A5A6,
  gold: 0xF1C40F, cyan: 0x1ABC9C, teal: 0x1ABC9C, magenta: 0xE91E63,
};

/**
 * Accepts `#5865F2`, `5865F2`, `0x5865F2`, a decimal, a colour name, or
 * `random`. Returns null when the input is blank (meaning "clear it") and
 * undefined when it is unparseable, so the caller can tell those apart.
 */
export function parseColor(input: string | null | undefined): number | null | undefined {
  const raw = (input ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'random') return Math.floor(Math.random() * 0xFFFFFF);
  if (raw in COLOR_NAMES) return COLOR_NAMES[raw];

  const hex = raw.replace(/^#/, '').replace(/^0x/, '');
  if (/^[0-9a-f]{6}$/.test(hex)) return parseInt(hex, 16);
  if (/^[0-9a-f]{3}$/.test(hex)) {
    // Expand shorthand like #f0a to #ff00aa.
    return parseInt(hex.split('').map((c) => c + c).join(''), 16);
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 0 && n <= 0xFFFFFF) return n;
  }
  return undefined;
}

/** Splits a textarea of URLs on newlines/commas/spaces. */
export function parseUrlList(input: string | null | undefined): string[] {
  return (input ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

// ── Panel ────────────────────────────────────────────────────────────────────

function targetLabel(target: string): string {
  if (target === 'welcomer:welcome') return 'Welcome message';
  if (target === 'welcomer:goodbye') return 'Goodbye message';
  if (target === 'wdm:welcome') return 'Welcome DM';
  if (target.startsWith('msg:')) return `Saved template \`${target.slice(4)}\``;
  if (target.startsWith('send:')) return `One-off message to <#${target.slice(5)}>`;
  return target;
}

function saveVerb(target: string): string {
  return target.startsWith('send:') ? 'Send' : 'Save';
}

/** Builds the panel payload for a session. Pure — callers decide how to deliver it. */
export function buildPayload(session: BuilderSession): Record<string, unknown> {
  const tpl = session.template;
  const sid = session.sid;
  const v2 = tpl.style === 'v2';

  const container = new ContainerBuilder()
    .setAccentColor(typeof tpl.color === 'number' ? tpl.color : 0x5865F2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      '# 🧩 Message Builder',
      `**Editing:** ${targetLabel(session.target)}`,
    ].join('\n')))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(describeTemplate(tpl)))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

  // Editing groups. Each opens a modal holding at most 5 inputs, which is the
  // hard Discord limit — hence the grouping rather than one big form.
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`tb_open_text:${sid}`).setLabel('Text').setEmoji('📝').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`tb_open_media:${sid}`).setLabel('Media').setEmoji('🖼️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`tb_open_trim:${sid}`).setLabel('Author & Footer').setEmoji('🏷️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`tb_open_field:${sid}`).setLabel('Add Field').setEmoji('📋').setStyle(ButtonStyle.Secondary)
        .setDisabled((tpl.fields ?? []).length >= 25),
      new ButtonBuilder().setCustomId(`tb_open_button:${sid}`).setLabel('Add Button').setEmoji('🔗').setStyle(ButtonStyle.Secondary)
        .setDisabled((tpl.buttons ?? []).length >= 5),
    ),
  );

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`tb_style:${sid}`)
        .setLabel(v2 ? 'Switch to Embed' : 'Switch to V2').setEmoji('🎨').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`tb_timestamp:${sid}`)
        .setLabel(`Timestamp: ${tpl.timestamp ? 'on' : 'off'}`).setEmoji('🕐').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`tb_dividers:${sid}`)
        .setLabel(`Dividers: ${tpl.separators !== false ? 'on' : 'off'}`).setEmoji('➖').setStyle(ButtonStyle.Secondary)
        // Dividers only exist in V2; disabling explains itself better than hiding.
        .setDisabled(!v2),
      new ButtonBuilder().setCustomId(`tb_reset:${sid}`).setLabel('Reset').setEmoji('♻️').setStyle(ButtonStyle.Danger),
    ),
  );

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`tb_preview:${sid}`).setLabel('Preview').setEmoji('👁️').setStyle(ButtonStyle.Secondary)
        .setDisabled(!isRenderable(tpl)),
      new ButtonBuilder().setCustomId(`tb_save:${sid}`).setLabel(saveVerb(session.target)).setEmoji('💾').setStyle(ButtonStyle.Success)
        .setDisabled(!isRenderable(tpl)),
      new ButtonBuilder().setCustomId(`tb_close:${sid}`).setLabel('Close').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
    ),
  );

  // Removal menus appear only when there is something to remove.
  const fields = tpl.fields ?? [];
  if (fields.length) {
    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`tb_rmfield:${sid}`)
          .setPlaceholder('Remove a field…')
          .addOptions(fields.slice(0, 25).map((f, i) => ({
            label: (f.name || `Field ${i + 1}`).slice(0, 100),
            description: (f.value || '').slice(0, 100) || undefined,
            value: String(i),
          }))),
      ),
    );
  }

  const buttons = tpl.buttons ?? [];
  if (buttons.length) {
    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`tb_rmbutton:${sid}`)
          .setPlaceholder('Remove a link button…')
          .addOptions(buttons.slice(0, 5).map((b, i) => ({
            label: (b.label || `Button ${i + 1}`).slice(0, 100),
            description: (b.url || '').slice(0, 100) || undefined,
            value: String(i),
          }))),
      ),
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      '-# Placeholders like `{user}`, `{server}` and `{server.ordinal}` work in every text field.',
      `-# Leave a modal field **empty to clear** it. Nothing is stored until you press **${saveVerb(session.target)}**.`,
    ].join('\n')));

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/** Opens a fresh builder on an already-deferred slash command. */
export async function openBuilder(
  interaction: ChatInputCommandInteraction,
  opts: { target: string; template: MessageTemplate; ownerId: string },
): Promise<unknown> {
  const session = createSession(opts.ownerId, opts.target, interaction.guildId ?? null, opts.template);
  return interaction.editReply(buildPayload(session) as never);
}

/**
 * Redraws the panel in place after an edit.
 *
 * Uses deferUpdate + editReply rather than update() so the same path works for
 * buttons, select menus and modal submissions — `update()` is only present on
 * modal submissions that came from a message, which the type system can't prove
 * here.
 */
export async function refresh(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  session: BuilderSession,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await (interaction as unknown as { deferUpdate: () => Promise<unknown> }).deferUpdate();
  }
  await interaction.editReply(buildPayload(session) as never);
}

// ── Modals ───────────────────────────────────────────────────────────────────

function input(
  id: string, label: string, style: TextInputStyle,
  value: string | null | undefined, max: number, placeholder?: string,
): ActionRowBuilder<TextInputBuilder> {
  const field = new TextInputBuilder()
    .setCustomId(id).setLabel(label.slice(0, 45)).setStyle(style)
    .setRequired(false).setMaxLength(max);
  if (placeholder) field.setPlaceholder(placeholder.slice(0, 100));
  // Pre-filling avoids retyping, but an empty string is rejected by the API.
  if (value) field.setValue(String(value).slice(0, max));
  return new ActionRowBuilder<TextInputBuilder>().addComponents(field);
}

/** Builds one of the editing modals. `group` matches the button that opened it. */
export function buildModal(group: string, session: BuilderSession): ModalBuilder | null {
  const tpl = session.template;
  const modal = new ModalBuilder().setCustomId(`tb_modal:${group}:${session.sid}`);

  if (group === 'text') {
    return modal.setTitle('Text & Colour').addComponents(
      input('content', 'Plain text (pings work here)', TextInputStyle.Paragraph, tpl.content, 2000, 'Welcome {user}!'),
      input('title', 'Title', TextInputStyle.Short, tpl.title, 256, 'Welcome to {server}!'),
      input('description', 'Description', TextInputStyle.Paragraph, tpl.description, 4000, 'You are our {server.ordinal} member.'),
      input('url', 'Title link URL', TextInputStyle.Short, tpl.url, 500, 'https://example.com'),
      input('color', 'Colour', TextInputStyle.Short,
        typeof tpl.color === 'number' ? `#${tpl.color.toString(16).padStart(6, '0')}` : '',
        20, '#5865F2, blurple, or random'),
    );
  }

  if (group === 'media') {
    return modal.setTitle('Images').addComponents(
      input('thumbnail', 'Thumbnail URL', TextInputStyle.Short, tpl.thumbnail, 500, '{user.avatar}'),
      input('image', 'Large image URL', TextInputStyle.Short, tpl.image, 500, 'https://…/banner.png'),
      input('gallery', 'Extra gallery images (V2, one per line)', TextInputStyle.Paragraph,
        (tpl.gallery ?? []).join('\n'), 1500, 'https://…/1.png'),
    );
  }

  if (group === 'trim') {
    return modal.setTitle('Author & Footer').addComponents(
      input('author_name', 'Author name', TextInputStyle.Short, tpl.author?.name, 256, '{user.tag}'),
      input('author_icon', 'Author icon URL', TextInputStyle.Short, tpl.author?.iconUrl, 500, '{user.avatar}'),
      input('author_url', 'Author link URL', TextInputStyle.Short, tpl.author?.url, 500, 'https://example.com'),
      input('footer_text', 'Footer text', TextInputStyle.Short, tpl.footer?.text, 2048, 'Member #{server.members}'),
      input('footer_icon', 'Footer icon URL', TextInputStyle.Short, tpl.footer?.iconUrl, 500, '{server.icon}'),
    );
  }

  if (group === 'field') {
    return modal.setTitle('Add a Field').addComponents(
      input('name', 'Field name', TextInputStyle.Short, '', 256, 'Joined'),
      input('value', 'Field value', TextInputStyle.Paragraph, '', 1024, '{joined}'),
      input('inline', 'Inline? (yes / no)', TextInputStyle.Short, 'no', 5, 'no'),
    );
  }

  if (group === 'button') {
    return modal.setTitle('Add a Link Button').addComponents(
      input('label', 'Button label', TextInputStyle.Short, '', 80, 'Read the rules'),
      input('url', 'Button URL', TextInputStyle.Short, '', 500, 'https://discord.com/channels/…'),
      input('emoji', 'Emoji (optional)', TextInputStyle.Short, '', 60, '📜'),
    );
  }

  return null;
}

// ── Saving ───────────────────────────────────────────────────────────────────

/** Persists or sends a session's template according to its target. */
export async function commitSession(
  session: BuilderSession,
  interaction: ButtonInteraction,
): Promise<{ ok: boolean; title: string; message: string }> {
  const tpl = session.template;
  const target = session.target;

  // DM welcome template — a separate target so it can differ from the one
  // posted in the channel.
  if (target.startsWith('wdm:')) {
    const event = target.slice(4) as WelcomerEvent;
    if (!session.guildId) return { ok: false, title: 'Server Only', message: 'That target needs a server.' };

    await WelcomerManager.setDmTemplate(session.guildId, event, tpl);
    const cfg = await WelcomerManager.getConfig(session.guildId, event);
    return {
      ok: true, title: 'DM Message Saved',
      message: [
        `The DM sent to new members was saved as **${tpl.style === 'v2' ? 'Components V2' : 'an embed'}**.`,
        cfg.dmEnabled
          ? 'DM welcomes are **on**.'
          : 'DM welcomes are currently **off** — turn them on with `/welcomer dm enabled:True`.',
        '-# Members with DMs closed simply won\'t receive it; that is not an error.',
      ].join('\n'),
    };
  }

  if (target.startsWith('welcomer:')) {
    const event = target.slice('welcomer:'.length) as WelcomerEvent;
    if (!session.guildId) return { ok: false, title: 'Server Only', message: 'That target needs a server.' };

    await WelcomerManager.setTemplate(session.guildId, event, tpl);
    const cfg = await WelcomerManager.getConfig(session.guildId, event);

    // Saving content is useless if the message can never fire, so surface the
    // remaining setup step instead of reporting a bare success.
    const todo: string[] = [];
    if (!cfg.channelId) todo.push(`Pick a channel: \`/welcomer quick event:${event} channel:#…\``);
    if (!cfg.enabled) todo.push(`Turn it on: \`/welcomer toggle event:${event} enabled:True\``);

    return {
      ok: true,
      title: 'Saved',
      message: [
        `The ${event} message was saved as **${tpl.style === 'v2' ? 'Components V2' : 'an embed'}**.`,
        cfg.channelId ? `It posts in <#${cfg.channelId}>.` : '',
        todo.length ? ['', '**Still to do:**', ...todo.map((t) => `> ${t}`)].join('\n') : '',
        `-# Preview any time with \`/welcomer test event:${event}\`.`,
      ].filter(Boolean).join('\n'),
    };
  }

  if (target.startsWith('msg:')) {
    const name = target.slice(4);
    if (!session.guildId) return { ok: false, title: 'Server Only', message: 'Saved templates are per-server.' };
    await templatesDB.set(`${session.guildId}.${name}`, tpl);
    return {
      ok: true, title: 'Template Saved',
      message: [
        `Saved as \`${name}\`.`,
        `Send it with \`/msgbuilder send name:${name} channel:#…\`.`,
        `Edit it again with \`/msgbuilder edit name:${name}\`.`,
      ].join('\n'),
    };
  }

  if (target.startsWith('send:')) {
    const channelId = target.slice(5);
    const channel = interaction.guild?.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel?.send) {
      return { ok: false, title: 'Channel Gone', message: 'That channel no longer exists or I cannot see it.' };
    }
    try {
      const sent = await channel.send(renderTemplate(tpl, {
        member: interaction.guild?.members.cache.get(interaction.user.id) ?? null,
        user: interaction.user,
        guild: interaction.guild ?? null,
      }) as never);
      return {
        ok: true, title: 'Message Sent',
        message: `Posted in ${channel}.\n-# [Jump to it](${sent.url})`,
      };
    } catch (err) {
      logger.warn(`[Builder] Send failed: ${(err as Error).message}`);
      return { ok: false, title: 'Send Failed', message: (err as Error).message };
    }
  }

  return { ok: false, title: 'Unknown Target', message: `Cannot save to \`${target}\`.` };
}

export function closeSession(sid: string): void {
  sessions.delete(sid);
}

/** Loads a saved template by name, or null. */
export async function loadSaved(guildId: string, name: string): Promise<MessageTemplate | null> {
  const stored = await templatesDB.get(`${guildId}.${name}`) as MessageTemplate | undefined;
  if (!stored || typeof stored !== 'object') return null;
  return { ...emptyTemplate(stored.style ?? 'embed'), ...stored };
}

/** Lists saved template names for a guild. */
export async function listSaved(guildId: string): Promise<string[]> {
  const all = await templatesDB.get(guildId) as Record<string, unknown> | undefined;
  if (!all || typeof all !== 'object') return [];
  return Object.keys(all).sort();
}

export async function deleteSaved(guildId: string, name: string): Promise<boolean> {
  const existing = await loadSaved(guildId, name);
  if (!existing) return false;
  await templatesDB.delete(`${guildId}.${name}`);
  return true;
}

export default {
  openBuilder, buildPayload, buildModal, getSession, refresh, commitSession,
  closeSession, parseColor, parseUrlList, loadSaved, listSaved, deleteSaved,
};
