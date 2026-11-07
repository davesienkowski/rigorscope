// Plan 02-08 (D-18, TRUST-07, D-02, RPT-01): `rigorscope tier` on the tier fixture and on an empty HOME. Written before the
// code (RED). Every run spawns the CLI on a temporary HOME from makeHome() built by test/fixtures/tier-home.mjs under a
// fixed clock and TZ=UTC. Nothing here touches the real HOME.
import { reconstructedView } from '../fixtures/strata-home.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  cliEnv, makeHome, runCli, runCliAsync, stateDirOf,
} from '../fixtures/build.mjs';
import { CONFOUNDER_NAMES } from '../../src/derive/confounders.mjs';
import { buildUnitEvidenceId } from '../../src/measure/rowkey.mjs';
import { TIER_KEYS } from '../../src/report/tier.mjs';
import { FORBIDDEN_KEYS, FORBIDDEN_WORDS } from '../prohibitions/no-score.test.mjs';
import {
  TIER_EXPECTED, TIER_SPEC, TIER_TIMES, buildTierHome,
} from '../fixtures/tier-home.mjs';

const E = TIER_EXPECTED;
export const envOf = (home) => cliEnv(home, { TZ: 'UTC', RIGORSCOPE_NOW: TIER_TIMES.now });
export const linesOf = (text) => text.split('\n').filter((l) => l !== '');
export const cli = (home, args) => runCli(args, { home, env: envOf(home) });
export const json = (home, args = ['tier']) => {
  const r = cli(home, [...args, '--json']);
  assert.equal(r.status, 0, r.stderr);
  return reconstructedView(JSON.parse(r.stdout));
};
const stratumOf = (doc, name) => doc.strata.find((s) => s.stratum === name);
const rowOf = (doc, name, tier) => stratumOf(doc, name).rows.find((r) => r.tier === tier);
const expRow = (strata, name, tier) => strata.find((s) => s.stratum === name).rows[tier];
const idOf = (id) => TIER_SPEC.find((s) => s.id === id).idFull;
const unitKeyOfId = (id) => E.keyOf(id);
const idOfInferred = () => E.keyOf('gba');

describe('tier fixture self-check (02-08)', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildTierHome({ home: ctx.home, root: ctx.root });
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
  });
  after(() => ctx.cleanup());

  it('every fixture unit has the intended risk tags, tier and tier signal (a changed rule table fails here first)', () => {
    const doc = json(ctx.home, ['units']);
    assert.equal(doc.units.length, TIER_SPEC.length);
    for (const s of TIER_SPEC) {
      const u = doc.units.find((x) => x.native_id === idOf(s.id));
      assert.ok(u, `unit ${s.id} is listed`);
      assert.deepEqual(u.risk_class.value, E.riskTags[s.id], `risk tags of ${s.id}`);
      assert.equal(u.tier.value, E.tiers[s.id].tier, `tier of ${s.id}`);
      assert.equal(u.tier.signal, E.tiers[s.id].signal, `tier signal of ${s.id}`);
    }
  });

  it('a costed unit has calls and the intended tokens, an uncosted one none', () => {
    const doc = json(ctx.home, ['units']);
    for (const s of TIER_SPEC) {
      const u = doc.units.find((x) => x.native_id === idOf(s.id));
      assert.equal(u.cost.tokens, s.costed ? s.tokens : null, `tokens of ${s.id}`);
    }
  });
});

