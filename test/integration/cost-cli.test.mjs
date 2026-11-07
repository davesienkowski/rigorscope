// Plan 01-08 contract: the `cost` report shape (COST-04, COST-05, TRUST-01, TRUST-02, TRUST-05, RPT-02) over the
// DST case report-shape. Written before the code (RED). Every expected value is hand-computed in
// test/fixtures/cases/98-report-shape.mjs (the arithmetic sits in comments there) or beside the case below,
// never by the code under test. The `loader` describe runs in process (loadCostReport, loadFreshness); the `cli`
// describe spawns bin/rigorscope.mjs under cliEnv. New report fields are read defensively, so a missing field
// fails an assertion and never a TypeError. No planted value is printed in a failure message.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLANTS, buildFixtureTree, cliEnv, ingestHome, loadCases, makeHome, runCli, runCliAsync, sha256File, stateDirOf,
} from '../fixtures/build.mjs';
import { DST_NOW, FIXTURE_NOW } from '../fixtures/clock.mjs';
import { periodOf } from '../fixtures/period.mjs';
import { parseCostTable } from '../fixtures/cost-table.mjs';
import { seedFreshness } from '../fixtures/freshness-rows.mjs';
import { insertMessage, openTempStore } from '../fixtures/derive-rows.mjs';
import { SNAPSHOTS, writeUsageCache } from '../fixtures/usage-cache.mjs';
import { UNITS_EXPECTED, buildUnitsHome } from '../fixtures/units-home.mjs';
import {
  S1, S2, S3, S4, TS_MS, expectedReport as ER,
} from '../fixtures/cases/98-report-shape.mjs';
import { Db, derivedPath, openStore } from '../../src/db.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const LA = 'America/Los_Angeles';
// A grammar mismatch or a non-JSON document is an assertion failure, never a bare exception.
function parse(stdout) {
  try { return parseCostTable(stdout); } catch { return assert.fail('cost output does not match the report grammar'); }
}
function parseJson(stdout) {
  try { return JSON.parse(stdout); } catch { return assert.fail('output is not one JSON document'); }
}
const nowFn = (iso) => () => new Date(iso);
const HOUR = 3600000;

// ---- helpers --------------------------------------------------------------------------------------------------
const cli = (home, args, extra = {}) => runCli(args, { home, env: cliEnv(home, { RIGORSCOPE_NOW: DST_NOW, ...extra }) });
const nano = (usd) => Math.round(Number.parseFloat(usd) * 1e6) * 1000; // '0.000015' -> 15000 (micro-dollar strings)
const usd6 = (n) => { const micro = Math.floor((n + 500) / 1000); return `${Math.floor(micro / 1e6)}.${String(micro % 1e6).padStart(6, '0')}`; };

async function shapeHome(cases = ['report-shape']) {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases });
  await ingestHome(ctx.home);
  return ctx;
}

// A loadCostReport that turns a throw into data, so a RED run fails on the assertion that follows.
async function load(home, opts = {}) {
  const { ensureDerived } = await mod('derive/ensure.mjs');
  const { loadCostReport } = await mod('report/cost.mjs');
  ensureDerived({ home, now: nowFn(DST_NOW) });
  try {
    return loadCostReport({ home, now: nowFn(DST_NOW), ...opts });
  } catch (err) {
    return { loadError: err.name };
  }
}

const periodLA = (extra = {}) => periodOf({ mode: 'range', tz: LA, ...extra });
const BY6 = ['role', 'model', 'effort', 'day', 'session', 'repo'];
const rowsOf = (r) => r?.rows ?? [];
const cellVal = (m) => (m && typeof m === 'object' && 'value' in m ? m.value : undefined);
// [dims..., calls, input, output, notional micro-dollar string] of a loader row.
const flat = (by) => (row) => [
  ...by.map((d) => (row[d] === null || row[d] === undefined ? '?' : String(row[d]))), String(row.calls), String(cellVal(row.input)),
  String(cellVal(row.output)), cellVal(row.notionalUsd) === undefined || cellVal(row.notionalUsd) === null ? '?' : usd6(Math.round(cellVal(row.notionalUsd) * 1e9)),
];
const tail = (rows) => rows.map((r) => r.slice(-5));

