// src/db.mjs guards: state directory, migrations, attach, import boundary. Written before the module.
//
// Assumed API (the contract Task 2 implements):
//   loadMigrations(dir)            async -> [{ version, sql, name }], throws on a gap or a duplicate
//   openStore({ home, migrations })  sync -> Db handle; `migrations` defaults to the repo's own list
//   openStoreReadOnly({ home }), openDerivedForBuild({ tmpPath, home }), openDerivedReadOnly({ home })
//   checkpointStore({ home })      sync; ensureStateDir(home) -> state dir path
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeHome, sha256File, stateDirOf } from '../fixtures/build.mjs';

const load = () => import(new URL('../../src/db.mjs', import.meta.url).href);
// The latest migration version of the repo (it grows with each plan that adds a migration).
async function latestVersion() {
  const { loadMigrations } = await load();
  const list = await loadMigrations(new URL('../../src/store/migrations/', import.meta.url).pathname);
  return list[list.length - 1].version;
}

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});
function home() {
  const ctx = makeHome();
  cleanups.push(ctx.cleanup);
  return ctx.home;
}
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const mode = (p) => statSync(p).mode & 0o777;
// Every schema object of a database file as sorted [type, name] pairs, through a read-only connection.
function schemaOf(file) {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return raw.prepare('SELECT type, name FROM sqlite_master ORDER BY type, name').all().map((r) => [r.type, r.name]);
  } finally {
    raw.close();
  }
}

describe('state directory', () => {
  it('stateDir, storePath and derivedPath sit under HOME/.rigorscope', async () => {
    const { stateDir, storePath, derivedPath } = await load();
    const h = home();
    assert.equal(stateDir(h), stateDirOf(h));
    assert.equal(storePath(h), join(stateDirOf(h), 'store.db'));
    assert.equal(derivedPath(h), join(stateDirOf(h), 'derived.db'));
  });

  it('ensureStateDir creates the directory with mode 0700 even under umask 022', async () => {
    const { ensureStateDir } = await load();
    const h = home();
    const old = process.umask(0o022);
    try {
      const dir = ensureStateDir(h);
      assert.equal(dir, stateDirOf(h));
      assert.equal(mode(dir), 0o700);
    } finally {
      process.umask(old);
    }
  });

  it('openStore creates store.db with mode 0600 even under umask 022', async () => {
    const { openStore, storePath } = await load();
    const h = home();
    const old = process.umask(0o022);
    try {
      const db = openStore({ home: h });
      db.close();
      assert.equal(mode(storePath(h)), 0o600);
    } finally {
      process.umask(old);
    }
  });

  it('refuses a symlinked state directory with StateDirError and writes nothing through it', async () => {
    const { ensureStateDir, openStore, StateDirError } = await load();
    const h = home();
    const target = scratch('rigorscope-target-');
    symlinkSync(target, stateDirOf(h));
    assert.throws(() => ensureStateDir(h), StateDirError);
    assert.throws(() => openStore({ home: h }), StateDirError);
    assert.deepEqual(readdirSync(target), [], 'nothing was written through the link');
  });

  it('refuses a state path that is a regular file with StateDirError', async () => {
    const { ensureStateDir, StateDirError } = await load();
    const h = home();
    writeFileSync(stateDirOf(h), 'not a directory');
    assert.throws(() => ensureStateDir(h), StateDirError);
  });

  it('the StateDirError message is one line and holds no path', async () => {
    const { ensureStateDir } = await load();
    const h = home();
    writeFileSync(stateDirOf(h), 'x');
    try {
      ensureStateDir(h);
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(!/[\r\n]/.test(err.message));
      assert.ok(!err.message.includes(h), 'no path in the message');
    }
  });
});