describe('tracer: one risk stratum travels from stored units to the tier report (02-08 Task 1)', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildTierHome({ home: ctx.home, root: ctx.root });
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
  });
  after(() => ctx.cleanup());

  it('tier --json exits 0 and prints a rigorscope.tier/2 document with the leading keys and counts', () => {
    const doc = json(ctx.home);
    assert.equal(doc.schema, 'rigorscope.tier/2');
    assert.equal(doc.population, 'all');
    assert.deepEqual(doc.populations.map((x) => x.population), ['forward', 'reconstructed']);
    assert.equal(doc.link_confidence, 'medium');
    assert.equal(doc.include_inferred, false);
    assert.equal(doc.min_n, 10);
    assert.equal(doc.counts.units, TIER_SPEC.length);
    assert.equal(doc.counts.inferred_excluded, E.inferredExcluded);
    assert.equal(doc.counts.untiered, 2);
    assert.equal(doc.counts.risk_unknown, 1);
    assert.deepEqual(doc.strata.map((s) => s.stratum), E.strata.map((s) => s.stratum));
    assert.equal(doc.counts.strata_shown, E.strata.length);
  });

  it('the gate-or-hook stratum has rows A, B, C and ? in that order with the expected counts, medians and p75', () => {
    const doc = json(ctx.home);
    const st = stratumOf(doc, 'gate-or-hook');
    assert.deepEqual(st.rows.map((r) => r.tier), ['A', 'B', 'C', '?']);
    for (const t of ['A', 'B', 'C', '?']) {
      const r = rowOf(doc, 'gate-or-hook', t);
      const e = expRow(E.strata, 'gate-or-hook', t);
      assert.equal(r.n, e.n, `n of ${t}`);
      assert.equal(r.costed, e.costed, `costed of ${t}`);
      assert.equal(r.tokens.median, e.tokens_median, `token median of ${t}`);
      assert.equal(r.tokens.p75, e.tokens_p75, `token p75 of ${t}`);
      assert.equal(r.tokens.known, e.costed, `known tokens of ${t}`);
      assert.deepEqual(r.catch, { value: null, label: 'unavailable' });
      assert.deepEqual(r.escape, { value: null, label: 'unavailable' });
      for (const k of ['usd', 'window_5h', 'window_7d']) {
        assert.deepEqual(Object.keys(r[k]), ['median', 'p75', 'known', 'usd_floor'], `${k} keys of ${t}`);
      }
      assert.equal(r.evidence_ids.length, e.n);
    }
    // window shares are unknown on this fixture (no usage snapshots): left out of known, never 0
    assert.equal(rowOf(doc, 'gate-or-hook', 'A').window_5h.known, 0);
    assert.equal(rowOf(doc, 'gate-or-hook', 'A').window_5h.median, null);
    // the unit on an unpriced model has unknown dollars: left out of usd.known
    assert.equal(rowOf(doc, 'gate-or-hook', 'B').usd.known, 9);
    assert.equal(st.usd_unknown, 1);
    assert.equal(st.window_share_unknown, 31);
    assert.equal(st.tokens_unknown, 0);
  });

  it('the low-evidence flags at the default min_n 10 are false, false, true and null for the ? row', () => {
    const doc = json(ctx.home);
    assert.deepEqual(['A', 'B', 'C', '?'].map((t) => rowOf(doc, 'gate-or-hook', t).low_evidence), [false, false, true, null]);
    assert.deepEqual(['A', 'B', 'C', '?'].map((t) => rowOf(doc, 'gate-or-hook', t).compared), [true, true, true, false]);
    assert.deepEqual(stratumOf(doc, 'gate-or-hook').compared, ['A', 'B', 'C']);
    assert.deepEqual(stratumOf(doc, 'gate-or-hook').low_evidence, ['C']);
  });

  it('--min-n 11 gives false, true, true and --min-n 12 gives true for all three letters', () => {
    const flags = (n) => {
      const doc = json(ctx.home, ['tier', '--min-n', String(n)]);
      assert.equal(doc.min_n, n);
      return ['A', 'B', 'C', '?'].map((t) => rowOf(doc, 'gate-or-hook', t).low_evidence);
    };
    assert.deepEqual(flags(11), [false, true, true, null]);
    assert.deepEqual(flags(12), [true, true, true, null]);
  });

  it('an invalid --min-n exits 2 with one fixed message that never echoes the value, before any state is touched', () => {
    const fresh = makeHome();
    try {
      const messages = new Set();
      for (const v of ['0', '1001', '010', '1.5', '+5', '-1', 'x7y']) {
        const r = cli(fresh.home, ['tier', `--min-n=${v}`]);
        assert.equal(r.status, 2, v);
        assert.equal(r.stdout, '');
        assert.ok(v.length < 2 || !r.stderr.includes(v), `the message does not echo ${v}`);
        messages.add(r.stderr);
      }
      const empty = cli(fresh.home, ['tier', '--min-n', '']);
      assert.equal(empty.status, 2);
      messages.add(empty.stderr);
      assert.equal(messages.size, 1, 'one fixed message');
      assert.ok(!existsSync(stateDirOf(fresh.home)), 'a usage error touches no state');
    } finally {
      fresh.cleanup();
    }
  });

  it('the attribution block has the values of units --json (mode medium) and sums to its total with check ok', () => {
    const doc = json(ctx.home);
    const units = json(ctx.home, ['units']);
    const a = doc.attribution;
    for (const b of ['attributed', 'unattributed_overlap', 'unlinked', 'total']) {
      for (const f of ['calls', 'tokens', 'usd_nano', 'refs_unknown_calls']) assert.equal(a[b][f], units.attribution[b][f], `${b}.${f}`);
    }
    assert.equal(a.check, 'ok');
    assert.equal(a.link_confidence, 'medium');
    assert.deepEqual([a.attributed.calls, a.attributed.tokens], E.buckets.medium.attributed);
    assert.deepEqual([a.unattributed_overlap.calls, a.unattributed_overlap.tokens], E.buckets.medium.overlap);
    assert.deepEqual([a.unlinked.calls, a.unlinked.tokens], E.buckets.medium.unlinked);
    assert.equal(a.attributed.calls + a.unattributed_overlap.calls + a.unlinked.calls, a.total.calls);
    assert.equal(a.attributed.tokens + a.unattributed_overlap.tokens + a.unlinked.tokens, a.total.tokens);
    assert.equal(a.attributed.usd_nano, null, 'one unit runs on an unpriced model, so the attributed dollars are unknown, never a partial sum');
    assert.equal(a.total.usd_nano, null);
  });

  it('a row lists the u: id of every unit, bytewise by unit key', () => {
    const doc = json(ctx.home);
    const r = rowOf(doc, 'gate-or-hook', 'C');
    const keys = expRow(E.strata, 'gate-or-hook', 'C').keys;
    assert.deepEqual(r.evidence_ids, keys.map((k) => buildUnitEvidenceId(k)));
  });

  it('tier text prints the freshness lines, then period, scope, population, statistic, attribution, the stratum line, the header and one row per tier', () => {
    const r = cli(ctx.home, ['tier']);
    assert.equal(r.status, 0, r.stderr);
    const lines = linesOf(r.stdout);
    const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix));
    const order = ['freshness: ', 'period: ', 'scope: ', 'statistic: ', 'attribution: ', 'population: reconstructed ', 'stratum: gate-or-hook '].map(at);
    assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'fixed order');
    assert.equal(lines[at('period: ')], "period: all time (units by start; a unit's cost counts all its attributed calls; start_unknown=forward:0,reconstructed:0 units have no start and are counted in the rows)");
    assert.equal(lines[at('scope: ')], 'scope: link_confidence=medium include_inferred=no min_n=10 unit_filters=none call_filters=none');
    assert.match(lines[at('population: reconstructed ')], /^population: reconstructed units=36 tiered=\d+ comparable=\d+ inferred_excluded=1 declared_at_close=0 untiered=2 risk_unknown=1 strata=4 empty=parser,global-config,script,docs costed=\d+ low_evidence=(yes|no) \(a unit with several risk tags counts once in each of its strata\)$/);
    assert.match(lines[at('stratum: gate-or-hook ')], /^stratum: gate-or-hook units=\d+ compared=A,B,C low_evidence=C inferred_excluded=1 declared_at_close=0 window=\d{4}-\d\d-\d\d\.\.\d{4}-\d\d-\d\d unknown_dates=0 tokens_unknown=0 usd_unknown=1 window_share_unknown=31$/);
    const h = at('stratum: gate-or-hook ') + 1;
    assert.equal(lines[h].split(/\s+/).join(' '), 'tier n costed tokens_median tokens_p75 usd_median usd_p75 usd_n window_5h_median window_5h_p75 window_7d_median window_7d_p75 low_evidence catch escape');
    const rows = lines.slice(h + 1, h + 5).map((l) => l.split(/\s+/));
    assert.deepEqual(rows.map((c) => c[0]), ['A', 'B', 'C', '?']);
    const eA = expRow(E.strata, 'gate-or-hook', 'A');
    assert.deepEqual(rows[0].slice(1, 5), [String(eA.n), String(eA.costed), String(eA.tokens_median), String(eA.tokens_p75)]);
    assert.deepEqual(rows[0].slice(-3), ['no', 'unavailable', 'unavailable']);
    assert.deepEqual(rows[2].slice(-3), ['yes', 'unavailable', 'unavailable']);
    assert.deepEqual(rows[3].slice(-3), ['-', 'unavailable', 'unavailable']);
    assert.deepEqual(rows[0].slice(8, 12), ['?', '?', '?', '?'], 'window shares are unknown, printed ?');
  });

  it('two tier runs and two tier --json runs print byte-identical stdout', () => {
    assert.equal(cli(ctx.home, ['tier']).stdout, cli(ctx.home, ['tier']).stdout);
    assert.equal(cli(ctx.home, ['tier', '--json']).stdout, cli(ctx.home, ['tier', '--json']).stdout);
  });
});

