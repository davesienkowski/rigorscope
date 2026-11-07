// Vanished and unreadable files (plan 01-11, WR-05, D-04, RR-01, DATA-03). A file that disappears or becomes
// unreadable between the stat and the read is counted under walk_skip (`vanished` for ENOENT and ENOTDIR,
// `unreadable` for EACCES and EPERM), its unflushed lines are dropped, and the run continues with the later
// files and the later sources; the run is not marked failed. Any other error still fails the run.
//
// The real transcript descriptor is wrapped so that its read() deletes the chosen file first, which is
// exactly the window between the runner's stat and its read. Failure messages never print a path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeAssistant, makeHome, makeUsage, queryDb, sha256, stateDirOf, storeDigest, windowsUsersDirFor, writeJsonl,
} from '../fixtures/build.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const STORE = (home) => join(stateDirOf(home), 'store.db');
const PROJECT = '-fixture-vanish-work';
const FILES = 6;
const LINES = 4;
const sessionName = (f) => `sess-v-${String(f).padStart(4, '0')}`;

function buildTree(root, { skip = [], empty = [], meta = false } = {}) {
  const proj = join(root, 'projects', PROJECT);
  for (let f = 0; f < FILES; f += 1) {
    if (skip.includes(f)) continue;
    const session = sessionName(f);
    const lines = [];
    if (!empty.includes(f)) {
      for (let i = 0; i < LINES; i += 1) {
        lines.push(JSON.stringify(makeAssistant({
          session, ts: `2026-10-27T12:00:${String(i).padStart(2, '0')}.000Z`, id: `msg_v_${f}_${i}`, model: 'claude-opus-5-5',
          use: makeUsage({ input: 1 + i, output: 2, read: 3, creation: 4 }),
        })));
      }
    }
    writeJsonl(join(proj, `${session}.jsonl`), lines);
  }
  if (meta) {
    const dir = join(proj, sessionName(1), 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-a0b1c2d3e4f5a6b7.meta.json'), `${JSON.stringify({ agentType: 'gsd-executor' })}\n`);
  }
}

const opts = (h, extra = {}) => ({ home: h, env: { HOME: h }, windowsUsersDir: windowsUsersDirFor(h), ...extra });

// Real descriptors, with transcript.read deleting (or otherwise breaking) every unit whose file name ends with
// one of `names` before the real read runs.
async function sourcesWith(names, act = (abs) => unlinkSync(abs)) {
  const { loadSources } = await mod('ingest/sources.mjs');
  const all = await loadSources();
  const hit = (unit) => names.some((n) => unit.abs.endsWith(n));
  return all.map((src) => (src.name !== 'transcript' ? src : {
    ...src,
    read(unit, start, o) {
      if (hit(unit)) act(unit.abs);
      return src.read(unit, start, o);
    },
  }));
}

const count = (h, name) => queryDb(STORE(h), "SELECT coalesce(sum(n), 0) AS n FROM ingest_count WHERE kind = 'walk_skip' AND name = ?", [name])[0].n;
const lastRun = (h) => queryDb(STORE(h), 'SELECT run_id, status, error_code FROM ingest_run ORDER BY run_id DESC LIMIT 1')[0];
const fileRows = (h) => queryDb(STORE(h), 'SELECT rel_path, state, offset FROM source_file ORDER BY rel_path');
const hasFile = (h, f) => fileRows(h).some((r) => r.rel_path.endsWith(`${sessionName(f)}.jsonl`));
const sessions = (h) => new Set(queryDb(STORE(h), 'SELECT DISTINCT session_id FROM cc_message').map((r) => r.session_id));
function digest(h) {
  return { message: storeDigest(h), files: sha256(JSON.stringify(fileRows(h))) };
}

// A run that throws is reported as { status: 'threw', code } so the assertion that fails is the planned one and
// no error text (which can hold a path) reaches the test output.
async function ingest(o) {
  const { runIngest } = await mod('ingest/run.mjs');
  try {
    return await runIngest(o);
  } catch (err) {
    return { status: 'threw', code: typeof err?.code === 'string' ? err.code : 'unknown' };
  }
}

async function withHome(build, fn) {
  const ctx = makeHome();
  try {
    buildTree(ctx.root, build);
    return await fn(ctx);
  } finally {
    ctx.cleanup();
  }
}

describe('a file that vanishes between the stat and the read', () => {
  it('is counted as vanished; the run is ok, later files and later sources still run, and no file row is kept', async () => {
    await withHome({}, async (ctx) => {
      const s = await ingest(opts(ctx.home, { sources: await sourcesWith([`${sessionName(2)}.jsonl`]) }));
      assert.equal(s.status, 'ok');
      assert.equal(lastRun(ctx.home).status, 'ok');
      assert.equal(count(ctx.home, 'vanished'), 1);
      const got = sessions(ctx.home);
      for (let f = 3; f < FILES; f += 1) assert.ok(got.has(sessionName(f)), `file ${f} after the vanished one was ingested`);
      assert.equal(got.has(sessionName(2)), false, 'the vanished file left no message rows');
      assert.equal(hasFile(ctx.home, 2), false, 'the vanished file left no source_file row');
      const run = lastRun(ctx.home).run_id;
      const ran = queryDb(STORE(ctx.home), 'SELECT source FROM ingest_source_run WHERE run_id = ? ORDER BY source', [run]).map((r) => r.source);
      assert.deepEqual(ran, ['ledger', 'otel', 'transcript', 'usage']);
    });
  });

  it('two files vanishing back to back are both counted and the file after them is ingested', async () => {
    await withHome({}, async (ctx) => {
      const s = await ingest(opts(ctx.home, { sources: await sourcesWith([`${sessionName(2)}.jsonl`, `${sessionName(3)}.jsonl`]) }));
      assert.equal(s.status, 'ok');
      assert.equal(count(ctx.home, 'vanished'), 2);
      assert.ok(sessions(ctx.home).has(sessionName(4)), 'the file after the two vanished ones was ingested');
    });
  });

  it('a meta unit whose file vanishes between the stat and the read is counted and skipped', async () => {
    await withHome({ meta: true }, async (ctx) => {
      const s = await ingest(opts(ctx.home, { sources: await sourcesWith(['.meta.json']) }));
      assert.equal(s.status, 'ok');
      assert.equal(count(ctx.home, 'vanished'), 1);
      assert.equal(sessions(ctx.home).size, FILES, 'every session file was still ingested');
    });
  });

  it('a file that cannot be opened (mode 000) is counted as unreadable and the run goes on', { skip: process.getuid?.() === 0 ? 'running as root: mode 000 does not block reads' : false }, async () => {
    await withHome({}, async (ctx) => {
      const s = await ingest(opts(ctx.home, { sources: await sourcesWith([`${sessionName(2)}.jsonl`], (abs) => chmodSync(abs, 0o000)) }));
      try {
        assert.equal(s.status, 'ok');
        assert.equal(count(ctx.home, 'unreadable'), 1);
        assert.equal(count(ctx.home, 'vanished'), 0);
        assert.ok(sessions(ctx.home).has(sessionName(3)), 'the file after the unreadable one was ingested');
      } finally {
        chmodSync(join(ctx.root, 'projects', PROJECT, `${sessionName(2)}.jsonl`), 0o600);
      }
    });
  });

  it('a zero-byte file is read as 0 lines and is not counted as vanished', async () => {
    await withHome({ empty: [2] }, async (ctx) => {
      const s = await ingest(opts(ctx.home));
      assert.equal(s.status, 'ok');
      assert.equal(count(ctx.home, 'vanished'), 0);
      assert.ok(hasFile(ctx.home, 2), 'the zero-byte file has its source_file row');
    });
  });

  it('the store after a vanish equals an ingest of the same tree without that file', async () => {
    await withHome({}, async (a) => {
      await withHome({ skip: [2] }, async (b) => {
        assert.equal((await ingest(opts(a.home, { sources: await sourcesWith([`${sessionName(2)}.jsonl`]) }))).status, 'ok');
        assert.equal((await ingest(opts(b.home))).status, 'ok');
        assert.deepEqual(digest(a.home), digest(b.home));
      });
    });
  });

  it('any other error (a failing writer) still fails the run unchanged', async () => {
    const { runIngest } = await mod('ingest/run.mjs');
    const { loadSources } = await mod('ingest/sources.mjs');
    await withHome({}, async (ctx) => {
      const sources = (await loadSources()).map((src) => (src.name !== 'transcript' ? src : {
        ...src,
        createWriter: () => ({
          write() {
            const err = new Error('injected writer failure');
            err.code = 'ERR_SQLITE_ERROR';
            throw err;
          },
        }),
      }));
      await assert.rejects(runIngest(opts(ctx.home, { sources })), (err) => err.code === 'ERR_SQLITE_ERROR');
      assert.deepEqual({ ...lastRun(ctx.home), run_id: 0 }, { run_id: 0, status: 'failed', error_code: 'ERR_SQLITE_ERROR' });
    });
  });
});
