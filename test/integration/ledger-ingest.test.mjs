// Plan 03-03 Task 2 (LEDG-03, D-12, J3, J12, R2, R3): the ledger source through real ingest runs on temporary HOMEs:
// cursor, partial last line, replaced and truncated files, the tolerant reader, key conflicts, the J12 counter identities,
// doctor's `ledger-lines:` line, symlinks and freshness. Written before the code (RED). The real ~/.rigorscope is never
// touched; every HOME comes from makeHome().
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  PLANTS, cliEnv, ingestHome, makeHome, queryDb, runCli, stateDirOf,
} from '../fixtures/build.mjs';
import { buildLine } from '../../src/ledger/line.mjs';
import { loadFreshness } from '../../src/report/freshness.mjs';
import { loadDoctor } from '../../src/report/doctor.mjs';
import { loadMigrations, openStore } from '../../src/db.mjs';
import { fileURLToPath } from 'node:url';

const REPO_KEY = '~/repos/alpha/.git';
const MIGRATIONS = fileURLToPath(new URL('../../src/store/migrations/', import.meta.url));
const ledgerDir = (home) => join(stateDirOf(home), 'ledger');
const ledgerFile = (home) => join(ledgerDir(home), 'units.jsonl');
const storeOf = (home) => join(stateDirOf(home), 'store.db');

// The i-th distinct valid start line (a distinct unit and time, so a distinct line_id).
const mk = (i, over = {}) => {
  const r = buildLine({
    record: 'start', ts: `2026-10-28T12:00:0${i}.000Z`, repo_key: REPO_KEY, kind: 'quick', native_id: `26102${i}-a1b`, tier: 'B',
    tier_source: 'declared-at-start', start: `2026-10-28T12:00:0${i}.000Z`, ...over,
  });
  assert.equal(r.ok, true, r.reason);
  return r;
};

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });
function home() {
  const ctx = makeHome();
  cleanups.push(ctx.cleanup);
  return ctx.home;
}
const put = (h, text) => {
  mkdirSync(ledgerDir(h), { recursive: true });
  writeFileSync(ledgerFile(h), text, { mode: 0o600 });
};
const rowsOf = (h, sql = 'SELECT count(*) AS n FROM ledger_line') => queryDb(storeOf(h), sql);
const count = (h) => rowsOf(h)[0].n;

// The run's ledger figures: the ingest_source_run row and the name-keyed counts.
function figures(h, runId) {
  const sr = queryDb(storeOf(h), "SELECT * FROM ingest_source_run WHERE run_id = ? AND source = 'ledger'", [runId])[0];
  const c = {};
  for (const r of queryDb(storeOf(h), "SELECT kind, name, n FROM ingest_count WHERE run_id = ? AND source = 'ledger'", [runId])) {
    c[r.kind] ??= {};
    c[r.kind][r.name] = r.n;
  }
  const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
  return { sr, c, dropped: sum(c.dropped), kept: c.lines?.kept ?? 0, blank: c.lines?.blank ?? 0, keyConflict: c.conflict?.key_conflict ?? 0 };
}
// Identity A and B of J12.
function assertIdentities(f) {
  assert.equal(f.sr.lines_read, f.blank + f.sr.oversized + f.sr.unparseable + f.dropped + f.kept, 'identity A');
  assert.ok(f.sr.rows_upserted + f.keyConflict <= f.kept, 'identity B');
}
const ingest = async (h) => (await ingestHome(h)).runId;

