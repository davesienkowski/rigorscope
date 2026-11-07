// Plan 01-12 Task 4 (WR-03, U5, COST-04, RR-08) and review CR-01 (RR-04): migration 006 and the refill of
// has_server_tool_use. Before plan 01-12 the flag stored only that the server_tool_use key was present (the counts
// were never stored), so the migration sets a stored 1 to NULL (unknown), keeps 0 (the old 0 covers an absent key
// and also a present value that was not an object, which the store cannot tell apart) and sets head_hash to NULL on
// the transcript session and subagent files, so the next ingest rereads the files that still exist. The writer's
// merge keeps an unknown against a 0, so the reread refills the flag to 1 where a count is above 0 and leaves it
// NULL otherwise. It deletes no row. The legacy stores are opened with the migration array sliced to the version
// under test.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadMigrations, openStore, storePath } from '../../src/db.mjs';
import { createWriter } from '../../src/sources/transcript/write.mjs';
import {
  makeAssistant, makeHome, makeUsage, mangleHome, queryDb, stateDirOf, windowsUsersDirFor, writeJsonl,
} from '../fixtures/build.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../src/store/migrations/', import.meta.url));
const FILE = fileURLToPath(new URL('../../src/store/migrations/006-server-tool-use-flag.mjs', import.meta.url));

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});
function home() {
  const ctx = makeHome();
  cleanups.push(ctx.cleanup);
  return ctx;
}
const upTo = async (n) => (await loadMigrations(MIGRATIONS)).slice(0, n);
const userVersion = (db) => db.prepare('PRAGMA user_version').get().user_version;
const TABLES = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const counts = (db) => Object.fromEntries(TABLES(db).map((t) => [t, db.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n]));
const dumpAll = (db) => JSON.stringify(TABLES(db).map((t) => db.prepare(`SELECT * FROM "${t}" ORDER BY 1, 2`).all().map((r) => ({ ...r }))));
const flags = (db) => db.prepare('SELECT message_id, has_server_tool_use AS f FROM cc_message ORDER BY message_id').all().map((r) => [r.message_id, r.f]);

// A store at version 5: messages with the flag 1, 0 and NULL, transcript session, subagent and meta files and an
// otel file, each with head_hash set.
async function legacyStore(h) {
  const db = openStore({ home: h, migrations: await upTo(5) });
  assert.equal(userVersion(db), 5);
  db.exec(`
    INSERT INTO source_root (root_id, source, alias, kind, display) VALUES (1, 'transcript', 'claude', 'home', 'claude'), (2, 'otel', 'live', 'dir', 'live');
    INSERT INTO source_file (file_id, root_id, rel_path, kind, offset, head_hash, tail_hash, state) VALUES
      (1, 1, 'p/s.jsonl', 'session', 10, 'h1', 't1', 'ok'),
      (2, 1, 'p/s/subagents/agent-a.jsonl', 'subagent', 10, 'h2', 't2', 'ok'),
      (3, 1, 'p/s/subagents/agent-a.meta.json', 'meta', 10, 'h3', 't3', 'ok'),
      (4, 2, 'metrics-a.jsonl', 'metrics', 10, 'h4', 't4', 'ok');
    INSERT INTO cc_message (session_id, agent_id, message_id, has_server_tool_use) VALUES
      ('s', '', 'm-one', 1), ('s', '', 'm-zero', 0), ('s', '', 'm-null', NULL);
  `);
  return db;
}

describe('migration 006: the module', () => {
  it('exports version 6, equal to its file number, and SQL with no DELETE and no DROP', async () => {
    let mod = null;
    try {
      mod = await import(new URL(`file://${FILE}`).href);
    } catch {
      mod = null;
    }
    assert.ok(mod, 'the migration module exists');
    assert.equal(mod.version, 6);
    assert.equal(typeof mod.sql, 'string');
    assert.doesNotMatch(mod.sql, /\b(DELETE|DROP)\b/i);
  });
});

