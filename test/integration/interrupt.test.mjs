// Interrupting a real ingest (plan 01-11, WR-01, D-13, RR-01, DATA-03, DATA-04). A SIGTERM or SIGINT sent to
// a running `rigorscope ingest` is honored at the next chunk boundary: exit 143 (130), no lock file, the run
// row `failed` with the signal name, every committed chunk whole, and a following run ends equal to an
// uninterrupted run over the same tree. The spawned tests use a raw spawn (not runCli) so the child can be
// signalled while it runs; the boundary tests drive runIngest in process through its `stop` seam
// (lock: false), counting committed chunks through beforeCommit.
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BIN, REPO, cliEnv, makeAssistant, makeHome, makeUsage, queryDb, runCli, sha256, stateDirOf, storeDigest,
  windowsUsersDirFor, writeJsonl,
} from '../fixtures/build.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const STORE = (home) => join(stateDirOf(home), 'store.db');
const LOCK = (home) => join(stateDirOf(home), 'ingest.lock');

// Many small files: every file ends with a committed chunk, so the files are the chunk boundaries the
// signal can land on. The signal is due after 10 of 100 files, so the child has about nine tenths of its run
// left to receive it; if the child finishes before the signal is due the test fails and says the fixture is
// too small.
const FILES = 100;
const LINES = 30;
const SIGNAL_AFTER_FILES = 10;
const POLL_MS = 5;
const POLL_LIMIT_MS = 60_000;
// A fixed project directory name and no cwd field, so the stored rows do not depend on the HOME path and
// two HOMEs built from the same tree are comparable.
const PROJECT = '-fixture-interrupt-work';

