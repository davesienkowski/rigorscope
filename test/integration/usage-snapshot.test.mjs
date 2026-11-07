// Usage snapshots from the main Claude Code config file and from transcript usageReport lines (plan 01-06,
// D-11a, COST-04, DATA-03, DATA-05). Spawned CLI runs use a fixture HOME and cliEnv; in-process runIngest is
// used where a seam (usageMaxBytes, usagePick) or a hook (beforeCommit) is needed. No failure message holds a
// planted value: assertions compare indexes, counts and names.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFixtureTree, cliEnv, makeHome, runCli, runCliAsync, sha256, stateDirOf, windowsUsersDirFor, HELPERS,
} from '../fixtures/build.mjs';
import {
  CACHE_SOURCE, EXPECTED_WINDOW, MS, SNAPSHOTS, USAGE_NEEDLES, USAGE_PLANTS, cacheFileObject, usageReportLine,
  writeUsageCache,
} from '../fixtures/usage-cache.mjs';
import { DECOY, DECOY_FETCHED_MS } from '../canary/plants/usage.mjs';
import { leakyCachePick, leakyReportPick } from '../canary/leaky-usage-pick.mjs';
import { S14 } from '../fixtures/cases/95-usage-window.mjs';
import { DatabaseSync } from 'node:sqlite';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const STORE = (home) => join(stateDirOf(home), 'store.db');
const E = EXPECTED_WINDOW;
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

// Rows of a query, or [] when the table does not exist yet (a RED run fails on an assertion, not on SQL).
function q(home, sql, params = []) {
  let db;
  try {
    db = new DatabaseSync(STORE(home), { readOnly: true });
    return db.prepare(sql).all(...params).map((r) => ({ ...r }));
  } catch (err) {
    if (/no such (table|column)|unable to open/.test(String(err?.message))) return [];
    throw err;
  } finally {
    try { db?.close(); } catch { /* not opened */ }
  }
}

const SNAP_SQL = `SELECT ${E.snapshotColumns.join(', ')} FROM usage_snapshot ORDER BY fetched_at_ms, source`;
const snapRows = (home) => q(home, SNAP_SQL).map((r) => E.snapshotColumns.map((c) => r[c]));
const snapCount = (home) => q(home, 'SELECT count(*) AS n FROM usage_snapshot')[0]?.n ?? 0;
const limitRows = (home, source, fetched) => q(home, `
  SELECT l.seq, l.kind, l.grp, l.percent, l.resets_ms, l.severity, l.is_active
    FROM usage_limit l JOIN usage_snapshot s ON s.snapshot_id = l.snapshot_id
   WHERE s.source = ? AND s.fetched_at_ms = ? ORDER BY l.seq`, [source, fetched]).map((r) => Object.values(r));
// Key digest of both tables without the surrogate snapshot_id and the run bookkeeping.
function keyDigest(home) {
  const snaps = q(home, `SELECT ${E.snapshotColumns.join(', ')} FROM usage_snapshot ORDER BY source, fetched_at_ms`);
  const limits = q(home, `
    SELECT s.source, s.fetched_at_ms, l.seq, l.kind, l.grp, l.percent, l.resets_ms, l.severity, l.is_active
      FROM usage_limit l JOIN usage_snapshot s ON s.snapshot_id = l.snapshot_id ORDER BY s.source, s.fetched_at_ms, l.seq`);
  return { snapshots: snaps.length, limits: limits.length, digest: sha256(JSON.stringify([snaps, limits])) };
}

const usageLine = (stdout) => stdout.split('\n').find((l) => l.startsWith('usage: files=')) ?? null;
const cli = (home, args = ['ingest'], extra = {}) => runCli(args, { home, env: cliEnv(home, extra) });

async function ingestIn(home, options = {}) {
  const { runIngest } = await mod('ingest/run.mjs');
  return runIngest({ home, env: { HOME: home }, windowsUsersDir: windowsUsersDirFor(home), ...options });
}

// Index of every planted needle (and the email shape) found in a text or buffer; [] when clean.
function leaks(textOrBuf, extra = []) {
  const s = Buffer.isBuffer(textOrBuf) ? textOrBuf.toString('latin1') : String(textOrBuf);
  const found = [...USAGE_NEEDLES, ...extra].map((n, i) => (s.includes(n) ? i : -1)).filter((i) => i >= 0);
  if (EMAIL_SHAPE.test(s)) found.push('email-shape');
  return found;
}