describe('openStore and migrations', () => {
  it('sets WAL, a busy timeout of at least 5000 ms, foreign keys on and the latest user_version', async () => {
    const { openStore } = await load();
    const db = openStore({ home: home() });
    try {
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.ok(db.prepare('PRAGMA busy_timeout').get().timeout >= 5000);
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, await latestVersion());
    } finally {
      db.close();
    }
  });

  it('migration 001 creates exactly ingest_run and cc_message, both STRICT', async () => {
    const { openStore, loadMigrations } = await load();
    const first = (await loadMigrations(new URL('../../src/store/migrations/', import.meta.url).pathname)).slice(0, 1);
    const db = openStore({ home: home(), migrations: first });
    try {
      const tables = db.prepare(
        "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all().map((r) => ({ ...r }));
      assert.deepEqual(tables, [{ name: 'cc_message', strict: 1 }, { name: 'ingest_run', strict: 1 }]);
      const pk = db.prepare("SELECT name FROM pragma_table_info('cc_message') WHERE pk > 0 ORDER BY pk").all().map((r) => r.name);
      assert.deepEqual(pk, ['session_id', 'agent_id', 'message_id']);
    } finally {
      db.close();
    }
  });

  it('opening twice keeps the latest user_version and works with a second open connection', async () => {
    const { openStore } = await load();
    const h = home();
    const a = openStore({ home: h });
    const b = openStore({ home: h });
    try {
      assert.equal(b.prepare('PRAGMA user_version').get().user_version, await latestVersion());
    } finally {
      a.close();
      b.close();
    }
  });

  it('the repo migration directory loads as a contiguous list starting at version 1', async () => {
    const { loadMigrations } = await load();
    const list = await loadMigrations(new URL('../../src/store/migrations/', import.meta.url).pathname);
    assert.ok(list.length >= 1);
    list.forEach((m, i) => assert.equal(m.version, i + 1));
    assert.equal(typeof list[0].sql, 'string');
  });

  it('loadMigrations throws on a gap and on a duplicate version', async () => {
    const { loadMigrations } = await load();
    const mk = (files) => {
      const dir = scratch('rigorscope-mig-');
      for (const [name, version] of files) {
        writeFileSync(join(dir, name), `export const version = ${version};\nexport const sql = 'CREATE TABLE t${version} (a INTEGER) STRICT;';\n`);
      }
      return dir;
    };
    await assert.rejects(loadMigrations(mk([['001-a.mjs', 1], ['003-c.mjs', 3]])), /gap|contiguous/i);
    await assert.rejects(loadMigrations(mk([['001-a.mjs', 1], ['001-b.mjs', 1]])), /duplicate/i);
    const ok = await loadMigrations(mk([['001-a.mjs', 1], ['002-b.mjs', 2], ['003-c.mjs', 3]]));
    assert.deepEqual(ok.map((m) => m.version), [1, 2, 3]);
  });

  it('refuses a store whose user_version is above the latest migration, naming both numbers', async () => {
    const { openStore, storePath, StoreTooNewError } = await load();
    const latest = await latestVersion();
    const h = home();
    openStore({ home: h }).close();
    const raw = new DatabaseSync(storePath(h));
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    assert.throws(() => openStore({ home: h }), (err) => {
      assert.ok(err instanceof StoreTooNewError);
      assert.match(err.message, /99/);
      assert.match(err.message, new RegExp(`\\b${latest}\\b`));
      assert.ok(!/[\r\n]/.test(err.message));
      return true;
    });
  });

  it('applies a pending migration in place and rolls a failing one back, leaving the schema as it was', async () => {
    const { openStore, loadMigrations } = await load();
    const h = home();
    const dir = scratch('rigorscope-mig2-');
    const real = new URL('../../src/store/migrations/', import.meta.url).pathname;
    for (const f of readdirSync(real)) writeFileSync(join(dir, f), readFileSync(join(real, f)));
    openStore({ home: h }).close();
    const next = (await latestVersion()) + 1;
    writeFileSync(join(dir, `${String(next).padStart(3, '0')}-bad.mjs`), `export const version = ${next};\nexport const sql = 'CREATE TABLE ok_before_fail (a INTEGER) STRICT; THIS IS NOT SQL;';\n`);
    const bad = await loadMigrations(dir);
    // Plan 02-01: the store already exists at the latest version, so the bad migration is pending and the open opts in;
    // the throw must be the SQL error of the bad migration, not the pending-migration refusal.
    assert.throws(() => openStore({ home: h, migrations: bad, migrate: true }), (err) => {
      assert.notEqual(err.name, 'StoreMigrationPendingError');
      assert.match(String(err.message), /syntax error|near "THIS"/i);
      return true;
    });
    const raw = new DatabaseSync(join(h, '.rigorscope', 'store.db'));
    try {
      assert.equal(raw.prepare('PRAGMA user_version').get().user_version, next - 1);
      assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'ok_before_fail'").get().n, 0);
    } finally {
      raw.close();
    }
    // A new file name: ESM caches modules by URL, so rewriting 002-bad.mjs would re-load the bad one.
    rmSync(join(dir, `${String(next).padStart(3, '0')}-bad.mjs`));
    writeFileSync(join(dir, `${String(next).padStart(3, '0')}-good.mjs`), `export const version = ${next};\nexport const sql = 'CREATE TABLE extra (a INTEGER) STRICT;';\n`);
    const good = await loadMigrations(dir);
    const db = openStore({ home: h, migrations: good, migrate: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, next);
    } finally {
      db.close();
    }
  });
});

