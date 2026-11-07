// Migration 003 and the OTel writer (plan 01-03, DATA-03, RR-04, RR-08). Written before the migration
// and the writer exist. Contract of the writer module:
//   createWriter(db) -> { writeEvent(row, loc), writeMetric(row, loc), write(record, fileId) }
//   writeEvent / writeMetric -> { inserted: 0 | 1, conflict: boolean }; loc = { file_id, src_end_offset }
//   write({ kind: 'event' | 'metric', row, end, onConflict }, fileId) -> rows newly inserted; a conflict calls onConflict()
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome } from '../fixtures/build.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);

async function openFresh() {
  const ctx = makeHome();
  const { openStore } = await mod('db.mjs');
  const db = openStore({ home: ctx.home });
  db.exec("INSERT INTO source_root (source, alias, kind, display) VALUES ('otel', 'live', 'live', '~/x')");
  db.exec("INSERT INTO source_file (root_id, rel_path, kind) VALUES (1, 'events-2026-10-27.jsonl', 'events')");
  db.exec("INSERT INTO source_file (root_id, rel_path, kind) VALUES (1, 'metrics-2026-10-27.jsonl', 'metrics')");
  const { createWriter } = await mod('sources/otel/write.mjs');
  return { ctx, db, w: createWriter(db), close: () => { db.close(); ctx.cleanup(); } };
}

const evRow = (over = {}) => ({
  sessionId: 's1', seq: 1, eventTs: '2026-10-27T12:00:01.000Z', kind: 'api_request', tsUtc: '2026-10-27T12:00:01.000Z',
  promptId: null, requestId: 'req-1', toolUseId: null, ccVersion: '2.1.309', attrsJson: '{"model":"m"}', attrsSha: 'sha-a', ...over,
});
const mRow = (over = {}) => ({
  tsUtc: '2026-10-27T12:00:01.000Z', metric: 'claude_code.cost.usage', attrsSha: 'sha-m', value: 0.5, sessionId: 's1', ccVersion: '2.1.309',
  attrsJson: '{"model":"m"}', ...over,
});
const n = (db, sql, p = []) => db.prepare(sql).get(...p).n;
const ordinals = (db) => db.prepare('SELECT ordinal FROM otel_metric ORDER BY ordinal').all().map((r) => r.ordinal);

