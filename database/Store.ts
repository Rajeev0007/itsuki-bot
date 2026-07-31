/**
 * @file Store.ts
 * @description The one place the bot gets a data store from.
 *
 * Every consumer imports `getStore` from here and nothing else, which is what
 * made swapping the JSON files for MongoDB a change to this directory only —
 * none of the 31 managers and commands that use it needed touching.
 *
 * Named `Store` rather than `index` so the import path is explicit and does not
 * rely on directory-index resolution.
 */

import { MongoStore, type Store } from './MongoStore';

export type { Store, StoreDoc } from './MongoStore';
export { MongoStore } from './MongoStore';

/**
 * One store instance per collection name.
 *
 * Shared deliberately: a store carries the once-per-process defaults seeding, so
 * handing out a fresh instance per call would repeat that work and make the
 * guard useless.
 */
const registry = new Map<string, Store>();

/**
 * Returns the store for a collection, creating it on first use.
 *
 * Does NOT connect — stores are built at module load, long before a connection
 * exists. Each method awaits the shared connection instead, so this is safe to
 * call at the top level of any file.
 *
 * @param name      Collection name, e.g. `economy`. Also the old JSON filename.
 * @param defaults  Top-level keys to insert if absent. Existing data is never
 *                  overwritten.
 */
export function getStore(name: string, defaults: Record<string, unknown> = {}): Store {
  const existing = registry.get(name);
  if (existing) return existing;

  const store = new MongoStore(name, defaults);
  registry.set(name, store);
  return store;
}

/** Every store created so far. Used by the migration script and diagnostics. */
export function knownStores(): string[] {
  return [...registry.keys()].sort();
}

export default { getStore, knownStores };
