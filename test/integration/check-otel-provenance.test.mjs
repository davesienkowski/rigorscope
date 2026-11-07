// Plan 01-14 Task 1 (D-16, RR-01, DATA-03): the generic read-only OTel provenance check
// scripts/check-otel-provenance.mjs. Written before the script. Every run is a child process over a synthetic HOME
// (makeHome: its name holds a space and a hash character) with the allowlisted environment of cliEnv, never the real
// HOME. The store is built by an ordinary spawned `rigorscope ingest` over the OTel fixture tree; the stale-row case
// adds one provenance row with a read-write open of src/db.mjs before the script runs.
//
// Every test asserts the exit status of the script, so with the script absent each one fails on an assertion about
// the run, not on an import.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/db.mjs';
import { REPO, cliEnv, makeHome, runCli, sha256, stateDirOf } from '../fixtures/build.mjs';
import { SA, buildOtelTree } from '../fixtures/otel.mjs';

const SCRIPT = join(REPO, 'scripts', 'check-otel-provenance.mjs');
const ROOT_LINE = /^([a-z][a-z0-9-]*): compared (\d+) equal (\d+) differing (\d+) missing (\d+)$/;

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function freshHome() {
  const ctx = makeHome();
  cleanups.push(ctx.cleanup);
  return ctx.home;
}

// A HOME with the live OTel directory (one events file, one metrics file whose nine lines hold a byte-identical
// pair), ingested once through the spawned CLI.
function ingestedHome() {
  const home = freshHome();
  const tree = buildOtelTree(home, { preserve: false });
  const r = runCli(['ingest'], { home });
  assert.equal(r.status, 0, r.stderr);
  return { home, tree };
}

// Runs the script as a child. Every run, failing ones included, must keep the HOME path and the fixture's file
// names and session id out of its output.
function check(home, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO, env: cliEnv(home), encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
  });
  if (r.signal || r.error) throw new Error(`script child failed: signal=${r.signal} error=${r.error?.code ?? null}`);
  for (const stream of [r.stdout, r.stderr]) {
    assert.ok(!stream.includes(home), 'no HOME path in the output');
    assert.ok(!stream.includes(tmpdir() + '/'), 'no temp-dir path in the output');
    assert.ok(!/(events|metrics)-\d{4}-\d{2}-\d{2}/.test(stream), 'no OTel file name in the output');
    assert.ok(!stream.includes(SA), 'no session id in the output');
  }
  return r;
}

const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const rootLines = (text) => Object.fromEntries(linesOf(text).map((l) => ROOT_LINE.exec(l)).filter(Boolean)
  .map((m) => [m[1], { compared: +m[2], equal: +m[3], differing: +m[4], missing: +m[5] }]));

describe('check-otel-provenance', () => {
  it('a freshly ingested store compares every OTel file of the root as equal and exits 0', () => {
    const { home } = ingestedHome();
    const r = check(home);
    assert.equal(r.status, 0, r.stderr);
    const roots = rootLines(r.stdout);
    assert.deepEqual(roots.live, { compared: 2, equal: 2, differing: 0, missing: 0 });
    assert.deepEqual(roots.total, { compared: 2, equal: 2, differing: 0, missing: 0 });
  });

  it('a planted stale provenance row (an offset that is not a line end) is reported as 1 differing file, exit 1', () => {
    const { home } = ingestedHome();
    const db = openStore({ home });
    try {
      const { file_id: fileId } = db.prepare(
        `SELECT f.file_id FROM source_file f JOIN source_root r ON r.root_id = f.root_id
          WHERE r.source = 'otel' AND f.kind = 'metrics'`,
      ).get();
      db.prepare(
        `INSERT INTO otel_metric_line (file_id, src_end_offset, ts_utc, metric, attrs_sha)
         VALUES (?, 1, '2026-10-27T12:00:01.000Z', 'claude_code.cost.usage', ?)`,
      ).run(fileId, 'f'.repeat(64));
    } finally {
      db.close();
    }
    const r = check(home);
    assert.equal(r.status, 1, r.stderr);
    const roots = rootLines(r.stdout);
    assert.deepEqual(roots.live, { compared: 2, equal: 1, differing: 1, missing: 0 });
    assert.deepEqual(roots.total, { compared: 2, equal: 1, differing: 1, missing: 0 });
  });

  it('a metrics file deleted after the ingest is reported as missing, not differing, exit 0', () => {
    const { home, tree } = ingestedHome();
    rmSync(tree.files.liveMetrics);
    const r = check(home);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(rootLines(r.stdout).live, { compared: 1, equal: 1, differing: 0, missing: 1 });
  });

  it('a HOME with no store prints one line, creates no state directory and exits 0', () => {
    const home = freshHome();
    buildOtelTree(home, { preserve: false });
    const r = check(home);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(linesOf(r.stdout).length, 1);
    assert.match(r.stdout, /no store/);
    assert.equal(existsSync(stateDirOf(home)), false, 'no state directory was created');
  });

  it('an unknown option exits 2 with a usage line', () => {
    const home = freshHome();
    const r = check(home, ['--frobnicate']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^usage: node scripts\/check-otel-provenance\.mjs/m);
  });

  it('--home selects the HOME to check (the environment HOME is not used then)', () => {
    const { home } = ingestedHome();
    const empty = freshHome();
    const r = spawnSync(process.execPath, [SCRIPT, '--home', home], {
      cwd: REPO, env: cliEnv(empty), encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(home), 'no HOME path in the output');
    assert.deepEqual(rootLines(r.stdout).live, { compared: 2, equal: 2, differing: 0, missing: 0 });
  });

  it('never writes: store.db is byte-identical, a sidecar that existed is unchanged, no lock file appears', () => {
    const { home } = ingestedHome();
    const dir = stateDirOf(home);
    const sidecars = ['store.db-wal', 'store.db-shm'];
    const before = { store: sha256(readFileSync(join(dir, 'store.db'))) };
    for (const s of sidecars) before[s] = existsSync(join(dir, s)) ? sha256(readFileSync(join(dir, s))) : null;
    const r = check(home);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(sha256(readFileSync(join(dir, 'store.db'))), before.store, 'store.db unchanged');
    // A read-only connection to a WAL store may leave EMPTY -wal and -shm files where none existed (documented in
    // docs/operations.md); a sidecar that existed before must be byte-identical, and a new one must be empty.
    for (const s of sidecars) {
      const p = join(dir, s);
      if (before[s] !== null) assert.equal(sha256(readFileSync(p)), before[s], `${s} unchanged`);
      else if (existsSync(p) && s === 'store.db-wal') assert.equal(statSync(p).size, 0, `${s} is empty`);
    }
    assert.equal(existsSync(join(dir, 'ingest.lock')), false, 'no lock file');
    assert.equal(existsSync(join(dir, 'derived.db')), false, 'no derived.db built');
  });
});