describe('loader', () => {
  let ctx;
  before(async () => { ctx = await shapeHome(); });
  after(() => ctx.cleanup());

  it('loader: six dimensions in the order A, B, E, C, D, F with section-first keys', async () => {
    const r = await load(ctx.home, { by: BY6, tz: LA, period: periodLA({ sinceMs: 0, untilMs: null }) });
    assert.equal(rowsOf(r).length, 6, 'six rows');
    assert.deepEqual(rowsOf(r).map((x) => x.calls), [1, 1, 1, 1, 1, 1]);
    assert.deepEqual(rowsOf(r).map((x) => x.session), [S1, S1, S3, S2, S2, S4]);
    assert.equal(rowsOf(r)[0]?.key, `main/role=main/model=claude-haiku-5-5/effort=high/day=2026-10-31/session=${S1}/repo=rigorscope`);
    assert.equal(rowsOf(r)[5]?.key, `main/role=main/model=claude-opus-5-5/effort=low/day=2026-11-02/session=${S4}/repo=?`);
  });

  it('loader: the main total row sums to 6 calls, 550 input, 70 output and 675000 nano-dollars', async () => {
    const r = await load(ctx.home, { by: ['role', 'model'], tz: LA });
    const t = r?.totalRow;
    assert.equal(t?.calls, 6);
    assert.equal(cellVal(t?.input), 550); // 5 x 100 + 50
    assert.equal(cellVal(t?.output), 70); // 5 x 10 + 20
    assert.equal(cellVal(t?.cacheRead), 0);
    assert.equal(cellVal(t?.cacheWrite), 0);
    assert.equal(Math.round(cellVal(t?.notionalUsd) * 1e9), 675000); // 5 x 15000 + 600000
    assert.equal(t?.key, 'main/total');
  });

  for (const [tz, rows] of Object.entries(ER.roleModelEffortDay)) {
    it(`loader: --by role,model,effort,day in ${tz} gives the hand-computed rows`, async () => {
      const by = ['role', 'model', 'effort', 'day'];
      const r = await load(ctx.home, { by, tz, period: periodOf({ mode: 'all', tz }) });
      assert.deepEqual(rowsOf(r).map(flat(by)).map((x) => [...x.slice(0, 4), x[4], x[5], x[6], x[7]]), rows);
    });
  }

  for (const [tz, rows] of Object.entries(ER.day)) {
    it(`loader: --by day in ${tz} buckets local days of the call instant`, async () => {
      const r = await load(ctx.home, { by: ['day'], tz, period: periodOf({ mode: 'all', tz }) });
      assert.deepEqual(rowsOf(r).map(flat(['day'])), rows);
    });
  }

  for (const dim of ['repo', 'session', 'effort']) {
    it(`loader: --by ${dim} gives the hand-computed rows, NULL last`, async () => {
      const r = await load(ctx.home, { by: [dim], tz: LA, period: periodOf({ mode: 'all', tz: LA }) });
      assert.deepEqual(rowsOf(r).map(flat([dim])), ER[dim]);
    });
  }

  it('loader: ts_ms in derived.db equals the hand-computed epoch milliseconds', async () => {
    await load(ctx.home, {});
    const db = new Db(derivedPath(ctx.home), { readOnly: true });
    try {
      const got = Object.fromEntries(db.prepare('SELECT message_id AS m, ts_ms AS t FROM api_call').all().map((x) => [x.m, x.t]));
      const want = Object.fromEntries(Object.entries(TS_MS).map(([l, ms]) => [`msg_rs_${l.toLowerCase()}`, ms]));
      assert.deepEqual(got, want);
    } catch (err) {
      assert.fail(`ts_ms column read failed (${err.name})`);
    } finally {
      db.close();
    }
  });

  // Plan 02-02 (D-09): repo, repo_key and repo_rule come from the git resolver at ingest (rule = its method).
  it('loader: repo, repo_key and repo_rule in derived.db come from the git resolver and store no cwd', async () => {
    await load(ctx.home, {});
    const db = new Db(derivedPath(ctx.home), { readOnly: true });
    let got;
    let keys;
    try {
      try {
        got = Object.fromEntries(db.prepare('SELECT owner_session_id AS s, repo AS r, repo_rule AS u FROM api_call').all().map((x) => [x.s, [x.r, x.u]]));
      } catch { got = {}; }
      try {
        keys = Object.fromEntries(db.prepare('SELECT owner_session_id AS s, repo_key AS k FROM api_call').all().map((x) => [x.s, x.k]));
      } catch { keys = {}; }
    } finally { db.close(); }
    assert.deepEqual(got, ER.repoOf);
    assert.deepEqual(keys, ER.repoKeyOf);
    const bytes = readFileSync(derivedPath(ctx.home));
    // Plan 02-02: 'scratch' replaces the S3 fragment 'play', which the derived column name repo_label.display holds.
    for (const needle of ['scratch', 'fix-x', PLANTS.osUser, ctx.home]) {
      assert.equal(bytes.indexOf(Buffer.from(needle)), -1, 'derived.db holds a cwd fragment');
    }
  });

  const BOUND = [
    ['LA since 2026-11-01 until 2026-11-01', { tz: LA, sinceMs: 1793516400000, untilMs: 1793606400000 }, ['B', 'C', 'D', 'E']],
    ['UTC since 2026-11-01 until 2026-11-01', { tz: 'UTC', sinceMs: 1793491200000, untilMs: 1793577600000 }, ['A', 'B', 'C', 'D']],
  ];
  for (const [name, p, want] of BOUND) {
    it(`loader: period ${name} keeps exactly the calls inside the half-open range`, async () => {
      const r = await load(ctx.home, { by: ['session'], tz: p.tz, period: periodOf({ mode: 'range', ...p }) });
      assert.equal(r?.totalRow?.calls, want.length);
      assert.equal(cellVal(r?.totalRow?.input), want.length * 100);
    });
  }

  it('loader: the lower bound is inclusive to the millisecond', async () => {
    const at = await load(ctx.home, { by: ['session'], tz: 'UTC', period: periodOf({ mode: 'range', tz: 'UTC', sinceMs: TS_MS.B }) });
    const after1 = await load(ctx.home, { by: ['session'], tz: 'UTC', period: periodOf({ mode: 'range', tz: 'UTC', sinceMs: TS_MS.B + 1 }) });
    assert.equal(at?.totalRow?.calls, 5, 'B kept when sinceMs equals its instant');
    assert.equal(after1?.totalRow?.calls, 4, 'B dropped one millisecond later');
  });

  it('loader: the upper bound is exclusive to the millisecond', async () => {
    const at = await load(ctx.home, { by: ['session'], tz: 'UTC', period: periodOf({ mode: 'range', tz: 'UTC', untilMs: TS_MS.F }) });
    const after1 = await load(ctx.home, { by: ['session'], tz: 'UTC', period: periodOf({ mode: 'range', tz: 'UTC', untilMs: TS_MS.F + 1 }) });
    assert.equal(at?.totalRow?.calls, 5, 'F dropped when untilMs equals its instant');
    assert.equal(after1?.totalRow?.calls, 6, 'F kept one millisecond later');
  });

  it('loader: a period excluding two calls scopes counts, totals and notional to the rows and leaves conservation global', async () => {
    const all = await load(ctx.home, { by: ['role'], tz: 'UTC', period: periodOf({ mode: 'all' }) });
    const some = await load(ctx.home, { by: ['role'], tz: 'UTC', period: periodOf({ mode: 'range', tz: 'UTC', sinceMs: 1793491200000, untilMs: 1793577600000 }) });
    assert.equal(some?.counts?.calls, 4);
    assert.equal(some?.totals?.find((t) => t.class === 'input')?.sum, 400);
    assert.equal(some?.notional?.known_nano, 60000); // 4 x 15000
    assert.deepEqual(some?.conservation, all?.conservation);
    assert.equal(all?.counts?.calls, 6);
  });

  it('loader: a period containing every call reproduces the unbounded scoped values', async () => {
    const all = await load(ctx.home, { by: ['role'], tz: 'UTC', period: periodOf({ mode: 'all' }) });
    const wide = await load(ctx.home, { by: ['role'], tz: 'UTC', period: periodOf({ mode: 'range', tz: 'UTC', sinceMs: 0, untilMs: 4102444800000 }) });
    assert.ok(all?.counts, 'counts present');
    assert.deepEqual(wide?.counts, all?.counts);
    assert.deepEqual(wide?.totals, all?.totals);
    assert.deepEqual(wide?.notional, all?.notional);
    assert.deepEqual(wide?.pricing, all?.pricing);
  });

  it('loader: every section total passes the rows-sum-to-total check', async () => {
    const r = await load(ctx.home, { by: ['model', 'effort'], tz: LA });
    assert.deepEqual(r?.totalsCheck?.main, { ok: true, columns: [] });
  });

  it('loader: tampering with a part cost makes the main totals check name notional_usd', async () => {
    const ctx2 = await shapeHome();
    try {
      await load(ctx2.home, {});
      const db = new Db(derivedPath(ctx2.home));
      db.exec("UPDATE api_call_part SET cost_nano = cost_nano + 1 WHERE call_key = 'm:msg_rs_a'");
      db.close();
      const r = await load(ctx2.home, { by: ['role'], tz: LA });
      assert.equal(r?.totalsCheck?.main?.ok, false);
      assert.deepEqual(r?.totalsCheck?.main?.columns, ['notional_usd']);
    } finally { ctx2.cleanup(); }
  });

  it('loader: the period object is attached with the resolved zone and bounds', async () => {
    const period = periodLA({ sinceMs: 1793516400000, untilMs: 1793606400000, sinceDate: '2026-11-01', untilDate: '2026-11-01' });
    const r = await load(ctx.home, { by: ['role'], tz: LA, period });
    assert.deepEqual(r?.period, period);
  });

  it('loader: labels, by-labels and the footer labels are ASCII constants per dimension', async () => {
    const r = await load(ctx.home, { by: BY6, tz: LA });
    assert.deepEqual(r?.byLabels?.main, {
      role: 'derived', model: 'transcript', effort: 'derived', day: 'derived', session: 'transcript', repo: 'reconstructed',
    });
    assert.equal(r?.byLabels?.side, null);
  });

  it('loader: a bounded period over a call with an unknown record time counts it in callsTsUnknown and drops it from every row', async () => {
    const ctx2 = makeHome();
    try {
      const db = openTempStore({ home: ctx2.home });
      const base = { session_id: 'sess-u', model: 'claude-haiku-5-5', input_tokens: 10, output_tokens: 1, cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0 };
      insertMessage(db, { ...base, message_id: 'msg_known', ts_utc: '2026-11-01T10:00:00.000Z' });
      insertMessage(db, { ...base, message_id: 'msg_unknown', ts_utc: null });
      db.close();
      const bounded = await load(ctx2.home, { by: ['role'], tz: 'UTC', period: periodOf({ mode: 'range', tz: 'UTC', sinceMs: 0 }) });
      assert.equal(bounded?.callsTsUnknown, 1);
      assert.equal(bounded?.totalRow?.calls, 1);
      const unbounded = await load(ctx2.home, { by: ['role'], tz: 'UTC', period: periodOf({ mode: 'all' }) });
      assert.equal(unbounded?.totalRow?.calls, 2, 'an unbounded period counts both calls');
    } finally { ctx2.cleanup(); }
  });

  it('loader: an empty store has no rows, no total, an all period and a no-ingest freshness check', async () => {
    const ctx2 = makeHome();
    try {
      const r = await load(ctx2.home, { by: ['role'], tz: 'UTC' });
      assert.deepEqual(rowsOf(r), []);
      assert.equal(r?.totalRow ?? null, null);
      assert.equal(r?.freshnessCheck?.verdict, 'none');
    } finally { ctx2.cleanup(); }
  });

  it('loader: without a period the old behavior stays (mode all, every call counted)', async () => {
    const r = await load(ctx.home, { by: ['role', 'model'] });
    assert.equal(r?.period?.mode, 'all');
    assert.equal(r?.counts?.calls, 6);
  });

  it('loader: rows of two sections with the same role and model have different keys (case otel-join)', async () => {
    const ctx2 = await shapeHome(['otel-join']);
    try {
      const r = await load(ctx2.home, { by: ['role', 'model'], tz: 'UTC' });
      const keys = [...rowsOf(r), ...(r?.otelRows ?? []), ...(r?.harnessRows ?? [])].map((x) => x.key);
      assert.ok(keys.length > 0 && keys.every((k) => typeof k === 'string'), 'keys present');
      assert.equal(new Set(keys).size, keys.length, 'keys are unique across sections');
      assert.ok((r?.otelRows ?? []).every((x) => x.key?.startsWith('otel/')));
      assert.ok((r?.harnessRows ?? []).every((x) => x.key?.startsWith('harness/')));
    } finally { ctx2.cleanup(); }
  });
});

