// Plan 01-12 Task 3 (WR-02, T-01-23, RR-08): migration 005 forces a reread of every OTel file. It only sets
// head_hash to NULL on the source_file rows of the otel source; it deletes no row. The cursor logic then classifies
// each such file as rewritten and rereads it from offset 0, and the OTel writer's onReread hook replaces the file's
// provenance rows (Task 2). The legacy stores are opened with the migration array sliced to the version under test,
// so each asserted user_version stays true when a later migration exists.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadMigrations, openStore, storePath } from '../../src/db.mjs';
import { makeHome, queryDb, sha256, stateDirOf, windowsUsersDirFor } from '../fixtures/build.mjs';
import { buildOtelTree } from '../fixtures/otel.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../src/store/migrations/', import.meta.url));
const FILE = fileURLToPath(new URL('../../src/store/migrations/005-otel-provenance-reread.mjs', import.meta.url));

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});
function home() {
  const ctx = makeHome();
  cleanups.push(ctx.cleanup);
  return ctx.home;
}
const upTo = async (n) => (await loadMigrations(MIGRATIONS)).slice(0, n);

const TABLES = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const counts = (db) => Object.fromEntries(TABLES(db).map((t) => [t, db.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n]));
const dump = (db, t) => db.prepare(`SELECT * FROM "${t}" ORDER BY 1, 2`).all().map((r) => ({ ...r }));
const userVersion = (db) => db.prepare('PRAGMA user_version').get().user_version;

// A store at version 4 with two otel files, one transcript file and duplicated provenance rows for one file.
async function legacyStore(h) {
  const db = openStore({ home: h, migrations: await upTo(4) });
  assert.equal(userVersion(db), 4);
  db.exec(`
    INSERT INTO source_root (root_id, source, alias, kind, display) VALUES
      (1, 'otel', 'live', 'dir', 'live'), (2, 'otel', 'preserve', 'dir', 'preserve'), (3, 'transcript', 'home', 'dir', 'home');
    INSERT INTO source_file (file_id, root_id, rel_path, kind, dev, ino, size, mtime_ms, offset, head_hash, tail_hash, state) VALUES
      (10, 1, 'metrics-a.jsonl', 'metrics', '1', '100', 300, 5, 300, 'h-live', 't-live', 'ok'),
      (11, 2, 'metrics-a.jsonl', 'metrics', '1', '101', 210, 6, 210, 'h-pres', 't-pres', 'ok'),
      (12, 3, 'p/s.jsonl', 'session', '1', '102', 50, 7, 50, 'h-tr', 't-tr', 'ok');
    INSERT INTO otel_metric_line (file_id, src_end_offset, ts_utc, metric, attrs_sha) VALUES
      (11, 110, 't', 'm', 'a'), (11, 210, 't', 'm', 'a'), (11, 100, 't', 'm', 'a'), (11, 200, 't', 'm', 'a'),
      (10, 150, 't', 'm', 'b');
  `);
  return db;
}

