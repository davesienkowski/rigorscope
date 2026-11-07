// Plan 02-08 review fixes (02-08-REVIEW.md WR-01..WR-06, IN-01; 02-08-FIX-PLAN.md). One test commit per finding, written
// before its fix (RED). Every run spawns the CLI on a temporary HOME built from test/fixtures/tier-home.mjs (or the phase 1
// `iterations` case) under a fixed clock and TZ=UTC; a state the fixture cannot reach is made by editing that temporary HOME's
// derived.db with the Db class (the same tamper pattern cost-by.test.mjs uses). Nothing here touches the real HOME.
import { reconstructedView } from '../fixtures/strata-home.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Db, derivedPath } from '../../src/db.mjs';
import {
  buildFixtureTree, cliEnv, makeHome, runCli,
} from '../fixtures/build.mjs';
import {
  TIER_EXPECTED, TIER_SPEC, TIER_TIMES, buildTierHome,
} from '../fixtures/tier-home.mjs';

const E = TIER_EXPECTED;
const envOf = (home) => cliEnv(home, { TZ: 'UTC', RIGORSCOPE_NOW: TIER_TIMES.now });
const run = (home, args) => runCli(args, { home, env: envOf(home) });
const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const textOf = (home, args = ['tier']) => {
  const r = run(home, args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const jsonOf = (home, args = ['tier']) => reconstructedView(JSON.parse(textOf(home, [...args, '--json'])));
const stratumOf = (doc, name) => doc.strata.find((s) => s.stratum === name);
const rowOf = (doc, name, tier) => stratumOf(doc, name).rows.find((r) => r.tier === tier);
const lineStarting = (text, prefix) => linesOf(text).find((l) => l.startsWith(prefix));
const idOf = (id) => TIER_SPEC.find((s) => s.id === id).idFull;

async function tierHome() {
  const ctx = makeHome();
  buildTierHome({ home: ctx.home, root: ctx.root });
  assert.equal(run(ctx.home, ['ingest']).status, 0);
  // one report first so derived.db exists; every tamper below edits that file in place and it is not rebuilt (store unchanged)
  assert.equal(run(ctx.home, ['tier']).status, 0);
  return ctx;
}

function tamper(home, sql, params = []) {
  const db = new Db(derivedPath(home));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

// The cells of one tier row of one stratum in the tier text: tier n costed tokens_median ... (split on whitespace).
function rowCells(text, stratum, tier) {
  const lines = linesOf(text);
  const at = lines.findIndex((l) => l.startsWith(`stratum: ${stratum} `));
  assert.ok(at >= 0, `a stratum line for ${stratum}`);
  const row = lines.slice(at + 2, at + 6).find((l) => l.split(/\s+/)[0] === tier);
  assert.ok(row, `a ${tier} row in ${stratum}`);
  return row.split(/\s+/);
}

// ---- WR-01 (RR-05, RR-04): a lower-bound dollar figure is never printed as exact ------------------------------------------
describe('WR-01: floor-priced units carry a >= marker in tier rows, leads and units (02-08 review)', () => {
  let floored;
  let plain;
  before(async () => {
    floored = await tierHome();
    plain = await tierHome();
    // the two calls of unit ga5 become floor-priced (ttl_unresolved): its dollars are a lower bound
    tamper(floored.home, "UPDATE api_call_part SET cost_floor = 1, floor_reason = 'ttl_unresolved' WHERE call_key IN (SELECT call_key FROM api_call WHERE owner_session_id = ?)", [E.sessions.ga5]);
  });
  after(() => { floored.cleanup(); plain.cleanup(); });

  it('the statistic JSON carries usd_floor on all four statistics: true for the usd of a row holding a floored unit, false elsewhere', () => {
    const doc = jsonOf(floored.home);
    const a = rowOf(doc, 'gate-or-hook', 'A');
    assert.equal(a.usd.usd_floor, true);
    assert.deepEqual(Object.keys(a.usd), ['median', 'p75', 'known', 'usd_floor']);
    for (const k of ['tokens', 'window_5h', 'window_7d']) assert.equal(a[k].usd_floor, false, k);
    for (const t of ['B', 'C', '?']) assert.equal(rowOf(doc, 'gate-or-hook', t).usd.usd_floor, false, t);
    assert.equal(a.usd.known, 11, 'a floored unit stays in the usd statistic (a lower bound is a known value)');
  });

  it('the A row prints its usd median and p75 with >= and the B and C rows without', () => {
    const text = textOf(floored.home);
    const a = rowCells(text, 'gate-or-hook', 'A');
    assert.match(a[5], /^>=\d+\.\d{6}$/, `usd_median cell ${a[5]}`);
    assert.match(a[6], /^>=\d+\.\d{6}$/, `usd_p75 cell ${a[6]}`);
    for (const t of ['B', 'C']) {
      const c = rowCells(text, 'gate-or-hook', t);
      assert.match(c[5], /^\d+\.\d{6}$/, `${t} usd_median`);
      assert.match(c[6], /^\d+\.\d{6}$/, `${t} usd_p75`);
    }
  });

  it('a lead names the floor: notional_floor in JSON and >= before the floored side in the sentence', () => {
    const doc = jsonOf(floored.home);
    const lead = doc.leads.find((l) => l.stratum === 'gate-or-hook' && l.tiers[0] === 'A' && l.tiers[1] === 'B');
    assert.ok(lead, 'the A-B lead');
    assert.deepEqual(lead.notional_floor, [true, false]);
    assert.match(lead.sentence, /notional >=\d+\.\d{6} vs \d+\.\d{6}\)/);
    const bc = doc.leads.find((l) => l.tiers[0] === 'B' && l.tiers[1] === 'C');
    assert.deepEqual(bc.notional_floor, [false, false]);
    assert.match(bc.sentence, /notional \d+\.\d{6} vs \d+\.\d{6}\)/);
  });

  it('with no floored call nothing changes: usd_floor false everywhere, notional_floor false, no >= in a row or a lead', () => {
    const doc = jsonOf(plain.home);
    for (const st of doc.strata) {
      for (const r of st.rows) for (const k of ['tokens', 'usd', 'window_5h', 'window_7d']) assert.equal(r[k].usd_floor, false, `${st.stratum} ${r.tier} ${k}`);
    }
    for (const l of doc.leads) {
      assert.deepEqual(l.notional_floor, [false, false]);
      assert.ok(!l.sentence.includes('>='));
    }
    const text = textOf(plain.home);
    for (const t of ['A', 'B', 'C']) assert.ok(!rowCells(text, 'gate-or-hook', t).join(' ').includes('>='), t);
  });

  it('a floored unit with unknown dollars is outside the usd set, so it sets no marker (unit test of the statistic)', async () => {
    const { summarizeRow } = await import('../../src/report/tier.mjs');
    const u = (k) => ({ unit_key: k, tier: 'A', tier_signal: 'frontmatter', risk_class: '["parser"]' });
    const cost = (usd, floor) => ({
      calls: 1, scopes: 1, tokens: 10, usd_nano: usd, usd_floor: floor, window_5h: null, window_7d: null,
    });
    const known = summarizeRow([u('a'), u('b')], new Map([['a', cost(5, false)], ['b', cost(9, true)]]), { tier: 'A' });
    assert.equal(known.usd.usd_floor, true);
    const unknown = summarizeRow([u('a'), u('b')], new Map([['a', cost(5, false)], ['b', cost(null, true)]]), { tier: 'A' });
    assert.equal(unknown.usd.usd_floor, false);
    assert.equal(unknown.usd.known, 1);
    assert.equal(unknown.tokens.usd_floor, false);
  });

  it('units (A1): the floored unit lists its dollars with >= in text and usd_floor true in JSON, an exact unit false', () => {
    const doc = jsonOf(floored.home, ['units']);
    const ga5 = doc.units.find((x) => x.native_id === idOf('ga5'));
    const ga4 = doc.units.find((x) => x.native_id === idOf('ga4'));
    assert.equal(ga5.cost.usd_floor, true);
    assert.equal(ga4.cost.usd_floor, false);
    const gbb = doc.units.find((x) => x.native_id === idOf('gbb'));
    assert.equal(gbb.cost.usd_floor, null, 'a unit with no attributed call has an unknown floor flag, never false');
    const text = textOf(floored.home, ['units']);
    const row = (id) => linesOf(text).find((l) => l.includes(idOf(id)));
    assert.match(row('ga5'), />=\d+\.\d{6}\s*$/);
    assert.doesNotMatch(row('ga4'), />=/);
  });
});

// ---- WR-02 (RR-04, TRUST-06): a confounder unknown for some calls of a unit is never `unchanged` --------------------------
describe('WR-02: a partial unit makes its confounder partly unknown, and changed still wins (02-08 review)', () => {
  const effort = (doc) => stratumOf(doc, 'gate-or-hook').confounders.entries.find((e) => e.name === 'effort');
  let partial;
  let changed;
  before(async () => {
    partial = await tierHome();
    changed = await tierHome();
    const part = "UPDATE unit_confounder SET unknown_calls = 1 WHERE unit_key = ? AND name = 'effort' AND link_confidence = 'medium'";
    tamper(partial.home, part, [E.keyOf('ga5')]);
    tamper(changed.home, part, [E.keyOf('ga5')]);
    tamper(changed.home, "UPDATE unit_confounder SET value = '[\"low\"]' WHERE unit_key = ? AND name = 'effort' AND link_confidence = 'medium'", [E.keyOf('gb0')]);
  });
  after(() => { partial.cleanup(); changed.cleanup(); });

  it('unknown_calls 1 on one unit: effort is partly unknown (1 of 30 units), unchanged drops from 7 to 6', () => {
    const doc = jsonOf(partial.home);
    const e = effort(doc);
    assert.equal(e.status, 'partly-unknown');
    assert.equal(e.unknown_units, 1);
    assert.equal(e.sides.reduce((n, s) => n + s.unknown, 0), 0, 'a partial unit has a known value, so it is not added to the per-side unknown count');
    assert.equal(e.sides.reduce((n, s) => n + s.partial, 0), 1);
    assert.equal(stratumOf(doc, 'gate-or-hook').confounders.unchanged, 6);
    const line = lineStarting(textOf(partial.home), 'confounders: gate-or-hook ');
    assert.ok(line.includes('partly unknown: effort (1 of 30 units); unchanged=6'), line);
  });

  it('a partial unit does not hide a known difference: effort high (partial) against effort low is changed', () => {
    const e = effort(jsonOf(changed.home));
    assert.equal(e.status, 'changed');
    assert.equal(e.unknown_units, 1, 'the partial unit is still reported');
    const line = lineStarting(textOf(changed.home), 'confounders: gate-or-hook ');
    assert.ok(line.includes('effort (A: high; B: high, low; C: high)'), line);
  });

  it('leads reuse the flag: a lead whose pair holds the partial unit lists effort as unknown, another pair does not', () => {
    const doc = jsonOf(partial.home);
    const ab = doc.leads.find((l) => l.stratum === 'gate-or-hook' && l.tiers.join('') === 'AB');
    const bc = doc.leads.find((l) => l.stratum === 'gate-or-hook' && l.tiers.join('') === 'BC');
    assert.ok(ab.confounders_unknown.includes('effort'));
    assert.ok(!bc.confounders_unknown.includes('effort'));
  });

  it('pure: equal values with one partial unit are partly-unknown; changed wins; no partial is unchanged', async () => {
    const { diffConfounders } = await import('../../src/report/confounder-diff.mjs');
    const unit = (key, effortValue, partialEffort) => ({
      key, values: { effort: effortValue }, partial: partialEffort ? { effort: true } : {}, start_ms: 1, end_ms: 2,
    });
    const sides = (a, b) => [{ tier: 'A', units: a }, { tier: 'B', units: b }];
    const pick = (s) => diffConfounders(s, { names: ['effort'] })[0];
    assert.equal(pick(sides([unit('a', '["high"]', false)], [unit('b', '["high"]', false)])).status, 'unchanged');
    const equalPartial = pick(sides([unit('a', '["high"]', true)], [unit('b', '["high"]', false)]));
    assert.equal(equalPartial.status, 'partly-unknown');
    assert.equal(equalPartial.unknown_units, 1);
    assert.equal(pick(sides([unit('a', '["high"]', true)], [unit('b', '["low"]', false)])).status, 'changed');
  });

  it('pure: unitPartialFlags marks a name when any of its role rows has unknown_calls above 0 and never otherwise', async () => {
    const { unitPartialFlags } = await import('../../src/report/confounder-diff.mjs');
    assert.deepEqual({ ...unitPartialFlags([
      { name: 'effort', role: 'main', value: '["high"]', unknown_calls: 0 },
      { name: 'model', role: 'main', value: '["m"]', unknown_calls: 2 },
      { name: 'model', role: 'sub', value: null, unknown_calls: 1 },
      { name: 'repo', role: '', value: 'r', unknown_calls: null },
    ]) }, { model: true });
    assert.deepEqual({ ...unitPartialFlags([]) }, {});
    assert.deepEqual({ ...unitPartialFlags(undefined) }, {});
  });
});

// ---- WR-03 (TRUST-06 adjacency): units of unknown dates are counted in the comparison window, never silently dropped ---------
describe('WR-03: the window line carries unknown_dates=N (02-08 review)', () => {
  let some;
  let all;
  let pristine;
  before(async () => {
    some = await tierHome();
    all = await tierHome();
    pristine = await tierHome();
    // gb4 (B) and ga5 (A) lose their start: gb4 was alone on the first day, so the window now starts later
    tamper(some.home, "UPDATE unit SET start_ms = NULL, date_source = 'none' WHERE unit_key IN (?, ?)", [E.keyOf('gb4'), E.keyOf('ga5')]);
    // every unit loses both bounds: no known day at all
    tamper(all.home, "UPDATE unit SET start_ms = NULL, date_source = 'none', end_ms = NULL, end_source = 'none'");
  });
  after(() => { some.cleanup(); all.cleanup(); pristine.cleanup(); });

  it('two compared units with an unknown start: unknown_dates=2 on the stratum and confounders lines, the bounds cover the known dates', () => {
    const text = textOf(some.home);
    assert.match(lineStarting(text, 'stratum: gate-or-hook '), / window=2026-10-02\.\.2026-10-17 unknown_dates=2 tokens_unknown=/);
    assert.ok(lineStarting(text, 'confounders: gate-or-hook ').startsWith('confounders: gate-or-hook A,B,C window=2026-10-02..2026-10-17 unknown_dates=2 changed: '));
  });

  it('--json carries unknown_dates on the stratum window, the confounders window and every lead window (the units of that pair)', () => {
    const doc = jsonOf(some.home);
    const st = stratumOf(doc, 'gate-or-hook');
    assert.deepEqual(st.window, { first_day: '2026-10-02', last_day: '2026-10-17', unknown_dates: 2 });
    assert.deepEqual(st.confounders.window, { first_day: '2026-10-02', last_day: '2026-10-17', unknown_dates: 2 });
    const unknownOf = (pair) => doc.leads.find((l) => l.stratum === 'gate-or-hook' && l.tiers.join('') === pair).window.unknown_dates;
    assert.deepEqual([unknownOf('AB'), unknownOf('AC'), unknownOf('BC')], [2, 1, 1]);
  });

  it('with no known date at all the count survives: window=? unknown_dates=30 and a window object with null days', () => {
    const text = textOf(all.home);
    assert.match(lineStarting(text, 'stratum: gate-or-hook '), / window=\? unknown_dates=30 tokens_unknown=/);
    assert.ok(lineStarting(text, 'confounders: gate-or-hook ').startsWith('confounders: gate-or-hook A,B,C window=? unknown_dates=30 changed: '));
    const doc = jsonOf(all.home);
    const st = stratumOf(doc, 'gate-or-hook');
    assert.deepEqual(st.window, { first_day: null, last_day: null, unknown_dates: 30 });
    assert.deepEqual(st.confounders.window, { first_day: null, last_day: null, unknown_dates: 30 });
    assert.ok(doc.leads.every((l) => l.window.first_day === null && l.window.unknown_dates > 0));
  });

  it('with every date known unknown_dates is 0 in text and JSON', () => {
    const text = textOf(pristine.home);
    assert.match(lineStarting(text, 'stratum: gate-or-hook '), / unknown_dates=0 /);
    const doc = jsonOf(pristine.home);
    assert.equal(stratumOf(doc, 'gate-or-hook').window.unknown_dates, 0);
    assert.ok(doc.leads.every((l) => l.window.unknown_dates === 0));
  });
});

// ---- WR-04 (D-02, D-03, TIER-02): cost --tier B excludes probe-inferred units unless --include-inferred ---------------------
describe('WR-04: cost --tier excludes inferred tiers by default and --include-inferred adds them (02-08 review)', () => {
  const OCT = ['--since', '2026-10-01', '--until', '2026-11-01'];
  const costRun = (home, args) => run(home, ['cost', ...OCT, ...args]);
  const costJson = (home, args) => {
    const r = costRun(home, [...args, '--json']);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const tierCalls = (doc) => Object.fromEntries(doc.sections.main.rows.map((r) => [r.dims.tier.value ?? '?', r.calls]));
  const costedB = TIER_SPEC.filter((s) => s.costed && s.tier === 'B' && !s.probes).length;
  let ctx;
  before(async () => { ctx = await tierHome(); });
  after(() => ctx.cleanup());

  it('--by tier --tier B prints the B row only (no B-inferred row) and the totals check is OK', () => {
    assert.deepEqual(tierCalls(costJson(ctx.home, ['--by', 'tier', '--tier', 'B'])), { B: 2 * costedB });
    assert.match(costRun(ctx.home, ['--by', 'tier', '--tier', 'B']).stdout, /^totals check: main OK/m);
  });

  it('--include-inferred puts the probe-inferred unit back: B and B-inferred rows, and the scope line says so', () => {
    const args = ['--by', 'tier', '--tier', 'B', '--include-inferred'];
    assert.deepEqual(tierCalls(costJson(ctx.home, args)), { B: 2 * costedB, 'B-inferred': 2 });
    const scope = lineStarting(costRun(ctx.home, args).stdout, 'scope: ');
    assert.ok(scope.includes('include_inferred=yes'), scope);
    const off = lineStarting(costRun(ctx.home, ['--by', 'tier', '--tier', 'B']).stdout, 'scope: ');
    assert.ok(off.includes('include_inferred=no'), off);
  });

  it('the --by tier dimension itself is unchanged: with no --tier filter B-inferred keeps its own row and the totals check is OK', () => {
    const calls = tierCalls(costJson(ctx.home, ['--by', 'tier']));
    assert.equal(calls['B-inferred'], 2);
    assert.equal(calls.B, 2 * costedB);
    assert.match(costRun(ctx.home, ['--by', 'tier']).stdout, /^totals check: main OK/m);
  });

  it('--include-inferred with no --tier changes nothing', () => {
    const a = costRun(ctx.home, ['--by', 'tier']);
    const b = costRun(ctx.home, ['--by', 'tier', '--include-inferred']);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(b.stdout, a.stdout);
  });

  it('--evidence agrees with the rows: the inferred unit is listed only under --include-inferred, and then with its 2 calls', () => {
    const inferredKey = E.keyOf('gba');
    const without = costJson(ctx.home, ['--by', 'unit', '--tier', 'B', '--evidence', '--limit', '100']);
    assert.ok(!without.sections.main.rows.some((r) => r.dims.unit.value === inferredKey));
    const withFlag = costJson(ctx.home, ['--by', 'tier', '--tier', 'B', '--include-inferred', '--evidence', '--limit', '100']);
    const inferredRow = withFlag.sections.main.rows.find((r) => r.dims.tier.value === 'B-inferred');
    assert.ok(inferredRow, 'a B-inferred row');
    assert.equal(withFlag.evidence[inferredRow.key].calls, 2, 'inline evidence loads with the same filter as the rows');
    const plainRow = without.sections.main.rows.find((r) => r.dims.unit.value === E.keyOf('gb0'));
    assert.equal(without.evidence[plainRow.key].calls, 2);
  });

  it('pure: the tier filter fragment adds the probes-skipped predicate only to letters, only without includeInferred', async () => {
    const { costFilterWhere } = await import('../../src/report/cost.mjs');
    const filters = { unit: { repo: null, tier: ['B', null], framework: null, runtime: null }, call: { model: null, role: null } };
    const off = costFilterWhere(filters, { includeInferred: false });
    assert.ok(off.sql.includes("u.tier_signal <> 'probes-skipped'"));
    assert.ok(off.sql.includes('u.tier IS NULL'));
    const dflt = costFilterWhere(filters);
    assert.equal(dflt.sql, off.sql, 'the default excludes inferred tiers');
    const on = costFilterWhere(filters, { includeInferred: true });
    assert.ok(!on.sql.includes('probes-skipped'));
  });
});

// ---- WR-05: cost --model selects calls by the call model while --by model splits by part model (documented) ------------------
describe('WR-05: the cost --model filter is call-level and says so (02-08 review)', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['iterations'] });
    assert.equal(runCli(['ingest'], { home: ctx.home }).status, 0);
  });
  after(() => ctx.cleanup());

  const cost = (args) => runCli(['cost', ...args], { home: ctx.home });
  const modelRows = (args) => {
    const r = cost(['--by', 'model', '--json', ...args]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).sections.main.rows.map((x) => x.dims.model.value);
  };

  it('the documented behaviour on the iterations fixture: a call keeps its advisor part under a filter on the call model, and a part model selects nothing', () => {
    assert.deepEqual(modelRows([]), ['claude-fable-5-0', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    assert.deepEqual(modelRows(['--model', 'claude-fable-5-0']), [], 'the fable part belongs to a call whose model is opus');
    assert.deepEqual(modelRows(['--model', 'claude-opus-5-5']), ['claude-fable-5-0', 'claude-opus-5-5']);
    assert.match(cost(['--by', 'model', '--model', 'claude-opus-5-5']).stdout, /^totals check: main OK/m);
  });

  it('the scope line states that --model selects calls by the call model and --by model splits by part model; other filters do not say it', () => {
    const scope = lineStarting(cost(['--by', 'model', '--model', 'claude-opus-5-5']).stdout, 'scope: ');
    assert.ok(scope.includes('--model selects calls by the call model'), scope);
    assert.ok(scope.includes('--by model splits by part model'), scope);
    const other = lineStarting(cost(['--by', 'model', '--role', 'main']).stdout, 'scope: ');
    assert.ok(!other.includes('call model'), other);
  });

  it('docs/cli.md states the same under cost', () => {
    const text = readFileSync(new URL('../../docs/cli.md', import.meta.url), 'utf8');
    const start = text.indexOf('#### Filters');
    const section = text.slice(start, text.indexOf('\n#### ', start + 10) > 0 ? text.indexOf('\n#### ', start + 10) : start + 6000);
    assert.ok(section.includes('selects calls by the call model'));
    assert.ok(section.includes('splits by part model'));
  });
});

