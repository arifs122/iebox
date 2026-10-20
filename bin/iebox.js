#!/usr/bin/env node
/**
 * thin wrapper: keep process-level concerns (exit code, EPIPE, signals) here
 * and all logic in src/cli.js.
 */

import { main } from '../src/cli.js';

// Writing to a closed pipe (iebox doctor | head) must not produce a stack trace.
process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') process.exit(0);
});
process.stderr.on('error', () => {});

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = Number.isInteger(code) ? code : 0;
  })
  .catch((error) => {
    process.stderr.write(`iebox: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
