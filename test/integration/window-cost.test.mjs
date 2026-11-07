// Estimated window shares in derive and cost (plan 01-06, D-11a, D-07, D-09, COST-04, TRUST-01, TRUST-02).
// Every expected value is hand-computed in test/fixtures/usage-cache.mjs (EXPECTED_WINDOW) or beside the
// direct-row cases below, never by the code under test. Columns are selected by header name, so the dollar
// column (plan 01-05) is not asserted here.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildFixtureTree, cliEnv, isDataRow, makeHome, parseCost, runCli, sha256, sha256File, stateDirOf,
} from '../fixtures/build.mjs';
import { insertIter, insertMessage, openTempStore, queryOrEmpty } from '../fixtures/derive-rows.mjs';
import { EXPECTED_WINDOW, MS, SNAPSHOTS, insertSnapshotRow, writeUsageCache } from '../fixtures/usage-cache.mjs';
import { S14 } from '../fixtures/cases/95-usage-window.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const E = EXPECTED_WINDOW;
const DERIVED = (home) => join(stateDirOf(home), 'derived.db');
const ROW_COLS = ['role', 'model', 'calls', 'input', 'output', 'cache_read', 'cache_write', 'window_5h', 'window_7d'];

const cli = (home, args) => runCli(args, { home, env: cliEnv(home) });

function readDerived(home, fn) {
  const db = new DatabaseSync(DERIVED(home), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// Rows of the table selected by header name; fails on an assertion (never a TypeError) when a column is missing.
// The header is the first line holding a calls column (a --by model table starts with model, not role).
function select(stdout, names) {
  const lines = stdout.split('\n');
  const at = lines.findIndex((l) => l.trim().split(/\s+/).includes('calls'));
  assert.ok(at >= 0, 'a table is printed');
  const header = lines[at].trim().split(/\s+/);
  for (const n of names) assert.ok(header.includes(n), `the header has a ${n} column`);
  const end = lines.findIndex((l) => l.startsWith('labels:'));
  const idx = names.map((n) => header.indexOf(n));
  return lines.slice(at + 1, end).filter(isDataRow).map((l) => l.trim().split(/\s+/)).map((r) => idx.map((i) => r[i])); // plan 01-08: no =total rows
}
const lineStarting = (stdout, prefix) => stdout.split('\n').find((l) => l.startsWith(prefix)) ?? null;

// Builds case usage-window (cache A and transcript snapshot D), ingests, then writes caches B, C and E with an
// ingest after each: the five-snapshot series of the plan.
async function seriesHome() {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['usage-window'] });
  assert.equal(cli(ctx.home, ['ingest']).status, 0);
  for (const snap of [SNAPSHOTS.B, SNAPSHOTS.C, SNAPSHOTS.E]) {
    writeUsageCache(ctx.home, snap);
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
  }
  return ctx;
}

const INTERVAL_SQL = `SELECT win, seq, start_ms, end_ms, start_pct, end_pct, resets_ms, status, delta_micro, parts, weight_total
  FROM window_interval ORDER BY win, seq`;
const SHARE_SQL = `SELECT a.message_id, w.win, w.interval_seq, w.share_micro
  FROM api_call_part_window w JOIN api_call a ON a.call_key = w.call_key ORDER BY w.win, w.interval_seq, a.ts_utc, a.message_id`;
// Hand order of EXPECTED shares: per window, by interval then call time.
const expectedShares = () => E.shares.slice().sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : x[2] - y[2]));

function windowDigest(home) {
  return readDerived(home, (db) => {
    const canon = (rows) => rows.map((r) => Object.keys(r).sort().map((k) => [k, r[k]]));
    const tables = [
      queryOrEmpty(db, 'SELECT * FROM window_interval ORDER BY win, seq'),
      queryOrEmpty(db, 'SELECT * FROM api_call_part_window ORDER BY call_key, part_seq, win'),
      queryOrEmpty(db, 'SELECT * FROM usage_latest'),
      queryOrEmpty(db, 'SELECT * FROM api_call ORDER BY call_key'),
      queryOrEmpty(db, 'SELECT * FROM api_call_part ORDER BY call_key, part_seq'),
      queryOrEmpty(db, 'SELECT * FROM derive_state').map(({ built_utc: _b, store_fingerprint: _f, last_run_end_utc: _l, ...rest }) => rest),
    ];
    return sha256(JSON.stringify(tables.map(canon)));
  });
}

