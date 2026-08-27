/**
 * @file MessageAdapter.ts
 * @description Wraps a Discord Message so it can be passed directly into any
 * existing slash-command execute() — zero rewrites needed on command files.
 *
 * Components V2 payloads (ContainerBuilder etc.) are forwarded as-is; Discord
 * supports them on regular channel messages when IS_COMPONENTS_V2 flag is set.
 *
 * Implements the ChatInputCommandInteraction surface actually used by commands:
 * user / guild / channel / client / replied / deferred
 * options → getString · getInteger · getNumber · getBoolean · getUser
 * get · getSubcommand · getSubcommandGroup
 * deferReply · editReply · reply · followUp
 */

import {
  type Message,
  type Client,
  type User,
  type Guild,
  type TextBasedChannel,
  type GuildTextBasedChannel,
  type PermissionsBitField,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { type SlashCommandData } from './Command';
import { hasV2Components } from '../utils/V2Flag';
import logger from '../utils/Logger';

// ── IS_COMPONENTS_V2 flag value (1 << 15 = 32768) ───────────────────────────
const IS_V2 = Number((MessageFlags as Record<string, unknown>).IsComponentsV2 ?? 32768);
const EPHEMERAL = Number((MessageFlags as Record<string, unknown>).Ephemeral ?? 64);

/** Wraps plain text in a minimal Components V2 container. */
function v2Text(content: string): ContainerBuilder {
  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
}

const SNOWFLAKE_RE = /^<@!?(\d{15,25})>$|^(\d{15,25})$/;

// ── ApplicationCommandOptionType constants ───────────────────────────────────
const OT = {
  SUB_COMMAND: 1,
  SUB_COMMAND_GROUP: 2,
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
  USER: 6,
  NUMBER: 10,
} as const;

interface OptionEntry {
  type: number;
  value: unknown;
  user?: User;
}

// ── PrefixOptions ─────────────────────────────────────────────────────────────
/**
 * Parses positional message arguments into typed named options that mirror
 * the ChatInputCommandInteraction.options API.
 */
export class PrefixOptions {
  private readonly _map = new Map<string, OptionEntry>();
  private _subcmd: string | null = null;
  private _subcmdGrp: string | null = null;

  constructor(data: SlashCommandData, args: string[], message: Message) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (data as any).toJSON?.() as { options?: unknown[] } | undefined;
    const options = (json?.options ?? []) as Array<{ type: number; name: string; options?: unknown[] }>;

    // ── Subcommand group ─────────────────────────────────────────────────────
    if (options[0]?.type === OT.SUB_COMMAND_GROUP) {
      const grp = options.find((o) => o.name === args[0]?.toLowerCase());
      if (grp) {
        this._subcmdGrp = grp.name;
        const sub = (grp.options ?? [] as typeof options).find(
          (o) => (o as { type: number; name: string }).name === args[1]?.toLowerCase()
               && (o as { type: number }).type === OT.SUB_COMMAND
        ) as typeof options[0] | undefined;
        if (sub) {
          this._subcmd = sub.name;
          this._mapOpts(
            (sub.options ?? []) as Array<{ type: number; name: string }>,
            args.slice(2),
            message,
          );
        }
      }
      return;
    }

    // ── Subcommand ───────────────────────────────────────────────────────────
    if (options[0]?.type === OT.SUB_COMMAND) {
      const sub = options.find((o) => o.name === args[0]?.toLowerCase());
      if (sub) {
        this._subcmd = sub.name;
        this._mapOpts(
          (sub.options ?? []) as Array<{ type: number; name: string }>,
          args.slice(1),
          message,
        );
      } else if (args[0]) {
        // Unknown subcommand — store it so the command can produce its own error
        this._subcmd = args[0].toLowerCase();
      }
      return;
    }

    // ── Regular options ──────────────────────────────────────────────────────
    this._mapOpts(options as Array<{ type: number; name: string }>, args, message);
  }

  private _mapOpts(
    options: Array<{ type: number; name: string }>,
    args: string[],
    message: Message,
  ): void {
    const mentions = [...message.mentions.users.values()];
    let mentionIdx = 0;
    let argIdx = 0;

    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const isLast = i === options.length - 1;

      if (opt.type === OT.USER) {
        // Prefer @mentions in order; fall back to a bare user ID / <@id>.
        const user = mentions[mentionIdx] ?? null;
        if (user) {
          mentionIdx++;
          this._map.set(opt.name, { type: OT.USER, value: user.id, user });
        } else {
          const raw = args[argIdx];
          const match = raw ? SNOWFLAKE_RE.exec(raw.trim()) : null;
          const id = match ? (match[1] ?? match[2]) : null;
          if (id) {
            // Resolve the ID so getUser()/get().user actually return a User
            // instead of null (which callers dereference with `!`).
            const resolved =
              message.guild?.members.cache.get(id)?.user
              ?? message.client.users.cache.get(id)
              ?? null;
            this._map.set(opt.name, { type: OT.USER, value: id, user: resolved ?? undefined });
          } else if (raw) {
            this._map.set(opt.name, { type: OT.USER, value: raw });
          }
        }
        argIdx++;

      } else if (opt.type === OT.INTEGER) {
        const n = parseInt((args[argIdx++] ?? '').replace(/[,_]/g, ''), 10);
        if (!isNaN(n)) this._map.set(opt.name, { type: OT.INTEGER, value: n });

      } else if (opt.type === OT.NUMBER) {
        const n = parseFloat((args[argIdx++] ?? '').replace(/[,_]/g, ''));
        if (!isNaN(n)) this._map.set(opt.name, { type: OT.NUMBER, value: n });

      } else if (opt.type === OT.BOOLEAN) {
        const raw = args[argIdx++]?.toLowerCase();
        if (raw) this._map.set(opt.name, { type: OT.BOOLEAN, value: raw === 'true' || raw === 'yes' || raw === '1' });

      } else {
        // STRING — last option eats remaining args (handles multi-word input)
        if (isLast && argIdx < args.length) {
          this._map.set(opt.name, { type: OT.STRING, value: args.slice(argIdx).join(' ') });
          argIdx = args.length;
        } else {
          const raw = args[argIdx++];
          if (raw !== undefined) this._map.set(opt.name, { type: OT.STRING, value: raw });
        }
      }
    }
  }

  // ── Public option accessors ───────────────────────────────────────────────

  /**
   * Mirrors interaction.options.get(name) — returns { value, user } or null.
   * Handles `options.get('x')?.user` and `options.get('x')!.value as T` patterns.
   */
  get(name: string): { value: unknown; user: User | null } | null {
    const e = this._map.get(name);
    return e ? { value: e.value, user: e.user ?? null } : null;
  }

  getString(name: string, required?: boolean): string | null {
    const v = this._map.get(name)?.value;
    if (v == null) { if (required) throw new Error(`Missing required option: ${name}`); return null; }
    return String(v);
  }

  getInteger(name: string, required?: boolean): number | null {
    const v = this._map.get(name)?.value;
    if (v == null) { if (required) throw new Error(`Missing required option: ${name}`); return null; }
    return Math.floor(Number(v));
  }

  getNumber(name: string, required?: boolean): number | null {
    const v = this._map.get(name)?.value;
    if (v == null) { if (required) throw new Error(`Missing required option: ${name}`); return null; }
    return Number(v);
  }

  getBoolean(name: string, required?: boolean): boolean | null {
    const v = this._map.get(name)?.value;
    if (v == null) { if (required) throw new Error(`Missing required option: ${name}`); return null; }
    return Boolean(v);
  }

  getUser(name: string, required?: boolean): User | null {
    const e = this._map.get(name);
    if (!e) { if (required) throw new Error(`Missing required option: ${name}`); return null; }
    return e.user ?? null;
  }

  // Stubs — not resolvable from a plain message
  getMember(_n: string) { return null; }
  getChannel(_n: string) { return null; }
  getRole(_n: string) { return null; }
  getAttachment(_n: string) { return null; }
  getFocused() { return ''; }

  getSubcommand(required = true): string {
    if (!this._subcmd) {
      if (required) throw new Error('Please provide a subcommand. Usage: `<prefix><command> <subcommand> [options]`');
      return '';
    }
    return this._subcmd;
  }

  getSubcommandGroup(required = false): string | null {
    if (!this._subcmdGrp && required) throw new Error('Please provide a subcommand group.');
    return this._subcmdGrp;
  }
}

