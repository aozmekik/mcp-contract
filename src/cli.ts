#!/usr/bin/env node
import process from 'node:process';
import { INTERRUPTED_EXIT_CODE, main } from './cli/main.ts';

const controller = new AbortController();
let interrupts = 0;
const onSignal = (): void => {
  interrupts += 1;
  if (interrupts > 1) {
    // A second Ctrl-C means "now": skip graceful cleanup.
    process.exit(INTERRUPTED_EXIT_CODE);
  }
  controller.abort(new Error('Interrupted'));
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  stdoutIsTTY: process.stdout.isTTY,
  signal: controller.signal,
});
process.off('SIGINT', onSignal);
process.off('SIGTERM', onSignal);
