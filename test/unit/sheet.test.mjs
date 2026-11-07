// Plan 03-05 (RPT-06, D-20, TRUST-03, TRUST-09): buildSheet is pure; every row has exactly ROW_KEYS, a two-value status, a consumer
// that is the CONSUMERS id of its SIGNALS entry, n and population, and at most MAX_EVIDENCE_IDS evidence ids.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONSUMERS, SIGNALS } from '../../src/report/signals.mjs';
import { calibrateFields } from '../../src/report/calibrate.mjs';
import { MAX_EVIDENCE_IDS, ROW_IDS, ROW_KEYS, buildSheet } from '../../src/report/sheet.mjs';
import { pairRow } from '../fixtures/calibrate-rows.mjs';
import { FORBIDDEN_WORDS, RECOMMEND_WORDS } from '../prohibitions/no-score.test.mjs';

const BANNED = [...FORBIDDEN_WORDS, ...RECOMMEND_WORDS];
export const emptyUnitsInput = (over = {}) => ({
  calibration: calibrateFields([], new Map()),
  strata: [], units: [], unrecorded: { cutoff_day: null, n: 0, k: 0, first_seen_unknown: 0 }, incomplete: { n: 0, listed: [], omitted: 0 },
  tz: 'UTC', minN: 10, ...over,
});

describe('sheet tracer (03-05 Task 1)', () => {
  it('the calibrate-tier row for one disagreeing pair says cannot, names n 1 below 5, forward, a consumer and an evidence id', () => {
    const sheet = buildSheet('units', emptyUnitsInput({ calibration: calibrateFields([pairRow()], new Map()) }));
    const r = sheet.find((x) => x.id === 'calibrate-tier');
    assert.deepEqual(Object.keys(r), [...ROW_KEYS]);
    assert.equal(r.status, 'cannot');
    assert.match(r.reason, /compared pairs 1 of 5 needed/);
    assert.equal(r.population, 'forward');
    assert.equal(r.n, 1);
    assert.equal(r.low_evidence, true);
    assert.equal(r.evidence_ids.length, 1);
    assert.equal(r.evidence_omitted, 0);
    const sig = SIGNALS.find((s) => s.id === r.signal);
    assert.equal(r.consumer, sig.consumer);
    assert.ok(Object.hasOwn(CONSUMERS, r.consumer));
  });

  it('rows keep the fixed ROW_IDS order and MAX_EVIDENCE_IDS is 5', () => {
    assert.equal(MAX_EVIDENCE_IDS, 5);
    const ids = buildSheet('units', emptyUnitsInput()).map((r) => r.id);
    assert.deepEqual(ids, ROW_IDS.filter((id) => ids.includes(id)));
  });
});

describe('calibrate rows (03-05 Task 2)', () => {
  const five = () => Array.from({ length: 5 }, () => pairRow());
  const rowOf = (rows, id) => rows.find((r) => r.id === id);

  it('a field with n 5 can be decided today with an evidence id; with n 4 it cannot, and the order is the same', () => {
    const can = buildSheet('units', emptyUnitsInput({ calibration: calibrateFields(five(), new Map()) }));
    const cannot = buildSheet('units', emptyUnitsInput({ calibration: calibrateFields(five().slice(1), new Map()) }));
    const a = rowOf(can, 'calibrate-tier');
    const b = rowOf(cannot, 'calibrate-tier');
    assert.equal(a.status, 'can decide today');
    assert.equal(a.low_evidence, false);
    assert.ok(a.evidence_ids.length >= 1 && a.evidence_ids.length <= MAX_EVIDENCE_IDS);
    assert.equal(a.evidence_omitted, 0);
    assert.equal(b.status, 'cannot');
    assert.match(b.reason, /compared pairs 4 of 5 needed/);
    assert.deepEqual(can.map((r) => r.id), cannot.map((r) => r.id));
  });

  it('a can row never lacks an evidence id: a field of n 5 with every id removed is downgraded to cannot', () => {
    const cal = calibrateFields(five(), new Map());
    for (const f of cal.fields) { f.disagree_ids = []; f.pair_ids = []; }
    const r = rowOf(buildSheet('units', emptyUnitsInput({ calibration: cal })), 'calibrate-tier');
    assert.equal(r.status, 'cannot');
    assert.match(r.reason, /no evidence id/);
  });

  it('more than 5 disagreeing ids are listed 5 and the rest counted in evidence_omitted', () => {
    const cal = calibrateFields(Array.from({ length: 8 }, () => pairRow()), new Map());
    cal.fields[0].disagree_ids = Array.from({ length: 8 }, (_, i) => `u:k${i}`);
    const r = rowOf(buildSheet('units', emptyUnitsInput({ calibration: cal })), 'calibrate-tier');
    assert.deepEqual([r.evidence_ids.length, r.evidence_omitted], [5, 3]);
  });

  it('every sentence is built from a closed vocabulary: no forbidden or recommendation word', () => {
    const rows = buildSheet('units', emptyUnitsInput({ calibration: calibrateFields(five(), new Map()) }));
    for (const r of rows) {
      for (const w of `${r.question} ${r.reason}`.toLowerCase().match(/[a-z]+/g)) {
        assert.ok(!BANNED.includes(w), `word ${w} in ${r.id}`);
      }
    }
  });
});

