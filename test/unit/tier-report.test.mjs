// Plan 02-08 (D-18, D-02, D-06, TRUST-07): the pure parts of src/report/tier.mjs. Written before the code (RED). The module is
// imported inside each test, so this file loads before the module exists.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import('../../src/report/tier.mjs');
const unit = (key, tier, signal = tier === null ? 'none' : 'frontmatter', risk = '["gate-or-hook"]') => ({
  unit_key: key, tier, tier_signal: signal, risk_class: risk,
});
const cost = (tokens, usd = 1, w5 = 1, w7 = 1) => ({
  calls: 1, scopes: 1, tokens, usd_nano: usd, window_5h: w5, window_7d: w7,
});

describe('summarizeRow: nearest-rank statistic over the costed units (TRUST-07 precision)', () => {
  const row = async (values, over = {}) => {
    const { summarizeRow } = await mod();
    const units = values.map((v, i) => unit(`k${String(i).padStart(2, '0')}`, 'A'));
    const costs = new Map(values.map((v, i) => [`k${String(i).padStart(2, '0')}`, v === null ? { ...cost(null), calls: 1 } : cost(v)]));
    return summarizeRow(units, costs, { minN: 10, tier: 'A', ...over });
  };

  it('n 0: nothing is known, median and p75 are null, never 0', async () => {
    const r = await row([]);
    assert.equal(r.n, 0);
    assert.equal(r.costed, 0);
    assert.deepEqual(r.tokens, { median: null, p75: null, known: 0, usd_floor: false });
    assert.equal(r.compared, false);
  });
  it('n 1: both statistics are the value', async () => {
    const r = await row([7]);
    assert.deepEqual(r.tokens, { median: 7, p75: 7, known: 1, usd_floor: false });
    assert.equal(r.compared, true);
  });
  it('n 2: the median is the lower value and the p75 the higher', async () => {
    const r = await row([5, 9]);
    assert.deepEqual(r.tokens, { median: 5, p75: 9, known: 2, usd_floor: false });
  });
  it('n 4: median at rank 2, p75 at rank 3, whatever the input order', async () => {
    const r = await row([40, 10, 30, 20]);
    assert.deepEqual(r.tokens, { median: 20, p75: 30, known: 4, usd_floor: false });
  });
  it('n 10 with ties: median rank 5, p75 rank 8, elements of the list', async () => {
    const r = await row([1, 2, 2, 2, 3, 3, 4, 9, 9, 9]);
    assert.deepEqual(r.tokens, { median: 3, p75: 9, known: 10, usd_floor: false });
  });
  it('a unit with attributed calls but unknown tokens is not costed and is left out of known', async () => {
    const r = await row([10, null, 30]);
    assert.equal(r.n, 3);
    assert.equal(r.costed, 2);
    assert.deepEqual(r.tokens, { median: 10, p75: 30, known: 2, usd_floor: false });
  });
  it('unknown usd and window values are left out of that measure only', async () => {
    const { summarizeRow } = await mod();
    const units = [unit('k1', 'B'), unit('k2', 'B'), unit('k3', 'B')];
    const costs = new Map([
      ['k1', cost(100, null, null, 3)], ['k2', cost(200, 5, null, 4)], ['k3', cost(300, 7, null, null)],
    ]);
    const r = summarizeRow(units, costs, { minN: 10, tier: 'B' });
    assert.equal(r.costed, 3);
    assert.deepEqual(r.usd, { median: 5, p75: 7, known: 2, usd_floor: false });
    assert.deepEqual(r.window_5h, { median: null, p75: null, known: 0, usd_floor: false });
    assert.deepEqual(r.window_7d, { median: 3, p75: 4, known: 2, usd_floor: false });
  });
  it('a unit with no cost entry is counted in n but is not costed', async () => {
    const { summarizeRow } = await mod();
    const r = summarizeRow([unit('k1', 'C')], new Map(), { minN: 10, tier: 'C' });
    assert.equal(r.n, 1);
    assert.equal(r.costed, 0);
    assert.equal(r.compared, false);
  });
  it('the ? row is never compared and its low-evidence flag is null', async () => {
    const r = await row([1, 2, 3], { tier: '?' });
    assert.equal(r.compared, false);
    assert.equal(r.low_evidence, null);
    assert.equal(r.costed, 3);
  });
  it('catch and escape are unavailable and the row carries exactly the frozen keys', async () => {
    const { TIER_KEYS } = await mod();
    const r = await row([1]);
    assert.deepEqual(r.catch, { value: null, label: 'unavailable' });
    assert.deepEqual(r.escape, { value: null, label: 'unavailable' });
    assert.deepEqual(Object.keys(r), [...TIER_KEYS.row]);
  });
});

