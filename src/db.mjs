// The only module that imports the built-in sqlite module (ADR-0005). Everything else gets a
// database handle from here, so a class rename in Node or a swap of binding touches one file.
//
// Two files live under <HOME>/.rigorscope/ (directory 0700, files 0600):
//   store.db    durable, WAL, forward-only in-place migrations by PRAGMA user_version. A fresh store (user_version 0,
//               no tables) gets every migration on its first open, in one transaction; an existing store with a
//               pending migration is refused unless the caller passes the `migrate` option, which only
//               src/store/migrate.mjs does, after a verified backup (plan 02-01, D-23 Q9, ADR-0008)
//   derived.db  rebuilt into a temp file and renamed; attaches store.db read-only while it builds
// All SQL here uses prepared statements with bound parameters; the only interpolated value is an
// integer migration version that loadMigrations has already validated.
import * as sqlite from 'node:sqlite';
import {
  chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node 24 exports DatabaseSync only; Node 26 renames it to Database and keeps the old name as an alias.
export const Db = sqlite.Database ?? sqlite.DatabaseSync;

const BUSY_TIMEOUT_MS = 5000;

export class StateDirError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateDirError';
  }
}

export class StoreTooNewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreTooNewError';
  }
}

// The refusal of a store newer than this rigorscope (one source for its text: openStore and the migrate path).
export const storeTooNew = (current, latest) => new StoreTooNewError(
  `store.db has schema version ${current}, newer than the latest this rigorscope supports (${latest}); update rigorscope`,
);

// An existing store (user_version 1 to latest-1) opened without the `migrate` option. The message holds the two
// validated integers and fixed text only, never a path.
export class StoreMigrationPendingError extends Error {
  constructor(from, to) {
    super(
      `store.db is at schema version ${from} and this rigorscope needs ${to}: migration pending, back up first; `
        + 'run rigorscope migrate --apply to back up, verify and apply it',
    );
    this.name = 'StoreMigrationPendingError';
    this.code = 'migration_pending';
    this.from = from;
    this.to = to;
  }
}

export const stateDir = (home) => join(home, '.rigorscope');
export const storePath = (home) => join(stateDir(home), 'store.db');
export const derivedPath = (home) => join(stateDir(home), 'derived.db');

function inspectStateDir(home) {
  const dir = stateDir(home);
  let st = null;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) {
    // No path in the message: the path holds the OS user name.
    throw new StateDirError('the rigorscope state directory is a symlink or not a directory; refusing to use it');
  }
  return { dir, exists: st !== null, mode: st ? st.mode : 0 };
}

