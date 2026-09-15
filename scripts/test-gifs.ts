/**
 * @file test-gifs.ts
 * @description Standalone check that the roleplay GIF pipeline actually works.
 *
 * Run:  npx tsx scripts/test-gifs.ts
 *
 * This hits the real GIF APIs (OtakuGIFs → Gifukai → nekos.best) through the
 * same GifService the /hug, /kiss, /bonk … commands use, so a pass here means
 * the commands will render a GIF. No Discord token or gateway connection needed.
 *
 * It also reports which provider served each action, and verifies the GIF URL
 * is directly accessible (no Cloudflare blocking) by Discord's image proxy.
 */

import GifService from '../services/GifService';
import axios from 'axios';

/** The ten roleplay commands, matching commands/social/*.ts */
const ROLEPLAY_ACTIONS = [
  'hug', 'kiss', 'pat', 'slap', 'cuddle',
  'bonk', 'poke', 'wave', 'dance', 'cry',
];

interface Row { action: string; ok: boolean; url: string | null; accessible: boolean; ms: number }

async function main(): Promise<void> {
  console.log(`\nTesting ${ROLEPLAY_ACTIONS.length} roleplay actions against GIF providers…\n`);

  const rows: Row[] = [];
  for (const action of ROLEPLAY_ACTIONS) {
    const started = Date.now();
    let url: string | null = null;
    let accessible = false;
    try {
      url = await GifService.getGif(action);
      // Verify the GIF URL is directly fetchable (no Cloudflare challenge)
      if (url) {
        try {
          const head = await axios.head(url, { timeout: 5000 });
          accessible = head.status === 200;
        } catch {
          accessible = false;
        }
      }
    } catch (err) {
      console.error(`  ${action}: threw — ${(err as Error).message}`);
    }
    const ms = Date.now() - started;
    rows.push({ action, ok: Boolean(url), url, accessible, ms });

    const status = url ? (accessible ? 'OK  ' : 'WARN') : 'FAIL';
    const note = url && !accessible ? ' (URL blocked — Discord won\'t render it!)' : '';
    console.log(`  [${status}] ${action.padEnd(8)} ${String(ms).padStart(5)}ms  ${url ?? '(no GIF returned)'}${note}`);
  }

  const passed = rows.filter((r) => r.ok && r.accessible).length;
  const failed = rows.filter((r) => !r.ok);
  const blocked = rows.filter((r) => r.ok && !r.accessible);

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${passed}/${rows.length} actions returned a working GIF URL.`);

  // A URL that isn't an image/gif would render as a broken embed in Discord.
  const suspicious = rows.filter((r) => r.url && !/\.(gif|png|jpe?g|webp)(\?|$)/i.test(r.url));
  if (suspicious.length) {
    console.log(`\nWarning — these URLs don't look like images, so Discord may not render them:`);
    for (const r of suspicious) console.log(`  ${r.action}: ${r.url}`);
  }

  if (blocked.length) {
    console.log(`\nBlocked by Cloudflare: ${blocked.map((r) => r.action).join(', ')}`);
    console.log('Discord\'s image proxy will NOT be able to fetch these GIFs.');
    console.log('The MediaGallery component will render empty.');
  }

  if (failed.length) {
    console.log(`\nFailed: ${failed.map((r) => r.action).join(', ')}`);
    console.log('Those commands will still post, just without a GIF.');
    process.exitCode = 1;
  } else if (blocked.length) {
    console.log('\nSome GIFs will not render in Discord due to Cloudflare blocking.');
    process.exitCode = 1;
  } else {
    console.log('\nAll roleplay commands will render a GIF. ✅');
  }
  console.log('');
}

main().catch((err) => {
  console.error('\nTest run failed outright:', (err as Error).message);
  process.exitCode = 1;
});