// ---- Task 3: the units, tier and cost rows, the advisor row, and the shape of every row ------------------------------------------
import { ADVISOR_WINDOW_DAYS } from '../../src/report/advisor-trial.mjs';

const fwdUnit = (n, over = {}) => ({
  key: `gsd-core:~/r/.git:quick:26110${n}-aaa`, evidenceId: `u:gsd-core:~%2Fr%2F.git:quick:26110${n}-aaa`, population: 'forward',
  cost: { calls: 1, tokens: 10 }, ledger: { status: 'complete' }, hasRecon: true, reconStartMs: null, ...over,
});
const stratum = (population, costed, n = costed) => ({ population, n, costed, low_evidence: costed < 10, min_n: 10 });
const idsOf = (rows, id) => rows.find((r) => r.id === id);

describe('units rows (03-05 Task 3, J6)', () => {
  it('9 forward costed units: units-forward-sample cannot naming 9 and the floor; 10: can with an evidence id', () => {
    const nine = buildSheet('units', emptyUnitsInput({ strata: [stratum('forward', 9)], units: Array.from({ length: 9 }, (_, i) => fwdUnit(i)) }));
    const ten = buildSheet('units', emptyUnitsInput({ strata: [stratum('forward', 10)], units: Array.from({ length: 10 }, (_, i) => fwdUnit(i)) }));
    const a = idsOf(nine, 'units-forward-sample');
    const b = idsOf(ten, 'units-forward-sample');
    assert.equal(a.status, 'cannot');
    assert.match(a.reason, /9 costed units, below the floor 10/);
    assert.equal(b.status, 'can decide today');
    assert.equal(b.low_evidence, false);
    assert.ok(b.evidence_ids.length >= 1);
  });

  it('no ledger line: units-ledger-use cannot with the cutoff none and n 0', () => {
    const r = idsOf(buildSheet('units', emptyUnitsInput()), 'units-ledger-use');
    assert.equal(r.status, 'cannot');
    assert.match(r.reason, /cutoff none/);
    assert.equal(r.n, 0);
  });

  it('a start-only unit: units-unclosed can with that unit id and low evidence while forward n is below 10', () => {
    const open = fwdUnit(1, { ledger: { status: 'incomplete' } });
    const sheet = buildSheet('units', emptyUnitsInput({
      strata: [stratum('forward', 0, 1)], units: [open, fwdUnit(2)], unrecorded: { cutoff_day: '2026-10-30', n: 1, k: 0, first_seen_unknown: 0 },
      incomplete: { n: 1, listed: [], omitted: 0 },
    }));
    const r = idsOf(sheet, 'units-unclosed');
    assert.equal(r.status, 'can decide today');
    assert.deepEqual(r.evidence_ids, [open.evidenceId]);
    assert.equal(r.low_evidence, true);
    assert.equal(r.n, 1);
  });
});

const row = (tier, costed, ids = []) => ({ tier, costed, evidence_ids: ids });
const tierPop = (population, rows, { comparable = 30, units = 40 } = {}) => ({
  population, counts: { units, comparable }, strata: [{ stratum: 'script', rows }], leads: [{ evidence_ids: ['u:x1', 'u:x2'] }],
});

