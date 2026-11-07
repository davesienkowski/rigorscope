// Plan 03-03 (LEDG-03, D-12, ADR-0011): migration 008 adds the `ledger_line` table and its index to store.db and
// changes nothing else. Written before the code (RED). Every test selects migrations by version (m.version <= 7,
// m.version <= 8), never by list length, and never writes the latest store version as a literal.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadMigrations, openStore } from '../../src/db.mjs';
import { makeHome } from '../fixtures/build.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../src/store/migrations/', import.meta.url));
const FILE = fileURLToPath(new URL('../../src/store/migrations/008-ledger-line.mjs', import.meta.url));

// The pin of migration 008's `sql`, set when the DDL was final (plan 03-03). A later change is a new migration.
const FROZEN_008_SQL_SHA256 = '211038a2d8a56bdd7a1245b23d0287f4f93840b53565b43c907bc9d588c460e2';

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});
function home() {
  const ctx = makeHome();
  cleanups.push(ctx.cleanup);
  return ctx.home;
}
const userVersion = (db) => db.prepare('PRAGMA user_version').get().user_version;
const select = async (pred) => (await loadMigrations(MIGRATIONS)).filter(pred);
const master = (db) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all().map((r) => ({ ...r }));

describe('migration 008: the module', () => {
  it('exports version 8, one frozen section, sql equal to the joined sections, and the object names', async () => {
    const mod = await import(pathToFileURL(FILE).href);
    assert.equal(mod.version, 8);
    assert.ok(Object.isFrozen(mod.SECTIONS));
    assert.deepEqual(mod.SECTIONS.map((s) => [s.id, s.plan]), [['ledger-line', '03-03']]);
    for (const s of mod.SECTIONS) {
      assert.ok(Object.isFrozen(s));
      assert.equal(typeof s.sql, 'string');
    }
    assert.equal(mod.sql, mod.SECTIONS.map((s) => s.sql).join('\n'));
    assert.deepEqual([...mod.TABLE_NAMES], ['ledger_line']);
    assert.ok(mod.INDEX_NAMES.length >= 1);
    assert.ok(!/\b(DELETE|DROP|ALTER|UPDATE)\b/i.test(mod.sql), 'only adds: no row is deleted, no table dropped or altered');
    assert.ok(!/\b(branch|cwd|worktree|prompt)\b/i.test(mod.sql), 'no branch, path or text column (ADR-0010)');
    for (const stmt of mod.sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      assert.match(stmt, /IF NOT EXISTS/, 'every CREATE carries IF NOT EXISTS');
    }
  });

  it('the sha256 of sql equals the pinned value', async () => {
    const mod = await import(pathToFileURL(FILE).href);
    assert.match(FROZEN_008_SQL_SHA256, /^[0-9a-f]{64}$/, 'the pin is a sha256 hex');
    assert.equal(createHash('sha256').update(mod.sql).digest('hex'), FROZEN_008_SQL_SHA256);
  });
});

describe('migration 008: applied', () => {
  it('only adds ledger_line: a v7 store reaches 8 with its indexes and a second run changes nothing', async () => {
    const mod = await import(pathToFileURL(FILE).href);
    const h = home();
    const db7 = openStore({ home: h, migrations: await select((m) => m.version <= 7) });
    assert.equal(userVersion(db7), 7);
    db7.exec("INSERT INTO cc_message (session_id, agent_id, message_id, cwd) VALUES ('s', '', 'a', '~/x')");
    const before = master(db7);
    db7.close();

    const db8 = openStore({ home: h, migrations: await select((m) => m.version <= 8), migrate: true });
    let once;
    try {
      assert.equal(userVersion(db8), 8);
      assert.equal(db8.prepare('SELECT count(*) AS n FROM cc_message').get().n, 1, 'no existing row is touched');
      once = master(db8);
      const known = new Set(before.map((r) => `${r.type}\0${r.name}`));
      const added = once.filter((r) => !known.has(`${r.type}\0${r.name}`));
      const expected = new Set([...mod.TABLE_NAMES, ...mod.INDEX_NAMES]);
      for (const r of added) {
        const autoOfNew = r.name.startsWith('sqlite_autoindex_') && mod.TABLE_NAMES.includes(r.tbl_name);
        assert.ok(expected.has(r.name) || autoOfNew, `unexpected object added: ${r.name}`);
      }
      assert.ok(added.some((r) => r.name === 'ledger_line' && r.type === 'table'));
      for (const b of before) {
        assert.deepEqual(once.find((r) => r.type === b.type && r.name === b.name), b, `${b.name} unchanged`);
      }
      assert.equal(db8.prepare('SELECT count(*) AS n FROM ledger_line').get().n, 0);
    } finally {
      db8.close();
    }

    // The rewind pattern of the 005 and 006 tests: user_version back to 7, migrate again through 008.
    const raw = openStore({ home: h, migrations: await select((m) => m.version <= 8) });
    raw.exec('PRAGMA user_version = 7');
    raw.close();
    const again = openStore({ home: h, migrations: await select((m) => m.version <= 8), migrate: true });
    try {
      assert.equal(userVersion(again), 8);
      assert.deepEqual(master(again), once, 'running 008 twice harms nothing');
    } finally {
      again.close();
    }
  });

  it('rejects rows that break a CHECK and keeps the key unique', () => {
    const db = openStore({ home: home() });
    try {
      const ok = {
        line_id: 'a'.repeat(32), line_sha: 'b'.repeat(64), v: 1, record: 'start', ts_utc: '2026-10-28T12:00:00.000Z',
        unit_key: 'gsd-core:~/r/.git:quick:261030-a1b', framework: 'gsd-core', repo_key: '~/r/.git', kind: 'quick',
        native_id: '261030-a1b', tier: 'A', tier_source: 'plan-at-start', first_seen_run: 1,
      };
      const insert = (over) => {
        const row = { ...ok, ...over };
        const cols = Object.keys(row);
        db.prepare(`INSERT INTO ledger_line (${cols.join(', ')}) VALUES (${cols.map((c) => `$${c}`).join(', ')})`).run(row);
      };
      insert({});
      assert.throws(() => insert({}), /constraint/i, 'duplicate line_id');
      const bad = [
        ['line_id too short', { line_id: 'a'.repeat(31) }],
        ['line_id upper case', { line_id: 'A'.repeat(32) }],
        ['line_sha not 64', { line_id: 'c'.repeat(32), line_sha: 'b'.repeat(63) }],
        ['v not 1', { line_id: 'c'.repeat(32), v: 2 }],
        ['record other', { line_id: 'c'.repeat(32), record: 'middle' }],
        ['tier lower case', { line_id: 'c'.repeat(32), tier: 'a' }],
        ['tier_source unknown value', { line_id: 'c'.repeat(32), tier_source: 'guessed' }],
        ['status other', { line_id: 'c'.repeat(32), status: 'done' }],
        ['ts not a time', { line_id: 'c'.repeat(32), ts_utc: 'yesterday' }],
        ['kind other', { line_id: 'c'.repeat(32), kind: 'epic' }],
      ];
      for (const [label, over] of bad) assert.throws(() => insert(over), /constraint/i, label);
      assert.equal(db.prepare('SELECT count(*) AS n FROM ledger_line').get().n, 1);
    } finally {
      db.close();
    }
  });
});