describe('window share: the five-snapshot series', () => {
  let ctx;
  let out;
  before(async () => {
    ctx = await seriesHome();
    out = cli(ctx.home, ['cost', '--by', 'role,model']);
  });
  after(() => ctx.cleanup());

  it('tracer: cost shows estimated window shares per role and model with the header and footer lines', () => {
    assert.equal(out.status, 0);
    assert.deepEqual(select(out.stdout, ROW_COLS), E.rows);
    const lines = out.stdout.split('\n');
    const periodAt = lines.findIndex((l) => l.startsWith('period:'));
    const headerAt = lines.findIndex((l) => l.trim().split(/\s+/)[0] === 'role');
    // Plan 01-08: the freshness block precedes the period line, so positions are relative to it.
    assert.ok(periodAt >= 1);
    assert.match(lines[periodAt + 1], E.header, 'the window usage line follows period:');
    assert.equal(headerAt, periodAt + 2, 'and precedes the table header');
    assert.equal(lineStarting(out.stdout, 'labels:'), E.labels);
    const notionalAt = lines.findIndex((l) => l.startsWith('notional:'));
    assert.equal(lines[notionalAt + 1], E.footer, 'the window: footer follows notional:');
  });

  it('derived.db holds the hand-computed intervals and micro-point shares', () => {
    const got = readDerived(ctx.home, (db) => queryOrEmpty(db, INTERVAL_SQL).map((r) => Object.values(r)));
    assert.deepEqual(got, E.intervals);
    const shares = readDerived(ctx.home, (db) => queryOrEmpty(db, SHARE_SQL).map((r) => Object.values(r)));
    assert.deepEqual(shares, expectedShares());
  });

  it('a zero-weight part inside a usable interval is stored as 0; calls outside every interval have no row', () => {
    const rows = readDerived(ctx.home, (db) => queryOrEmpty(db, SHARE_SQL));
    assert.deepEqual(rows.filter((r) => r.message_id === 'msg_w10').map((r) => r.share_micro), [0, 0]);
    assert.equal(rows.filter((r) => ['msg_w07', 'msg_w08'].includes(r.message_id)).length, 0);
    assert.ok(rows.length > 0, 'shares were derived');
  });

  it('usable intervals conserve their delta exactly', () => {
    const sums = readDerived(ctx.home, (db) => queryOrEmpty(db, `
      SELECT i.win, i.delta_micro, (SELECT sum(w.share_micro) FROM api_call_part_window w WHERE w.win = i.win AND w.interval_seq = i.seq) AS s
        FROM window_interval i WHERE i.status = 'usable' ORDER BY i.win, i.seq`));
    assert.deepEqual(sums.map((r) => [r.win, r.delta_micro, r.s]), [
      ['five_hour', 12000000, 12000000], ['seven_day', 6000000, 6000000], ['seven_day', 3000000, 3000000], ['seven_day', 2000000, 2000000],
    ]);
  });

  it('--by role and --by model aggregate the shares with ? wherever one part is unknown', () => {
    const byRole = cli(ctx.home, ['cost', '--by', 'role']);
    assert.equal(byRole.status, 0);
    assert.deepEqual(select(byRole.stdout, ['role', 'window_5h', 'window_7d']), E.byRole);
    const byModel = cli(ctx.home, ['cost', '--by', 'model']);
    assert.equal(byModel.status, 0);
    assert.deepEqual(select(byModel.stdout, ['model', 'window_5h', 'window_7d']), E.byModel);
  });

  it('derive_state records the pass version, the weights text and the snapshot count', async () => {
    const { PASS_VERSION } = await mod('derive/schema.mjs');
    const { WINDOW_WEIGHTS_TEXT } = await mod('derive/window.mjs');
    const st = readDerived(ctx.home, (db) => queryOrEmpty(db, 'SELECT pass_version, window_weights, usage_snapshots FROM derive_state'));
    assert.deepEqual(st, [{ pass_version: PASS_VERSION, window_weights: WINDOW_WEIGHTS_TEXT, usage_snapshots: 5 }]);
    assert.ok(PASS_VERSION >= 4, 'at least the 01-06 value 4 (01-05 had 3); plan 01-07 raised it to 5');
    const latest = readDerived(ctx.home, (db) => queryOrEmpty(db, 'SELECT source, label, fetched_at_ms, five_hour_pct, seven_day_pct, seven_day_opus_pct FROM usage_latest'));
    assert.deepEqual(latest, [{ source: 'claude-json-cache', label: 'measured', fetched_at_ms: MS.h17, five_hour_pct: 5, seven_day_pct: 51, seven_day_opus_pct: 12 }]);
  });

  it('no window cell or window label is ever measured; the header line carries its source label', () => {
    const labels = lineStarting(out.stdout, 'labels:');
    assert.match(labels ?? '', / window_share=estimated;/);
    assert.ok(!/window_share=measured/.test(out.stdout));
    assert.match(lineStarting(out.stdout, 'window usage:') ?? '', /via claude-json-cache \(measured\)/);
  });

  it('the derived content digest is equal after a forced second rebuild', async () => {
    const before = windowDigest(ctx.home);
    const { ensureDerived } = await mod('derive/ensure.mjs');
    assert.deepEqual(ensureDerived({ home: ctx.home, force: true }), { rebuilt: true, reason: 'forced' });
    assert.equal(windowDigest(ctx.home), before);
  });
});