// ---- freshness (loader level) -----------------------------------------------------------------------------------------------
const NOW_MS = Date.parse(DST_NOW);
const at = (secondsAgo) => new Date(NOW_MS - secondsAgo * 1000).toISOString();

async function seededHome(spec) {
  const ctx = makeHome();
  const db = openStore({ home: ctx.home });
  seedFreshness(db, spec);
  db.close();
  return ctx;
}

async function freshOf(spec, nowMs = NOW_MS) {
  const ctx = await seededHome(spec);
  try {
    const { loadFreshness } = await mod('report/freshness.mjs');
    const out = loadFreshness({ home: ctx.home, nowMs });
    return out ? JSON.parse(JSON.stringify(out)) : null;
  } finally { ctx.cleanup(); }
}
const srcOf = (f, name) => (f?.sources ?? []).find((s) => s.name === name);
const baseSpec = (over = {}) => ({
  runs: [{ ended: at(3600), sources: ['transcript', 'otel', 'usage'] }],
  files: [
    { source: 'transcript', alias: 'claude', rel: 'p/s.jsonl', last: at(3600) },
    { source: 'otel', alias: 'live', rel: 'events-2026-11-03.jsonl', last: at(3600) },
  ],
  ...over,
});

describe('loader: freshness', () => {
  for (const [secs, stale] of [[129599, false], [129600, false], [129601, true]]) {
    it(`loader: freshness record age ${secs} s is ${stale ? 'stale' : 'not stale'} for the transcript source`, async () => {
      const f = await freshOf(baseSpec({ files: [{ source: 'transcript', alias: 'claude', rel: 'p/s.jsonl', last: at(secs) }] }));
      assert.equal(srcOf(f, 'transcript')?.recordAgeSec, secs);
      assert.equal(srcOf(f, 'transcript')?.state === 'stale', stale);
    });
    it(`loader: freshness run age ${secs} s is ${stale ? 'stale' : 'not stale'} for the transcript source`, async () => {
      const f = await freshOf(baseSpec({ runs: [{ ended: at(secs), sources: ['transcript', 'otel', 'usage'] }] }));
      assert.equal(srcOf(f, 'transcript')?.runAgeSec, secs);
      assert.equal(srcOf(f, 'transcript')?.state === 'stale', stale);
    });
  }

  it('loader: freshness a fresher preserve file never hides a stale live OTel directory', async () => {
    const f = await freshOf(baseSpec({
      files: [
        { source: 'transcript', alias: 'claude', rel: 'p/s.jsonl', last: at(3600) },
        { source: 'otel', alias: 'live', rel: 'events-2026-10-20.jsonl', last: '2026-10-20T10:00:00.000Z' },
        { source: 'otel', alias: 'preserve', rel: 'events-2026-11-03.jsonl', last: '2026-11-03T06:00:00.000Z' },
      ],
    }));
    assert.equal(srcOf(f, 'otel')?.state, 'stale');
    assert.equal(srcOf(f, 'otel')?.newestRecordUtc, '2026-10-20T10:00:00.000Z');
    assert.equal(f?.verdict, 'stale');
  });

  it('loader: freshness the usage source is not rated and never stale', async () => {
    const f = await freshOf(baseSpec());
    assert.equal(srcOf(f, 'usage')?.state, 'not_rated');
    assert.equal(srcOf(f, 'usage')?.live, false);
  });

  it('loader: freshness a store with no ingest run has verdict none', async () => {
    const f = await freshOf({ runs: [], files: [] });
    assert.equal(f?.verdict, 'none');
  });

  it('loader: freshness a live source with a run but no records is empty and not stale', async () => {
    const f = await freshOf(baseSpec({ files: [{ source: 'transcript', alias: 'claude', rel: 'p/s.jsonl', last: at(3600) }] }));
    assert.equal(srcOf(f, 'otel')?.state, 'empty');
  });

  it('loader: freshness a live source that never ran is stale while another source ran', async () => {
    const f = await freshOf({ runs: [{ ended: at(3600), sources: ['transcript'] }], files: [] });
    assert.equal(srcOf(f, 'otel')?.state, 'never_run');
    assert.equal(f?.verdict, 'stale');
  });

  it('loader: freshness a future-dated newest record gives a negative age and is not stale', async () => {
    const f = await freshOf(baseSpec({ files: [{ source: 'transcript', alias: 'claude', rel: 'p/s.jsonl', last: at(-7200) }] }));
    assert.equal(srcOf(f, 'transcript')?.recordAgeSec, -7200);
    assert.notEqual(srcOf(f, 'transcript')?.state, 'stale');
  });

  it('loader: freshness only runs with status ok count as the last run', async () => {
    const f = await freshOf(baseSpec({
      runs: [{ ended: at(200000), sources: ['transcript', 'otel', 'usage'] }, { ended: at(60), status: 'failed', sources: ['transcript', 'otel', 'usage'] }],
    }));
    assert.equal(srcOf(f, 'transcript')?.runAgeSec, 200000);
  });
});

