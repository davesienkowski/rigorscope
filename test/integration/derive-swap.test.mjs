// Plan 01-04 contract: the atomic derived.db rebuild over a read-only snapshot of store.db, the lazy
// ensureDerived decision, and static guards on the derivation code (DATA-02, RR-08, D-12). Written before
// the code (RED).
//
// Assumed shapes (Task 3 implements them):
//   rebuildDerived({ home, now, beforeRename, ownerRule, passVersion })
//   ensureDerived({ home, now, passVersion, ownerRule, force }) -> { rebuilt, reason }
//     reasons: missing, unreadable, pass_version, store_user_version, store_fingerprint, owner_rule, forced
//   storeFingerprint(db) -> 'runs|max run_id|ended runs|max ended_utc'
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  buildFixtureTree, listState, makeHome, runCli, sha256File, stateDirOf,
} from '../fixtures/build.mjs';
import { derivedDigest, insertMessage, openTempStore, queryOrEmpty } from '../fixtures/derive-rows.mjs';
import {
  Db, derivedPath, openDerivedForBuild, openDerivedReadOnly, storePath,
} from '../../src/db.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const NOW = () => new Date('2026-10-28T03:00:00.000Z');

async function ingested(cases = ['iterations']) {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases });
  const r = runCli(['ingest'], { home: ctx.home });
  assert.equal(r.status, 0, 'ingest exit status');
  return ctx;
}

