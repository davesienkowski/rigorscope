// Prohibition (plan 02-08, TRUST-06): a confounder MUST NOT be reported as unchanged when any compared unit's value is unknown;
// a confounder that is NULL for every compared unit is reported unknown, and one with exactly one distinct known value and at
// least one unknown unit is partly-unknown.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a module exporting diffConfounders, resolved against process.cwd(); unset means
// src/report/confounder-diff.mjs. test/prohibitions/fixtures/null-confounder-unknown-violation.mjs (reports unchanged whenever
// fewer than two distinct known values occur) must fail this test; test/prohibitions/fixtures/null-confounder-unknown-clean.mjs
// (re-exports the real module) must pass it.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_SUBJECT = fileURLToPath(new URL('../../src/report/confounder-diff.mjs', import.meta.url));
const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : DEFAULT_SUBJECT;
const load = async () => (await import(pathToFileURL(subject).href)).diffConfounders;
const unit = (key, values) => ({
  key, values, start_ms: 1, end_ms: 2,
});
const side = (tier, units) => ({ tier, units });
const statusOf = async (a, b, name) => {
  const diff = await load();
  return diff([side('A', a.map((v, i) => unit(`a${i}`, { [name]: v }))), side('B', b.map((v, i) => unit(`b${i}`, { [name]: v })))], { names: [name] })
    .find((e) => e.name === name).status;
};

it('every compared unit NULL is unknown for a categorical and for a numeric name', async () => {
  assert.equal(await statusOf([null, null], [null], 'model'), 'unknown');
  assert.equal(await statusOf([null], [null, null], 'effort'), 'unknown');
  assert.equal(await statusOf([null, null], [null], 'unit_size'), 'unknown');
  assert.equal(await statusOf([null], [null], 'worker_count'), 'unknown');
});

it('one distinct known value plus at least one NULL unit is partly-unknown for a categorical and for a numeric name', async () => {
  assert.equal(await statusOf(['["m"]'], [null], 'model'), 'partly-unknown');
  assert.equal(await statusOf(['["m"]', null], ['["m"]'], 'cc_version'), 'partly-unknown');
  assert.equal(await statusOf([5, null], [5], 'unit_size'), 'partly-unknown');
  assert.equal(await statusOf([3], [null], 'subagents'), 'partly-unknown');
});

it('neither an all-NULL nor a partly-NULL confounder is ever unchanged', async () => {
  for (const [a, b, name] of [[[null], [null], 'model'], [['["m"]'], [null], 'model'], [[null], [null], 'unit_size'], [[1, null], [1], 'unit_size']]) {
    assert.notEqual(await statusOf(a, b, name), 'unchanged');
  }
});

it('a fully known single value is unchanged (the check can pass)', async () => {
  assert.equal(await statusOf(['["m"]'], ['["m"]'], 'model'), 'unchanged');
  assert.equal(await statusOf([4, 4], [4], 'unit_size'), 'unchanged');
});
