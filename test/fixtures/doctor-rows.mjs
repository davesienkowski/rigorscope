// Seed helpers for the doctor tests (plan 01-09). A helper, not a test: it imports openStore from src/db.mjs and
// nothing else from src. Every column is bound explicitly (NULL when absent), so a new column cannot silently
// change what a test seeds.
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { openStore } from '../../src/db.mjs';
import { REPO } from './build.mjs';
import { insertSnapshotRow } from './usage-cache.mjs';

export { openStore, insertSnapshotRow as seedSnapshot };

const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
function insertAll(db, table, row) {
  const cols = columnsOf(db, table);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return db.prepare(sql).run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
}

export function seedRun(db, {
  startedUtc, endedUtc, status = 'ok', roots = null, unknownTokenBearing = null, errorCode = null,
} = {}) {
  const r = insertAll(db, 'ingest_run', {
    started_utc: startedUtc ?? endedUtc, ended_utc: endedUtc ?? null, trigger: 'test', status, roots,
    unknown_token_bearing: unknownTokenBearing, error_code: errorCode,
  });
  return Number(r.lastInsertRowid);
}

export function seedSourceRoot(db, {
  source, alias, kind = alias, display = `~/.${alias}`, firstSeenRun = null, lastSeenRun = null,
}) {
  insertAll(db, 'source_root', {
    source, alias, kind, display, first_seen_run: firstSeenRun, last_seen_run: lastSeenRun,
  });
  return db.prepare('SELECT root_id FROM source_root WHERE source = ? AND alias = ?').get(source, alias).root_id;
}

export function seedSourceFile(db, {
  rootId, rel, kind = 'session', size = 0, offset = 0, lastRecordUtc = null, lastSeenRun = null, lastReadRun = null,
}) {
  return Number(insertAll(db, 'source_file', {
    root_id: rootId, rel_path: rel, kind, size, offset, last_record_utc: lastRecordUtc, last_seen_run: lastSeenRun,
    last_read_run: lastReadRun,
  }).lastInsertRowid);
}

export function seedSourceRun(db, runId, source, { pendingTailBytes = 0, newestRecordUtc = null } = {}) {
  insertAll(db, 'ingest_source_run', {
    run_id: runId, source, pending_tail_bytes: pendingTailBytes, newest_record_utc: newestRecordUtc,
  });
}

export function seedCount(db, runId, source, kind, name, n) {
  insertAll(db, 'ingest_count', { run_id: runId, source, kind, name, n });
}

export function seedUnknownAttr(db, { source, scope, name, runId = null, n = 1 }) {
  insertAll(db, 'unknown_attr', {
    source, scope, name, first_run_id: runId, last_run_id: runId, last_run_n: n,
  });
}

// Runs fn(db) against a writable store.db of home and closes it.
export function withStore(home, fn) {
  const db = openStore({ home });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// An empty HOME/.rigorscope/ingest.lock whose mtime is mtimeMs (a whole number of milliseconds).
export function writeLockFile(home, mtimeMs) {
  const dir = join(home, '.rigorscope');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'ingest.lock');
  writeFileSync(file, '', { mode: 0o600 });
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

// sha256 over sorted relative paths, types, sizes, modes and file bytes of the whole tree (a missing tree digests
// as the empty tree). A symlink is recorded by its type only.
export function homeDigest(home) {
  const h = createHash('sha256');
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      const rel = relative(home, p);
      if (st.isSymbolicLink()) h.update(`${rel}\0link\0`);
      else if (st.isDirectory()) {
        h.update(`${rel}\0dir\0${(st.mode & 0o777).toString(8)}\0`);
        walk(p);
      } else h.update(`${rel}\0file\0${st.size}\0${(st.mode & 0o777).toString(8)}\0`).update(readFileSync(p));
    }
  };
  if (existsSync(home)) walk(home);
  return h.digest('hex');
}

export const REPO_UNIT_SERVICE = join(REPO, 'units', 'rigorscope-ingest.service');
export const REPO_UNIT_TIMER = join(REPO, 'units', 'rigorscope-ingest.timer');

// HOME/.config/systemd/user (or a given directory), and HOME/repos/rigorscope as a symlink to this checkout.
export const unitDirOf = (home) => join(home, '.config', 'systemd', 'user');
export function linkCheckout(home) {
  mkdirSync(join(home, 'repos'), { recursive: true });
  const link = join(home, 'repos', 'rigorscope');
  if (!existsSync(link)) symlinkSync(REPO.replace(/\/$/, ''), link);
  return link;
}

// Copies the repo unit files byte for byte (or the given texts, to model drift) into the unit directory of home.
// The repo files must exist: a missing file is an assertion failure, not an ENOENT.
export function installRepoUnits(home, { service, timer } = {}) {
  assert.ok(existsSync(REPO_UNIT_SERVICE), 'units/rigorscope-ingest.service exists');
  assert.ok(existsSync(REPO_UNIT_TIMER), 'units/rigorscope-ingest.timer exists');
  const dir = unitDirOf(home);
  mkdirSync(dir, { recursive: true });
  for (const [src, name, text] of [
    [REPO_UNIT_SERVICE, 'rigorscope-ingest.service', service],
    [REPO_UNIT_TIMER, 'rigorscope-ingest.timer', timer],
  ]) {
    if (text === undefined) copyFileSync(src, join(dir, name));
    else writeFileSync(join(dir, name), text);
  }
  return dir;
}
