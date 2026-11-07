// Prohibition (plan 02-08, TRUST-08, D-18): tier leads and tier output MUST NOT carry a single score, a figure pooled across
// risk strata, or a verdict of the pass or fail kind. A lead names one stratum and two tiers, its keys are a fixed list, and
// its words come from a fixed vocabulary.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a module exporting buildLeads, resolved against process.cwd(); unset means
// src/report/leads.mjs. test/prohibitions/fixtures/no-score-violation.mjs (adds a numeric combined-rank key to every lead and
// prepends one lead pooled over every stratum with a verdict word) must fail this test;
// test/prohibitions/fixtures/no-score-clean.mjs (re-exports the real module) must pass it.
//
// The two frozen lists below are also imported by test/integration/tier-cli.test.mjs, which scans the real `tier --json` keys and
// the whole `tier` text for them.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pairRow } from '../fixtures/calibrate-rows.mjs';

export const FORBIDDEN_KEYS = Object.freeze(['score', 'rank_score', 'overall', 'pooled', 'headline', 'verdict', 'pass', 'fail', 'passed',
  'failed', 'grade', 'winner']);
export const FORBIDDEN_WORDS = Object.freeze(['score', 'scores', 'scored', 'overall', 'pooled', 'headline', 'verdict', 'pass', 'passes',
  'passed', 'fail', 'fails', 'failed', 'grade', 'winner', 'loser', 'best', 'worst', 'better', 'worse']);
// Plan 03-05 (RPT-06, D-20): the words a decision sheet row must not use either; a row states what the numbers support, it never
// tells the owner what to do.
export const RECOMMEND_WORDS = Object.freeze(['should', 'recommend', 'recommended', 'advise', 'consider', 'suggest', 'try', 'prefer', 'ought']);
const ALLOWED_LEAD_KEYS = Object.freeze(['rank', 'stratum', 'tiers', 'sentence', 'costed', 'low_evidence', 'median_tokens', 'median_usd',
  'notional_floor', 'gap_tokens', 'direction', 'confounders_changed', 'confounders_unknown', 'window', 'evidence_ids']);

const DEFAULT_SUBJECT = fileURLToPath(new URL('../../src/report/leads.mjs', import.meta.url));
const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : DEFAULT_SUBJECT;
const load = async () => (await import(pathToFileURL(subject).href)).buildLeads;
const unit = (key) => ({
  key, values: {}, start_ms: 1, end_ms: 2,
});
const side = (tier, costed, median) => ({
  tier, costed, low_evidence: costed < 10, tokens_median: median, usd_median: 2_000_000, median_unit_key: `k-${tier}`, units: [unit(`k-${tier}`)],
});
const NAMES = ['gate-or-hook', 'security', 'parser', 'global-config', 'script', 'docs', 'none', 'unknown'];
const strata = (n) => NAMES.slice(0, n).map((name, i) => ({ stratum: name, sides: [side('A', 12 + i, 100), side('B', 11 + i, 140), side('C', 9, 90)] }));
const wordsOf = (text) => text.toLowerCase().match(/[a-z]+/g) ?? [];

function walkKeys(value, out = []) {
  if (Array.isArray(value)) for (const v of value) walkKeys(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); walkKeys(v, out); }
  }
  return out;
}

it('every lead key is on the allowlist and none is a forbidden key', async () => {
  const buildLeads = await load();
  const { leads } = buildLeads(strata(3), { maxLeads: 5 });
  assert.ok(leads.length > 0);
  for (const l of leads) {
    for (const k of Object.keys(l)) assert.ok(ALLOWED_LEAD_KEYS.includes(k), `key ${k} is on the allowlist`);
    for (const k of walkKeys(l)) assert.ok(!FORBIDDEN_KEYS.includes(k), `key ${k} is forbidden`);
  }
});

it('no sentence holds a word of the forbidden vocabulary', async () => {
  const buildLeads = await load();
  const { leads } = buildLeads(strata(4), { maxLeads: 5 });
  for (const l of leads) {
    for (const w of wordsOf(l.sentence)) assert.ok(!FORBIDDEN_WORDS.includes(w), `word ${w} is forbidden`);
  }
});

it('each lead names exactly one stratum of the input and two letters, and none pools strata', async () => {
  const buildLeads = await load();
  const input = strata(5);
  const { leads } = buildLeads(input, { maxLeads: 5 });
  for (const l of leads) {
    assert.ok(input.some((s) => s.stratum === l.stratum), `stratum ${l.stratum} comes from the input`);
    assert.equal(l.tiers.length, 2);
    assert.ok(l.tiers.every((t) => ['A', 'B', 'C'].includes(t)));
    assert.notEqual(l.tiers[0], l.tiers[1]);
  }
});

it('at most five leads are returned and the rest are counted', async () => {
  const buildLeads = await load();
  const out = buildLeads(strata(8), { maxLeads: 5 });
  assert.ok(out.leads.length <= 5);
  assert.equal(out.leads.length + out.omitted, 24);
});

