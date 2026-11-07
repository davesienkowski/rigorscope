#!/usr/bin/env node
// Node-only backup, verify, check and read-only query helper for the rigorscope state directory (plan 01-12, RR-08).
// The store is kept forever and migrated in place, so the only revert of a migration is a copy taken before it. This
// helper takes that copy with nothing but Node (24.15 or newer, for the built-in sqlite module): no sqlite3 shell, no
// checksum tool, no other process.
//
// Modes (exclusive):
//   (none)     back up store.db and, when present, derived.db into <state dir>/backups/<label>-<UTC stamp>/
//   --verify   re-hash and re-inspect a backup against its MANIFEST.txt
//   --check    integrity_check, user_version and foreign_key_check of the live files or of a backup
//   --sql      run one read-only statement and print the rows, tab-separated, NULL as NULL
//
// Guarantees: it takes no lock and never writes, migrates or checkpoints the live files (they are opened read-only
// through src/db.mjs; a read-only connection to a WAL store may leave empty -shm and -wal files beside the live file,
// which the next ingest adopts). Copies are made with the SQLite online backup in one step, set to 0600 in a 0700
// directory that is created exclusively (an existing directory or file is refused, never overwritten or deleted), and
// read only through an immutable read-only open, so no -wal or -shm file ever appears beside a copy. MANIFEST.txt is
// written last, only after every copy verified. Output never holds an absolute path, a SQL text or an error string
// that can hold a path. Exit 0 success, 1 a failed check or nothing to act on, 2 a usage error.
//
// The backup and verify code lives in src/store/backup.mjs and is shared with `rigorscope migrate --apply` (plan
// 02-01), which takes the same copy, labeled pre-migrate, verifies it and only then applies a pending migration. It is
// imported only after the runtime preflight passed, like src/db.mjs before it, so an old Node fails with the preflight
// message and not on the sqlite module.
import os from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runPreflight } from '../src/preflight.mjs';

const USAGE = 'usage: node scripts/backup-store.mjs [--home DIR] [--label NAME] '
  + '[--verify | --check | --sql STATEMENT] [--of live|latest|NAME] [--db store|derived]';
const DEFAULT_LABEL = 'pre-upgrade';

class UsageError extends Error {}

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

// src/store/backup.mjs, loaded by main after the preflight.
let bk = null;
const reasonOf = (e) => (bk ? bk.reason(e) : e?.code ?? e?.name ?? 'error');

// -> { label shown, open(file) -> connection or null when absent } for `live` or a backup.
function target(db, home, of, label) {
  if (of === 'live') {
    if (!bk.stateDirPresent(home)) return { shown: 'live', open: () => null };
    return {
      shown: 'live',
      open: (f) => {
        const p = f === 'store.db' ? db.storePath(home) : db.derivedPath(home);
        if (bk.kindOf(p) !== 'file') return null;
        return f === 'store.db' ? db.openStoreReadOnly({ home }) : db.openDerivedReadOnly({ home });
      },
    };
  }
  const name = bk.resolveBackup(home, of, label);
  if (name === null) return null;
  const leaf = join(db.stateDir(home), 'backups', name);
  if (bk.kindOf(leaf) !== 'dir') return null;
  return {
    shown: `${bk.SHOWN_BACKUPS}/${name}`,
    open: (f) => (bk.kindOf(join(leaf, f)) === 'file' ? db.openCopyReadOnly(join(leaf, f)) : null),
  };
}