function withDerived(home, fn) {
  const db = openDerivedReadOnly({ home });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const derivedTables = (home) => withDerived(home, (db) => queryOrEmpty(
  db, "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
));
const digestOf = (home) => withDerived(home, (db) => derivedDigest(db));
const stateOf = (home) => withDerived(home, (db) => queryOrEmpty(db, 'SELECT * FROM derive_state')[0] ?? {});

function writable(file, fn) {
  const db = new Db(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe('atomic swap', () => {
  it('a throw before the rename keeps the derived.db with the three tables byte-identical and leaves no temp file', async () => {
    const ctx = await ingested();
    try {
      const { rebuildDerived } = await mod('derive/rebuild.mjs');
      rebuildDerived({ home: ctx.home, now: NOW });
      // Plan 01-06 added window_interval, api_call_part_window and usage_latest; 02-02 repo_label and unit; 02-05
      // unit_role; 02-07 link_scope, unit_link, scope_attribution, unit_attribution and unit_confounder.
      assert.deepEqual(derivedTables(ctx.home).map((t) => t.name).sort(), ['api_call', 'api_call_part', 'api_call_part_window', 'derive_state', 'join_stat', 'link_scope', 'otel_call', 'repo_label', 'repo_scan_count', 'scope_attribution', 'unit', 'unit_attribution', 'unit_confounder', 'unit_link', 'unit_role', 'usage_latest', 'window_interval']);
      const before = sha256File(derivedPath(ctx.home));
      assert.throws(
        () => rebuildDerived({ home: ctx.home, now: NOW, beforeRename: () => { throw new Error('boom-before-rename'); } }),
        /boom-before-rename/,
      );
      assert.equal(sha256File(derivedPath(ctx.home)), before);
      assert.deepEqual(listState(ctx.home).filter((n) => n.includes('.tmp')), []);
    } finally {
      ctx.cleanup();
    }
  });

  it('a stale file named like the temp file neither blocks a rebuild nor is promoted', async () => {
    const ctx = await ingested();
    try {
      const { rebuildDerived } = await mod('derive/rebuild.mjs');
      const { ensureStateDir } = await mod('db.mjs');
      const dir = ensureStateDir(ctx.home);
      writeFileSync(join(dir, `derived.db.${process.pid}.tmp`), 'JUNK-not-a-database');
      writeFileSync(join(dir, `derived.db.${process.pid}.tmp-journal`), 'JUNK-journal');
      rebuildDerived({ home: ctx.home, now: NOW });
      assert.equal(readFileSync(derivedPath(ctx.home)).subarray(0, 16).toString('latin1'), 'SQLite format 3\0');
      assert.equal(withDerived(ctx.home, (db) => queryOrEmpty(db, 'SELECT count(*) AS n FROM api_call_part'))[0]?.n, 3);
      assert.deepEqual(listState(ctx.home).filter((n) => n.includes('.tmp')), []);
    } finally {
      ctx.cleanup();
    }
  });

  it('derived.db is mode 0600 and holds exactly api_call, api_call_part and derive_state, each STRICT', async () => {
    const ctx = await ingested();
    try {
      const { rebuildDerived } = await mod('derive/rebuild.mjs');
      rebuildDerived({ home: ctx.home, now: NOW });
      assert.equal(statSync(derivedPath(ctx.home)).mode & 0o777, 0o600);
      assert.deepEqual(derivedTables(ctx.home).slice().sort((a, b) => (a.name < b.name ? -1 : 1)), [
        { name: 'api_call', strict: 1 }, { name: 'api_call_part', strict: 1 }, { name: 'api_call_part_window', strict: 1 },
        { name: 'derive_state', strict: 1 }, { name: 'join_stat', strict: 1 }, { name: 'link_scope', strict: 1 },
        { name: 'otel_call', strict: 1 }, { name: 'repo_label', strict: 1 }, { name: 'repo_scan_count', strict: 1 }, { name: 'scope_attribution', strict: 1 },
        { name: 'unit', strict: 1 }, { name: 'unit_attribution', strict: 1 }, { name: 'unit_confounder', strict: 1 },
        { name: 'unit_link', strict: 1 }, { name: 'unit_role', strict: 1 },
        { name: 'usage_latest', strict: 1 }, { name: 'window_interval', strict: 1 },
      ]); // plan 01-06 added the three window tables; 01-07 otel_call and join_stat; 02-02 repo_label and unit; 02-05 unit_role;
      // 02-07 link_scope, unit_link, scope_attribution, unit_attribution and unit_confounder; 03.1-02 repo_scan_count
    } finally {
      ctx.cleanup();
    }
  });

  it('records the pass version, owner rule, store version and store fingerprint in derive_state', async () => {
    const ctx = await ingested();
    try {
      const { rebuildDerived } = await mod('derive/rebuild.mjs');
      const { PASS_VERSION } = await mod('derive/schema.mjs');
      rebuildDerived({ home: ctx.home, now: NOW, ownerRule: 'latest' });
      const st = stateOf(ctx.home);
      assert.equal(st.pass_version, PASS_VERSION);
      assert.ok(PASS_VERSION >= 2, 'PASS_VERSION is above the 01-01 value');
      assert.equal(st.owner_rule, 'latest');
      // The latest store migration (plan 01-12 made this the loader's last version instead of a literal, so a new
      // migration does not break the test; it was 4 after plan 01-06 and 3 after 01-03).
      const { loadMigrations } = await mod('db.mjs');
      const migrations = await loadMigrations(join(SRC, 'store', 'migrations'));
      assert.equal(st.store_user_version, migrations[migrations.length - 1].version);
      assert.match(String(st.store_fingerprint), /^1\|1\|1\|\d{4}-\d{2}-\d{2}T/);
      assert.equal(st.built_utc, '2026-10-28T03:00:00.000Z');
    } finally {
      ctx.cleanup();
    }
  });

  it('rebuilding twice from the same store gives the same content digest', async () => {
    const ctx = await ingested(['derive-dups', 'derive-roles-iter']);
    try {
      const { rebuildDerived } = await mod('derive/rebuild.mjs');
      rebuildDerived({ home: ctx.home, now: NOW });
      const a = digestOf(ctx.home);
      rebuildDerived({ home: ctx.home, now: () => new Date('2026-10-29T00:00:00.000Z') });
      assert.equal(digestOf(ctx.home), a);
      assert.equal(stateOf(ctx.home).api_call_part_rows, 15);
    } finally {
      ctx.cleanup();
    }
  });

  it('two rebuilds in parallel child processes both finish and leave one valid derived.db with the solo digest', async () => {
    const ctx = await ingested(['derive-roles-iter']);
    try {
      const url = pathToFileURL(join(SRC, 'derive/rebuild.mjs')).href;
      const script = 'const m = await import(process.env.RS_MOD); m.rebuildDerived({ home: process.env.RS_HOME });';
      const child = () => new Promise((resolve, reject) => {
        const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
          env: { HOME: ctx.home, RS_HOME: ctx.home, RS_MOD: url, PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'ignore', 'pipe'],
        });
        let err = '';
        c.stderr.on('data', (d) => { err += d; });
        c.on('error', reject);
        c.on('close', (status) => resolve({ status, err }));
      });
      const [a, b] = await Promise.all([child(), child()]);
      assert.equal(a.status, 0, 'first child');
      assert.equal(b.status, 0, 'second child');
      assert.equal(statSync(derivedPath(ctx.home)).mode & 0o777, 0o600);
      const parallel = digestOf(ctx.home);
      const { rebuildDerived } = await mod('derive/rebuild.mjs');
      rebuildDerived({ home: ctx.home });
      assert.equal(digestOf(ctx.home), parallel);
      assert.equal(stateOf(ctx.home).api_call_rows, 10);
      assert.equal(stateOf(ctx.home).api_call_part_rows, 12);
      assert.deepEqual(listState(ctx.home).filter((n) => n.includes('.tmp')), []);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('read-only snapshot', () => {
  it('a write through the read-only attach is rejected and the store row counts are unchanged', async () => {
    const ctx = await ingested();
    try {
      const count = () => writable(storePath(ctx.home), (db) => db.prepare('SELECT count(*) AS n FROM cc_message').get().n);
      const before = count();
      const tmp = join(stateDirOf(ctx.home), 'probe-attach.db');
      const db = openDerivedForBuild({ tmpPath: tmp, home: ctx.home });
      try {
        assert.throws(() => db.exec("INSERT INTO s.ingest_run (started_utc, trigger) VALUES ('x', 'y')"), /readonly/);
        assert.throws(() => db.exec('DELETE FROM s.cc_message'), /readonly/);
      } finally {
        db.close();
      }
      assert.equal(count(), before);
    } finally {
      ctx.cleanup();
    }
  });

  it('an uncommitted store write is neither waited for nor visible; once committed the next ensureDerived picks it up', async () => {
    const ctx = await ingested();
    try {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      assert.equal(ensureDerived({ home: ctx.home }).rebuilt, true, 'first ensure builds');
      const w = new Db(storePath(ctx.home), { timeout: 0 });
      try {
        w.exec('BEGIN IMMEDIATE');
        insertMessage(w, {
          session_id: 'sess-late', message_id: 'msg_late', model: 'claude-opus-5-5', ts_utc: '2026-10-27T20:00:00.000Z',
          input_tokens: 1, output_tokens: 1, cache_read: 1, cache_creation: 1,
        });
        w.exec("INSERT INTO ingest_run (started_utc, ended_utc, trigger) VALUES ('2026-10-28T04:00:00.000Z', '2026-10-28T04:00:01.000Z', 'manual')");
        const t0 = Date.now();
        const unchanged = ensureDerived({ home: ctx.home });
        const forced = ensureDerived({ home: ctx.home, force: true });
        assert.ok(Date.now() - t0 < 2500, 'no wait on the writer');
        assert.equal(unchanged.rebuilt, false, 'the uncommitted run is not visible to the staleness check');
        assert.equal(forced.reason, 'forced');
        const late = withDerived(ctx.home, (db) => queryOrEmpty(db, "SELECT count(*) AS n FROM api_call WHERE message_id = 'msg_late'"));
        assert.equal(late[0]?.n, 0, 'the uncommitted message is not in derived.db');
        w.exec('COMMIT');
      } finally {
        if (w.isTransaction) w.exec('ROLLBACK');
        w.close();
      }
      const after = ensureDerived({ home: ctx.home });
      assert.deepEqual(after, { rebuilt: true, reason: 'store_fingerprint' });
      const late = withDerived(ctx.home, (db) => queryOrEmpty(db, "SELECT count(*) AS n FROM api_call WHERE message_id = 'msg_late'"));
      assert.equal(late[0]?.n, 1);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('ensureDerived', () => {
  it('builds a missing derived.db and reports reason missing', async () => {
    const ctx = await ingested();
    try {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      assert.deepEqual(ensureDerived({ home: ctx.home }), { rebuilt: true, reason: 'missing' });
      assert.ok(existsSync(derivedPath(ctx.home)));
    } finally {
      ctx.cleanup();
    }
  });

  it('does not rebuild on unchanged inputs: the second call leaves derived.db byte-identical', async () => {
    const ctx = await ingested();
    try {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      assert.equal(ensureDerived({ home: ctx.home }).rebuilt, true);
      const before = sha256File(derivedPath(ctx.home));
      const digest = digestOf(ctx.home);
      assert.deepEqual(ensureDerived({ home: ctx.home }), { rebuilt: false, reason: null });
      assert.equal(sha256File(derivedPath(ctx.home)), before);
      assert.equal(digestOf(ctx.home), digest);
    } finally {
      ctx.cleanup();
    }
  });

  it('rebuilds when the pass version differs (reason pass_version)', async () => {
    const ctx = await ingested();
    try {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      const { PASS_VERSION } = await mod('derive/schema.mjs');
      assert.equal(ensureDerived({ home: ctx.home }).rebuilt, true);
      assert.deepEqual(ensureDerived({ home: ctx.home, passVersion: PASS_VERSION + 1 }), { rebuilt: true, reason: 'pass_version' });
      assert.equal(stateOf(ctx.home).pass_version, PASS_VERSION + 1);
    } finally {
      ctx.cleanup();
    }
  });

  it('rebuilds when the recorded store user_version differs (reason store_user_version)', async () => {
    const ctx = await ingested();
    try {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      assert.equal(ensureDerived({ home: ctx.home }).rebuilt, true);
      writable(derivedPath(ctx.home), (db) => db.exec('UPDATE derive_state SET store_user_version = store_user_version - 1'));
      assert.deepEqual(ensureDerived({ home: ctx.home }), { rebuilt: true, reason: 'store_user_version' });
    } finally {
      ctx.cleanup();
    }
  });

  it('rebuilds after another ingest run (reason store_fingerprint)', async () => {
    const ctx = await ingested();
    try {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      assert.equal(ensureDerived({ home: ctx.home }).rebuilt, true);
      assert.equal(runCli(['ingest'], { home: ctx.home }).status, 0);
      assert.deepEqual(ensureDerived({ home: ctx.home }), { rebuilt: true, reason: 'store_fingerprint' });
    } finally {
      ctx.cleanup();
    }
  });

  it('rebuilds a corrupt derived.db (reason unreadable)', async () => {
    const ctx = await ingested();
    try {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      assert.equal(ensureDerived({ home: ctx.home }).rebuilt, true);
      writeFileSync(derivedPath(ctx.home), 'JUNK-not-a-database-at-all');
      assert.deepEqual(ensureDerived({ home: ctx.home }), { rebuilt: true, reason: 'unreadable' });
      assert.equal(withDerived(ctx.home, (db) => queryOrEmpty(db, 'SELECT count(*) AS n FROM api_call'))[0]?.n, 2);
    } finally {
      ctx.cleanup();
    }
  });

  it('rebuilds when forced or when the owner rule differs', async () => {
    const ctx = await ingested();
    try {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      assert.equal(ensureDerived({ home: ctx.home }).rebuilt, true);
      assert.deepEqual(ensureDerived({ home: ctx.home, force: true }), { rebuilt: true, reason: 'forced' });
      assert.deepEqual(ensureDerived({ home: ctx.home, ownerRule: 'latest' }), { rebuilt: true, reason: 'owner_rule' });
      assert.equal(stateOf(ctx.home).owner_rule, 'latest');
    } finally {
      ctx.cleanup();
    }
  });

  it('on a HOME with no ingest builds a schema-only store and an empty derived.db', async () => {
    const ctx = makeHome();
    try {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      assert.deepEqual(ensureDerived({ home: ctx.home }), { rebuilt: true, reason: 'missing' });
      assert.ok(existsSync(storePath(ctx.home)), 'schema-only store created');
      const st = stateOf(ctx.home);
      assert.equal(st.api_call_rows, 0);
      assert.equal(st.api_call_part_rows, 0);
      assert.equal(st.store_fingerprint, '0||0|');
    } finally {
      ctx.cleanup();
    }
  });

  it('storeFingerprint joins run count, last run id, ended runs and last end time', async () => {
    const ctx = makeHome();
    try {
      const { storeFingerprint } = await mod('derive/ensure.mjs');
      const db = openTempStore({ home: ctx.home });
      try {
        db.exec("INSERT INTO ingest_run (run_id, started_utc, ended_utc, trigger) VALUES (1, '2026-10-28T01:00:00.000Z', '2026-10-28T01:00:05.000Z', 'manual')");
        const one = storeFingerprint(db);
        db.exec("INSERT INTO ingest_run (run_id, started_utc, trigger) VALUES (2, '2026-10-28T02:00:00.000Z', 'manual')");
        const open = storeFingerprint(db);
        db.exec("UPDATE ingest_run SET ended_utc = '2026-10-28T02:00:05.000Z' WHERE run_id = 2");
        const ended = storeFingerprint(db);
        assert.equal(one, '1|1|1|2026-10-28T01:00:05.000Z');
        assert.equal(open, '2|2|1|2026-10-28T01:00:05.000Z');
        assert.equal(ended, '2|2|2|2026-10-28T02:00:05.000Z');
      } finally {
        db.close();
      }
    } finally {
      ctx.cleanup();
    }
  });
});

describe('static guards on the derivation and report code', () => {
  const WRITE_TO_S = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+s\./i;
  const files = (dir) => readdirSync(join(SRC, dir)).filter((n) => n.endsWith('.mjs')).map((n) => join(SRC, dir, n));

  it('the write-to-schema-s pattern has teeth', () => {
    for (const s of ['INSERT INTO s.cc_message', 'insert or ignore into s.x', 'UPDATE s.ingest_run', 'DELETE FROM s.cc_message', 'CREATE INDEX IF NOT EXISTS s.i', 'DROP TABLE s.t']) {
      assert.match(s, WRITE_TO_S);
    }
    assert.doesNotMatch('SELECT * FROM s.cc_message', WRITE_TO_S);
  });

  it('no statement under src/derive names a write target in schema s, and the derive modules exist', () => {
    const names = readdirSync(join(SRC, 'derive')).sort();
    for (const n of ['build.mjs', 'conservation.mjs', 'ensure.mjs', 'owner.mjs', 'parts.mjs', 'rebuild.mjs', 'role.mjs', 'schema.mjs']) {
      assert.ok(names.includes(n), `src/derive/${n} exists`);
    }
    for (const f of files('derive')) assert.doesNotMatch(readFileSync(f, 'utf8'), WRITE_TO_S, f.slice(SRC.length));
    const rebuild = readFileSync(join(SRC, 'derive/rebuild.mjs'), 'utf8');
    assert.ok(rebuild.includes('BEGIN IMMEDIATE'), 'one write transaction over one snapshot');
    assert.ok(rebuild.includes('fillDerived'), 'the fill runs inside the rebuild');
  });

  it('nothing under src/derive or src/report reads the run-level sub-agent token total', () => {
    for (const f of [...files('derive'), ...files('report')]) {
      const text = readFileSync(f, 'utf8');
      assert.ok(!/total_tokens|totalTokens|subagent_completed/.test(text), f.slice(SRC.length));
    }
  });
});
