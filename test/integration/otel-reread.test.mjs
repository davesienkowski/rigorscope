// Plan 01-12 Task 2 (WR-02, T-01-23, DATA-03): a rewritten OTel file keeps exactly its own provenance rows.
// A preserve-directory metrics file holds a short non-metric first line and then two byte-identical metric
// lines. After a scrub-style rewrite that drops the first line, both metric lines move to lower offsets. Before
// the fix the old provenance rows stayed, the second line counted the stale row of the first line's old offset,
// and a third otel_metric row with ordinal 2 appeared. Everything runs through the spawned CLI.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, queryDb, runCli, sha256, stateDirOf } from '../fixtures/build.mjs';
import { SA, liveDirFor, metricLine, preserveDayLines, preserveDirFor } from '../fixtures/otel.mjs';

const STORE = (home) => join(stateDirOf(home), 'store.db');
const q = (home, sql, params) => queryDb(STORE(home), sql, params);

// About 10 bytes, shorter than a metric line, so the rewrite moves the pair below the old offsets.
const FIRST = '{"note":1}';
const METRIC = metricLine({
  ts: '2026-10-27T12:00:01.000Z', metric: 'claude_code.cost.usage', value: 0.0123,
  attrs: { 'session.id': SA, model: 'claude-opus-5-5' }, resource: { 'service.name': 'claude-code' },
});

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function setup() {
  const ctx = makeHome();
  cleanups.push(ctx.cleanup);
  mkdirSync(liveDirFor(ctx.home), { recursive: true });
  const dir = preserveDirFor(ctx.home);
  mkdirSync(dir, { recursive: true });
  const metrics = join(dir, 'metrics-2026-10-27.jsonl');
  writeFileSync(metrics, `${FIRST}\n${METRIC}\n${METRIC}\n`);
  writeFileSync(join(dir, 'events-2026-10-26.jsonl'), `${preserveDayLines().join('\n')}\n`);
  return { home: ctx.home, metrics };
}

function ingest(home) {
  const r = runCli(['ingest'], { home });
  assert.equal(r.status, 0, r.stderr);
  return q(home, "SELECT files_reread AS reread, bytes_read AS bytes FROM ingest_source_run WHERE source = 'otel' ORDER BY run_id DESC LIMIT 1")[0];
}

const lineRows = (home, metrics) => q(home, `SELECT l.src_end_offset AS off FROM otel_metric_line l JOIN source_file f ON f.file_id = l.file_id
  WHERE f.rel_path = ? ORDER BY l.src_end_offset`, [metrics.split('/').pop()]).map((r) => r.off);
const ordinals = (home) => q(home, "SELECT ordinal FROM otel_metric WHERE metric = 'claude_code.cost.usage' ORDER BY ordinal").map((r) => r.ordinal);
const digest = (home) => sha256(JSON.stringify({
  m: q(home, 'SELECT ts_utc, metric, attrs_sha, ordinal, value, session_id, cc_version, attrs FROM otel_metric ORDER BY 1, 2, 3, 4'),
  e: q(home, 'SELECT session_id, event_seq, event_ts, kind, ts_utc, attrs_sha FROM otel_event ORDER BY 1, 2, 3, 4'),
}));
const naturalKeys = (home) => sha256(JSON.stringify({
  d: digest(home),
  l: q(home, 'SELECT file_id, src_end_offset, ts_utc, metric, attrs_sha FROM otel_metric_line ORDER BY 1, 2'),
  f: q(home, "SELECT rel_path, size, offset, state FROM source_file WHERE kind IN ('metrics', 'events') ORDER BY rel_path"),
}));

describe('a rewritten OTel file keeps exactly its own provenance rows', () => {
  it('the first read stores two provenance rows and two metric rows with ordinals 0 and 1', () => {
    const { home, metrics } = setup();
    ingest(home);
    assert.equal(lineRows(home, metrics).length, 2);
    assert.deepEqual(ordinals(home), [0, 1]);
    assert.ok(q(home, 'SELECT count(*) AS n FROM otel_event')[0].n > 0, 'the events file was ingested');
  });

  it('after a rewrite that moves the pair to lower offsets: one reread, 2 provenance rows, ordinals 0 and 1, same digests', () => {
    const { home, metrics } = setup();
    ingest(home);
    const before = digest(home);
    const oldOffsets = lineRows(home, metrics);
    writeFileSync(metrics, `${METRIC}\n${METRIC}\n`);
    const run = ingest(home);
    assert.equal(run.reread, 1, 'the rewritten file is reread once');
    const offsets = lineRows(home, metrics);
    assert.equal(offsets.length, 2, `provenance rows after the rewrite: ${offsets.length}`);
    assert.notDeepEqual(offsets, oldOffsets, 'the provenance rows are those of the new pass');
    assert.deepEqual(ordinals(home), [0, 1], 'no third metric row');
    assert.equal(digest(home), before, 'otel_metric and otel_event are unchanged');
  });

  it('a third ingest after the rewrite reads 0 bytes and changes no natural-key table', () => {
    const { home, metrics } = setup();
    ingest(home);
    writeFileSync(metrics, `${METRIC}\n${METRIC}\n`);
    ingest(home);
    const keys = naturalKeys(home);
    const run = ingest(home);
    assert.equal(run.bytes, 0);
    assert.equal(run.reread, 0);
    assert.equal(naturalKeys(home), keys);
  });

  it('control: an append without a rewrite adds one provenance row and ordinal 2 (no reread hook on an append)', () => {
    const { home, metrics } = setup();
    ingest(home);
    appendFileSync(metrics, `${METRIC}\n`);
    const run = ingest(home);
    assert.equal(run.reread, 0, 'an append is not a reread');
    assert.equal(lineRows(home, metrics).length, 3, 'the earlier provenance rows stay');
    assert.deepEqual(ordinals(home), [0, 1, 2]);
    assert.equal(readFileSync(metrics, 'utf8').split('\n').filter(Boolean).length, 4);
  });
});