describe('tier on an empty HOME (02-08 Task 1)', () => {
  let ctx;
  before(() => { ctx = makeHome(); });
  after(() => ctx.cleanup());

  it('tier --json exits 0 with no strata and zero counts', () => {
    const doc = json(ctx.home);
    assert.equal(doc.schema, 'rigorscope.tier/2');
    assert.deepEqual(doc.strata, []);
    assert.equal(doc.counts.units, 0);
    assert.equal(doc.counts.strata_shown, 0);
    assert.equal(doc.attribution.check, 'ok');
    assert.equal(doc.min_n, 10);
  });

  it('tier text prints the lines down to attribution (zeros, check=ok) and then no units', () => {
    const r = cli(ctx.home, ['tier']);
    assert.equal(r.status, 0, r.stderr);
    const lines = linesOf(r.stdout);
    const a = lines.find((l) => l.startsWith('attribution: '));
    assert.ok(a && a.includes('check=ok'));
    assert.match(a, /total=0\/0\/0\.000000/);
    assert.equal(lines[lines.length - 1], 'no units');
    assert.ok(!lines.some((l) => l.startsWith('stratum: ')));
  });
});

// ---- Task 2: strata rules, inferred tiers, link modes, confounders, leads, concurrency, no score --------------------------
const textOf = (home, args = ['tier']) => {
  const r = cli(home, args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const lineStarting = (text, prefix) => linesOf(text).find((l) => l.startsWith(prefix));
const modelText = (m) => m;

describe('strata rules on the tier fixture (02-08 Task 2)', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildTierHome({ home: ctx.home, root: ctx.root });
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
  });
  after(() => ctx.cleanup());

  it('strata come in RISK_TAGS order, then none, then unknown; the multi-tag unit counts in gate-or-hook and in security; none and unknown hold one unit each', () => {
    const doc = json(ctx.home);
    assert.deepEqual(doc.strata.map((s) => s.stratum), ['gate-or-hook', 'security', 'none', 'unknown']);
    const multi = unitKeyOfId('gaa');
    assert.ok(doc.strata[0].rows[0].evidence_ids.includes(buildUnitEvidenceId(multi)));
    assert.deepEqual(rowOf(doc, 'security', 'A').evidence_ids, [buildUnitEvidenceId(multi)]);
    assert.equal(stratumOf(doc, 'none').units, 1);
    assert.equal(stratumOf(doc, 'unknown').units, 1);
    assert.deepEqual(rowOf(doc, 'none', 'C').evidence_ids, [buildUnitEvidenceId(unitKeyOfId('nc0'))]);
    assert.deepEqual(rowOf(doc, 'unknown', 'A').evidence_ids, [buildUnitEvidenceId(unitKeyOfId('uk0'))]);
  });

  it('a stratum with one compared side prints no comparison, and every stratum window matches the fixture', () => {
    const text = textOf(ctx.home);
    for (const name of ['security', 'none', 'unknown']) {
      assert.ok(linesOf(text).includes(`confounders: ${name} no comparison (fewer than two tier sides with attributed cost)`), name);
    }
    const doc = json(ctx.home);
    for (const st of E.strata) {
      const got = stratumOf(doc, st.stratum).window;
      assert.deepEqual(got && [got.first_day, got.last_day], st.window, `window of ${st.stratum}`);
    }
  });

  it('the empty strata are named on the population line', () => {
    const p = lineStarting(textOf(ctx.home), 'population: reconstructed ');
    assert.ok(p.includes('strata=4 empty=parser,global-config,script,docs'));
  });

  it('--since and --until select units by start and count the rest out of the period', () => {
    const doc = json(ctx.home, ['tier', '--since', '2026-10-02', '--until', '2026-10-03']);
    assert.equal(doc.counts.units, 4);
    assert.equal(doc.period.mode, 'range');
    const t = textOf(ctx.home, ['tier', '--since', '2026-10-02', '--until', '2026-10-03']);
    assert.ok(lineStarting(t, 'period: ').startsWith('period: from 2026-10-02 to 2026-10-03 inclusive, tz=UTC (units by start;'));
  });
});