// ---- plan 03-05: calibrate and the decision sheet --------------------------------------------------------------------------
// Subject-injectable: GSD_PROHIB_SHEET_SUBJECT names a module exporting buildSheet, calibrateFields, ROW_KEYS and ROW_IDS (resolved
// against process.cwd()); unset means the real modules. test/prohibitions/fixtures/no-score-sheet-violation.mjs (adds a numeric
// score to a row, a recommendation word to a reason, a total across calibrate fields and reorders rows by status) must fail
// these tests; test/prohibitions/fixtures/no-score-sheet-clean.mjs (re-exports the real modules) must pass them.
const SHEET_DEFAULT = fileURLToPath(new URL('./fixtures/no-score-sheet-clean.mjs', import.meta.url));
const sheetSubject = process.env.GSD_PROHIB_SHEET_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SHEET_SUBJECT) : SHEET_DEFAULT;
const loadSheet = async () => import(pathToFileURL(sheetSubject).href);
const STATUSES = ['can decide today', 'cannot'];

const unitsInput = (calibration) => ({
  calibration, strata: [], units: [], unrecorded: { cutoff_day: null, n: 0, k: 0, first_seen_unknown: 0 },
  incomplete: { n: 0, listed: [], omitted: 0 }, tz: 'UTC', minN: 10,
});

it('calibrate has no composite', async () => {
  const { calibrateFields } = await loadSheet();
  const doc = calibrateFields([pairRow(), pairRow({ recon_tier: 'B' }), pairRow({ recon_tier: null })], new Map());
  assert.deepEqual(Object.keys(doc), ['pairs', 'ledger_only', 'fields']);
  for (const k of walkKeys(doc)) assert.ok(!FORBIDDEN_KEYS.includes(k), `key ${k} is forbidden`);
  for (const k of walkKeys(doc)) assert.ok(!/total|rate|accuracy|composite/.test(k), `key ${k} is a composite`);
  assert.equal(doc.fields.length, 4);
  for (const f of doc.fields) assert.ok(!Object.hasOwn(f, 'verdict') && !Object.hasOwn(f, 'agrees'));
});

it('sheet has no score or recommendation', async () => {
  const { buildSheet, calibrateFields, ROW_KEYS, ROW_IDS } = await loadSheet();
  const mixed = [...Array.from({ length: 5 }, () => pairRow()), pairRow({ recon_tier: null })];
  for (const cal of [calibrateFields(mixed, new Map()), calibrateFields([pairRow()], new Map())]) {
    const rows = buildSheet('units', unitsInput(cal));
    assert.ok(rows.length >= 4);
    const order = rows.map((r) => ROW_IDS.indexOf(r.id));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'rows keep the fixed order, not a status order');
    assert.ok(!order.includes(-1));
    for (const r of rows) {
      assert.deepEqual(Object.keys(r), [...ROW_KEYS], `row ${r.id} has exactly the allowed keys`);
      assert.ok(STATUSES.includes(r.status), `status ${r.status}`);
      for (const k of walkKeys(r)) assert.ok(!FORBIDDEN_KEYS.includes(k), `key ${k} is forbidden`);
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === 'number') assert.ok(['n', 'evidence_omitted'].includes(k), `numeric key ${k} is not n or evidence_omitted`);
      }
      for (const w of wordsOf(`${r.question} ${r.reason}`)) {
        assert.ok(!FORBIDDEN_WORDS.includes(w) && !RECOMMEND_WORDS.includes(w), `word ${w} in ${r.id}`);
      }
    }
  }
});

it('sheet has no score or recommendation on the tier and cost surfaces', async () => {
  const { buildSheet, ROW_KEYS, ROW_IDS } = await loadSheet();
  const row = (tier, costed) => ({ tier, costed, evidence_ids: [`u:${tier}`] });
  const pop = (population, b) => ({
    population, counts: { units: 40, comparable: 30 }, strata: [{ stratum: 'script', rows: [row('A', 12), row('B', b)] }], leads: [{ evidence_ids: ['u:x'] }],
  });
  const advisor = {
    state: { snapshots: 2, snapshots_null: 0, models_seen: ['m-one', 'm-two'], baseline: 'm-one', changed: true, change_model: 'm-two', baseline_start_ms: 0, window_start_ms: 7 * 86_400_000, window_end_ms: 14 * 86_400_000, window_days: 7, full: true },
    scope: 'window', models: [], baseline: [{ model: 'm-one', parts: 10, usd_nano: 1 }], trial: [{ model: 'm-two', parts: 10, usd_nano: null }],
  };
  const sheets = [
    buildSheet('tier', { populations: [pop('forward', 11), pop('reconstructed', 3)], minN: 10 }),
    buildSheet('cost', {
      populations: [{ population: 'forward', units: 12, costed: 12 }, { population: 'reconstructed', units: 9, costed: 9 }],
      samples: { forward: ['k1'], reconstructed: [] }, advisor, minN: 10,
    }),
  ];
  for (const rows of sheets) {
    const order = rows.map((r) => ROW_IDS.indexOf(r.id));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    for (const r of rows) {
      assert.deepEqual(Object.keys(r), [...ROW_KEYS]);
      assert.ok(STATUSES.includes(r.status));
      for (const k of walkKeys(r)) assert.ok(!FORBIDDEN_KEYS.includes(k));
      for (const [k, v] of Object.entries(r)) if (typeof v === 'number') assert.ok(['n', 'evidence_omitted'].includes(k), k);
      for (const w of wordsOf(`${r.question} ${r.reason}`)) assert.ok(!FORBIDDEN_WORDS.includes(w) && !RECOMMEND_WORDS.includes(w), `word ${w} in ${r.id}`);
    }
  }
});