describe('window share: conservation, ensure and order', () => {
  it('a tampered share makes checkWindowConservation fail and cost print window_conservation=VIOLATED with exit 0', async () => {
    const ctx = await seriesHome();
    try {
      assert.equal(cli(ctx.home, ['cost']).status, 0);
      const { Db } = await mod('db.mjs');
      const db = new Db(DERIVED(ctx.home));
      try {
        db.prepare("UPDATE api_call_part_window SET share_micro = share_micro + 1 WHERE win = 'five_hour' AND share_micro = 2000000").run();
        const { checkWindowConservation } = await mod('derive/conservation.mjs');
        const res = checkWindowConservation(db);
        assert.equal(res.ok, false);
        assert.ok(res.violations.length >= 1);
        assert.ok(!JSON.stringify(res.violations).includes(ctx.home));
      } finally {
        db.close();
      }
      const r = cli(ctx.home, ['cost']);
      assert.equal(r.status, 0);
      assert.match(lineStarting(r.stdout, 'window:') ?? '', / window_conservation=VIOLATED$/);
    } finally {
      ctx.cleanup();
    }
  });

  it('an ingest that adds a snapshot makes ensureDerived rebuild (store_fingerprint); a second call leaves the file byte-identical', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['usage-window'] });
      assert.equal(cli(ctx.home, ['ingest']).status, 0);
      assert.equal(cli(ctx.home, ['cost']).status, 0);
      writeUsageCache(ctx.home, SNAPSHOTS.B);
      assert.equal(cli(ctx.home, ['ingest']).status, 0);
      const { ensureDerived } = await mod('derive/ensure.mjs');
      assert.deepEqual(ensureDerived({ home: ctx.home }), { rebuilt: true, reason: 'store_fingerprint' });
      const n = readDerived(ctx.home, (db) => queryOrEmpty(db, 'SELECT usage_snapshots FROM derive_state'));
      assert.deepEqual(n, [{ usage_snapshots: 3 }], 'A, B and the transcript snapshot D');
      const sha = sha256File(DERIVED(ctx.home));
      assert.deepEqual(ensureDerived({ home: ctx.home }), { rebuilt: false, reason: null });
      assert.equal(sha256File(DERIVED(ctx.home)), sha);
    } finally {
      ctx.cleanup();
    }
  });

  it('the derived window content does not depend on the ingest order of the snapshots', async () => {
    const forward = await seriesHome();
    const reversed = makeHome();
    try {
      await buildFixtureTree(reversed.root, { home: reversed.home, cases: ['usage-window'] });
      for (const snap of [SNAPSHOTS.E, SNAPSHOTS.C, SNAPSHOTS.B, SNAPSHOTS.A]) {
        writeUsageCache(reversed.home, snap);
        assert.equal(cli(reversed.home, ['ingest']).status, 0);
      }
      for (const c of [forward, reversed]) assert.equal(cli(c.home, ['cost']).status, 0);
      const a = readDerived(forward.home, (db) => queryOrEmpty(db, 'SELECT * FROM window_interval ORDER BY win, seq'));
      const b = readDerived(reversed.home, (db) => queryOrEmpty(db, 'SELECT * FROM window_interval ORDER BY win, seq'));
      assert.equal(a.length, 8);
      assert.deepEqual(b, a);
      assert.equal(windowDigest(reversed.home), windowDigest(forward.home));
    } finally {
      forward.cleanup();
      reversed.cleanup();
    }
  });

  it('row order is the 01-04 order whatever the window values are', async () => {
    const ctx = await seriesHome();
    try {
      const withShares = select(cli(ctx.home, ['cost', '--by', 'role,model']).stdout, ['role', 'model']);
      rmSync(stateDirOf(ctx.home), { recursive: true, force: true });
      rmSync(join(ctx.home, '.claude.json'), { force: true });
      assert.equal(cli(ctx.home, ['ingest']).status, 0);
      const fewer = select(cli(ctx.home, ['cost', '--by', 'role,model']).stdout, ['role', 'model']);
      assert.deepEqual(fewer, withShares);
      assert.deepEqual(withShares, E.rows.map((r) => r.slice(0, 2)));
    } finally {
      ctx.cleanup();
    }
  });
});

