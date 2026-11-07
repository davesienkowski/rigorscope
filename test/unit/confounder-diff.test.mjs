// Plan 02-08 (TRUST-06, D-17): the changed, unknown and partly-unknown confounders of one tier comparison. Written before the
// code (RED). The module is imported inside each test. The pure cases of the null-confounder prohibition live in
// test/prohibitions/null-confounder-unknown.test.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFOUNDER_NAMES } from '../../src/derive/confounders.mjs';

const mod = () => import('../../src/report/confounder-diff.mjs');
const u = (key, values, over = {}) => ({
  key, values, start_ms: Date.UTC(2026, 9, 1), end_ms: Date.UTC(2026, 9, 2), ...over,
});
const side = (tier, units) => ({ tier, units });
const find = (entries, name) => entries.find((e) => e.name === name);
const j = (...v) => JSON.stringify(v);

describe('the name tables', () => {
  it('CONFOUNDER_KINDS has exactly the names of CONFOUNDER_NAMES, numeric for unit_size, worker_count and subagents', async () => {
    const { CONFOUNDER_KINDS } = await mod();
    assert.deepEqual(Object.keys(CONFOUNDER_KINDS), [...CONFOUNDER_NAMES]);
    assert.deepEqual(Object.entries(CONFOUNDER_KINDS).filter(([, k]) => k === 'numeric').map(([n]) => n).sort(), ['subagents', 'unit_size', 'worker_count']);
    assert.equal(Object.getPrototypeOf(CONFOUNDER_KINDS), null);
    assert.ok(Object.isFrozen(CONFOUNDER_KINDS));
  });
  it('speed is displayed as fast_mode and every other name as itself; the four statuses are fixed', async () => {
    const { DISPLAY_NAMES, DIFF_STATUSES } = await mod();
    assert.equal(DISPLAY_NAMES.speed, 'fast_mode');
    for (const n of CONFOUNDER_NAMES.filter((x) => x !== 'speed')) assert.equal(DISPLAY_NAMES[n], n);
    assert.deepEqual([...DIFF_STATUSES], ['changed', 'unknown', 'partly-unknown', 'unchanged']);
  });
});

describe('unitConfounderValues', () => {
  it('a categorical value is the canonical JSON text of the sorted union over the roles, null when every row is NULL', async () => {
    const { unitConfounderValues } = await mod();
    const v = unitConfounderValues([
      { name: 'model', role: 'main', value: j('b', 'a') }, { name: 'model', role: 'gsd-executor', value: j('c') },
      { name: 'effort', role: 'main', value: null }, { name: 'effort', role: 'gsd-executor', value: null },
      { name: 'cc_version', role: '', value: j('2.1.309') }, { name: 'worker_mode', role: '', value: 'inline' },
    ]);
    assert.equal(v.model, j('a', 'b', 'c'));
    assert.equal(v.effort, null);
    assert.equal(v.cc_version, j('2.1.309'));
    assert.equal(v.worker_mode, j('inline'));
    assert.equal(v.gsd_version, null, 'an absent name is unknown');
    assert.deepEqual(Object.keys(v), [...CONFOUNDER_NAMES]);
  });
  it('numeric values: unit_size is lines added plus deleted, worker_count and subagents integers, null when unknown', async () => {
    const { unitConfounderValues } = await mod();
    const v = unitConfounderValues([
      { name: 'unit_size', role: '', value: JSON.stringify({ commits: 1, files: 1, added: 7, deleted: 3 }) },
      { name: 'worker_count', role: '', value: '2' }, { name: 'subagents', role: '', value: null },
    ]);
    assert.equal(v.unit_size, 10);
    assert.equal(v.worker_count, 2);
    assert.equal(v.subagents, null);
    const w = unitConfounderValues([{ name: 'unit_size', role: '', value: JSON.stringify({ commits: 1, files: null, added: null, deleted: null }) }]);
    assert.equal(w.unit_size, null);
  });
});