function storeBytes(home) {
  const dir = stateDirOf(home);
  return ['store.db', 'store.db-wal', 'store.db-shm'].map((n) => {
    try { return readFileSync(join(dir, n)); } catch { return Buffer.alloc(0); }
  });
}

async function withHome(fn) {
  const ctx = makeHome();
  try {
    return await fn(ctx);
  } finally {
    ctx.cleanup();
  }
}

describe('usage snapshots: the cache file becomes one measured snapshot', () => {
  it('tracer: ingest stores the cache as one measured snapshot and prints a usage source line', () => withHome(async ({ home }) => {
    writeUsageCache(home, SNAPSHOTS.A);
    const r = cli(home);
    assert.equal(r.status, 0, 'ingest exit status');
    const line = usageLine(r.stdout);
    assert.ok(line !== null, 'a usage: source line is printed');
    assert.match(line, /^usage: files=1 new=1 reread=0 unchanged=0 skipped=0 /);
    assert.deepEqual(snapRows(home), [E.snapshotRows[0]]);
    assert.deepEqual(leaks(r.stdout + r.stderr), []);
  }));

  it('the four cache rewrites plus the transcript report give the five hand-computed rows; offsets normalize', () => withHome(async (ctx) => {
    await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['usage-window'] });
    for (const snap of [null, SNAPSHOTS.B, SNAPSHOTS.C, SNAPSHOTS.E]) {
      if (snap) writeUsageCache(ctx.home, snap);
      assert.equal(cli(ctx.home).status, 0);
    }
    assert.deepEqual(snapRows(ctx.home), E.snapshotRows);
    const perModel = q(ctx.home, 'SELECT count(*) AS n FROM usage_snapshot WHERE seven_day_opus_pct IS NOT NULL')[0]?.n;
    assert.equal(perModel, 1, 'only snapshot E carries a per-model window');
  }));

  it('a second ingest of an unchanged cache reports unchanged=1 and adds no snapshot or limit row', () => withHome(async ({ home }) => {
    writeUsageCache(home, SNAPSHOTS.E);
    assert.equal(cli(home).status, 0);
    const before = keyDigest(home);
    const r = cli(home);
    assert.equal(r.status, 0);
    assert.match(usageLine(r.stdout) ?? '', /^usage: files=1 new=0 reread=0 unchanged=1 skipped=0 /);
    assert.deepEqual(keyDigest(home), before);
    assert.equal(before.snapshots, 1);
    assert.equal(before.limits, 3);
  }));

  it('limit rows: E keeps kind, group, percent, instant and is_active with severity NULL', () => withHome(async ({ home }) => {
    writeUsageCache(home, SNAPSHOTS.E);
    assert.equal(cli(home).status, 0);
    assert.deepEqual(limitRows(home, CACHE_SOURCE, MS.h17), E.limitRowsE);
  }));

  it('first_run_id is the run that first stored the snapshot and does not move on a later run', () => withHome(async ({ home }) => {
    writeUsageCache(home, SNAPSHOTS.A);
    const one = await ingestIn(home);
    await ingestIn(home);
    const rows = q(home, 'SELECT first_run_id FROM usage_snapshot');
    assert.deepEqual(rows, [{ first_run_id: one.runId }]);
  }));

  it('usage_snapshot and usage_limit columns equal the pick-derived columns plus bookkeeping', () => withHome(async ({ home }) => {
    writeUsageCache(home, SNAPSHOTS.E);
    assert.equal(cli(home).status, 0);
    const { CACHE_PICK } = await mod('sources/usage/cache.mjs');
    const { REPORT_PICK } = await mod('sources/usage/report.mjs');
    const colsOf = (t) => q(home, `PRAGMA table_info(${t})`).map((r) => r.name).sort();
    const picked = (t) => [...new Set([...CACHE_PICK, ...REPORT_PICK].filter((e) => e.table === t).map((e) => e.column))];
    assert.deepEqual(colsOf('usage_snapshot'), [...picked('usage_snapshot'), 'snapshot_id', 'source', 'label', 'fetched_utc', 'first_run_id'].sort());
    assert.deepEqual(colsOf('usage_limit'), [...picked('usage_limit'), 'snapshot_id', 'seq'].sort());
    for (const t of ['usage_snapshot', 'usage_limit']) {
      for (const c of colsOf(t)) assert.ok(!/cost|token|dollar|session|usd|spend|account|email|scope/.test(c), `column ${c}`);
    }
  }));

  it('no text column of any store table holds a plant, an email shape or the fixture home', () => withHome(async (ctx) => {
    await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['usage-window'] });
    writeUsageCache(ctx.home, SNAPSHOTS.E);
    assert.equal(cli(ctx.home).status, 0);
    assert.ok(snapCount(ctx.home) >= 2, 'snapshots were stored');
    const found = [];
    for (const { name } of q(ctx.home, "SELECT name FROM sqlite_master WHERE type = 'table'")) {
      for (const row of q(ctx.home, `SELECT * FROM ${name}`)) {
        for (const v of Object.values(row)) {
          if (typeof v === 'string' && (leaks(v).length > 0)) found.push(name);
        }
      }
    }
    assert.deepEqual([...new Set(found)], []);
  }));
});