describe('cursor behavior of the ledger source', () => {
  it('inserts once, then nothing; an appended line is read from the stored offset', async () => {
    const h = home();
    put(h, [mk(1), mk(2), mk(3)].map((x) => x.text).join(''));
    const r1 = figures(h, await ingest(h));
    assert.equal(r1.sr.rows_upserted, 3);
    assert.equal(count(h), 3);
    assertIdentities(r1);

    const r2 = figures(h, await ingest(h));
    assert.equal(r2.sr.rows_upserted, 0);
    assert.equal(r2.sr.lines_read, 0);
    assert.equal(r2.sr.files_unchanged, 1, 'the file is reported unchanged');
    assert.equal(count(h), 3);

    appendFileSync(ledgerFile(h), mk(4).text);
    const r3 = figures(h, await ingest(h));
    assert.equal(r3.sr.lines_read, 1, 'read from the stored offset, not from 0');
    assert.equal(r3.sr.rows_upserted, 1);
    assert.equal(count(h), 4);
    assertIdentities(r3);
  });

  it('a final line without LF is not read until it is completed', async () => {
    const h = home();
    const a = mk(1).text;
    const b = mk(2).text;
    put(h, a + b.slice(0, -1));
    const r1 = figures(h, await ingest(h));
    assert.equal(r1.sr.rows_upserted, 1);
    assert.ok(r1.sr.pending_tail_bytes > 0, 'the pending tail is counted');
    assert.equal(count(h), 1);
    appendFileSync(ledgerFile(h), '\n');
    const r2 = figures(h, await ingest(h));
    assert.equal(r2.sr.rows_upserted, 1);
    assert.equal(count(h), 2);
  });

  it('a replaced file with the same lines plus one new inserts exactly the new one (R2: by kind and key)', async () => {
    const h = home();
    const lines = [mk(1), mk(2), mk(3)];
    put(h, lines.map((x) => x.text).join(''));
    await ingest(h);
    const tmp = join(ledgerDir(h), 'units.jsonl.new');
    writeFileSync(tmp, [...lines, mk(4)].map((x) => x.text).join(''), { mode: 0o600 });
    renameSync(tmp, ledgerFile(h));
    const f = figures(h, await ingest(h));
    assert.equal(f.sr.files_reread, 1, 'the replaced file is reread from 0');
    assert.equal(f.sr.rows_upserted, 1);
    assert.equal(f.kept, 4, 'kept counts every line read again');
    assertIdentities(f);
    assert.deepEqual(rowsOf(h, 'SELECT line_id FROM ledger_line ORDER BY line_id').map((r) => r.line_id),
      [...lines, mk(4)].map((x) => x.line.line_id).sort());
  });

  it('a shorter replacement file inserts nothing and deletes nothing', async () => {
    const h = home();
    put(h, [mk(1), mk(2), mk(3)].map((x) => x.text).join(''));
    await ingest(h);
    const before = rowsOf(h, 'SELECT * FROM ledger_line ORDER BY line_id');
    const tmp = join(ledgerDir(h), 'units.jsonl.new');
    writeFileSync(tmp, mk(2).text, { mode: 0o600 });
    renameSync(tmp, ledgerFile(h));
    const f = figures(h, await ingest(h));
    assert.equal(f.sr.rows_upserted, 0);
    assert.deepEqual(rowsOf(h, 'SELECT * FROM ledger_line ORDER BY line_id'), before, 'the store is the record');
  });
});

