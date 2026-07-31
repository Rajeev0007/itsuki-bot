/**
 * @file Command.ts
 * @description Base class for all slash/prefix hybrid commands.
 */

import { InteractionContextType } from 'discord.js';
import type {
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  Client,
} from 'discord.js';

// Resolved defensively so an older discord.js build can't crash the loader.
const CTX = InteractionContextType as unknown as Record<string, number> | undefined;
const CTX_GUILD   = Number(CTX?.Guild ?? 0);
const CTX_BOT_DM  = Number(CTX?.BotDM ?? 1);

export type SlashCommandData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder
  | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>;

export interface CommandOptions {
  data: SlashCommandData;
  execute: (interaction: ChatInputCommandInteraction, client?: Client) => Promise<unknown>;
  category?: string;
  cooldown?: number | null;
  ownerOnly?: boolean;
  /**
   * Set to `true` only when the command genuinely cannot work outside a server
   * — i.e. it needs a voice channel, guild members, or per-guild settings.
   *
   * Defaults to `false`, so commands are usable in DMs unless they opt out.
   * The economy, gambling, profile and social data is all global, so those work
   * identically in a DM.
   */
  guildOnly?: boolean;
  /**
   * Requires a recent vote on top.gg or Discord Bot List.
   * Premium members and bot owners bypass it.
   */
  voteLocked?: boolean;
  /** Requires an active premium grant (user or guild). */
  premiumOnly?: boolean;
  nsfw?: boolean;
  premium?: boolean;
  permissions?: string[];
  maintenance?: boolean;
  autocomplete?: ((interaction: AutocompleteInteraction, client?: Client) => Promise<void>) | null;
  /** Additional names the command can be invoked with via prefix (e.g. ['bal'] for 'balance'). */
  aliases?: string[];
}

export class Command {
  data: SlashCommandData;
  execute: CommandOptions['execute'];
  category: string;
  cooldown: number | null;
  ownerOnly: boolean;
  guildOnly: boolean;
  voteLocked: boolean;
  premiumOnly: boolean;
  nsfw: boolean;
  premium: boolean;
  permissions: string[];
  maintenance: boolean;
  autocomplete: CommandOptions['autocomplete'];
  aliases: string[];

  constructor(options: CommandOptions) {
    if (!options.data)    throw new Error('[Command] "data" (SlashCommandBuilder) is required.');
    if (!options.execute) throw new Error('[Command] "execute" function is required.');

    this.data        = options.data;
    this.execute     = options.execute;
    this.category    = options.category    ?? 'utility';
    this.cooldown    = options.cooldown    ?? null;
    this.ownerOnly   = options.ownerOnly   ?? false;
    // DM-allowed by default. Previously this defaulted to `true` while no
    // command ever set it, so every single command was blocked in DMs.
    this.guildOnly   = options.guildOnly   ?? false;
    this.voteLocked  = options.voteLocked  ?? false;
    this.premiumOnly = options.premiumOnly ?? false;
    this.nsfw        = options.nsfw        ?? false;
    this.premium     = options.premium     ?? false;
    this.permissions = options.permissions ?? [];
    this.maintenance  = options.maintenance  ?? false;
    this.autocomplete = options.autocomplete ?? null;
    this.aliases      = options.aliases      ?? [];

    this._applyContexts();
  }

  /**
   * Declares to Discord where this command may be invoked, derived from
   * `guildOnly` so the registration can never disagree with the runtime guard.
   *
   * - guild-only  → `[Guild]`, so it isn't even offered in DMs
   * - otherwise   → `[Guild, BotDM]`
   *
   * `PrivateChannel` (group DMs) is deliberately excluded: Discord only accepts
   * that context for user-installable apps, and this is a guild-installed bot.
   */
  private _applyContexts(): void {
    const builder = this.data as unknown as {
      setContexts?: (contexts: number[]) => unknown;
    };
    if (typeof builder.setContexts !== 'function') return;
    try {
      builder.setContexts(this.guildOnly ? [CTX_GUILD] : [CTX_GUILD, CTX_BOT_DM]);
    } catch {
      /* Older builder without context support — registration falls back to
         Discord's default (all contexts), and the runtime guard still holds. */
    }
  }

  get name(): string {
    return (this.data as { name: string }).name;
  }

  /** True when this command is offered in DMs. */
  get dmAllowed(): boolean {
    return !this.guildOnly;
  }
}