describe('usage snapshots: every failure of the read is soft, named and silent about content', () => {
  const P = USAGE_PLANTS;
  const raw = (text) => (home) => writeUsageCache(home, null, { raw: text });
  const obj = (o) => (home) => writeUsageCache(home, null, { raw: JSON.stringify(o) });
  const cases = [
    ['absent', 'absent', () => {}],
    ['a directory at the path', 'not_regular', (home) => mkdirSync(join(home, '.claude.json'))],
    ['a symlink at the path', 'not_regular', (home) => {
      writeFileSync(join(home, 'real-cache.json'), JSON.stringify(cacheFileObject(SNAPSHOTS.A)));
      symlinkSync(join(home, 'real-cache.json'), join(home, '.claude.json'));
    }],
    ['unparseable text holding the plants', 'unparseable', raw(`{"cachedUsageUtilization":{"accountUuid":"${P.accountId}","e":"${P.email}","m":${'4'}`)],
    ['an empty file', 'unparseable', raw('')],
    ['whitespace only', 'unparseable', raw('  \n\t ')],
    ['an array root', 'no_cache', raw('[]')],
    ['a null root', 'no_cache', raw('null')],
    ['an empty object', 'no_cache', raw('{}')],
    ['no cache key', 'no_cache', (home) => writeUsageCache(home, SNAPSHOTS.A, { cache: undefined })],
    ['a null cache', 'no_cache', obj(cacheFileObject(SNAPSHOTS.A, { cache: null }))],
    ['an array cache', 'no_cache', obj(cacheFileObject(SNAPSHOTS.A, { cache: [1, 2] }))],
  ];
  for (const [title, status, setup] of cases) {
    it(`${title}: zero snapshots, count ${status}, nothing leaked`, () => withHome(async ({ home }) => {
      setup(home);
      const s = await ingestIn(home);
      assert.ok(s.sources?.usage, 'the usage source ran');
      assert.equal(s.sources.usage.dropped?.[status], 1, `named count ${status}`);
      assert.equal(s.sources.usage.skipped, 1, 'skipped=1');
      assert.equal(snapCount(home), 0);
      const text = JSON.stringify(s);
      assert.deepEqual(leaks(text), []);
      assert.ok(!text.includes(home), 'no absolute path of the file');
    }));
  }

  it('an unreadable file counts unreadable and stores nothing', { skip: process.getuid?.() === 0 }, () => withHome(async ({ home }) => {
    const file = writeUsageCache(home, SNAPSHOTS.A);
    chmodSync(file, 0o000);
    try {
      const s = await ingestIn(home);
      assert.equal(s.sources?.usage?.dropped?.unreadable, 1);
      assert.equal(snapCount(home), 0);
    } finally {
      chmodSync(file, 0o644);
    }
  }));

  it('a file over the size cap counts oversized and is not read', () => withHome(async ({ home }) => {
    writeUsageCache(home, SNAPSHOTS.A);
    const s = await ingestIn(home, { usageMaxBytes: 100 });
    assert.equal(s.sources?.usage?.dropped?.oversized, 1);
    assert.equal(s.sources.usage.bytes, 0, 'nothing was read');
    assert.equal(snapCount(home), 0);
  }));

  for (const [title, value] of [['a string', '1793005200000'], ['a negative number', -1], ['1e20', 1e20], ['a float', 1793005200000.5], ['before 2000', 946684799999]]) {
    it(`an invalid fetchedAtMs (${title}) stores nothing and counts the fetchedAtMs path`, () => withHome(async ({ home }) => {
      writeUsageCache(home, SNAPSHOTS.A, { fetchedAtMs: value });
      const s = await ingestIn(home);
      assert.equal(s.sources?.usage?.rejected?.fetchedAtMs, 1);
      assert.equal(snapCount(home), 0);
    }));
  }

  it('the CLI exits 0 on an unparseable cache and prints no byte of it and no path', () => withHome(async ({ home }) => {
    writeUsageCache(home, null, { raw: `{"x":"${USAGE_PLANTS.accountId} ${USAGE_PLANTS.email}"` });
    const r = cli(home);
    assert.equal(r.status, 0);
    assert.match(usageLine(r.stdout) ?? '', /\bdropped=[^ ]*unparseable:1\b/);
    assert.deepEqual(leaks(r.stdout + r.stderr), []);
    assert.ok(!(r.stdout + r.stderr).includes(home));
  }));
});

