/**
 * @file test-gifs.ts
 * @description Standalone check that the roleplay GIF pipeline actually works.
 *
 * Run:  npx tsx scripts/test-gifs.ts
 *
 * Hits the real nekos.best API through the same GifService the action commands
 * use, so a pass here means the commands will render a GIF. No Discord token or
 * gateway connection needed.
 *
 * It reports, per action, which CATEGORY the GIF actually came from — which is
 * how you confirm an action is showing its own reaction rather than a declared
 * substitute. Any row marked SUBSTITUTED is a category that does not exist
 * upstream; any row marked MISSING will post without a GIF.
 */

import GifService from '../services/GifService';
import { ACTIONS } from '../config/actions';

interface Row {
  action: string;
  declared: string;
  got: string | null;
  url: string | null;
  substituted: boolean;
  ms: number;
}

async function main(): Promise<void> {
  console.log('\nLoading the nekos.best category catalogue…');
  const categories = await GifService.categories();
  console.log(`  ${categories.length} live categories.\n`);

  // Every declared category is checked against the live catalogue first. This is
  // the check that would have caught /bonk pointing at a category that does not
  // exist, before any user ever saw the wrong GIF.
  const missingCategories = ACTIONS
    .filter((a) => !categories.includes(a.category))
    .map((a) => `${a.name} -> ${a.category}${a.fallbacks?.length ? ` (falls back to ${a.fallbacks.join(', ')})` : ' (NO FALLBACK)'}`);

  if (missingCategories.length) {
    console.log('Actions whose category is not in the live catalogue:');
    for (const line of missingCategories) console.log(`  ${line}`);
    console.log('');
  }

  console.log(`Fetching a GIF for each of ${ACTIONS.length} actions…\n`);
  const rows: Row[] = [];
  for (const action of ACTIONS) {
    const started = Date.now();
    let got: string | null = null;
    let url: string | null = null;
    let substituted = false;
    try {
      const result = await GifService.resolve(action.category, action.fallbacks ?? []);
      url = result.url;
      got = result.category;
      substituted = result.substituted;
    } catch (err) {
      console.error(`  ${action.name}: threw — ${(err as Error).message}`);
    }
    const ms = Date.now() - started;
    rows.push({ action: action.name, declared: action.category, got, url, substituted, ms });

    const status = !url ? 'MISSING     ' : substituted ? 'SUBSTITUTED ' : 'OK          ';
    console.log(
      `  [${status}] ${action.name.padEnd(9)} category=${String(got ?? '-').padEnd(9)} ${String(ms).padStart(5)}ms  ${url ?? '(none)'}`,
    );
  }

  const ok = rows.filter((r) => r.url && !r.substituted);
  const subbed = rows.filter((r) => r.substituted);
  const missing = rows.filter((r) => !r.url);

  console.log(`\n${'-'.repeat(72)}`);
  console.log(`${ok.length}/${rows.length} actions returned a GIF from their OWN category.`);
  if (subbed.length) {
    console.log(`\n${subbed.length} used a declared substitute:`);
    for (const r of subbed) console.log(`  ${r.action}: wanted "${r.declared}", used "${r.got}"`);
    console.log('  These are intentional (declared in config/actions.ts) but the GIF is not');
    console.log('  literally the action. Remove the action or find a better category to fix.');
  }
  if (missing.length) {
    console.log(`\n${missing.length} returned nothing and will post without a GIF:`);
    for (const r of missing) console.log(`  ${r.action} (category "${r.declared}")`);
    process.exitCode = 1;
  }

  // Pool state proves the batching is working: after one call per action each
  // category should hold the rest of its batch, so repeat use costs no requests.
  const state = GifService._state();
  console.log(`\nPooled batches: ${state.pooled.length} categories holding ${state.pooled.reduce((n, p) => n + p.remaining, 0)} ready GIFs.`);
  if (state.cooldowns.length) {
    console.log(`Cooling down: ${state.cooldowns.map((c) => `${c.category} (${Math.ceil(c.msLeft / 1000)}s)`).join(', ')}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error('\nTest run failed outright:', (err as Error).message);
  process.exitCode = 1;
});
