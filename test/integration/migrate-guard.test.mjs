// Plan 02-01 (D-23 amendment Q9, ADR-0008): pending store migrations are opt-in on an existing store. Written before
// the code (RED). A fresh store (no store.db, or user_version 0) still gets every migration with no ceremony; an
// existing store whose user_version is between 1 and latest-1 is refused by every command with "migration pending,
// back up first", and only `rigorscope migrate --apply` applies it: it takes the ingest lock, takes a backup labeled
// pre-migrate with the shared backup module, verifies that backup against its manifest, and only then opens the store
// with the opt-in.
//
// Every run uses a temporary HOME from makeHome() (its name holds a space and a hash character), never the real one.
// The latest store version is computed from loadMigrations, never written as a literal, so these tests keep passing
// when a later plan adds a migration. A pending store is built through the `migrations` seam of openStore on a fresh
// HOME (a sliced list, applied from user_version 0, which needs no opt-in). The names the code under test adds
// (StoreMigrationPendingError, LATEST_STORE_VERSION) are never imported statically here: a missing named export would
// fail the whole file at link time.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadMigrations, openCopyReadOnly, openStore, storePath } from '../../src/db.mjs';
import { acquireLock, releaseLock } from '../../src/ingest/lock.mjs';
import { FIXTURE_NOW } from '../fixtures/clock.mjs';
import {
  REPO, buildTranscriptTree, cliEnv, makeHome, queryDb, runCli, sha256File, stateDirOf,
} from '../fixtures/build.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../src/store/migrations/', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'backup-store.mjs');
// FIXTURE_NOW (cliEnv's fixed clock) is 2026-10-28T12:00:00.000Z; the stamp is its UTC digits with T and Z, by hand.
const STAMP = '20261028T120000Z';
const FILE_LINE = /^store\.db sha256: [0-9a-f]{64} bytes: \d+ user_version: (\d+) integrity_check: ok$/;

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});
function fixture() {
  const ctx = makeHome();
  cleanups.push(ctx.cleanup);
  return ctx;
}

async function allMigrations() {
  const all = await loadMigrations(MIGRATIONS);
  return { all, latest: all[all.length - 1].version };
}
const nameOf = (m) => m.name.replace(/\.mjs$/, '');
const userVersionOf = (home) => queryDb(storePath(home), 'PRAGMA user_version')[0].user_version;
const linesOf = (text) => text.split('\n').filter((l) => l !== '');

// A store one migration behind the latest, built on a fresh HOME (applied from 0, no opt-in needed) and closed, so
// the main file holds everything. Returns the main-file sha256 and the pending migration's name.
async function pendingStore(home) {
  const { all, latest } = await allMigrations();
  openStore({ home, migrations: all.slice(0, latest - 1) }).close();
  assert.equal(userVersionOf(home), latest - 1, 'the fixture store sits one migration behind');
  return { latest, pendingName: nameOf(all[latest - 1]), sha: sha256File(storePath(home)) };
}

// No output of any run may hold the temporary HOME path.
function noHomeIn(home, r) {
  assert.ok(!r.stdout.includes(home) && !r.stderr.includes(home), 'no HOME path in stdout or stderr');
}

// Exactly one stderr line `rigorscope: <message>` (a runtime warning line fails this for its own reason).
function oneStderrLine(r) {
  const parts = r.stderr.split('\n');
  assert.deepEqual(parts.length, 2, 'stderr holds exactly one line');
  assert.equal(parts[1], '', 'the line ends with a newline');
  assert.match(parts[0], /^rigorscope: /);
  return parts[0].slice('rigorscope: '.length);
}

function assertPendingMessage(message, latest) {
  assert.ok(!/[\r\n]/.test(message), 'one line');
  assert.match(message, new RegExp(`\\b${latest - 1}\\b`), 'names the store version');
  assert.match(message, new RegExp(`\\b${latest}\\b`), 'names the latest version');
  assert.ok(message.includes('migration pending, back up first'), 'says a migration is pending');
  assert.ok(message.includes('rigorscope migrate --apply'), 'names the migrate command');
  assert.ok(!message.includes('/'), 'holds no path');
}

