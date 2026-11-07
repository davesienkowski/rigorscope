// Plan 01-08 contract: `rigorscope evidence <row-key>` (TRUST-04, D-08) and its loader. Written before the code (RED).
// Expected call sets are hand-computed in test/fixtures/cases/98-report-shape.mjs (expectedReport.evidence). New
// fields are read defensively, so a missing field fails an assertion and never a TypeError. No planted value is
// printed in a failure message.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLANTS, buildFixtureTree, cliEnv, ingestHome, makeHome, runCli, runCliAsync, sha256File, stateDirOf,
} from '../fixtures/build.mjs';
import { DST_NOW, FIXTURE_NOW } from '../fixtures/clock.mjs';
import { periodOf } from '../fixtures/period.mjs';
import { insertMessage, openTempStore } from '../fixtures/derive-rows.mjs';
import {
  MSG, S1, S2, S3, S4, TS_MS, expectedReport as ER,
} from '../fixtures/cases/98-report-shape.mjs';
import { O8_KEY } from '../fixtures/cases/97-otel-join.mjs';
import { Db, derivedPath, openStore } from '../../src/db.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const LA = 'America/Los_Angeles';
const LIMIT_ALL = 100000;
const cli = (home, args, extra = {}) => runCli(args, { home, env: cliEnv(home, { RIGORSCOPE_NOW: DST_NOW, ...extra }) });

async function shapeHome(cases = ['report-shape'], now = undefined) {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases });
  await ingestHome(ctx.home, cliEnv(ctx.home, now ? { RIGORSCOPE_NOW: now } : {}));
  return ctx;
}

async function prepare(home) {
  const { ensureDerived } = await mod('derive/ensure.mjs');
  ensureDerived({ home, now: () => new Date(DST_NOW) });
}

// loadEvidence with a thrown RangeError turned into data.
async function ev(home, rowKey, opts = {}) {
  await prepare(home);
  const { loadEvidence } = await mod('report/evidence.mjs');
  try {
    return loadEvidence({
      home, rowKey, period: periodOf({ mode: 'all', tz: 'UTC' }), tz: 'UTC', limit: 50, now: () => new Date(DST_NOW), ...opts,
    });
  } catch (err) {
    return { loadError: err.name };
  }
}
const lettersOf = (e) => (e?.items ?? []).map((i) => i.messageId);
const letters = (ls) => ls.map((l) => MSG[l]);
const rangeOf = (tz, sinceMs, untilMs) => periodOf({ mode: 'range', tz, sinceMs, untilMs });

const BAD_KEYS = [
  'bogus/total', 'Main/total', 'main', 'main/', '/main/total', 'main/total/', 'main/unknown=x', 'main/role=main/role=main',
  'main/role=', 'main/role=%7e', 'main/role=%7', 'main/role=%FF', 'main/role=%C3', 'main/total/role=main', 'main/role=main/model',
  `main/role=${'x'.repeat(600)}`, "main/role=main'; DROP TABLE api_call; --", 'main/role=a b', 'main/role=a\tb', '',
  'main/role=1/model=2/effort=3/day=4/session=5/repo=6/role=7',
];
const PARTITION_CASES = ['report-shape', 'otel-join', 'derive-roles-iter'];

