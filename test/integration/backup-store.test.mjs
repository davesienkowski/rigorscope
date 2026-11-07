// Plan 01-12 Task 1 (RR-08, DATA-03): the Node-only store backup helper scripts/backup-store.mjs. Written before
// the script. Every run is a child process over a synthetic HOME (makeHome: its name holds a space and a hash
// character) whose state directory holds a store.db in WAL mode with a writer connection kept open and rows that
// exist only in the -wal file, plus a derived.db in rollback-journal mode. The stores are built with the Db class
// of src/db.mjs, never from the real schema, so no test depends on the migration count.
//
// The copies are read here through an immutable URI opened directly with the sqlite module (independent of the
// code under test), so reading a copy never leaves a sidecar file beside it.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../../src/db.mjs';
import { REPO, cliEnv, makeHome, sha256File, stateDirOf } from '../fixtures/build.mjs';
import { FIXTURE_NOW } from '../fixtures/clock.mjs';

const SCRIPT = join(REPO, 'scripts', 'backup-store.mjs');
// FIXTURE_NOW is 2026-10-28T12:00:00.000Z; the stamp is its UTC digits with T and Z, computed by hand.
const STAMP = '20261028T120000Z';
const HEX64 = /^[0-9a-f]{64}$/;
const FILE_LINE = /^(store\.db|derived\.db) sha256: ([0-9a-f]{64}) bytes: (\d+) user_version: (\d+) integrity_check: (\S+)$/;

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function freshHome() {
  const ctx = makeHome();
  cleanups.push(ctx.cleanup);
  return ctx.home;
}

// Runs the helper as a child. Every run, failing ones included, must keep the HOME path out of its output.
function helper(home, args, { env } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO, env: env ?? cliEnv(home), encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
  });
  if (r.signal || r.error) throw new Error(`helper child failed: signal=${r.signal} error=${r.error?.code ?? null}`);
  assert.ok(!r.stdout.includes(home) && !r.stderr.includes(home), 'no HOME path in stdout or stderr');
  assert.ok(!r.stdout.includes(tmpdir() + '/') && !r.stderr.includes(tmpdir() + '/'), 'no temp-dir path in the output');
  return r;
}

const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const fileLines = (text) => linesOf(text).filter((l) => FILE_LINE.test(l));
const mode = (p) => statSync(p).mode & 0o777;

