/**
 * @file MaintenanceManager.ts
 * @description Global maintenance-mode switch. When enabled, every command
 * (slash or prefix) is blocked for everyone except bot owners, with an
 * optional reason shown to the user.
 *
 * Note: this is a global on/off switch, distinct from the static per-command
 * `Command.maintenance` flag (which is set at command-definition time and
 * never changes at runtime). This manager is what /maintenance actually
 * controls live.
 */

import { getStore } from '../database/JsonStore';
import logger       from '../utils/Logger';

interface MaintenanceState {
  enabled: boolean;
  reason:  string | null;
  setBy:   string | null;
  setAt:   number | null;
}

const DEFAULT_STATE: MaintenanceState = { enabled: false, reason: null, setBy: null, setAt: null };

class MaintenanceManager {
  private readonly _db = getStore('maintenance');
  private _state: MaintenanceState = { ...DEFAULT_STATE };
  private _loadPromise: Promise<void>;

  constructor() {
    this._loadPromise = this._load();
  }

  private async _load(): Promise<void> {
    try {
      const raw = (await this._db.get('state')) as Partial<MaintenanceState> | null;
      if (raw && typeof raw === 'object') {
        this._state = { ...DEFAULT_STATE, ...raw };
      }
      logger.debug(`[Maintenance] Loaded state — enabled=${this._state.enabled}`);
    } catch (err) {
      logger.error('[Maintenance] Failed to load maintenance.json:', (err as Error).message);
    }
  }

  async ready(): Promise<void> {
    return this._loadPromise;
  }

  /** Synchronous — safe to call inside messageCreate/interactionCreate. */
  isEnabled(): boolean {
    return this._state.enabled;
  }

  reason(): string | null {
    return this._state.reason;
  }

  async enable(reason: string | null, setBy: string): Promise<void> {
    this._state = { enabled: true, reason, setBy, setAt: Date.now() };
    await this._db.set('state', this._state);
  }

  async disable(): Promise<void> {
    this._state = { ...DEFAULT_STATE };
    await this._db.set('state', this._state);
  }
}

export default new MaintenanceManager();