describe('tier rows (03-05 Task 3, J6)', () => {
  const sheetOf = (forward, reconstructed) => buildSheet('tier', { populations: [forward, reconstructed], minN: 10 });

  it('tier-cost row says cannot below the floor and can at it, from the stratum rows, with the lead ids', () => {
    const rowsAt = (b) => [row('A', 12, ['u:a']), row('B', b, ['u:b']), row('C', 0), row('?', 3)];
    const can = sheetOf(tierPop('forward', rowsAt(11)), tierPop('reconstructed', rowsAt(11)));
    const cannot = sheetOf(tierPop('forward', rowsAt(9)), tierPop('reconstructed', rowsAt(9)));
    assert.equal(idsOf(can, 'tier-cost-forward').status, 'can decide today');
    assert.deepEqual(idsOf(can, 'tier-cost-forward').evidence_ids, ['u:x1', 'u:x2']);
    const r = idsOf(cannot, 'tier-cost-forward');
    assert.equal(r.status, 'cannot');
    assert.equal(r.n, 9);
    assert.match(r.reason, /costed n 9, below the floor 10/);
    assert.equal(idsOf(cannot, 'tier-cost-reconstructed').status, 'cannot');
  });

  it('tier-cost row says cannot with `no stratum has two tiers` when one side is empty', () => {
    const r = idsOf(sheetOf(tierPop('forward', [row('A', 20), row('B', 0)]), tierPop('reconstructed', [row('A', 20), row('B', 0)])), 'tier-cost-reconstructed');
    assert.equal(r.status, 'cannot');
    assert.match(r.reason, /no stratum has two tiers/);
  });

  it('forward tier-cost and tier-source-comparable say cannot with the k of n reason when few forward units have a comparable source', () => {
    const rowsOk = [row('A', 12, ['u:a']), row('B', 11, ['u:b'])];
    const sheet = sheetOf(tierPop('forward', rowsOk, { comparable: 4, units: 20 }), tierPop('reconstructed', rowsOk));
    assert.equal(idsOf(sheet, 'tier-cost-forward').status, 'cannot');
    assert.match(idsOf(sheet, 'tier-cost-forward').reason, /only 4 of 20 forward units have a comparable tier source/);
    const c = idsOf(sheet, 'tier-source-comparable');
    assert.equal(c.status, 'cannot');
    assert.match(c.reason, /4 of 20 forward units/);
    assert.equal(c.population, 'forward');
  });

  it('a population left out by --population gives a cannot row with n 0, never a missing row', () => {
    const sheet = buildSheet('tier', { populations: [tierPop('reconstructed', [row('A', 12), row('B', 11)])], minN: 10 });
    assert.deepEqual(sheet.map((r) => r.id), ['tier-cost-forward', 'tier-cost-reconstructed', 'tier-source-comparable']);
    assert.equal(idsOf(sheet, 'tier-cost-forward').n, 0);
  });
});

const one = (parts, model = 'm-one') => [{ model, parts, usd_nano: 5_000_000_000 }];
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 6, 2, 0, 0);
const costInput = (advisor) => ({
  populations: [{ population: 'forward', units: 12, costed: 12, low_evidence: false }, { population: 'reconstructed', units: 9, costed: 9, low_evidence: true }],
  samples: { forward: ['k1', 'k2'], reconstructed: [] }, advisor, minN: 10,
});
const state = (over) => ({
  snapshots: 3, snapshots_null: 0, models_seen: ['m-one', 'm-two'], baseline: 'm-one', changed: true, change_model: 'm-two', window_start_ms: T0,
  window_end_ms: T0 + ADVISOR_WINDOW_DAYS * DAY, baseline_start_ms: T0 - ADVISOR_WINDOW_DAYS * DAY, window_days: ADVISOR_WINDOW_DAYS, full: true, ...over,
});
// The advisor input of the loader: scope window carries baseline and trial, scope all carries models.
const windows = (baseline, trial, stateOver = {}) => ({ state: state(stateOver), scope: 'window', models: [], baseline, trial });
const noWindow = (models, stateOver) => ({
  state: state({ changed: false, models_seen: ['m-one'], change_model: null, window_start_ms: null, window_end_ms: null, baseline_start_ms: null, full: false, ...stateOver }),
  scope: 'all', models, baseline: [], trial: [],
});