// Creates <HOME>/.rigorscope with mode 0700 under umask 077, after refusing a symlink or a
// non-directory. The umask stays at 077 for the rest of the process, so every file created later
// (databases, WAL files, temp files) is 0600.
export function ensureStateDir(home) {
  process.umask(0o077);
  const { dir, exists, mode } = inspectStateDir(home);
  if (!exists) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else if ((mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return dir;
}

// Migration modules are NNN-name.mjs files exporting `version` and `sql`. Versions must be
// contiguous from 1, so a later plan adds a migration by adding a file and editing nothing else.
export function loadMigrations(dir) {
  return importMigrations(dir);
}

async function importMigrations(dir) {
  const names = readdirSync(dir)
    .filter((n) => /^\d{3,}-[A-Za-z0-9._-]+\.mjs$/.test(n))
    .sort((a, b) => (Number.parseInt(a, 10) - Number.parseInt(b, 10)) || (a < b ? -1 : a > b ? 1 : 0));
  const out = [];
  for (const name of names) {
    const mod = await import(pathToFileURL(join(dir, name)).href);
    if (!Number.isSafeInteger(mod.version) || mod.version < 1 || typeof mod.sql !== 'string') {
      throw new Error(`migration ${name} must export an integer version >= 1 and a sql string`);
    }
    if (mod.version !== Number.parseInt(name, 10)) {
      throw new Error(`migration ${name} exports version ${mod.version}, which does not match its file name`);
    }
    const prev = out.length ? out[out.length - 1].version : 0;
    if (mod.version === prev) throw new Error(`duplicate migration version ${mod.version} (${name})`);
    if (mod.version !== prev + 1) {
      throw new Error(`migration gap: expected version ${prev + 1}, found ${mod.version} (${name}); versions must be contiguous from 1`);
    }
    out.push({ version: mod.version, sql: mod.sql, name });
  }
  return out;
}

export const DEFAULT_MIGRATIONS = Object.freeze(
  await loadMigrations(fileURLToPath(new URL('./store/migrations/', import.meta.url))),
);
// The schema version this rigorscope writes: the last migration's version (0 for an empty list).
export const LATEST_STORE_VERSION = DEFAULT_MIGRATIONS.length ? DEFAULT_MIGRATIONS[DEFAULT_MIGRATIONS.length - 1].version : 0;

const userVersion = (db) => db.prepare('PRAGMA user_version').get().user_version;
const hasSchema = (db) => db.prepare('SELECT 1 AS x FROM sqlite_master LIMIT 1').get() !== undefined;

// The guard, judged on one read of the version and of sqlite_master: a store newer than the list is refused first;
// a store with a pending migration (user_version 1 to latest-1, or user_version 0 with tables already in it, which is
// not a store this rigorscope made) is refused with StoreMigrationPendingError unless `migrate` is true.
function judge(db, latest, migrate) {
  const v = userVersion(db);
  if (v > latest) throw storeTooNew(v, latest);
  if (migrate !== true && v < latest && (v >= 1 || hasSchema(db))) throw new StoreMigrationPendingError(v, latest);
  return v;
}

// Opens (creating if needed) store.db and applies pending migrations. The guard is judged right after the connection
// opens, before any PRAGMA that can write: a store newer than the list is refused first; a fresh store (user_version
// 0 and no tables) gets every migration; an existing store with a pending migration is refused with
// StoreMigrationPendingError unless the caller passes the `migrate` option as true. Only the migrate path
// (src/store/migrate.mjs) passes it, after a backup verified against its manifest (ADR-0008).
//
// A fresh store is created atomically: every migration and the final user_version bump run in one BEGIN IMMEDIATE
// transaction, and the guard is judged again inside it (review 02-01 WR-02). Another process may have created the
// store between the first read and this write lock; if it holds a pending migration now (an older rigorscope made
// it), the open throws StoreMigrationPendingError and applies nothing, also with the `migrate` option (the caller's
// backup was not of this store). A same-version creator commits all of its migrations at once, so a concurrent open
// sees user_version 0 or latest, never a version in between that it would refuse. The three PRAGMAs run before that
// transaction because journal_mode and foreign_keys cannot change inside one; they are safe on a store another
// process created in the window: synchronous and foreign_keys are per connection, and journal_mode = WAL writes the
// file only when the store is not in WAL yet, while every store rigorscope creates is set to WAL before its first
// migration. An existing store (first read 1 to latest-1, only with the option) gets each migration in its own
// BEGIN IMMEDIATE transaction together with its user_version bump.
export function openStore({ home, migrations = DEFAULT_MIGRATIONS, migrate = false }) {
  ensureStateDir(home);
  const db = new Db(storePath(home), { timeout: BUSY_TIMEOUT_MS });
  try {
    const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
    let current = judge(db, latest, migrate);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    if (current === 0 && latest > 0) {
      db.exec('BEGIN IMMEDIATE');
      try {
        current = judge(db, latest, migrate);
        if (current >= 1 && current < latest) throw new StoreMigrationPendingError(current, latest);
        if (current === 0) {
          for (const m of migrations) db.exec(m.sql);
          db.exec(`PRAGMA user_version = ${latest}`);
          current = latest;
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
        throw err;
      }
    }
    for (const m of migrations) {
      if (m.version <= current) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        // Another process may have applied it while this one waited for the lock.
        if (userVersion(db) < m.version) {
          db.exec(m.sql);
          db.exec(`PRAGMA user_version = ${m.version}`);
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
        throw err;
      }
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export function openStoreReadOnly({ home }) {
  inspectStateDir(home);
  return new Db(storePath(home), { readOnly: true, timeout: BUSY_TIMEOUT_MS });
}

// A fresh derived database at tmpPath (default rollback journal: no sidecar files exist before the
// rename), with store.db attached read-only as schema s. The attach target is a bound parameter
// built from a file URL, so a path with a space or a hash character is safe.
export function openDerivedForBuild({ tmpPath, home }) {
  ensureStateDir(home);
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-journal`, { force: true });
  const db = new Db(tmpPath, { timeout: BUSY_TIMEOUT_MS });
  try {
    db.prepare('ATTACH DATABASE ? AS s').run(`${pathToFileURL(storePath(home)).href}?mode=ro`);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export function openDerivedReadOnly({ home }) {
  inspectStateDir(home);
  return new Db(derivedPath(home), { readOnly: true, timeout: BUSY_TIMEOUT_MS });
}

// Pages copied per step of an online backup. Large enough that any store is copied in one step, so a writer in
// another process cannot make SQLite restart the copy part way (node:sqlite rejects SQLite's own -1, "all pages").
export const BACKUP_PAGES_PER_STEP = 2 ** 31 - 1;

// Online backup of an open database (a read-only connection is enough; rows still in a -wal file are included)
// into destPath, in one step. The destination is created exclusively first, so an existing file is refused with
// an error whose code is EEXIST before anything is written, and nothing is ever overwritten. Resolves with the
// total page count.
export async function backupDatabase(source, destPath) {
  closeSync(openSync(destPath, 'wx', 0o600));
  return sqlite.backup(source, destPath, { rate: BACKUP_PAGES_PER_STEP });
}

// Read-only open of a file that no process writes, such as a backup copy: the immutable=1 URI makes SQLite skip
// locking and the WAL, so no -wal or -shm file is created beside it and nothing can write. Never use it on a live
// file (immutable means SQLite assumes nobody changes the file while it is open).
export function openCopyReadOnly(path) {
  const url = pathToFileURL(path);
  url.search = 'immutable=1';
  return new Db(url, { readOnly: true });
}

// Folds the WAL into store.db and closes, so the main file holds everything (raw-byte scans, copies). It opens the
// store without the `migrate` option, so it refuses a store with a pending migration like every other caller.
export function checkpointStore({ home }) {
  const db = openStore({ home });
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}