describe('the guard on spawned commands', () => {
  it('a fresh HOME: ingest exits 0, store.db reaches the latest version and no backups directory appears', async () => {
    const { home, root } = fixture();
    buildTranscriptTree(root);
    const { latest } = await allMigrations();
    const r = runCli(['ingest'], { home });
    assert.equal(r.status, 0, r.stderr);
    noHomeIn(home, r);
    assert.equal(userVersionOf(home), latest);
    assert.equal(existsSync(join(stateDirOf(home), 'backups')), false, 'no backup on a fresh store');
  });

  it('a pending store: ingest exits 1 with one stderr line, prints nothing on stdout and changes no byte of store.db', async () => {
    const { home, root } = fixture();
    buildTranscriptTree(root);
    const { latest, sha } = await pendingStore(home);
    const r = runCli(['ingest'], { home });
    assert.equal(r.status, 1, `ingest on a pending store must refuse; stdout: ${r.stdout.length} chars`);
    assert.equal(r.stdout, '');
    noHomeIn(home, r);
    assertPendingMessage(oneStderrLine(r), latest);
    assert.equal(sha256File(storePath(home)), sha, 'main-file bytes unchanged');
    assert.equal(userVersionOf(home), latest - 1, 'user_version unchanged');
  });
});

describe('rigorscope migrate --apply', () => {
  it('migrate --apply on a pending store backs up, verifies, applies and exits 0', async () => {
    const { home } = fixture();
    const { latest, pendingName } = await pendingStore(home);
    const r = runCli(['migrate', '--apply'], { home });
    assert.equal(r.status, 0, `migrate --apply exit status (stderr ${r.stderr.length} chars)`);
    noHomeIn(home, r);
    assert.equal(r.stderr, '');
    const lines = linesOf(r.stdout);
    const shown = `<state dir>/backups/pre-migrate-${STAMP}`;
    assert.equal(lines.length, 10, 'ten lines');
    assert.equal(lines[0], `migrate: store.db at schema v${latest - 1}, this rigorscope supports v${latest}, pending 1: ${pendingName}`);
    assert.equal(lines[1], `backup: ${shown}`);
    assert.match(lines[2], FILE_LINE);
    assert.equal(FILE_LINE.exec(lines[2])[1], String(latest - 1), 'the backup holds the unmigrated store');
    assert.equal(lines[3], 'derived.db: absent, skipped');
    assert.equal(lines[4], 'backup: ok');
    assert.equal(lines[5], `verify: ${shown}`);
    assert.equal(lines[6], lines[2], 'verify re-reads the same file line');
    assert.equal(lines[7], 'derived.db: absent, skipped');
    assert.equal(lines[8], 'verify: ok');
    assert.equal(lines[9], `migrate: applied ${pendingName}; store.db at schema v${latest}`);
    const leaf = join(stateDirOf(home), 'backups', `pre-migrate-${STAMP}`);
    assert.deepEqual(readdirSync(leaf).sort(), ['MANIFEST.txt', 'store.db']);
    const copy = openCopyReadOnly(join(leaf, 'store.db'));
    try {
      assert.equal(copy.prepare('PRAGMA user_version').get().user_version, latest - 1);
    } finally {
      copy.close();
    }
    assert.equal(userVersionOf(home), latest, 'the live store reached the latest version');
  });

  it('the pre-migrate backup verifies with scripts/backup-store.mjs, a second and independent signal', async () => {
    const { home } = fixture();
    await pendingStore(home);
    assert.equal(runCli(['migrate', '--apply'], { home }).status, 0);
    const v = spawnSync(process.execPath, [SCRIPT, '--verify', '--of', 'latest', '--label', 'pre-migrate'], {
      cwd: REPO, env: cliEnv(home), encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
    });
    assert.equal(v.status, 0, v.stdout);
    noHomeIn(home, v);
    assert.equal(linesOf(v.stdout).at(-1), 'verify: ok');
  });

  it('after migrate --apply, ingest works again on the same HOME', async () => {
    const { home, root } = fixture();
    buildTranscriptTree(root);
    const { latest } = await pendingStore(home);
    assert.equal(runCli(['ingest'], { home }).status, 1, 'refused before the migration');
    assert.equal(runCli(['migrate', '--apply'], { home }).status, 0);
    const r = runCli(['ingest'], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(userVersionOf(home), latest);
  });
});

// Plan 02-01 Task 2: every other branch of the migrate path, and cost and evidence on a pending store.
const backupsOf = (home) => join(stateDirOf(home), 'backups');
const lockOf = (home) => join(stateDirOf(home), 'ingest.lock');
const fixedNow = () => new Date(Date.parse(FIXTURE_NOW));
async function inProcess(home, extra = {}) {
  const { migrateStore } = await import('../../src/store/migrate.mjs');
  const lines = [];
  const res = await migrateStore({
    home, now: fixedNow, apply: true, out: (l) => lines.push(l), ...extra,
  });
  return { ...res, lines };
}
function unchanged(home, { latest, sha }) {
  assert.equal(sha256File(storePath(home)), sha, 'main-file bytes unchanged');
  assert.equal(userVersionOf(home), latest - 1, 'user_version unchanged');
}
// Flips the last byte of a file in place (the copy keeps its 0600 mode).
function flipLastByte(file) {
  const buf = readFileSync(file);
  buf[buf.length - 1] ^= 0xff;
  writeFileSync(file, buf);
}

describe('migrate: the dry run and the no-op branches', () => {
  it('migrate without a flag prints the pending and dry-run lines, exits 0, takes no lock and writes nothing', async () => {
    const { home } = fixture();
    const st = await pendingStore(home);
    const r = runCli(['migrate'], { home });
    assert.equal(r.status, 0, r.stderr);
    noHomeIn(home, r);
    assert.deepEqual(linesOf(r.stdout), [
      `migrate: store.db at schema v${st.latest - 1}, this rigorscope supports v${st.latest}, pending 1: ${st.pendingName}`,
      'migrate: dry run, nothing was written; re-run with --apply to back up, verify and apply',
    ]);
    assert.equal(existsSync(backupsOf(home)), false, 'no backups directory');
    assert.equal(existsSync(lockOf(home)), false, 'no lock file');
    unchanged(home, st);
  });

  it('migrate --apply on a store at the latest version says nothing is pending, exits 0 and takes no backup', async () => {
    const { home } = fixture();
    const { latest } = await allMigrations();
    openStore({ home }).close();
    const r = runCli(['migrate', '--apply'], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(linesOf(r.stdout), [`migrate: store.db at schema v${latest}, this rigorscope supports v${latest}, nothing pending`]);
    assert.equal(existsSync(backupsOf(home)), false);
  });

  it('a second migrate --apply after a successful one takes no second backup', async () => {
    const { home } = fixture();
    const { latest } = await pendingStore(home);
    assert.equal(runCli(['migrate', '--apply'], { home }).status, 0);
    const again = runCli(['migrate', '--apply'], { home, env: cliEnv(home, { RIGORSCOPE_NOW: '2026-10-29T12:00:00Z' }) });
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(linesOf(again.stdout), [`migrate: store.db at schema v${latest}, this rigorscope supports v${latest}, nothing pending`]);
    assert.deepEqual(readdirSync(backupsOf(home)), [`pre-migrate-${STAMP}`], 'one backup directory');
  });

  it('migrate and migrate --apply on an empty HOME print the no-store line, exit 0 and create no state directory', () => {
    const { home } = fixture();
    for (const args of [['migrate'], ['migrate', '--apply']]) {
      const r = runCli(args, { home });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(linesOf(r.stdout), ['migrate: no store.db; nothing to migrate (the first ingest creates it at the latest schema)']);
      assert.equal(existsSync(stateDirOf(home)), false, `${args.join(' ')} created no state directory`);
    }
  });

  it('migrate --apply while an ingest holds the lock prints the skip line, exits 0 and applies nothing', async () => {
    const { home } = fixture();
    const st = await pendingStore(home);
    const got = acquireLock({ home });
    assert.equal(got.acquired, true);
    let r;
    try {
      r = runCli(['migrate', '--apply'], { home });
    } finally {
      releaseLock(got.handle);
    }
    assert.equal(r.status, 0, r.stderr);
    const lines = linesOf(r.stdout);
    assert.match(lines.at(-1), /^migrate: skipped, an ingest holds the lock \(pid \d+ since \S+\); nothing was applied$/);
    assert.equal(existsSync(backupsOf(home)), false, 'no backup');
    unchanged(home, st);
  });

  it('a store newer than this rigorscope makes migrate and migrate --apply exit 1 with the too-new line', async () => {
    const { home } = fixture();
    const { latest } = await allMigrations();
    openStore({ home }).close();
    const raw = new DatabaseSync(storePath(home));
    raw.exec(`PRAGMA user_version = ${latest + 1}`);
    raw.close();
    const sha = sha256File(storePath(home));
    for (const args of [['migrate'], ['migrate', '--apply']]) {
      const r = runCli(args, { home });
      assert.equal(r.status, 1, args.join(' '));
      assert.equal(r.stdout, '');
      const message = oneStderrLine(r);
      assert.match(message, new RegExp(`schema version ${latest + 1}, newer than the latest this rigorscope supports \\(${latest}\\)`));
    }
    assert.equal(sha256File(storePath(home)), sha);
    assert.equal(existsSync(backupsOf(home)), false);
  });
});

describe('migrate --apply: a failed step applies nothing', () => {
  it('an existing backup directory for the stamp fails the backup: exit 1, nothing applied', async () => {
    const { home } = fixture();
    const st = await pendingStore(home);
    mkdirSync(join(backupsOf(home), `pre-migrate-${STAMP}`), { recursive: true, mode: 0o700 });
    const r = runCli(['migrate', '--apply'], { home });
    assert.equal(r.status, 1, r.stdout);
    noHomeIn(home, r);
    const lines = linesOf(r.stdout);
    assert.ok(lines.includes(`backup: FAILED pre-migrate-${STAMP}: already exists, never overwritten`), lines.join('|'));
    assert.equal(lines.at(-1), `migrate: nothing applied; store.db stays at schema v${st.latest - 1}`);
    unchanged(home, st);
  });

  it('a copy changed after the backup fails the verify: exit 1, nothing applied', async () => {
    const { home } = fixture();
    const st = await pendingStore(home);
    const res = await inProcess(home, { afterBackup: ({ dir }) => flipLastByte(join(dir, 'store.db')) });
    assert.equal(res.exitCode, 1);
    assert.ok(res.lines.includes('verify: FAILED'), res.lines.join('|'));
    assert.equal(res.lines.at(-1), `migrate: nothing applied; store.db stays at schema v${st.latest - 1}`);
    assert.ok(res.lines.every((l) => !l.includes(home)), 'no HOME path in any line');
    unchanged(home, st);
  });

  // Review 02-01 WR-03: a backup or verify step that throws (instead of returning code 1) must still end in the
  // FAILED line for its step and the nothing-applied line, exit 1, with the lock released and no internal error.
  it('a backup step that throws (backups is a regular file) prints the FAILED and nothing-applied lines: exit 1', async () => {
    const { home } = fixture();
    const st = await pendingStore(home);
    writeFileSync(backupsOf(home), 'not a directory\n');
    const r = runCli(['migrate', '--apply'], { home });
    assert.equal(r.stderr, '', 'no internal error on stderr');
    assert.equal(r.status, 1, r.stdout);
    noHomeIn(home, r);
    const lines = linesOf(r.stdout);
    assert.deepEqual(lines.slice(-2), [
      'migrate: FAILED backup (the backups entry is not a directory)',
      `migrate: nothing applied; store.db stays at schema v${st.latest - 1}`,
    ], lines.join('|'));
    assert.equal(existsSync(lockOf(home)), false, 'the lock is released');
    unchanged(home, st);
  });

  it('a verify step that throws (the backup directory cannot be listed) prints the FAILED and nothing-applied lines: exit 1', async (t) => {
    if (process.getuid?.() === 0) {
      t.skip('root reads a directory without the read bit');
      return;
    }
    const { home } = fixture();
    const st = await pendingStore(home);
    let leaf = null;
    // Runs before the fixture cleanup (the cleanups run last-in first-out), so the directory can be removed.
    cleanups.push(() => { if (leaf) chmodSync(leaf, 0o700); });
    const res = await inProcess(home, {
      afterBackup: ({ dir }) => {
        leaf = dir;
        chmodSync(dir, 0o300); // entries stay reachable by name; listing the directory fails with EACCES
      },
    });
    assert.equal(res.exitCode, 1);
    assert.deepEqual(res.lines.slice(-2), [
      'migrate: FAILED verify (EACCES)',
      `migrate: nothing applied; store.db stays at schema v${st.latest - 1}`,
    ], res.lines.join('|'));
    assert.ok(res.lines.every((l) => !l.includes(home)), 'no HOME path in any line');
    assert.equal(existsSync(lockOf(home)), false, 'the lock is released');
    unchanged(home, st);
  });

  it('a migration whose SQL fails rolls back alone and names the verified backup: exit 1', async () => {
    const { home } = fixture();
    const st = await pendingStore(home);
    const { all, latest } = await allMigrations();
    const dir = mkdtempSync(join(tmpdir(), 'rigorscope-badmig-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const m of all.slice(0, latest - 1)) writeFileSync(join(dir, m.name), readFileSync(join(MIGRATIONS, m.name)));
    const badName = `${String(latest).padStart(3, '0')}-bad-sql`;
    writeFileSync(join(dir, `${badName}.mjs`), `export const version = ${latest};\nexport const sql = 'CREATE TABLE ok_before_fail (a INTEGER) STRICT; THIS IS NOT SQL;';\n`);
    const bad = await loadMigrations(dir);
    const res = await inProcess(home, { migrations: bad });
    assert.equal(res.exitCode, 1);
    assert.match(res.lines.at(-1), new RegExp(`^migrate: FAILED applying ${badName} \\([A-Za-z0-9_]+\\); store\\.db at schema v${latest - 1}; `
      + `the verified backup is <state dir>/backups/pre-migrate-${STAMP}$`));
    assert.ok(res.lines.includes('verify: ok'), 'the backup verified before the apply');
    assert.equal(userVersionOf(home), latest - 1);
    assert.equal(queryDb(storePath(home), "SELECT count(*) AS n FROM sqlite_master WHERE name = 'ok_before_fail'")[0].n, 0);
    assert.equal(st.latest, latest);
  });
});

describe('cost and evidence on a pending store', () => {
  for (const args of [['cost'], ['evidence', 'main/total']]) {
    it(`${args[0]} exits 1 with the one-line pending message and changes no byte of store.db`, async () => {
      const { home } = fixture();
      const st = await pendingStore(home);
      const r = runCli(args, { home });
      assert.equal(r.status, 1, r.stdout);
      assert.equal(r.stdout, '');
      noHomeIn(home, r);
      assertPendingMessage(oneStderrLine(r), st.latest);
      unchanged(home, st);
    });
  }
});

describe('opt-in scope (static scan of src)', () => {
  it('only src/store/migrate.mjs passes the migrate option, on exactly one non-comment line', () => {
    const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (
      e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.mjs') ? [join(d, e.name)] : []));
    const hits = {};
    for (const file of walk(SRC)) {
      const n = readFileSync(file, 'utf8').split('\n')
        .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l) && /\bmigrate\s*:\s*true\b/.test(l)).length;
      if (n) hits[relative(SRC, file)] = n;
    }
    assert.deepEqual(hits, { [join('store', 'migrate.mjs')]: 1 });
  });
});
