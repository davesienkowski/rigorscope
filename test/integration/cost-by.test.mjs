// Plan 01-04 contract: `rigorscope cost --by role,model` over the derivation core. Written before the
// code (RED). Every expected row and footer line is hand-computed in the case modules
// (test/fixtures/cases/70-derive-dups.mjs, 80-derive-roles-iter.mjs) or below, never by the code under test.
//
// Assumed shapes (Task 3 implements them):
//   cost [--by role|model[,role|model]]   exit 0 whatever the numbers; a bad --by exits 2 before any state
//   output: freshness, period, header, rows, labels, then the footer lines conservation, counts, totals
//   ensureDerived({ home, ownerRule, force }) -> { rebuilt, reason }; loadCostReport({ home, by }); parseBy(text)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXPECTED_COST_ROWS, LABELS_LINE, buildFixtureTree, cliEnv, isDataRow, makeHome, runCli, runCliAsync, stateDirOf,
} from '../fixtures/build.mjs';
import { buildRowKey } from '../../src/measure/rowkey.mjs';
import { TIER_EXPECTED, TIER_SPEC, TIER_TIMES, buildTierHome } from '../fixtures/tier-home.mjs';
import { UNITS_EXPECTED, buildUnitsHome } from '../fixtures/units-home.mjs';
import { insertMessage, openTempStore } from '../fixtures/derive-rows.mjs';
import * as dups from '../fixtures/cases/70-derive-dups.mjs';
import * as roles from '../fixtures/cases/80-derive-roles-iter.mjs';
import { Db, derivedPath } from '../../src/db.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);

// Plan 01-06: the window_share column became window_5h and window_7d.
const NUM_HEADER = ['calls', 'input', 'output', 'cache_read', 'cache_write', 'notional_usd', 'window_5h', 'window_7d'];
const CONSERVATION_OK = 'conservation: OK (role sums = model sums = part total = store total for each of the 6 token classes)';
// Plan 01-05: the notional_usd cell holds the hand-computed dollars (test/integration/cost-price.test.mjs
// shows the arithmetic); '?' where a part stays unpriced. window_share stays '?' until plan 01-06.
const withPrices = (rows, cells = rows.map(() => '?')) => rows.map((r, i) => [...r, cells[i], '?', '?']);
const LABELS_DERIVED = LABELS_LINE.replace('notional_usd=unavailable', 'notional_usd=derived');
// Plan 01-05 adds two footer lines after totals: pricing (asserted in full in cost-price.test.mjs) and notional.
function assertFooter(o, three, notional) {
  assert.deepEqual(o.footer.slice(0, 3), three);
  assert.match(o.footer[3], /^pricing: table=prices-\d{4}-\d{2}-\d{2}\.json /);
  assert.equal(o.footer[4], notional);
  // Plan 01-06: the window footer line; these cases record no usage snapshot.
  assert.match(o.footer[5], /^window: weights=input:1,output:1,cache_read:1,cache_creation:1 snapshots=0 intervals_5h=none intervals_7d=none parts_5h=0\/\d+ parts_7d=0\/\d+ window_conservation=OK$/);
  // Plan 01-07: the join: (short form, no OTel stored) and roles: lines.
  assert.match(o.footer[6], /^join: otel_requests=0 transcript_calls=\d+$/);
  assert.match(o.footer[7], /^roles: harness=0 attribution=\d+ meta=\d+ transcript_main=\d+ /);
  assert.equal(o.footer.length, 8);
}
const DOLLARS = {
  iter: ['?', '0.001650', '>=0.000131'],
  iterNotional: 'notional: usd>=0.001781(1 unknown, 1 floor) label=derived',
  dups: ['0.000466', '0.000012', '0.000260'],
  dupsNotional: 'notional: usd=0.000738 label=derived',
  roles: ['0.000008', '0.000602', '0.000920', '?', '0.000003', '0.002961', '0.000248', '?', '0.000314'],
  rolesByRole: ['0.000008', '0.000602', '0.000920', '?', '0.000314'],
  rolesByModel: ['?', '0.000011', '0.003881', '0.001164', '?'],
  rolesNotional: 'notional: usd>=0.005056(2 unknown) label=derived',
  tracer: ['?', '0.000001', '>=0.000037', '>=0.006280', '?'],
  tracerNotional: 'notional: usd>=0.006432(3 unknown, 3 floor) label=derived',
};