describe('loader', () => {
  let ctx;
  before(async () => { ctx = await shapeHome(); });
  after(() => ctx.cleanup());

  it('loader: the high-effort Los_Angeles day key lists calls B then E with two sessions', async () => {
    const x = ER.evidence.highDay1LA;
    const e = await ev(ctx.home, x.key, { tz: x.tz, period: periodOf({ mode: 'all', tz: x.tz }) });
    assert.deepEqual(lettersOf(e), letters(x.calls));
    assert.deepEqual([e?.calls, e?.sessions, e?.listed], [2, x.sessions, 2]);
  });

  for (const k of ['totalDay1LA', 'totalDay1UTC']) {
    it(`loader: main/total over ${k} lists exactly the hand-computed calls in time order`, async () => {
      const x = ER.evidence[k];
      const tz = x.tz;
      const lower = tz === 'UTC' ? 1793491200000 : 1793516400000;
      const upper = tz === 'UTC' ? 1793577600000 : 1793606400000;
      const e = await ev(ctx.home, 'main/total', { tz, period: rangeOf(tz, lower, upper) });
      assert.deepEqual(lettersOf(e), letters(x.calls));
      assert.equal(e?.calls, x.calls.length);
    });
  }

  it('loader: the call at exactly the exclusive upper bound is not listed and one millisecond later it is', async () => {
    const a = await ev(ctx.home, 'main/total', { period: rangeOf('UTC', null, TS_MS.F) });
    const b = await ev(ctx.home, 'main/total', { period: rangeOf('UTC', null, TS_MS.F + 1) });
    assert.equal(a?.calls, 5);
    assert.equal(b?.calls, 6);
  });

  it('loader: listed items carry session, agent, message, request id, record time and occurrences and root alias plus relative file', async () => {
    const e = await ev(ctx.home, `main/role=main/model=claude-haiku-5-5/effort=high/day=2026-10-31/session=${S1}/repo=rigorscope`, { tz: LA, period: periodOf({ mode: 'all', tz: LA }) });
    assert.equal(e?.items?.length, 1);
    const i = e?.items?.[0];
    assert.deepEqual([i?.callKey, i?.sessionId, i?.agentId, i?.messageId, i?.requestId, i?.tsUtc, i?.occurrences],
      ['m:msg_rs_a', S1, '', 'msg_rs_a', 'req_rs_a', '2026-11-01T06:59:59.000Z', 1]);
    assert.deepEqual(i?.files, [{ root: 'claude', path: `~-repos-rigorscope/${S1}.jsonl`, offset: null }]);
  });

  for (const key of BAD_KEYS.slice(0, 3)) {
    it(`loader: the malformed key ${JSON.stringify(key.slice(0, 20))} throws a RangeError before any query`, async () => {
      await prepare(ctx.home);
      const { loadEvidence } = await mod('report/evidence.mjs');
      assert.throws(() => loadEvidence({ home: ctx.home, rowKey: key, period: periodOf({ mode: 'all' }), tz: 'UTC', limit: 50, now: () => new Date(DST_NOW) }), RangeError);
    });
  }

  it('loader: every hostile or malformed key throws a RangeError with a fixed message', async () => {
    await prepare(ctx.home);
    const { loadEvidence } = await mod('report/evidence.mjs');
    const messages = new Set();
    for (const key of BAD_KEYS) {
      try {
        loadEvidence({ home: ctx.home, rowKey: key, period: periodOf({ mode: 'all' }), tz: 'UTC', limit: 50, now: () => new Date(DST_NOW) });
        assert.fail('a malformed key was accepted');
      } catch (err) {
        assert.equal(err.name, 'RangeError');
        messages.add(err.message);
        assert.equal(err.message.includes('DROP'), false);
      }
    }
    assert.equal(messages.size, 1, 'one fixed message');
  });

  it('loader: limit 1 lists one call and keeps the call count', async () => {
    const e = await ev(ctx.home, 'main/total', { limit: 1 });
    assert.deepEqual([e?.calls, e?.listed, e?.items?.length], [6, 1, 1]);
    assert.equal(e?.items?.[0]?.messageId, 'msg_rs_a');
  });

  it('loader: limit bounds 0, 100001, -1, 1.5, NaN and a string throw RangeError and 100000 is accepted', async () => {
    for (const limit of [0, 100001, -1, 1.5, Number.NaN, '3']) {
      const e = await ev(ctx.home, 'main/total', { limit });
      assert.equal(e?.loadError, 'RangeError', 'bad limit rejected');
    }
    const ok = await ev(ctx.home, 'main/total', { limit: 100000 });
    assert.equal(ok?.listed, 6);
  });

  it('loader: listing is ordered by record time then call id and repeats byte for byte', async () => {
    const a = await ev(ctx.home, 'main/total', { limit: LIMIT_ALL });
    const b = await ev(ctx.home, 'main/total', { limit: LIMIT_ALL });
    assert.deepEqual(lettersOf(a), letters(['A', 'B', 'C', 'D', 'E', 'F']));
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it('loader: a valid key whose section has no calls gives zero counts and no items', async () => {
    const e = await ev(ctx.home, 'harness/total');
    assert.deepEqual([e?.calls, e?.sessions, e?.listed, e?.items], [0, 0, 0, []]);
  });

  it('loader: an empty store gives zero counts for a valid key and creates no file', async () => {
    const empty = makeHome();
    try {
      const e = await ev(empty.home, 'main/total');
      assert.deepEqual([e?.calls, e?.sessions, e?.listed], [0, 0, 0]);
    } finally { empty.cleanup(); }
  });

  it('loader: counts are exact integers and sessions are distinct owner sessions', async () => {
    const e = await ev(ctx.home, 'main/total');
    assert.deepEqual([e?.calls, e?.sessions], [6, 4]);
    assert.ok(Number.isInteger(e?.calls) && Number.isInteger(e?.sessions) && Number.isInteger(e?.listed));
    assert.deepEqual([...new Set((e?.items ?? []).map((i) => i.sessionId))].sort(), [S1, S2, S3, S4].sort());
  });

  it('loader: the result holds no absolute path, no home prefix and no planted OS user name', async () => {
    const e = await ev(ctx.home, 'main/total', { limit: LIMIT_ALL });
    const text = JSON.stringify(e);
    assert.ok(text.length > 20, 'evidence result present');
    assert.equal(/\/(home|Users|mnt)\//.test(text), false);
    assert.equal(text.includes(PLANTS.osUser), false);
  });
});

describe('loader: partitions, variants and files', () => {
  for (const caseId of PARTITION_CASES) {
    it(`loader: --by role keys of case ${caseId} partition each section total`, async () => {
      const ctx = await shapeHome([caseId], FIXTURE_NOW);
      try {
        await prepare(ctx.home);
        const { loadCostReport } = await mod('report/cost.mjs');
        let report;
        try { report = loadCostReport({ home: ctx.home, by: ['role'], now: () => new Date(DST_NOW), tz: 'UTC', period: periodOf({ mode: 'all', tz: 'UTC' }) }); } catch { report = {}; }
        const groups = { main: report?.rows ?? [], otel: report?.otelRows ?? [], harness: report?.harnessRows ?? [] };
        let checked = 0;
        for (const [section, rows] of Object.entries(groups)) {
          const total = await ev(ctx.home, `${section}/total`, { limit: LIMIT_ALL });
          const union = [];
          if (rows.length > 0) assert.ok((total?.items ?? []).length > 0, `${section} total lists calls`);
          for (const row of rows) {
            assert.equal(typeof row.key, 'string', 'row key present');
            const part = await ev(ctx.home, row.key, { limit: LIMIT_ALL });
            union.push(...(part?.items ?? []).map((i) => i.callKey));
          }
          assert.equal(new Set(union).size, union.length, `${section} keys are pairwise disjoint`);
          assert.deepEqual([...union].sort(), (total?.items ?? []).map((i) => i.callKey).sort(), `${section} union equals the total key`);
          checked += rows.length;
        }
        assert.ok(checked > 0, 'rows exist to partition');
      } finally { ctx.cleanup(); }
    });
  }

  it('loader: the main total key lists exactly the calls counted by the counts line', async () => {
    const ctx = await shapeHome();
    try {
      await prepare(ctx.home);
      const { loadCostReport } = await mod('report/cost.mjs');
      const report = loadCostReport({ home: ctx.home, by: ['role'], now: () => new Date(DST_NOW) });
      const e = await ev(ctx.home, 'main/total');
      assert.equal(e?.calls, report?.counts?.calls);
    } finally { ctx.cleanup(); }
  });

  it('loader: a role key lists exact matches only, never a prefix or a case variant', async () => {
    const ctx = makeHome();
    try {
      const db = openTempStore({ home: ctx.home });
      const base = { session_id: 'sess-v', model: 'claude-haiku-5-5', input_tokens: 1, output_tokens: 1, cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0, ts_utc: '2026-11-01T10:00:00.000Z' };
      insertMessage(db, { ...base, agent_id: 'agentv1', message_id: 'msg_v1', attribution_agent: 'Explore' });
      insertMessage(db, { ...base, agent_id: 'agentv2', message_id: 'msg_v2', attribution_agent: 'explore' });
      insertMessage(db, { ...base, agent_id: 'agentv3', message_id: 'msg_v3', attribution_agent: 'Explore2' });
      insertMessage(db, { ...base, agent_id: '', message_id: 'msg_v4' });
      db.close();
      const upper = await ev(ctx.home, 'main/role=Explore');
      const lower = await ev(ctx.home, 'main/role=explore');
      assert.deepEqual(lettersOf(upper), ['msg_v1']);
      assert.deepEqual(lettersOf(lower), ['msg_v2']);
      assert.deepEqual(lettersOf(await ev(ctx.home, 'main/role=main')), ['msg_v4']);
    } finally { ctx.cleanup(); }
  });

  it('loader: a transcript call read from two roots lists both files by root alias then relative path', async () => {
    const ctx = await shapeHome(['subagents', 'backup-root']);
    try {
      const e = await ev(ctx.home, 'main/total', { limit: LIMIT_ALL });
      const call = (e?.items ?? []).find((i) => i.messageId === 'msg_m31' && i.sessionId === '33333333-3333-4333-8333-333333333333');
      assert.ok(call, 'the shared call is listed');
      // Case 20 holds the session in root claude; case 40 holds it and a copy under session 5555... in root claude-contrib.
      assert.deepEqual((call?.files ?? []).map((f) => f.root), ['claude', 'claude-contrib', 'claude-contrib']);
      assert.deepEqual((call?.files ?? []).slice(1).map((f) => f.path), [
        '~-repos-agents/33333333-3333-4333-8333-333333333333.jsonl', '~-repos-agents/55555555-5555-4555-8555-555555555555.jsonl',
      ]);
      assert.ok((call?.files ?? []).every((f) => f.offset === null && !f.path.startsWith('/')));
    } finally { ctx.cleanup(); }
  });

  it('loader: an otel call lists its live root file with the stored byte offset', async () => {
    const ctx = await shapeHome(['otel-join'], FIXTURE_NOW);
    try {
      const e = await ev(ctx.home, 'otel/total', { limit: LIMIT_ALL });
      assert.ok((e?.items ?? []).length > 0, 'otel calls listed');
      for (const i of e.items) {
        assert.ok(i.files.length >= 1, 'every otel call names a file');
        assert.ok(i.files.every((f) => f.root === 'live' && Number.isSafeInteger(f.offset) && f.offset > 0));
      }
    } finally { ctx.cleanup(); }
  });

  it('loader: the otel call without a request id is found by session, sequence and time', async () => {
    const ctx = await shapeHome(['otel-join'], FIXTURE_NOW);
    try {
      const e = await ev(ctx.home, 'otel/total', { limit: LIMIT_ALL });
      const o8 = (e?.items ?? []).find((i) => i.callKey === `o:${O8_KEY}`);
      assert.ok(o8, 'O8 is listed');
      assert.equal(o8?.requestId ?? null, null);
      assert.equal((o8?.files ?? []).length, 1);
    } finally { ctx.cleanup(); }
  });
});

describe('cli', () => {
  let ctx;
  before(async () => { ctx = await shapeHome(); await prepare(ctx.home); });
  after(() => ctx.cleanup());

  it('cli: malformed keys exit 2 with one stderr line and create no state', () => {
    assert.equal(cli(ctx.home, ['evidence', 'main/total']).status, 0, 'a valid key exits 0 (positive control)');
    for (const key of BAD_KEYS.filter((k) => k !== '' && !k.startsWith('-'))) {
      const fresh = makeHome();
      try {
        const r = cli(fresh.home, ['evidence', key]);
        assert.equal(r.status, 2, 'exit status of a malformed key');
        assert.equal(r.stderr.trim().split('\n').length, 1);
        assert.equal(existsSync(stateDirOf(fresh.home)), false);
      } finally { fresh.cleanup(); }
    }
  });

  it('cli: no row key or two row keys exit 2', () => {
    assert.equal(cli(ctx.home, ['evidence', 'main/total']).status, 0, 'one row key exits 0 (positive control)');
    assert.equal(cli(ctx.home, ['evidence']).status, 2);
    assert.equal(cli(ctx.home, ['evidence', 'main/total', 'main/total']).status, 2);
  });

  it('cli: the listing prints the freshness block, the period, the row, the summary line and the call lines', () => {
    const r = cli(ctx.home, ['evidence', ER.evidence.highDay1LA.key, '--tz', LA]);
    assert.equal(r.status, 0);
    const lines = r.stdout.split('\n');
    assert.match(lines[0], /^freshness: (OK|STALE) as of 2026-11-03T12:00:00.000Z \(clock fixed by RIGORSCOPE_NOW\)$/);
    const at = lines.findIndex((l) => l.startsWith('period: '));
    assert.ok(at > 0);
    assert.equal(lines[at + 1], `evidence: row ${ER.evidence.highDay1LA.key}`);
    assert.equal(lines[at + 2], 'calls=2 sessions=2 listed=2 (ordered by record time, then call id; transcript evidence names the file and message id, no line locator is stored; otel evidence adds the stored byte offset)');
    assert.equal(lines[at + 3], 'call m:msg_rs_b');
  });

  for (const [name, tz, since, until, want] of [
    ['Los_Angeles', LA, '2026-11-01', '2026-11-01', ['B', 'C', 'D', 'E']], ['UTC', 'UTC', '2026-11-01', '2026-11-01', ['A', 'B', 'C', 'D']],
  ]) {
    it(`cli: evidence main/total --since ${since} --until ${until} in ${name} lists calls ${want.join(', ')}`, () => {
      const r = cli(ctx.home, ['evidence', 'main/total', '--since', since, '--until', until, '--tz', tz]);
      assert.equal(r.status, 0);
      const calls = r.stdout.split('\n').filter((l) => l.startsWith('call ')).map((l) => l.slice(5));
      assert.deepEqual(calls, want.map((l) => `m:${MSG[l]}`));
    });
  }

  it('cli: --limit 1 lists one call and states listed=1 with calls unchanged', () => {
    const r = cli(ctx.home, ['evidence', 'main/total', '--limit', '1']);
    assert.match(r.stdout, /^calls=6 sessions=4 listed=1 /m);
    assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('call ')).length, 1);
  });

  it('cli: --limit 100000 is accepted and the default lists every call of a small row', () => {
    assert.equal(cli(ctx.home, ['evidence', 'main/total', '--limit', '100000']).status, 0);
    assert.match(cli(ctx.home, ['evidence', 'main/total']).stdout, /^calls=6 sessions=4 listed=6 /m);
  });

  it('cli: limits 0, 100001, -1, 1.5, a padded and an exponent value exit 2', () => {
    assert.equal(cli(ctx.home, ['evidence', 'main/total', '--limit', '2']).status, 0, 'a valid limit exits 0 (positive control)');
    for (const v of ['0', '100001', '-1', '1.5', ' 2', '1e3', '', '+3', '0x10']) {
      assert.equal(cli(ctx.home, ['evidence', 'main/total', '--limit', v]).status, 2, `limit ${JSON.stringify(v)}`);
    }
  });

  it('cli: a valid key with no calls prints calls=0 sessions=0 listed=0 and no file lines', () => {
    const r = cli(ctx.home, ['evidence', 'harness/total']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^calls=0 sessions=0 listed=0 /m);
    assert.equal(/^\s+file /m.test(r.stdout), false);
  });

  it('cli: an empty store prints the freshness block and zero counts and exits 0', () => {
    const fresh = makeHome();
    try {
      const r = cli(fresh.home, ['evidence', 'main/total']);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^freshness: no ingest recorded$/m);
      assert.match(r.stdout, /^calls=0 sessions=0 listed=0 /m);
    } finally { fresh.cleanup(); }
  });

  it('cli: --json prints one document with the evidence schema and its key set', () => {
    const r = cli(ctx.home, ['evidence', 'main/total', '--json', '--limit', '2']);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    let doc = null;
    try { doc = JSON.parse(r.stdout); } catch { doc = null; }
    assert.deepEqual(Object.keys(doc ?? {}), ['schema', 'as_of_utc', 'clock_fixed', 'freshness', 'period', 'row_key', 'section', 'dims', 'calls', 'sessions', 'listed', 'items']);
    assert.equal(doc?.schema, 'rigorscope.evidence/1');
    assert.deepEqual([doc?.calls, doc?.sessions, doc?.listed, doc?.items?.length], [6, 4, 2, 2]);
    assert.deepEqual(Object.keys(doc?.items?.[0] ?? {}), ['call_key', 'session_id', 'agent_id', 'message_id', 'request_id', 'ts_utc', 'occurrences', 'files']);
    assert.deepEqual(Object.keys(doc?.items?.[0]?.files?.[0] ?? {}), ['root', 'path', 'offset']);
  });

  it('cli: the output of the same command printed twice is byte-identical and never holds an absolute path', () => {
    const a = cli(ctx.home, ['evidence', 'main/total']);
    const b = cli(ctx.home, ['evidence', 'main/total']);
    assert.equal(a.status, 0);
    assert.equal(a.stdout, b.stdout);
    assert.equal(/\/(home|Users|mnt)\//.test(a.stdout), false);
    assert.equal(a.stdout.includes(PLANTS.osUser), false);
  });

  it('cli: two parallel evidence runs print identical stdout and leave derived.db unchanged', async () => {
    cli(ctx.home, ['evidence', 'main/total']);
    const before = sha256File(derivedPath(ctx.home));
    const env = cliEnv(ctx.home, { RIGORSCOPE_NOW: DST_NOW });
    const [a, b] = await Promise.all([runCliAsync(['evidence', 'main/total'], { home: ctx.home, env }), runCliAsync(['evidence', 'main/total'], { home: ctx.home, env })]);
    assert.equal(a.status, 0);
    assert.equal(a.stdout, b.stdout);
    assert.equal(sha256File(derivedPath(ctx.home)), before);
  });

  it('cli: with an ingest transaction open on store.db evidence still exits 0 with the committed state', () => {
    const w = openStore({ home: ctx.home });
    w.exec('BEGIN IMMEDIATE');
    w.prepare("INSERT INTO ingest_run (started_utc, trigger) VALUES ('2026-11-03T11:59:00.000Z', 'test')").run();
    try {
      const r = cli(ctx.home, ['evidence', 'main/total']);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^calls=6 sessions=4 listed=6 /m);
    } finally { w.exec('ROLLBACK'); w.close(); }
  });

  it('cli: evidence does not write to either database', () => {
    const store = sha256File(join(stateDirOf(ctx.home), 'store.db'));
    const derived = sha256File(derivedPath(ctx.home));
    assert.equal(cli(ctx.home, ['evidence', 'main/total']).status, 0, 'the command exists and exits 0');
    assert.equal(sha256File(join(stateDirOf(ctx.home), 'store.db')), store);
    assert.equal(sha256File(derivedPath(ctx.home)), derived);
  });

  it('cli: cost --evidence for a row lists the same calls as evidence for its key', () => {
    const viaCost = cli(ctx.home, ['cost', '--by', 'session', '--tz', 'UTC', '--evidence', '--limit', '5']).stdout;
    const direct = cli(ctx.home, ['evidence', `main/session=${S1}`, '--tz', 'UTC', '--limit', '5']).stdout;
    const calls = (t) => t.split('\n').filter((l) => l.startsWith('call ')).length;
    assert.ok(calls(viaCost) >= calls(direct));
    assert.equal(calls(direct), 2);
  });

  it('cli: the evidence text and docs state the honest limit that transcript lines have no line locator', () => {
    assert.match(cli(ctx.home, ['evidence', 'main/total']).stdout, /no line locator is stored/);
  });
});