// ---- WR-06a (TRUST-07): start_unknown counts the selected units of unknown start, before the period and after the filters -----
describe('WR-06a: start_unknown follows the unit and call filters, not the period (02-08 review)', () => {
  const BOUNDED = ['--since', '2026-10-01', '--until', '2026-10-31'];
  let ctx;
  before(async () => {
    ctx = await tierHome();
    // gb0 and gb1 (opus units, no sonnet call) lose their start
    tamper(ctx.home, "UPDATE unit SET start_ms = NULL, date_source = 'none' WHERE unit_key IN (?, ?)", [E.keyOf('gb0'), E.keyOf('gb1')]);
  });
  after(() => ctx.cleanup());

  const startUnknown = (args) => jsonOf(ctx.home, ['tier', ...args]).counts.start_unknown;

  it('a call filter that keeps neither unit leaves start_unknown 0 (they are out because of the filter, not the period)', () => {
    assert.equal(startUnknown([...BOUNDED, '--model', E.models.m2]), 0);
    const text = lineStarting(textOf(ctx.home, ['tier', ...BOUNDED, '--model', E.models.m2]), 'period: ');
    assert.ok(text.includes('start_unknown=forward:0,reconstructed:0 units are outside a bounded period'), text);
    assert.equal(startUnknown(['--model', E.models.m2]), 0);
  });

  it('a bounded period with no call filter still reports both units, outside the period', () => {
    assert.equal(startUnknown(BOUNDED), 2);
    assert.ok(lineStarting(textOf(ctx.home, ['tier', ...BOUNDED]), 'period: ').includes('start_unknown=forward:0,reconstructed:2 units are outside a bounded period'));
    assert.equal(startUnknown([...BOUNDED, '--model', E.models.m1]), 2, 'a call filter that keeps them still counts them');
  });

  it('the default period prints start_unknown too, worded for units that are in the rows', () => {
    assert.equal(startUnknown([]), 2);
    const line = lineStarting(textOf(ctx.home), 'period: ');
    assert.equal(line, "period: all time (units by start; a unit's cost counts all its attributed calls; start_unknown=forward:0,reconstructed:2 units have no start and are counted in the rows)");
  });
});

