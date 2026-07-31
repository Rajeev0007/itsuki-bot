/**
 * @file test-gifs.ts
 * @description Standalone check that the roleplay GIF pipeline actually works.
 *
 * Run:  npx tsx scripts/test-gifs.ts
 *
 * This hits the real nekos.best API through the same GifService the /hug,
 * /kiss, /bonk … commands use, so a pass here means the commands will render a
 * GIF. No Discord token or gateway connection needed.
 *
 * It also reports which endpoint each action resolved through, which is how you
 * can tell whether `bonk` exists upstream or fell back to `punch`.
 */

import GifService from '../services/GifService';

/** The ten roleplay commands, matching commands/social/*.ts */
const ROLEPLAY_ACTIONS = [
  'hug', 'kiss', 'pat', 'slap', 'cuddle',
  'bonk', 'poke', 'wave', 'dance', 'cry',
];

interface Row { action: string; ok: boolean; url: string | null; ms: number }

async function main(): Promise<void> {
  console.log(`\nTesting ${ROLEPLAY_ACTIONS.length} roleplay actions against nekos.best…\n`);

  const rows: Row[] = [];
  for (const action of ROLEPLAY_ACTIONS) {
    const started = Date.now();
    let url: string | null = null;
    try {
      url = await GifService.getGif(action);
    } catch (err) {
      console.error(`  ${action}: threw — ${(err as Error).message}`);
    }
    const ms = Date.now() - started;
    rows.push({ action, ok: Boolean(url), url, ms });

    const status = url ? 'OK  ' : 'FAIL';
    console.log(`  [${status}] ${action.padEnd(8)} ${String(ms).padStart(5)}ms  ${url ?? '(no GIF returned)'}`);
  }

  const passed = rows.filter((r) => r.ok).length;
  const failed = rows.filter((r) => !r.ok);

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${passed}/${rows.length} actions returned a GIF URL.`);

  // A URL that isn't an image/gif would render as a broken embed in Discord.
  const suspicious = rows.filter((r) => r.url && !/\.(gif|png|jpe?g|webp)(\?|$)/i.test(r.url));
  if (suspicious.length) {
    console.log(`\nWarning — these URLs don't look like images, so Discord may not render them:`);
    for (const r of suspicious) console.log(`  ${r.action}: ${r.url}`);
  }

  if (failed.length) {
    console.log(`\nFailed: ${failed.map((r) => r.action).join(', ')}`);
    console.log('Those commands will still post, just without a GIF.');
    console.log('Check the log lines above: a 404 means the endpoint does not exist');
    console.log('upstream (add a fallback in ACTION_ENDPOINTS in services/GifService.ts);');
    console.log('anything else usually means a network or rate-limit problem.');
    process.exitCode = 1;
  } else {
    console.log('\nAll roleplay commands will render a GIF.');
  }
  console.log('');
}

main().catch((err) => {
  console.error('\nTest run failed outright:', (err as Error).message);
  process.exitCode = 1;
});
