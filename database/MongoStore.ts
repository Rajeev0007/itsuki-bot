/**
 * @file MongoStore.ts
 * @description MongoDB-backed key/value store with the same API the rest of the
 * bot already uses, so no business logic had to change when moving off JSON
 * files.
 *
 * ── Document model ──────────────────────────────────────────────────────────
 * One collection per store, one document per TOP-LEVEL key, with the value
 * always wrapped in a `v` field:
 *
 *     getStore('economy').set('12345.wallet', 500)
 *       -> collection "economy", document { _id: "12345", v: { wallet: 500 } }
 *
 * So a key path maps to a document id plus a field path:
 *     "12345.wallet"  ->  _id "12345", field "v.wallet"
 *
 * The `v` wrapper looks redundant for objects but it is what makes the model
 * uniform: top-level values are not always objects (`maintenance.set('enabled',
 * true)` stores a boolean, other stores hold arrays), and a document cannot have
 * a bare scalar body. Wrapping means scalars, arrays and objects all use one
 * code path instead of three, which matters more than prettier documents.
 *
 * ── Why this is faster and safer than the JSON store ────────────────────────
 * The JSON store held every store fully in memory and rewrote the ENTIRE file
 * on every change through a serialised write queue. That is why it felt slow
 * under load and why an interrupted write could truncate a file. Here each
 * change touches one document, and counters use `$inc` and `$push`, which are
 * atomic server-side — two concurrent `add()` calls can no longer read the same
 * value and overwrite each other, which was a real way to lose or duplicate
 * currency.
 */

import type { Collection, Db } from 'mongodb';
import { promises as fs } from 'fs';
import path from 'path';
import { getDb } from './Mongo';

/** Prototype-pollution guards — a key path must never reach these. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export interface StoreDoc {
  _id: string;
  v: unknown;
}

/** The contract every consumer relies on. */
export interface Store {
  get(keyPath?: string, fallback?: unknown): Promise<unknown>;
  set(keyPath: string, value: unknown): Promise<void>;
  delete(keyPath: string): Promise<void>;
  has(keyPath: string): Promise<boolean>;
  ensure(keyPath: string, defaultValue: unknown): Promise<unknown>;
  push(keyPath: string, ...items: unknown[]): Promise<void>;
  pull(keyPath: string, filterFn: unknown): Promise<void>;
  add(keyPath: string, amount: number): Promise<number>;
  subtract(keyPath: string, amount: number): Promise<number>;
  all(): Promise<Array<[string, unknown]>>;
  filter(predicate: (entry: [string, unknown]) => boolean): Promise<Array<[string, unknown]>>;
  map<T>(transform: (entry: [string, unknown]) => T): Promise<T[]>;
  save(): Promise<void>;
  backup(): Promise<string>;
}

function splitKeyPath(keyPath: string): string[] {
  const parts = String(keyPath ?? '').split('.').filter((p) => p.length > 0);
  for (const part of parts) {
    if (FORBIDDEN_KEYS.has(part)) {
      throw new Error(`[MongoStore] Refusing unsafe key segment "${part}".`);
    }
    // Update operators treat a leading $ as an operator name, so a segment like
    // that would be silently misinterpreted rather than stored.
    if (part.startsWith('$')) {
      throw new Error(`[MongoStore] Key segment "${part}" may not start with "$".`);
    }
  }
  return parts;
}

/** Walks a plain object/array tree, returning undefined on any miss. */
function walk(root: unknown, segments: string[]): unknown {
  let node = root;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Sets a nested value in a plain tree, creating intermediates as objects. */
function assign(root: Record<string, unknown>, segments: string[], value: unknown): void {
  let node = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = value;
}

/**
 * `findOneAndUpdate` returns the document directly in driver v6 but a
 * `{ value }` wrapper in v5. Unwrapping both keeps this working across a
 * dependency bump.
 */
function unwrap(result: unknown): StoreDoc | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { value?: unknown };
  const doc = 'value' in r ? r.value : result;
  return (doc && typeof doc === 'object' ? doc : null) as StoreDoc | null;
}

export class MongoStore implements Store {
  private readonly _name: string;
  private readonly _defaults: Record<string, unknown>;
  private _seeded: Promise<void> | null = null;

  constructor(name: string, defaults: Record<string, unknown> = {}) {
    this._name = name;
    this._defaults = defaults;
  }

  get name(): string {
    return this._name;
  }

  private async _col(): Promise<Collection<StoreDoc>> {
    const db: Db = await getDb();
    const col = db.collection<StoreDoc>(this._name);
    if (Object.keys(this._defaults).length) await this._seedDefaults(col);
    return col;
  }

