/**
 * @file InteractionHandler.ts
 * @description Routes button / modal / select-menu interactions to their handlers.
 * All interactions are patched with IS_COMPONENTS_V2 before dispatch so handlers
 * do not need to include the flag manually in every editReply / update call.
 */

import fs from 'fs';
import path from 'path';
import { MessageFlags, type Client, type Interaction } from 'discord.js';
import logger from '../utils/Logger';

interface InteractionModule {
  customId: string;
  execute: (interaction: Interaction, client: Client) => Promise<void>;
}

/**
 * Does a `PREFIX:*` registration claim this customId?
 *
 * Two conventions are in use in this codebase and both must keep working:
 *   `panel_:*`    → owns every id beginning with `panel_` (panel_maint:…, panel_nav:…)
 *   `card_page:*` → owns the `card_page` SEGMENT only (card_page:<user>:<page>:…)
 *
 * The previous logic was a bare `startsWith` with the ':' stripped, which made
 * the second form leak: `card_page:*` also claimed `card_page_display` and
 * `lb_page:*` claimed `lb_page_display`, routing a page-indicator button into the
 * pagination handler. Requiring a segment boundary — end of string, or ':' — fixes
 * that, while a prefix deliberately ending in '_' keeps its open-ended behaviour.
 */
function matchesPrefix(prefix: string, rawId: string): boolean {
  if (!rawId.startsWith(prefix)) return false;
  if (prefix.endsWith('_')) return true;              // "panel_" style
  if (rawId.length === prefix.length) return true;    // exact
  return rawId[prefix.length] === ':';                // segment boundary
}

export default class InteractionHandler {
  client: Client;
  buttons: Map<string, InteractionModule>;
  modals: Map<string, InteractionModule>;
  menus: Map<string, InteractionModule>;

  constructor(client: Client) {
    this.client = client;
    this.buttons = new Map();
    this.modals = new Map();
    this.menus = new Map();
  }

  load(): void {
    this._loadDir('buttons', this.buttons);
    this._loadDir('modals', this.modals);
    this._loadDir('stringMenus', this.menus);
    this._loadDir('userMenus', this.menus);
    this._loadDir('roleMenus', this.menus);
    this._loadDir('channelMenus', this.menus);
  }

  private _loadDir(subdir: string, map: Map<string, InteractionModule>): void {
    const dir = path.join(__dirname, '../interactions', subdir);
    if (!fs.existsSync(dir)) return;
    // Accept .js as well as .ts. With .ts only, a compiled deployment loaded
    // ZERO component handlers, so every verify/panel/backup/record button showed
    // "This interaction failed" with just a debug line in the log. `.d.ts` is
    // excluded because it contains no runtime module. (commands/owner/reload.ts
    // already accepts both extensions.)
    const files = fs.readdirSync(dir).filter(
      (f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.d.ts'),
    );
    for (const file of files) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const raw = require(path.join(dir, file));
        const mod = (raw.default ?? raw) as InteractionModule;
        if (mod.customId && mod.execute) {
          map.set(mod.customId, mod);
          logger.debug(`[InteractionHandler] Loaded ${subdir}/${file} → ${mod.customId}`);
        }
      } catch (err) {
        logger.error(`[InteractionHandler] Failed to load ${subdir}/${file}:`, (err as Error).message);
      }
    }
  }

  async handle(interaction: Interaction): Promise<void> {
    // IS_COMPONENTS_V2 is patched onto the interaction in interactionCreate.ts
    // before this method is called — no need to patch again here.

    let map: Map<string, InteractionModule> | null = null;
    if ((interaction as { isButton?: () => boolean }).isButton?.()) map = this.buttons;
    else if ((interaction as { isModalSubmit?: () => boolean }).isModalSubmit?.()) map = this.modals;
    else if ((interaction as { isAnySelectMenu?: () => boolean }).isAnySelectMenu?.()) map = this.menus;
    if (!map) return;

    const rawId = (interaction as { customId?: string }).customId ?? '';
    let handler = map.get(rawId);
    if (!handler) {
      // Wildcard match, resolved longest-prefix-first so the most specific
      // registration wins instead of whichever the Map happened to yield first.
      const candidates = [...map.entries()]
        .filter(([key]) => key.endsWith(':*'))
        .map(([key, h]) => ({ prefix: key.slice(0, -2), h }))
        .sort((a, b) => b.prefix.length - a.prefix.length);
      handler = candidates.find(({ prefix }) => matchesPrefix(prefix, rawId))?.h;
    }

    if (!handler) {
      // No globally-registered handler for this customId. This is expected
      // for buttons/menus owned by a command's own local
      // msg.createMessageComponentCollector() (help, blackjack, crash,
      // mines, prestige, waifu reroll, etc.) — those are handled by a
      // separate listener the collector attaches directly, not by this
      // router. We must NOT deferUpdate() here: this router's listener is
      // registered at boot (before any collector exists) so it always runs
      // first, and calling deferUpdate() would acknowledge the interaction
      // out from under the collector before its own handler gets to run,
      // breaking the update/edit it was about to perform. Just leave it —
      // if truly orphaned (e.g. bot restarted mid-collector), Discord shows
      // its own "interaction failed" after a few seconds, which is correct.
      logger.debug(`[InteractionHandler] No global handler for "${rawId}" — leaving for a local collector, if any.`);
      return;
    }

    try {
      await handler.execute(interaction, this.client);
    } catch (err) {
      logger.error(`[InteractionHandler] Error handling "${rawId}":`, (err as Error).message);
      logger.debug((err as Error).stack ?? '');
      const msg = {
        content: 'An error occurred processing this interaction.',
        flags: MessageFlags.Ephemeral,
      };
      const i = interaction as unknown as Record<string, unknown>;
      if (i.replied || i.deferred) {
        await (i.followUp as (o: unknown) => Promise<void>)(msg).catch(() => {});
      } else {
        await (i.reply as (o: unknown) => Promise<void>)(msg).catch(() => {});
      }
    }
  }
}