// ── MessageCommandAdapter ─────────────────────────────────────────────────────
/**
 * Drop-in replacement for ChatInputCommandInteraction when running a command
 * triggered by a prefix message. V2 component payloads are forwarded as-is —
 * Discord renders them on regular messages when IS_COMPONENTS_V2 is set.
 */
export class MessageCommandAdapter {
  readonly user: User;
  readonly guild: Guild | null;
  readonly channel: TextBasedChannel | null;
  readonly client: Client;
  readonly options: PrefixOptions;

  /** Real GuildMember — exposes .voice, .permissions, .roles etc. for music / permission checks */
  get member() { return this._msg.member; }

  /**
   * The invoker's permissions IN THIS CHANNEL, mirroring
   * `ChatInputCommandInteraction#memberPermissions`.
   *
   * Commands feature-check this to decide whether the user may perform a
   * privileged action (e.g. /steal needs Manage Expressions). It was missing
   * entirely, so every such check read `undefined` and failed closed — which
   * made `,steal` unusable even for the server owner, and that command's
   * reply-based flow only exists on this adapter.
   *
   * Channel-aware rather than role-only so per-channel overwrites are honoured.
   */
  get memberPermissions(): PermissionsBitField | null {
    const member = this._msg.member;
    if (!member) return null;
    const channel = this._msg.channel;
    if (channel && 'permissionsFor' in channel) {
      const resolved = (channel as GuildTextBasedChannel).permissionsFor(member);
      if (resolved) return resolved;
    }
    return member.permissions;
  }