// Plan 02-01 (D-23 Q9): the opt-in guard. An existing store whose user_version is between 1 and latest-1 is refused
// without the `migrate` option, before any write; a fresh store (user_version 0) still gets every migration. The new
// exports are read from the module namespace, never imported by name, so a missing export fails an assertion here.
describe('opt-in migration guard', () => {
  const MIG = new URL('../../src/store/migrations/', import.meta.url).pathname;
  async function pending(h) {
    const { openStore, loadMigrations, storePath } = await load();
    const all = await loadMigrations(MIG);
    const latest = all[all.length - 1].version;
    openStore({ home: h, migrations: all.slice(0, latest - 1) }).close();
    return { latest, sha: sha256File(storePath(h)) };
  }
  const versionOf = (file) => {
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      return raw.prepare('PRAGMA user_version').get().user_version;
    } finally {
      raw.close();
    }
  };

  it('a store one migration behind is refused with StoreMigrationPendingError and keeps its bytes and version', async () => {
    const mod = await load();
    const h = home();
    const { latest, sha } = await pending(h);
    let caught = null;
    try {
      mod.openStore({ home: h }).close();
    } catch (err) {
      caught = err;
    }
    assert.ok(caught !== null, 'openStore without the option throws on a pending store');
    assert.equal(caught.name, 'StoreMigrationPendingError');
    assert.equal(caught.code, 'migration_pending');
    assert.equal(typeof mod.StoreMigrationPendingError, 'function', 'StoreMigrationPendingError is exported');
    assert.ok(caught instanceof mod.StoreMigrationPendingError);
    assert.equal(caught.from, latest - 1);
    assert.equal(caught.to, latest);
    assert.ok(!/[\r\n]/.test(caught.message), 'one line');
    assert.match(caught.message, new RegExp(`\\b${latest - 1}\\b`));
    assert.match(caught.message, new RegExp(`\\b${latest}\\b`));
    assert.ok(caught.message.includes('migration pending, back up first'));
    assert.ok(!caught.message.includes('/'), 'no path in the message');
    assert.equal(sha256File(mod.storePath(h)), sha, 'main-file bytes unchanged');
    assert.equal(versionOf(mod.storePath(h)), latest - 1, 'user_version unchanged');
  });

  it('the same store reaches the latest version when the migrate option is set', async () => {
    const { openStore } = await load();
    const h = home();
    const { latest } = await pending(h);
    const db = openStore({ home: h, migrate: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, latest);
    } finally {
      db.close();
    }
  });

  it('a store.db at user_version 0 gets every migration with no option and no backup', async () => {
    const { openStore, ensureStateDir, storePath } = await load();
    const h = home();
    ensureStateDir(h);
    new DatabaseSync(storePath(h)).close();
    assert.equal(versionOf(storePath(h)), 0);
    const db = openStore({ home: h });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, await latestVersion());
    } finally {
      db.close();
    }
    assert.deepEqual(readdirSync(stateDirOf(h)).filter((n) => n === 'backups'), []);
  });

  it('a store newer than this rigorscope is refused with StoreTooNewError also when the migrate option is set', async () => {
    const { openStore, storePath, StoreTooNewError } = await load();
    const latest = await latestVersion();
    const h = home();
    openStore({ home: h }).close();
    const raw = new DatabaseSync(storePath(h));
    raw.exec(`PRAGMA user_version = ${latest + 1}`);
    raw.close();
    const sha = sha256File(storePath(h));
    assert.throws(() => openStore({ home: h, migrate: true }), (err) => err instanceof StoreTooNewError);
    assert.equal(sha256File(storePath(h)), sha);
  });

  it('a store.db at user_version 0 that already holds a table is not fresh: refused without the option, nothing applied', async () => {
    const { openStore, ensureStateDir, storePath } = await load();
    const h = home();
    ensureStateDir(h);
    const raw = new DatabaseSync(storePath(h));
    raw.exec('CREATE TABLE not_ours (a INTEGER) STRICT');
    raw.close();
    const sha = sha256File(storePath(h));
    assert.throws(() => openStore({ home: h }), (err) => {
      assert.equal(err.name, 'StoreMigrationPendingError');
      assert.equal(err.from, 0);
      return true;
    });
    assert.equal(sha256File(storePath(h)), sha, 'main-file bytes unchanged');
    assert.deepEqual(schemaOf(storePath(h)), [['table', 'not_ours']], 'no migration object was created');
    assert.equal(versionOf(storePath(h)), 0);
  });

  it('LATEST_STORE_VERSION equals the last loaded migration version and DEFAULT_MIGRATIONS is the frozen loaded list', async () => {
    const mod = await load();
    const latest = await latestVersion();
    assert.equal(mod.LATEST_STORE_VERSION, latest);
    assert.ok(Array.isArray(mod.DEFAULT_MIGRATIONS), 'DEFAULT_MIGRATIONS is exported');
    assert.equal(mod.DEFAULT_MIGRATIONS.length, latest);
    assert.ok(Object.isFrozen(mod.DEFAULT_MIGRATIONS));
  });
});