describe('the tolerant reader through ingest (J3)', () => {
  it('one run holding each outcome once: identity A holds and every bad line stores nothing', async () => {
    const h = home();
    const reject = { ...mk(1).line, tier: 'a' };
    const oversized = JSON.stringify({ ...mk(2).line, extra: 'x'.repeat(9000) });
    const text = [
      mk(3).text,
      '\n',
      '{"v":1, nope\n',
      '[1]\n',
      '{"v":2}\n',
      `${JSON.stringify(reject)}\n`,
      `${oversized}\n`,
    ].join('');
    put(h, text);
    const f = figures(h, await ingest(h));
    assert.equal(count(h), 1);
    assert.equal(f.kept, 1);
    assert.equal(f.blank, 1);
    assert.equal(f.sr.unparseable, 1);
    assert.equal(f.sr.oversized, 1);
    assert.deepEqual(f.c.dropped, { not_object: 1, unknown_version: 1, bad_tier: 1 });
    assert.equal(f.sr.lines_read, 7);
    assertIdentities(f);
    assert.equal(f.c.dropped.bad_json, undefined, 'a not-JSON line counts once, as unparseable');
  });

  it('dropped lines store nothing: no plant reaches store.db, derived.db or the run log', async () => {
    const h = home();
    const planted = JSON.stringify({
      ...mk(1).line, branch: `x/${PLANTS.email}`, [`k ${PLANTS.email}`]: 1, session_id: PLANTS.osUser, tier: PLANTS.prompt,
    });
    const alsoBad = JSON.stringify({ ...mk(2).line, native_id: PLANTS.command });
    put(h, `${planted}\n${alsoBad}\n${mk(3, { session_id: 'sess-ok' }).text}`);
    await ingest(h);
    assert.equal(count(h), 1, 'only the clean line is stored');
    for (const name of readdirSync(stateDirOf(h))) {
      const p = join(stateDirOf(h), name);
      if (!statSync(p).isFile()) continue;
      const bytes = readFileSync(p);
      for (const plant of [PLANTS.email, PLANTS.prompt, PLANTS.command, PLANTS.osUser]) {
        assert.ok(!bytes.includes(Buffer.from(plant)), `${name} holds no plant`);
      }
    }
  });

  it('a line with an extra key is stored without the key and the name is tallied', async () => {
    const h = home();
    put(h, `${JSON.stringify({ ...mk(1).line, branch: 'feature/secret-branch' })}\n${JSON.stringify({ ...mk(2).line, 'has space': 1 })}\n`);
    const f = figures(h, await ingest(h));
    assert.equal(count(h), 2);
    assert.deepEqual(f.c.rejected_field, { branch: 1, '?': 1 });
    const cols = Object.keys(rowsOf(h, 'SELECT * FROM ledger_line LIMIT 1')[0]);
    assert.ok(!cols.includes('branch'));
    assert.ok(!JSON.stringify(rowsOf(h, 'SELECT * FROM ledger_line')).includes('secret-branch'));
  });

  it('a key conflict keeps the stored row: same line_id, different content', async () => {
    const h = home();
    const first = mk(1);
    put(h, first.text);
    await ingest(h);
    const before = rowsOf(h, 'SELECT * FROM ledger_line');
    const clash = { ...first.line, command: 'gsd-quick' }; // same line_id, different content
    appendFileSync(ledgerFile(h), `${JSON.stringify(clash)}\n`);
    const f = figures(h, await ingest(h));
    assert.equal(f.sr.rows_upserted, 0);
    assert.equal(f.keyConflict, 1, 'counted under conflict / key_conflict');
    assert.equal(f.kept, 1, 'a conflicting line is in kept');
    assert.equal(f.c.dropped, undefined, 'and in no dropped row');
    assertIdentities(f);
    assert.deepEqual(rowsOf(h, 'SELECT * FROM ledger_line'), before, 'the stored row is unchanged');
  });

  it('an identical line again is neither inserted nor a conflict', async () => {
    const h = home();
    const first = mk(1);
    put(h, first.text);
    await ingest(h);
    appendFileSync(ledgerFile(h), first.text);
    const f = figures(h, await ingest(h));
    assert.equal(f.sr.rows_upserted, 0);
    assert.equal(f.keyConflict, 0);
    assert.equal(f.kept, 1);
    assert.equal(count(h), 1);
  });
});

describe('files, symlinks and freshness', () => {
  it('a symlinked ledger directory is skipped and counted; nothing is read through it', async () => {
    const h = home();
    await ingest(h);
    const other = join(h, 'elsewhere');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'units.jsonl'), mk(1).text);
    symlinkSync(other, ledgerDir(h));
    const f = figures(h, await ingest(h));
    assert.equal(count(h), 0);
    assert.equal(f.c.walk_skip?.symlink, 1);
    assert.equal(f.sr.files, 0);
  });

  it('a symlinked units.jsonl is skipped and counted', async () => {
    const h = home();
    await ingest(h);
    const other = join(h, 'elsewhere.jsonl');
    writeFileSync(other, mk(1).text);
    mkdirSync(ledgerDir(h), { recursive: true });
    symlinkSync(other, ledgerFile(h));
    const f = figures(h, await ingest(h));
    assert.equal(count(h), 0);
    assert.equal(f.c.walk_skip?.symlink, 1);
  });

  it('an absent ledger directory is not an error and leaves no source root', async () => {
    const h = home();
    await ingest(h);
    assert.equal(existsSync(ledgerDir(h)), false);
    assert.equal(count(h), 0);
    assert.deepEqual(rowsOf(h, "SELECT 1 FROM source_root WHERE source = 'ledger'"), []);
  });

  it('the ledger freshness row is not rated and never makes the verdict STALE', async () => {
    const h = home();
    put(h, mk(1).text);
    await ingest(h);
    const far = Date.parse('2030-01-01T00:00:00Z');
    const fr = loadFreshness({ home: h, nowMs: far });
    const row = fr.sources.find((s) => s.name === 'ledger');
    assert.equal(row.state, 'not_rated');
    assert.notEqual(row.state, 'stale');
    assert.ok(!fr.sources.filter((s) => s.name === 'ledger').some((s) => s.state === 'stale'));
  });
});

