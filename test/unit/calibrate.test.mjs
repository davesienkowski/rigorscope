// Plan 03-05 (LEDG-06, D-19): calibrateFields is pure over plain derived `unit` rows and a link map. A reconstruction value of
// NULL is unknown, never disagree; a ledger value of NULL leaves the pair out of that field's n; no total exists.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pairRow } from '../fixtures/calibrate-rows.mjs';
import { FIELDS, LOW_EVIDENCE_PAIRS, TIME_TOLERANCE_MIN, calibrateFields } from '../../src/report/calibrate.mjs';

const field = (doc, name) => doc.fields.find((f) => f.field === name);

describe('calibrate tracer (03-05 Task 1)', () => {
  it('constants: four fields in order, floor 5, tolerance 30', () => {
    assert.deepEqual([...FIELDS], ['tier', 'start', 'end', 'session']);
    assert.equal(LOW_EVIDENCE_PAIRS, 5);
    assert.equal(TIME_TOLERANCE_MIN, 30);
  });

  it('one pair whose ledger tier differs from the reconstructed letter is one disagree, n 1, low evidence', () => {
    const doc = calibrateFields([pairRow()], new Map());
    assert.equal(doc.pairs, 1);
    assert.equal(doc.ledger_only, 0);
    const t = field(doc, 'tier');
    assert.deepEqual([t.agree, t.disagree, t.unknown, t.n, t.low_evidence], [0, 1, 0, 1, true]);
    assert.equal(t.disagree_ids.length, 1);
    assert.match(t.disagree_ids[0], /^u:/);
  });

  it('unknown is not wrong: a NULL reconstructed tier and a tier_conflict reconstruction both count unknown', () => {
    const doc = calibrateFields([pairRow({ recon_tier: null }), pairRow({ recon_tier: 'C', tier_conflict: 1 }), pairRow({ recon_tier: 'B' })], new Map());
    const t = field(doc, 'tier');
    assert.deepEqual([t.agree, t.disagree, t.unknown, t.n], [1, 0, 2, 3]);
  });

  it('a pair whose ledger tier is NULL (tier_signal not ledger) leaves the tier field and is counted as ledger_unrecorded', () => {
    const doc = calibrateFields([pairRow({ tier: 'A', tier_signal: 'frontmatter' }), pairRow()], new Map());
    const t = field(doc, 'tier');
    assert.deepEqual([t.n, t.ledger_unrecorded], [1, 1]);
  });
});

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const MIN = 60_000;
const timed = (over) => pairRow({ ledger_start_ms: T0, recon_start_ms: T0, ...over });

