// Prohibition (plan 02-08, D-02, D-03, TIER-02): a unit with an unknown tier MUST NOT be placed in the A, B or C row of a tier
// report or compared (the `?` row is never compared), and a tier inferred from probe files MUST NOT be counted in a tier row
// unless --include-inferred is given.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a module exporting stratify and summarizeRow, resolved against process.cwd();
// unset means src/report/tier.mjs. test/prohibitions/fixtures/unknown-tier-not-compared-violation.mjs (sends tier NULL to C and
// keeps probes-skipped units in their letter row by default) must fail this test;
// test/prohibitions/fixtures/unknown-tier-not-compared-clean.mjs (re-exports the real module) must pass it.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_SUBJECT = fileURLToPath(new URL('../../src/report/tier.mjs', import.meta.url));
const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : DEFAULT_SUBJECT;
const load = async () => import(pathToFileURL(subject).href);
const unit = (key, tier, signal) => ({
  unit_key: key, tier, tier_signal: signal, risk_class: '["gate-or-hook"]',
});
const UNITS = [
  unit('u-null-none', null, 'none'),
  unit('u-null-also', null, 'none'),
  unit('u-b-inferred', 'B', 'probes-skipped'),
  unit('u-c-inferred', 'C', 'probes-skipped'),
  unit('u-a-front', 'A', 'frontmatter'),
  unit('u-b-file', 'B', 'tier-file'),
];
const keys = (list) => list.map((u) => u.unit_key);
const only = (st) => st.find((s) => s.stratum === 'gate-or-hook');

it('a unit with tier NULL is in the ? row and in no letter row', async () => {
  const { stratify } = await load();
  const st = only(stratify(UNITS, { includeInferred: false }));
  for (const letter of ['A', 'B', 'C']) {
    for (const k of ['u-null-none', 'u-null-also']) assert.ok(!keys(st.rows[letter]).includes(k), `${k} is not in ${letter}`);
  }
  assert.deepEqual(keys(st.rows['?']), ['u-null-also', 'u-null-none']);
});

it('with includeInferred true a unit with tier NULL is still only in the ? row', async () => {
  const { stratify } = await load();
  const st = only(stratify(UNITS, { includeInferred: true }));
  for (const letter of ['A', 'B', 'C']) assert.ok(!keys(st.rows[letter]).some((k) => k.startsWith('u-null')));
  assert.deepEqual(keys(st.rows['?']), ['u-null-also', 'u-null-none']);
});

it('probes-skipped units are in no row by default and are counted', async () => {
  const { stratify } = await load();
  const st = only(stratify(UNITS, { includeInferred: false }));
  const all = ['A', 'B', 'C', '?'].flatMap((t) => keys(st.rows[t]));
  assert.ok(!all.includes('u-b-inferred') && !all.includes('u-c-inferred'));
  assert.equal(st.inferredExcluded, 2);
  assert.deepEqual(keys(st.rows.B), ['u-b-file']);
  assert.deepEqual(keys(st.rows.C), []);
});

it('probes-skipped units are in their letter rows only with includeInferred', async () => {
  const { stratify } = await load();
  const st = only(stratify(UNITS, { includeInferred: true }));
  assert.deepEqual(keys(st.rows.B), ['u-b-file', 'u-b-inferred']);
  assert.deepEqual(keys(st.rows.C), ['u-c-inferred']);
  assert.equal(st.inferredExcluded, 0);
});

it('the ? row is never compared: compared false and a null low-evidence flag, even with costed units', async () => {
  const { summarizeRow } = await load();
  const costs = new Map(['u-null-none', 'u-null-also'].map((k, i) => [k, {
    calls: 1, scopes: 1, tokens: 100 + i, usd_nano: 1, window_5h: 1, window_7d: 1,
  }]));
  const r = summarizeRow(UNITS.slice(0, 2), costs, { minN: 10, tier: '?' });
  assert.equal(r.compared, false);
  assert.equal(r.low_evidence, null);
  assert.equal(r.costed, 2);
});
