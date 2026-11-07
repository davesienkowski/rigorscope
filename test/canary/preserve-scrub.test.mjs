// OTel canary and preserve-scrub (plan 01-03, DATA-05, DATA-06). The raw-byte scan of the store, its WAL,
// derived.db and all captured output must find none of the planted OTel values on the real path and must
// find them when a deliberately leaking OTel normalizer is injected (teeth). preserve-scrub removes
// tool_parameters, tool_input and error from rigorscope's own preserve copy atomically and idempotently;
// --full also removes prompt, prompt_text, response, vcs.ref.head.name and the identity keys.
//
// Failure messages report labels, needle indexes and offsets only. A planted value is never printed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, lstatSync, readFileSync, readdirSync, renameSync, symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  PLANTS, REPO, cliEnv, makeHome, queryDb, runCli, sha256, sha256File, stateDirOf, treeDigest, windowsUsersDirFor,
} from '../fixtures/build.mjs';
import {
  OTEL_EXPECTED, OTEL_PLANTS, buildOtelTree, buildPreserveScrubTree, otelNeedles, preserveDirFor, readRegularFiles, scanBuffers,
} from '../fixtures/otel.mjs';
import { leakyOtelNormalize } from './leaky-otel-normalizer.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const NAMES = Object.keys(OTEL_PLANTS);
const idx = (n) => NAMES.indexOf(n);
const OS_USER_INDEX = Object.values(OTEL_PLANTS).length + 1;
const THREE = [OTEL_PLANTS.toolParameters, OTEL_PLANTS.toolInput, OTEL_PLANTS.errorText];

const stateBytes = (home, { derived = true } = {}) => {
  const dir = stateDirOf(home);
  const names = ['store.db', 'store.db-wal', 'store.db-shm', ...(derived ? ['derived.db'] : [])];
  return names.filter((n) => existsSync(join(dir, n))).map((n) => ({ label: n, buf: readFileSync(join(dir, n)) }));
};

// sha256, inode and mtime of every entry directly inside dir (files only).
function snap(dir) {
  const out = {};
  for (const n of readdirSync(dir).sort()) {
    const st = lstatSync(join(dir, n));
    if (st.isFile()) out[n] = { sha: sha256File(join(dir, n)), ino: st.ino, mtime: st.mtimeMs, mode: st.mode & 0o777 };
  }
  return out;
}

const pairs = (text) => (text === 'none' ? {} : Object.fromEntries(text.split(',').map((p) => [p.split(':')[0], Number(p.split(':')[1])])));
function parseScrub(stdout) {
  const files = {};
  for (const m of stdout.matchAll(/^preserve-scrub: (\S+) lines=(\d+) rewritten=(\d+) dropped=(\d+) unparseable_kept=(\d+) removed=(\S+)$/gm)) {
    files[m[1]] = { lines: +m[2], rewritten: +m[3], dropped: +m[4], unparseableKept: +m[5], removed: pairs(m[6]) };
  }
  const f = /^preserve-scrub: files=(\d+) rewritten=(\d+) unchanged=(\d+) skipped=(\S+) mode=(dry-run|apply) rules=(default|full)$/m.exec(stdout);
  assert.ok(f, 'the final summary line is present');
  return { files, total: { files: +f[1], rewritten: +f[2], unchanged: +f[3], skipped: pairs(f[4]), mode: f[5], rules: f[6] } };
}
const sumRemoved = (files) => {
  const t = {};
  for (const f of Object.values(files)) for (const [k, n] of Object.entries(f.removed)) t[k] = (t[k] ?? 0) + n;
  return t;
};

function scrubHome() {
  const ctx = makeHome();
  const tree = buildPreserveScrubTree(ctx.home);
  return { ctx, tree };
}

function otelDigest(home) {
  const q = (sql) => queryDb(join(stateDirOf(home), 'store.db'), sql);
  return sha256(JSON.stringify([
    q('SELECT session_id, event_seq, event_ts, kind, ts_utc, attrs, attrs_sha FROM otel_event ORDER BY 1, 2, 3, 4'),
    q('SELECT ts_utc, metric, attrs_sha, ordinal, value, attrs FROM otel_metric ORDER BY 1, 2, 3, 4'),
  ]));
}
const conflicts = (home) => queryDb(join(stateDirOf(home), 'store.db'), 'SELECT coalesce(sum(n), 0) AS n FROM ingest_count WHERE kind = \'dropped\' AND name = \'key_conflict\'')[0].n;

