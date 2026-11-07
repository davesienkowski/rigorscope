// rigorscope migrate [--apply]: the only path that applies a pending migration to an existing store (plan 02-01,
// D-23 Q9, ADR-0008). Every other caller of openStore leaves out the `migrate` option and is refused on a store with a
// pending migration, so the daily timer and casual commands fail safe instead of migrating before a backup exists.
//
//   no store.db           print the no-store line and return 0; nothing is created (checked before any lock)
//   store newer           StoreTooNewError, as every other command (the CLI prints it and exits 1)
//   nothing pending       print the version line and return 0; no lock, no backup
//   dry run (no apply)    print the version line with the pending names and the dry-run line; no lock, no write
//   apply                 inside the ingest lock: re-read the version, back up (label pre-migrate) with the shared
//                         backup module, verify that exact backup against its manifest, and only then open the store
//                         with the opt-in. A failed backup or verify (returned or thrown) applies nothing and ends
//                         with the nothing-applied line (exit 1); a held lock applies nothing and returns 0 (the
//                         ingest and preserve-scrub convention); a migration whose SQL fails rolls back alone
//                         (each migration is its own transaction) and the FAILED line names the version reached and
//                         the verified backup (exit 1).
//
// Output goes through out(line) and never holds an absolute path: a backup is shown as <state dir>/backups/<name>.
// Test seams (undocumented): `migrations` replaces the shipped list; afterBackup({ dir }) runs after the backup and
// before the verify, with the absolute backup directory (never printed).
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MIGRATIONS, openStore, openStoreReadOnly, stateDir, storePath, storeTooNew,
} from '../db.mjs';
import { withLock } from '../ingest/lock.mjs';
import {
  SHOWN_BACKUPS, backupStore, reason, verifyBackup,
} from './backup.mjs';

export const MIGRATE_LABEL = 'pre-migrate';

const nameOf = (m) => m.name.replace(/\.mjs$/, '');

function absent(p) {
  try {
    lstatSync(p);
    return false;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return true;
    throw err;
  }
}

// The store's user_version through a read-only connection (writes nothing to the main file).
function versionOf(home) {
  const ro = openStoreReadOnly({ home });
  try {
    return ro.prepare('PRAGMA user_version').get().user_version;
  } finally {
    ro.close();
  }
}

// A short reason that can hold no path: an error code or the error name.
const codeOf = (err) => (typeof err?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(err.code) ? err.code : err?.name ?? 'Error');

export async function migrateStore({
  home, now = () => new Date(), apply = false, out, migrations = DEFAULT_MIGRATIONS, afterBackup,
}) {
  if (absent(stateDir(home)) || absent(storePath(home))) {
    out('migrate: no store.db; nothing to migrate (the first ingest creates it at the latest schema)');
    return { status: 'absent', exitCode: 0 };
  }
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  const pendingFrom = (current) => migrations.filter((m) => m.version > current).map(nameOf);
  const current = versionOf(home);
  if (current > latest) throw storeTooNew(current, latest);
  const pending = pendingFrom(current);
  const head = `migrate: store.db at schema v${current}, this rigorscope supports v${latest}`;
  if (pending.length === 0) {
    out(`${head}, nothing pending`);
    return { status: 'none_pending', exitCode: 0 };
  }
  out(`${head}, pending ${pending.length}: ${pending.join(',')}`);
  if (!apply) {
    out('migrate: dry run, nothing was written; re-run with --apply to back up, verify and apply');
    return { status: 'dry_run', exitCode: 0 };
  }
  const locked = await withLock({ home, now }, async () => {
    // Re-read under the lock: another migrate may have applied it meanwhile.
    const from = versionOf(home);
    if (from > latest) throw storeTooNew(from, latest);
    const names = pendingFrom(from);
    if (names.length === 0) {
      out(`migrate: store.db at schema v${from}, this rigorscope supports v${latest}, nothing pending`);
      return { status: 'none_pending', exitCode: 0 };
    }
    const nothingApplied = () => out(`migrate: nothing applied; store.db stays at schema v${from}`);
    // A step that throws (for example a `backups` entry that is not a directory, or a read error) is reported like
    // one that returned code 1: its FAILED line with the backup module's path-free reason, then the nothing-applied
    // line (review 02-01 WR-03). Nothing was applied yet, and withLock releases the lock on return.
    const step = async (name, fn) => {
      try {
        return await fn();
      } catch (err) {
        out(`migrate: FAILED ${name} (${reason(err)})`);
        return { code: 1 };
      }
    };
    const backup = await step('backup', () => backupStore({
      home, label: MIGRATE_LABEL, now, out,
    }));
    if (backup.code !== 0) {
      nothingApplied();
      return { status: 'backup_failed', exitCode: 1 };
    }
    if (afterBackup) await afterBackup({ dir: join(stateDir(home), 'backups', backup.name) });
    const verified = await step('verify', () => verifyBackup({ home, of: backup.name, out }));
    if (verified.code !== 0) {
      nothingApplied();
      return { status: 'verify_failed', exitCode: 1 };
    }
    try {
      openStore({ home, migrations, migrate: true }).close();
    } catch (err) {
      const reached = versionOf(home);
      const failed = migrations.find((m) => m.version === reached + 1);
      out(`migrate: FAILED applying ${failed ? nameOf(failed) : 'a migration'} (${codeOf(err)}); store.db at schema v${reached}; `
        + `the verified backup is ${SHOWN_BACKUPS}/${backup.name}`);
      return { status: 'apply_failed', exitCode: 1 };
    }
    out(`migrate: applied ${names.join(',')}; store.db at schema v${versionOf(home)}`);
    return { status: 'applied', exitCode: 0 };
  });
  if (!locked.acquired) {
    const h = locked.holder ?? {};
    out(`migrate: skipped, an ingest holds the lock (pid ${h.pid ?? 'unknown'} since ${h.started_utc ?? 'unknown'}); nothing was applied`);
    return { status: 'lock_held', exitCode: 0 };
  }
  return locked.value;
}