// ---- WR-06b (RR-04): the table says how many units the dollar statistics cover ------------------------------------------------
describe('WR-06b: the tier table prints usd_n beside the dollar statistics (02-08 review)', () => {
  let ctx;
  before(async () => { ctx = await tierHome(); });
  after(() => ctx.cleanup());

  it('the header has usd_n after usd_p75, always (not only when it differs from costed)', () => {
    const lines = linesOf(textOf(ctx.home));
    const at = lines.findIndex((l) => l.startsWith('stratum: gate-or-hook '));
    const header = lines[at + 1].trim().split(/\s+/);
    assert.deepEqual(header.slice(5, 9), ['usd_median', 'usd_p75', 'usd_n', 'window_5h_median']);
    for (const stratum of ['security', 'none', 'unknown']) {
      const l = lines.findIndex((x) => x.startsWith(`stratum: ${stratum} `));
      assert.match(lines[l + 1], /usd_p75\s+usd_n\s+window_5h_median/, stratum);
    }
  });

  it('row B shows usd_n 9 beside costed 10 (the unit on the unpriced model), A shows 11 of 11, and the cell equals usd.known in JSON', () => {
    const text = textOf(ctx.home);
    const b = rowCells(text, 'gate-or-hook', 'B');
    assert.equal(b[2], '10');
    assert.equal(b[7], '9');
    const a = rowCells(text, 'gate-or-hook', 'A');
    assert.equal(a[2], '11');
    assert.equal(a[7], '11');
    const doc = jsonOf(ctx.home);
    assert.equal(rowOf(doc, 'gate-or-hook', 'B').usd.known, 9);
    assert.equal(rowCells(text, 'gate-or-hook', '?')[7], String(rowOf(doc, 'gate-or-hook', '?').usd.known));
  });
});