function check(db, home, of, label) {
  const t = target(db, home, of, label);
  if (t === null) {
    out('check: FAILED no such backup');
    return 1;
  }
  out(`check: ${t.shown}`);
  let failed = false;
  for (const f of bk.FILES) {
    let conn;
    try {
      conn = t.open(f);
      if (conn === null) {
        out(`${f}: absent`);
        if (f === 'store.db') failed = true;
        continue;
      }
      const integrity = bk.integrityOf(conn);
      const userVersion = conn.prepare('PRAGMA user_version').get().user_version;
      const fk = conn.prepare('PRAGMA foreign_key_check').all().length;
      out(`${f} user_version: ${userVersion} integrity_check: ${integrity} foreign_key_check rows: ${fk}`);
      if (integrity !== 'ok' || fk !== 0) failed = true;
    } catch (e) {
      out(`${f}: FAILED (${reasonOf(e)})`);
      failed = true;
    } finally {
      conn?.close();
    }
  }
  out(failed ? 'check: FAILED' : 'check: ok');
  return failed ? 1 : 0;
}

function cell(v) {
  if (v === null) return 'NULL';
  if (v instanceof Uint8Array) return `blob(${v.byteLength})`;
  return String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function sql(db, home, statement, of, label, which) {
  const f = which === 'derived' ? 'derived.db' : 'store.db';
  const t = target(db, home, of, label);
  if (t === null) {
    out('sql: FAILED no such backup');
    return 1;
  }
  let conn;
  try {
    conn = t.open(f);
    if (conn === null) {
      out(`sql: FAILED ${f}: absent`);
      return 1;
    }
    const st = conn.prepare(statement);
    st.setReadBigInts(true);
    st.setReturnArrays(true);
    const rows = st.all();
    for (const row of rows) out(row.map(cell).join('\t'));
    return 0;
  } catch (e) {
    out(`sql: FAILED (${reasonOf(e)})`);
    return 1;
  } finally {
    conn?.close();
  }
}

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        home: { type: 'string' },
        label: { type: 'string' },
        verify: { type: 'boolean' },
        check: { type: 'boolean' },
        sql: { type: 'string' },
        of: { type: 'string' },
        db: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    throw new UsageError(`invalid arguments (${e.code ?? 'error'})`);
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }
  const isSql = values.sql !== undefined;
  const modes = [values.verify === true, values.check === true, isSql].filter(Boolean).length;
  if (modes > 1) throw new UsageError('--verify, --check and --sql are exclusive');
  bk = await import('../src/store/backup.mjs');
  if (values.label !== undefined && !bk.LABEL_RE.test(values.label)) {
    throw new UsageError('--label takes lowercase letters, digits and hyphens, starting with a letter or digit');
  }
  if (values.home !== undefined && values.home === '') throw new UsageError('--home needs a directory');
  if (isSql && values.sql.trim() === '') throw new UsageError('--sql needs a statement');
  if (values.db !== undefined && (!isSql || !['store', 'derived'].includes(values.db))) {
    throw new UsageError('--db is store or derived, and goes with --sql');
  }
  if (values.of !== undefined && modes === 0) throw new UsageError('--of goes with --verify, --check or --sql');
  if (values.verify && values.of === 'live') throw new UsageError('--verify reads a backup, not live');

  const { clockFromEnv } = await import('../src/clock.mjs');
  let clock;
  try {
    clock = clockFromEnv(process.env);
  } catch (e) {
    throw new UsageError(e.message);
  }
  const db = await import('../src/db.mjs');
  const home = values.home ?? os.homedir();
  process.umask(0o077);

  if (values.verify) return (await bk.verifyBackup({ home, of: values.of ?? 'latest', label: values.label, out })).code;
  if (values.check) return check(db, home, values.of ?? 'live', values.label);
  if (isSql) return sql(db, home, values.sql, values.of ?? 'live', values.label, values.db ?? 'store');
  return (await bk.backupStore({ home, label: values.label ?? DEFAULT_LABEL, now: clock.now, out })).code;
}

const pre = runPreflight();
if (!pre.ok) {
  err(pre.msg);
  process.exitCode = pre.exit;
} else {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError || e?.name === 'BackupUsageError') {
      err(`backup-store: ${e.message}`);
      err(USAGE);
      process.exitCode = 2;
    } else {
      err(`backup-store: FAILED (${reasonOf(e)})`);
      process.exitCode = 1;
    }
  }
}