describe('doctor ledger-lines', () => {
  it('prints kept, dropped by reason, unknown keys and the last run', async () => {
    const h = home();
    put(h, [mk(1).text, '{"v":1, nope\n', `${JSON.stringify({ ...mk(2).line, tier: 'a' })}\n`, `${JSON.stringify({ ...mk(3).line, branch: 'b' })}\n`].join(''));
    await ingest(h);
    const r = runCli(['doctor'], { home: h, env: cliEnv(h) });
    assert.ok([0, 1, 2].includes(r.status), r.stderr);
    const line = r.stdout.split('\n').find((l) => l.startsWith('ledger-lines:'));
    assert.ok(line, 'the ledger-lines line is printed');
    assert.match(line, /rows=2 /);
    assert.match(line, /kept=2 /);
    assert.match(line, /dropped=1 /);
    assert.match(line, /bad_json=1 /);
    assert.match(line, /oversized=0 /);
    assert.match(line, /key_conflict=0 /);
    assert.match(line, /unknown_keys=1 /);
    assert.match(line, /last_run_dropped=2$/);
    assert.ok(r.stdout.split('\n').includes('  dropped bad_tier n=1'));
    assert.ok(r.stdout.split('\n').includes('  unknown-key branch n=1'));
    const j = JSON.parse(runCli(['doctor', '--json'], { home: h, env: cliEnv(h) }).stdout);
    assert.equal(j.ledger_lines.kept, 2);
  });

  it('unknown_keys is the exact total when more than 40 distinct key names are stored', async () => {
    const h = home();
    const extra = {};
    for (let i = 0; i < 60; i += 1) extra[`extra_key_${String(i).padStart(2, '0')}`] = 'x';
    put(h, `${JSON.stringify({ ...mk(1).line, ...extra })}\n`);
    await ingest(h);
    const stored = rowsOf(h, "SELECT count(*) AS names, coalesce(sum(n), 0) AS total FROM ingest_count WHERE source = 'ledger' AND kind = 'rejected_field'")[0];
    assert.equal(stored.names, 60);
    assert.equal(stored.total, 60);
    const r = runCli(['doctor'], { home: h, env: cliEnv(h) });
    assert.ok([0, 1, 2].includes(r.status), r.stderr);
    const out = r.stdout.split('\n');
    const line = out.find((l) => l.startsWith('ledger-lines:'));
    assert.ok(line, 'the ledger-lines line is printed');
    assert.match(line, /unknown_keys=60 /);
    assert.equal(out.filter((l) => l.startsWith('  unknown-key ')).length, 40, 'the display list stays capped at 40');
    const j = JSON.parse(runCli(['doctor', '--json'], { home: h, env: cliEnv(h) }).stdout);
    assert.equal(j.ledger_lines.unknown_keys, 60);
    assert.equal(j.ledger_lines.unknown_key_names.length, 40);
  });

  it('on a store that has no ledger_line table it prints the unavailable form', async () => {
    const h = home();
    const migrations = (await loadMigrations(MIGRATIONS)).filter((m) => m.version <= 7);
    openStore({ home: h, migrations }).close();
    const doc = await loadDoctor({ home: h, nowMs: Date.parse('2026-11-04T12:00:00Z') });
    assert.ok(typeof doc.ledger_lines.unavailable === 'string');
    rmSync(join(stateDirOf(h), 'store.db'), { force: true });
  });
});
