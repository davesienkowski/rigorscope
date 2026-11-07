// Backup and verify of the rigorscope state directory, shared by scripts/backup-store.mjs (its default mode and
// --verify) and by `rigorscope migrate --apply` (src/store/migrate.mjs), so both write the same copies, lines and
// MANIFEST.txt (moved here from the script by plan 02-01; the lines, refusals and codes are unchanged).
//
// Guarantees: it takes no lock and never writes, migrates or checkpoints the live files (they are opened read-only
// through src/db.mjs). Copies are made with the SQLite online backup in one step, set to 0600 in a 0700 directory that
// is created exclusively (an existing directory or file is refused, never overwritten or deleted), and read only
// through an immutable read-only open, so no -wal or -shm file ever appears beside a copy. MANIFEST.txt is written
// last, only after every copy verified. Output goes through the caller's out(line) and never holds an absolute path,
// a SQL text or an error string that can hold a path. It spawns no process and does not import the sqlite module.
import { createHash } from 'node:crypto';
import {
  closeSync, createReadStream, chmodSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import * as db from '../db.mjs';

export const LABEL_RE = /^[a-z0-9][a-z0-9-]*$/;
export const NAME_RE = /^([a-z0-9][a-z0-9-]*)-(\d{8}T\d{6}Z)$/;
export const MANIFEST = 'MANIFEST.txt';
export const FILES = ['store.db', 'derived.db'];
export const FILE_LINE = /^(store\.db|derived\.db) sha256: ([0-9a-f]{64}) bytes: (\d+) user_version: (\d+) integrity_check: (\S+)$/;
export const SHOWN_BACKUPS = '<state dir>/backups';

// A bad --of value; the script maps it to its usage error (exit 2, same message).
export class BackupUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupUsageError';
  }
}

// A short reason that can hold no path: the state-directory refusal, SQLite's generic error string, or an error code.
export function reason(e) {
  if (e?.name === 'StateDirError') return 'the state directory is a symlink or not a directory';
  return e?.errstr ?? e?.code ?? e?.name ?? 'error';
}

// 'absent', 'file', 'dir', 'symlink' or 'other' for a path, without following a final symlink.
export function kindOf(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 'absent';
    throw e;
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFile()) return 'file';
  if (st.isDirectory()) return 'dir';
  return 'other';
}

