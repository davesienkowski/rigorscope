// Plan 02-08 (TRUST-08, D-18): the ranked leads, pure. Written before the code (RED). The module is imported inside each test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import('../../src/report/leads.mjs');
const unit = (key, values = {}) => ({
  key, values, start_ms: Date.UTC(2026, 9, 1), end_ms: Date.UTC(2026, 9, 2),
});
const side = (tier, costed, median, over = {}) => ({
  tier, costed, low_evidence: costed < 10, tokens_median: median, usd_median: 1_000_000, median_unit_key: `k-${tier}-${median}`,
  units: [unit(`k-${tier}-${median}`)], ...over,
});
const stratum = (name, sides) => ({ stratum: name, sides });
const FULL = Object.fromEntries(['model', 'effort', 'speed', 'cc_version', 'worker_mode', 'repo', 'gsd_version', 'base_sha', 'local_mods_head', 'hooks_sha',
  'hook_events', 'model_default', 'advisor_model'].map((n) => [n, '["v"]']).concat([['worker_count', 0], ['subagents', 0], ['unit_size', 10]]));

describe('candidateLeads and orderLeads (TRUST-08 boundary)', () => {
  it('one candidate per pair of compared letter sides in each stratum, in pair order A-B, A-C, B-C', async () => {
    const { candidateLeads } = await mod();
    const c = candidateLeads([stratum('gate-or-hook', [side('A', 11, 100), side('B', 10, 200), side('C', 9, 300)])]);
    assert.deepEqual(c.map((x) => x.tiers.join('-')), ['A-B', 'A-C', 'B-C']);
  });
  it('a stratum with fewer than two compared sides has no candidate', async () => {
    const { candidateLeads } = await mod();
    assert.deepEqual(candidateLeads([stratum('security', [side('A', 3, 100)])]), []);
    assert.deepEqual(candidateLeads([]), []);
  });
  it('orders by the smaller side costed count, then the absolute median gap, then stratum order, then pair order', async () => {
    const { candidateLeads, orderLeads } = await mod();
    const strata = [
      stratum('security', [side('A', 5, 100), side('B', 5, 150)]),
      stratum('gate-or-hook', [side('A', 11, 100), side('B', 10, 200), side('C', 9, 120)]),
    ];
    const out = orderLeads(candidateLeads(strata));
    assert.deepEqual(out.map((x) => `${x.stratum}:${x.tiers.join('-')}`), [
      'gate-or-hook:A-B', 'gate-or-hook:B-C', 'gate-or-hook:A-C', 'security:A-B',
    ]);
  });
  it('candidates tied on count and gap are ordered by stratum and then pair order, whatever the input order', async () => {
    const { candidateLeads, orderLeads } = await mod();
    const a = stratum('parser', [side('A', 6, 100), side('B', 6, 150)]);
    const b = stratum('gate-or-hook', [side('A', 6, 100), side('B', 6, 150)]);
    const x = orderLeads(candidateLeads([a, b])).map((l) => l.stratum);
    const y = orderLeads(candidateLeads([b, a])).map((l) => l.stratum);
    assert.deepEqual(x, ['gate-or-hook', 'parser']);
    assert.deepEqual(y, x);
  });
});

describe('buildLeads', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => stratum(['gate-or-hook', 'security', 'parser', 'global-config', 'script', 'docs'][i], [
    side('A', 10 + i, 100), side('B', 10 + i, 150),
  ]));
  it('zero candidates: no leads and omitted 0', async () => {
    const { buildLeads } = await mod();
    assert.deepEqual(buildLeads([], { maxLeads: 5 }), { leads: [], omitted: 0 });
  });
  it('five candidates give five leads and omitted 0; six give five and omitted 1', async () => {
    const { buildLeads, MAX_LEADS } = await mod();
    assert.equal(MAX_LEADS, 5);
    assert.deepEqual([buildLeads(many(5)).leads.length, buildLeads(many(5)).omitted], [5, 0]);
    assert.deepEqual([buildLeads(many(6)).leads.length, buildLeads(many(6)).omitted], [5, 1]);
  });
  it('each lead has exactly the keys of LEAD_KEYS, a rank from 1, one stratum and two letters', async () => {
    const { buildLeads, LEAD_KEYS } = await mod();
    const { leads } = buildLeads(many(2));
    assert.deepEqual(leads.map((l) => l.rank), [1, 2]);
    for (const l of leads) {
      assert.deepEqual(Object.keys(l), [...LEAD_KEYS]);
      assert.equal(typeof l.stratum, 'string');
      assert.equal(l.tiers.length, 2);
      assert.ok(l.tiers.every((t) => ['A', 'B', 'C'].includes(t)));
    }
  });
  it('the sentence names the stratum, tiers, medians, gap with direction, counts, low-evidence sides and the u: ids', async () => {
    const { buildLeads } = await mod();
    const { leads } = buildLeads([stratum('gate-or-hook', [
      side('A', 11, 2250, { units: [unit('ka', FULL)] }), side('B', 9, 3160, { units: [unit('kb', FULL)] }),
    ])]);
    const l = leads[0];
    assert.equal(l.gap_tokens, 910);
    assert.equal(l.direction, 'fewer');
    assert.deepEqual(l.median_tokens, [2250, 3160]);
    assert.deepEqual(l.low_evidence, ['B']);
    assert.equal(l.evidence_ids.length, 2);
    assert.match(l.evidence_ids[0], /^u:/);
    assert.ok(l.sentence.startsWith('In risk stratum gate-or-hook, tier A units cost a median of 910 tokens fewer than tier B (2250 vs 3160 tokens; notional '));
    assert.ok(l.sentence.includes('(costed n=11 vs 9, low evidence on B)'));
    assert.ok(l.sentence.includes('confounders changed: none; unknown: none.'));
    assert.ok(l.sentence.endsWith(`Evidence: ${l.evidence_ids[0]}, ${l.evidence_ids[1]}.`));
  });
  it('an equal median reads as the same and an unknown dollar figure as ?', async () => {
    const { buildLeads } = await mod();
    const { leads } = buildLeads([stratum('docs', [side('B', 10, 500, { usd_median: null }), side('C', 12, 500, { usd_median: null })])]);
    assert.equal(leads[0].direction, 'same');
    assert.equal(leads[0].gap_tokens, 0);
    assert.ok(leads[0].sentence.includes('the same median number of tokens as tier C'));
    assert.ok(leads[0].sentence.includes('notional ? vs ?'));
    assert.deepEqual(leads[0].median_usd, [null, null]);
  });
  it('the confounders of the pair are named: changed and unknown (unknown and partly-unknown)', async () => {
    const { buildLeads } = await mod();
    const a = side('A', 10, 100, { units: [unit('a', { model: '["m1"]', effort: null, repo: '["r"]' })] });
    const b = side('B', 10, 200, { units: [unit('b', { model: '["m2"]', effort: null, repo: '["r"]' })] });
    const { leads } = buildLeads([stratum('gate-or-hook', [a, b])]);
    assert.ok(leads[0].confounders_changed.includes('model'));
    assert.ok(leads[0].confounders_unknown.includes('effort'));
    assert.ok(!leads[0].confounders_changed.includes('repo'));
    assert.ok(leads[0].sentence.includes('confounders changed: model'));
  });
  it('a lead never aggregates strata: its stratum is one name and its evidence ids are the two median units', async () => {
    const { buildLeads } = await mod();
    const { leads } = buildLeads(many(3));
    for (const l of leads) assert.ok(!l.stratum.includes(','));
  });
});
