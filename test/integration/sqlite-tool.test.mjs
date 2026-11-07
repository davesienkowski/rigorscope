// Plan 01-08 contract (RPT-02): store.db and derived.db of a fully ingested HOME open read-only in a second process
// (through the repo's read-only openers) and in the sqlite3 CLI, with equal per-table row counts, integrity ok, every
// table STRICT, documented SQL blocks that run in the CLI, snapshot behavior across a rebuild, and byte-identical
// files across the reads. Written before the code (RED): two cases fail until Tasks 3 and 5. The sqlite3 cases skip
// with a visible reason when the CLI is absent. Characterization cases (they pass on the existing code) say so in
// their title. No planted value is printed in a failure message.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFixtureTree, cliEnv, makeHome, runCli, sha256File, stateDirOf,
} from '../fixtures/build.mjs';
import { DST_NOW } from '../fixtures/clock.mjs';
import { insertMessage, openTempStore } from '../fixtures/derive-rows.mjs';
import { Db, derivedPath, openDerivedReadOnly, openStore, openStoreReadOnly, storePath } from '../../src/db.mjs';

const READER = fileURLToPath(new URL('../fixtures/sqlite-reader.mjs', import.meta.url));
const DOCS = fileURLToPath(new URL('../../docs/data-model.md', import.meta.url));
const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);

const cliVersion = (() => {
  const r = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split(/\s+/)[0] : null;
})();
const SKIP_CLI = cliVersion === null ? 'the sqlite3 CLI is not installed' : false;

// A function that lists the tables that are not STRICT, from PRAGMA table_list rows.
export const nonStrict = (rows) => rows.filter((r) => r.schema === 'main' && !r.name.startsWith('sqlite_') && r.type === 'table' && r.strict !== 1).map((r) => r.name);

const sqlite3 = (file, sql) => spawnSync('sqlite3', ['-readonly', file], { input: sql, encoding: 'utf8' });
const reader = (home, mode, ...rest) => {
  const r = spawnSync(process.execPath, [READER, home, mode, ...rest], { encoding: 'utf8', env: cliEnv(home) });
  return { status: r.status, stderr: r.stderr, out: r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
};

function describeDb(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  return { tables, counts: Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n])) };
}
const parentView = (home) => {
  const s = openStoreReadOnly({ home });
  const d = openDerivedReadOnly({ home });
  try { return { store: describeDb(s), derived: describeDb(d) }; } finally { s.close(); d.close(); }
};
const cliCounts = (file, tables) => Object.fromEntries(tables.map((t) => [t, Number(sqlite3(file, `SELECT count(*) FROM "${t}";`).stdout.trim())]));
const digests = (home) => [sha256File(storePath(home)), sha256File(derivedPath(home))];