  /** The message this command replied to, if it was invoked as a reply. */
  get replyTargetId(): string | null {
    return this._msg.reference?.messageId ?? null;
  }

  /**
   * Fetches the message this command replied to.
   *
   * Slash commands have no equivalent, so commands that support reply-style
   * invocation should feature-detect this method rather than assume it exists.
   */
  async fetchReplyTarget(): Promise<Message | null> {
    const id = this._msg.reference?.messageId;
    if (!id) return null;
    try {
      return await this._msg.channel.messages.fetch(id);
    } catch {
      // Deleted, or in a channel we can no longer read.
      return null;
    }
  }

  replied = false;
  deferred = false;

  private _loadingMsg: Message | null = null;

  /** Edit the loading message (or reply fresh) with an error payload. Used by the prefix router for error recovery. */
  async sendError(payload: unknown): Promise<void> {
    try {
      if (this._loadingMsg) {
        await this._loadingMsg.edit(this._withFlag(payload) as never);
      } else {
        await this._msg.reply(this._withFlag(payload) as never);
      }
    } catch { /* best-effort */ }
  }

  constructor(
    private readonly _msg: Message,
    data: SlashCommandData,
    args: string[],
  ) {
    this.user = _msg.author;
    this.guild = _msg.guild;
    this.channel = _msg.channel as TextBasedChannel;
    this.client = _msg.client;
    this.options = new PrefixOptions(data, args, _msg);
  }

  // ── Interaction-mirroring methods ─────────────────────────────────────────

  async deferReply(_opts?: unknown): Promise<void> {
    try {
      // Two things matter here:
      //  1. Discord rejects an empty message, so the placeholder needs real
      //     content (the previous `{ content: '' }` always threw).
      //  2. A message created WITHOUT IS_COMPONENTS_V2 can never have the flag
      //     added by a later edit. Since practically every command edits in a
      //     V2 payload, the placeholder itself must be a V2 message.
      this._loadingMsg = await this._msg.reply({
        components: [v2Text('-# Working…')],
        flags: IS_V2,
      } as never);
      this.deferred = true;
    } catch (err) {
      logger.debug('[Prefix] deferReply failed:', (err as Error).message);
      this._loadingMsg = null;
    }
  }

  async editReply(payload: unknown): Promise<unknown> {
    return this._send(payload);
  }

  async reply(payload: unknown): Promise<unknown> {
    return this._send(payload);
  }

  async followUp(payload: unknown): Promise<unknown> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (this._msg.channel as any).send(this._withFlag(payload));
    } catch (err) {
      logger.debug('[Prefix] followUp failed:', (err as Error).message);
      return null;
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async _send(payload: unknown): Promise<unknown> {
    const p = this._withFlag(payload);
    try {
      if (this._loadingMsg) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = await this._loadingMsg.edit(p as any);
        this.replied = true;
        return msg;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = await this._msg.reply(p as any);
      this.replied = true;
      return msg;
    } catch (err) {
      logger.debug('[Prefix] send failed:', (err as Error).message);
      // Last-resort fallback — send a fresh message to the channel
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (this._msg.channel as any).send(p);
      } catch {
        return null;
      }
    }
  }

  /**
   * Normalises a payload for delivery as a regular channel message.
   *
   * Everything the adapter sends is turned into a Components V2 payload: the
   * loading message is created as V2 (see deferReply) and Discord will not let
   * a V2 message be edited into a content/embeds message. Plain-text payloads
   * are therefore wrapped in a minimal container rather than sent as `content`,
   * which is what used to make those replies fail outright.
   *
   * The Ephemeral bit is always stripped — ephemeral replies don't exist for
   * regular messages.
   */
  private _withFlag(raw: unknown): Record<string, unknown> {
    const p: Record<string, unknown> =
      typeof raw === 'object' && raw !== null
        ? { ...(raw as Record<string, unknown>) }
        : { content: String(raw ?? '') };

    delete p.ephemeral;

    if (!hasV2Components(p)) {
      // Fold content/embeds-style payloads into a V2 container so they can be
      // delivered through the same (V2) message the command deferred with.
      const text = typeof p.content === 'string' && p.content.trim().length > 0
        ? p.content
        : null;
      const extraRows = Array.isArray(p.components) ? p.components : [];
      if (text !== null || extraRows.length > 0) {
        p.components = [v2Text(text ?? '-# Done.'), ...extraRows];
      } else {
        p.components = [v2Text('-# Done.')];
      }
      delete p.embeds;
    }

    // Components V2 forbids `content`. Message#edit() is a partial patch, so
    // the placeholder text has to be explicitly cleared — Discord treats
    // `null` as "remove this field".
    p.content = null;

    const existing = typeof p.flags === 'number' ? p.flags : 0;
    p.flags = (existing | IS_V2) & ~EPHEMERAL;

    return p;
  }
}