// Review 02-01 WR-02: openStore judges "fresh" (user_version 0, no tables) inside the same write transaction that
// applies the migrations, so another process that creates the store between this open's first read and its write lock
// cannot make it apply a pending migration without the option. The race is made deterministic in one process (SQLite
// locks two connections of one process like two processes): Db.prototype.exec is wrapped so that the first
// `BEGIN IMMEDIATE` of the connection under test first runs the other "process" to completion. That point lies after
// openStore's version read and its PRAGMAs and before its write lock, the window the review reproduced with two
// processes. Each test restores exec in a finally.
describe('fresh-store creation is judged inside its write transaction (review WR-02)', () => {
  const MIG = new URL('../../src/store/migrations/', import.meta.url).pathname;
  const versionOf = (file) => {
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      return raw.prepare('PRAGMA user_version').get().user_version;
    } finally {
      raw.close();
    }
  };
  // Runs `during` once, just before the first exec whose SQL is `sql` (or, with after: true, just after it). The hook
  // is disarmed before `during` runs, so connections that `during` opens pass straight through.
  function interpose(Db, sql, during, { after = false } = {}) {
    const orig = Db.prototype.exec;
    let armed = true;
    Db.prototype.exec = function exec(text) {
      if (armed && text === sql && !after) {
        armed = false;
        during();
      }
      const res = orig.call(this, text);
      if (armed && text === sql && after) {
        armed = false;
        during();
      }
      return res;
    };
    return () => {
      Db.prototype.exec = orig;
    };
  }
  // What an older checkout's openStore does on a fresh file: WAL, one write lock, its migrations, its version.
  function createAt(Db, file, migrations) {
    const b = new Db(file, { timeout: 5000 });
    try {
      b.exec('PRAGMA journal_mode = WAL');
      b.exec('BEGIN IMMEDIATE');
      for (const m of migrations) b.exec(m.sql);
      b.exec(`PRAGMA user_version = ${migrations[migrations.length - 1].version}`);
      b.exec('COMMIT');
    } finally {
      b.close();
    }
  }
  // The schema a store built from `migrations` on a fresh HOME has (the reference for "nothing more was applied").
  async function referenceSchema(migrations) {
    const { openStore, storePath } = await load();
    const h = home();
    openStore({ home: h, migrations }).close();
    return schemaOf(storePath(h));
  }

  it('an older process creating the store at latest-1 inside the window: StoreMigrationPendingError, nothing applied', async () => {
    const mod = await load();
    const all = await mod.loadMigrations(MIG);
    const latest = all[all.length - 1].version;
    const h = home();
    const file = mod.storePath(h);
    const restore = interpose(mod.Db, 'BEGIN IMMEDIATE', () => createAt(mod.Db, file, all.slice(0, latest - 1)));
    let caught = null;
    try {
      mod.openStore({ home: h }).close();
    } catch (err) {
      caught = err;
    } finally {
      restore();
    }
    assert.ok(caught !== null, `openStore without the option must refuse; user_version is now ${versionOf(file)}`);
    assert.equal(caught.name, 'StoreMigrationPendingError');
    assert.equal(caught.from, latest - 1);
    assert.equal(caught.to, latest);
    assert.equal(versionOf(file), latest - 1, 'user_version stays latest-1');
    assert.deepEqual(schemaOf(file), await referenceSchema(all.slice(0, latest - 1)), 'no object of the pending migration');
  });

  it('a same-version process creating the store at latest inside the window: the open succeeds and applies nothing', async () => {
    const mod = await load();
    const all = await mod.loadMigrations(MIG);
    const latest = all[all.length - 1].version;
    const h = home();
    const file = mod.storePath(h);
    const restore = interpose(mod.Db, 'BEGIN IMMEDIATE', () => createAt(mod.Db, file, all));
    try {
      const db = mod.openStore({ home: h });
      try {
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, latest);
      } finally {
        db.close();
      }
    } finally {
      restore();
    }
    assert.deepEqual(schemaOf(file), await referenceSchema(all));
  });

  it('a first-ever open never exposes an intermediate version: an open at the creator\'s first commit is not refused', async () => {
    // `cost` or `doctor` running while the first `ingest` creates the store must see a fresh or a latest store, never
    // one at 1..latest-1 that it would refuse as "migration pending".
    const mod = await load();
    const latest = mod.LATEST_STORE_VERSION;
    const h = home();
    let seen = null;
    const restore = interpose(mod.Db, 'COMMIT', () => {
      try {
        const c = mod.openStore({ home: h });
        seen = c.prepare('PRAGMA user_version').get().user_version;
        c.close();
      } catch (err) {
        seen = err;
      }
    }, { after: true });
    try {
      mod.openStore({ home: h }).close();
    } finally {
      restore();
    }
    assert.ok(!(seen instanceof Error), `the concurrent open threw ${seen?.name}: ${seen?.message}`);
    assert.equal(seen, latest);
    assert.equal(versionOf(mod.storePath(h)), latest);
  });

  it('a migration that fails on a fresh store rolls the whole creation back: user_version 0 and no tables', async () => {
    const { openStore, loadMigrations, storePath } = await load();
    const h = home();
    const dir = scratch('rigorscope-mig-fresh-');
    const real = new URL('../../src/store/migrations/', import.meta.url).pathname;
    for (const f of readdirSync(real)) writeFileSync(join(dir, f), readFileSync(join(real, f)));
    const next = (await latestVersion()) + 1;
    writeFileSync(join(dir, `${String(next).padStart(3, '0')}-bad.mjs`), `export const version = ${next};\nexport const sql = 'CREATE TABLE ok_before_fail (a INTEGER) STRICT; THIS IS NOT SQL;';\n`);
    const bad = await loadMigrations(dir);
    assert.throws(() => openStore({ home: h, migrations: bad }), (err) => {
      assert.match(String(err.message), /syntax error|near "THIS"/i);
      return true;
    });
    assert.equal(versionOf(storePath(h)), 0);
    assert.deepEqual(schemaOf(storePath(h)), []);
  });
});