const ts = (i) => `2026-10-27T12:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;

function buildTree(root, { files = FILES, lines = LINES } = {}) {
  const proj = join(root, 'projects', PROJECT);
  for (let f = 0; f < files; f += 1) {
    const session = `sess-int-${String(f).padStart(4, '0')}`;
    const out = [];
    for (let i = 0; i < lines; i += 1) {
      out.push(JSON.stringify(makeAssistant({
        session, ts: ts(i), id: `msg_int_${f}_${i}`, model: 'claude-opus-5-5',
        use: makeUsage({ input: 1 + i, output: 2, read: 3, creation: 4 }),
      })));
    }
    writeJsonl(join(proj, `${session}.jsonl`), out);
  }
}

function home(opts) {
  const ctx = makeHome();
  buildTree(ctx.root, opts);
  return ctx;
}

// Natural-key digest: storeDigest (cc_message keys and tokens) plus the source_file rows (alias, path, kind,
// state, offset). Run-log tables are excluded: they grow with every run.
function digest(h) {
  const files = queryDb(STORE(h), `SELECT r.alias, f.rel_path, f.kind, f.state, f.offset FROM source_file f
                                     JOIN source_root r ON r.root_id = f.root_id ORDER BY 1, 2`);
  return { message: storeDigest(h), files: files.length, fileDigest: sha256(JSON.stringify(files)) };
}

const lastRun = (h) => queryDb(STORE(h), 'SELECT status, error_code FROM ingest_run ORDER BY run_id DESC LIMIT 1')[0];
const runCount = (h) => queryDb(STORE(h), 'SELECT count(*) AS n FROM ingest_run')[0].n;

function okFiles(h) {
  try {
    return queryDb(STORE(h), "SELECT count(*) AS n FROM source_file WHERE state = 'ok'")[0].n;
  } catch {
    return 0; // the store or the table does not exist yet
  }
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Spawns `rigorscope ingest`, waits until SIGNAL_AFTER_FILES files are committed, sends `signal`, and resolves
// with the exit code, the exit signal and stderr.
async function interrupt(h, signal) {
  const child = spawn(process.execPath, [BIN, 'ingest'], { cwd: REPO, env: cliEnv(h) });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.resume();
  const exited = new Promise((resolve) => { child.on('exit', (code, sig) => resolve({ code, sig })); });
  const t0 = Date.now();
  while (okFiles(h) < SIGNAL_AFTER_FILES) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (Date.now() - t0 > POLL_LIMIT_MS) { child.kill('SIGKILL'); throw new Error('the ingest did not commit any file in time'); }
    await sleep(POLL_MS);
  }
  assert.ok(
    child.exitCode === null && child.signalCode === null,
    'the fixture is too small: the ingest finished before the signal was due (enlarge the fixture, never loosen this)',
  );
  child.kill(signal);
  const { code, sig } = await exited;
  // stdout is drained; give the stderr stream its close.
  await new Promise((r) => { if (child.stderr.closed) r(); else child.stderr.on('close', r); });
  return { code, sig, stderr };
}

const wantLine = (signal) => `rigorscope: interrupted by ${signal}; committed chunks are kept, the next run resumes\n`;

describe('a real signal stops a real multi-file ingest at a committed boundary', () => {
  let base;
  let term;
  let baseline;

  before(() => {
    base = home();
    const r = runCli(['ingest'], { home: base.home });
    assert.equal(r.status, 0, 'the uninterrupted baseline ingest failed');
    baseline = digest(base.home);
    assert.equal(baseline.files, FILES);
    term = home();
  });

  after(() => {
    base?.cleanup();
    term?.cleanup();
  });

  it('SIGTERM during ingest exits 143 with no lock, a failed run row and a whole store', async () => {
    const r = await interrupt(term.home, 'SIGTERM');
    assert.equal(r.sig, null, 'the child must exit by itself, not be killed by the signal');
    assert.equal(r.code, 143);
    assert.equal(existsSync(LOCK(term.home)), false, 'the lock file is gone');
    assert.deepEqual(lastRun(term.home), { status: 'failed', error_code: 'SIGTERM' });
    assert.deepEqual(queryDb(STORE(term.home), 'PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
    assert.deepEqual(queryDb(STORE(term.home), 'PRAGMA foreign_key_check'), []);
    assert.equal(r.stderr, wantLine('SIGTERM'));
    const partial = digest(term.home);
    assert.ok(partial.files >= SIGNAL_AFTER_FILES && partial.files < FILES, 'the run stopped part way');
  });

  it('a resumed run exits 0 and equals an uninterrupted run over the same tree', () => {
    const r = runCli(['ingest'], { home: term.home });
    assert.equal(r.status, 0, 'the resumed ingest failed');
    assert.equal(lastRun(term.home).status, 'ok');
    assert.deepEqual(digest(term.home), baseline);
  });

  it('a third run reads 0 bytes and changes no natural-key table; only the run log grows', () => {
    const before3 = digest(term.home);
    const runs = runCount(term.home);
    const r = runCli(['ingest'], { home: term.home });
    assert.equal(r.status, 0, 'the third ingest failed');
    const [src] = queryDb(STORE(term.home), "SELECT bytes_read FROM ingest_source_run WHERE source = 'transcript' ORDER BY run_id DESC LIMIT 1");
    assert.equal(src.bytes_read, 0);
    assert.deepEqual(digest(term.home), before3);
    assert.equal(runCount(term.home), runs + 1);
  });

  it('SIGINT during ingest exits 130 with no lock and a failed run row, and resumes to the same store', async () => {
    const ctx = home();
    try {
      const r = await interrupt(ctx.home, 'SIGINT');
      assert.equal(r.sig, null, 'the child must exit by itself, not be killed by the signal');
      assert.equal(r.code, 130);
      assert.equal(existsSync(LOCK(ctx.home)), false, 'the lock file is gone');
      assert.deepEqual(lastRun(ctx.home), { status: 'failed', error_code: 'SIGINT' });
      assert.deepEqual(queryDb(STORE(ctx.home), 'PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
      assert.equal(r.stderr, wantLine('SIGINT'));
      assert.equal(runCli(['ingest'], { home: ctx.home }).status, 0, 'the resumed ingest failed');
      assert.deepEqual(digest(ctx.home), baseline);
    } finally {
      ctx.cleanup();
    }
  });
});

// In process, deterministic: the stop seam reports a signal once K chunks have been committed. Small files with
// chunkLines 2 make several chunks per file, so the in-loop flush is a boundary too.
describe('stop at chosen chunk boundaries (in process)', () => {
  const SMALL = { files: 12, lines: 5 };
  const opts = (h, extra = {}) => ({
    home: h, env: { HOME: h }, windowsUsersDir: windowsUsersDirFor(h), lock: false, chunkLines: 2, ...extra,
  });
  let ref;
  let refDigest;
  let total;

  before(async () => {
    const { runIngest } = await mod('ingest/run.mjs');
    ref = home(SMALL);
    total = 0;
    await runIngest(opts(ref.home, { beforeCommit: () => { total += 1; } }));
    refDigest = digest(ref.home);
    assert.ok(total > 3, 'the small fixture has several chunks');
  });

  after(() => ref?.cleanup());

  async function stopAfter(k) {
    const { runIngest } = await mod('ingest/run.mjs');
    const ctx = home(SMALL);
    try {
      let committed = 0;
      await assert.rejects(
        runIngest(opts(ctx.home, { beforeCommit: () => { committed += 1; }, stop: () => (committed >= k ? 'SIGTERM' : null) })),
        (err) => err.name === 'InterruptError' && err.code === 'SIGTERM' && err.exitCode === 143,
      );
      assert.equal(committed, k, 'the run stopped at the first boundary after chunk k');
      assert.deepEqual(lastRun(ctx.home), { status: 'failed', error_code: 'SIGTERM' });
      assert.deepEqual(queryDb(STORE(ctx.home), 'PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
      assert.deepEqual(queryDb(STORE(ctx.home), 'PRAGMA foreign_key_check'), []);
      await runIngest(opts(ctx.home));
      assert.equal(lastRun(ctx.home).status, 'ok');
      assert.deepEqual(digest(ctx.home), refDigest);
    } finally {
      ctx.cleanup();
    }
  }

  it('a signal after the first committed chunk resumes to the uninterrupted store', () => stopAfter(1));
  it('a signal in the middle of the file set resumes to the uninterrupted store', () => stopAfter(Math.floor(total / 2)));
  it('a signal one chunk before the last resumes to the uninterrupted store', () => stopAfter(total - 1));

  it('a signal after the last yield point lets the run finish normally', async () => {
    const { runIngest } = await mod('ingest/run.mjs');
    // Plan 02-02: the run now ends with the unit post-step, which has yield points of its own after the last source,
    // so the signal is armed at the last poll instead of in a last source's discover. A reference run on an identical
    // home counts the polls (K); the test run arms the signal at poll K, after which no poll comes.
    const ref = home(SMALL);
    let polls = 0;
    try {
      await runIngest(opts(ref.home, { stop: () => { polls += 1; return null; } }));
    } finally {
      ref.cleanup();
    }
    assert.ok(polls > 0);
    const ctx = home(SMALL);
    try {
      let armed = false;
      let n = 0;
      const stop = () => {
        n += 1;
        const signal = armed ? 'SIGTERM' : null;
        if (n === polls) armed = true;
        return signal;
      };
      const s = await runIngest(opts(ctx.home, { stop }));
      assert.equal(armed, true);
      assert.equal(n, polls, 'no poll after the one that armed the signal');
      assert.equal(s.status, 'ok');
      assert.equal(lastRun(ctx.home).status, 'ok');
      assert.deepEqual(digest(ctx.home), refDigest);
    } finally {
      ctx.cleanup();
    }
  });
});