// ---- IN-01: a lead's n is the costed count and says so ------------------------------------------------------------------------
describe('IN-01: the lead sentence says costed n= (02-08 review)', () => {
  let ctx;
  before(async () => { ctx = await tierHome(); });
  after(() => ctx.cleanup());

  it('every lead sentence prints (costed n=X vs Y and the numbers are the lead costed counts, not the table n', () => {
    const doc = jsonOf(ctx.home);
    assert.ok(doc.leads.length > 0);
    for (const l of doc.leads) {
      assert.ok(l.sentence.includes(`(costed n=${l.costed[0]} vs ${l.costed[1]}`), l.sentence);
      assert.ok(!/\(n=/.test(l.sentence), l.sentence);
    }
    const b = doc.leads.find((l) => l.tiers[0] === 'B' && l.tiers[1] === 'C');
    assert.equal(b.costed[0], rowOf(doc, 'gate-or-hook', 'B').costed);
    assert.notEqual(b.costed[0], rowOf(doc, 'gate-or-hook', 'B').n, 'costed differs from the unit count n for row B, which is why the wording matters');
  });
});

// ---- the third-round guard (02-08-FIX-PLAN stop rule; R1 W3b): floor, partial unknown and unknown date together -----------------
describe('guard: a floor, a partial unknown and an unknown date in one comparison are all shown, none as known', () => {
  let ctx;
  before(async () => {
    ctx = await tierHome();
    tamper(ctx.home, "UPDATE api_call_part SET cost_floor = 1, floor_reason = 'ttl_unresolved' WHERE call_key IN (SELECT call_key FROM api_call WHERE owner_session_id = ?)", [E.sessions.gb2]);
    tamper(ctx.home, "UPDATE unit_confounder SET unknown_calls = 3 WHERE unit_key = ? AND name = 'model' AND link_confidence = 'medium'", [E.keyOf('gc1')]);
    tamper(ctx.home, "UPDATE unit SET start_ms = NULL, date_source = 'none' WHERE unit_key = ?", [E.keyOf('ga2')]);
  });
  after(() => ctx.cleanup());

  it('the B row prints >=, the confounders line lists the partial name and unknown_dates=1, in text and JSON', () => {
    const text = textOf(ctx.home);
    assert.match(rowCells(text, 'gate-or-hook', 'B')[5], /^>=/);
    assert.match(rowCells(text, 'gate-or-hook', 'A')[5], /^\d/);
    const doc = jsonOf(ctx.home);
    const st = stratumOf(doc, 'gate-or-hook');
    assert.equal(rowOf(doc, 'gate-or-hook', 'B').usd.usd_floor, true);
    assert.equal(st.window.unknown_dates, 1);
    assert.equal(st.confounders.window.unknown_dates, 1);
    // model already differs across the sides, so changed wins; the partial unit is still counted in unknown_units
    const model = st.confounders.entries.find((e) => e.name === 'model');
    assert.equal(model.status, 'changed');
    assert.equal(model.unknown_units, 1);
    assert.ok(lineStarting(text, 'confounders: gate-or-hook ').includes('unknown_dates=1'));
  });
});