describe('usage snapshots: field shapes', () => {
  const win = (pct, resetsAt) => ({ ...SNAPSHOTS.A, five_hour: { pct, resetsAt } });
  for (const [title, snap, path] of [
    ['percent 101', win(101, '2026-10-26T13:00:00Z'), 'utilization.five_hour.utilization'],
    ['percent -1', win(-1, '2026-10-26T13:00:00Z'), 'utilization.five_hour.utilization'],
    ['percent as a string', win('12', '2026-10-26T13:00:00Z'), 'utilization.five_hour.utilization'],
    ['percent as text', win('NaN', '2026-10-26T13:00:00Z'), 'utilization.five_hour.utilization'],
    ['resets_at not a date', win(10, 'not a date'), 'utilization.five_hour.resets_at'],
    ['resets_at hour 25', win(10, '2026-10-26T25:00:00Z'), 'utilization.five_hour.resets_at'],
  ]) {
    it(`${title}: the snapshot is stored without that window and the path is counted`, () => withHome(async ({ home }) => {
      writeUsageCache(home, snap);
      const s = await ingestIn(home);
      assert.equal(s.sources?.usage?.rejected?.[path], 1, 'path counted');
      const rows = snapRows(home);
      assert.equal(rows.length, 1);
      const [, , , fhPct, fhReset, sdPct] = rows[0];
      assert.equal(fhPct, null);
      assert.equal(fhReset, null);
      assert.equal(sdPct, 40, 'the other window is kept');
    }));
  }

  it('limits: bad kinds are dropped, a bad group is NULL, is_active non-boolean NULL, more than 16 entries capped', () => withHome(async ({ home }) => {
    const ok = (i) => ({ kind: `k${i}`, group: 'all', percent: 1, severity: 'x', resets_at: '2026-10-31T00:00:00Z', scope: null, is_active: true });
    const limits = [
      { ...ok(0), kind: USAGE_PLANTS.email },
      { ...ok(1), kind: 'Session' },
      { ...ok(2), group: 'Bad Group' },
      { ...ok(3), is_active: 'yes' },
      ...Array.from({ length: 16 }, (_, i) => ok(10 + i)),
    ];
    writeUsageCache(home, { ...SNAPSHOTS.A, limits });
    const s = await ingestIn(home);
    const rej = s.sources?.usage?.rejected ?? {};
    assert.equal(rej['utilization.limits[].kind'], 2, 'two kinds rejected');
    assert.equal(rej['utilization.limits[].group'], 1);
    assert.equal(rej['utilization.limits[].is_active'], 1);
    assert.equal(rej['utilization.limits'], 4, '20 entries: 16 kept, 4 counted');
    const rows = limitRows(home, CACHE_SOURCE, MS.h09);
    assert.equal(rows.length, 14, 'the 16 kept entries minus the 2 bad kinds');
    assert.deepEqual(rows[0], [0, 'k2', null, 1, MS.oct31, null, 1]);
    assert.deepEqual(rows[1], [1, 'k3', 'all', 1, MS.oct31, null, null]);
    for (const b of storeBytes(home)) assert.deepEqual(leaks(b), []);
  }));

  for (const [title, opts] of [['a UTF-8 BOM', { bom: true }], ['CRLF pretty-printed JSON', { crlfPretty: true }], ['plants written as unicode escapes', { unicodeEscapes: true }]]) {
    it(`${title} ingests to the same row and leaves no decoded plant in the store`, () => withHome(async ({ home }) => {
      writeUsageCache(home, SNAPSHOTS.A, opts);
      const s = await ingestIn(home);
      assert.equal(s.sources?.usage?.new, 1);
      assert.deepEqual(snapRows(home), [E.snapshotRows[0]]);
      const { checkpointStore } = await mod('db.mjs');
      checkpointStore({ home });
      for (const b of storeBytes(home)) assert.deepEqual(leaks(b), []);
    }));
  }

  it('a +05:30 offset and the Z spelling of one instant store the same value', () => withHome(async ({ home }) => {
    writeUsageCache(home, { ...SNAPSHOTS.A, five_hour: { pct: 10, resetsAt: '2026-10-26T18:30:00+05:30' } });
    await ingestIn(home);
    assert.equal(snapRows(home)[0]?.[4], MS.h13, '18:30+05:30 is 13:00Z');
  }));
});

