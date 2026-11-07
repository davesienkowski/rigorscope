// Store side of the usage snapshots (plan 01-06, D-11a, D-04, DATA-03): migration 004, the usage writer, the
// optional `cursorless` descriptor flag of the runner, the usage descriptor and the transcript classification
// of usageReport lines. Written before the code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHome, queryDb, stateDirOf } from '../fixtures/build.mjs';
import { MS, SNAPSHOTS, usageReportLine, writeUsageCache } from '../fixtures/usage-cache.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const MIGRATIONS = fileURLToPath(new URL('../../src/store/migrations/', import.meta.url));
const n = (db, sql, p = []) => db.prepare(sql).get(...p).n;
const throwsMatch = (fn, re) => {
  try {
    fn();
  } catch (err) {
    assert.match(String(err?.message), re);
    return;
  }
  assert.fail('expected a throw');
};

async function freshStore() {
  const ctx = makeHome();
  const { openStore } = await mod('db.mjs');
  const db = openStore({ home: ctx.home });
  return { ctx, db, close: () => { db.close(); ctx.cleanup(); } };
}

const SNAP_E = {
  source: 'claude-json-cache',
  label: 'measured',
  snapshot: {
    fetchedAtMs: MS.h17,
    windows: { five_hour: { pct: 5, resetsMs: MS.h18 }, seven_day: { pct: 51, resetsMs: MS.oct31 }, seven_day_opus: { pct: 12, resetsMs: MS.oct31 }, seven_day_sonnet: null },
    limits: [
      { kind: 'session', grp: 'all', percent: 5, resetsMs: MS.h18, severity: null, isActive: 1 },
      { kind: 'weekly_all', grp: null, percent: 51, resetsMs: MS.oct31, severity: null, isActive: null },
    ],
  },
};

describe('migration 004', () => {
  it('applies on top of a version 3 store and on an empty store, ending at user_version 4 with the two tables', async () => {
    const ctx = makeHome();
    try {
      const { openStore, loadMigrations } = await mod('db.mjs');
      const all = await loadMigrations(MIGRATIONS);
      assert.ok(all.length >= 4);
      assert.equal(all[3].version, 4);
      const three = openStore({ home: ctx.home, migrations: all.slice(0, 3) });
      assert.equal(three.prepare('PRAGMA user_version').get().user_version, 3);
      three.close();
      const four = openStore({ home: ctx.home, migrations: all.slice(0, 4), migrate: true });
      assert.equal(four.prepare('PRAGMA user_version').get().user_version, 4);
      const names = four.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'usage_%' ORDER BY name").all().map((r) => r.name);
      assert.deepEqual(names, ['usage_limit', 'usage_snapshot']);
      for (const t of names) assert.equal(four.prepare('SELECT strict FROM pragma_table_list(?)').get(t).strict, 1, `${t} is STRICT`);
      four.close();
    } finally {
      ctx.cleanup();
    }
  });

  it('has exactly the planned columns and no money, identity, token, session or path column', async () => {
    const { db, close } = await freshStore();
    try {
      assert.deepEqual(db.prepare('PRAGMA table_info(usage_snapshot)').all().map((c) => c.name), [
        'snapshot_id', 'source', 'label', 'fetched_at_ms', 'fetched_utc', 'first_run_id', 'five_hour_pct', 'five_hour_resets_ms',
        'seven_day_pct', 'seven_day_resets_ms', 'seven_day_opus_pct', 'seven_day_opus_resets_ms', 'seven_day_sonnet_pct', 'seven_day_sonnet_resets_ms',
      ]);
      assert.deepEqual(db.prepare('PRAGMA table_info(usage_limit)').all().map((c) => c.name), [
        'snapshot_id', 'seq', 'kind', 'grp', 'percent', 'resets_ms', 'severity', 'is_active',
      ]);
    } finally {
      close();
    }
  });

  it('CHECKs: source set, label tied to source, percentages 0 to 100, a percentage NULL exactly with its instant, unique key', async () => {
    const { db, close } = await freshStore();
    try {
      const ins = (o) => db.prepare(`INSERT INTO usage_snapshot (source, label, fetched_at_ms, fetched_utc, five_hour_pct, five_hour_resets_ms)
        VALUES ($source, $label, $ms, 'x', $pct, $reset)`).run({ source: 'claude-json-cache', label: 'measured', ms: 1, pct: null, reset: null, ...o });
      ins({});
      throwsMatch(() => ins({ ms: 1 }), /UNIQUE/);
      throwsMatch(() => ins({ ms: 2, source: 'other' }), /CHECK/);
      throwsMatch(() => ins({ ms: 3, label: 'transcript' }), /CHECK/);
      ins({ ms: 4, source: 'transcript', label: 'transcript' });
      throwsMatch(() => ins({ ms: 5, source: 'transcript', label: 'measured' }), /CHECK/);
      throwsMatch(() => ins({ ms: 6, pct: 101, reset: 9 }), /CHECK/);
      throwsMatch(() => ins({ ms: 7, pct: 5, reset: null }), /CHECK/);
      throwsMatch(() => ins({ ms: 8, pct: null, reset: 9 }), /CHECK/);
      throwsMatch(() => ins({ ms: 0 }), /CHECK/);
      ins({ ms: 9, pct: 100, reset: 9 });
      const limit = (o) => db.prepare(`INSERT INTO usage_limit (snapshot_id, seq, kind, percent, resets_ms, is_active)
        VALUES (1, $seq, 'k', $p, 1, $a)`).run({ seq: 0, p: 1, a: null, ...o });
      limit({});
      throwsMatch(() => limit({ seq: 1, a: 2 }), /CHECK/);
      throwsMatch(() => limit({ seq: 2, p: -1 }), /CHECK/);
    } finally {
      close();
    }
  });
});