describe('window share: no snapshot, empty HOME, unreadable cache', () => {
  it('transcripts and no snapshot: none recorded, window_share=unavailable, every cell ?, zero coverage', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['usage-window'] });
      rmSync(join(ctx.home, '.claude.json'));
      const file = join(ctx.root, 'projects', `${ctx.home.replace(/[^A-Za-z0-9]/g, '-')}-repos-uwin`, `${S14}.jsonl`);
      const kept = readFileSync(file, 'utf8').split('\n').filter((l) => !l.includes('"usageReport"'));
      writeFileSync(file, kept.join('\n'));
      assert.equal(cli(ctx.home, ['ingest']).status, 0);
      const r = cli(ctx.home, ['cost', '--by', 'role,model']);
      assert.equal(r.status, 0);
      const lines = r.stdout.split('\n');
      assert.equal(lines[lines.findIndex((l) => l.startsWith('period:')) + 1], 'window usage: none recorded');
      assert.match(lineStarting(r.stdout, 'labels:') ?? '', / window_share=unavailable;/);
      const cells = select(r.stdout, ['window_5h', 'window_7d']);
      assert.equal(cells.length, 5);
      for (const c of cells) assert.deepEqual(c, ['?', '?']);
      assert.equal(lineStarting(r.stdout, 'window:'), E.noSnapshotFooter(9));
    } finally {
      ctx.cleanup();
    }
  });

  it('an empty HOME prints no rows and no window line, label or footer, exit 0', () => {
    const ctx = makeHome();
    try {
      const r = cli(ctx.home, ['cost']);
      assert.equal(r.status, 0);
      assert.equal(r.stdout.split('\n')[2], 'no rows');
      assert.ok(!/window/.test(r.stdout));
    } finally {
      ctx.cleanup();
    }
  });

  it('an unreadable cache (a directory at the path) keeps cost at exit 0 with the earlier shape plus none recorded', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['tracer-base'] });
      mkdirSync(join(ctx.home, '.claude.json'));
      assert.equal(cli(ctx.home, ['ingest']).status, 0);
      const r = cli(ctx.home, ['cost']);
      assert.equal(r.status, 0);
      assert.equal(r.stdout.split('\n')[r.stdout.split('\n').findIndex((l) => l.startsWith('period:')) + 1], 'window usage: none recorded');
      assert.ok(parseCost(r.stdout).rows.length >= 1);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('window share: direct rows', () => {
  // Two snapshots one hour apart with the same reset instants: five-hour 10 -> 14 and weekly 20 -> 24,
  // a delta of 4 points (4,000,000 micro) in each window.
  const X = { source: 'claude-json-cache', fetchedAtMs: MS.h10, five_hour: { pct: 10, resetsMs: MS.h13 }, seven_day: { pct: 20, resetsMs: MS.oct31 } };
  const Y = { source: 'claude-json-cache', fetchedAtMs: MS.h11, five_hour: { pct: 14, resetsMs: MS.h13 }, seven_day: { pct: 24, resetsMs: MS.oct31 } };
  const zero = { cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0, output_tokens: 0 };

  it('an advisor part on another model gets its own share: --by model shows each part only in its own row', async () => {
    const ctx = makeHome();
    try {
      const db = openTempStore({ home: ctx.home });
      try {
        insertSnapshotRow(db, X);
        insertSnapshotRow(db, Y);
        // Top level (executor part): input 100 -> weight 100. Advisor iteration on claude-fable-5-1: input 300 -> 300.
        // Shares of 4,000,000: 4,000,000 x 100 / 400 = 1,000,000 (1.00%) and x 300 / 400 = 3,000,000 (3.00%).
        insertMessage(db, {
          session_id: 'sess-adv', message_id: 'msg_adv', model: 'claude-opus-5-5', input_tokens: 100, ...zero,
          has_iterations: 1, ts_utc: '2026-10-26T10:30:00.000Z',
        });
        insertIter(db, { session_id: 'sess-adv', message_id: 'msg_adv', iter_seq: 0, iter_type: 'message', model: 'claude-opus-5-5', input_tokens: 100, ...zero });
        insertIter(db, { session_id: 'sess-adv', message_id: 'msg_adv', iter_seq: 1, iter_type: 'advisor_message', model: 'claude-fable-5-1', input_tokens: 300, ...zero });
      } finally {
        db.close();
      }
      const r = cli(ctx.home, ['cost', '--by', 'model']);
      assert.equal(r.status, 0);
      assert.deepEqual(select(r.stdout, ['model', 'window_5h', 'window_7d']), [
        ['claude-fable-5-1', '3.00%', '3.00%'],
        ['claude-opus-5-5', '1.00%', '1.00%'],
      ]);
    } finally {
      ctx.cleanup();
    }
  });

  it('equal weights 1:1:1 with a one-point delta give 333,334, 333,333 and 333,333 micro-points in call order', async () => {
    const ctx = makeHome();
    try {
      const db = openTempStore({ home: ctx.home });
      try {
        insertSnapshotRow(db, X);
        insertSnapshotRow(db, { ...Y, five_hour: { pct: 11, resetsMs: MS.h13 }, seven_day: { pct: 21, resetsMs: MS.oct31 } });
        // Three calls of weight 1 each (input 1): 1,000,000 / 3 = 333,333 rem 1; the remainder goes to the first by
        // (timestamp, call key, part seq).
        for (const [i, ts] of ['10:10', '10:20', '10:30'].entries()) {
          insertMessage(db, {
            session_id: 'sess-rem', message_id: `msg_r${i}`, model: 'claude-haiku-5-5', input_tokens: 1, ...zero,
            ts_utc: `2026-10-26T${ts}:00.000Z`,
          });
        }
      } finally {
        db.close();
      }
      assert.equal(cli(ctx.home, ['cost']).status, 0);
      const shares = readDerived(ctx.home, (d) => queryOrEmpty(d, `SELECT a.message_id, w.share_micro FROM api_call_part_window w
        JOIN api_call a ON a.call_key = w.call_key WHERE w.win = 'five_hour' ORDER BY a.message_id`));
      assert.deepEqual(shares.map((r) => [r.message_id, r.share_micro]), [['msg_r0', 333334], ['msg_r1', 333333], ['msg_r2', 333333]]);
    } finally {
      ctx.cleanup();
    }
  });
});
