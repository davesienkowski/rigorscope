// Plan 03-04 (TRUST-03, D-15, LEDG-08; threat T-03-40, T-03-42): no row, line or JSON figure adds forward and reconstructed units
// or calls into one, and a coverage target is a line beside n, never a verdict. The checks are local functions proven able to fail
// on a violation fixture first (the way no-score.test.mjs does), then run over the real `units`, `tier` and `cost` documents and
// texts of a temporary HOME. Nothing here touches the real ~/.rigorscope.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  cliEnv, ingestHome, makeHome, runCli,
} from '../fixtures/build.mjs';
import {
  A1, STRATA_NOW, buildStrataHome, declaredAtClose, planAtStart,
} from '../fixtures/strata-home.mjs';
import { FORBIDDEN_KEYS, FORBIDDEN_WORDS } from './no-score.test.mjs';

const POPS = ['forward', 'reconstructed'];
const UNIT_DIMS = ['tier', 'unit', 'framework'];

// -> a list of violation codes for one document or text. kind: units | tier | cost; doc and text are the --json and plain outputs.
export function pooledViolations(kind, { doc, text }) {
  const v = [];
  const lines = (text ?? '').split('\n');
  if (kind === 'units') {
    if (Object.hasOwn(doc, 'counts')) v.push('top_level_counts');
    const names = (doc.strata ?? []).map((s) => s.population);
    if (names.some((n) => !POPS.includes(n)) || new Set(names).size !== names.length) v.push('unknown_or_repeated_stratum');
    if (lines.filter((l) => l.startsWith('units: ')).length !== (doc.strata ?? []).length) v.push('units_line_per_stratum');
  } else if (kind === 'tier') {
    for (const k of ['counts', 'strata', 'leads', 'leads_omitted']) if (Object.hasOwn(doc, k)) v.push(`top_level_${k}`);
    for (const p of doc.populations ?? []) {
      const own = new Set(p.strata.flatMap((st) => st.rows.flatMap((r) => r.evidence_ids)));
      const others = new Set((doc.populations ?? []).filter((q) => q !== p).flatMap((q) => q.strata.flatMap((st) => st.rows.flatMap((r) => r.evidence_ids))));
      for (const id of own) if (others.has(id)) v.push('unit_in_two_populations');
      for (const l of p.leads) if (l.evidence_ids.some((id) => others.has(id) && !own.has(id))) v.push('lead_crosses_populations');
    }
  } else if (kind === 'cost') {
    if (doc.by.some((d) => UNIT_DIMS.includes(d)) && !doc.by.includes('population')) v.push('unit_dimension_without_population');
    if (doc.by.some((d) => UNIT_DIMS.includes(d)) && doc.sections.main.rows.some((r) => !Object.hasOwn(r.dims, 'population'))) v.push('row_without_population');
  }
  if (lines.some((l) => /^population: (all|mixed)\b/.test(l))) v.push('pooled_population_line');
  return v;
}

// -> violation codes for the coverage and target lines of a units text and document.
export function verdictViolations({ doc, text }) {
  const v = [];
  for (const l of (text ?? '').split('\n').filter((x) => x.startsWith('coverage: '))) {
    for (const w of l.toLowerCase().split(/[^a-z]+/)) if (FORBIDDEN_WORDS.includes(w)) v.push(`word_${w}`);
    if (/\b(met|missed|reached|not met)\b/i.test(l)) v.push('target_verdict');
  }
  for (const s of doc?.strata ?? []) {
    const keys = Object.keys(s.coverage ?? {});
    for (const k of keys) if (FORBIDDEN_KEYS.includes(k)) v.push(`key_${k}`);
    if (keys.includes('combined') || keys.includes('total_share')) v.push('folded_coverage');
  }
  return v;
}

// Review fix HIGH-1 (TRUST-03, D-15): a figure that adds both populations (the whole-store attribution and links lines, the window
// totals) is never printed without its label; the window splits forward-attributed from reconstructed-attributed calls.
export const WHOLE_STORE_LABEL = 'whole store, both populations (not a stratum figure)';
export const WINDOW_LABEL = 'by bucket, not a stratum figure';
export function wholeStoreViolations({ doc, text }) {
  const v = [];
  for (const l of (text ?? '').split('\n')) {
    for (const key of ['attribution', 'links']) {
      if (l.startsWith(`${key}: `) && !l.startsWith(`${key}: ${WHOLE_STORE_LABEL} `)) v.push(`unlabeled_${key}_line`);
    }
    if (l.startsWith('window: ') && !l.includes(WINDOW_LABEL)) v.push('unlabeled_window_line');
  }
  for (const key of ['attribution', 'links']) {
    if (doc && doc[key] && doc[key].scope !== WHOLE_STORE_LABEL) v.push(`unlabeled_${key}_json`);
  }
  const b = doc?.window?.buckets;
  if (b && (Object.hasOwn(b, 'attributed') || !Object.hasOwn(b, 'attributed_forward') || !Object.hasOwn(b, 'attributed_reconstructed'))) v.push('pooled_window_bucket');
  return v;
}