describe('usage writer', () => {
  it('inserts a new snapshot with its limit rows and the run id, and ignores a replay', async () => {
    const { db, close } = await freshStore();
    try {
      const runId = db.prepare("INSERT INTO ingest_run (started_utc, trigger, status) VALUES ('x', 'manual', 'running')").run().lastInsertRowid;
      const { createUsageWriter } = await mod('sources/usage/write.mjs');
      const w = createUsageWriter(db);
      assert.deepEqual(w.insertSnapshot(SNAP_E, { runId: Number(runId) }), { inserted: 1 });
      assert.deepEqual(w.insertSnapshot(SNAP_E, { runId: Number(runId) }), { inserted: 0 });
      const rows = db.prepare('SELECT * FROM usage_snapshot').all().map((r) => ({ ...r }));
      assert.equal(rows.length, 1);
      assert.deepEqual({ ...rows[0], snapshot_id: undefined }, {
        snapshot_id: undefined, source: 'claude-json-cache', label: 'measured', fetched_at_ms: MS.h17, fetched_utc: '2026-10-26T17:00:00.000Z',
        first_run_id: Number(runId), five_hour_pct: 5, five_hour_resets_ms: MS.h18, seven_day_pct: 51, seven_day_resets_ms: MS.oct31,
        seven_day_opus_pct: 12, seven_day_opus_resets_ms: MS.oct31, seven_day_sonnet_pct: null, seven_day_sonnet_resets_ms: null,
      });
      assert.deepEqual(db.prepare('SELECT seq, kind, grp, percent, resets_ms, severity, is_active FROM usage_limit ORDER BY seq').all().map((r) => Object.values(r)), [
        [0, 'session', 'all', 5, MS.h18, null, 1], [1, 'weekly_all', null, 51, MS.oct31, null, null],
      ]);
    } finally {
      close();
    }
  });

  it('write(record, fileId, runId) returns the rows newly inserted and binds a missing run id as NULL', async () => {
    const { db, close } = await freshStore();
    try {
      const { createUsageWriter } = await mod('sources/usage/write.mjs');
      const w = createUsageWriter(db);
      assert.equal(w.write({ kind: 'usage_snapshot', ...SNAP_E }, null), 1);
      assert.equal(w.write({ kind: 'usage_snapshot', ...SNAP_E }, null), 0);
      assert.equal(n(db, 'SELECT count(*) AS n FROM usage_snapshot WHERE first_run_id IS NULL'), 1);
      assert.equal(n(db, 'SELECT count(*) AS n FROM usage_limit'), 2);
    } finally {
      close();
    }
  });
});