// The 01-02 `iterations` case: msg_m41 (opus, advisor iteration on fable) and msg_m42 (sonnet, no iterations).
const ITER = {
  rows: [
    ['main', 'claude-fable-5-0', '1', '30', '20', '0', '0'],
    ['main', 'claude-opus-5-5', '1', '100', '40', '1000', '50'],
    ['main', 'claude-sonnet-5-5', '1', '9', '9', '9', '9'],
  ],
  counts: 'counts: calls=2 parts=3 duplicates_collapsed=0 synthetic_skipped=0 top_level_only=1 iteration_mismatch=0 unknown_iteration_type=0',
  totals: 'totals: input=139 output=69 cache_read=1009 cache_write=59 cache_5m=59 cache_1h=0',
};

// Case 10 (01-01 tracer tree): M4 has no cache_creation and only M1 carries the 5m/1h split.
const TRACER_TOTALS = 'totals: input=212 output=116 cache_read=6607 cache_write>=438(1 unknown) cache_5m>=200(7 unknown) cache_1h>=100(7 unknown)';

// Splits `cost` stdout. The header is the third line whatever the leading dimension is.
function costOut(stdout) {
  const lines = stdout.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const labelsAt = lines.findIndex((l) => l.startsWith('labels:'));
  // Plan 01-08: the freshness block has several lines, so the period line is found by its prefix; the table follows it.
  const p0 = lines.findIndex((l) => l.startsWith('period:'));
  const hasTable = p0 >= 0 && lines.length > p0 + 1 && lines[p0 + 1] !== 'no rows';
  // Plan 01-06: a window usage line sits between period and the table header when rows exist.
  const w = hasTable && lines[p0 + 1].startsWith('window usage:') ? 1 : 0;
  // Plan 01-08: the scope: line (printed under the default period) is asserted in cost-cli.test.mjs, not in these footer lists.
  const footer = labelsAt >= 0 ? lines.slice(labelsAt + 1).filter((l) => !l.startsWith('scope:')) : [];
  return {
    lines,
    windowUsage: w ? lines[p0 + 1] : null,
    header: hasTable ? lines[p0 + 1 + w].trim().split(/\s+/) : null,
    rows: hasTable ? lines.slice(p0 + 2 + w, labelsAt >= 0 ? labelsAt : undefined).filter(isDataRow).map((l) => l.trim().split(/\s+/)) : [],
    labels: labelsAt >= 0 ? lines[labelsAt] : null,
    footer,
  };
}

async function ingested(cases) {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases });
  const r = runCli(['ingest'], { home: ctx.home });
  assert.equal(r.status, 0, 'ingest exit status');
  return ctx;
}

function cost(ctx, by) {
  return runCli(by === undefined ? ['cost'] : ['cost', '--by', by], { home: ctx.home });
}

