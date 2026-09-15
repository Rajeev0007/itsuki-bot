/**
 * @file migrate-to-mongo.ts
 * @description Imports the legacy `database/*.json` files into MongoDB.
 *
 *   npm run migrate            # dry run — reports what WOULD happen, writes nothing
 *   npm run migrate -- --write # actually import
 *   npm run migrate -- --write --force
 *                              # also overwrite documents that already exist
 *   npm run migrate -- --write --only=economy,users
 *
 * Dry run is the default on purpose: this touches live data, and the safe
 * outcome should be the one you get by accident.
 *
 * Safe to re-run. Without `--force` existing documents are left alone, so an
 * interrupted import can simply be run again.
 */

import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import { connect, close, getDb } from '../database/Mongo';

const DB_DIR = path.resolve(__dirname, '..', 'database');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const FORCE = argv.includes('--force');
const ONLY = (argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

interface Report {
  store: string;
  keys: number;
  inserted: number;
  skipped: number;
  overwritten: number;
  warnings: string[];
}

async function listStoreFiles(): Promise<string[]> {
  const entries = await fs.readdir(DB_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.replace(/\.json$/, ''))
    .filter((name) => (ONLY.length ? ONLY.includes(name) : true))
    .sort();
}

async function readStoreFile(name: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(DB_DIR, `${name}.json`), 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) return {};

  const parsed = JSON.parse(trimmed);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name}.json does not contain a JSON object at the top level.`);
  }
  return parsed as Record<string, unknown>;
}

async function migrateStore(name: string): Promise<Report> {
  const report: Report = { store: name, keys: 0, inserted: 0, skipped: 0, overwritten: 0, warnings: [] };

  const data = await readStoreFile(name);
  const keys = Object.keys(data);
  report.keys = keys.length;
  if (!keys.length) return report;

  const db = await getDb();
  const col = db.collection(name);

  // Existing ids are fetched up front so the dry run can report accurately
  // without writing, and so the real run needs one query instead of one per key.
  const existing = new Set<string>(
    (await col.find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)),
  );

  const operations: Array<Record<string, unknown>> = [];

  for (const key of keys) {
    // A top-level key containing a dot was already unreachable through the old
    // store, because get()/set() split key paths on dots — worth surfacing
    // rather than importing data nothing can read.
    if (key.includes('.')) {
      report.warnings.push(`key "${key}" contains a dot and will not be reachable via getStore().get()`);
    }
    if (key.startsWith('$')) {
      report.warnings.push(`key "${key}" starts with "$" and was skipped — Mongo reserves that prefix`);
      continue;
    }

    const alreadyThere = existing.has(key);
    if (alreadyThere && !FORCE) { report.skipped++; continue; }
    if (alreadyThere) report.overwritten++; else report.inserted++;

    operations.push({
      replaceOne: {
        filter: { _id: key },
        // The `v` wrapper is the document model MongoStore reads; see its header.
        replacement: { v: data[key] },
        upsert: true,
      },
    });
  }

  if (WRITE && operations.length) {
    // Unordered so one bad document cannot abandon the rest of the batch.
    await col.bulkWrite(operations as never, { ordered: false });
  }

  return report;
}

(async () => {
  console.log(WRITE
    ? `\nImporting database/*.json into MongoDB${FORCE ? ' (overwriting existing documents)' : ''}…`
    : '\nDRY RUN — nothing will be written. Add --write to import.');
  if (ONLY.length) console.log(`Limited to: ${ONLY.join(', ')}`);

  try {
    await connect();
  } catch (err) {
    console.error(`\nCould not reach MongoDB: ${(err as Error).message}`);
    console.error('Set MONGO_URI in your .env first — see .env.example.\n');
    process.exit(1);
  }

  const names = await listStoreFiles();
  if (!names.length) {
    console.log('\nNo JSON store files found — nothing to migrate.\n');
    await close();
    return;
  }

  const reports: Report[] = [];
  let failed = 0;

  for (const name of names) {
    try {
      const report = await migrateStore(name);
      reports.push(report);
    } catch (err) {
      failed++;
      console.error(`  ${name.padEnd(16)} FAILED — ${(err as Error).message}`);
    }
  }

  console.log('');
  console.log(`  ${'store'.padEnd(16)} ${'keys'.padStart(6)} ${'new'.padStart(6)} ${'over'.padStart(6)} ${'skip'.padStart(6)}`);
  console.log(`  ${'-'.repeat(16)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(6)}`);
  for (const r of reports) {
    console.log(`  ${r.store.padEnd(16)} ${String(r.keys).padStart(6)} ${String(r.inserted).padStart(6)} ${String(r.overwritten).padStart(6)} ${String(r.skipped).padStart(6)}`);
  }

  const totals = reports.reduce((acc, r) => ({
    keys: acc.keys + r.keys,
    inserted: acc.inserted + r.inserted,
    overwritten: acc.overwritten + r.overwritten,
    skipped: acc.skipped + r.skipped,
  }), { keys: 0, inserted: 0, overwritten: 0, skipped: 0 });

  console.log(`  ${'-'.repeat(16)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(6)}`);
  console.log(`  ${'total'.padEnd(16)} ${String(totals.keys).padStart(6)} ${String(totals.inserted).padStart(6)} ${String(totals.overwritten).padStart(6)} ${String(totals.skipped).padStart(6)}`);

  const warnings = reports.flatMap((r) => r.warnings.map((w) => `${r.store}: ${w}`));
  if (warnings.length) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }

  if (WRITE) {
    // Verify by counting, rather than trusting the write result.
    console.log('\nVerifying…');
    const db = await getDb();
    let mismatches = 0;
    for (const r of reports) {
      const count = await db.collection(r.store).countDocuments();
      const expected = r.keys;
      const status = count >= expected ? 'ok' : 'MISMATCH';
      if (count < expected) mismatches++;
      console.log(`  ${r.store.padEnd(16)} ${String(count).padStart(6)} document(s) in Mongo vs ${expected} key(s) in JSON — ${status}`);
    }
    console.log(mismatches
      ? `\n${mismatches} collection(s) hold fewer documents than the JSON file. Do NOT delete the JSON files yet.`
      : '\nAll collections match or exceed the JSON key counts.'
        + '\nStart the bot and confirm your data looks right, then delete database/*.json and database/JsonStore.ts.');
  } else {
    console.log('\nRe-run with --write to apply.');
  }

  await close();
  process.exit(failed || 0);
})().catch(async (err) => {
  console.error('\nMigration failed:', (err as Error).message);
  await close().catch(() => {});
  process.exit(1);
});