describe('migration 006: the store', () => {
  it('sets the flag 1 to NULL, keeps 0 and NULL, and raises user_version to 6', async () => {
    const { home: h } = home();
    (await legacyStore(h)).close();
    const db = openStore({ home: h, migrations: await upTo(6), migrate: true });
    try {
      assert.equal(userVersion(db), 6);
      assert.deepEqual(flags(db), [['m-null', null], ['m-one', null], ['m-zero', 0]]);
    } finally {
      db.close();
    }
  });

  it('sets head_hash to NULL on the transcript session and subagent files only', async () => {
    const { home: h } = home();
    (await legacyStore(h)).close();
    const db = openStore({ home: h, migrations: await upTo(6), migrate: true });
    try {
      const rows = db.prepare('SELECT file_id, head_hash, tail_hash FROM source_file ORDER BY file_id').all().map((r) => [r.file_id, r.head_hash, r.tail_hash]);
      assert.deepEqual(rows, [[1, null, 't1'], [2, null, 't2'], [3, 'h3', 't3'], [4, 'h4', 't4']]);
    } finally {
      db.close();
    }
  });

  it('deletes no row, and a second open changes nothing', async () => {
    const { home: h } = home();
    const legacy = await legacyStore(h);
    const before = counts(legacy);
    legacy.close();
    const m6 = await upTo(6);
    const first = openStore({ home: h, migrations: m6, migrate: true });
    assert.equal(userVersion(first), 6);
    assert.deepEqual(counts(first), before);
    const snap = dumpAll(first);
    first.close();
    const again = openStore({ home: h, migrations: m6 });
    try {
      assert.equal(userVersion(again), 6);
      assert.equal(dumpAll(again), snap);
    } finally {
      again.close();
    }
  });
});

// The writer's merge of has_server_tool_use, through the real transcript writer (review CR-01, RR-04):
//   CASE WHEN old = 1 OR new = 1 THEN 1 WHEN old IS NULL OR new IS NULL THEN NULL ELSE 0 END
// A 1 from any copy wins; otherwise an unknown from any copy, in either order, stays unknown (a copy that reported an
// unreadable value may hide a count above 0, so a 0 from another copy cannot answer for it); 0 only when every copy
// stored 0. The writer cannot tell a NULL set by migration 006 from an unknown one, so a migrated NULL followed by a
// reread 0 also stays NULL: over-unknown, never a wrong 0.
describe('migration 006: the NULL-safe upsert of the writer', () => {
  const row = (f) => ({
    session_id: 's', agent_id: '', message_id: 'm', has_iterations: 0, has_server_tool_use: f,
  });
  async function writeSeq(values, { migrations } = {}) {
    const { home: h } = home();
    const db = openStore({ home: h, migrations: migrations ?? await upTo(6) });
    cleanups.push(() => db.close());
    const w = createWriter(db);
    for (const v of values) w.write({ kind: 'message', row: row(v), iterations: [] }, null);
    return db;
  }
  const stored = (db) => db.prepare('SELECT has_server_tool_use AS f FROM cc_message').get().f;

  it('a stored NULL then 0 stays NULL (an unknown is not erased by a 0, in either order)', async () => {
    assert.equal(stored(await writeSeq([null, 0])), null);
  });
  it('a stored NULL then 1 gives 1', async () => {
    assert.equal(stored(await writeSeq([null, 1])), 1);
  });
  it('a stored 0 then an unreadable NULL gives NULL (an unknown is not erased by a 0)', async () => {
    assert.equal(stored(await writeSeq([0, null])), null);
  });
  it('a stored 0, an unreadable NULL, then 0 again stays NULL', async () => {
    assert.equal(stored(await writeSeq([0, null, 0])), null);
  });
  it('a stored 1 then NULL or 0 stays 1 (a 1 is never lost)', async () => {
    assert.equal(stored(await writeSeq([1, null])), 1);
    assert.equal(stored(await writeSeq([1, 0])), 1);
    assert.equal(stored(await writeSeq([0, null, 1])), 1);
  });
  it('the sticky unknown is only for has_server_tool_use: a count column 0 then NULL stays 0', async () => {
    const { home: h } = home();
    const db = openStore({ home: h, migrations: await upTo(6) });
    cleanups.push(() => db.close());
    const w = createWriter(db);
    w.write({ kind: 'message', row: { ...row(0), cache_5m: 0 }, iterations: [] }, null);
    w.write({ kind: 'message', row: { ...row(0), cache_5m: null }, iterations: [] }, null);
    assert.equal(db.prepare('SELECT cache_5m AS v FROM cc_message').get().v, 0);
  });
  it('a stored NULL then NULL stays NULL', async () => {
    assert.equal(stored(await writeSeq([null, null])), null);
  });
  it('a stored 0 then 1 gives 1', async () => {
    assert.equal(stored(await writeSeq([0, 1])), 1);
  });
  it('a stored 1, migrated to NULL by 006, then reread with 0 stays NULL; reread with 1 ends at 1', async () => {
    const { home: h } = home();
    const legacy = openStore({ home: h, migrations: await upTo(5) });
    createWriter(legacy).write({ kind: 'message', row: row(1), iterations: [] }, null);
    assert.equal(stored(legacy), 1);
    legacy.close();
    const db = openStore({ home: h, migrations: await upTo(6), migrate: true });
    cleanups.push(() => db.close());
    assert.equal(stored(db), null, 'migrated to unknown');
    createWriter(db).write({ kind: 'message', row: row(0), iterations: [] }, null);
    assert.equal(stored(db), null, 'a migrated unknown is not erased by a 0');
    createWriter(db).write({ kind: 'message', row: row(1), iterations: [] }, null);
    assert.equal(stored(db), 1);
  });
});