// ---- spawned CLI ---------------------------------------------------------------------------------------------------------------
const TRACER_ARGS = ['cost', '--by', 'role,model,effort,day,session,repo', '--tz', LA, '--json'];

describe('cli', () => {
  let ctx;
  before(async () => { ctx = await shapeHome(); });
  after(() => ctx.cleanup());

  it('tracer: cost --by role,model,effort,day,session,repo --json on the DST case, then evidence for the first row', () => {
    const r = cli(ctx.home, TRACER_ARGS);
    assert.equal(r.status, 0, 'exit status');
    assert.equal(r.stderr, '', 'stderr is empty');
    let doc = null;
    try { doc = JSON.parse(r.stdout); } catch { doc = null; }
    assert.equal(doc?.schema, 'rigorscope.cost/1');
    const rows = doc?.sections?.main?.rows ?? [];
    assert.equal(rows.length, 6);
    assert.deepEqual(rows.map((x) => x.dims?.session?.value), [S1, S1, S3, S2, S2, S4]);
    const total = doc?.sections?.main?.total;
    assert.equal(total?.calls, 6);
    assert.deepEqual([total?.input?.value, total?.output?.value, total?.cache_read?.value, total?.cache_write?.value, total?.notional_usd?.value], [550, 70, 0, 0, 675000]);
    const keyA = rows[0]?.key;
    assert.equal(keyA, `main/role=main/model=claude-haiku-5-5/effort=high/day=2026-10-31/session=${S1}/repo=rigorscope`);
    const ev = cli(ctx.home, ['evidence', keyA ?? 'main/total', '--tz', LA]);
    assert.equal(ev.status, 0, 'evidence exit status');
    assert.match(ev.stdout, /^calls=1 sessions=1 listed=1 /m);
    assert.match(ev.stdout, new RegExp(`^ {2}session ${S1} agent - message msg_rs_a request req_rs_a at 2026-11-01T06:59:59.000Z occurrences 1$`, 'm'));
    assert.match(ev.stdout, new RegExp(`^ {4}file claude:~-repos-rigorscope/${S1}.jsonl$`, 'm'));
    assert.equal(ev.stdout.includes(['', 'home', ''].join('/')), false);
  });

  for (const [tz, rows] of Object.entries(ER.roleModelEffortDay)) {
    it(`cli: text --by role,model,effort,day --tz ${tz} prints the hand-computed rows and one =total row`, () => {
      const r = cli(ctx.home, ['cost', '--by', 'role,model,effort,day', '--tz', tz]);
      assert.equal(r.status, 0);
      const t = parse(r.stdout);
      assert.deepEqual(t.blocks[0].rows.map((x) => [x.role, x.model, x.effort, x.day, x.calls, x.input, x.output, x.notional_usd]), rows);
      assert.deepEqual(t.blocks[0].total, {
        role: '=total', model: '=', effort: '=', day: '=', calls: '6', input: '550', output: '70', cache_read: '0', cache_write: '0',
        notional_usd: '0.000675', window_5h: '?', window_7d: '?',
      });
      assert.equal(t.totalsCheck, 'totals check: main OK (rows sum to the total row in input, output, cache_read, cache_write, notional_usd, window_5h and window_7d)');
    });
  }

  for (const [dim, key] of [['day', 'day'], ['repo', 'repo'], ['session', 'session'], ['effort', 'effort']]) {
    for (const tz of dim === 'day' ? Object.keys(ER.day) : [LA]) {
      it(`cli: text --by ${dim} --tz ${tz} prints the hand-computed rows`, () => {
        const r = cli(ctx.home, ['cost', '--by', dim, '--tz', tz]);
        assert.equal(r.status, 0);
        const t = parse(r.stdout);
        const want = dim === 'day' ? ER.day[tz] : ER[key];
        assert.deepEqual(t.blocks[0].rows.map((x) => [x[dim], x.calls, x.input, x.output, x.notional_usd]), want);
      });
    }
  }

  it('cli: the footer lines appear in the fixed order with by-labels and scope', () => {
    const r = cli(ctx.home, ['cost', '--by', 'role,day', '--tz', LA]);
    const t = parse(r.stdout);
    assert.deepEqual(Object.keys(t.footer), ['labels', 'by-labels', 'scope', 'conservation', 'counts', 'totals', 'pricing', 'notional', 'window', 'join', 'roles']);
    assert.equal(t.footer['by-labels'][0], 'by-labels: role=derived day=derived');
    assert.match(t.footer.scope[0], /^scope: period limits rows, totals check, counts \(except synthetic_skipped\), totals, pricing, notional and otel-only; conservation, window, join, roles, crosscheck and error-band cover all ingested records$/);
  });

  it('cli: by-labels is absent when --by names only role and model', () => {
    const t = parse(cli(ctx.home, ['cost', '--by', 'role,model']).stdout);
    assert.equal(t.footer['by-labels'], undefined);
  });

  it('cli: by-labels names every new dimension in --by order for main rows', () => {
    const t = parse(cli(ctx.home, ['cost', '--by', 'repo,session,effort,day,model,role', '--tz', LA]).stdout);
    assert.equal(t.footer['by-labels'][0], 'by-labels: repo=reconstructed session=transcript effort=derived day=derived model=transcript role=derived');
  });

  it('cli: the default period is the last 7 days before the fixed clock and says so', () => {
    const t = parse(cli(ctx.home, ['cost', '--tz', LA]).stdout);
    assert.equal(t.period, `period: last 7 days, from ${new Date(NOW_MS - 168 * HOUR).toISOString()} (default), tz=${LA}, calls_ts_unknown=0`);
  });

  it('cli: an explicit since and until prints both bounds in the zone', () => {
    const t = parse(cli(ctx.home, ['cost', '--since', '2026-11-01', '--until', '2026-11-01', '--tz', LA]).stdout);
    assert.equal(t.period, `period: from 2026-11-01 (2026-11-01T07:00:00.000Z) to 2026-11-01 inclusive (before 2026-11-02T08:00:00.000Z), tz=${LA}, calls_ts_unknown=0`);
    assert.equal(t.blocks[0].total.calls, '4');
  });

  it('cli: only --until has no lower bound and an exclusive bound at the next local day', () => {
    const t = parse(cli(ctx.home, ['cost', '--until', '2026-10-31', '--tz', LA]).stdout);
    assert.equal(t.period, `period: from the first record to 2026-10-31 inclusive (before 2026-11-01T07:00:00.000Z), tz=${LA}, calls_ts_unknown=0`);
    assert.equal(t.blocks[0].total?.calls, '1');
  });

  it('cli: only --since has no upper bound', () => {
    const t = parse(cli(ctx.home, ['cost', '--since', '2026-11-02', '--tz', LA]).stdout);
    assert.equal(t.period, `period: from 2026-11-02 (2026-11-02T08:00:00.000Z) to the last record, tz=${LA}, calls_ts_unknown=0`);
    assert.equal(t.blocks[0].total?.calls, '1');
  });

  for (const [tz, keep] of [[LA, 'BCDE'], ['UTC', 'ABCD']]) {
    it(`cli: --since 2026-11-01 --until 2026-11-01 --tz ${tz} keeps calls ${keep.split('').join(', ')}`, () => {
      const t = parse(cli(ctx.home, ['cost', '--since', '2026-11-01', '--until', '2026-11-01', '--tz', tz, '--by', 'session']).stdout);
      assert.equal(t.blocks[0].total?.calls, String(keep.length));
      const sessions = t.blocks[0].rows.map((x) => x.session).sort();
      assert.deepEqual(sessions, [...new Set(keep.split('').map((l) => ({ A: S1, B: S1, C: S2, D: S2, E: S3, F: S4 })[l]))].sort());
    });
  }

  it('cli: hostile or malformed flags exit 2 with one fixed line and create no state', () => {
    const bad = [
      ['--by', ''], ['--by', 'bogus'], ['--by', 'role,role'], ['--by', 'role, model'], ['--by', ' role'], ['--by', 'role;DROP TABLE x'],
      ['--by', 'role,'], ['--by', ',role'], ['--by', 'Role'], ['--since', '2026-1-1'], ['--since', '2026-02-30'],
      ['--since', '2026-11-01T00:00:00Z'], ['--since', ' 2026-11-01'], ['--until', '2026/11/01'], ['--until', ''],
      ['--tz', 'Not/AZone'], ['--tz', ''], ['--tz', '+05:00'], ['--tz', 'a b'], ['--limit', '3'],
    ];
    assert.equal(cli(ctx.home, ['cost', '--by', BY6.join(','), '--since', '2026-11-01', '--until', '2026-11-02', '--tz', LA]).status, 0, 'valid flags exit 0 (positive control)');
    for (const args of bad) {
      const fresh = makeHome();
      try {
        const r = cli(fresh.home, ['cost', ...args]);
        assert.equal(r.status, 2, `exit status for flag ${args[0]}`);
        assert.equal(r.stderr.trim().split('\n').length, 1, 'one stderr line');
        assert.equal(existsSync(stateDirOf(fresh.home)), false, 'no state directory created');
      } finally { fresh.cleanup(); }
    }
  });

  it('cli: --since after --until exits 2 before any state', () => {
    assert.equal(cli(ctx.home, ['cost', '--since', '2026-11-01', '--until', '2026-11-02']).status, 0, 'ordered dates exit 0 (positive control)');
    const fresh = makeHome();
    try {
      const r = cli(fresh.home, ['cost', '--since', '2026-11-02', '--until', '2026-11-01']);
      assert.equal(r.status, 2);
      assert.equal(existsSync(stateDirOf(fresh.home)), false);
    } finally { fresh.cleanup(); }
  });

  it('cli: an invalid RIGORSCOPE_NOW exits 2 with one fixed line and creates no state', () => {
    assert.match(cli(ctx.home, ['cost']).stdout, /clock fixed by RIGORSCOPE_NOW/, 'a valid fixed clock is honored (positive control)');
    for (const v of ['bogus', '2026-11-03', '2026-11-03T12:00:00+00:00', '2026-13-03T12:00:00Z', '']) {
      const fresh = makeHome();
      try {
        const r = cli(fresh.home, ['cost'], { RIGORSCOPE_NOW: v });
        assert.equal(r.status, 2, 'exit status');
        assert.equal(existsSync(stateDirOf(fresh.home)), false);
      } finally { fresh.cleanup(); }
    }
  });

  it('cli: a fixed clock is named in the freshness header', () => {
    const t = parse(cli(ctx.home, ['cost']).stdout);
    assert.match(t.freshness.first, /^freshness: (OK|STALE) as of 2026-11-03T12:00:00.000Z \(clock fixed by RIGORSCOPE_NOW\)$/);
  });

  it('cli: text and JSON of the same run agree cell for cell', () => {
    const args = ['--by', 'role,model,effort,day', '--tz', LA];
    const t = parse(cli(ctx.home, ['cost', ...args]).stdout);
    const doc = parseJson(cli(ctx.home, ['cost', ...args, '--json']).stdout);
    const rows = doc.sections.main.rows;
    assert.equal(rows.length, t.blocks[0].rows.length);
    rows.forEach((jr, i) => {
      const tr = t.blocks[0].rows[i];
      assert.equal(String(jr.calls), tr.calls);
      assert.equal(String(jr.input.value), tr.input);
      assert.equal(String(jr.output.value), tr.output);
      assert.equal(usd6(jr.notional_usd.value), tr.notional_usd);
      assert.equal(jr.window_5h.value, null);
      assert.equal(tr.window_5h, '?');
    });
  });

  it('cli: JSON keys, measure key set, units, nano-dollars and null for unknown', () => {
    const doc = parseJson(cli(ctx.home, ['cost', '--by', 'role,model', '--tz', 'UTC', '--json']).stdout);
    assert.deepEqual(Object.keys(doc), ['schema', 'as_of_utc', 'clock_fixed', 'freshness', 'period', 'by', 'population', 'populations', 'units', 'labels', 'by_labels', 'window_usage', 'sections', 'footer', 'filters']);
    assert.equal(doc.clock_fixed, true);
    assert.equal(doc.as_of_utc, DST_NOW);
    assert.deepEqual(doc.units, {
      input: 'tokens', output: 'tokens', cache_read: 'tokens', cache_write: 'tokens', notional_usd: 'nano_usd', window_5h: 'percent_of_window', window_7d: 'percent_of_window',
    });
    const row = doc.sections.main.rows[0];
    for (const c of Object.keys(doc.units)) assert.deepEqual(Object.keys(row[c]), ['value', 'n', 'label', 'coverage', 'evidence'], `measure keys of ${c}`);
    assert.equal(row.input.label, 'transcript');
    assert.equal(row.notional_usd.label, 'derived');
    assert.equal(Number.isInteger(row.notional_usd.value), true);
    assert.equal(row.window_5h.value, null);
    assert.equal(row.window_5h.label, 'unavailable');
    assert.equal(row.input.evidence, row.key);
    assert.deepEqual(Object.keys(doc.sections), ['main', 'otel', 'harness']);
    assert.equal(doc.sections.main.total_check.ok, true);
  });

  it('cli: --json prints one document and nothing else, and an empty store gives empty arrays and null totals', () => {
    const fresh = makeHome();
    try {
      const r = cli(fresh.home, ['cost', '--json']);
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      const doc = parseJson(r.stdout);
      assert.deepEqual(doc.sections?.main?.rows, []);
      assert.equal(doc.sections?.main?.total, null);
      assert.equal(doc.window_usage, null);
      assert.equal(r.stdout.endsWith('}\n'), true);
    } finally { fresh.cleanup(); }
  });

  it('cli: an empty report prints the freshness block, the period line and no rows and nothing else', () => {
    const fresh = makeHome();
    try {
      const out = cli(fresh.home, ['cost']).stdout.split('\n').filter((l) => l !== '');
      assert.equal(out.length, 3);
      assert.equal(out[0], 'freshness: no ingest recorded');
      assert.match(out[1], /^period: last 7 days, from /);
      assert.equal(out[2], 'no rows');
    } finally { fresh.cleanup(); }
  });

  it('cli: no output line holds an absolute path, a home prefix or the OS user name', () => {
    assert.match(cli(ctx.home, TRACER_ARGS).stdout, /rigorscope\.cost\/1/, 'the JSON document is printed (positive control)');
    const outs = [cli(ctx.home, ['cost', '--by', BY6.join(','), '--tz', LA, '--evidence']).stdout, cli(ctx.home, TRACER_ARGS).stdout];
    for (const o of outs) {
      assert.equal(/\/(home|Users|mnt)\//.test(o), false);
      assert.equal(o.includes(PLANTS.osUser), false);
    }
  });

  it('cli: two parallel cost children print identical stdout and leave derived.db unchanged', async () => {
    cli(ctx.home, ['cost']);
    const before = sha256File(derivedPath(ctx.home));
    const env = cliEnv(ctx.home, { RIGORSCOPE_NOW: DST_NOW });
    const [a, b] = await Promise.all([
      runCliAsyncEnv(['cost', '--by', 'day', '--tz', LA], ctx.home, env), runCliAsyncEnv(['cost', '--by', 'day', '--tz', LA], ctx.home, env),
    ]);
    assert.equal(a.status, 0);
    assert.match(a.stdout, /=total/, 'the total row is printed (positive control)');
    assert.equal(a.stdout, b.stdout);
    assert.equal(sha256File(derivedPath(ctx.home)), before);
  });

  it('cli: running cost twice prints identical output', () => {
    assert.match(cli(ctx.home, ['cost', '--tz', LA]).stdout, /^freshness: (OK|STALE) as of /, 'the freshness block is printed (positive control)');
    assert.equal(cli(ctx.home, ['cost', '--tz', LA]).stdout, cli(ctx.home, ['cost', '--tz', LA]).stdout);
  });

  it('cli: cost --evidence lists the first calls of every row under a heading', () => {
    const r = cli(ctx.home, ['cost', '--by', 'session', '--tz', LA, '--evidence', '--limit', '1']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^evidence \(first 1 calls per row; run rigorscope evidence ROW_KEY for the full listing\):$/m);
    assert.equal((r.stdout.match(/^ {2}session /gm) ?? []).length, 5, 'four rows and the total row list one call each');
  });

  it('cli: --limit without --evidence exits 2', () => {
    assert.equal(cli(ctx.home, ['cost', '--evidence', '--limit', '3']).status, 0, 'evidence with a limit exits 0 (positive control)');
    assert.equal(cli(ctx.home, ['cost', '--limit', '3']).status, 2);
  });
});

function runCliAsyncEnv(args, home, env) {
  return runCliAsync(args, { home, env });
}

// Earlier cases stay inside the default window once the clock is FIXTURE_NOW.
describe('cli: default window over the earlier cases', () => {
  it('every case except report-shape has its earliest record at or after FIXTURE_NOW minus 168 hours', async () => {
    const lower = Date.parse(FIXTURE_NOW) - 168 * HOUR;
    const ids = (await loadCases()).filter((c) => c.id !== 'report-shape' && c.sources.includes('transcript')).map((c) => c.id);
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ids });
      await ingestHome(ctx.home);
      const db = new Db(join(stateDirOf(ctx.home), 'store.db'), { readOnly: true });
      const min = db.prepare("SELECT min(unixepoch(ts_utc, 'subsec') * 1000) AS m FROM cc_message WHERE ts_utc IS NOT NULL").get().m;
      db.close();
      assert.ok(min >= lower, 'earliest record is inside the default window');
    } finally { ctx.cleanup(); }
  });
});