// A live state directory: store.db in WAL mode with rows only in the -wal file and its writer left open, and
// (unless derived: false) a derived.db in rollback-journal mode. Returns the open writer.
function buildLive(home, { derived = true } = {}) {
  const dir = stateDirOf(home);
  mkdirSync(dir, { mode: 0o700 });
  const w = new Db(join(dir, 'store.db'));
  cleanups.push(() => { try { w.close(); } catch { /* already closed */ } });
  w.exec('PRAGMA journal_mode = WAL');
  w.exec('PRAGMA foreign_keys = ON');
  w.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT) STRICT;
          CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent (id), note TEXT) STRICT;`);
  w.exec("INSERT INTO parent VALUES (1, 'a'), (2, 'b'); INSERT INTO child VALUES (1, 1, NULL), (2, 2, 'x');");
  w.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  w.exec('PRAGMA wal_autocheckpoint = 0');
  w.exec("INSERT INTO parent VALUES (3, 'wal-only'); INSERT INTO child VALUES (3, 3, 'wal-only');");
  w.exec('PRAGMA user_version = 7');
  assert.ok(statSync(join(dir, 'store.db-wal')).size > 0, 'the fixture keeps rows in the -wal file');
  if (derived) {
    const d = new Db(join(dir, 'derived.db'));
    d.exec("CREATE TABLE d (k TEXT, v INTEGER) STRICT; INSERT INTO d VALUES ('one', 1), ('two', NULL);");
    d.exec('PRAGMA user_version = 3');
    d.close();
  }
  return w;
}

// Reads a copy through an immutable read-only URI (no sidecar file, no write).
function readCopy(file, sql) {
  const url = new URL(pathToFileURL(file).href);
  url.search = 'immutable=1';
  const db = new DatabaseSync(url, { readOnly: true });
  try {
    return db.prepare(sql).all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

const backupsDir = (home) => join(stateDirOf(home), 'backups');
const leaf = (home, label = 'pre-upgrade') => join(backupsDir(home), `${label}-${STAMP}`);
const treeHashes = (dir) => readdirSync(dir).sort().map((n) => `${n}:${sha256File(join(dir, n))}`);

describe('backup of a live state directory', () => {
  it('copies a WAL store held open by a writer, rows only in the -wal included, and prints the hash lines', () => {
    const home = freshHome();
    buildLive(home);
    const r = helper(home, []);
    assert.equal(r.status, 0, r.stderr);
    const lines = linesOf(r.stdout);
    assert.equal(lines[0], `backup: <state dir>/backups/pre-upgrade-${STAMP}`);
    assert.equal(lines[lines.length - 1], 'backup: ok');
    const files = fileLines(r.stdout).map((l) => FILE_LINE.exec(l));
    assert.deepEqual(files.map((m) => m[1]), ['store.db', 'derived.db']);
    const [store, derived] = files;
    assert.equal(store[2], sha256File(join(leaf(home), 'store.db')), 'printed sha256 equals the copy');
    assert.equal(derived[2], sha256File(join(leaf(home), 'derived.db')));
    assert.equal(Number(store[3]), statSync(join(leaf(home), 'store.db')).size);
    assert.equal(store[4], '7');
    assert.equal(derived[4], '3');
    assert.equal(store[5], 'ok');
    assert.equal(derived[5], 'ok');
    assert.equal(lines.length, 4);
    const walOnly = readCopy(join(leaf(home), 'store.db'), "SELECT count(*) AS n FROM parent WHERE name = 'wal-only'");
    assert.deepEqual(walOnly, [{ n: 1 }], 'the copy holds the rows that were only in the -wal file');
  });

  it('the backup directory holds exactly the manifest and the two copies, 0700 and 0600, also after verify, check and sql', () => {
    const home = freshHome();
    buildLive(home);
    const r = helper(home, []);
    assert.equal(r.status, 0, r.stderr);
    const expect = ['MANIFEST.txt', 'derived.db', 'store.db'];
    assert.deepEqual(readdirSync(leaf(home)).sort(), expect);
    assert.equal(mode(backupsDir(home)), 0o700);
    assert.equal(mode(leaf(home)), 0o700);
    for (const f of expect) assert.equal(mode(join(leaf(home), f)), 0o600, f);
    const manifest = readFileSync(join(leaf(home), 'MANIFEST.txt'), 'utf8');
    assert.deepEqual(fileLines(manifest), fileLines(r.stdout), 'the manifest holds the printed file lines');
    assert.ok(linesOf(manifest).includes('label: pre-upgrade'));
    assert.ok(linesOf(manifest).includes(`instant: ${FIXTURE_NOW}`));
    assert.equal(helper(home, ['--verify']).status, 0);
    assert.equal(helper(home, ['--check', '--of', 'latest']).status, 0);
    assert.equal(helper(home, ['--sql', 'SELECT count(*) FROM parent', '--of', 'latest']).status, 0);
    assert.deepEqual(readdirSync(leaf(home)).sort(), expect, 'no -wal or -shm beside a copy');
  });

  it('leaves the live files untouched and adds only backups/ to the state directory', () => {
    const home = freshHome();
    buildLive(home);
    const dir = stateDirOf(home);
    const live = ['store.db', 'store.db-wal', 'derived.db'];
    const before = live.map((f) => sha256File(join(dir, f)));
    const entriesBefore = readdirSync(dir).sort();
    assert.equal(helper(home, []).status, 0);
    assert.equal(helper(home, ['--check']).status, 0);
    assert.equal(helper(home, ['--sql', 'SELECT count(*) FROM child']).status, 0);
    assert.deepEqual(live.map((f) => sha256File(join(dir, f))), before);
    assert.deepEqual(readdirSync(dir).sort(), [...entriesBefore, 'backups'].sort());
  });

  it('without derived.db prints the skip line and exits 0; the backup still verifies', () => {
    const home = freshHome();
    buildLive(home, { derived: false });
    const r = helper(home, []);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(linesOf(r.stdout).includes('derived.db: absent, skipped'));
    assert.deepEqual(readdirSync(leaf(home)).sort(), ['MANIFEST.txt', 'store.db']);
    const v = helper(home, ['--verify']);
    assert.equal(v.status, 0, v.stdout + v.stderr);
  });

  it('without store.db exits 1 naming store.db and creates no backups/ directory', () => {
    const home = freshHome();
    mkdirSync(stateDirOf(home), { mode: 0o700 });
    const r = helper(home, []);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /store\.db/);
    assert.equal(existsSync(backupsDir(home)), false);
    const bare = freshHome();
    const r2 = helper(bare, []);
    assert.equal(r2.status, 1);
    assert.match(r2.stdout + r2.stderr, /store\.db/);
    assert.equal(existsSync(stateDirOf(bare)), false, 'no state directory is created');
  });

  it('refuses a state directory that is a symlink, writing nothing through it', () => {
    const home = freshHome();
    const target = mkdtempSync(join(tmpdir(), 'rigorscope-backup-target-'));
    cleanups.push(() => rmSync(target, { recursive: true, force: true }));
    writeFileSync(join(target, 'store.db'), '');
    symlinkSync(target, stateDirOf(home));
    const r = helper(home, []);
    assert.equal(r.status, 1);
    assert.deepEqual(readdirSync(target), ['store.db'], 'nothing was written through the link');
  });

  it('a second run under the same stamp exits 1 and leaves the first backup byte-identical', () => {
    const home = freshHome();
    buildLive(home);
    assert.equal(helper(home, []).status, 0);
    const before = treeHashes(leaf(home));
    const r = helper(home, []);
    assert.equal(r.status, 1);
    assert.deepEqual(treeHashes(leaf(home)), before);
  });

  it('rejects an invalid --label with exit 2 and creates nothing', () => {
    const home = freshHome();
    buildLive(home);
    for (const label of ['..', 'A', 'a/b', '']) {
      const r = helper(home, ['--label', label]);
      assert.equal(r.status, 2, `label ${JSON.stringify(label)}`);
    }
    assert.equal(existsSync(backupsDir(home)), false);
  });
});

describe('--verify', () => {
  it('re-hashes the newest backup (default) and a named one, printing the same file lines', () => {
    const home = freshHome();
    buildLive(home);
    const b = helper(home, ['--label', 'pre-migration-005-006']);
    assert.equal(b.status, 0, b.stderr);
    for (const args of [['--verify'], ['--verify', '--of', 'latest', '--label', 'pre-migration-005-006'],
      ['--verify', '--of', `pre-migration-005-006-${STAMP}`]]) {
      const v = helper(home, args);
      assert.equal(v.status, 0, `${args.join(' ')}: ${v.stdout}${v.stderr}`);
      assert.deepEqual(fileLines(v.stdout), fileLines(b.stdout));
      assert.equal(linesOf(v.stdout).at(-1), 'verify: ok');
    }
  });

  it('a changed byte of a copy fails naming store.db and its sha256', () => {
    const home = freshHome();
    buildLive(home);
    assert.equal(helper(home, []).status, 0);
    const copy = join(leaf(home), 'store.db');
    const buf = readFileSync(copy);
    buf[buf.length - 1] ^= 0xff;
    writeFileSync(copy, buf);
    chmodSync(copy, 0o600);
    const v = helper(home, ['--verify']);
    assert.equal(v.status, 1);
    assert.match(v.stdout, /store\.db.*sha256/);
    assert.equal(linesOf(v.stdout).at(-1), 'verify: FAILED');
  });

  it('a copy readable by group or other fails naming the mode', () => {
    const home = freshHome();
    buildLive(home);
    assert.equal(helper(home, []).status, 0);
    chmodSync(join(leaf(home), 'derived.db'), 0o644);
    const v = helper(home, ['--verify']);
    assert.equal(v.status, 1);
    assert.match(v.stdout, /derived\.db.*mode/);
  });

  it('a deleted copy or a deleted manifest fails, a bad --of is a usage error, and no run adds an entry', () => {
    const home = freshHome();
    buildLive(home);
    assert.equal(helper(home, []).status, 0);
    assert.equal(helper(home, ['--verify', '--of', '../x']).status, 2);
    unlinkSync(join(leaf(home), 'derived.db'));
    assert.equal(helper(home, ['--verify']).status, 1);
    assert.deepEqual(readdirSync(leaf(home)).sort(), ['MANIFEST.txt', 'store.db']);
    unlinkSync(join(leaf(home), 'MANIFEST.txt'));
    const v = helper(home, ['--verify']);
    assert.equal(v.status, 1);
    assert.match(v.stdout + v.stderr, /MANIFEST/);
    assert.deepEqual(readdirSync(leaf(home)).sort(), ['store.db']);
  });
});

describe('--check', () => {
  it('reports the live files and fails on a foreign key violation', () => {
    const home = freshHome();
    buildLive(home);
    const r = helper(home, ['--check']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = linesOf(r.stdout);
    assert.ok(lines.includes('store.db user_version: 7 integrity_check: ok foreign_key_check rows: 0'), r.stdout);
    assert.ok(lines.includes('derived.db user_version: 3 integrity_check: ok foreign_key_check rows: 0'), r.stdout);
    assert.equal(lines.at(-1), 'check: ok');
    const loose = new Db(join(stateDirOf(home), 'store.db'));
    loose.exec('PRAGMA foreign_keys = OFF');
    loose.exec("INSERT INTO child VALUES (4, 99, 'dangling')");
    loose.close();
    const bad = helper(home, ['--check']);
    assert.equal(bad.status, 1);
    assert.ok(linesOf(bad.stdout).includes('store.db user_version: 7 integrity_check: ok foreign_key_check rows: 1'), bad.stdout);
    assert.equal(linesOf(bad.stdout).at(-1), 'check: FAILED');
  });

  it('--of latest checks the copy and leaves no sidecar; a missing derived.db prints absent', () => {
    const home = freshHome();
    buildLive(home, { derived: false });
    assert.equal(helper(home, []).status, 0);
    const r = helper(home, ['--check', '--of', 'latest']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(linesOf(r.stdout).includes('store.db user_version: 7 integrity_check: ok foreign_key_check rows: 0'));
    assert.ok(linesOf(r.stdout).includes('derived.db: absent'));
    assert.deepEqual(readdirSync(leaf(home)).sort(), ['MANIFEST.txt', 'store.db']);
  });

  it('a store.db that is not a database exits 1 naming store.db and no path', () => {
    const home = freshHome();
    mkdirSync(stateDirOf(home), { mode: 0o700 });
    writeFileSync(join(stateDirOf(home), 'store.db'), 'this is not a database file, only text bytes '.repeat(40));
    const r = helper(home, ['--check']);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /store\.db/);
  });
});

describe('--sql', () => {
  it('prints a count bare, NULL as NULL with tab separators, reads derived.db and a copy, and refuses a write', () => {
    const home = freshHome();
    buildLive(home);
    const count = helper(home, ['--sql', 'SELECT count(*) FROM parent']);
    assert.equal(count.status, 0, count.stderr);
    assert.equal(count.stdout, '3\n');
    const row = helper(home, ['--sql', 'SELECT c.note, p.name FROM child c JOIN parent p ON p.id = c.parent_id WHERE c.id = 1']);
    assert.equal(row.stdout, 'NULL\ta\n');
    const derived = helper(home, ['--sql', 'SELECT k, v FROM d ORDER BY k', '--db', 'derived']);
    assert.equal(derived.stdout, 'one\t1\ntwo\tNULL\n');
    assert.equal(helper(home, []).status, 0);
    const copy = helper(home, ['--sql', "SELECT count(*) FROM parent WHERE name = 'wal-only'", '--of', 'latest']);
    assert.equal(copy.stdout, '1\n');
    assert.deepEqual(readdirSync(leaf(home)).sort(), ['MANIFEST.txt', 'derived.db', 'store.db']);
    const del = helper(home, ['--sql', 'DELETE FROM parent']);
    assert.equal(del.status, 1);
    assert.equal(helper(home, ['--sql', 'SELECT count(*) FROM parent']).stdout, '3\n', 'the rows remain');
  });

  it('--sql with --verify, --sql with no statement and two modes at once are usage errors', () => {
    const home = freshHome();
    buildLive(home);
    assert.equal(helper(home, ['--sql', 'SELECT 1', '--verify']).status, 2);
    assert.equal(helper(home, ['--sql']).status, 2);
    assert.equal(helper(home, ['--check', '--verify']).status, 2);
  });
});

describe('usage and hygiene', () => {
  it('an unknown option and an invalid RIGORSCOPE_NOW exit 2 with a message on stderr', () => {
    const home = freshHome();
    buildLive(home);
    const r = helper(home, ['--frobnicate']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
    const bad = helper(home, [], { env: cliEnv(home, { RIGORSCOPE_NOW: 'yesterday' }) });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /RIGORSCOPE_NOW/);
    assert.equal(existsSync(backupsDir(home)), false);
  });

  it('--home selects the state directory over HOME, under a name with a space and a hash character', () => {
    const home = freshHome();
    assert.ok(home.includes(' ') && home.includes('#'), 'the fixture HOME name holds a space and a hash');
    buildLive(home);
    const other = freshHome();
    const env = cliEnv(other);
    const run = (args) => {
      const r = spawnSync(process.execPath, [SCRIPT, '--home', home, ...args], { cwd: REPO, env, encoding: 'utf8', timeout: 60_000 });
      assert.ok(!r.stdout.includes(home) && !r.stderr.includes(home));
      return r;
    };
    assert.equal(run([]).status, 0);
    assert.equal(run(['--verify']).status, 0);
    assert.equal(run(['--sql', 'SELECT count(*) FROM parent']).stdout, '3\n');
    assert.equal(existsSync(stateDirOf(other)), false, 'the HOME state directory was not touched');
  });

  it('imports only node built-ins other than sqlite and files under src/, and spawns no process', () => {
    assert.ok(existsSync(SCRIPT), 'the helper exists');
    const text = readFileSync(SCRIPT, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const specs = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g)].map((m) => m[2]);
    assert.ok(specs.length > 0, 'the helper imports something');
    for (const s of specs) {
      const ok = (s.startsWith('node:') && s !== 'node:sqlite') || s.startsWith('../src/');
      assert.ok(ok, `import ${s} is a node built-in other than sqlite or a file under src/`);
    }
    assert.ok(!/child_process|node:sqlite/.test(text), 'no process-spawning module and no sqlite import');
    // Plan 02-01: the backup and verify code moved to src/store/backup.mjs (shared with rigorscope migrate --apply);
    // the same rules hold there. Its relative imports must stay under src/.
    const MODULE = join(REPO, 'src', 'store', 'backup.mjs');
    assert.ok(existsSync(MODULE), 'the shared backup module exists');
    const mtext = readFileSync(MODULE, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const mspecs = [...mtext.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g)].map((m) => m[2]);
    assert.ok(mspecs.length > 0, 'the module imports something');
    const SRC = join(REPO, 'src') + '/';
    for (const s of mspecs) {
      const ok = (s.startsWith('node:') && s !== 'node:sqlite') || (s.startsWith('.') && join(REPO, 'src', 'store', s).startsWith(SRC));
      assert.ok(ok, `module import ${s} is a node built-in other than sqlite or a file under src/`);
    }
    assert.ok(!/child_process|node:sqlite/.test(mtext), 'the module has no process-spawning module and no sqlite import');
  });
});