describe('migration 006: the refill by the next ingest', () => {
  it('rereads the files that still exist and refills the flag to 1 from a count above 0; a reread 0 and a message whose file is gone stay NULL', async () => {
    const ctx = home();
    const h = ctx.home;
    const dir = join(ctx.root, 'projects', `${mangleHome(h)}-repos-refill`);
    const line = (session, id, stu, sec) => {
      const use = makeUsage({ input: 1, output: 1, read: 0, creation: 0 });
      use.server_tool_use = stu;
      return JSON.stringify(makeAssistant({ session, ts: `2026-10-27T12:00:0${sec}.000Z`, id, model: 'claude-opus-5-5', use }));
    };
    writeJsonl(join(dir, 'sess-keep.jsonl'), [
      line('sess-keep', 'msg_zero', { web_search_requests: 0 }, 1),
      line('sess-keep', 'msg_two', { web_search_requests: 2 }, 2),
    ]);
    const gone = join(dir, 'sess-gone.jsonl');
    writeJsonl(gone, [line('sess-gone', 'msg_gone', { web_search_requests: 1 }, 3)]);
    const { runIngest } = await import('../../src/ingest/run.mjs');
    const opts = { home: h, env: { HOME: h }, windowsUsersDir: windowsUsersDirFor(h) };
    await runIngest(opts);
    // Make it a store from before migration 006: presence-only flags (every message carried the key, so 1).
    const raw = new DatabaseSync(storePath(h));
    raw.exec('UPDATE cc_message SET has_server_tool_use = 1');
    raw.exec('PRAGMA user_version = 5');
    raw.close();
    rmSync(gone);
    openStore({ home: h, migrations: await upTo(6), migrate: true }).close();
    // Plan 02-01: bring the store to the latest version through the opt-in, so the ingest below (which opens the store
    // without it) does not depend on 006 being the latest migration.
    openStore({ home: h, migrate: true }).close();
    const STORE = join(stateDirOf(h), 'store.db');
    const flagMap = () => Object.fromEntries(queryDb(STORE, 'SELECT message_id, has_server_tool_use AS f FROM cc_message').map((r) => [r.message_id, r.f]));
    assert.deepEqual(flagMap(), { msg_zero: null, msg_two: null, msg_gone: null });
    const summary = await runIngest(opts);
    assert.equal(summary.sources.transcript.reread, 1, 'the session file that still exists is reread');
    assert.deepEqual(flagMap(), { msg_zero: null, msg_two: 1, msg_gone: null });
  });
});