describe('OTel canary: the scan has teeth and the real path is clean', () => {
  it('finds identity, content and OS user name plants when a leaking OTel normalizer is injected', async () => {
    const ctx = makeHome();
    try {
      buildOtelTree(ctx.home, { preserve: true });
      const { runIngest } = await mod('ingest/run.mjs');
      const { checkpointStore } = await mod('db.mjs');
      await runIngest({ home: ctx.home, env: { HOME: ctx.home }, windowsUsersDir: windowsUsersDirFor(ctx.home), otelNormalize: leakyOtelNormalize });
      checkpointStore({ home: ctx.home });
      const found = new Set(scanBuffers(stateBytes(ctx.home, { derived: false }), otelNeedles()).map((f) => f.needle));
      for (const n of ['userId', 'userEmail', 'organizationId', 'terminalType', 'toolParameters', 'toolInput', 'errorText', 'branchName']) {
        assert.ok(found.has(idx(n)), `plant ${n} found in the leaking run`);
      }
      assert.ok(found.has(OS_USER_INDEX), 'OS user name plant found');
      assert.ok(found.has('email-shape'), 'email shape found');
      assert.ok(found.has(idx('nonAscii')) || found.has(Object.values(OTEL_PLANTS).length), 'a non-ASCII plant found');
    } finally {
      ctx.cleanup();
    }
  });

  it('finds none of the planted values in store.db, its WAL and shm, derived.db or any output after discovery ingest and a second ingest', async () => {
    const ctx = makeHome();
    try {
      buildOtelTree(ctx.home, { preserve: true });
      const outputs = [];
      for (const args of [['ingest'], ['ingest'], ['cost']]) {
        const r = runCli(args, { home: ctx.home });
        assert.equal(r.status, 0, `${args[0]} exit status`);
        outputs.push({ label: `out:${args[0]}:stdout`, buf: Buffer.from(r.stdout) }, { label: `out:${args[0]}:stderr`, buf: Buffer.from(r.stderr) });
      }
      const { checkpointStore } = await mod('db.mjs');
      checkpointStore({ home: ctx.home });
      const findings = scanBuffers([...stateBytes(ctx.home), ...outputs], [...otelNeedles(), ...Object.values(PLANTS)]);
      assert.deepEqual(findings, []);
      assert.ok(queryDb(join(stateDirOf(ctx.home), 'store.db'), 'SELECT count(*) AS n FROM otel_event')[0].n > 0, 'the scan ran over a populated store');
    } finally {
      ctx.cleanup();
    }
  });

  it('an interrupted then resumed OTel ingest leaves none of the planted values in any byte', async () => {
    const ctx = makeHome();
    try {
      buildOtelTree(ctx.home, { preserve: true });
      const { runIngest } = await mod('ingest/run.mjs');
      const { checkpointStore } = await mod('db.mjs');
      const o = { home: ctx.home, env: { HOME: ctx.home }, windowsUsersDir: windowsUsersDirFor(ctx.home) };
      let chunks = 0;
      await assert.rejects(runIngest({ ...o, chunkLines: 2, beforeCommit: () => { chunks += 1; if (chunks === 3) throw new Error('interrupt-here'); } }), /interrupt-here/);
      await runIngest(o);
      checkpointStore({ home: ctx.home });
      assert.deepEqual(scanBuffers(stateBytes(ctx.home), otelNeedles()), []);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('preserve-scrub: scan teeth on the preserve copy', () => {
  it('an unscrubbed preserve copy is detected by the same scan', () => {
    const { ctx, tree } = scrubHome();
    try {
      const found = new Set(scanBuffers(readRegularFiles(tree.dir), THREE, { email: false }).map((f) => f.needle));
      assert.deepEqual([...found].sort(), [0, 1, 2]);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('preserve-scrub: dry run and apply', () => {
  it('a dry run (the default) leaves every preserve file sha256-identical and reports what it would do', () => {
    const { ctx, tree } = scrubHome();
    try {
      const before = snap(tree.dir);
      const r = runCli(['preserve-scrub'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(snap(tree.dir), before);
      const p = parseScrub(r.stdout);
      assert.equal(p.total.mode, 'dry-run');
      assert.equal(p.total.rewritten, OTEL_EXPECTED.scrub.rewrittenFiles);
      assert.match(r.stdout, /--apply/);
      assert.ok(!existsSync(join(ctx.home, '.rigorscope')), 'no state directory is created');
    } finally {
      ctx.cleanup();
    }
  });

  it('--apply leaves no tool_parameters, tool_input or error plant and reports exactly the hand-computed counts', () => {
    const { ctx, tree } = scrubHome();
    try {
      const r = runCli(['preserve-scrub', '--apply'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(scanBuffers(readRegularFiles(tree.dir), THREE, { email: false }), []);
      const p = parseScrub(r.stdout);
      assert.equal(p.total.mode, 'apply');
      assert.equal(p.total.rules, 'default');
      assert.deepEqual(sumRemoved(p.files), OTEL_EXPECTED.scrub.removed);
      assert.equal(Object.values(p.files).reduce((a, f) => a + f.dropped, 0), OTEL_EXPECTED.scrub.dropped);
      assert.equal(Object.values(p.files).reduce((a, f) => a + f.unparseableKept, 0), OTEL_EXPECTED.scrub.unparseableKept);
      assert.equal(p.total.files, OTEL_EXPECTED.scrub.files);
      assert.equal(p.total.rewritten, OTEL_EXPECTED.scrub.rewrittenFiles);
      assert.deepEqual(p.total.skipped, OTEL_EXPECTED.scrub.skipped);
    } finally {
      ctx.cleanup();
    }
  });

  it('copies every other line byte for byte: a file with only identity keys keeps its bytes, inode and mtime; the prompt plant stays by default', () => {
    const { ctx, tree } = scrubHome();
    try {
      const before = snap(tree.dir);
      assert.equal(runCli(['preserve-scrub', '--apply'], { home: ctx.home }).status, 0);
      const after = snap(tree.dir);
      for (const n of ['events-2026-10-26.jsonl', 'metrics-2026-10-27.jsonl']) assert.deepEqual(after[n], before[n], `${n} untouched`);
      const text = readFileSync(tree.files.ev27, 'utf8');
      assert.ok(text.includes(OTEL_PLANTS.promptText), 'the default rule set does not remove prompt text (D-05)');
      const ev25 = readFileSync(tree.files.ev25);
      assert.ok(ev25.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'the BOM line was not rewritten, so its bytes are kept');
      assert.ok(ev25.includes(Buffer.from('\r\n')), 'CRLF endings are kept');
      assert.ok(!ev25.subarray(ev25.length - 2).equals(Buffer.from('\r\n')), 'the missing final newline stays missing');
      assert.ok(text.endsWith('\n'));
    } finally {
      ctx.cleanup();
    }
  });

  it('skips decoys and counts them (name 2, symlink 1, not_regular 1), leaving the symlink target and the other entries untouched', () => {
    const { ctx, tree } = scrubHome();
    try {
      const outsideBefore = sha256File(tree.outsideFile);
      const reportsBefore = treeDigest(join(tree.dir, 'reports'));
      const notes = sha256File(join(tree.dir, 'notes.txt'));
      const r = runCli(['preserve-scrub', '--apply'], { home: ctx.home });
      assert.deepEqual(parseScrub(r.stdout).total.skipped, { name: 2, symlink: 1, not_regular: 1 });
      assert.equal(sha256File(tree.outsideFile), outsideBefore);
      assert.equal(treeDigest(join(tree.dir, 'reports')), reportsBefore);
      assert.equal(sha256File(join(tree.dir, 'notes.txt')), notes);
      assert.ok(lstatSync(join(tree.dir, 'events-2026-10-24.jsonl')).isSymbolicLink());
      assert.ok(lstatSync(join(tree.dir, 'metrics-2026-10-24.jsonl')).isDirectory());
    } finally {
      ctx.cleanup();
    }
  });

  it('a second --apply rewrites 0 files and changes nothing (sha256, inode and mtime equal)', () => {
    const { ctx, tree } = scrubHome();
    try {
      assert.equal(runCli(['preserve-scrub', '--apply'], { home: ctx.home }).status, 0);
      const mid = snap(tree.dir);
      const r = runCli(['preserve-scrub', '--apply'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(parseScrub(r.stdout).total.rewritten, 0);
      assert.deepEqual(snap(tree.dir), mid);
    } finally {
      ctx.cleanup();
    }
  });

  it('rewritten files are mode 0600, no temp file remains, and the live receiver directory is never touched', () => {
    const { ctx, tree } = scrubHome();
    try {
      const live = buildOtelTree(ctx.home, { preserve: false });
      const liveBefore = treeDigest(live.liveDir);
      assert.equal(runCli(['preserve-scrub', '--apply'], { home: ctx.home }).status, 0);
      for (const f of [tree.files.ev27, tree.files.ev25]) assert.equal(lstatSync(f).mode & 0o777, 0o600, 'rewritten file mode');
      assert.deepEqual(readdirSync(tree.dir).filter((n) => n.startsWith('.scrub-')), []);
      assert.equal(treeDigest(live.liveDir), liveBefore);
      // Plan 01-12 (U2): --apply takes the ingest lock, so it now creates the state directory (mode 0700) like
      // ingest does, and releases the lock afterwards. The dry-run assertions that no state directory exists stay.
      assert.equal(lstatSync(join(ctx.home, '.rigorscope')).mode & 0o777, 0o700, '--apply creates the 0700 state directory');
      assert.ok(!existsSync(join(ctx.home, '.rigorscope', 'ingest.lock')), 'no lock file is left behind');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('preserve-scrub --full', () => {
  it('--apply --full leaves no plant of any kind (identity, content, branch, terminal, OS user name) and no email shape', () => {
    const { ctx, tree } = scrubHome();
    try {
      const dry = runCli(['preserve-scrub', '--full'], { home: ctx.home });
      assert.equal(parseScrub(dry.stdout).total.rules, 'full');
      assert.ok(scanBuffers(readRegularFiles(tree.dir), otelNeedles()).length > 0, 'a dry run with --full changes nothing');
      const r = runCli(['preserve-scrub', '--apply', '--full'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(scanBuffers(readRegularFiles(tree.dir), otelNeedles()), []);
      assert.equal(parseScrub(r.stdout).total.rules, 'full');
      const again = runCli(['preserve-scrub', '--apply', '--full'], { home: ctx.home });
      assert.equal(parseScrub(again.stdout).total.rewritten, 0, 'idempotent');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('preserve-scrub: ingest agreement and refusals', () => {
  it('ingesting the preserve directory before and after --apply gives identical store content and zero key conflicts', () => {
    const a = scrubHome();
    const b = scrubHome();
    try {
      assert.equal(runCli(['ingest'], { home: a.ctx.home }).status, 0);
      const first = otelDigest(a.ctx.home);
      assert.equal(runCli(['preserve-scrub', '--apply'], { home: a.ctx.home }).status, 0);
      assert.equal(runCli(['ingest'], { home: a.ctx.home }).status, 0);
      assert.equal(otelDigest(a.ctx.home), first, 're-ingesting a scrubbed file changes no row');
      assert.equal(conflicts(a.ctx.home), 0);
      assert.equal(runCli(['preserve-scrub', '--apply'], { home: b.ctx.home }).status, 0);
      assert.equal(runCli(['ingest'], { home: b.ctx.home }).status, 0);
      assert.equal(otelDigest(b.ctx.home), first, 'scrub then ingest equals ingest then scrub');
      assert.equal(conflicts(b.ctx.home), 0);
    } finally {
      a.ctx.cleanup();
      b.ctx.cleanup();
    }
  });

  it('refuses a symlinked preserve directory with exit 1 and changes nothing behind it', () => {
    const { ctx, tree } = scrubHome();
    try {
      const real = `${tree.dir}-real`;
      renameSync(tree.dir, real);
      symlinkSync(real, tree.dir);
      const before = snap(real);
      const r = runCli(['preserve-scrub', '--apply'], { home: ctx.home });
      assert.equal(r.status, 1);
      assert.ok(r.stderr.length > 0 && !r.stderr.includes(ctx.home), 'one line, no absolute path');
      assert.deepEqual(snap(real), before);
    } finally {
      ctx.cleanup();
    }
  });

  it('a missing preserve directory prints one line and exits 0; an unknown flag is a usage error (exit 2)', () => {
    const ctx = makeHome();
    try {
      const r = runCli(['preserve-scrub'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^preserve-scrub: no preserve directory$/m);
      assert.equal(runCli(['preserve-scrub', '--bogus'], { home: ctx.home }).status, 2);
      assert.ok(!existsSync(preserveDirFor(ctx.home)));
    } finally {
      ctx.cleanup();
    }
  });
});

// Plan 01-12 (U2, DATA-04, DATA-06): --apply takes the ingest lock before it rewrites anything; the dry run takes
// none. The lock is held by a spawned child through withLock, the way test/unit/lock.test.mjs holds it.
const LOCK_MODULE = new URL('../../src/ingest/lock.mjs', import.meta.url).pathname;
async function holdLock(home) {
  const script = `import(${JSON.stringify(LOCK_MODULE)}).then(async (m) => { await m.withLock({ home: ${JSON.stringify(home)} }, () => { process.stdout.write('ready\\n'); return new Promise(() => setInterval(() => {}, 1000)); }); });`;
  const child = spawn(process.execPath, ['-e', script], { cwd: REPO, env: cliEnv(home) });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); });
    child.on('error', reject);
    child.on('exit', () => reject(new Error('lock holder exited before it was ready')));
  });
  child.removeAllListeners('exit');
  return {
    pid: child.pid,
    release: () => new Promise((resolve) => { child.on('exit', () => resolve()); child.kill('SIGTERM'); }),
  };
}

describe('preserve-scrub and the ingest lock', () => {
  it('--apply while an ingest holds the lock prints the skip line, exits 0 and rewrites nothing', async () => {
    const { ctx, tree } = scrubHome();
    let holder;
    try {
      holder = await holdLock(ctx.home);
      const lockBefore = readFileSync(join(ctx.home, '.rigorscope', 'ingest.lock'), 'utf8');
      const before = snap(tree.dir);
      const r = runCli(['preserve-scrub', '--apply'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^preserve-scrub: skipped, an ingest holds the lock \\(pid ${holder.pid} since \\S+\\)$`, 'm'));
      assert.deepEqual(snap(tree.dir), before, 'every preserve file is byte-identical');
      assert.equal(readFileSync(join(ctx.home, '.rigorscope', 'ingest.lock'), 'utf8'), lockBefore, 'the holder keeps its lock');
    } finally {
      await holder?.release();
      ctx.cleanup();
    }
  });

  it('--apply after the ingest finished rewrites as before and leaves no lock file', async () => {
    const { ctx, tree } = scrubHome();
    try {
      const holder = await holdLock(ctx.home);
      await holder.release();
      const r = runCli(['preserve-scrub', '--apply'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(parseScrub(r.stdout).total.rewritten, OTEL_EXPECTED.scrub.rewrittenFiles);
      assert.deepEqual(scanBuffers(readRegularFiles(tree.dir), THREE, { email: false }), []);
      assert.ok(!existsSync(join(ctx.home, '.rigorscope', 'ingest.lock')));
    } finally {
      ctx.cleanup();
    }
  });

  it('the dry run under a held lock still runs, takes no lock and writes nothing', async () => {
    const { ctx, tree } = scrubHome();
    let holder;
    try {
      holder = await holdLock(ctx.home);
      const stateBefore = readdirSync(join(ctx.home, '.rigorscope')).sort();
      const before = snap(tree.dir);
      const r = runCli(['preserve-scrub'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(parseScrub(r.stdout).total.mode, 'dry-run');
      assert.doesNotMatch(r.stdout, /skipped, an ingest holds the lock/);
      assert.deepEqual(snap(tree.dir), before);
      assert.deepEqual(readdirSync(join(ctx.home, '.rigorscope')).sort(), stateBefore);
    } finally {
      await holder?.release();
      ctx.cleanup();
    }
  });

  it('--apply with no state directory creates it with mode 0700 and removes its lock afterwards', () => {
    const { ctx } = scrubHome();
    try {
      assert.ok(!existsSync(join(ctx.home, '.rigorscope')));
      const r = runCli(['preserve-scrub', '--apply'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(lstatSync(join(ctx.home, '.rigorscope')).mode & 0o777, 0o700);
      assert.deepEqual(readdirSync(join(ctx.home, '.rigorscope')), []);
    } finally {
      ctx.cleanup();
    }
  });
});