// ---- freshness header (spawned) ---------------------------------------------------------------------------------------------
const pad = (name) => name.padEnd(10);
const fl = (name, rec, recAge, run, runAge, tail2) => `  ${pad(name)} newest record ${rec} (age ${recAge}); last run ${run} (age ${runAge}); ${tail2}`;

describe('cli: freshness header', () => {
  async function headerOf(spec, extra = {}) {
    const c = await seededHome(spec);
    try {
      const r = cli(c.home, ['cost'], extra);
      assert.equal(r.status, 0, 'exit 0 whatever the verdict');
      return parse(r.stdout).freshness.lines;
    } finally { c.cleanup(); }
  }

  it('cli: freshness block for a STALE live OTel directory with a recent run reads as an idle source', async () => {
    const lines = await headerOf(baseSpec({
      files: [
        { source: 'transcript', alias: 'claude', rel: 'p/s.jsonl', last: at(129601) },
        { source: 'otel', alias: 'live', rel: 'events-2026-10-20.jsonl', last: '2026-10-20T10:00:00.000Z' },
        { source: 'otel', alias: 'preserve', rel: 'events-2026-11-03.jsonl', last: '2026-11-03T06:00:00.000Z' },
      ],
    }));
    assert.deepEqual(lines, [
      'freshness: STALE as of 2026-11-03T12:00:00.000Z (clock fixed by RIGORSCOPE_NOW)',
      `  ${pad('ledger')} newest record none (age ?); last run none (age ?); not rated`, // plan 03-03: the ledger source is never rated
      fl('otel', '2026-10-20T10:00:00.000Z', '338h00m00s', '2026-11-03T11:00:00.000Z', '1h00m00s', 'limit 36h; STALE: newest record older than 36h; last ingest run 1h00m00s ago, so ingest is current and the source looks idle'),
      fl('transcript', '2026-11-01T23:59:59.000Z', '36h00m01s', '2026-11-03T11:00:00.000Z', '1h00m00s', 'limit 36h; STALE: newest record older than 36h; last ingest run 1h00m00s ago, so ingest is current and the source looks idle'),
      `  ${pad('usage')} newest record none (age ?); last run 2026-11-03T11:00:00.000Z (age 1h00m00s); not rated`,
    ]);
  });

  it('cli: freshness block is OK when every live source is within 36 hours, with the boundary age', async () => {
    const lines = await headerOf(baseSpec({
      files: [
        { source: 'transcript', alias: 'claude', rel: 'p/s.jsonl', last: at(129600) },
        { source: 'otel', alias: 'live', rel: 'events-2026-11-03.jsonl', last: at(60) },
      ],
    }));
    assert.equal(lines[0], 'freshness: OK as of 2026-11-03T12:00:00.000Z (clock fixed by RIGORSCOPE_NOW)');
    assert.equal(lines[3], fl('transcript', '2026-11-02T00:00:00.000Z', '36h00m00s', '2026-11-03T11:00:00.000Z', '1h00m00s', 'limit 36h; ok'));
  });

  it('cli: freshness block names an old run without an old record', async () => {
    const lines = await headerOf(baseSpec({ runs: [{ ended: at(129601), sources: ['transcript', 'otel', 'usage'] }] }));
    assert.match(lines[3], /limit 36h; STALE: last ingest run older than 36h$/);
  });

  it('cli: freshness block names both an old record and an old run', async () => {
    const lines = await headerOf(baseSpec({
      runs: [{ ended: at(129601), sources: ['transcript', 'otel', 'usage'] }],
      files: [{ source: 'transcript', alias: 'claude', rel: 'p/s.jsonl', last: at(129602) }, { source: 'otel', alias: 'live', rel: 'e.jsonl', last: at(60) }],
    }));
    assert.match(lines[3], /limit 36h; STALE: newest record older than 36h; last ingest run older than 36h$/);
  });

  it('cli: freshness block says no records (not stale) for a live source with a run but no records', async () => {
    const lines = await headerOf(baseSpec({ files: [{ source: 'transcript', alias: 'claude', rel: 'p/s.jsonl', last: at(60) }] }));
    assert.match(lines[2], /^ {2}otel {7}newest record none \(age \?\); last run .* limit 36h; no records \(not stale\)$/);
    assert.match(lines[0], /^freshness: OK /);
  });

  it('cli: freshness block says no ingest run recorded for a live source that never ran', async () => {
    const lines = await headerOf({ runs: [{ ended: at(60), sources: ['transcript'] }], files: [] });
    assert.match(lines[2], /newest record none \(age \?\); last run none \(age \?\); limit 36h; STALE: no ingest run recorded for this source$/);
    assert.match(lines[0], /^freshness: STALE /);
  });

  it('cli: freshness block with no ingest at all is the single line no ingest recorded', async () => {
    const lines = await headerOf({ runs: [], files: [] });
    assert.deepEqual(lines, ['freshness: no ingest recorded']);
  });

  it('cli: a future-dated record prints a negative age and does not make the source stale', async () => {
    const lines = await headerOf(baseSpec({ files: [{ source: 'transcript', alias: 'claude', rel: 'p/s.jsonl', last: at(-5) }, { source: 'otel', alias: 'live', rel: 'e.jsonl', last: at(60) }] }));
    assert.match(lines[3], /\(age -0h00m05s\)/);
    assert.match(lines[0], /^freshness: OK /);
  });

  it('cli: the clock marker is absent when no fixed clock is set', async () => {
    const c = await seededHome(baseSpec());
    try {
      const env = cliEnv(c.home);
      delete env.RIGORSCOPE_NOW;
      const r = runCli(['cost'], { home: c.home, env });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stdout.split('\n')[0], /RIGORSCOPE_NOW/);
    } finally { c.cleanup(); }
  });
});