describe('inferred tiers (D-02, D-03, TIER-02) on the tier fixture (02-08 Task 2)', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildTierHome({ home: ctx.home, root: ctx.root });
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
  });
  after(() => ctx.cleanup());

  it('by default the inferred unit is in no row and is counted; --include-inferred puts it in the B row with the expected figures', () => {
    const def = json(ctx.home);
    const inc = json(ctx.home, ['tier', '--include-inferred']);
    assert.equal(def.include_inferred, false);
    assert.equal(inc.include_inferred, true);
    const keyB = idOfInferred();
    assert.ok(!rowOf(def, 'gate-or-hook', 'B').evidence_ids.includes(buildUnitEvidenceId(keyB)));
    assert.ok(rowOf(inc, 'gate-or-hook', 'B').evidence_ids.includes(buildUnitEvidenceId(keyB)));
    for (const [doc, exp] of [[def, E.strata], [inc, E.withInferred.strata]]) {
      const r = rowOf(doc, 'gate-or-hook', 'B');
      const e = expRow(exp, 'gate-or-hook', 'B');
      assert.deepEqual([r.n, r.costed, r.tokens.median, r.tokens.p75], [e.n, e.costed, e.tokens_median, e.tokens_p75]);
    }
    assert.equal(stratumOf(def, 'gate-or-hook').inferred_excluded, 1);
    assert.equal(stratumOf(inc, 'gate-or-hook').inferred_excluded, 0);
    assert.equal(def.counts.inferred_excluded, 1);
    assert.equal(inc.counts.inferred_excluded, 0);
    assert.equal(rowOf(inc, 'gate-or-hook', 'B').costed, 11);
  });

  it('the scope line says include_inferred=yes with the circularity note; the ? row never gains the inferred unit', () => {
    const t = textOf(ctx.home, ['tier', '--include-inferred']);
    assert.equal(lineStarting(t, 'scope: '), 'scope: link_confidence=medium include_inferred=yes min_n=10 unit_filters=none call_filters=none '
      + '(tiers inferred from probe files are compared; such tiers are circular with catch, TIER-02)');
    const inc = json(ctx.home, ['tier', '--include-inferred']);
    assert.equal(rowOf(inc, 'gate-or-hook', '?').n, 2);
  });

  it('a default run after an --include-inferred run prints stdout byte-identical to the default run before it', () => {
    const before1 = cli(ctx.home, ['tier']).stdout;
    cli(ctx.home, ['tier', '--include-inferred']);
    assert.equal(cli(ctx.home, ['tier']).stdout, before1);
    const beforeJson = cli(ctx.home, ['tier', '--json']).stdout;
    cli(ctx.home, ['tier', '--include-inferred', '--json']);
    assert.equal(cli(ctx.home, ['tier', '--json']).stdout, beforeJson);
  });
});