describe('migration 003', () => {
  it('applies on top of a version 2 store and on an empty store, ending at user_version 3 with the three tables', async () => {
    const ctx = makeHome();
    try {
      const { openStore, loadMigrations } = await mod('db.mjs');
      const { fileURLToPath } = await import('node:url');
      const all = await loadMigrations(fileURLToPath(new URL('../../src/store/migrations/', import.meta.url)));
      assert.ok(all.length >= 3); // plan 01-06 added migration 004
      assert.equal(all[2].version, 3);
      const two = openStore({ home: ctx.home, migrations: all.slice(0, 2) });
      assert.equal(two.prepare('PRAGMA user_version').get().user_version, 2);
      assert.equal(n(two, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'otel_event'"), 0);
      two.close();
      const three = openStore({ home: ctx.home, migrations: all.slice(0, 3), migrate: true });
      assert.equal(three.prepare('PRAGMA user_version').get().user_version, 3);
      const names = three.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'otel_%' ORDER BY name").all().map((r) => r.name);
      assert.deepEqual(names, ['otel_event', 'otel_metric', 'otel_metric_line']);
      three.close();
    } finally {
      ctx.cleanup();
    }
  });

  it('creates every table STRICT, with foreign keys to source_file and no identity, content or path column', async () => {
    const { db, close } = await openFresh();
    try {
      for (const t of ['otel_event', 'otel_metric', 'otel_metric_line']) {
        assert.equal(db.prepare('SELECT strict FROM pragma_table_list(?)').get(t).strict, 1, `${t} is STRICT`);
        const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
        assert.ok(fks.some((f) => f.table === 'source_file'), `${t} references source_file`);
        for (const c of db.prepare(`PRAGMA table_info(${t})`).all()) {
          assert.ok(!/^(user|organization|email|account|prompt$|prompt_text|response|command|path|content|text|error|tool_parameters|tool_input)/i.test(c.name), `column ${c.name}`);
        }
      }
      assert.deepEqual(db.prepare('PRAGMA table_info(otel_event)').all().map((c) => c.name), [
        'session_id', 'event_seq', 'event_ts', 'kind', 'ts_utc', 'prompt_id', 'request_id', 'tool_use_id', 'cc_version', 'attrs', 'attrs_sha', 'file_id', 'src_end_offset',
      ]);
      assert.deepEqual(db.prepare('PRAGMA table_info(otel_metric)').all().map((c) => c.name), [
        'ts_utc', 'metric', 'attrs_sha', 'ordinal', 'value', 'session_id', 'cc_version', 'attrs', 'file_id', 'src_end_offset',
      ]);
    } finally {
      close();
    }
  });

  it('has a non-negative check on the sequence and the ordinal and no numeric CHECK on attrs', async () => {
    const { db, w, close } = await openFresh();
    try {
      assert.throws(() => w.writeEvent(evRow({ seq: -1 }), { file_id: 1, src_end_offset: 10 }));
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name IN ('otel_event', 'otel_metric')").all().map((r) => r.sql).join('\n');
      assert.ok(!/CHECK\s*\(\s*attrs/i.test(sql), 'attrs has no CHECK');
      assert.equal(w.writeEvent(evRow({ attrsJson: '{"a":"x","b":-3,"c":1.5}', seq: 2 }), { file_id: 1, src_end_offset: 20 }).inserted, 1);
    } finally {
      close();
    }
  });
});

describe('event writer', () => {
  it('inserts a row with explicit columns and first-seen provenance, and a replay inserts nothing', async () => {
    const { db, w, close } = await openFresh();
    try {
      const first = w.writeEvent(evRow(), { file_id: 1, src_end_offset: 100 });
      assert.deepEqual({ ...first }, { inserted: 1, conflict: false });
      const again = w.writeEvent(evRow(), { file_id: 2, src_end_offset: 555 });
      assert.deepEqual({ ...again }, { inserted: 0, conflict: false });
      assert.equal(n(db, 'SELECT count(*) AS n FROM otel_event'), 1);
      const row = db.prepare('SELECT * FROM otel_event').get();
      assert.deepEqual({ file_id: row.file_id, off: row.src_end_offset, req: row.request_id, prompt: row.prompt_id }, { file_id: 1, off: 100, req: 'req-1', prompt: null });
    } finally {
      close();
    }
  });

  it('a key that exists with different content is a conflict and the stored row is unchanged', async () => {
    const { db, w, close } = await openFresh();
    try {
      w.writeEvent(evRow(), { file_id: 1, src_end_offset: 100 });
      const res = w.writeEvent(evRow({ attrsJson: '{"model":"other"}', attrsSha: 'sha-b' }), { file_id: 1, src_end_offset: 200 });
      assert.deepEqual({ ...res }, { inserted: 0, conflict: true });
      const row = db.prepare('SELECT attrs, attrs_sha FROM otel_event').get();
      assert.deepEqual({ ...row }, { attrs: '{"model":"m"}', attrs_sha: 'sha-a' });
    } finally {
      close();
    }
  });

  it('the four key fields keep rows apart: same session and sequence with another name or timestamp is a new row', async () => {
    const { db, w, close } = await openFresh();
    try {
      w.writeEvent(evRow(), { file_id: 1, src_end_offset: 1 });
      assert.equal(w.writeEvent(evRow({ kind: 'tool_decision' }), { file_id: 1, src_end_offset: 2 }).inserted, 1);
      assert.equal(w.writeEvent(evRow({ eventTs: '2026-10-27T12:00:02.000Z' }), { file_id: 1, src_end_offset: 3 }).inserted, 1);
      assert.equal(n(db, 'SELECT count(*) AS n FROM otel_event'), 3);
    } finally {
      close();
    }
  });

  it('write(record, fileId) takes the offset from the record, counts new rows and calls onConflict on a conflict', async () => {
    const { db, w, close } = await openFresh();
    try {
      let conflicts = 0;
      const rec = (row) => ({ kind: 'event', row, end: 77, onConflict: () => { conflicts += 1; } });
      assert.equal(w.write(rec(evRow()), 1), 1);
      assert.equal(w.write(rec(evRow()), 1), 0);
      assert.equal(conflicts, 0);
      assert.equal(w.write(rec(evRow({ attrsSha: 'sha-z' })), 1), 0);
      assert.equal(conflicts, 1);
      assert.equal(db.prepare('SELECT src_end_offset AS o FROM otel_event').get().o, 77);
    } finally {
      close();
    }
  });
});

describe('metric writer', () => {
  it('a byte-identical pair gets ordinals 0 and 1; a re-read from offset 0 and a replay add nothing', async () => {
    const { db, w, close } = await openFresh();
    try {
      assert.equal(w.writeMetric(mRow(), { file_id: 2, src_end_offset: 100 }).inserted, 1);
      assert.equal(w.writeMetric(mRow(), { file_id: 2, src_end_offset: 200 }).inserted, 1);
      assert.deepEqual(ordinals(db), [0, 1]);
      assert.equal(w.writeMetric(mRow(), { file_id: 2, src_end_offset: 100 }).inserted, 0);
      assert.equal(w.writeMetric(mRow(), { file_id: 2, src_end_offset: 200 }).inserted, 0);
      assert.deepEqual(ordinals(db), [0, 1]);
      assert.equal(n(db, 'SELECT count(*) AS n FROM otel_metric_line'), 2);
    } finally {
      close();
    }
  });

  it('an appended third copy gets ordinal 2, and a copy in another file restarts at 0 and adds nothing', async () => {
    const { db, w, close } = await openFresh();
    try {
      db.exec("INSERT INTO source_file (root_id, rel_path, kind) VALUES (1, 'metrics-copy.jsonl', 'metrics')");
      w.writeMetric(mRow(), { file_id: 2, src_end_offset: 100 });
      w.writeMetric(mRow(), { file_id: 2, src_end_offset: 200 });
      assert.equal(w.writeMetric(mRow(), { file_id: 2, src_end_offset: 300 }).inserted, 1);
      assert.deepEqual(ordinals(db), [0, 1, 2]);
      assert.equal(w.writeMetric(mRow(), { file_id: 3, src_end_offset: 100 }).inserted, 0);
      assert.equal(w.writeMetric(mRow(), { file_id: 3, src_end_offset: 200 }).inserted, 0);
      assert.deepEqual(ordinals(db), [0, 1, 2]);
    } finally {
      close();
    }
  });

  it('a pair split across two runs (one copy, then the next copy later) still gets ordinals 0 and 1', async () => {
    const { db, w, close } = await openFresh();
    try {
      w.writeMetric(mRow(), { file_id: 2, src_end_offset: 100 });
      // A later run re-creates the writer; provenance persists in the table.
      const { createWriter } = await mod('sources/otel/write.mjs');
      const w2 = createWriter(db);
      assert.equal(w2.writeMetric(mRow(), { file_id: 2, src_end_offset: 200 }).inserted, 1);
      assert.deepEqual(ordinals(db), [0, 1]);
    } finally {
      close();
    }
  });

  it('a metric key that exists with a different value is a conflict and the stored value is unchanged; other attrs are separate keys', async () => {
    const { db, w, close } = await openFresh();
    try {
      w.writeMetric(mRow(), { file_id: 2, src_end_offset: 100 });
      const res = w.writeMetric(mRow({ value: 9 }), { file_id: 2, src_end_offset: 100 });
      assert.deepEqual({ ...res }, { inserted: 0, conflict: true });
      assert.equal(n(db, 'SELECT count(*) AS n FROM otel_metric WHERE value = 0.5'), 1);
      assert.equal(w.writeMetric(mRow({ attrsSha: 'sha-other' }), { file_id: 2, src_end_offset: 300 }).inserted, 1);
      assert.equal(n(db, 'SELECT count(*) AS n FROM otel_metric'), 2);
    } finally {
      close();
    }
  });

  it('write(record, fileId) uses the record offset for provenance and onConflict for a value conflict', async () => {
    const { db, w, close } = await openFresh();
    try {
      let conflicts = 0;
      const rec = (row, end) => ({ kind: 'metric', row, end, onConflict: () => { conflicts += 1; } });
      assert.equal(w.write(rec(mRow(), 100), 2), 1);
      assert.equal(w.write(rec(mRow({ value: 3 }), 100), 2), 0);
      assert.equal(conflicts, 1);
      assert.equal(db.prepare('SELECT src_end_offset AS o FROM otel_metric_line').get().o, 100);
    } finally {
      close();
    }
  });
});
