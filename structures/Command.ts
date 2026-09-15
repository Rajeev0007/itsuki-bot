/**
 * @file Command.ts
 * @description Base class for all slash/prefix hybrid commands.
 */

import { InteractionContextType, ApplicationIntegrationType } from 'discord.js';
import config from '../config/config';
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
/** Group DMs and DMs with other users. Only valid on user-installable commands. */
const CTX_PRIVATE = Number(CTX?.PrivateChannel ?? 2);

const INT = ApplicationIntegrationType as unknown as Record<string, number> | undefined;
/** Installed to a server. */
const INSTALL_GUILD = Number(INT?.GuildInstall ?? 0);
/** Installed to a user account — "Add to my apps". */
const INSTALL_USER  = Number(INT?.UserInstall ?? 1);

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
  /**
   * Offer this command to users who installed the bot to their own account
   * ("Add to my apps") rather than to a server.
   *
   * Left undefined it is inferred, which is almost always what you want — see
   * the Command constructor. Set it explicitly only to override that.
   */
  userInstall?: boolean;
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
  /** Whether this command is registered for user (account-level) installs. */
  userInstall: boolean;

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

    // A command carrying `default_member_permissions` is inherently a
    // guild-moderation command: that field is meaningless outside a server, so
    // offering it in a user-install context would show a command that can never
    // work. Detected from the builder so individual commands need no annotation.
    const hasMemberPerms = Boolean(
      (this.data as { default_member_permissions?: unknown }).default_member_permissions,
    );

    // Inferred rather than opt-in, so new commands are user-installable by
    // default and only the genuinely server-bound ones are excluded.
    this.userInstall = options.userInstall
      ?? (config.userInstall && !this.guildOnly && !this.ownerOnly && !hasMemberPerms);

    this._applyContexts();
  }

  /**
   * Declares to Discord WHERE this command may be invoked and HOW the app may be
   * installed. Both are derived from the command's own flags so the registration
   * can never disagree with the runtime guards.
   *
   * `integration_types` is the field that makes account-level installs work.
   * Omitting it — as this used to — makes Discord default to `[GuildInstall]`,
   * which is why a user who chose "Add to my apps" saw no commands at all: as far
   * as Discord was concerned, none of them existed outside a server.
   *
   * The two fields are NOT independent. `PrivateChannel` (group DMs and DMs with
   * other people) is only accepted on a user-installable command, so it is added
   * only when user install is actually enabled — otherwise Discord rejects the
   * whole registration.
   *
   *   guild-only            → contexts [Guild],                    install [Guild]
   *   user-installable      → contexts [Guild, BotDM, PrivateChannel], install [Guild, User]
   *   otherwise             → contexts [Guild, BotDM],             install [Guild]
   */
  private _applyContexts(): void {
    const builder = this.data as unknown as {
      setContexts?: (contexts: number[]) => unknown;
      setIntegrationTypes?: (types: number[]) => unknown;
    };

    const contexts = this.guildOnly
      ? [CTX_GUILD]
      : (this.userInstall
        ? [CTX_GUILD, CTX_BOT_DM, CTX_PRIVATE]
        : [CTX_GUILD, CTX_BOT_DM]);

    const integrationTypes = this.userInstall
      ? [INSTALL_GUILD, INSTALL_USER]
      : [INSTALL_GUILD];

    // Each is applied independently: an older builder may support one and not
    // the other, and having contexts still take effect is better than neither.
    if (typeof builder.setContexts === 'function') {
      try { builder.setContexts(contexts); } catch { /* unsupported build */ }
    }
    if (typeof builder.setIntegrationTypes === 'function') {
      try { builder.setIntegrationTypes(integrationTypes); } catch { /* unsupported build */ }
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