describe('concurrent tier runs on a stale derived.db (TIER-02 concurrency, 02-08 Task 2)', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildTierHome({ home: ctx.home, root: ctx.root });
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
    assert.equal(cli(ctx.home, ['tier']).status, 0);
  });
  after(() => ctx.cleanup());

  it('two runs spawned together, one with --include-inferred, both exit 0 and match a serial run with the same flags', async () => {
    assert.equal(cli(ctx.home, ['ingest']).status, 0, 'a second ingest changes the store fingerprint, so derived.db is stale');
    const env = envOf(ctx.home);
    const [a, b] = await Promise.all([
      runCliAsync(['tier', '--json', '--include-inferred'], { home: ctx.home, env }),
      runCliAsync(['tier', '--json'], { home: ctx.home, env }),
    ]);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(a.stdout, cli(ctx.home, ['tier', '--json', '--include-inferred']).stdout);
    assert.equal(b.stdout, cli(ctx.home, ['tier', '--json']).stdout);
  });
});

describe('--link-confidence low on the tier fixture (D-13, 02-08 Task 2)', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildTierHome({ home: ctx.home, root: ctx.root });
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
  });
  after(() => ctx.cleanup());

  it('low mode adds the low-only scope to its one unit: the B row figures equal the low-mode expectation and the scope line says widened', () => {
    const doc = json(ctx.home, ['tier', '--link-confidence', 'low']);
    assert.equal(doc.link_confidence, 'low');
    const r = rowOf(doc, 'gate-or-hook', 'B');
    const e = expRow(E.low.strata, 'gate-or-hook', 'B');
    assert.deepEqual([r.n, r.costed, r.tokens.median, r.tokens.p75], [e.n, e.costed, e.tokens_median, e.tokens_p75]);
    assert.notEqual(r.tokens.median, rowOf(json(ctx.home), 'gate-or-hook', 'B').tokens.median);
    const t = textOf(ctx.home, ['tier', '--link-confidence', 'low']);
    assert.equal(lineStarting(t, 'scope: '), 'scope: link_confidence=low include_inferred=no min_n=10 unit_filters=none call_filters=none '
      + '(widened: a scope with no high or medium link counts its one low-confidence unit)');
  });

  it('the attribution line sums to its total in both modes and the buckets equal the fixture', () => {
    for (const mode of ['medium', 'low']) {
      const a = json(ctx.home, ['tier', '--link-confidence', mode]).attribution;
      assert.equal(a.check, 'ok');
      assert.equal(a.attributed.calls + a.unattributed_overlap.calls + a.unlinked.calls, a.total.calls);
      assert.equal(a.attributed.tokens + a.unattributed_overlap.tokens + a.unlinked.tokens, a.total.tokens);
      assert.deepEqual([a.attributed.calls, a.attributed.tokens], E.buckets[mode].attributed);
      assert.deepEqual([a.unattributed_overlap.calls, a.unattributed_overlap.tokens], E.buckets[mode].overlap);
    }
  });

  it('the overlap scope is in unattributed_overlap and in neither unit cost', () => {
    const doc = json(ctx.home);
    const sumOverlap = E.tokens.overlap.reduce((x, y) => x + y, 0);
    assert.ok(doc.attribution.unattributed_overlap.tokens >= sumOverlap);
    const ga1 = TIER_SPEC.find((s) => s.id === 'ga1');
    const units = json(ctx.home, ['units']);
    assert.equal(units.units.find((u) => u.native_id === ga1.idFull).cost.tokens, ga1.tokens);
  });

  it('an invalid mode exits 2 with the fixed message and nothing on stdout', () => {
    const r = cli(ctx.home, ['tier', '--link-confidence', 'high']);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes('the --link-confidence value must be medium or low'));
    assert.ok(!r.stderr.includes('high'));
  });
});