describe('isLowEvidence and parseMinN (TRUST-07 boundary)', () => {
  it('flags a side with fewer costed units than min_n', async () => {
    const { isLowEvidence } = await mod();
    assert.deepEqual([0, 1, 9, 10, 11].map((c) => isLowEvidence(c, 10)), [true, true, true, false, false]);
    assert.deepEqual([0, 1, 2].map((c) => isLowEvidence(c, 1)), [true, false, false]);
    assert.deepEqual([0, 999, 1000].map((c) => isLowEvidence(c, 1000)), [true, true, false]);
  });
  it('accepts 1, 10 and 1000', async () => {
    const { parseMinN } = await mod();
    assert.deepEqual(['1', '10', '1000'].map(parseMinN), [1, 10, 1000]);
  });
  it('rejects 0, 1001, a leading zero, a decimal, a sign and the empty string with one fixed message that never holds the input', async () => {
    const { parseMinN } = await mod();
    const messages = new Set();
    for (const v of ['0', '1001', '010', '1.5', '+5', '-1', '', ' 5', '5 ', '1e3', 'abc']) {
      assert.throws(() => parseMinN(v), (e) => {
        assert.ok(e instanceof RangeError);
        assert.ok(v.length < 2 || !e.message.includes(v), `the message echoes ${v}`);
        messages.add(e.message);
        return true;
      });
    }
    assert.equal(messages.size, 1);
  });
});

describe('strataOf (D-06)', () => {
  it('NULL is the unknown stratum and [] the known-empty none stratum', async () => {
    const { strataOf } = await mod();
    assert.deepEqual(strataOf(null), ['unknown']);
    assert.deepEqual(strataOf('[]'), ['none']);
  });
  it('one tag and two specific tags come out in RISK_TAGS order', async () => {
    const { strataOf } = await mod();
    assert.deepEqual(strataOf('["security"]'), ['security']);
    assert.deepEqual(strataOf('["security","gate-or-hook"]'), ['gate-or-hook', 'security']);
  });
  it('script is dropped when a specific tag is present, kept alone and with docs', async () => {
    const { strataOf } = await mod();
    assert.deepEqual(strataOf('["parser","script"]'), ['parser']);
    assert.deepEqual(strataOf('["docs","script"]'), ['script', 'docs']);
    assert.deepEqual(strataOf('["script"]'), ['script']);
  });
  it('a malformed text throws a RangeError whose message never holds the text', async () => {
    const { strataOf } = await mod();
    for (const bad of ['not json', '{"a":1}', '["nonsense"]', '[1]', '', '"gate-or-hook"']) {
      assert.throws(() => strataOf(bad), (e) => e instanceof RangeError && !e.message.includes('nonsense') && !e.message.includes('not json'));
    }
  });
  it('SCRIPT_SPECIFIC is the shipped table scriptUnless.specific', async () => {
    const { SCRIPT_SPECIFIC } = await mod();
    const { loadRiskRules } = await import('../../src/units/risk-rules.mjs');
    assert.deepEqual([...SCRIPT_SPECIFIC], [...loadRiskRules().scriptUnless.specific]);
  });
});

describe('sideOf (D-02, D-03)', () => {
  it('a unit with tier NULL is the ? side; a frontmatter letter its letter', async () => {
    const { sideOf } = await mod();
    assert.equal(sideOf({ tier: null, tier_signal: 'none' }, { includeInferred: false }), '?');
    assert.equal(sideOf({ tier: null, tier_signal: 'none' }, { includeInferred: true }), '?');
    assert.equal(sideOf({ tier: 'B', tier_signal: 'frontmatter' }, { includeInferred: false }), 'B');
  });
  it('a probes-skipped letter is excluded (null) by default and in its letter row with includeInferred', async () => {
    const { sideOf } = await mod();
    assert.equal(sideOf({ tier: 'C', tier_signal: 'probes-skipped' }, { includeInferred: false }), null);
    assert.equal(sideOf({ tier: 'C', tier_signal: 'probes-skipped' }, { includeInferred: true }), 'C');
  });
});

describe('stratify (D-06, D-02)', () => {
  it('returns the non-empty strata in RISK_TAGS then none then unknown order, units bytewise by key', async () => {
    const { stratify } = await mod();
    const units = [
      unit('z', 'A', 'frontmatter', '[]'), unit('b', 'A', 'frontmatter', '["gate-or-hook","security"]'),
      unit('a', 'A', 'frontmatter', '["gate-or-hook"]'), unit('u', 'B', 'frontmatter', null), unit('p', null, 'none', '["parser"]'),
    ];
    const out = stratify(units, { includeInferred: false });
    assert.deepEqual(out.map((s) => s.stratum), ['gate-or-hook', 'security', 'parser', 'none', 'unknown']);
    assert.deepEqual(out[0].rows.A.map((u) => u.unit_key), ['a', 'b']);
    assert.deepEqual(out[2].rows['?'].map((u) => u.unit_key), ['p']);
    assert.deepEqual(Object.keys(out[0].rows), ['A', 'B', 'C', '?']);
  });
  it('counts a probes-skipped unit as inferred_excluded and keeps it out of every row by default', async () => {
    const { stratify } = await mod();
    const units = [unit('x', 'B', 'probes-skipped'), unit('y', 'B', 'tier-file')];
    const [st] = stratify(units, { includeInferred: false });
    assert.equal(st.inferredExcluded, 1);
    assert.deepEqual(st.rows.B.map((u) => u.unit_key), ['y']);
    const [st2] = stratify(units, { includeInferred: true });
    assert.equal(st2.inferredExcluded, 0);
    assert.deepEqual(st2.rows.B.map((u) => u.unit_key), ['x', 'y']);
  });
});
