#!/usr/bin/env node
// Entry point. The preflight runs first and before anything touches disk; the CLI (which pulls in
// the sqlite module) is imported only after it passes.
import os from 'node:os';
import { runPreflight } from '../src/preflight.mjs';

const pre = runPreflight();
if (!pre.ok) {
  process.stderr.write(`${pre.msg}\n`);
  process.exit(pre.exit);
}

// The clock seam (plan 01-08): RIGORSCOPE_NOW fixes the clock; an invalid value exits 2 before any state exists.
const { clockFromEnv } = await import('../src/clock.mjs');
let clock;
try {
  clock = clockFromEnv(process.env);
} catch (err) {
  process.stderr.write(`rigorscope: ${err.message}\n`);
  process.exit(2);
}

const { main } = await import('../src/cli.mjs');
process.exitCode = await main(process.argv.slice(2), {
  home: os.homedir(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  now: clock.now,
  clockFixed: clock.fixed,
});