describe('diffConfounders: the four states', () => {
  it('every compared unit NULL is unknown, never unchanged', async () => {
    const { diffConfounders } = await mod();
    const e = find(diffConfounders([side('A', [u('a', { model: null })]), side('B', [u('b', { model: null })])], { names: ['model'] }), 'model');
    assert.equal(e.status, 'unknown');
    assert.equal(e.unknown_units, 2);
  });
  it('one distinct known value plus a NULL unit is partly-unknown', async () => {
    const { diffConfounders } = await mod();
    const e = find(diffConfounders([side('A', [u('a', { model: j('m') })]), side('B', [u('b', { model: null })])], { names: ['model'] }), 'model');
    assert.equal(e.status, 'partly-unknown');
    assert.equal(e.unknown_units, 1);
  });
  it('byte-equal values across sides are one value: unchanged', async () => {
    const { diffConfounders } = await mod();
    const e = find(diffConfounders([side('A', [u('a', { model: j('m') })]), side('B', [u('b', { model: j('m') })])], { names: ['model'] }), 'model');
    assert.equal(e.status, 'unchanged');
    assert.deepEqual(e.sides.map((s) => s.values), [[j('m')], [j('m')]]);
  });
  it('two distinct known values anywhere among the compared units is changed, with both shown per side', async () => {
    const { diffConfounders } = await mod();
    const e = find(diffConfounders([side('A', [u('a', { model: j('m1') }), u('a2', { model: j('m2') })]), side('B', [u('b', { model: j('m1') })])], { names: ['model'] }), 'model');
    assert.equal(e.status, 'changed');
    assert.deepEqual(e.sides.map((s) => s.values), [[j('m1'), j('m2')], [j('m1')]]);
    assert.deepEqual(e.sides.map((s) => [s.known, s.unknown]), [[2, 0], [1, 0]]);
  });
  it('a numeric confounder is changed when the per-side nearest-rank medians differ and unchanged when they are equal', async () => {
    const { diffConfounders } = await mod();
    const diff = (a, b) => find(diffConfounders([
      side('A', a.map((v, i) => u(`a${i}`, { unit_size: v }))), side('B', b.map((v, i) => u(`b${i}`, { unit_size: v }))),
    ], { names: ['unit_size'] }), 'unit_size');
    const same = diff([1, 5, 9], [3, 5, 100]);
    assert.equal(same.status, 'unchanged');
    assert.deepEqual(same.sides.map((s) => s.median), [5, 5]);
    const differs = diff([1, 5, 9], [3, 6, 100]);
    assert.equal(differs.status, 'changed');
    assert.deepEqual(differs.sides.map((s) => s.median), [5, 6]);
    assert.equal(diff([2, 4], [4, 8]).sides[0].median, 2, 'the lower middle for an even count');
  });
  it('a numeric confounder with a NULL unit and equal medians is partly-unknown, with every unit NULL unknown', async () => {
    const { diffConfounders } = await mod();
    const mk = (a, b) => find(diffConfounders([
      side('A', a.map((v, i) => u(`a${i}`, { worker_count: v }))), side('B', b.map((v, i) => u(`b${i}`, { worker_count: v }))),
    ], { names: ['worker_count'] }), 'worker_count');
    assert.equal(mk([0, null], [0]).status, 'partly-unknown');
    assert.equal(mk([null], [null]).status, 'unknown');
  });
  it('a side of one unit is compared (its value set is that unit)', async () => {
    const { diffConfounders } = await mod();
    const e = find(diffConfounders([side('A', [u('a', { model: j('m') })]), side('C', [u('c', { model: j('n') })])], { names: ['model'] }), 'model');
    assert.equal(e.status, 'changed');
  });
  it('fewer than two sides yields no entries', async () => {
    const { diffConfounders } = await mod();
    assert.deepEqual(diffConfounders([], { names: ['model'] }), []);
    assert.deepEqual(diffConfounders([side('A', [u('a', { model: j('m') })])], { names: ['model'] }), []);
  });
  it('entries follow the order of names, with the display name and kind', async () => {
    const { diffConfounders } = await mod();
    const names = [...CONFOUNDER_NAMES];
    const out = diffConfounders([side('A', [u('a', {})]), side('B', [u('b', {})])], { names });
    assert.deepEqual(out.map((e) => e.name), names);
    assert.equal(find(out, 'speed').display, 'fast_mode');
    assert.equal(find(out, 'unit_size').kind, 'numeric');
    assert.equal(find(out, 'repo').kind, 'categorical');
    assert.ok(out.every((e) => e.status === 'unknown'), 'a unit with no value for a name is unknown');
  });
});

describe('comparisonWindow', () => {
  it('is the closed span of the earliest start and latest end, units of unknown date counted and left out', async () => {
    const { comparisonWindow } = await mod();
    const w = comparisonWindow([
      { start_ms: 100, end_ms: 200 }, { start_ms: 50, end_ms: 120 }, { start_ms: null, end_ms: 900 }, { start_ms: 60, end_ms: null },
    ]);
    assert.deepEqual(w, { start_ms: 50, end_ms: 900, unknown_dates: 2 });
    assert.deepEqual(comparisonWindow([{ start_ms: null, end_ms: null }]), { start_ms: null, end_ms: null, unknown_dates: 1 });
    assert.deepEqual(comparisonWindow([]), { start_ms: null, end_ms: null, unknown_dates: 0 });
  });
});