describe('the cursorless descriptor flag', () => {
  const writeSource = (dir, name, body) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'index.mjs'), body);
  };

  it('validateDescriptor accepts cursorless true, false or absent and rejects any other type, naming the directory', async () => {
    const { validateDescriptor } = await mod('ingest/sources.mjs');
    const base = {
      name: 'x', freshness: { live: false, staleAfterHours: 1 }, discover() {}, read() {}, normalize() {}, createWriter() {},
    };
    validateDescriptor(base, 'x');
    validateDescriptor({ ...base, cursorless: true }, 'x');
    validateDescriptor({ ...base, cursorless: false }, 'x');
    throwsMatch(() => validateDescriptor({ ...base, cursorless: 'yes' }, 'x'), /source "x": cursorless must be a boolean/);
    throwsMatch(() => validateDescriptor({ ...base, cursorless: 1 }, 'x'), /cursorless/);
  });

  it('a stub cursorless source whose unit path does not exist runs every time with no cursor row, no stat and no hash', async () => {
    const ctx = makeHome();
    const dir = mkdtempSync(join(tmpdir(), 'rigorscope-src-'));
    try {
      writeSource(dir, 'stubless', `
export const name = 'stubless';
export const freshness = { live: false, staleAfterHours: 24 };
export const cursorless = true;
export function discover() { return { roots: [], units: [{ rootAlias: null, rel: 'nowhere', abs: ${JSON.stringify(join(ctx.home, 'does-not-exist'))}, kind: 'x' }] }; }
export function* read() { yield { text: 'one', end: 3 }; }
export function normalize(item) { return { records: [{ text: item.text }] }; }
export function createWriter(db) {
  db.exec('CREATE TABLE IF NOT EXISTS stubless_rows (n INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, run INTEGER) STRICT');
  const ins = db.prepare('INSERT INTO stubless_rows (text, run) VALUES (?, ?)');
  return { write: (rec, fileId, runId) => { ins.run(rec.text, runId ?? null); return 1; } };
}
`);
      const { runIngest } = await mod('ingest/run.mjs');
      const one = await runIngest({ home: ctx.home, env: {}, windowsUsersDir: '', sourcesDir: dir });
      const two = await runIngest({ home: ctx.home, env: {}, windowsUsersDir: '', sourcesDir: dir });
      const q = (sql) => queryDb(join(stateDirOf(ctx.home), 'store.db'), sql);
      assert.deepEqual(q('SELECT text, run FROM stubless_rows ORDER BY n').map((r) => [r.text, r.run]), [['one', one.runId], ['one', two.runId]]);
      assert.equal(q('SELECT count(*) AS n FROM source_root')[0].n, 0);
      assert.equal(q('SELECT count(*) AS n FROM source_file')[0].n, 0);
      assert.deepEqual([one.sources.stubless.files, one.sources.stubless.new, one.sources.stubless.bytes], [1, 1, 3]);
      assert.equal(one.sources.stubless.skipped, 0, 'a missing path is not a walk skip for a cursorless unit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      ctx.cleanup();
    }
  });
});