describe('attach and read-only connections', () => {
  it('openDerivedForBuild attaches store.db read-only as schema s; reads work, a write through s is rejected', async () => {
    const { openStore, openDerivedForBuild, ensureStateDir } = await load();
    const h = home(); // the path holds a space and a hash character
    const store = openStore({ home: h });
    store.prepare("INSERT INTO cc_message (session_id, agent_id, message_id) VALUES ('s', '', 'm')").run();
    store.close();
    const tmpPath = join(ensureStateDir(h), 'derived.test.tmp');
    const db = openDerivedForBuild({ tmpPath, home: h });
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM s.cc_message').get().n, 1);
      assert.throws(
        () => db.prepare("INSERT INTO s.cc_message (session_id, agent_id, message_id) VALUES ('x', '', 'y')").run(),
        /readonly|read-only|attempt to write/i,
      );
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete', 'derived build uses the rollback journal');
    } finally {
      db.close();
    }
    assert.deepEqual(readdirSync(stateDirOf(h)).filter((n) => /-(wal|shm|journal)$/.test(n) && n.startsWith('derived')), []);
  });

  it('openStoreReadOnly rejects writes', async () => {
    const { openStore, openStoreReadOnly } = await load();
    const h = home();
    openStore({ home: h }).close();
    const ro = openStoreReadOnly({ home: h });
    try {
      assert.throws(() => ro.exec("INSERT INTO ingest_run (started_utc, trigger) VALUES ('t', 'x')"), /readonly|read-only/i);
    } finally {
      ro.close();
    }
  });

  it('a read-only connection sees the pre-write count while another holds an uncommitted write (WAL)', async () => {
    const { openStore, openStoreReadOnly } = await load();
    const h = home();
    const writer = openStore({ home: h });
    writer.prepare("INSERT INTO cc_message (session_id, agent_id, message_id) VALUES ('s', '', 'm1')").run();
    const ro = openStoreReadOnly({ home: h });
    try {
      writer.exec('BEGIN IMMEDIATE');
      writer.prepare("INSERT INTO cc_message (session_id, agent_id, message_id) VALUES ('s', '', 'm2')").run();
      assert.equal(ro.prepare('SELECT count(*) AS n FROM cc_message').get().n, 1, 'pre-write snapshot, no busy error');
      writer.exec('COMMIT');
      assert.equal(ro.prepare('SELECT count(*) AS n FROM cc_message').get().n, 2);
    } finally {
      ro.close();
      writer.close();
    }
  });

  it('openDerivedReadOnly opens a built derived.db read-only', async () => {
    const { openStore, openDerivedForBuild, openDerivedReadOnly, derivedPath, ensureStateDir } = await load();
    const h = home();
    openStore({ home: h }).close();
    const tmpPath = join(ensureStateDir(h), 'derived.db.t.tmp');
    const build = openDerivedForBuild({ tmpPath, home: h });
    build.exec('CREATE TABLE t (a INTEGER) STRICT');
    build.close();
    renameSync(tmpPath, derivedPath(h));
    const ro = openDerivedReadOnly({ home: h });
    try {
      assert.equal(ro.prepare('SELECT count(*) AS n FROM t').get().n, 0);
      assert.throws(() => ro.exec('INSERT INTO t VALUES (1)'), /readonly|read-only/i);
    } finally {
      ro.close();
    }
  });

  it('checkpointStore leaves no WAL content behind', async () => {
    const { openStore, checkpointStore, storePath } = await load();
    const h = home();
    const db = openStore({ home: h });
    db.prepare("INSERT INTO cc_message (session_id, agent_id, message_id) VALUES ('s', '', 'm')").run();
    db.close();
    checkpointStore({ home: h });
    const raw = new DatabaseSync(storePath(h), { readOnly: true });
    try {
      assert.equal(raw.prepare('SELECT count(*) AS n FROM cc_message').get().n, 1);
    } finally {
      raw.close();
    }
  });

  it('Db is a constructor usable as new Db(":memory:")', async () => {
    const { Db } = await load();
    const d = new Db(':memory:');
    d.exec('CREATE TABLE t (a INTEGER)');
    assert.equal(d.prepare('SELECT count(*) AS n FROM t').get().n, 0);
    d.close();
  });
});