describe('confounders changed in the comparison window (TRUST-06, 02-08 Task 2)', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildTierHome({ home: ctx.home, root: ctx.root });
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
  });
  after(() => ctx.cleanup());

  it('gate-or-hook shows model and unit_size changed, the seven env names unknown and unchanged=7', () => {
    const line = lineStarting(textOf(ctx.home), 'confounders: gate-or-hook ');
    assert.ok(line, 'a confounders line for gate-or-hook');
    const sm = E.confounders.sizeMedians;
    assert.ok(line.startsWith('confounders: gate-or-hook A,B,C window=2026-10-01..2026-10-17 unknown_dates=0 changed: model ('));
    assert.ok(line.includes(`model (A: ${modelText(E.models.m1)}, ${E.models.m2}; B: ${E.models.unpriced}, ${E.models.m1}; C: ${E.models.m1})`));
    assert.ok(line.includes(`unit_size (median lines A: ${sm.A}; B: ${sm.B}; C: ${sm.C})`));
    assert.ok(line.includes('; unknown: gsd_version (30 of 30 units), base_sha (30 of 30 units), local_mods_head (30 of 30 units), hooks_sha (30 of 30 units), hook_events (30 of 30 units), model_default (30 of 30 units), advisor_model (30 of 30 units); '));
    assert.ok(line.endsWith('partly unknown: none; unchanged=7'));
  });

  it('--json carries every entry in CONFOUNDER_NAMES order with its status', () => {
    const doc = json(ctx.home);
    const c = stratumOf(doc, 'gate-or-hook').confounders;
    assert.equal(c.status, 'compared');
    assert.deepEqual(c.sides, ['A', 'B', 'C']);
    assert.deepEqual(c.entries.map((e) => e.name), [...CONFOUNDER_NAMES]);
    const by = (s) => c.entries.filter((e) => e.status === s).map((e) => e.name);
    assert.deepEqual(by('changed'), E.confounders.changed);
    assert.deepEqual(by('unknown'), E.confounders.unknown);
    assert.deepEqual(by('unchanged').sort(), [...E.confounders.unchanged].sort());
    assert.equal(c.unchanged, 7);
    assert.deepEqual(c.window, { first_day: '2026-10-01', last_day: '2026-10-17', unknown_dates: 0 });
  });

  it('a stratum with fewer than two compared sides has status no-comparison and no entries', () => {
    const c = stratumOf(json(ctx.home), 'security').confounders;
    assert.equal(c.status, 'no-comparison');
    assert.deepEqual(c.entries, []);
  });

  it('planted env snapshots: one before every unit start makes gsd_version unchanged; a second between two starts makes it changed', async () => {
    const plant = makeHome();
    try {
      buildTierHome({ home: plant.home, root: plant.root });
      assert.equal(cli(plant.home, ['ingest']).status, 0);
      const w = new DatabaseSync(join(stateDirOf(plant.home), 'store.db'));
      try {
        const run = w.prepare("INSERT INTO ingest_run (run_id, started_utc, ended_utc, trigger) VALUES (?, ?, ?, 'test')");
        const snap = w.prepare("INSERT INTO env_snapshot (run_id, taken_utc, gsd_version, gsd_version_source) VALUES (?, ?, ?, 'version-file')");
        run.run(101, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:01.000Z');
        snap.run(101, '2026-09-30T00:00:00.000Z', '9.9.1');
      } finally {
        w.close();
      }
      const { rebuildDerived } = await import('../../src/derive/rebuild.mjs');
      rebuildDerived({ home: plant.home });
      const entry = (doc) => stratumOf(doc, 'gate-or-hook').confounders.entries.find((e) => e.name === 'gsd_version');
      assert.equal(entry(json(plant.home)).status, 'unchanged');
      const w2 = new DatabaseSync(join(stateDirOf(plant.home), 'store.db'));
      try {
        w2.prepare("INSERT INTO ingest_run (run_id, started_utc, ended_utc, trigger) VALUES (?, ?, ?, 'test')").run(102, '2026-10-09T12:00:00.000Z', '2026-10-09T12:00:01.000Z');
        w2.prepare("INSERT INTO env_snapshot (run_id, taken_utc, gsd_version, gsd_version_source) VALUES (?, ?, ?, 'version-file')").run(102, '2026-10-09T12:00:00.000Z', '9.9.2');
      } finally {
        w2.close();
      }
      rebuildDerived({ home: plant.home });
      const changed = entry(json(plant.home));
      assert.equal(changed.status, 'changed');
      const seen = new Set(changed.sides.flatMap((s) => s.values));
      assert.deepEqual([...seen].sort(), [JSON.stringify(['9.9.1']), JSON.stringify(['9.9.2'])]);
    } finally {
      plant.cleanup();
    }
  });
});

describe('ranked leads with evidence ids (TRUST-08, 02-08 Task 2)', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildTierHome({ home: ctx.home, root: ctx.root });
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
  });
  after(() => ctx.cleanup());

  it('the three gate-or-hook pairs are ordered as the fixture expects, with sentences and median-unit ids', () => {
    const doc = json(ctx.home);
    assert.equal(doc.leads.length, E.leads.length);
    assert.equal(doc.leads_omitted, 0);
    for (const [i, l] of doc.leads.entries()) {
      const e = E.leads[i];
      assert.equal(l.rank, i + 1);
      assert.equal(l.stratum, e.stratum);
      assert.deepEqual(l.tiers, e.tiers);
      assert.deepEqual(l.costed, e.costed);
      assert.deepEqual(l.median_tokens, e.median_tokens);
      assert.equal(l.gap_tokens, e.gap_tokens);
      assert.deepEqual(l.evidence_ids, e.median_keys.map((k) => buildUnitEvidenceId(k)));
      assert.ok(l.sentence.includes(`(costed n=${e.costed[0]} vs ${e.costed[1]}`));
      assert.ok(l.confounders_changed.includes('model') && l.confounders_changed.includes('unit_size'));
    }
  });

  it('every lead id resolves through spawned evidence with exit 0', () => {
    const doc = json(ctx.home);
    for (const l of doc.leads) {
      for (const id of l.evidence_ids) {
        const r = cli(ctx.home, ['evidence', id]);
        assert.equal(r.status, 0, `${id}: ${r.stderr}`);
      }
    }
  });

  it('the text prints the leads: line, the ranked sentences and no omitted line', () => {
    const lines = linesOf(textOf(ctx.home));
    const at = lines.findIndex((l) => l.startsWith('leads: '));
    assert.equal(lines[at], "leads: 3 of 3 (ordered by the smaller side's costed n, then the median token gap, then stratum and tier order)");
    assert.match(lines[at + 1], /^ {2}1\. In risk stratum gate-or-hook, tier A units cost a median of 910 tokens fewer than tier B \(2250 vs 3160 tokens; notional /);
    assert.match(lines[at + 2], /^ {2}2\. In risk stratum gate-or-hook, tier B units cost a median of 640 tokens more than tier C /);
    assert.match(lines[at + 3], /^ {2}3\. In risk stratum gate-or-hook, tier A units cost a median of 270 tokens fewer than tier C /);
    assert.equal(lines.length, at + 4);
  });

  it('--include-inferred changes the B median and so the leads, as the fixture expects', () => {
    const doc = json(ctx.home, ['tier', '--include-inferred']);
    assert.deepEqual(doc.leads.map((l) => [l.tiers.join('-'), l.gap_tokens]), E.leadsWithInferred.map((l) => [l.tiers.join('-'), l.gap_tokens]));
  });
});

