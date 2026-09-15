/**
 * @file CooldownManager.ts
 * @description Per-user, per-command cooldown tracking with in-memory Map.
 */

/**
 * Node's setTimeout stores its delay in a signed 32-bit int. Anything larger
 * overflows, triggers a TimeoutOverflowWarning and fires *immediately* — which
 * would have wiped monthly (30 d) and yearly (365 d) cooldowns on the spot.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

class CooldownManager {
  private _store = new Map<string, number>();

  private _key(userId: string, commandName: string): string {
    return `${userId}:${commandName}`;
  }

  check(userId: string, commandName: string): { onCooldown: boolean; remaining: number } {
    const key     = this._key(userId, commandName);
    const expiry  = this._store.get(key);
    if (!expiry) return { onCooldown: false, remaining: 0 };
    const remaining = expiry - Date.now();
    if (remaining <= 0) {
      this._store.delete(key);
      return { onCooldown: false, remaining: 0 };
    }
    return { onCooldown: true, remaining };
  }

  set(userId: string, commandName: string, durationMs: number): void {
    const duration = Math.max(0, Number(durationMs) || 0);
    const key = this._key(userId, commandName);
    this._store.set(key, Date.now() + duration);

    // Only schedule an eviction timer when the delay actually fits. Longer
    // cooldowns are cleaned up lazily by check()/purge(), which compare the
    // stored expiry rather than relying on a timer.
    if (duration > 0 && duration <= MAX_TIMEOUT_MS) {
      const timer = setTimeout(() => this._store.delete(key), duration);
      // Don't let a pending cooldown timer hold the process open on shutdown.
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  clear(userId: string, commandName: string): void {
    this._store.delete(this._key(userId, commandName));
  }

  purge(): void {
    const now = Date.now();
    for (const [key, expiry] of this._store) {
      if (expiry <= now) this._store.delete(key);
    }
  }
}

export default new CooldownManager();