describe('cost rows and the advisor-trial row (03-05 Task 3, D-25; review M4)', () => {
  it('cost sample rows follow the population costed counts; evidence ids come from the samples', () => {
    const sheet = buildSheet('cost', costInput(windows(one(10), one(8, 'm-two'))));
    assert.deepEqual(sheet.map((r) => r.id), ['cost-forward-sample', 'cost-reconstructed-sample', 'advisor-trial']);
    assert.equal(idsOf(sheet, 'cost-forward-sample').status, 'can decide today');
    assert.equal(idsOf(sheet, 'cost-forward-sample').evidence_ids.length, 2);
    assert.equal(idsOf(sheet, 'cost-reconstructed-sample').status, 'cannot');
    assert.match(idsOf(sheet, 'cost-reconstructed-sample').reason, /9 of 9 reconstructed units/);
  });

  it('advisor-trial is the last row, carries no recommendation, and is decidable only when the trial window has elapsed and both windows have parts', () => {
    const sheet = buildSheet('cost', costInput(windows(one(12), [{ model: 'm-two', parts: 11, usd_nano: null }])));
    const r = sheet[sheet.length - 1];
    assert.equal(r.id, 'advisor-trial');
    assert.equal(r.status, 'can decide today');
    assert.equal(r.n, 11, 'n is the smaller of the two windows');
    assert.equal(r.population, 'not-unit-level');
    assert.equal(r.consumer, 'owner-rigor-decisions');
    assert.deepEqual(r.evidence_ids, ['main/model=m-one', 'main/model=m-two']);
    assert.match(r.reason, /baseline window 2026-10-30T02:00:00\.000Z to 2026-11-06T02:00:00\.000Z: 12 parts/);
    assert.match(r.reason, /trial window 2026-11-06T02:00:00\.000Z to 2026-11-13T02:00:00\.000Z: 11 parts/);
    assert.match(r.reason, /window = 7 days from the first snapshot whose advisor_model differs from the earliest recorded value/);
    assert.match(r.reason, /role-share figures carry that confounder/);
    assert.match(r.reason, /m-two parts 11 notional usd \?/);
  });

  it('advisor-trial says cannot until the trial window has elapsed, even when both windows already hold parts', () => {
    const notFull = idsOf(buildSheet('cost', costInput(windows(one(12), one(12, 'm-two'), { full: false }))), 'advisor-trial');
    assert.equal(notFull.status, 'cannot');
    assert.match(notFull.reason, /not full yet/);
    assert.match(notFull.reason, /ends 2026-11-13T02:00:00\.000Z/);
    const single = idsOf(buildSheet('cost', costInput(noWindow(one(10)))), 'advisor-trial');
    assert.equal(single.status, 'cannot');
    assert.match(single.reason, /no snapshot with a different value exists, so no window has started/);
    assert.equal(single.n, 10);
  });

  it('advisor-trial stays cannot with the specific reason when a window has no advisor part, or too few parts', () => {
    const noBase = idsOf(buildSheet('cost', costInput(windows([], one(30, 'm-two')))), 'advisor-trial');
    assert.equal(noBase.status, 'cannot');
    assert.match(noBase.reason, /the baseline window has no advisor part/);
    const noTrial = idsOf(buildSheet('cost', costInput(windows(one(30), []))), 'advisor-trial');
    assert.equal(noTrial.status, 'cannot');
    assert.match(noTrial.reason, /the trial window has no advisor part/);
    const few = idsOf(buildSheet('cost', costInput(windows(one(3), one(8, 'm-two')))), 'advisor-trial');
    assert.equal(few.status, 'cannot');
    assert.equal(few.low_evidence, true);
    assert.equal(few.n, 3);
  });

  it('advisor-trial with no snapshot says so and has n 0 and no recommendation word', () => {
    const r = idsOf(buildSheet('cost', costInput(noWindow([], { snapshots: 0, models_seen: [], baseline: null }))), 'advisor-trial');
    assert.equal(r.status, 'cannot');
    assert.equal(r.n, 0);
    assert.match(r.reason, /no environment snapshot records an advisor_model/);
  });
});