describe('the four fields (03-05 Task 2, J2, J3)', () => {
  it('start: offsets 10 and 45 minutes give agree 1, disagree 1, median 10, max 45 and within 30', () => {
    const doc = calibrateFields([timed({ ledger_start_ms: T0 + 10 * MIN }), timed({ ledger_start_ms: T0 + 45 * MIN })], new Map());
    const f = field(doc, 'start');
    assert.deepEqual([f.agree, f.disagree, f.unknown, f.n, f.median_min, f.max_min, f.within_min], [1, 1, 0, 2, 10, 45, 30]);
  });

  it('start: a difference of exactly 30 minutes agrees and 31 disagrees, in either direction', () => {
    const doc = calibrateFields([timed({ ledger_start_ms: T0 + 30 * MIN }), timed({ ledger_start_ms: T0 - 31 * MIN })], new Map());
    const f = field(doc, 'start');
    assert.deepEqual([f.agree, f.disagree], [1, 1]);
    assert.equal(f.max_min, 31);
  });

  it('unknown is not wrong: a NULL reconstructed start or end counts unknown and a NULL ledger value leaves the pair out', () => {
    const doc = calibrateFields([
      timed({ recon_start_ms: null, ledger_end_ms: T0, recon_end_ms: null }),
      timed({ ledger_start_ms: null, ledger_end_ms: null }),
    ], new Map());
    const s = field(doc, 'start');
    assert.deepEqual([s.agree, s.disagree, s.unknown, s.n, s.ledger_unrecorded, s.median_min, s.max_min], [0, 0, 1, 1, 1, null, null]);
    const e = field(doc, 'end');
    assert.deepEqual([e.unknown, e.n, e.ledger_unrecorded], [1, 1, 1]);
  });

  it('end: a clamped derived end counts unknown and stays in n', () => {
    const doc = calibrateFields([
      timed({ ledger_end_ms: T0 + MIN, recon_end_ms: T0 + MIN, end_source: 'clamped' }),
      timed({ ledger_end_ms: T0 + MIN, recon_end_ms: T0 + MIN }),
    ], new Map());
    const e = field(doc, 'end');
    assert.deepEqual([e.agree, e.disagree, e.unknown, e.n, e.median_min, e.max_min], [1, 0, 1, 2, 0, 0]);
  });

  it('session: no link row is unknown, a link to another session is disagree, a matching link is agree, a NULL ledger session is out', () => {
    const rows = [
      pairRow({ unit_key: 'k-none', ledger_session_id: 's1' }),
      pairRow({ unit_key: 'k-other', ledger_session_id: 's1' }),
      pairRow({ unit_key: 'k-match', ledger_session_id: 's1' }),
      pairRow({ unit_key: 'k-null', ledger_session_id: null }),
    ];
    const links = new Map([['k-other', new Set(['s2'])], ['k-match', new Set(['s2', 's1'])]]);
    const f = field(calibrateFields(rows, links), 'session');
    assert.deepEqual([f.agree, f.disagree, f.unknown, f.n, f.ledger_unrecorded], [1, 1, 1, 3, 1]);
    assert.equal(f.disagree_ids.length, 1);
    assert.ok(!JSON.stringify(f).includes('s1'), 'no session id in the field figures');
  });

  it('low evidence: 4 pairs are low, 5 are not, and a field with no pair prints n 0, low evidence and null medians', () => {
    const four = calibrateFields(Array.from({ length: 4 }, () => pairRow()), new Map());
    const five = calibrateFields(Array.from({ length: 5 }, () => pairRow()), new Map());
    assert.equal(field(four, 'tier').low_evidence, true);
    assert.equal(field(five, 'tier').low_evidence, false);
    const none = field(calibrateFields([], new Map()), 'start');
    assert.deepEqual([none.n, none.low_evidence, none.median_min, none.max_min], [0, true, null, null]);
  });

  it('ledger-only units are counted apart and enter no field', () => {
    const doc = calibrateFields([pairRow({ has_recon: 0, recon_tier: null }), pairRow()], new Map());
    assert.deepEqual([doc.pairs, doc.ledger_only], [1, 1]);
    assert.equal(field(doc, 'tier').n, 1);
  });

  it('there is no total, rate or composite key anywhere in the document', () => {
    const doc = calibrateFields([pairRow()], new Map());
    assert.deepEqual(Object.keys(doc), ['pairs', 'ledger_only', 'fields']);
    const keys = [];
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
    walk(doc);
    assert.ok(!keys.some((k) => /total|rate|accuracy|composite|overall|score/.test(k)), keys.join(','));
  });

  it('at most 5 disagreeing ids per field, the rest counted', () => {
    const doc = calibrateFields(Array.from({ length: 7 }, () => pairRow()), new Map());
    const t = field(doc, 'tier');
    assert.deepEqual([t.disagree, t.disagree_ids.length, t.disagree_omitted], [7, 5, 2]);
  });
});

// ---- review fix H1/M1/M2 (03-05 REVIEW): day-precision reconstruction, the reconstruction's own clamp, the compared floor ----------
const NY = 'America/New_York';
const dayRow = (over) => pairRow({ recon_date_source: 'quick-id', ...over });
// 2026-10-30 local midnight in New York is 04:00Z (EDT); the ledger instants below are on that local day or the next.
const NY_MIDNIGHT = Date.UTC(2026, 9, 30, 4, 0, 0);
const HOUR = 60 * MIN;

