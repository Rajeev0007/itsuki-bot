/**
 * Bootstrap: loads tsx so Node can run the TypeScript sources directly.
 *
 * Start the bot with `npm start` (or `node start.js`).
 *
 * Do NOT start it with ts-node. This project has no ts-node configuration, and
 * a globally installed ts-node cannot resolve the project's own TypeScript,
 * which fails with the very unhelpful:
 *     TypeError: Cannot read properties of undefined (reading 'fileExists')
 * tsx is a normal dependency (not a devDependency) precisely so that this
 * entrypoint keeps working on hosts that install with --omit=dev.
 */

try {
  require('tsx/cjs');
} catch (err) {
  // Without this, a missing node_modules surfaces as a bare MODULE_NOT_FOUND
  // stack trace that says nothing about what to actually do.
  console.error([
    '',
    '  Could not load "tsx", which is what runs this bot\'s TypeScript files.',
    '',
    '  Dependencies are most likely not installed yet. Run:',
    '',
    '      npm install',
    '',
    '  and then start the bot with:',
    '',
    '      npm start',
    '',
    `  Original error: ${err && err.message}`,
    '',
  ].join('\n'));
  process.exit(1);
}

require('./index.ts');