// ---- otel-join blocks and totals (spawned) -----------------------------------------------------------------------------------
describe('cli: otel-join sections', () => {
  let ctx;
  before(async () => { ctx = await shapeHome(['otel-join']); });
  after(() => ctx.cleanup());

  it('cli: the main, otel-only and harness blocks each end with their own total row and the check lists the sections', () => {
    const r = cli(ctx.home, ['cost', '--by', 'role,model', '--tz', 'UTC', '--since', '2026-10-27', '--until', '2026-10-28'], { RIGORSCOPE_NOW: FIXTURE_NOW });
    assert.equal(r.status, 0);
    const t = parse(r.stdout);
    assert.equal(t.blocks.length, 3);
    assert.ok(t.blocks.every((b) => b.total && b.total.role === '=total'), 'each block has a total row');
    assert.match(t.totalsCheck, /^totals check: main OK; otel OK; harness OK \(rows sum to the total row in /);
    const keys = new Set();
    for (const b of t.blocks) for (const row of b.rows) keys.add(`${b.heading ?? 'main'}|${row.role}|${row.model}`);
    assert.equal(keys.size, t.blocks.reduce((n, b) => n + b.rows.length, 0));
  });

  it('cli: the by-labels line carries an otel clause only when otel or harness rows exist', () => {
    const t = parse(cli(ctx.home, ['cost', '--by', 'role,day', '--tz', 'UTC', '--since', '2026-10-27', '--until', '2026-10-28'], { RIGORSCOPE_NOW: FIXTURE_NOW }).stdout);
    assert.match(t.footer['by-labels'][0], /; otel and harness rows: role=otel day=derived$/);
  });

  it('cli: the evidence listing of the otel total names the otel root alias and a byte offset', () => {
    const r = cli(ctx.home, ['evidence', 'otel/total', '--tz', 'UTC', '--since', '2026-10-27', '--until', '2026-10-28', '--limit', '2'], { RIGORSCOPE_NOW: FIXTURE_NOW });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^ {4}file live:events-\d{4}-\d{2}-\d{2}\.jsonl offset \d+$/m);
  });
});