describe('violation fixtures prove the checks can fail', () => {
  it('no pooled stratum: the whole-store attribution and links lines and the window need their labels (violation fixtures)', () => {
    assert.ok(wholeStoreViolations({ doc: {}, text: 'attribution: link_confidence=medium section=main attributed=1/2/3' }).includes('unlabeled_attribution_line'));
    assert.ok(wholeStoreViolations({ doc: {}, text: 'links: scopes=3 refs_unknown=0' }).includes('unlabeled_links_line'));
    assert.ok(wholeStoreViolations({ doc: { attribution: { link_confidence: 'medium' } }, text: '' }).includes('unlabeled_attribution_json'));
    assert.ok(wholeStoreViolations({ doc: { links: { scopes: 1 } }, text: '' }).includes('unlabeled_links_json'));
    assert.ok(wholeStoreViolations({ doc: {}, text: 'window: since 2026-10-28T12:00:00.000Z total=3/1.0' }).includes('unlabeled_window_line'));
    assert.ok(wholeStoreViolations({ doc: { window: { buckets: { attributed: {}, unlinked: {} } } }, text: '' }).includes('pooled_window_bucket'));
    assert.deepEqual(wholeStoreViolations({
      doc: { attribution: { scope: WHOLE_STORE_LABEL }, links: { scope: WHOLE_STORE_LABEL }, window: { buckets: { attributed_forward: {}, attributed_reconstructed: {} } } },
      text: `attribution: ${WHOLE_STORE_LABEL} link_confidence=medium\nlinks: ${WHOLE_STORE_LABEL} scopes=1\nwindow: since x ${WINDOW_LABEL}: a=1`,
    }), []);
  });
  it('no pooled stratum: a summed top-level n, a merged tier lead and a cost row without population are all flagged', () => {
    assert.ok(pooledViolations('units', { doc: { counts: { units: 5 }, strata: [{ population: 'forward' }] }, text: 'units: n=5' }).includes('top_level_counts'));
    const merged = {
      populations: [
        { population: 'forward', strata: [{ rows: [{ evidence_ids: ['u:1'] }] }], leads: [{ evidence_ids: ['u:1', 'u:2'] }] },
        { population: 'reconstructed', strata: [{ rows: [{ evidence_ids: ['u:2'] }] }], leads: [] },
      ],
    };
    assert.ok(pooledViolations('tier', { doc: merged, text: '' }).includes('lead_crosses_populations'));
    assert.ok(pooledViolations('cost', { doc: { by: ['tier'], sections: { main: { rows: [{ dims: { tier: {} } }] } } }, text: '' }).includes('unit_dimension_without_population'));
    assert.ok(pooledViolations('units', { doc: { strata: [{ population: 'forward' }] }, text: 'population: all n=3\nunits: n=3' }).includes('pooled_population_line'));
  });
  it('targets are lines not verdicts: a met word, a forbidden word and a folded coverage key are all flagged', () => {
    assert.ok(verdictViolations({ doc: {}, text: 'coverage: forward tiered=9/10 (90.00%) target 90% met' }).includes('target_verdict'));
    assert.ok(verdictViolations({ doc: {}, text: 'coverage: forward overall=1/2' }).includes('word_overall'));
    assert.ok(verdictViolations({ doc: { strata: [{ coverage: { score: 1 } }] }, text: '' }).includes('key_score'));
    assert.ok(verdictViolations({ doc: { strata: [{ coverage: { combined: 1 } }] }, text: '' }).includes('folded_coverage'));
  });
});

