// Idempotency, ordering, rotation and interruption of the OTel ingest (plan 01-03, DATA-03, DATA-05).
// A digest of the sorted natural keys plus kept columns (no file ids, no offsets, no run ids) of
// otel_event, otel_metric and unknown_attr must be unchanged by a re-ingest, a different unit order, a
// different line order, an interruption followed by a clean run, a rotation re-read, and by reading the
// live directory before or after the preserve directory.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, copyFileSync, readFileSync, renameSync, truncateSync, writeFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  makeHome, queryDb, runCli, runCliAsync, sha256, shuffleLines, stateDirOf, windowsUsersDirFor,
} from '../fixtures/build.mjs';
import {
  SB, buildOtelTree, eventLine, evAttrs, otelNeedles, scanBuffers,
} from '../fixtures/otel.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const STORE = (home) => join(stateDirOf(home), 'store.db');

function digest(home) {
  const q = (sql) => queryDb(STORE(home), sql);
  const tables = {
    otel_event: q(`SELECT session_id, event_seq, event_ts, kind, ts_utc, prompt_id, request_id, tool_use_id, cc_version, attrs, attrs_sha
                     FROM otel_event ORDER BY 1, 2, 3, 4`),
    otel_metric: q(`SELECT ts_utc, metric, attrs_sha, ordinal, value, session_id, cc_version, attrs FROM otel_metric ORDER BY 1, 2, 3, 4`),
    unknown_attr: q('SELECT source, scope, name FROM unknown_attr WHERE source = \'otel\' ORDER BY 1, 2, 3'),
    source_root: q('SELECT source, alias, kind, display FROM source_root WHERE source = \'otel\' ORDER BY alias'),
    source_file: q(`SELECT r.alias, f.rel_path, f.kind, f.state FROM source_file f
                      JOIN source_root r ON r.root_id = f.root_id WHERE r.source = 'otel' ORDER BY 1, 2`),
  };
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
  return { counts, digest: sha256(JSON.stringify(tables)) };
}

const runLogCounts = (home) => Object.fromEntries(
  ['ingest_run', 'ingest_source_run', 'ingest_count'].map((t) => [t, queryDb(STORE(home), `SELECT count(*) AS n FROM ${t}`)[0].n]),
);
const opts = (home, extra = {}) => ({ home, env: { HOME: home }, windowsUsersDir: windowsUsersDirFor(home), ...extra });
const fresh = (preserve = true) => {
  const ctx = makeHome();
  const tree = buildOtelTree(ctx.home, { preserve });
  return { ...ctx, tree };
};
const metricPair = (home) => queryDb(STORE(home), 'SELECT ordinal FROM otel_metric WHERE metric = \'claude_code.cost.usage\' ORDER BY ordinal').map((r) => r.ordinal);
const otelBytes = (home) => {
  const dir = stateDirOf(home);
  return ['store.db', 'store.db-wal', 'store.db-shm'].filter((n) => existsSync(join(dir, n))).map((n) => ({ label: n, buf: readFileSync(join(dir, n)) }));
};