describe('every row names consumer n and population (03-05 Task 3, TRUST-03, TRUST-09)', () => {
  it('on all three surfaces: ROW_KEYS exactly, a SIGNALS consumer in CONSUMERS, n and population, the evidence rule, the fixed order', () => {
    const rowsAt = [row('A', 12, ['u:a']), row('B', 11, ['u:b'])];
    const all = [
      buildSheet('units', emptyUnitsInput({
        calibration: calibrateFields(Array.from({ length: 6 }, () => pairRow()), new Map()), strata: [stratum('forward', 12), stratum('reconstructed', 12)],
        units: Array.from({ length: 12 }, (_, i) => fwdUnit(i)), unrecorded: { cutoff_day: '2026-10-30', n: 12, k: 3, first_seen_unknown: 0 },
        incomplete: { n: 0, listed: [], omitted: 0 },
      })),
      buildSheet('tier', { populations: [tierPop('forward', rowsAt), tierPop('reconstructed', rowsAt)], minN: 10 }),
      buildSheet('cost', costInput(windows(one(10), one(8, 'm-two')))),
    ];
    const seen = all.flat().map((r) => r.id);
    assert.deepEqual(seen, ROW_IDS.filter((id) => seen.includes(id)), 'surfaces in ROW_IDS order');
    assert.equal(seen.length, ROW_IDS.length, 'every row id appears once');
    for (const r of all.flat()) {
      assert.deepEqual(Object.keys(r), [...ROW_KEYS], r.id);
      assert.equal(r.consumer, SIGNALS.find((s) => s.id === r.signal).consumer, r.id);
      assert.ok(Object.hasOwn(CONSUMERS, r.consumer));
      assert.ok(Number.isInteger(r.n) && r.n >= 0, `${r.id} has n`);
      assert.ok(typeof r.population === 'string' && r.population !== '');
      assert.ok(r.evidence_ids.length <= MAX_EVIDENCE_IDS);
      if (r.status === 'can decide today') {
        assert.ok(r.evidence_ids.length >= 1, `${r.id} can row has an evidence id`);
        if (r.id !== 'units-unclosed') assert.equal(r.low_evidence, false, `${r.id} can row is not low evidence`);
      }
      assert.ok(!Object.keys(r).some((k) => /count|total|score|rank/.test(k)));
    }
    assert.equal(ROW_IDS.length, 13);
    assert.equal(ROW_IDS[ROW_IDS.length - 1], 'advisor-trial');
  });
});

// ---- review fix M2, H1 sheet text, L1 ----------------------------------------------------------------------------------------
describe('calibrate rows count compared pairs (review M2) and say how the time fields were compared (review H1)', () => {
  const rowOf = (rows, id) => rows.find((r) => r.id === id);
  it('five pairs with an unknown reconstructed tier are cannot, low evidence, reason `compared pairs 0 of 5 needed`', () => {
    const cal = calibrateFields(Array.from({ length: 5 }, () => pairRow({ recon_tier: null })), new Map());
    const r = rowOf(buildSheet('units', emptyUnitsInput({ calibration: cal })), 'calibrate-tier');
    assert.equal(r.status, 'cannot');
    assert.equal(r.low_evidence, true);
    assert.equal(r.n, 5);
    assert.match(r.reason, /compared pairs 0 of 5 needed/);
    assert.match(r.reason, /unknown 5/);
  });

  it('five compared pairs can be decided; four compared plus one unknown cannot', () => {
    const mk = (extra) => rowOf(buildSheet('units', emptyUnitsInput({ calibration: calibrateFields(extra, new Map()) })), 'calibrate-tier');
    assert.equal(mk(Array.from({ length: 5 }, () => pairRow())).status, 'can decide today');
    const four = mk([...Array.from({ length: 4 }, () => pairRow()), pairRow({ recon_tier: null })]);
    assert.equal(four.status, 'cannot');
    assert.match(four.reason, /compared pairs 4 of 5 needed/);
  });

  it('start and end rows name how many pairs were compared by instant and by day', () => {
    const T = Date.UTC(2026, 9, 30, 0, 0, 0);
    const rows = Array.from({ length: 5 }, () => pairRow({ recon_date_source: 'quick-id', ledger_start_ms: T + 3600000, recon_start_ms: T }));
    const r = rowOf(buildSheet('units', emptyUnitsInput({ calibration: calibrateFields(rows, new Map(), { tz: 'UTC' }) })), 'calibrate-start');
    assert.equal(r.status, 'can decide today');
    assert.match(r.reason, /compared by instant 0, by day 5/);
  });
});

describe('units-ledger-use with every unit recorded (review L1)', () => {
  it('k 0 of n 12 is still decidable: the evidence ids are forward units, not a downgrade', () => {
    const units = Array.from({ length: 12 }, (_, i) => fwdUnit(i));
    const sheet = buildSheet('units', emptyUnitsInput({
      strata: [stratum('forward', 12)], units, unrecorded: { cutoff_day: '2026-10-30', n: 12, k: 0, first_seen_unknown: 0 },
    }));
    const r = idsOf(sheet, 'units-ledger-use');
    assert.equal(r.status, 'can decide today');
    assert.ok(r.evidence_ids.length >= 1);
    assert.doesNotMatch(r.reason, /no evidence id exists/);
  });
});