// Plan 03-05 (carried from 03-04): the --sheet documents and texts hold no row, count or line that adds forward and reconstructed.
export function sheetPooledViolations({ doc, text }) {
  const v = [];
  const rows = doc?.sheet ?? [];
  for (const r of rows) {
    if (!['forward', 'reconstructed', 'not-unit-level'].includes(r.population)) v.push(`row_population_${r.population}`);
    if (/forward and reconstructed|both populations|all units/i.test(`${r.question} ${r.reason}`)) v.push(`row_pools_${r.id}`);
  }
  for (const k of Object.keys(doc ?? {})) if (/sheet_(count|total)|rows_can/.test(k)) v.push(`doc_key_${k}`);
  for (const l of (text ?? '').split('\n')) {
    if (/^ {2}[a-z-]+: (cannot|can decide today);/.test(l) && /population=(all|mixed)\b/.test(l)) v.push('row_line_pooled');
    if (/^sheet: .*\d+ (rows|questions)/.test(l)) v.push('sheet_header_counts');
  }
  return v;
}

describe('the sheet pooled-population walk can fail (03-05 violation fixtures)', () => {
  it('a row with a pooled population, a pooling sentence and a counting key are all flagged', () => {
    assert.ok(sheetPooledViolations({ doc: { sheet: [{ id: 'x', population: 'all', question: 'q', reason: 'r' }] }, text: '' }).includes('row_population_all'));
    assert.ok(sheetPooledViolations({ doc: { sheet: [{ id: 'x', population: 'forward', question: 'q', reason: 'forward and reconstructed units' }] }, text: '' }).includes('row_pools_x'));
    assert.ok(sheetPooledViolations({ doc: { sheet_total: 3, sheet: [] }, text: '' }).includes('doc_key_sheet_total'));
    assert.ok(sheetPooledViolations({ doc: {}, text: 'sheet: 7 rows' }).includes('sheet_header_counts'));
    assert.ok(sheetPooledViolations({ doc: {}, text: '  units-x: cannot; n=1; population=all; low_evidence=yes' }).includes('row_line_pooled'));
  });
});

describe('the real reports (03-04)', () => {
  let ctx;
  const env = () => cliEnv(ctx.home, { TZ: 'UTC', RIGORSCOPE_NOW: STRATA_NOW });
  const run = (args) => {
    const r = runCli(args, { home: ctx.home, env: env() });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  before(async () => {
    ctx = makeHome();
    buildStrataHome({
      home: ctx.home,
      root: ctx.root,
      texts: [planAtStart('261030-a1b', '2026-10-28T12:00:00.000Z'), ...declaredAtClose('261029-c2d', '2026-10-28T13:00:00.000Z', '2026-10-28T14:00:00.000Z')],
    });
    await ingestHome(ctx.home, env());
  });
  after(() => ctx.cleanup());

  it('no pooled stratum: units, tier and cost documents and texts have no merged figure', () => {
    for (const kind of ['units', 'tier']) {
      const doc = JSON.parse(run([kind, '--json']));
      assert.deepEqual(pooledViolations(kind, { doc, text: run([kind]) }), [], kind);
      assert.deepEqual(wholeStoreViolations({ doc, text: run([kind]) }), [], `${kind} whole-store labels`);
      for (const sel of POPS) {
        const sdoc = JSON.parse(run([kind, '--json', '--population', sel]));
        const stext = run([kind, '--population', sel]);
        assert.deepEqual(pooledViolations(kind, { doc: sdoc, text: stext }), [], `${kind} ${sel}`);
        assert.deepEqual(wholeStoreViolations({ doc: sdoc, text: stext }), [], `${kind} ${sel} whole-store labels`);
      }
    }
    for (const by of ['tier', 'unit', 'framework', 'role,tier']) {
      assert.deepEqual(pooledViolations('cost', { doc: JSON.parse(run(['cost', '--by', by, '--json', '--since', '2026-10-01', '--until', '2026-11-01'])), text: '' }), [], by);
    }
    assert.ok(A1.includes('a1b'));
  });

  it('no pooled stratum: the --sheet documents and texts of units, tier and cost hold no merged row', () => {
    for (const kind of ['units', 'tier', 'cost']) {
      const doc = JSON.parse(run([kind, '--json', '--sheet']));
      const text = run([kind, '--sheet']);
      assert.ok(doc.sheet.length >= 3, kind);
      assert.deepEqual(sheetPooledViolations({ doc, text }), [], kind);
      if (kind !== 'cost') assert.deepEqual(pooledViolations(kind, { doc, text }), [], `${kind} with the sheet`);
      if (kind !== 'cost') assert.deepEqual(wholeStoreViolations({ doc, text }), [], `${kind} whole-store labels with the sheet`);
    }
  });

  it('targets are lines not verdicts: the coverage lines and keys of the real units report carry none', () => {
    assert.deepEqual(verdictViolations({ doc: JSON.parse(run(['units', '--json'])), text: run(['units']) }), []);
    assert.ok(run(['units']).split('\n').some((l) => l.includes('target 90%')));
  });
});