describe('OTel re-ingest', () => {
  it('a second run reads 0 bytes and leaves every natural-key table unchanged; only the run-log tables grow', () => {
    const ctx = fresh();
    try {
      assert.equal(runCli(['ingest'], { home: ctx.home }).status, 0);
      const d1 = digest(ctx.home);
      const logs1 = runLogCounts(ctx.home);
      const r2 = runCli(['ingest'], { home: ctx.home });
      assert.equal(r2.status, 0, r2.stderr);
      assert.deepEqual(digest(ctx.home), d1);
      const logs2 = runLogCounts(ctx.home);
      assert.equal(logs2.ingest_run, logs1.ingest_run + 1);
      assert.ok(logs2.ingest_source_run > logs1.ingest_source_run);
      const [src] = queryDb(STORE(ctx.home), 'SELECT bytes_read, lines_read FROM ingest_source_run WHERE source = \'otel\' ORDER BY run_id DESC LIMIT 1');
      assert.equal(src.bytes_read, 0);
      assert.equal(src.lines_read, 0);
      for (const t of ['otel_event', 'otel_metric', 'unknown_attr', 'source_root', 'source_file']) assert.ok(d1.counts[t] > 0, `${t} holds rows`);
    } finally {
      ctx.cleanup();
    }
  });

  it('reversed unit order gives the same key digest as the natural order', async () => {
    const a = fresh();
    const b = fresh();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(a.home));
      await runIngest(opts(b.home, { order: 'reverse' }));
      assert.deepEqual(digest(b.home), digest(a.home));
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('shuffled line order inside every file gives the same key digest', async () => {
    const a = fresh();
    const b = fresh();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      for (const f of Object.values(b.tree.files)) shuffleLines(f, 11);
      await runIngest(opts(a.home));
      await runIngest(opts(b.home));
      assert.deepEqual(digest(b.home), digest(a.home));
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('live-then-preserve and preserve-then-live give the same key digest', async () => {
    const a = fresh();
    const b = fresh();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(a.home));
      const preserveFirst = (units) => [...units].sort((x, y) => (x.rootAlias === y.rootAlias ? 0 : x.rootAlias === 'preserve' ? -1 : 1));
      await runIngest(opts(b.home, { order: preserveFirst }));
      assert.deepEqual(digest(b.home), digest(a.home));
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('an appended complete line is the only data read, and its key appears', async () => {
    const ctx = fresh();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(ctx.home));
      const before = digest(ctx.home);
      const line = `${eventLine({
        ts: '2026-10-27T13:00:00.000Z', event: 'api_request',
        attrs: evAttrs({ session: SB, seq: 40, ts: '2026-10-27T13:00:00.000Z', name: 'api_request', extra: { model: 'claude-opus-5-5', input_tokens: 3 } }),
      })}\n`;
      // The live events file ends in a partial tail; the appended line is read on a clean file instead.
      const next = join(ctx.tree.liveDir, 'events-2026-10-28.jsonl');
      writeFileSync(next, '');
      await runIngest(opts(ctx.home));
      appendFileSync(next, line);
      await runIngest(opts(ctx.home));
      const [src] = queryDb(STORE(ctx.home), 'SELECT bytes_read FROM ingest_source_run WHERE source = \'otel\' ORDER BY run_id DESC LIMIT 1');
      assert.equal(src.bytes_read, Buffer.byteLength(line));
      assert.equal(digest(ctx.home).counts.otel_event, before.counts.otel_event + 1);
    } finally {
      ctx.cleanup();
    }
  });

  it('a trailing partial line is not consumed until its newline arrives', async () => {
    const ctx = fresh(false);
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      const next = join(ctx.tree.liveDir, 'events-2026-10-28.jsonl');
      const full = eventLine({
        ts: '2026-10-28T01:00:00.000Z', event: 'api_request',
        attrs: evAttrs({ session: SB, seq: 41, ts: '2026-10-28T01:00:00.000Z', name: 'api_request', extra: { model: 'claude-opus-5-5', input_tokens: 4 } }),
      });
      const cut = Math.floor(full.length / 2);
      const count = () => queryDb(STORE(ctx.home), 'SELECT count(*) AS n FROM otel_event')[0].n;
      writeFileSync(next, full.slice(0, cut));
      await runIngest(opts(ctx.home));
      const before = count();
      const [mid] = queryDb(STORE(ctx.home), 'SELECT pending_tail_bytes AS p FROM ingest_source_run WHERE source = \'otel\' ORDER BY run_id DESC LIMIT 1');
      assert.ok(mid.p >= cut, 'the partial bytes are pending');
      appendFileSync(next, `${full.slice(cut)}\n`);
      await runIngest(opts(ctx.home));
      assert.equal(count(), before + 1, 'the completed line is read once');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('OTel rotation', () => {
  it('after truncate-then-replace the store digest and the canary scan equal those of a clean ingest of the same final content', async () => {
    const a = fresh();
    const b = fresh();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      const { checkpointStore } = await mod('db.mjs');
      await runIngest(opts(a.home));
      const f = a.tree.files.liveMetrics;
      const full = readFileSync(f);
      truncateSync(f, 100);
      await runIngest(opts(a.home));
      writeFileSync(f, full);
      await runIngest(opts(a.home));
      await runIngest(opts(b.home));
      assert.deepEqual(digest(a.home), digest(b.home));
      checkpointStore({ home: a.home });
      checkpointStore({ home: b.home });
      assert.deepEqual(scanBuffers(otelBytes(a.home), otelNeedles()), []);
      assert.deepEqual(scanBuffers(otelBytes(b.home), otelNeedles()), []);
      const re = queryDb(STORE(a.home), 'SELECT name FROM ingest_count WHERE kind = \'reread\'').map((r) => r.name);
      assert.ok(re.includes('truncated'), `reread reasons: ${re}`);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('the byte-identical metric pair stays two rows (ordinal 0 and 1) after the live ingest, the preserve copy, a re-read and an append', async () => {
    const ctx = fresh(false);
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(ctx.home));
      assert.deepEqual(metricPair(ctx.home), [0, 1], 'after the live ingest');
      buildOtelTree(ctx.home, { preserve: true });
      await runIngest(opts(ctx.home));
      assert.deepEqual(metricPair(ctx.home), [0, 1], 'after the preserve copy');
      // Re-read from offset 0: a new inode with the same bytes.
      const f = ctx.tree.files.liveMetrics;
      copyFileSync(f, `${f}.new`);
      renameSync(`${f}.new`, f);
      await runIngest(opts(ctx.home));
      assert.deepEqual(metricPair(ctx.home), [0, 1], 'after a re-read from offset 0');
      appendFileSync(f, readFileSync(f, 'utf8').split('\n')[0] + '\n');
      await runIngest(opts(ctx.home));
      assert.deepEqual(metricPair(ctx.home), [0, 1], 'after an appended line');
    } finally {
      ctx.cleanup();
    }
  });

  it('a pair split across two runs (first copy read, second appended later) still gets ordinals 0 and 1', async () => {
    const ctx = makeHome();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      const tree = buildOtelTree(ctx.home, { preserve: false });
      const lines = readFileSync(tree.files.liveMetrics, 'utf8').split('\n').filter(Boolean);
      const m3 = lines[2];
      writeFileSync(tree.files.liveMetrics, `${lines.slice(0, 3).join('\n')}\n`);
      await runIngest(opts(ctx.home));
      assert.deepEqual(metricPair(ctx.home), [0]);
      appendFileSync(tree.files.liveMetrics, `${m3}\n`);
      await runIngest(opts(ctx.home));
      assert.deepEqual(metricPair(ctx.home), [0, 1]);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('OTel key conflicts', () => {
  it('a preserve line whose key exists with different content is counted as dropped key_conflict and the stored row is unchanged', async () => {
    const ctx = fresh();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      const p = ctx.tree.files.preserveEvents27;
      writeFileSync(p, readFileSync(p, 'utf8').replace('"output_tokens":80', '"output_tokens":81'));
      await runIngest(opts(ctx.home));
      const conflicts = queryDb(STORE(ctx.home), 'SELECT sum(n) AS n FROM ingest_count WHERE source = \'otel\' AND kind = \'dropped\' AND name = \'key_conflict\'')[0].n;
      assert.equal(conflicts, 1);
      const attrs = JSON.parse(queryDb(STORE(ctx.home), 'SELECT attrs FROM otel_event WHERE request_id = \'req-e1\'')[0].attrs);
      assert.equal(attrs.output_tokens, 80);
      assert.equal(digest(ctx.home).counts.otel_event, 14);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('OTel interruption and concurrency', () => {
  it('a run cut between chunks (open chunk rolled back, lock released) then a clean run equals one uninterrupted run', async () => {
    const a = fresh();
    const b = fresh();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(a.home));
      let chunks = 0;
      await assert.rejects(runIngest(opts(b.home, {
        chunkLines: 2, beforeCommit: () => { chunks += 1; if (chunks === 2) throw new Error('cut-here'); },
      })), /cut-here/);
      assert.ok(!existsSync(join(stateDirOf(b.home), 'ingest.lock')), 'lock released after the failure');
      await runIngest(opts(b.home));
      assert.deepEqual(digest(b.home), digest(a.home));
      const runs = queryDb(STORE(b.home), 'SELECT status FROM ingest_run ORDER BY run_id').map((r) => r.status);
      assert.deepEqual(runs, ['failed', 'ok']);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('two ingest processes started together never duplicate a key, exit 0, and leave a clean canary scan', async () => {
    const ctx = fresh();
    try {
      const [x, y] = await Promise.all([runCliAsync(['ingest'], { home: ctx.home }), runCliAsync(['ingest'], { home: ctx.home })]);
      for (const r of [x, y]) {
        assert.equal(r.status, 0, r.stderr);
        assert.ok(/^ingest: roots=/m.test(r.stdout) || /^ingest: skipped, another ingest holds the lock/m.test(r.stdout));
      }
      const ran = [x, y].filter((r) => /^ingest: roots=/m.test(r.stdout)).length;
      assert.equal(queryDb(STORE(ctx.home), 'SELECT count(*) AS n FROM ingest_run')[0].n, ran);
      const solo = fresh();
      try {
        const { runIngest } = await mod('ingest/run.mjs');
        const { checkpointStore } = await mod('db.mjs');
        await runIngest(opts(solo.home));
        assert.deepEqual(digest(ctx.home), digest(solo.home));
        checkpointStore({ home: ctx.home });
        assert.deepEqual(scanBuffers(otelBytes(ctx.home), otelNeedles()), []);
      } finally {
        solo.cleanup();
      }
    } finally {
      ctx.cleanup();
    }
  });

  it('every natural-key table keeps its row count and digest across a re-ingest in reversed order (unclassified family)', async () => {
    const ctx = fresh();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(ctx.home));
      const d1 = digest(ctx.home);
      await runIngest(opts(ctx.home, { order: 'reverse' }));
      const d2 = digest(ctx.home);
      assert.deepEqual(d2.counts, d1.counts);
      assert.equal(d2.digest, d1.digest);
      assert.equal(d1.counts.otel_event, 14);
      assert.equal(d1.counts.otel_metric, 7);
    } finally {
      ctx.cleanup();
    }
  });

  it('empty inputs ingest with 0 rows and exit 0: a zero-byte file, a whitespace-only file and a file of blank lines', async () => {
    const ctx = makeHome();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      const dir = join(ctx.home, '.local', 'share', 'hook-telemetry');
      buildOtelTree(ctx.home, { preserve: false });
      for (const [name, text] of [['events-2026-10-20.jsonl', ''], ['events-2026-10-21.jsonl', '   \t  '], ['metrics-2026-10-21.jsonl', '\n\n\n'], ['events-2026-10-22.jsonl', '\r\n\r\n']]) {
        writeFileSync(join(dir, name), text);
      }
      await runIngest(opts(ctx.home));
      assert.equal(digest(ctx.home).counts.otel_event, 12, 'the empty files add no event');
      assert.equal(digest(ctx.home).counts.otel_metric, 7, 'the empty files add no metric');
    } finally {
      ctx.cleanup();
    }
  });
});