describe('the usage descriptor', () => {
  it('is name usage, not live, stale after 168 hours, cursorless, and passes validation', async () => {
    const d = await mod('sources/usage/index.mjs');
    const { validateDescriptor } = await mod('ingest/sources.mjs');
    validateDescriptor(d, 'usage');
    assert.equal(d.name, 'usage');
    assert.deepEqual({ ...d.freshness }, { live: false, staleAfterHours: 168 });
    assert.equal(d.cursorless, true);
  });

  it('discover returns one unit and no root even when the file is absent; read yields exactly one item', async () => {
    const ctx = makeHome();
    try {
      const d = await mod('sources/usage/index.mjs');
      const disc = await d.discover({ home: ctx.home, options: {} });
      assert.deepEqual(disc.roots, []);
      assert.equal(disc.units.length, 1);
      const items = [...d.read(disc.units[0], 0, {})];
      assert.equal(items.length, 1);
      assert.equal(items[0].result.status, 'absent');
      writeUsageCache(ctx.home, SNAPSHOTS.A);
      const again = [...d.read(disc.units[0], 0, {})];
      assert.equal(again[0].result.status, 'ok');
      assert.ok(again[0].end > 0);
    } finally {
      ctx.cleanup();
    }
  });

  it('normalize hands an ok snapshot to the writer and counts any other status by name, never an unknown key', async () => {
    const d = await mod('sources/usage/index.mjs');
    const tallies = [];
    const ctx = { tally: (kind, name, k = 1) => tallies.push([kind, name, k]), attr: () => assert.fail('the unknown-name mechanism is never used') };
    const okItem = { result: { status: 'ok', opened: true, bytes: 9, snapshot: SNAP_E.snapshot, rejected: [{ path: 'utilization.limits', n: 2 }] }, end: 9 };
    const res = d.normalize(okItem, {}, ctx);
    assert.equal(res.records.length, 1);
    assert.deepEqual([res.records[0].source, res.records[0].label], ['claude-json-cache', 'measured']);
    assert.deepEqual(tallies, [['rejected_field', 'utilization.limits', 2]]);
    tallies.length = 0;
    const bad = d.normalize({ result: { status: 'unparseable', opened: true, bytes: 4, snapshot: null, rejected: [] }, end: 4 }, {}, ctx);
    assert.deepEqual(bad.records, []);
    assert.ok(tallies.some(([kind, name]) => kind === 'dropped' && name === 'unparseable'));
  });
});

describe('transcript classification of usageReport lines', () => {
  it('a line with both byte markers and no assistant marker is classified usage_report', async () => {
    const { classifyLine } = await mod('sources/transcript/classify.mjs');
    assert.deepEqual(classifyLine({ buf: Buffer.from(usageReportLine(SNAPSHOTS.D)) }), { action: 'usage_report' });
  });

  it('a near miss holding only one of the two markers keeps the earlier classification', async () => {
    const { classifyLine } = await mod('sources/transcript/classify.mjs');
    const onlyReport = Buffer.from(JSON.stringify({ type: 'system', subtype: 'other', usageReport: {} }));
    const onlySubtype = Buffer.from(JSON.stringify({ type: 'system', subtype: 'local_command', content: 'x' }));
    assert.deepEqual(classifyLine({ buf: onlyReport }), { action: 'skip', reason: 'type', type: 'system' });
    assert.deepEqual(classifyLine({ buf: onlySubtype }), { action: 'skip', reason: 'type', type: 'system' });
  });

  it('an assistant line that also holds both markers stays a candidate', async () => {
    const { classifyLine } = await mod('sources/transcript/classify.mjs');
    const buf = Buffer.from('{"type":"assistant","subtype":"local_command","usageReport":1}');
    assert.deepEqual(classifyLine({ buf }), { action: 'candidate' });
  });

  it('transcript normalize turns line D into one usage snapshot record through the report pick seam', async () => {
    const d = await mod('sources/transcript/index.mjs');
    const tallies = [];
    let seen = 0;
    const ctx = {
      tally: (kind, name) => tallies.push([kind, name]), attr: () => assert.fail('no unknown names for a report line'),
      options: { usageReportPick: (line) => { seen += 1; return { status: 'ok', snapshot: { fetchedAtMs: Date.parse(line.timestamp), windows: SNAP_E.snapshot.windows, limits: [] }, rejected: [] }; } },
    };
    const res = d.normalize({ buf: Buffer.from(usageReportLine(SNAPSHOTS.D)), end: 10 }, { kind: 'session' }, ctx);
    assert.equal(seen, 1);
    assert.equal(res.records.length, 1);
    assert.deepEqual([res.records[0].kind, res.records[0].source, res.records[0].label, res.records[0].snapshot.fetchedAtMs], ['usage_snapshot', 'transcript', 'transcript', MS.h16]);
    assert.ok(!tallies.some(([kind]) => kind === 'skipped_type'), 'a consumed report is not a skipped system line');
  });
});