describe('usage snapshots: transcript usageReport lines', () => {
  it('snapshot D is stored once with the transcript label and severity kept; a copy in a second file adds none', () => withHome(async (ctx) => {
    await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['usage-window'] });
    assert.equal(cli(ctx.home).status, 0);
    assert.deepEqual(snapRows(ctx.home).filter((r) => r[0] === 'transcript'), [E.snapshotRows[3]]);
    assert.deepEqual(limitRows(ctx.home, 'transcript', MS.h16), E.limitRowsD);
    const copy = join(ctx.root, 'projects', `${HELPERS.mangleHome(ctx.home)}-repos-uwin2`, 'copy.jsonl');
    HELPERS.writeJsonl(copy, [usageReportLine(SNAPSHOTS.D, { session: S14 })]);
    assert.equal(cli(ctx.home).status, 0);
    assert.equal(q(ctx.home, "SELECT count(*) AS n FROM usage_snapshot WHERE source = 'transcript'")[0]?.n, 1);
    const { checkpointStore } = await mod('db.mjs');
    checkpointStore({ home: ctx.home });
    for (const b of storeBytes(ctx.home)) assert.deepEqual(leaks(b), []);
  }));

  it('a system line without usageReport and one whose usageReport is an array store nothing', () => withHome(async (ctx) => {
    const file = join(ctx.root, 'projects', `${HELPERS.mangleHome(ctx.home)}-repos-ur`, 's.jsonl');
    HELPERS.writeJsonl(file, [
      usageReportLine(SNAPSHOTS.D, { usageReport: undefined }),
      usageReportLine({ ...SNAPSHOTS.D, iso: '2026-10-26T16:10:00.000Z' }, { usageReport: [1, 2] }),
      usageReportLine({ ...SNAPSHOTS.D, iso: '2026-10-26T16:20:00.000Z' }, { usageReport: { rate_limits: { limits: 'x' } } }),
    ]);
    assert.equal(cli(ctx.home).status, 0);
    assert.equal(snapCount(ctx.home), 0);
  }));

  it('the leaking report stub stores the line, so the store scan would catch a leaking pick', () => withHome(async (ctx) => {
    const file = join(ctx.root, 'projects', `${HELPERS.mangleHome(ctx.home)}-repos-ur`, 's.jsonl');
    HELPERS.writeJsonl(file, [usageReportLine(SNAPSHOTS.D)]);
    await ingestIn(ctx.home, { usageReportPick: leakyReportPick });
    const { checkpointStore } = await mod('db.mjs');
    checkpointStore({ home: ctx.home });
    assert.ok(storeBytes(ctx.home).some((b) => leaks(b).length > 0), 'the leak is visible to the scan');
  }));

  it('the leaking cache stub stores the file, so the store scan would catch a leaking pick', () => withHome(async ({ home }) => {
    writeUsageCache(home, SNAPSHOTS.E);
    await ingestIn(home, { usagePick: leakyCachePick });
    const { checkpointStore } = await mod('db.mjs');
    checkpointStore({ home });
    assert.ok(storeBytes(home).some((b) => leaks(b).length > 0), 'the leak is visible to the scan');
  }));
});