describe('import boundary (static scan of src)', () => {
  const SRC = new URL('../../src/', import.meta.url).pathname;
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : []
  ));
  const sqliteImport = /(?:from\s+|import\(\s*|require\(\s*)['"]node:sqlite['"]/;
  const netImport = /(?:from\s+|import\(\s*|require\(\s*)['"](?:node:)?(?:http|https|http2|net|dgram|tls|dns)(?:\/promises)?['"]/;

  it('only src/db.mjs imports the built-in sqlite module', () => {
    const files = walk(SRC);
    assert.ok(files.length > 0);
    const importers = files.filter((f) => sqliteImport.test(readFileSync(f, 'utf8')));
    assert.deepEqual(importers.map((f) => f.slice(SRC.length)), ['db.mjs']);
  });

  it('no file under src imports a networking module', () => {
    const files = walk(SRC);
    assert.ok(files.length > 0, 'src holds modules to scan');
    const offenders = files.filter((f) => netImport.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders.map((f) => f.slice(SRC.length)), []);
  });

  it('no file under src spawns the claude binary', () => {
    const spawnClaude = /(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*['"]claude['"]/;
    const files = walk(SRC);
    assert.ok(files.length > 0, 'src holds modules to scan');
    const offenders = files.filter((f) => spawnClaude.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders.map((f) => f.slice(SRC.length)), []);
  });
});

// Plan 01-12 Task 1: the two exports the backup helper reaches SQLite through.
//   backupDatabase(source, destPath)  -> Promise of the page count; one-step online backup; EEXIST for an existing dest
//   openCopyReadOnly(path)            read-only immutable open of a file no process writes (no sidecar, no write)
describe('backupDatabase and openCopyReadOnly', () => {
  // A WAL store with rows that exist only in the -wal file; the writer stays open until the test ends.
  function walStore() {
    const dir = scratch('rigorscope-bk-');
    const live = join(dir, 'live.db');
    const w = new DatabaseSync(live);
    cleanups.push(() => w.close());
    w.exec('PRAGMA journal_mode = WAL');
    w.exec("CREATE TABLE t (a TEXT) STRICT; INSERT INTO t VALUES ('main');");
    w.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    w.exec('PRAGMA wal_autocheckpoint = 0');
    w.exec("INSERT INTO t VALUES ('wal-only')");
    assert.ok(statSync(`${live}-wal`).size > 0);
    return { dir, live };
  }

  it('backupDatabase copies a WAL store including its uncheckpointed rows and resolves with the page count', async () => {
    const { backupDatabase } = await load();
    assert.equal(typeof backupDatabase, 'function', 'backupDatabase is exported');
    const { dir, live } = walStore();
    const src = new DatabaseSync(live, { readOnly: true });
    try {
      const pending = backupDatabase(src, join(dir, 'copy.db'));
      assert.ok(pending instanceof Promise, 'returns a promise');
      const pages = await pending;
      assert.ok(Number.isInteger(pages) && pages > 0);
    } finally {
      src.close();
    }
    const copy = new DatabaseSync(join(dir, 'copy.db'), { readOnly: true });
    try {
      assert.deepEqual(copy.prepare('SELECT a FROM t ORDER BY a').all().map((r) => r.a), ['main', 'wal-only']);
    } finally {
      copy.close();
    }
  });

  it('backupDatabase rejects with EEXIST for an existing destination and leaves it byte-identical', async () => {
    const { backupDatabase } = await load();
    assert.equal(typeof backupDatabase, 'function', 'backupDatabase is exported');
    const { dir, live } = walStore();
    const dest = join(dir, 'taken.db');
    writeFileSync(dest, 'an existing file');
    const src = new DatabaseSync(live, { readOnly: true });
    try {
      await assert.rejects(backupDatabase(src, dest), (err) => err.code === 'EEXIST');
    } finally {
      src.close();
    }
    assert.equal(readFileSync(dest, 'utf8'), 'an existing file');
  });

  it('openCopyReadOnly reads a copy, creates no -wal or -shm file and throws on a write', async () => {
    const { backupDatabase, openCopyReadOnly } = await load();
    assert.equal(typeof openCopyReadOnly, 'function', 'openCopyReadOnly is exported');
    const { live } = walStore();
    const dir = scratch('rigorscope-copy #dir ');
    const src = new DatabaseSync(live, { readOnly: true });
    try {
      await backupDatabase(src, join(dir, 'copy.db'));
    } finally {
      src.close();
    }
    const db = openCopyReadOnly(join(dir, 'copy.db'));
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM t').get().n, 2);
      assert.throws(() => db.exec("INSERT INTO t VALUES ('x')"), /readonly|read-only/i);
    } finally {
      db.close();
    }
    assert.deepEqual(readdirSync(dir), ['copy.db']);
  });
});
