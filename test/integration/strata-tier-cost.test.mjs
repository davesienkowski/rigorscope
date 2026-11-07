// Plan 03-04 (TRUST-03, D-04, D-15): `tier` builds each population apart (no row, statistic or lead crosses populations) and a
// forward unit reaches its tier row. Task 2 adds the cost cases to this file. Temporary HOMEs only.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  cliEnv, ingestHome, makeHome, runCli,
} from '../fixtures/build.mjs';
import { buildUnitEvidenceId } from '../../src/measure/rowkey.mjs';
import { stratify } from '../../src/report/tier.mjs';
import {
  A1, C2D, E3F, STRATA_NOW, buildStrataHome, declaredAtClose, planAtStart,
} from '../fixtures/strata-home.mjs';

const env = (home) => cliEnv(home, { TZ: 'UTC', RIGORSCOPE_NOW: STRATA_NOW });
const cli = (ctx, args) => runCli(args, { home: ctx.home, env: env(ctx.home) });
const tierJson = (ctx, args = []) => {
  const r = cli(ctx, ['tier', '--json', ...args]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const idsOf = (pop) => pop.strata.flatMap((st) => st.rows.flatMap((r) => r.evidence_ids));

describe('tier populations (03-04 Task 1)', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    buildStrataHome({
      home: ctx.home,
      root: ctx.root,
      texts: [planAtStart('261030-a1b', '2026-10-28T12:00:00.000Z'), ...declaredAtClose('261029-c2d', '2026-10-28T13:00:00.000Z', '2026-10-28T14:00:00.000Z')],
    });
    await ingestHome(ctx.home, env(ctx.home));
  });
  after(() => ctx.cleanup());

  it('tier --json has populations forward then reconstructed and no top-level counts, strata or leads', () => {
    const doc = tierJson(ctx);
    assert.equal(doc.population, 'all');
    for (const k of ['counts', 'strata', 'leads', 'leads_omitted']) assert.equal(Object.hasOwn(doc, k), false, k);
    assert.deepEqual(doc.populations.map((p) => p.population), ['forward', 'reconstructed']);
    for (const p of doc.populations) {
      for (const k of ['counts', 'declared_at_close', 'costed', 'low_evidence', 'strata', 'empty_strata', 'leads', 'leads_omitted']) {
        assert.ok(Object.hasOwn(p, k), `${p.population} has ${k}`);
      }
    }
  });

  it('forward unit reaches a tier row: the plan-at-start unit is in the C row of the forward population only', () => {
    const doc = tierJson(ctx);
    const [fwd, rec] = doc.populations;
    const a1 = buildUnitEvidenceId(A1);
    assert.ok(idsOf(fwd).includes(a1), 'a1b is in a forward row');
    const row = fwd.strata.flatMap((st) => st.rows).find((r) => r.evidence_ids.includes(a1));
    assert.equal(row.tier, 'C');
    assert.equal(fwd.counts.comparable, 1);
    assert.ok(!idsOf(rec).includes(a1));
    assert.ok(idsOf(rec).includes(buildUnitEvidenceId(E3F)));
    assert.ok(!idsOf(fwd).includes(buildUnitEvidenceId(E3F)));
  });

  it('declared-at-close is shown apart: the close-declared forward unit is in no comparable row, in declared_at_close, and not inferred_excluded', () => {
    const [fwd, rec] = tierJson(ctx).populations;
    const c2d = buildUnitEvidenceId(C2D);
    assert.ok(!idsOf(fwd).includes(c2d) && !idsOf(rec).includes(c2d), 'in no row');
    assert.deepEqual(fwd.declared_at_close, { n: 1, A: 0, B: 1, C: 0, '?': 0 });
    assert.equal(fwd.counts.units, 2, 'still counted in the population');
    assert.equal(fwd.counts.inferred_excluded, 0);
    assert.ok(fwd.strata.every((st) => st.inferred_excluded === 0));
    assert.equal(fwd.strata.reduce((n, st) => n + st.declared_at_close.n, 0), 1, 'the unit is in one risk stratum');
    assert.deepEqual(rec.declared_at_close, { n: 0, A: 0, B: 0, C: 0, '?': 0 });
  });

  it('a reconstructed declared-at-close unit keeps its comparable row exactly once and is not in declared_at_close (stratify)', () => {
    const recon = {
      unit_key: 'u-recon', tier: 'A', tier_signal: 'frontmatter', tier_timing: 'declared-at-close', risk_class: '[]',
    };
    const fwd = {
      unit_key: 'u-fwd', tier: 'B', tier_signal: 'ledger', tier_timing: 'declared-at-close', risk_class: '[]',
    };
    const out = stratify([recon, fwd]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].rows.A.map((u) => u.unit_key), ['u-recon']);
    assert.deepEqual(out[0].rows.B, []);
    assert.equal(out[0].declaredAtClose.n, 1);
    assert.equal(out[0].declaredAtClose.B, 1);
    assert.equal(out[0].inferredExcluded, 0);
  });

  it('the text prints one population line per population with costed and low_evidence, and --population forward gives one block', () => {
    const lines = cli(ctx, ['tier']).stdout.split('\n').filter((l) => l.startsWith('population:'));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^population: forward units=2 .*declared_at_close=1 .*costed=0 low_evidence=yes/);
    assert.match(lines[1], /^population: reconstructed units=1 .*costed=0 low_evidence=yes/);
    const one = cli(ctx, ['tier', '--population', 'forward']).stdout.split('\n').filter((l) => l.startsWith('population:'));
    assert.equal(one.length, 1);
  });
});