describe('migration 005: reread every OTel file', () => {
  it('exports version 5, equal to its file number, and SQL with no DELETE and no DROP', async () => {
    let mod = null;
    try {
      mod = await import(new URL(`file://${FILE}`).href);
    } catch {
      mod = null;
    }
    assert.ok(mod, 'the migration module exists');
    assert.equal(mod.version, 5);
    assert.equal(typeof mod.sql, 'string');
    assert.doesNotMatch(mod.sql, /\b(DELETE|DROP)\b/i);
  });

  it('raises user_version to 5 and sets head_hash to NULL on the otel source_file rows only', async () => {
    const h = home();
    (await legacyStore(h)).close();
    const db = openStore({ home: h, migrations: await upTo(5), migrate: true });
    try {
      assert.equal(userVersion(db), 5);
      const rows = db.prepare('SELECT file_id, head_hash, tail_hash, offset, state FROM source_file ORDER BY file_id').all().map((r) => ({ ...r }));
      assert.deepEqual(rows, [
        { file_id: 10, head_hash: null, tail_hash: 't-live', offset: 300, state: 'ok' },
        { file_id: 11, head_hash: null, tail_hash: 't-pres', offset: 210, state: 'ok' },
        { file_id: 12, head_hash: 'h-tr', tail_hash: 't-tr', offset: 50, state: 'ok' },
      ]);
    } finally {
      db.close();
    }
  });

  it('deletes no row: every table keeps its row count, and the provenance rows are untouched by the migration itself', async () => {
    const h = home();
    const legacy = await legacyStore(h);
    const before = counts(legacy);
    const lines = dump(legacy, 'otel_metric_line');
    legacy.close();
    const db = openStore({ home: h, migrations: await upTo(5), migrate: true });
    try {
      assert.equal(userVersion(db), 5);
      assert.deepEqual(counts(db), before);
      assert.deepEqual(dump(db, 'otel_metric_line'), lines);
    } finally {
      db.close();
    }
  });

  it('a second open changes nothing', async () => {
    const h = home();
    (await legacyStore(h)).close();
    const m5 = await upTo(5);
    const first = openStore({ home: h, migrations: m5, migrate: true });
    const snap = JSON.stringify(TABLES(first).map((t) => dump(first, t)));
    assert.equal(userVersion(first), 5);
    first.close();
    const again = openStore({ home: h, migrations: m5 });
    try {
      assert.equal(userVersion(again), 5);
      assert.equal(JSON.stringify(TABLES(again).map((t) => dump(again, t))), snap);
    } finally {
      again.close();
    }
  });

  it('end to end: the next ingest rereads every OTel file, replaces stale provenance, keeps otel_metric, then reads 0 bytes', async () => {
    const h = home();
    buildOtelTree(h, { preserve: true });
    const { runIngest } = await import('../../src/ingest/run.mjs');
    const opts = { home: h, env: { HOME: h }, windowsUsersDir: windowsUsersDirFor(h) };
    await runIngest(opts);
    const STORE = join(stateDirOf(h), 'store.db');
    const q = (sql) => queryDb(STORE, sql);
    const otelFiles = q("SELECT count(*) AS n FROM source_file f JOIN source_root r ON r.root_id = f.root_id WHERE r.source = 'otel'")[0].n;
    assert.ok(otelFiles >= 2);
    const provenance = q('SELECT file_id, count(*) AS n FROM otel_metric_line GROUP BY file_id ORDER BY file_id').map((r) => ({ ...r }));
    const metricDigest = () => sha256(JSON.stringify(q('SELECT ts_utc, metric, attrs_sha, ordinal, value, attrs FROM otel_metric ORDER BY 1, 2, 3, 4')));
    const digestBefore = metricDigest();
    // Make the store look like one from before migration 005 that holds stale provenance of an earlier pass.
    const raw = new DatabaseSync(storePath(h));
    raw.exec(`INSERT INTO otel_metric_line (file_id, src_end_offset, ts_utc, metric, attrs_sha)
              SELECT file_id, src_end_offset + 1000000, ts_utc, metric, attrs_sha FROM otel_metric_line`);
    raw.exec('PRAGMA user_version = 4');
    raw.close();
    openStore({ home: h, migrations: await upTo(5), migrate: true }).close();
    assert.equal(q("SELECT count(*) AS n FROM source_file f JOIN source_root r ON r.root_id = f.root_id WHERE r.source = 'otel' AND f.head_hash IS NULL")[0].n, otelFiles);
    // Plan 02-01: bring the store to the latest version through the opt-in, so the ingest below (which opens the store
    // without it) does not depend on 005 or 006 being the latest migration.
    openStore({ home: h, migrate: true }).close();
    const summary = await runIngest(opts);
    assert.equal(summary.sources.otel.reread, otelFiles, 'every OTel file is reread once');
    assert.deepEqual(q('SELECT file_id, count(*) AS n FROM otel_metric_line GROUP BY file_id ORDER BY file_id').map((r) => ({ ...r })), provenance);
    assert.equal(metricDigest(), digestBefore, 'otel_metric is unchanged');
    const third = await runIngest(opts);
    assert.equal(third.sources.otel.bytes, 0);
    assert.equal(third.sources.otel.reread, 0);
  });
});