describe('tracer: advisor iteration path', () => {
  it('tracer: cost --by role,model prints the advisor part on the advisor model and the conservation line', async () => {
    const ctx = await ingested(['iterations']);
    try {
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0, 'cost --by role,model exit status');
      const o = costOut(r.stdout);
      // Plan 01-08: the freshness block (a verdict line and one line per source) replaced the one-line freshness, and
      // the default period names its 7-day window (the clock is fixed to 2026-10-28T12:00:00Z by cliEnv).
      assert.match(o.lines[0], /^freshness: (OK|STALE) as of /, 'freshness block first');
      assert.ok(o.lines.some((l) => l.includes('transcript') && l.includes('newest record ')), 'the transcript source line');
      assert.ok(o.lines.includes('period: last 7 days, from 2026-10-21T12:00:00.000Z (default), tz=UTC, calls_ts_unknown=0'));
      assert.deepEqual(o.header, ['role', 'model', ...NUM_HEADER]);
      assert.deepEqual(o.rows, withPrices(ITER.rows, DOLLARS.iter), 'advisor tokens on claude-fable-5-0, never on the call model');
      assert.equal(o.labels, LABELS_DERIVED);
      assertFooter(o, [CONSERVATION_OK, ITER.counts, ITER.totals], DOLLARS.iterNotional);
      assert.equal(o.windowUsage, 'window usage: none recorded');
      // Plan 01-08: the freshness block (a verdict line and three source lines), period, window usage, header, three rows,
      // the =total row, the totals check, labels, scope and eight footer lines. Plan 03-03: the ledger source adds a freshness line.
      assert.equal(o.lines.length, 23, 'freshness block (a verdict line and four source lines), period, window usage, header, three rows, total, totals check, labels, scope and eight footer lines');
    } finally {
      ctx.cleanup();
    }
  });

  it('tracer: cost with no --by prints the same table and footer as --by role,model', async () => {
    const ctx = await ingested(['iterations']);
    try {
      const a = cost(ctx, 'role,model');
      const b = cost(ctx);
      assert.equal(a.status, 0);
      assert.equal(b.status, 0);
      assert.equal(b.stdout, a.stdout);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('dedup: case derive-dups', () => {
  it('collapses duplicate occurrences into one call each and skips the synthetic line', async () => {
    const ctx = await ingested(['derive-dups']);
    try {
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      const o = costOut(r.stdout);
      assert.deepEqual(o.rows, withPrices(dups.expectedDerived.rows, DOLLARS.dups));
      assertFooter(o, [CONSERVATION_OK, dups.expectedDerived.counts, dups.expectedDerived.totalsLine], DOLLARS.dupsNotional);
    } finally {
      ctx.cleanup();
    }
  });

  it('under the reversed owner rule the fork pair call takes role fork and every total is unchanged', async () => {
    const ctx = await ingested(['derive-dups']);
    try {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      const res = ensureDerived({ home: ctx.home, ownerRule: 'latest', force: true });
      assert.equal(res.rebuilt, true, 'a forced ensureDerived rebuilds');
      const { loadCostReport } = await mod('report/cost.mjs');
      const { renderCostText } = await mod('report/render-text.mjs');
      const o = costOut(renderCostText(loadCostReport({ home: ctx.home, by: ['role', 'model'] })));
      assert.deepEqual(o.rows, withPrices(dups.expectedDerived.rowsLatest, DOLLARS.dups));
      assert.equal(o.footer[0], CONSERVATION_OK);
      assert.equal(o.footer[2], dups.expectedDerived.totalsLine, 'the owner choice never changes a total');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('roles and iterations: case derive-roles-iter', () => {
  it('--by role,model prints nine rows with the NULL-model row last within main', async () => {
    const ctx = await ingested(['derive-roles-iter']);
    try {
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      assert.deepEqual(costOut(r.stdout).rows, withPrices(roles.expectedDerived.rows, DOLLARS.roles));
    } finally {
      ctx.cleanup();
    }
  });

  it('--by role prints five rows with distinct calls per role', async () => {
    const ctx = await ingested(['derive-roles-iter']);
    try {
      const r = cost(ctx, 'role');
      assert.equal(r.status, 0);
      const o = costOut(r.stdout);
      assert.deepEqual(o.header, ['role', ...NUM_HEADER]);
      assert.deepEqual(o.rows, withPrices(roles.expectedDerived.rowsByRole, DOLLARS.rolesByRole));
    } finally {
      ctx.cleanup();
    }
  });

  it('--by model prints five rows with the NULL model last', async () => {
    const ctx = await ingested(['derive-roles-iter']);
    try {
      const r = cost(ctx, 'model');
      assert.equal(r.status, 0);
      const o = costOut(r.stdout);
      assert.deepEqual(o.header, ['model', ...NUM_HEADER]);
      assert.deepEqual(o.rows, withPrices(roles.expectedDerived.rowsByModel, DOLLARS.rolesByModel));
    } finally {
      ctx.cleanup();
    }
  });

  it('prints the counts and totals lines with the mismatch and unknown-type counters', async () => {
    const ctx = await ingested(['derive-roles-iter']);
    try {
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      assertFooter(costOut(r.stdout), [CONSERVATION_OK, roles.expectedDerived.counts, roles.expectedDerived.totalsLine], DOLLARS.rolesNotional);
    } finally {
      ctx.cleanup();
    }
  });

  it('--by model,role puts the model column first and orders by model, then role', async () => {
    const ctx = await ingested(['derive-roles-iter']);
    try {
      const r = cost(ctx, 'model,role');
      assert.equal(r.status, 0);
      const o = costOut(r.stdout);
      assert.deepEqual(o.header, ['model', 'role', ...NUM_HEADER]);
      assert.deepEqual(o.rows.map((x) => [x[0], x[1]]), [
        ['claude-fable-5-0', 'main'],
        ['claude-haiku-5-5', 'Explore'],
        ['claude-haiku-5-5', 'main'],
        ['claude-opus-5-5', 'gsd-verifier'],
        ['claude-opus-5-5', 'main'],
        ['claude-sonnet-5-5', 'fork'],
        ['claude-sonnet-5-5', 'main'],
        ['claude-sonnet-5-5', 'unknown'],
        ['?', 'main'],
      ]);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('tracer group: case 10 unchanged', () => {
  it('keeps the five hand-computed 01-01 rows and prints the totals with the unknown notation', async () => {
    const ctx = await ingested(['tracer-base']);
    try {
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      const o = costOut(r.stdout);
      assert.deepEqual(o.rows, withPrices(EXPECTED_COST_ROWS, DOLLARS.tracer));
      assert.equal(o.rows[0][6], '?', 'the gsd-executor cache_write stays unknown');
      assertFooter(o, [
        CONSERVATION_OK,
        'counts: calls=8 parts=8 duplicates_collapsed=0 synthetic_skipped=0 top_level_only=8 iteration_mismatch=0 unknown_iteration_type=0',
        TRACER_TOTALS,
      ], DOLLARS.tracerNotional);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('--by validation', () => {
  // Plan 01-08: day became a valid dimension; 'days' stays unknown.
  const bad = ['', 'role,role', 'days', 'role, model', 'role;DROP TABLE api_call'];
  for (const value of bad) {
    it(`--by ${JSON.stringify(value)} exits 2 and creates nothing under a fresh HOME`, () => {
      const ctx = makeHome();
      try {
        const r = runCli(['cost', '--by', value], { home: ctx.home });
        assert.equal(r.status, 2, 'usage error');
        assert.equal(r.stdout, '');
        assert.ok(!r.stderr.includes('DROP'), 'the message does not echo the input');
        assert.equal(existsSync(stateDirOf(ctx.home)), false, 'no state directory');
      } finally {
        ctx.cleanup();
      }
    });
  }

  it('parseBy keeps order, rejects unknown, duplicate and padded names with a fixed message', async () => {
    const m = await mod('report/cost.mjs');
    assert.equal(typeof m.parseBy, 'function', 'parseBy is exported');
    assert.deepEqual(m.parseBy('model,role'), ['model', 'role']);
    assert.deepEqual(m.DEFAULT_BY, ['role', 'model']);
    const messages = new Set();
    for (const v of ['', 'role,', ' role', 'role,role', 'Role', 'x;y']) {
      assert.throws(() => m.parseBy(v), (err) => { messages.add(err.message); return err instanceof RangeError; });
    }
    assert.equal(messages.size, 1, 'one fixed message, never the input');
    assert.ok(Object.isFrozen(m.BY_DIMENSIONS));
    // Plan 01-08 added effort, day, session and repo to the whitelist; plan 02-08 added tier, unit, framework and runtime.
    assert.deepEqual(Object.keys(m.BY_DIMENSIONS).sort(), ['day', 'effort', 'framework', 'model', 'population', 'repo', 'role', 'runtime', 'session', 'tier', 'unit']);
  });
});

describe('trust edges', () => {
  it('on a HOME with no ingest prints the freshness line and no rows, with no footer line', () => {
    const ctx = makeHome();
    try {
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      assert.equal(r.stdout, 'freshness: no ingest recorded\nperiod: last 7 days, from 2026-10-21T12:00:00.000Z (default), tz=UTC, calls_ts_unknown=0\nno rows\n');
    } finally {
      ctx.cleanup();
    }
  });

  // Direct rows: msg_a output 0 on model-zero-out; msg_b output NULL and msg_c output 5 on model-null-out.
  function directStore(ctx) {
    const db = openTempStore({ home: ctx.home });
    try {
      const base = { session_id: 'sess-direct', agent_id: '', cache_read: 0, cache_creation: 0 };
      insertMessage(db, { ...base, message_id: 'msg_a', model: 'model-zero-out', input_tokens: 1, output_tokens: 0, ts_utc: '2026-10-27T16:00:01.000Z' });
      insertMessage(db, { ...base, message_id: 'msg_b', model: 'model-null-out', input_tokens: 2, output_tokens: null, ts_utc: '2026-10-27T16:00:02.000Z' });
      insertMessage(db, { ...base, message_id: 'msg_c', model: 'model-null-out', input_tokens: 3, output_tokens: 5, ts_utc: '2026-10-27T16:00:03.000Z' });
    } finally {
      db.close();
    }
  }

  it('a zero renders 0, a NULL renders ?, and a group with one NULL member renders ? (never its known sum)', () => {
    const ctx = makeHome();
    try {
      directStore(ctx);
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      const o = costOut(r.stdout);
      assert.deepEqual(o.rows, withPrices([
        ['main', 'model-null-out', '2', '5', '?', '0', '0'],
        ['main', 'model-zero-out', '1', '1', '0', '0', '0'],
      ]));
    } finally {
      ctx.cleanup();
    }
  });

  it('the totals line prints >=VALUE(N unknown) for a partly known class and ?(N unknown) for an unknown one', () => {
    const ctx = makeHome();
    try {
      directStore(ctx);
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      assert.equal(costOut(r.stdout).footer[2],
        'totals: input=6 output>=5(1 unknown) cache_read=0 cache_write=0 cache_5m=?(3 unknown) cache_1h=?(3 unknown)');
    } finally {
      ctx.cleanup();
    }
  });

  it('groups roles byte-exactly and case-sensitively: Explore and explore are two rows', () => {
    const ctx = makeHome();
    try {
      const db = openTempStore({ home: ctx.home });
      try {
        // Plan 01-08: a call needs a record time inside the default 7-day window to appear in the report.
        const base = { session_id: 'sess-case', model: 'claude-haiku-5-5', input_tokens: 1, output_tokens: 1, cache_read: 1, cache_creation: 1, ts_utc: '2026-10-27T12:00:00.000Z' };
        insertMessage(db, { ...base, agent_id: 'agent-up', message_id: 'msg_up', attribution_agent: 'Explore' });
        insertMessage(db, { ...base, agent_id: 'agent-low', message_id: 'msg_low', attribution_agent: 'explore' });
      } finally {
        db.close();
      }
      const r = cost(ctx, 'role');
      assert.equal(r.status, 0);
      // claude-haiku-5-5, 1 token per class, no 5m/1h split: 1x100 + 1x500 + 1x10 + 1x125 (5m rate) = 735, a floor
      assert.deepEqual(costOut(r.stdout).rows, withPrices([
        ['Explore', '1', '1', '1', '1', '1'],
        ['explore', '1', '1', '1', '1', '1'],
      ], ['>=0.000001', '>=0.000001']));
    } finally {
      ctx.cleanup();
    }
  });

  it('a tampered derived part prints conservation: VIOLATED and the exit status stays 0', async () => {
    const ctx = await ingested(['iterations']);
    try {
      const first = cost(ctx, 'role,model');
      assert.equal(first.status, 0);
      assert.equal(costOut(first.stdout).footer[0], CONSERVATION_OK);
      const db = new Db(derivedPath(ctx.home));
      try {
        db.exec("UPDATE api_call_part SET output_tokens = output_tokens + 1 WHERE kind = 'advisor'");
      } finally {
        db.close();
      }
      const second = cost(ctx, 'role,model');
      assert.equal(second.status, 0, 'never a non-zero exit for a bad-looking number');
      assert.match(costOut(second.stdout).footer[0], /^conservation: VIOLATED output\(/);
    } finally {
      ctx.cleanup();
    }
  });

  it('two cost processes started together both exit 0 with identical stdout', async () => {
    const ctx = await ingested(['derive-roles-iter']);
    try {
      const [a, b] = await Promise.all([
        runCliAsync(['cost', '--by', 'role,model'], { home: ctx.home }),
        runCliAsync(['cost', '--by', 'role,model'], { home: ctx.home }),
      ]);
      assert.equal(a.status, 0, 'first child');
      assert.equal(b.status, 0, 'second child');
      assert.equal(a.stdout, b.stdout);
      assert.deepEqual(costOut(a.stdout).rows, withPrices(roles.expectedDerived.rows, DOLLARS.roles));
    } finally {
      ctx.cleanup();
    }
  });

  it('a second cost on unchanged inputs does not rewrite derived.db', async () => {
    const ctx = await ingested(['iterations']);
    try {
      const { sha256File } = await import('../fixtures/build.mjs');
      assert.equal(cost(ctx, 'role,model').status, 0);
      const p = join(stateDirOf(ctx.home), 'derived.db');
      const before = sha256File(p);
      const a = cost(ctx, 'role,model');
      assert.equal(sha256File(p), before, 'derived.db byte-identical');
      assertFooter(costOut(a.stdout), [CONSERVATION_OK, ITER.counts, ITER.totals], DOLLARS.iterNotional);
    } finally {
      ctx.cleanup();
    }
  });
});

// ---- Plan 02-08 Task 3 (RPT-01, D-19, D-02, TIER-02): the cost dimensions tier, unit, framework and runtime, the six filters and
// filtered evidence, on the tier fixture and on the same-name units home. Every run spawns the CLI on a temporary HOME.
const E = TIER_EXPECTED;
const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const tierEnv = (home) => cliEnv(home, { TZ: 'UTC', RIGORSCOPE_NOW: TIER_TIMES.now });
const OCT = ['--since', '2026-10-01', '--until', '2026-11-01'];
const costTier = (home, args) => runCli(['cost', ...OCT, ...args], { home, env: tierEnv(home) });
const costJson = (home, args) => {
  const r = costTier(home, [...args, '--json']);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const mainRows = (doc) => doc.sections.main.rows;
const callsBy = (rows, dim) => Object.fromEntries(rows.map((r) => [r.dims[dim].value ?? '?', r.calls]));
const costed = TIER_SPEC.filter((s) => s.costed);
const callsOfTier = (pred) => 2 * costed.filter(pred).length;

describe('cost --by tier, unit, framework and runtime on the tier home (02-08 Task 3)', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildTierHome({ home: ctx.home, root: ctx.root, otelOnly: true });
    assert.equal(runCli(['ingest'], { home: ctx.home, env: tierEnv(ctx.home) }).status, 0);
  });
  after(() => ctx.cleanup());

  it('--by tier: A, B, B-inferred, C, ? and the two bucket rows with the fixture calls, and the totals check reads main OK', () => {
    const doc = costJson(ctx.home, ['--by', 'tier']);
    assert.deepEqual(callsBy(mainRows(doc), 'tier'), {
      A: callsOfTier((s) => s.tier === 'A'),
      B: callsOfTier((s) => s.tier === 'B' && !s.probes),
      'B-inferred': callsOfTier((s) => s.probes),
      C: callsOfTier((s) => s.tier === 'C'),
      '?': callsOfTier((s) => s.tier === null && !s.probes),
      '(unattributed_overlap)': E.tokens.overlap.length + E.tokens.low.length,
      '(unlinked)': E.tokens.none.length,
    });
    const t = costTier(ctx.home, ['--by', 'tier']);
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /^totals check: main OK/m);
  });

  it('--by tier labels: main rows reconstructed, the by-labels line names the four new dimensions and the strict mode', () => {
    const t = costTier(ctx.home, ['--by', 'tier,unit,framework,runtime']);
    assert.equal(t.status, 0, t.stderr);
    const line = linesOf(t.stdout).find((l) => l.startsWith('by-labels: '));
    assert.ok(line.startsWith('by-labels: population=derived tier=derived unit=derived framework=derived runtime=reconstructed'), line);
    assert.ok(line.includes('tier, unit and framework follow link_confidence=medium'));
  });

  it('--by unit: one row per attributed unit with its calls, plus the two bucket rows', () => {
    const rows = mainRows(costJson(ctx.home, ['--by', 'unit']));
    const by = callsBy(rows, 'unit');
    assert.equal(rows.length, costed.length + 2);
    for (const s of costed) assert.equal(by[E.keyOf(s.id)], 2, s.id);
    assert.equal(by['(unattributed_overlap)'], E.tokens.overlap.length + E.tokens.low.length);
    assert.equal(by['(unlinked)'], E.tokens.none.length);
  });

  it('--by framework and --by runtime', () => {
    const fw = callsBy(mainRows(costJson(ctx.home, ['--by', 'framework'])), 'framework');
    assert.equal(fw['gsd-core'], costed.length * 2);
    const rt = mainRows(costJson(ctx.home, ['--by', 'runtime']));
    assert.equal(rt.length, 1);
    assert.equal(rt[0].dims.runtime.value, 'claude-code');
    assert.equal(rt[0].dims.runtime.label, 'reconstructed');
    assert.equal(rt[0].calls, costed.length * 2 + E.tokens.overlap.length + E.tokens.low.length + E.tokens.none.length);
  });

  it('--by tier,model keeps the totals check OK', () => {
    const t = costTier(ctx.home, ['--by', 'tier,model']);
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /^totals check: main OK/m);
  });

  it('an otel-only call in the session of an attributed scope prints in the otel-only section with ? for tier, unit and framework', () => {
    const doc = costJson(ctx.home, ['--by', 'tier,unit,framework']);
    const rows = doc.sections.otel.rows;
    assert.equal(rows.length, 1);
    for (const d of ['tier', 'unit', 'framework']) {
      assert.equal(rows[0].dims[d].value, null, d);
      assert.equal(rows[0].dims[d].label, 'unavailable', d);
    }
  });

  it('--tier A keeps only calls attributed to a tier A unit; otel-only rows are empty under it and the totals check is OK', () => {
    const doc = costJson(ctx.home, ['--by', 'tier', '--tier', 'A']);
    assert.deepEqual(callsBy(mainRows(doc), 'tier'), { A: callsOfTier((s) => s.tier === 'A') });
    assert.equal(doc.sections.otel.rows.length, 0);
    const t = costTier(ctx.home, ['--by', 'tier', '--tier', 'A']);
    assert.match(t.stdout, /^totals check: main OK/m);
    const scope = linesOf(t.stdout).find((l) => l.startsWith('scope: '));
    assert.ok(scope.includes('unit_filters=tier=A call_filters=none'), scope);
    assert.ok(scope.includes('tier and framework filters keep only attributed main-section calls'));
  });

  it('--model, --repo, --runtime and --role select calls', () => {
    const total = (args) => mainRows(costJson(ctx.home, ['--by', 'runtime', ...args])).reduce((n, r) => n + r.calls, 0);
    const all = total([]);
    assert.equal(total(['--model', E.models.m2]), 2);
    assert.equal(total(['--repo', E.repoName]), all - E.tokens.none.length, 'the plain-directory session has no repo');
    assert.equal(total(['--repo', '?']), E.tokens.none.length);
    assert.equal(total(['--runtime', 'claude-code']), all);
    assert.equal(total(['--role', E.main.role]), all);
    const none = costTier(ctx.home, ['--runtime', '?']);
    assert.equal(none.status, 0);
    assert.ok(linesOf(none.stdout).includes('no rows'));
  });

  it('invalid filter values exit 2 with nothing on stdout and no echo; cost takes no --link-confidence', () => {
    for (const [flag, value] of [['--tier', 'Q;x'], ['--model', ''], ['--repo', 'a b'], ['--role', 'x y']]) {
      const r = costTier(ctx.home, [flag, value]);
      assert.equal(r.status, 2, flag);
      assert.equal(r.stdout, '');
      if (value.length > 1) assert.ok(!r.stderr.includes(value));
    }
    assert.equal(costTier(ctx.home, ['--link-confidence', 'low']).status, 2);
  });

  it('cost prints no column-0 key it did not print before when a filter is set', () => {
    const keys = (text) => new Set(linesOf(text).map((l) => /^([a-z0-9(][a-z0-9 ()_-]*): /.exec(l)?.[1]).filter(Boolean));
    const plain = keys(costTier(ctx.home, ['--by', 'tier']).stdout);
    const filtered = keys(costTier(ctx.home, ['--by', 'tier', '--tier', 'A', '--model', E.models.m1]).stdout);
    assert.deepEqual([...filtered].filter((k) => !plain.has(k)), []);
  });

  it('evidence of a tier row lists exactly that row calls; cost --evidence follows the filters; standalone evidence stays unfiltered', () => {
    const key = buildRowKey('main', [['tier', 'A']]);
    const e = runCli(['evidence', key, ...OCT, '--json', '--limit', '100'], { home: ctx.home, env: tierEnv(ctx.home) });
    assert.equal(e.status, 0, e.stderr);
    assert.equal(JSON.parse(e.stdout).calls, callsOfTier((s) => s.tier === 'A'));
    const bucket = runCli(['evidence', buildRowKey('main', [['tier', '(unattributed_overlap)']]), ...OCT, '--json'], { home: ctx.home, env: tierEnv(ctx.home) });
    assert.equal(JSON.parse(bucket.stdout).calls, E.tokens.overlap.length + E.tokens.low.length);
    const filtered = costJson(ctx.home, ['--by', 'tier', '--model', E.models.m2, '--evidence', '--limit', '100']);
    const popKey = buildRowKey('main', [['population', 'reconstructed'], ['tier', 'A']]);
    assert.equal(filtered.evidence[popKey].calls, 2, 'inline evidence counts only calls matching the filter');
    assert.equal(JSON.parse(e.stdout).calls, callsOfTier((s) => s.tier === 'A'), 'standalone evidence ignores the filters');
  });
});

describe('cost --repo with two repos of one name (02-08 Task 3)', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildUnitsHome({ home: ctx.home, root: ctx.root, sameName: true });
    assert.equal(runCli(['ingest'], { home: ctx.home }).status, 0);
  });
  after(() => ctx.cleanup());

  const repoRows = (args) => {
    const r = runCli(['cost', '--by', 'repo', '--json', ...args], { home: ctx.home });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).sections.main.rows.map((x) => x.dims.repo.value);
  };

  it('--repo proj prints both proj rows, a quoted key one, ? the calls of the ? row', () => {
    const [a, b] = UNITS_EXPECTED.sameName.displays;
    const both = repoRows(['--repo', 'proj']);
    assert.deepEqual([...both].sort(), [a, b].sort());
    assert.deepEqual(repoRows(['--repo', a]), [a]);
    assert.deepEqual(repoRows(['--repo', '?']), [null]);
  });

  it('every display cost --by repo prints selects exactly its own row', () => {
    const shown = repoRows([]).filter((v) => v !== null);
    assert.ok(shown.length >= 2);
    for (const display of shown) {
      const key = display.startsWith('~') || display.startsWith('/') ? display : display;
      assert.deepEqual(repoRows(['--repo', key]), [display], display);
    }
  });
});

describe('cost --role ? selects calls of unknown role (02-08 Task 3)', () => {
  it('on the derive-roles-iter case --role ? keeps the one call whose role source is unavailable', async () => {
    const ctx = await ingested(['derive-roles-iter']);
    try {
      const r = runCli(['cost', '--by', 'role', '--role', '?'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      const rows = costOut(r.stdout).rows;
      const exp = roles.expectedDerived.rowsByRole.find((x) => x[0] === 'unknown');
      assert.deepEqual(rows.map((x) => x.slice(0, 6)), [exp]);
      const named = runCli(['cost', '--by', 'role', '--role', 'unknown'], { home: ctx.home });
      assert.deepEqual(costOut(named.stdout).rows.map((x) => x.slice(0, 6)), [exp]);
    } finally {
      ctx.cleanup();
    }
  });
});