describe('no score, no pooled figure, no verdict in the tier output (TRUST-08, D-18, 02-08 Task 2)', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildTierHome({ home: ctx.home, root: ctx.root });
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
  });
  after(() => ctx.cleanup());

  // The `freshness` block is the report-trust block every document shares (its `verdict` is whether the sources are current,
  // not a verdict on a tier), so its subtree is not scanned; everything else is.
  const walk = (v, out = []) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, out));
    else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); if (k !== 'freshness') walk(x, out); }
    return out;
  };

  it('the document, stratum, row and lead keys are the frozen lists and no key is forbidden', async () => {
    const { LEAD_KEYS } = await import('../../src/report/leads.mjs');
    const doc = json(ctx.home);
    const raw = JSON.parse(cli(ctx.home, ['tier', '--json']).stdout);
    assert.deepEqual(Object.keys(raw), [...TIER_KEYS.document]);
    for (const p of raw.populations) assert.deepEqual(Object.keys(p), [...TIER_KEYS.population]);
    assert.deepEqual(Object.keys(doc.counts), [...TIER_KEYS.counts]);
    for (const st of doc.strata) {
      assert.deepEqual(Object.keys(st), [...TIER_KEYS.stratum]);
      for (const r of st.rows) assert.deepEqual(Object.keys(r), [...TIER_KEYS.row]);
    }
    for (const l of doc.leads) assert.deepEqual(Object.keys(l), [...LEAD_KEYS]);
    for (const k of walk(doc).filter((x) => x !== 'freshness')) assert.ok(!FORBIDDEN_KEYS.includes(k), `forbidden key ${k}`);
    const empty = makeHome();
    try {
      for (const k of walk(json(empty.home))) assert.ok(!FORBIDDEN_KEYS.includes(k), `forbidden key ${k} on the empty HOME`);
    } finally {
      empty.cleanup();
    }
  });

  it('the whole tier text has no word of the forbidden vocabulary', () => {
    for (const args of [['tier'], ['tier', '--include-inferred'], ['tier', '--link-confidence', 'low']]) {
      const words = textOf(ctx.home, args).toLowerCase().match(/[a-z]+/g);
      for (const w of words) assert.ok(!FORBIDDEN_WORDS.includes(w), `forbidden word ${w} in ${args.join(' ')}`);
    }
  });

  it('every lead names one stratum and two letters, and no line or key aggregates a tier across strata', () => {
    const doc = json(ctx.home);
    for (const l of doc.leads) {
      assert.ok(doc.strata.some((s) => s.stratum === l.stratum));
      assert.equal(l.tiers.length, 2);
    }
    assert.ok(!Object.keys(doc).some((k) => ['total_cost', 'pooled', 'all_strata'].includes(k)));
  });
});

