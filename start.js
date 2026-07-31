/**
 * Entry point. Loads a TypeScript runtime, then hands off to index.ts.
 *
 * This file is deliberately plain JavaScript so it can be launched three ways,
 * because game-panel eggs differ in how they start a Node app:
 *
 *   node start.js          -> registers tsx, then runs index.ts
 *   node index.js          -> index.js just delegates here
 *   ts-node start.js       -> ts-node has already hooked require('.ts'),
 *                             so this skips tsx and hands straight over
 *
 * The Pterodactyl-style Node egg ends with:
 *     if [[ "${MAIN_FILE}" == "*.js" ]]; then node ...; else ts-node ...; fi
 * The pattern is quoted, which makes it a literal string test that never
 * matches, so every MAIN_FILE value falls through to ts-node. Supporting that
 * path is therefore not optional.
 */

// Registering two TypeScript require hooks makes them fight over '.ts' and
// produces very confusing double-transform errors, so only register tsx when
// nothing else has claimed the extension (ts-node, tsx, swc-node, …).
const alreadyHooked = typeof require.extensions === 'object'
  && Boolean(require.extensions['.ts']);

if (!alreadyHooked) {
  try {
    require('tsx/cjs');
  } catch (err) {
    // Without this, a missing node_modules surfaces as a bare MODULE_NOT_FOUND
    // stack trace that says nothing about what to actually do.
    console.error([
      '',
      '  Could not load a TypeScript runtime, so the bot cannot start.',
      '',
      '  Dependencies are most likely not installed. Run:',
      '',
      '      npm install',
      '',
      '  then start the bot with:',
      '',
      '      npm start',
      '',
      `  Original error: ${err && err.message}`,
      '',
    ].join('\n'));
    process.exit(1);
  }
}

require('./index.ts');