describe('usage snapshots: the read leaves no cursor trace and never reads another file', () => {
  it('no source_root, source_file or unknown_attr row exists for the usage source', () => withHome(async ({ home }) => {
    writeUsageCache(home, SNAPSHOTS.E);
    assert.equal(cli(home).status, 0);
    assert.equal(snapCount(home), 1);
    assert.equal(q(home, "SELECT count(*) AS n FROM source_root WHERE source = 'usage'")[0].n, 0);
    assert.equal(q(home, "SELECT count(*) AS n FROM source_file WHERE rel_path LIKE '%claude.json%'")[0].n, 0);
    assert.equal(q(home, "SELECT count(*) AS n FROM unknown_attr WHERE source = 'usage'")[0].n, 0);
    const names = q(home, "SELECT DISTINCT name FROM ingest_count WHERE source = 'usage'").map((r) => r.name);
    for (const n of names) assert.ok(/^[a-z_][a-z0-9_.[\]]*$/.test(n), 'count names are fixed paths or statuses');
  }));

  it('an explicit --root still reads HOME/.claude.json, and the decoy files are never read', () => withHome(async (ctx) => {
    const { plant } = await import('../canary/plants/usage.mjs');
    plant({ home: ctx.home, root: ctx.root });
    mkdirSync(ctx.root, { recursive: true });
    const r = cli(ctx.home, ['ingest', '--root', ctx.root], { CLAUDE_CONFIG_DIR: join(ctx.home, '.claude-contrib') });
    assert.equal(r.status, 0);
    assert.match(usageLine(r.stdout) ?? '', /^usage: files=1 new=1 /);
    assert.deepEqual(q(ctx.home, 'SELECT fetched_at_ms FROM usage_snapshot').map((x) => x.fetched_at_ms), [MS.h17]);
    assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM usage_snapshot WHERE fetched_at_ms = ?', [DECOY_FETCHED_MS])[0].n, 0);
    const { checkpointStore } = await mod('db.mjs');
    checkpointStore({ home: ctx.home });
    for (const b of storeBytes(ctx.home)) assert.deepEqual(leaks(b, Object.values(DECOY)), []);
  }));
});

describe('usage snapshots: idempotency and concurrency', () => {
  it('two ingest processes started together: one run, one lock-held skip, one snapshot', () => withHome(async ({ home }) => {
    writeUsageCache(home, SNAPSHOTS.A);
    const { openStore } = await mod('db.mjs');
    openStore({ home }).close();
    const [a, b] = await Promise.all([runCliAsync(['ingest'], { home }), runCliAsync(['ingest'], { home })]);
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    const out = a.stdout + b.stdout;
    const skips = out.split('\n').filter((l) => l.startsWith('ingest: skipped, another ingest holds the lock')).length;
    const runs = out.split('\n').filter((l) => l.startsWith('usage: files=')).length;
    assert.equal(skips + runs, 2);
    assert.ok(runs >= 1);
    assert.equal(snapCount(home), 1);
  }));

  it('a run interrupted inside the usage transaction stores nothing; the next run stores the snapshot once', () => withHome(async ({ home }) => {
    writeUsageCache(home, SNAPSHOTS.E);
    let seen = 0;
    await assert.rejects(ingestIn(home, {
      beforeCommit: ({ source }) => { if (source === 'usage') { seen += 1; throw new Error('interrupt-usage'); } },
    }), /interrupt-usage/);
    assert.equal(seen, 1, 'the usage transaction was reached');
    assert.equal(snapCount(home), 0);
    await ingestIn(home);
    assert.equal(snapCount(home), 1);
    assert.equal(q(home, 'SELECT count(*) AS n FROM usage_limit')[0].n, 3);
  }));

  it('a rotation (older content, then newer) ends equal to a clean ingest of the same final series', () => {
    const run = async (order) => withHome(async ({ home }) => {
      for (const snap of order) {
        writeUsageCache(home, snap);
        await ingestIn(home);
      }
      return keyDigest(home);
    });
    return (async () => {
      const rotated = await run([SNAPSHOTS.C, SNAPSHOTS.A, SNAPSHOTS.E]);
      const clean = await run([SNAPSHOTS.A, SNAPSHOTS.C, SNAPSHOTS.E]);
      assert.equal(rotated.snapshots, 3);
      assert.deepEqual(rotated, clean);
    })();
  });

  it('a reversed ingest order of the five snapshots gives an equal key digest', async () => {
    const run = async (order) => withHome(async (ctx) => {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['usage-window'] });
      for (const snap of order) {
        writeUsageCache(ctx.home, snap);
        assert.equal(cli(ctx.home).status, 0);
      }
      return keyDigest(ctx.home);
    });
    const forward = await run([SNAPSHOTS.A, SNAPSHOTS.B, SNAPSHOTS.C, SNAPSHOTS.E]);
    const reversed = await run([SNAPSHOTS.E, SNAPSHOTS.C, SNAPSHOTS.B, SNAPSHOTS.A]);
    assert.equal(forward.snapshots, 5);
    assert.deepEqual(reversed, forward);
  });
});