// ---- Task 3: the RPT-01 filters and --evidence on tier ------------------------------------------------------------------
describe('tier filters (RPT-01, D-19, D-02) on the tier fixture (02-08 Task 3)', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildTierHome({ home: ctx.home, root: ctx.root });
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
  });
  after(() => ctx.cleanup());

  const costedTotal = TIER_SPEC.filter((s) => s.costed).length;
  const rowTiers = (doc, name) => stratumOf(doc, name).rows.map((r) => r.tier);

  it('--repo selects units by repo name; a repo no unit has prints no units', () => {
    assert.equal(json(ctx.home, ['tier', '--repo', E.repoName]).counts.units, TIER_SPEC.length);
    assert.equal(json(ctx.home, ['tier', '--repo', E.repoKey]).counts.units, TIER_SPEC.length);
    const none = cli(ctx.home, ['tier', '--repo', 'norepo']);
    assert.equal(none.status, 0);
    assert.ok(linesOf(none.stdout).includes('no units'));
  });

  it('--tier A,? prints only the A and ? rows and no lead; --tier ? prints only ? rows and leads: none', () => {
    const doc = json(ctx.home, ['tier', '--tier', 'A,?']);
    assert.deepEqual(rowTiers(doc, 'gate-or-hook'), ['A', '?']);
    assert.equal(doc.counts.units, TIER_SPEC.filter((s) => s.tier === 'A' || (s.tier === null && !s.probes)).length);
    assert.deepEqual(doc.leads, []);
    const q = json(ctx.home, ['tier', '--tier', '?']);
    assert.deepEqual(rowTiers(q, 'gate-or-hook'), ['?']);
    assert.deepEqual(q.filters.unit.tier, [null]);
    const t = textOf(ctx.home, ['tier', '--tier', '?']);
    assert.ok(linesOf(t).includes('leads: none (no stratum has two tier sides with attributed cost)'));
    assert.equal(lineStarting(t, 'scope: '), 'scope: link_confidence=medium include_inferred=no min_n=10 unit_filters=tier=? call_filters=none');
  });

  it('--framework and --runtime select units: gsd-core keeps all, ? runtime keeps the units with no linked transcript', () => {
    assert.equal(json(ctx.home, ['tier', '--framework', 'gsd-core']).counts.units, TIER_SPEC.length);
    assert.equal(json(ctx.home, ['tier', '--framework', 'nothing']).counts.units, 0);
    assert.equal(json(ctx.home, ['tier', '--runtime', '?']).counts.units, TIER_SPEC.filter((s) => !s.costed).length);
    assert.equal(json(ctx.home, ['tier', '--runtime', 'claude-code']).counts.units, costedTotal);
  });

  it('--model selects calls: the one unit with M2 calls stays and its row counts only those calls; the scope line says so', () => {
    const doc = json(ctx.home, ['tier', '--model', E.models.m2]);
    assert.equal(doc.counts.units, 1);
    const r = rowOf(doc, 'gate-or-hook', 'A');
    const ga3 = TIER_SPEC.find((s) => s.id === 'ga3');
    assert.deepEqual([r.n, r.costed, r.tokens.median], [1, 1, ga3.tokens]);
    const t = textOf(ctx.home, ['tier', '--model', E.models.m2]);
    assert.equal(lineStarting(t, 'scope: '), `scope: link_confidence=medium include_inferred=no min_n=10 unit_filters=none call_filters=model=${E.models.m2} `
      + '(cost columns count matching calls only; confounders describe all attributed calls)');
  });

  it('--role main drops the units with no attributed call of that role; the attribution line sums to its total under every filter', () => {
    const doc = json(ctx.home, ['tier', '--role', E.main.role]);
    assert.equal(doc.counts.units, costedTotal);
    for (const args of [['--role', 'main'], ['--model', E.models.m1], ['--model', E.models.m2], ['--tier', 'B'], ['--repo', 'norepo']]) {
      const a = json(ctx.home, ['tier', ...args]).attribution;
      assert.equal(a.check, 'ok', args.join(' '));
      assert.equal(a.attributed.calls + a.unattributed_overlap.calls + a.unlinked.calls, a.total.calls, args.join(' '));
    }
    const m = json(ctx.home, ['tier', '--model', E.models.m2]).attribution;
    assert.equal(m.total.calls, 2, 'the attribution line follows the call filters');
  });

  it('invalid values exit 2 with nothing on stdout, the fixed message and no echo of the value', () => {
    const bad = [['--tier', ''], ['--tier', 'A,A'], ['--tier', 'Q;x'], ['--tier', 'A\u0001'], ['--model', Array.from({ length: 17 }, (_, i) => `m${i}`).join(',')],
      ['--framework', '?'], ['--role', 'a b'], ['--link-confidence', 'zz'], ['--repo', 'x y']];
    for (const [flag, value] of bad) {
      const r = cli(ctx.home, ['tier', flag, value]);
      assert.equal(r.status, 2, `${flag} ${JSON.stringify(value).slice(0, 20)}`);
      assert.equal(r.stdout, '');
      if (value.length > 1) assert.ok(!r.stderr.includes(value), `${flag} value echoed`);
    }
  });

  it('--json carries filters and two runs print byte-identical stdout', () => {
    const doc = json(ctx.home, ['tier', '--tier', 'A,?', '--model', E.models.m1]);
    assert.deepEqual(doc.filters, { unit: { repo: null, tier: ['A', null], framework: null, runtime: null }, call: { model: [E.models.m1], role: null } });
    const a = cli(ctx.home, ['tier', '--tier', 'A,?', '--json']).stdout;
    assert.equal(a, cli(ctx.home, ['tier', '--tier', 'A,?', '--json']).stdout);
  });

  it('--evidence lists a unit u: id per row after the leads, with the heading; --json always carries evidence_ids', () => {
    const lines = linesOf(textOf(ctx.home, ['tier', '--evidence']));
    const at = lines.indexOf("evidence (units per row; run rigorscope evidence ID for a unit's calls):");
    assert.ok(at > 0);
    const rest = lines.slice(at + 1);
    const total = E.strata.reduce((n, st) => n + ['A', 'B', 'C', '?'].reduce((m, t) => m + st.rows[t].n, 0), 0);
    assert.equal(rest.length, total);
    const firstKey = expRow(E.strata, 'gate-or-hook', 'A').keys[0];
    assert.equal(rest[0], `  reconstructed gate-or-hook A ${buildUnitEvidenceId(firstKey)}`);
    assert.ok(rest.every((l) => /^ {2}reconstructed [a-z-]+ [ABC?] u[:]/.test(l)));
    assert.ok(!linesOf(textOf(ctx.home)).includes("evidence (units per row; run rigorscope evidence ID for a unit's calls):"));
    assert.ok(json(ctx.home).strata[0].rows[0].evidence_ids.length > 0);
  });
});
