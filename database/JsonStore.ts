/**
 * @file JsonStore.ts
 * @description LEGACY file-backed store. Retained only so
 * `scripts/migrate-to-mongo.ts` can read existing data out of `database/*.json`.
 *
 * Nothing in the running bot uses this any more — every consumer imports
 * `getStore` from `database/Store.ts`, which is MongoDB-backed. Do not add new
 * callers: this store keeps each collection wholly in memory and rewrites the
 * entire file on every change, which is what made it slow under load and what
 * allowed an interrupted write to truncate a file.
 *
 * Once the migration has been run and verified, this file and the JSON files can
 * be deleted.
 */

import fs   from 'fs/promises';
import path from 'path';

/**
 * Keys that must never be written through, or a crafted key path could mutate
 * `Object.prototype` for the whole process. Several key paths are built from
 * user-supplied strings (shop item ids, social action names), so writes are
 * validated rather than trusted.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function splitKeyPath(keyPath: string): string[] {
  const parts = String(keyPath).split('.');
  for (const part of parts) {
    if (FORBIDDEN_KEYS.has(part)) {
      throw new Error(`[JsonStore] Refusing to write unsafe key path: "${keyPath}"`);
    }
  }
  return parts;
}

export class JsonStore {
  private _path:    string;
  private _dir:     string;
  private _cache:   Record<string, unknown> | null;
  private _queue:   Promise<void>;
  private _defaults: Record<string, unknown>;
  private _ready:   Promise<void>;

  constructor(filePath: string, defaults: Record<string, unknown> = {}) {
    this._path     = path.resolve(filePath);
    this._dir      = path.dirname(this._path);
    this._cache    = null;
    this._queue    = Promise.resolve();
    this._defaults = defaults;
    this._ready    = this._init();
  }

  private async _init(): Promise<void> {
    try {
      await fs.mkdir(this._dir, { recursive: true });
      try {
        const raw = await fs.readFile(this._path, 'utf8');
        this._cache = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        this._cache = { ...this._defaults };
        await this._writeToDisk(this._cache);
      }
    } catch (err) {
      console.error(`[JsonStore] Init failed for ${this._path}:`, (err as Error).message);
      this._cache = { ...this._defaults };
    }
  }

  private async _ensureReady(): Promise<void> {
    await this._ready;
  }

  private async _writeToDisk(data: Record<string, unknown>): Promise<void> {
    const tmp = `${this._path}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmp, this._path);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* ignore */ }
      throw err;
    }
  }

  private _enqueueWrite(data: Record<string, unknown>): Promise<void> {
    this._queue = this._queue
      .then(() => this._writeToDisk(data))
      .catch((err) => console.error('[JsonStore] Write error:', (err as Error).message));
    return this._queue;
  }

  async get(keyPath?: string, fallback?: unknown): Promise<unknown> {
    await this._ensureReady();
    if (!keyPath) return this._cache;
    const parts = keyPath.split('.');
    let node: unknown = this._cache;
    for (const part of parts) {
      if (node == null || typeof node !== 'object') return fallback;
      node = (node as Record<string, unknown>)[part];
    }
    return node === undefined ? fallback : node;
  }

  async set(keyPath: string, value: unknown): Promise<void> {
    await this._ensureReady();
    const parts = splitKeyPath(keyPath);
    let node = this._cache!;
    for (let i = 0; i < parts.length - 1; i++) {
      if (node[parts[i]] == null || typeof node[parts[i]] !== 'object') {
        node[parts[i]] = {};
      }
      node = node[parts[i]] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
    await this._enqueueWrite(this._cache!);
  }

  async delete(keyPath: string): Promise<void> {
    await this._ensureReady();
    const parts = splitKeyPath(keyPath);
    let node: Record<string, unknown> = this._cache!;
    for (let i = 0; i < parts.length - 1; i++) {
      if (node[parts[i]] == null) return;
      node = node[parts[i]] as Record<string, unknown>;
    }
    delete node[parts[parts.length - 1]];
    await this._enqueueWrite(this._cache!);
  }

  async has(keyPath: string): Promise<boolean> {
    const val = await this.get(keyPath);
    return val !== undefined;
  }

  async ensure(keyPath: string, defaultValue: unknown): Promise<unknown> {
    await this._ensureReady();
    if (!(await this.has(keyPath))) {
      await this.set(keyPath, defaultValue);
      return defaultValue;
    }
    return this.get(keyPath);
  }

  async push(keyPath: string, ...items: unknown[]): Promise<void> {
    await this._ensureReady();
    const arr = ((await this.get(keyPath)) ?? []) as unknown[];
    if (!Array.isArray(arr)) throw new TypeError(`Value at "${keyPath}" is not an array.`);
    arr.push(...items);
    await this.set(keyPath, arr);
  }

  async pull(keyPath: string, filterFn: unknown): Promise<void> {
    await this._ensureReady();
    const arr = ((await this.get(keyPath)) ?? []) as unknown[];
    if (!Array.isArray(arr)) throw new TypeError(`Value at "${keyPath}" is not an array.`);
    const filtered = typeof filterFn === 'function'
      ? arr.filter(filterFn as (item: unknown) => boolean)
      : arr.filter((item) => item !== filterFn);
    await this.set(keyPath, filtered);
  }

  async add(keyPath: string, amount: number): Promise<number> {
    const current = ((await this.get(keyPath)) ?? 0) as number;
    const next    = current + amount;
    await this.set(keyPath, next);
    return next;
  }

  async subtract(keyPath: string, amount: number): Promise<number> {
    return this.add(keyPath, -amount);
  }

  async all(): Promise<Array<[string, unknown]>> {
    await this._ensureReady();
    return Object.entries(this._cache!);
  }

  async filter(predicate: (entry: [string, unknown]) => boolean): Promise<Array<[string, unknown]>> {
    const entries = await this.all();
    return entries.filter(([k, v]) => predicate([k, v]));
  }

  async map<T>(transform: (entry: [string, unknown]) => T): Promise<T[]> {
    const entries = await this.all();
    return entries.map(([k, v]) => transform([k, v]));
  }

  async save(): Promise<void> {
    await this._ensureReady();
    await this._writeToDisk(this._cache!);
  }

  async backup(): Promise<string> {
    await this._ensureReady();
    const backupsDir = path.join(this._dir, 'backups');
    await fs.mkdir(backupsDir, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${path.basename(this._path, '.json')}-${ts}.json`;
    const dest = path.join(backupsDir, name);
    await fs.copyFile(this._path, dest);

    const prefix = path.basename(this._path, '.json');
    const all    = await fs.readdir(backupsDir);
    const mine   = all.filter((f) => f.startsWith(prefix)).sort().reverse();
    for (const old of mine.slice(10)) {
      await fs.unlink(path.join(backupsDir, old)).catch(() => {});
    }
    return dest;
  }
}

/* Singleton Store Registry */
const _instances = new Map<string, JsonStore>();

export function getStore(name: string, defaults: Record<string, unknown> = {}): JsonStore {
  if (!_instances.has(name)) {
    const filePath = path.resolve(__dirname, `${name}.json`);
    _instances.set(name, new JsonStore(filePath, defaults));
  }
  return _instances.get(name)!;
}