async function sha256Of(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const fileLine = (f, i) => `${f} sha256: ${i.sha} bytes: ${i.bytes} user_version: ${i.userVersion} integrity_check: ${i.integrity}`;

export function integrityOf(conn) {
  const rows = conn.prepare('PRAGMA integrity_check').all();
  return rows.length === 1 && rows[0].integrity_check === 'ok' ? 'ok' : `FAILED(${rows.length})`;
}

// Hash, open read-only and immutable, read integrity and user_version, hash again. `stable` is false when the
// two hashes differ (something changed the copy while it was read). `error` is set when the copy could not be read.
async function inspectCopy(file) {
  const sha = await sha256Of(file);
  const bytes = statSync(file).size;
  let integrity = 'unreadable';
  let userVersion = '?';
  let error = null;
  try {
    const conn = db.openCopyReadOnly(file);
    try {
      integrity = integrityOf(conn);
      userVersion = conn.prepare('PRAGMA user_version').get().user_version;
    } finally {
      conn.close();
    }
  } catch (e) {
    error = reason(e);
  }
  const again = await sha256Of(file);
  return { sha, bytes, integrity, userVersion, error, stable: sha === again };
}

// Refuses a state directory that is a symlink or not a directory; returns false when it does not exist.
export function stateDirPresent(home) {
  const k = kindOf(db.stateDir(home));
  if (k === 'absent') return false;
  if (k !== 'dir') throw Object.assign(new Error('state directory'), { name: 'StateDirError' });
  return true;
}

export function backupsDirOf(home) {
  const dir = join(db.stateDir(home), 'backups');
  const k = kindOf(dir);
  if (k !== 'absent' && k !== 'dir') throw Object.assign(new Error('backups'), { code: 'the backups entry is not a directory' });
  return { dir, exists: k === 'dir' };
}

// -> a backup directory name, or null when `latest` finds none. Anything but `latest` or a well-formed name is a
// usage error, so `--of ../x` can never leave the backups directory.
export function resolveBackup(home, of, label) {
  if (of !== 'latest') {
    if (!NAME_RE.test(of)) throw new BackupUsageError('--of must be live, latest or a backup directory name');
    return of;
  }
  if (!stateDirPresent(home)) return null;
  const { dir, exists } = backupsDirOf(home);
  if (!exists) return null;
  const names = readdirSync(dir)
    .map((n) => [n, NAME_RE.exec(n)])
    .filter(([n, m]) => m && (label === undefined || m[1] === label) && kindOf(join(dir, n)) === 'dir')
    .sort(([a, ma], [b, mb]) => (ma[2] < mb[2] ? -1 : ma[2] > mb[2] ? 1 : a < b ? -1 : a > b ? 1 : 0));
  return names.length ? names[names.length - 1][0] : null;
}

// Backs up store.db and, when present, derived.db into <state dir>/backups/<label>-<UTC stamp of now()>/ and writes
// MANIFEST.txt last. Every line goes through out(line). -> { code: 0 | 1, name } (name: the backup directory name).
export async function backupStore({
  home, label, now, out,
}) {
  const instant = now().toISOString();
  const name = `${label}-${instant.slice(0, 19).replace(/[-:]/g, '')}Z`;
  if (!stateDirPresent(home) || kindOf(db.storePath(home)) !== 'file') {
    out('backup: FAILED store.db: absent, nothing to back up');
    return { code: 1, name };
  }
  const sources = [];
  try {
    for (const f of FILES) {
      const live = f === 'store.db' ? db.storePath(home) : db.derivedPath(home);
      if (kindOf(live) !== 'file') {
        sources.push([f, null]);
        continue;
      }
      try {
        sources.push([f, f === 'store.db' ? db.openStoreReadOnly({ home }) : db.openDerivedReadOnly({ home })]);
      } catch (e) {
        out(`backup: FAILED ${f}: cannot open (${reason(e)})`);
        return { code: 1, name };
      }
    }
    const { dir: backups, exists } = backupsDirOf(home);
    if (!exists) mkdirSync(backups, { mode: 0o700 });
    const leaf = join(backups, name);
    try {
      mkdirSync(leaf, { mode: 0o700 });
    } catch (e) {
      out(`backup: FAILED ${name}: ${e.code === 'EEXIST' ? 'already exists, never overwritten' : reason(e)}`);
      return { code: 1, name };
    }
    out(`backup: ${SHOWN_BACKUPS}/${name}`);
    const lines = [];
    for (const [f, conn] of sources) {
      if (!conn) {
        lines.push(`${f}: absent, skipped`);
        out(lines.at(-1));
        continue;
      }
      const dest = join(leaf, f);
      try {
        await db.backupDatabase(conn, dest);
        chmodSync(dest, 0o600);
      } catch (e) {
        out(`backup: FAILED ${f}: copy failed (${reason(e)})`);
        return { code: 1, name };
      }
      const info = await inspectCopy(dest);
      if (info.error || info.integrity !== 'ok' || !info.stable) {
        out(`backup: FAILED ${f}: the copy did not verify (${info.error ?? (info.stable ? `integrity_check ${info.integrity}` : 'changed while read')})`);
        return { code: 1, name };
      }
      lines.push(fileLine(f, info));
      out(lines.at(-1));
    }
    const fd = openSync(join(leaf, MANIFEST), 'wx', 0o600);
    try {
      writeSync(fd, [`label: ${label}`, `instant: ${instant}`, ...lines].join('\n') + '\n');
    } finally {
      closeSync(fd);
    }
    out('backup: ok');
    return { code: 0, name };
  } finally {
    for (const [, conn] of sources) conn?.close();
  }
}

// Re-hashes and re-inspects the backup `of` (latest, optionally of one label, or a directory name) against its
// MANIFEST.txt. Every line goes through out(line). -> { code: 0 | 1, name } (name null when none was found). A bad
// `of` throws BackupUsageError before anything is read.
export async function verifyBackup({
  home, of, label, out,
}) {
  const name = resolveBackup(home, of, label);
  if (name === null) {
    out('verify: FAILED no backup found');
    return { code: 1, name: null };
  }
  const leaf = join(db.stateDir(home), 'backups', name);
  if (!stateDirPresent(home) || kindOf(leaf) !== 'dir') {
    out(`verify: FAILED ${name}: no such backup`);
    return { code: 1, name };
  }
  out(`verify: ${SHOWN_BACKUPS}/${name}`);
  let manifest;
  try {
    manifest = readFileSync(join(leaf, MANIFEST), 'utf8');
  } catch (e) {
    out(`${MANIFEST}: cannot read (${reason(e)})`);
    out('verify: FAILED');
    return { code: 1, name };
  }
  const expected = new Map();
  for (const l of manifest.split('\n')) {
    const m = FILE_LINE.exec(l);
    if (m) expected.set(m[1], { sha: m[2], bytes: Number(m[3]), userVersion: Number(m[4]), integrity: m[5] });
    else if (/^(store\.db|derived\.db): absent, skipped$/.test(l)) expected.set(l.split(':')[0], 'absent');
  }
  const problems = [];
  if (!(expected.get('store.db') instanceof Object)) problems.push(`${MANIFEST}: no store.db line`);
  for (const f of FILES) {
    const want = expected.get(f);
    const p = join(leaf, f);
    const kind = kindOf(p);
    if (want === undefined || want === 'absent') {
      if (kind !== 'absent') problems.push(`${f}: present, but the manifest does not list it`);
      else if (want === 'absent') out(`${f}: absent, skipped`);
      continue;
    }
    if (kind !== 'file') {
      problems.push(`${f}: missing from the backup`);
      continue;
    }
    const m = statSync(p).mode & 0o777;
    if ((m & 0o077) !== 0) problems.push(`${f}: mode ${m.toString(8).padStart(4, '0')}, expected 0600`);
    const info = await inspectCopy(p);
    out(fileLine(f, info));
    if (info.sha !== want.sha) problems.push(`${f}: sha256 differs (manifest ${want.sha}, now ${info.sha})`);
    if (info.bytes !== want.bytes) problems.push(`${f}: bytes differ (manifest ${want.bytes}, now ${info.bytes})`);
    if (info.error) problems.push(`${f}: cannot open (${info.error})`);
    else {
      if (info.userVersion !== want.userVersion) problems.push(`${f}: user_version differs (manifest ${want.userVersion}, now ${info.userVersion})`);
      if (info.integrity !== 'ok') problems.push(`${f}: integrity_check ${info.integrity}`);
    }
    if (!info.stable) problems.push(`${f}: changed while it was read`);
  }
  const extra = readdirSync(leaf).filter((n) => n !== MANIFEST && !FILES.includes(n));
  if (extra.length) problems.push(`unexpected entries in the backup directory: ${extra.length}`);
  for (const p of problems) out(p);
  out(problems.length ? 'verify: FAILED' : 'verify: ok');
  return { code: problems.length ? 1 : 0, name };
}
