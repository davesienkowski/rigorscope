// Prohibition (plan 02-07, UNIT-06, D-13): the cost of a scope that has more than one counted unit MUST NOT be spread
// across those units, whether by share, by the first or last unit or by any other split: the scope's calls go whole to
// unattributed_overlap and no unit receives any of them.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a module exporting attributeScope, resolved against process.cwd(); unset
// means src/derive/attribution.mjs. test/prohibitions/fixtures/overlap-not-spread-violation.mjs (attributes a multi-unit
// scope to its bytewise-first unit with equal shares) must fail this test;
// test/prohibitions/fixtures/overlap-not-spread-clean.mjs (re-exports the real module) must pass it.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_SUBJECT = fileURLToPath(new URL('../../src/derive/attribution.mjs', import.meta.url));
const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : DEFAULT_SUBJECT;
const load = async () => (await import(pathToFileURL(subject).href)).attributeScope;
const L = (unitKey, confidence, method = 'tool-path') => ({ unit_key: unitKey, confidence, method });
const KEYS = ['bucket', 'reason', 'unitKey', 'countedUnits'];

function assertOverlap(r, label) {
  assert.deepEqual(Object.keys(r), KEYS, `${label}: only the four keys, no share list`);
  assert.equal(r.bucket, 'unattributed_overlap', `${label}: bucket`);
  assert.equal(r.unitKey, null, `${label}: no unit receives the calls`);
}

it('two counted units of equal confidence: the whole scope is overlap in both modes', async () => {
  const attributeScope = await load();
  for (const mode of ['medium', 'low']) assertOverlap(attributeScope({ links: [L('u-a', 'high'), L('u-b', 'high')], mode }), mode);
});

it('two counted units of unequal confidence: still overlap, never the stronger unit', async () => {
  const attributeScope = await load();
  for (const mode of ['medium', 'low']) assertOverlap(attributeScope({ links: [L('u-a', 'high'), L('u-b', 'medium')], mode }), mode);
});

it('three counted units: overlap in both modes', async () => {
  const attributeScope = await load();
  for (const mode of ['medium', 'low']) {
    assertOverlap(attributeScope({ links: [L('u-c', 'medium'), L('u-a', 'medium'), L('u-b', 'high')], mode }), mode);
  }
});

it('one unit linked by two methods plus another unit: overlap', async () => {
  const attributeScope = await load();
  for (const mode of ['medium', 'low']) {
    assertOverlap(attributeScope({ links: [L('u-a', 'high'), L('u-a', 'medium', 'slash-command'), L('u-b', 'medium')], mode }), mode);
  }
});

it('several low-only units in mode low: overlap', async () => {
  const attributeScope = await load();
  assertOverlap(attributeScope({ links: [L('u-a', 'low', 'interval'), L('u-b', 'low', 'interval')], mode: 'low' }), 'low');
});

it('a single counted unit is attributed whole', async () => {
  const attributeScope = await load();
  const r = attributeScope({ links: [L('u-a', 'high'), L('u-a', 'low', 'interval')], mode: 'medium' });
  assert.deepEqual(Object.keys(r), KEYS);
  assert.equal(r.bucket, 'attributed');
  assert.equal(r.unitKey, 'u-a');
});