// ---- Task 2: cost strata (T-03-25 closed) ---------------------------------------------------------------------------------------
import { TIER_SPEC, REPO_KEY as TIERS_REPO_KEY } from '../fixtures/tier-home.mjs';
import { lineText } from '../fixtures/strata-home.mjs';

describe('cost --by tier carries population first (03-04 Task 2, T-03-25)', () => {
  const OCT = ['--since', '2026-10-01', '--until', '2026-11-01'];
  const GA0 = TIER_SPEC.find((s) => s.id === 'ga0');
  let ctx;
  before(async () => {
    ctx = makeHome();
    buildStrataHome({
      home: ctx.home,
      root: ctx.root,
      base: 'tier',
      texts: [lineText({
        record: 'start', ts: '2026-10-02T07:00:00.000Z', native_id: GA0.idFull, repo_key: TIERS_REPO_KEY, tier: 'C', tier_source: 'plan-at-start',
      })],
    });
    await ingestHome(ctx.home, env(ctx.home));
  });
  after(() => ctx.cleanup());

  const costJson = (args) => {
    const r = cli(ctx, ['cost', ...OCT, ...args, '--json']);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const callsOf = (rows) => rows.reduce((n, r) => n + r.calls, 0);

  it('population is the leading dimension, forward and reconstructed calls are never one row, and the rows sum to the total row', () => {
    const doc = costJson(['--by', 'tier']);
    assert.deepEqual(doc.by, ['population', 'tier']);
    const rows = doc.sections.main.rows;
    assert.ok(rows.every((r) => Object.keys(r.dims)[0] === 'population'));
    const fwdRows = rows.filter((r) => r.dims.population.value === 'forward');
    assert.equal(fwdRows.length, 1);
    assert.equal(fwdRows[0].dims.tier.value, 'C');
    assert.equal(fwdRows[0].calls, 2, 'the two calls of ga0');
    assert.ok(rows.some((r) => r.dims.population.value === 'reconstructed' && r.dims.tier.value === 'A'));
    assert.ok(rows.every((r) => !(r.dims.population.value === 'forward' && r.dims.tier.value === 'A')));
    assert.equal(callsOf(rows), doc.sections.main.total.calls, 'the total row stays the call-level conservation total');
    assert.equal(doc.sections.main.totals_check?.ok ?? true, true);
    assert.equal(rows[0].dims.population.label, 'derived');
    const t = cli(ctx, ['cost', ...OCT, '--by', 'tier']).stdout;
    assert.match(t, /totals check: main OK/);
  });

  it('--by role alone has no population dimension and no populations block', () => {
    const doc = costJson(['--by', 'role']);
    assert.deepEqual(doc.by, ['role']);
    assert.equal(doc.populations, null);
    assert.ok(!cli(ctx, ['cost', ...OCT, '--by', 'role']).stdout.split('\n').some((l) => l.startsWith('population:')));
  });

  it('the footer prints one population line per stratum, forward first, with units, costed and low_evidence', () => {
    const lines = cli(ctx, ['cost', ...OCT, '--by', 'tier']).stdout.split('\n').filter((l) => l.startsWith('population: '));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^population: forward units=1 costed=1 low_evidence=yes /);
    assert.match(lines[1], /^population: reconstructed units=35 costed=\d+ low_evidence=(yes|no) /);
    const doc = costJson(['--by', 'tier']);
    assert.deepEqual(doc.populations.map((p) => [p.population, p.units, p.low_evidence]).slice(0, 1), [['forward', 1, true]]);
    assert.equal(doc.populations.length, 2);
  });

  it('--population forward keeps only calls attributed to forward units; reconstructed keeps the rest of the attributed calls', () => {
    const f = costJson(['--by', 'tier', '--population', 'forward']);
    assert.deepEqual(f.sections.main.rows.map((r) => r.dims.population.value), ['forward']);
    assert.equal(f.sections.main.total.calls, 2);
    assert.deepEqual(f.populations.map((p) => p.population), ['forward']);
    const all = costJson(['--by', 'tier']);
    const r = costJson(['--by', 'tier', '--population', 'reconstructed']);
    assert.ok(r.sections.main.rows.every((x) => x.dims.population.value === 'reconstructed'));
    const attributedAll = callsOf(all.sections.main.rows.filter((x) => ['forward', 'reconstructed'].includes(x.dims.population.value)));
    assert.equal(r.sections.main.total.calls + f.sections.main.total.calls, attributedAll);
    const bad = cli(ctx, ['cost', '--population', 'both']);
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, '');
  });

  it('a unit or framework dimension also brings population first', () => {
    for (const d of ['unit', 'framework']) assert.deepEqual(costJson(['--by', d]).by, ['population', d]);
    assert.deepEqual(costJson(['--by', 'role,tier']).by, ['population', 'role', 'tier']);
    assert.deepEqual(costJson(['--by', 'tier,population']).by, ['tier', 'population'], 'an explicit population keeps the order given');
  });
});