describe('sqlite tool', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    await buildFixtureTree(ctx.root, { home: ctx.home, cases: 'all' });
    assert.equal(runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home) }).status, 0, 'ingest exit status');
    assert.equal(runCli(['cost'], { home: ctx.home, env: cliEnv(ctx.home) }).status, 0, 'cost exit status');
  });
  after(() => ctx.cleanup());

  it('a second process reads both databases read-only with the same per-table row counts as the parent (characterization)', () => {
    const child = reader(ctx.home, 'snapshot');
    assert.equal(child.status, 0);
    const view = parentView(ctx.home);
    assert.deepEqual(child.out[0].store.counts, view.store.counts);
    assert.deepEqual(child.out[0].derived.counts, view.derived.counts);
    assert.ok(Object.keys(view.store.counts).length > 5 && Object.keys(view.derived.counts).length > 5);
  });

  it('the second process sees integrity_check ok and every table STRICT in both databases (characterization)', () => {
    const c = reader(ctx.home, 'snapshot').out[0];
    for (const db of [c.store, c.derived]) {
      assert.deepEqual(db.integrity, ['ok']);
      assert.deepEqual(Object.entries(db.strict).filter(([, v]) => v !== 1), []);
    }
  });

  it('the STRICT check function names a fabricated non-STRICT table (control)', () => {
    assert.deepEqual(nonStrict([{ schema: 'main', name: 'loose', type: 'table', strict: 0 }, { schema: 'main', name: 'tight', type: 'table', strict: 1 }]), ['loose']);
    const mem = new Db(':memory:');
    mem.exec('CREATE TABLE loose (a INTEGER); CREATE TABLE tight (a INTEGER) STRICT;');
    assert.deepEqual(nonStrict(mem.prepare('PRAGMA table_list').all().map((r) => ({ ...r }))), ['loose']);
    mem.close();
  });

  it('every table of store.db and derived.db is STRICT through PRAGMA table_list (characterization)', () => {
    for (const open of [openStoreReadOnly, openDerivedReadOnly]) {
      const db = open({ home: ctx.home });
      try { assert.deepEqual(nonStrict(db.prepare('PRAGMA table_list').all().map((r) => ({ ...r }))), []); } finally { db.close(); }
    }
  });

  // Plan 02-02 (D-09): repo_key, the git-resolved key the display groups by.
  it('derived.db carries the dimension columns ts_ms, repo, repo_rule and repo_key', () => {
    const db = openDerivedReadOnly({ home: ctx.home });
    try {
      const cols = db.prepare('PRAGMA table_info(api_call)').all().map((r) => r.name);
      for (const c of ['ts_ms', 'repo', 'repo_rule', 'repo_key']) assert.ok(cols.includes(c), 'api_call column present');
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'api_call_section_ts_idx'").all();
      assert.equal(idx.length, 1);
    } finally { db.close(); }
  });

  it('opening both databases read-only five times changes no byte of either file (characterization)', () => {
    const before1 = digests(ctx.home);
    for (let i = 0; i < 5; i += 1) parentView(ctx.home);
    assert.deepEqual(digests(ctx.home), before1);
  });

  it('the cost, cost --json and evidence commands run twice change no byte and print identical output', () => {
    const env = cliEnv(ctx.home, { RIGORSCOPE_NOW: DST_NOW });
    const before1 = digests(ctx.home);
    for (const args of [['cost'], ['cost', '--json'], ['evidence', 'main/total']]) {
      const a = runCli(args, { home: ctx.home, env });
      const b = runCli(args, { home: ctx.home, env });
      assert.equal(a.status, 0, `exit status of ${args[0]}`);
      assert.equal(a.stdout, b.stdout);
    }
    assert.deepEqual(digests(ctx.home), before1);
  });

  describe('sqlite3 CLI', { skip: SKIP_CLI }, () => {
    it(`records the CLI version ${cliVersion} and lists the tables of both databases`, (t) => {
      t.diagnostic(`sqlite3 CLI ${cliVersion}, in-process SQLite ${process.versions.sqlite}`);
      const view = parentView(ctx.home);
      const got = (file) => sqlite3(file, '.tables').stdout.split(/\s+/).filter(Boolean).sort();
      assert.deepEqual(got(storePath(ctx.home)), view.store.tables);
      assert.deepEqual(got(derivedPath(ctx.home)), view.derived.tables);
    });

    it('PRAGMA integrity_check and quick_check print ok on both files (characterization)', () => {
      for (const file of [storePath(ctx.home), derivedPath(ctx.home)]) {
        assert.equal(sqlite3(file, 'PRAGMA integrity_check;').stdout.trim(), 'ok');
        assert.equal(sqlite3(file, 'PRAGMA quick_check;').stdout.trim(), 'ok');
      }
    });

    it('per-table row counts in the CLI equal the parent counts for both files (characterization)', () => {
      const view = parentView(ctx.home);
      assert.deepEqual(cliCounts(storePath(ctx.home), view.store.tables), view.store.counts);
      assert.deepEqual(cliCounts(derivedPath(ctx.home), view.derived.tables), view.derived.counts);
    });

    it('PRAGMA table_list in the CLI shows every table STRICT, which holds on the 3.45 CLI too (characterization)', () => {
      for (const file of [storePath(ctx.home), derivedPath(ctx.home)]) {
        const out = sqlite3(file, '.mode list\nSELECT name, strict FROM pragma_table_list WHERE schema = \'main\' AND type = \'table\' AND name NOT LIKE \'sqlite_%\';').stdout;
        const bad = out.split('\n').filter(Boolean).map((l) => l.split('|')).filter(([, s]) => s !== '1');
        assert.deepEqual(bad, []);
      }
    });

    it('the documented SQL blocks run in the sqlite3 CLI', () => {
      const text = existsSync(DOCS) ? readFileSync(DOCS, 'utf8') : '';
      const blocks = [...text.matchAll(/```sql\n(-- db: (store|derived)\n[\s\S]*?)```/g)].map((m) => ({ db: m[2], sql: m[1] }));
      assert.ok(blocks.length >= 3, 'at least three documented SQL blocks');
      for (const b of blocks) {
        assert.equal(b.sql.includes('rs_local_day'), false, 'no block calls the day function');
        const file = b.db === 'store' ? storePath(ctx.home) : derivedPath(ctx.home);
        const r = sqlite3(file, b.sql);
        assert.equal(r.status, 0, 'block exit status');
        assert.equal(r.stderr, '', 'block stderr is empty');
      }
    });

    it('an uncommitted writer transaction on store.db does not disturb the child or the CLI (committed counts, no BUSY)', () => {
      const view = parentView(ctx.home);
      const w = openStore({ home: ctx.home });
      w.exec('BEGIN IMMEDIATE');
      w.prepare("INSERT INTO ingest_run (started_utc, trigger) VALUES ('2026-11-03T00:00:00.000Z', 'test')").run();
      try {
        const child = reader(ctx.home, 'snapshot');
        assert.equal(child.status, 0);
        assert.deepEqual(child.out[0].store.counts, view.store.counts);
        const r = sqlite3(storePath(ctx.home), 'SELECT count(*) FROM ingest_run;');
        assert.equal(r.status, 0);
        assert.equal(r.stderr, '');
        assert.equal(Number(r.stdout.trim()), view.store.counts.ingest_run);
      } finally { w.exec('ROLLBACK'); w.close(); }
    });

    it('opening the files through the CLI changes no byte of either file (characterization)', () => {
      const before1 = digests(ctx.home);
      for (const f of [storePath(ctx.home), derivedPath(ctx.home)]) sqlite3(f, 'SELECT count(*) FROM sqlite_master;');
      assert.deepEqual(digests(ctx.home), before1);
    });
  });

  it('a reader holding a snapshot of derived.db keeps its counts across a rebuild by rename and a new open sees the new file', async () => {
    const own = makeHome();
    try {
      const db = openTempStore({ home: own.home });
      const base = { session_id: 'sess-h', model: 'claude-haiku-5-5', input_tokens: 1, output_tokens: 1, cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0, ts_utc: '2026-11-01T10:00:00.000Z' };
      insertMessage(db, { ...base, message_id: 'msg_h1' });
      const { rebuildDerived } = await mod('derive/rebuild.mjs');
      rebuildDerived({ home: own.home, now: () => new Date(DST_NOW) });
      const signal = join(own.home, 'signal');
      const child = spawn(process.execPath, [READER, own.home, 'hold', signal], { env: cliEnv(own.home) });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      await new Promise((resolve) => { const t = setInterval(() => { if (out.includes('ready')) { clearInterval(t); resolve(); } }, 20); });
      insertMessage(db, { ...base, message_id: 'msg_h2' });
      db.close();
      rebuildDerived({ home: own.home, now: () => new Date(DST_NOW) });
      writeFileSync(signal, 'go');
      await new Promise((resolve) => { child.on('close', resolve); });
      const lines = out.trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual([lines[1].first, lines[1].second], [1, 1], 'the held snapshot keeps its count');
      const fresh = openDerivedReadOnly({ home: own.home });
      try { assert.equal(fresh.prepare('SELECT count(*) AS n FROM api_call').get().n, 2, 'a new open sees the rebuilt file'); } finally { fresh.close(); }
    } finally { own.cleanup(); }
  });

  it('the state directory holds no temporary derived file after all the reads and rebuilds (characterization)', () => {
    const names = readdirSync(stateDirOf(ctx.home));
    assert.ok(names.includes('store.db') && names.includes('derived.db'));
    assert.deepEqual(names.filter((n) => n.endsWith('.tmp') || n.endsWith('-journal')), []);
  });
});