// ---- window cells (text and JSON agree on a window case) -----------------------------------------------------------------------
describe('cli: window cells in JSON', () => {
  it('cli: the usage-window case prints window cells equal in text and JSON, labeled estimated', async () => {
    const ctx = await shapeHome(['usage-window']);
    try {
      // The snapshot series of window-cost.test.mjs: caches B, C and E, with an ingest after each.
      for (const snap of [SNAPSHOTS.B, SNAPSHOTS.C, SNAPSHOTS.E]) {
        writeUsageCache(ctx.home, snap);
        assert.equal(runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home) }).status, 0);
      }
      const extra = { RIGORSCOPE_NOW: '2026-10-28T12:00:00.000Z' };
      const text = parse(cli(ctx.home, ['cost', '--by', 'role'], extra).stdout);
      const doc = parseJson(cli(ctx.home, ['cost', '--by', 'role', '--json'], extra).stdout);
      const rows = doc.sections?.main?.rows ?? [];
      assert.equal(rows.length, text.blocks[0].rows.length);
      assert.ok(rows.length > 0);
      assert.ok(rows.some((jr) => jr.window_7d.value !== null), 'a known window cell exists');
      rows.forEach((jr, i) => {
        const tr = text.blocks[0].rows[i];
        if (jr.window_7d.value === null) assert.equal(tr.window_7d, '?');
        else {
          assert.equal(jr.window_7d.label, 'estimated');
          assert.equal(tr.window_7d, `${(Math.floor((Math.round(jr.window_7d.value * 1e6) + 5000) / 10000) / 100).toFixed(2)}%`);
        }
      });
    } finally { ctx.cleanup(); }
  });
});

