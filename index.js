/**
 * Alias entry point.
 *
 * Hosting panels commonly default their "main file" setting to `index.js`, and
 * this project's real entry is `index.ts`, which those panels cannot run
 * directly. This keeps `MAIN_FILE=index.js` working without duplicating the
 * bootstrap logic.
 */
require('./start.js');
