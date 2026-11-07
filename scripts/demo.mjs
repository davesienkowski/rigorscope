#!/usr/bin/env node
// `npm run demo`: builds the synthetic public demo fixture (test/fixtures/public-demo) into a temporary directory, runs
// the real CLI over it, prints each command with its output, and checks the numbers against the known answers in
// expected.json. It builds its own minimal child environment and never reads the caller's: no inherited variable
// (a config directory, repository roots, a receiver directory, any RIGORSCOPE_ variable) can point the run at real data.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPublicDemo } from '../test/fixtures/public-demo/build.mjs';
import { check, collect } from '../test/fixtures/public-demo/compare.mjs';

const BIN = fileURLToPath(new URL('../bin/rigorscope.mjs', import.meta.url));
const EXPECTED = fileURLToPath(new URL('../test/fixtures/public-demo/expected.json', import.meta.url));
const SINCE = ['--since', '2026-10-01', '--until', '2026-10-07'];

const dir = mkdtempSync(join(tmpdir(), 'rigorscope-demo-'));
let exitCode = 0;
try {
  const built = buildPublicDemo({ dir });
  // Only these variables reach the child. The Windows users directory is set empty so a WSL machine's own Windows
  // transcripts are not discovered.
  const env = {
    PATH: process.env.PATH ?? '', HOME: built.home, LANG: 'C.UTF-8', TZ: 'UTC', RIGORSCOPE_WINDOWS_USERS_DIR: '',
  };
  const run = (args, { show = true } = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', cwd: dir });
    if (r.status !== 0) throw new Error(`rigorscope ${args[0]} exited ${r.status}\n${r.stderr}`);
    if (show) process.stdout.write(`$ rigorscope ${args.join(' ')}\n${r.stdout}\n`);
    return r.stdout;
  };
  process.stdout.write('Synthetic demo: a temporary repository with four units and five transcript calls, all built by code.\n\n');
  const ingest = (label) => {
    process.stdout.write(`${label}\n`);
    const out = run(['ingest'], { show: false });
    process.stdout.write(`$ rigorscope ingest\n${out.split('\n').filter((l) => /^(transcript|locations|units):/.test(l)).join('\n')}\n\n`);
  };
  ingest('First ingest: all four units are in their live directories.');
  built.archive();
  ingest('One unit was moved into a milestone archive and a later milestone reused its id. Ingest again:');
  run(['units']);
  run(['cost', ...SINCE, '--by', 'unit']);
  const units = JSON.parse(run(['units', '--json'], { show: false }));
  const cost = JSON.parse(run(['cost', ...SINCE, '--by', 'role', '--json'], { show: false }));
  const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));
  const result = check(expected, collect({ units, cost }));
  process.stdout.write(`Known answers (test/fixtures/public-demo/expected.json): ${result.compared - result.mismatches.length} of ${result.declared} match.\n`);
  process.stdout.write('Catch, escape and rework print "unavailable": they are not computed.\n');
  if (!result.ok) {
    process.stdout.write(`MISMATCH in ${result.mismatches.length} values.\n`);
    exitCode = 1;
  }
} catch (err) {
  process.stderr.write(`demo failed: ${err.message}\n`);
  exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