describe('cli: scoped footer lines', () => {
  it('cli: a bounded period scopes the counts and notional lines to the displayed rows', async () => {
    const ctx = await shapeHome();
    try {
      const t = parse(cli(ctx.home, ['cost', '--since', '2026-11-02', '--until', '2026-11-02', '--tz', 'UTC']).stdout);
      assert.match(t.footer.counts[0], /^counts: calls=2 parts=2 /);
      assert.equal(t.footer.totals[0], 'totals: input=150 output=30 cache_read=0 cache_write=0 cache_5m=0 cache_1h=0');
      assert.equal(t.footer.notional[0], 'notional: usd=0.000615 label=derived');
      assert.match(t.footer.conservation[0], /^conservation: OK /);
    } finally { ctx.cleanup(); }
  });
});

describe('cli: the preserved real clock', () => {
  it('cli: without RIGORSCOPE_NOW the report still exits 0 and bounds the default window from the real clock', async () => {
    const ctx = await shapeHome();
    try {
      const env = cliEnv(ctx.home);
      delete env.RIGORSCOPE_NOW;
      const r = runCli(['cost'], { home: ctx.home, env });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^period: last 7 days, from \d{4}-\d{2}-\d{2}T/m);
    } finally { ctx.cleanup(); }
  });
});

describe('loader: scoped footer equality', () => {
  for (const caseId of ['iterations', 'otel-join', 'derive-dups', 'derive-roles-iter']) {
    it(`loader: a period containing every call reproduces the global counts, totals and otel-only lines of case ${caseId}`, async () => {
      const ctx = await shapeHome([caseId]);
      try {
        const all = await load(ctx.home, { by: ['role'], tz: 'UTC', period: periodOf({ mode: 'all' }) });
        const wide = await load(ctx.home, { by: ['role'], tz: 'UTC', period: periodOf({ mode: 'range', tz: 'UTC', sinceMs: 0, untilMs: 4102444800000 }) });
        assert.ok(all?.counts?.calls > 0, 'calls present');
        assert.deepEqual(wide?.counts, all?.counts);
        assert.deepEqual(wide?.totals, all?.totals);
        assert.deepEqual(wide?.notional, all?.notional);
        assert.deepEqual(wide?.pricing, all?.pricing);
        assert.deepEqual(wide?.otelOnly, all?.otelOnly);
        assert.deepEqual(wide?.totalRow?.sums, all?.totalRow?.sums);
      } finally { ctx.cleanup(); }
    });
  }
});

// Plan 02-02 (D-08, D-09, UNIT-01 adjacency): two repositories with one name stay apart. The units home gains a/proj and
// b/proj, each with one session; `cost --by repo` prints two rows displayed by their full repo keys, and `units` shows
// the same displays.
describe('cli: two repos with one name', () => {
  let ctx;
  const r = {};
  before(() => {
    ctx = makeHome();
    buildUnitsHome({ home: ctx.home, root: ctx.root, sameName: true });
    const env = cliEnv(ctx.home, { TZ: 'America/New_York' });
    r.ingest = runCli(['ingest'], { home: ctx.home, env });
    r.cost = runCli(['cost', '--by', 'repo'], { home: ctx.home, env });
    r.units = runCli(['units'], { home: ctx.home, env });
  });
  after(() => ctx.cleanup());

  it('cost --by repo prints one row per repo key, the same-named two displayed by their keys', () => {
    assert.equal(r.ingest.status, 0, r.ingest.stderr);
    assert.equal(r.cost.status, 0, r.cost.stderr);
    const repos = (parse(r.cost.stdout).blocks[0]?.rows ?? []).map((row) => row.repo);
    for (const d of UNITS_EXPECTED.sameName.displays) assert.ok(repos.includes(d), 'a same-named repo row by its key');
    assert.ok(repos.includes('alpha') && repos.includes('beta'), 'the uniquely named repos print by name');
    assert.ok(!repos.includes('proj'), 'no merged row under the shared name');
  });

  it('units shows the same displays for the same-named repos', () => {
    assert.equal(r.units.status, 0, r.units.stderr);
    const first = r.units.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]);
    for (const d of UNITS_EXPECTED.sameName.displays) assert.ok(first.includes(d), 'a units row by the full key');
  });
});