  /** Inserts any missing default top-level keys, once per process. */
  private _seedDefaults(col: Collection<StoreDoc>): Promise<void> {
    if (this._seeded) return this._seeded;
    this._seeded = (async () => {
      for (const [key, value] of Object.entries(this._defaults)) {
        // $setOnInsert leaves existing documents untouched, so this can never
        // clobber live data on a restart.
        await col.updateOne({ _id: key }, { $setOnInsert: { v: value } }, { upsert: true });
      }
    })();
    this._seeded.catch(() => { this._seeded = null; });
    return this._seeded;
  }

  /** Reads a whole document, mutates it in JS, writes it back. */
  private async _readModifyWrite(id: string, mutate: (value: unknown) => unknown): Promise<void> {
    const col = await this._col();
    const doc = await col.findOne({ _id: id });
    const next = mutate(doc ? doc.v : undefined);
    await col.replaceOne({ _id: id }, { v: next } as never, { upsert: true });
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async get(keyPath?: string, fallback?: unknown): Promise<unknown> {
    const col = await this._col();

    // No key path means "the whole store", which the JSON version returned as a
    // single object. Rebuilt here from every document.
    if (!keyPath) {
      const docs = await col.find({}).toArray();
      const out: Record<string, unknown> = {};
      for (const doc of docs) out[doc._id] = doc.v;
      return out;
    }

    const [id, ...rest] = splitKeyPath(keyPath);
    if (!id) return fallback;

    const doc = await col.findOne({ _id: id });
    if (!doc) return fallback;

    const value = rest.length ? walk(doc.v, rest) : doc.v;
    return value === undefined ? fallback : value;
  }

  async has(keyPath: string): Promise<boolean> {
    return (await this.get(keyPath)) !== undefined;
  }

  async all(): Promise<Array<[string, unknown]>> {
    const col = await this._col();
    const docs = await col.find({}).toArray();
    return docs.map((doc) => [doc._id, doc.v] as [string, unknown]);
  }

  async filter(predicate: (entry: [string, unknown]) => boolean): Promise<Array<[string, unknown]>> {
    // Applied in JS because the predicate is an arbitrary function; it cannot be
    // translated into a Mongo query.
    return (await this.all()).filter(predicate);
  }

  async map<T>(transform: (entry: [string, unknown]) => T): Promise<T[]> {
    return (await this.all()).map(transform);
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  async set(keyPath: string, value: unknown): Promise<void> {
    const segments = splitKeyPath(keyPath);
    if (!segments.length) throw new Error('[MongoStore] set() needs a key path.');

    // JSON.stringify drops undefined values, so under the JSON store setting a
    // key to undefined effectively removed it. Deleting keeps that behaviour
    // rather than storing null, which would read back as a real value.
    if (value === undefined) return this.delete(keyPath);

    const col = await this._col();
    const [id, ...rest] = segments;

    if (!rest.length) {
      await col.replaceOne({ _id: id }, { v: value } as never, { upsert: true });
      return;
    }

    const field = `v.${rest.join('.')}`;
    try {
      await col.updateOne({ _id: id }, { $set: { [field]: value } } as never, { upsert: true });
    } catch (err) {
      // Mongo refuses to create a field inside a non-object ("Cannot create
      // field 'b' in element {a: 5}"), whereas the JSON store simply replaced
      // the scalar with an object. Reproduce that so callers see no difference.
      if (!isPathConflict(err)) throw err;
      await this._readModifyWrite(id, (current) => {
        const root = (current !== null && typeof current === 'object')
          ? current as Record<string, unknown>
          : {};
        assign(root, rest, value);
        return root;
      });
    }
  }

  async delete(keyPath: string): Promise<void> {
    const segments = splitKeyPath(keyPath);
    if (!segments.length) return;

    const col = await this._col();
    const [id, ...rest] = segments;

    if (!rest.length) {
      await col.deleteOne({ _id: id });
      return;
    }
    await col.updateOne({ _id: id }, { $unset: { [`v.${rest.join('.')}`]: '' } } as never);
  }

  async ensure(keyPath: string, defaultValue: unknown): Promise<unknown> {
    const existing = await this.get(keyPath);
    if (existing !== undefined) return existing;
    await this.set(keyPath, defaultValue);
    return defaultValue;
  }

  /**
   * Appends to an array.
   *
   * `$push` is a server-side append, so concurrent pushes no longer overwrite
   * each other the way the previous read-modify-write did.
   */
  async push(keyPath: string, ...items: unknown[]): Promise<void> {
    const segments = splitKeyPath(keyPath);
    if (!segments.length) throw new Error('[MongoStore] push() needs a key path.');

    const col = await this._col();
    const [id, ...rest] = segments;
    const field = rest.length ? `v.${rest.join('.')}` : 'v';

    try {
      await col.updateOne(
        { _id: id },
        { $push: { [field]: { $each: items } } } as never,
        { upsert: true },
      );
    } catch (err) {
      // $push rejects a non-array target. The JSON store threw a TypeError for
      // that, so preserve the error rather than silently converting real data
      // into an array.
      const current = await this.get(keyPath);
      if (current !== undefined && !Array.isArray(current)) {
        throw new TypeError(`Value at "${keyPath}" is not an array.`);
      }
      if (!isPathConflict(err)) throw err;
      await this.set(keyPath, [...((current as unknown[]) ?? []), ...items]);
    }
  }

  /**
   * Removes matching items from an array.
   *
   * NOTE: this intentionally differs from the old JSON implementation, which was
   * self-contradictory — given a function it KEPT the matches
   * (`arr.filter(fn)`), but given a plain value it REMOVED them
   * (`arr.filter(i => i !== value)`). "Pull" means remove, so both forms now
   * remove. Nothing in the codebase called it, so no behaviour in the bot
   * changes.
   */
  async pull(keyPath: string, filterFn: unknown): Promise<void> {
    const current = await this.get(keyPath);
    const arr = (current ?? []) as unknown[];
    if (!Array.isArray(arr)) throw new TypeError(`Value at "${keyPath}" is not an array.`);

    const remaining = typeof filterFn === 'function'
      ? arr.filter((item) => !(filterFn as (i: unknown) => boolean)(item))
      : arr.filter((item) => item !== filterFn);

    await this.set(keyPath, remaining);
  }

  /**
   * Atomically adds to a number and returns the new value.
   *
   * `$inc` happens server-side, which fixes a real lost-update bug: the JSON
   * store read the value, added in JS and wrote it back, so two overlapping
   * payouts could both read the same balance and one would be discarded.
   */
  async add(keyPath: string, amount: number): Promise<number> {
    const segments = splitKeyPath(keyPath);
    if (!segments.length) throw new Error('[MongoStore] add() needs a key path.');
    if (!Number.isFinite(amount)) throw new TypeError(`[MongoStore] add() needs a finite amount, got ${amount}.`);

    const col = await this._col();
    const [id, ...rest] = segments;
    const field = rest.length ? `v.${rest.join('.')}` : 'v';

    try {
      const result = await col.findOneAndUpdate(
        { _id: id },
        { $inc: { [field]: amount } } as never,
        { upsert: true, returnDocument: 'after' },
      );
      const doc = unwrap(result);
      const value = doc ? (rest.length ? walk(doc.v, rest) : doc.v) : undefined;
      // The document is read back rather than assumed so the caller always gets
      // the true post-increment total.
      if (typeof value === 'number') return value;
      return amount;
    } catch (err) {
      if (!isPathConflict(err) && !isNonNumeric(err)) throw err;
      // A non-numeric existing value. The JSON store did `(value ?? 0) + amount`
      // which string-concatenated for "5" + 1 = "51"; coercing to a number is
      // the behaviour that was clearly intended.
      const current = await this.get(keyPath);
      const base = typeof current === 'number' && Number.isFinite(current) ? current : 0;
      const next = base + amount;
      await this.set(keyPath, next);
      return next;
    }
  }

  async subtract(keyPath: string, amount: number): Promise<number> {
    return this.add(keyPath, -amount);
  }

  // ── Compatibility ────────────────────────────────────────────────────────

  /**
   * No-op. Every write is already durable when it resolves; the JSON store
   * needed this to flush its pending write queue.
   */
  async save(): Promise<void> {
    /* nothing to flush */
  }

  /**
   * Exports the collection to a JSON file under `database/backups/`.
   *
   * Kept because the old API had it and it is a useful escape hatch, but note
   * this is a point-in-time export of one collection, not a real backup —
   * `mongodump` is the right tool for that.
   */
  async backup(): Promise<string> {
    const entries = await this.all();
    const data = Object.fromEntries(entries);

    const dir = path.resolve(__dirname, 'backups');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${this._name}-${Date.now()}.json`);
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');

    // Keep only the 5 most recent exports per store so this cannot quietly fill
    // the disk.
    const existing = (await fs.readdir(dir))
      .filter((f) => f.startsWith(`${this._name}-`) && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const stale of existing.slice(5)) {
      await fs.unlink(path.join(dir, stale)).catch(() => {});
    }

    return file;
  }
}

/** "Cannot create field 'x' in element {...}" — a scalar in the middle of a path. */
function isPathConflict(err: unknown): boolean {
  const message = (err as Error)?.message ?? '';
  return /cannot create field|not a document|path.*conflict|traverse.*element/i.test(message);
}

/** "Cannot apply $inc to a value of non-numeric type". */
function isNonNumeric(err: unknown): boolean {
  const message = (err as Error)?.message ?? '';
  return /non-numeric|\$inc/i.test(message);
}

export default MongoStore;