describe('day-precision reconstruction is compared by local day, never as an instant (review H1)', () => {
  it('a quick-id start on the same local day agrees with no minute difference; another day disagrees; neither enters median or max', () => {
    const doc = calibrateFields([
      dayRow({ ledger_start_ms: NY_MIDNIGHT + 14 * HOUR, recon_start_ms: NY_MIDNIGHT }),
      dayRow({ ledger_start_ms: NY_MIDNIGHT + 30 * HOUR, recon_start_ms: NY_MIDNIGHT }),
    ], new Map(), { tz: NY });
    const f = field(doc, 'start');
    assert.deepEqual([f.agree, f.disagree, f.unknown, f.n, f.median_min, f.max_min], [1, 1, 0, 2, null, null]);
    assert.deepEqual(f.compared_by, { instant: 0, day: 2 });
  });

  it('the day is the local day of the report zone: 22:00 New York is the next UTC day but the same local day', () => {
    const row = dayRow({ ledger_start_ms: Date.UTC(2026, 9, 31, 2, 0, 0), recon_start_ms: NY_MIDNIGHT });
    assert.equal(field(calibrateFields([row], new Map(), { tz: NY }), 'start').agree, 1);
    assert.equal(field(calibrateFields([row], new Map(), { tz: 'UTC' }), 'start').disagree, 1);
  });

  it('a frontmatter end is a day source too; an instant source (git) keeps the minute rule and the median', () => {
    const doc = calibrateFields([
      pairRow({ recon_end_source: 'frontmatter', ledger_end_ms: NY_MIDNIGHT + 5 * HOUR, recon_end_ms: NY_MIDNIGHT + 24 * HOUR - 1 }),
      pairRow({ recon_end_source: 'git', ledger_end_ms: NY_MIDNIGHT + 20 * MIN, recon_end_ms: NY_MIDNIGHT }),
    ], new Map(), { tz: NY });
    const e = field(doc, 'end');
    assert.deepEqual([e.agree, e.disagree, e.n, e.median_min, e.max_min], [2, 0, 2, 20, 20]);
    assert.deepEqual(e.compared_by, { instant: 1, day: 1 });
  });

  it('a precision mismatch is never a disagree: a day pair 14 hours apart as instants agrees when the day is the same', () => {
    const f = field(calibrateFields([dayRow({ ledger_start_ms: NY_MIDNIGHT + 14 * HOUR, recon_start_ms: NY_MIDNIGHT })], new Map(), { tz: NY }), 'start');
    assert.equal(f.disagree, 0);
  });

  it('tier and session fields carry no compared_by', () => {
    const doc = calibrateFields([pairRow()], new Map());
    assert.equal(Object.hasOwn(field(doc, 'tier'), 'compared_by'), false);
    assert.equal(Object.hasOwn(field(doc, 'session'), 'compared_by'), false);
  });
});

describe('the reconstruction end that was itself clamped is unknown (review M1)', () => {
  it('recon_end_source clamped counts unknown whatever the values, and stays in n', () => {
    const f = field(calibrateFields([
      pairRow({ recon_end_source: 'clamped', ledger_end_ms: T0, recon_end_ms: T0 }),
      pairRow({ ledger_end_ms: T0, recon_end_ms: T0 }),
    ], new Map()), 'end');
    assert.deepEqual([f.agree, f.disagree, f.unknown, f.n], [1, 0, 1, 2]);
  });
});

describe('the evidence floor counts compared pairs, not unknown ones (review M2)', () => {
  it('five pairs whose reconstructed tier is unknown: n 5, compared 0, low evidence', () => {
    const f = field(calibrateFields(Array.from({ length: 5 }, () => pairRow({ recon_tier: null })), new Map()), 'tier');
    assert.deepEqual([f.unknown, f.n, f.compared, f.low_evidence], [5, 5, 0, true]);
  });

  it('four compared plus one unknown is low; five compared is not', () => {
    const four = field(calibrateFields([...Array.from({ length: 4 }, () => pairRow()), pairRow({ recon_tier: null })], new Map()), 'tier');
    const five = field(calibrateFields(Array.from({ length: 5 }, () => pairRow()), new Map()), 'tier');
    assert.deepEqual([four.compared, four.n, four.low_evidence], [4, 5, true]);
    assert.deepEqual([five.compared, five.low_evidence], [5, false]);
  });
});
