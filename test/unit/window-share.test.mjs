// The pure window-share estimator and the percentage format (plan 01-06, D-11a, D-09, RR-04). Written before
// the code. Every expected value is hand-computed (arithmetic beside it) or comes from EXPECTED_WINDOW of
// test/fixtures/usage-cache.mjs; none is computed by the code under test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXPECTED_WINDOW, MS } from '../fixtures/usage-cache.mjs';
import { CALLS, msgId } from '../fixtures/cases/95-usage-window.mjs';
import {
  INTERVAL_STATUSES, MICRO, SAME_WINDOW_TOLERANCE_MS, WINDOWS, WINDOW_WEIGHTS, WINDOW_WEIGHTS_TEXT,
  classifyInterval, distribute, estimateWindowShares, partWeight,
} from '../../src/derive/window.mjs';
import { formatPct, known, pctCell, unknown } from '../../src/measure/measure.mjs';

const E = EXPECTED_WINDOW;
const tok = (input, output, cache_read, cache_creation) => ({ input_tokens: input, output_tokens: output, cache_read, cache_creation });
const throwsMatch = (fn, re) => {
  try {
    fn();
  } catch (err) {
    assert.match(String(err?.message), re);
    return;
  }
  assert.fail('expected a throw');
};

// The fixture series as estimator input: snapshots from EXPECTED_WINDOW.snapshotRows, parts from case 95.
const SNAPS = E.snapshotRows.map((r) => ({
  source: r[0], fetchedAtMs: r[2],
  five_hour: r[3] === null ? null : { pct: r[3], resetsMs: r[4] },
  seven_day: r[5] === null ? null : { pct: r[5], resetsMs: r[6] },
}));
const PARTS = CALLS.map(([n, , , time, [i, o, r, c]]) => ({
  callKey: `m:${msgId(n)}`, partSeq: 0, tsMs: Date.parse(`2026-10-26T${time}Z`), weight: c === undefined ? null : i + o + r + c,
}));
const asArrays = (res) => res.intervals.map((x) => [x.win, x.seq, x.startMs, x.endMs, x.startPct, x.endPct, x.resetsMs, x.status, x.deltaMicro, x.parts, x.weightTotal]);
const sharesOf = (res) => res.shares.map((s) => [s.callKey.slice(2), s.win, s.intervalSeq, s.shareMicro]);
const byKey = (rows) => rows.slice().sort((a, b) => (`${a[1]}|${a[0]}` < `${b[1]}|${b[0]}` ? -1 : 1));

describe('window estimator constants', () => {
  it('WINDOWS, MICRO, tolerance and the fixed status order', () => {
    assert.deepEqual(WINDOWS, ['five_hour', 'seven_day']);
    assert.equal(MICRO, 1000000);
    assert.equal(SAME_WINDOW_TOLERANCE_MS, 60000);
    assert.deepEqual(INTERVAL_STATUSES, ['usable', 'reset', 'falling', 'flat', 'unknown_tokens', 'zero_weight']);
  });

  it('WINDOW_WEIGHTS are equal and frozen, and WINDOW_WEIGHTS_TEXT is built from them', () => {
    assert.deepEqual({ ...WINDOW_WEIGHTS }, { input: 1, output: 1, cache_read: 1, cache_creation: 1 });
    assert.ok(Object.isFrozen(WINDOW_WEIGHTS));
    assert.equal(WINDOW_WEIGHTS_TEXT, 'input:1,output:1,cache_read:1,cache_creation:1');
  });
});

describe('partWeight', () => {
  it('sums the four classes with equal weights: 60 + 20 + 15 + 5 = 100', () => assert.equal(partWeight(tok(60, 20, 15, 5)), 100));
  it('is 0 for four zeros (a known zero)', () => assert.equal(partWeight(tok(0, 0, 0, 0)), 0));
  it('is null when any class is null', () => assert.equal(partWeight(tok(40, 10, 0, null)), null));
  it('is null when any class is undefined', () => assert.equal(partWeight({ input_tokens: 1, output_tokens: 1, cache_read: 1 }), null));
  it('is null when the sum is not a safe integer', () => assert.equal(partWeight(tok(Number.MAX_SAFE_INTEGER, 1, 0, 0)), null));
  it('follows a changed weight vector: input x2 gives 60 x 2 + 20 + 15 + 5 = 160', () => {
    assert.equal(partWeight(tok(60, 20, 15, 5), { input: 2, output: 1, cache_read: 1, cache_creation: 1 }), 160);
  });
});

describe('classifyInterval', () => {
  const a = { tsMs: MS.h09, pct: 10, resetsMs: MS.h13 };
  it('resets 59,999 ms apart are the same window: usable, delta (22 - 10) x 1e6', () => {
    assert.deepEqual(classifyInterval(a, { tsMs: MS.h12, pct: 22, resetsMs: MS.h13 + 59999 }), { status: 'usable', deltaMicro: 12000000 });
  });
  it('resets exactly 60,000 ms apart are still the same window', () => {
    assert.equal(classifyInterval(a, { tsMs: MS.h12, pct: 22, resetsMs: MS.h13 - 60000 }).status, 'usable');
  });
  it('resets 60,001 ms apart are a reset', () => {
    assert.deepEqual(classifyInterval(a, { tsMs: MS.h12, pct: 22, resetsMs: MS.h13 + 60001 }), { status: 'reset', deltaMicro: null });
  });
  it('a reset wins over a falling percentage', () => {
    assert.equal(classifyInterval(a, { tsMs: MS.h12, pct: 2, resetsMs: MS.h18 }).status, 'reset');
  });
  it('a falling percentage without a reset is falling', () => {
    assert.deepEqual(classifyInterval(a, { tsMs: MS.h12, pct: 9, resetsMs: MS.h13 }), { status: 'falling', deltaMicro: null });
  });
  it('an equal percentage is flat', () => {
    assert.deepEqual(classifyInterval(a, { tsMs: MS.h12, pct: 10, resetsMs: MS.h13 }), { status: 'flat', deltaMicro: null });
  });
  it('equal timestamps are not an interval', () => {
    assert.equal(classifyInterval(a, { ...a, pct: 12 }), null);
  });
  it('a fractional delta rounds to micro-points: 10 -> 12.5 is 2,500,000', () => {
    assert.equal(classifyInterval(a, { tsMs: MS.h12, pct: 12.5, resetsMs: MS.h13 }).deltaMicro, 2500000);
  });
});

describe('distribute (largest remainder, BigInt)', () => {
  it('1:1:1 over 1,000,000 gives 333,334, 333,333, 333,333 (the first remainder wins the tie)', () => {
    assert.deepEqual(distribute(1000000, [1, 1, 1]), [333334, 333333, 333333]);
  });
  it('100:200:0:300 over 12,000,000 gives 2,000,000, 4,000,000, 0, 6,000,000', () => {
    assert.deepEqual(distribute(12000000, [100, 200, 0, 300]), [2000000, 4000000, 0, 6000000]);
  });
  it('1:2 over 1,000,000: floors 333,333 and 666,666, remainders 1 and 2, the larger remainder gets the extra', () => {
    assert.deepEqual(distribute(1000000, [1, 2]), [333333, 666667]);
  });
  it('ties go by position: 1:1 over 1 gives 1 and 0', () => assert.deepEqual(distribute(1, [1, 1]), [1, 0]));
  it('a zero weight always gets 0, even with a remainder to hand out: 0:1:1 over 3 gives 0, 2, 1', () => {
    assert.deepEqual(distribute(3, [0, 1, 1]), [0, 2, 1]);
  });
  it('a 10^12 weight with a 100-point delta stays exact (BigInt products): shares sum to 100,000,000', () => {
    const w = [1e12, 1e12 + 1, 3];
    const s = distribute(100000000, w);
    assert.equal(s.reduce((x, y) => x + y, 0), 100000000);
    // 1e8 x 1e12 / (2e12 + 4) = 49,999,999.9 -> floor 49,999,999; 1e8 x (1e12 + 1) / (2e12 + 4) -> 50,000,000.0 floor 49,999,999
    assert.deepEqual(s.slice(0, 2).map((v) => Math.abs(v - 50000000) <= 1), [true, true]);
    assert.equal(s[2], 0, '3 / 2e12 of 1e8 is below one micro-point');
  });
  it('an empty list or a zero total returns null', () => {
    assert.equal(distribute(5, []), null);
    assert.equal(distribute(5, [0, 0]), null);
  });
  it('the shares always sum to the delta exactly over many weight vectors', () => {
    let x = 7;
    const rnd = (m) => { x = (x * 1103515245 + 12345) % 2147483648; return x % m; };
    for (let k = 0; k < 200; k += 1) {
      const weights = Array.from({ length: 1 + rnd(9) }, () => rnd(1000));
      if (weights.every((w) => w === 0)) weights[0] = 1;
      const delta = 1 + rnd(100000000);
      const s = distribute(delta, weights);
      assert.equal(s.reduce((a, b) => a + b, 0), delta);
      for (const [i, w] of weights.entries()) if (w === 0) assert.equal(s[i], 0);
    }
  });
});

describe('estimateWindowShares', () => {
  it('the fixture series gives the hand-computed intervals', () => {
    assert.deepEqual(asArrays(estimateWindowShares({ snapshots: SNAPS, parts: PARTS })), E.intervals);
  });

  it('the fixture series gives the hand-computed micro-point shares, one row per part inside an interval', () => {
    const got = sharesOf(estimateWindowShares({ snapshots: SNAPS, parts: PARTS }));
    assert.deepEqual(byKey(got), byKey(E.shares));
    assert.equal(got.length, 14, '7 parts inside the five-hour intervals and 7 inside the weekly ones');
  });

  it('a part exactly at the interval start is excluded and one exactly at the end is included (half-open)', () => {
    const s = [{ source: 'c', fetchedAtMs: 1000, five_hour: { pct: 1, resetsMs: 9e5 }, seven_day: null },
      { source: 'c', fetchedAtMs: 2000, five_hour: { pct: 3, resetsMs: 9e5 }, seven_day: null }];
    const p = [{ callKey: 'm:a', partSeq: 0, tsMs: 1000, weight: 1 }, { callKey: 'm:b', partSeq: 0, tsMs: 2000, weight: 1 }];
    assert.deepEqual(sharesOf(estimateWindowShares({ snapshots: s, parts: p })), [['b', 'five_hour', 0, 2000000]]);
  });

  it('unsorted snapshots and parts give the same result as sorted ones', () => {
    const sorted = estimateWindowShares({ snapshots: SNAPS, parts: PARTS });
    const shuffled = estimateWindowShares({ snapshots: [...SNAPS].reverse(), parts: [PARTS[4], ...PARTS.slice(5).reverse(), ...PARTS.slice(0, 4)] });
    assert.deepEqual(shuffled, sorted);
  });

  it('two snapshots in the same millisecond keep the first by source name bytewise', () => {
    const s = [
      { source: 'transcript', fetchedAtMs: 2000, five_hour: { pct: 50, resetsMs: 9e5 }, seven_day: null },
      { source: 'claude-json-cache', fetchedAtMs: 1000, five_hour: { pct: 1, resetsMs: 9e5 }, seven_day: null },
      { source: 'claude-json-cache', fetchedAtMs: 2000, five_hour: { pct: 3, resetsMs: 9e5 }, seven_day: null },
    ];
    const res = estimateWindowShares({ snapshots: s, parts: [{ callKey: 'm:a', partSeq: 0, tsMs: 1500, weight: 4 }] });
    assert.deepEqual(asArrays(res), [['five_hour', 0, 1000, 2000, 1, 3, 9e5, 'usable', 2000000, 1, 4]]);
  });

  it('fewer than two snapshots give no interval and no share', () => {
    const res = estimateWindowShares({ snapshots: SNAPS.slice(0, 1), parts: PARTS });
    assert.deepEqual(res, { intervals: [], shares: [] });
  });

  it('a part without a timestamp gets no row', () => {
    const res = estimateWindowShares({ snapshots: SNAPS, parts: [{ callKey: 'm:x', partSeq: 0, tsMs: null, weight: 5 }] });
    assert.deepEqual(res.shares, []);
  });

  it('an interval whose parts all weigh 0 is zero_weight with no share; one with no part is zero_weight too', () => {
    const s = [{ source: 'c', fetchedAtMs: 1000, five_hour: { pct: 1, resetsMs: 9e5 }, seven_day: null },
      { source: 'c', fetchedAtMs: 2000, five_hour: { pct: 3, resetsMs: 9e5 }, seven_day: null },
      { source: 'c', fetchedAtMs: 3000, five_hour: { pct: 4, resetsMs: 9e5 }, seven_day: null }];
    const res = estimateWindowShares({ snapshots: s, parts: [{ callKey: 'm:z', partSeq: 0, tsMs: 1500, weight: 0 }] });
    assert.deepEqual(res.intervals.map((x) => [x.status, x.deltaMicro, x.parts, x.weightTotal]), [['zero_weight', null, 1, 0], ['zero_weight', null, 0, 0]]);
    assert.deepEqual(sharesOf(res), [['z', 'five_hour', 0, null]]);
  });

  it('one unknown weight makes the whole interval unknown_tokens', () => {
    const s = SNAPS.slice(0, 2);
    const res = estimateWindowShares({ snapshots: s, parts: [{ callKey: 'm:a', partSeq: 0, tsMs: MS.h10, weight: 5 }, { callKey: 'm:b', partSeq: 0, tsMs: MS.h11, weight: null }] });
    assert.equal(res.intervals[0].status, 'unknown_tokens');
    assert.deepEqual(res.shares.map((x) => x.shareMicro), [null, null, null, null].slice(0, res.shares.length));
  });

  it('a snapshot without a window is left out of that window series only', () => {
    const s = [SNAPS[0], { ...SNAPS[1], five_hour: null }, SNAPS[2]];
    const res = estimateWindowShares({ snapshots: s, parts: [] });
    assert.deepEqual(res.intervals.map((x) => [x.win, x.startMs, x.endMs]), [
      ['five_hour', MS.h09, MS.h15], ['seven_day', MS.h09, MS.h12], ['seven_day', MS.h12, MS.h15],
    ]);
  });

  it('a part with several parts of one call keeps (timestamp, call key, part seq) order inside the interval', () => {
    const s = SNAPS.slice(0, 2);
    const p = [
      { callKey: 'm:b', partSeq: 1, tsMs: MS.h10, weight: 1 }, { callKey: 'm:b', partSeq: 0, tsMs: MS.h10, weight: 1 },
      { callKey: 'm:a', partSeq: 0, tsMs: MS.h10, weight: 1 },
    ];
    const res = estimateWindowShares({ snapshots: s, parts: p });
    // 12,000,000 / 3 = 4,000,000 each; order a/0, b/0, b/1
    assert.deepEqual(res.shares.filter((x) => x.win === 'five_hour').map((x) => [x.callKey, x.partSeq, x.shareMicro]), [
      ['m:a', 0, 4000000], ['m:b', 0, 4000000], ['m:b', 1, 4000000],
    ]);
  });
});

describe('formatPct and pctCell', () => {
  for (const [value, text] of [
    [0, '0.00%'], [0.000001, '<0.01%'], [0.004999, '<0.01%'], [0.005, '0.01%'], [4, '4.00%'], [11, '11.00%'],
    [0.125, '0.13%'], [9, '9.00%'], [100, '100.00%'], [33.333334, '33.33%'],
  ]) {
    it(`formatPct(${value}) is ${text}`, () => assert.equal(formatPct(value), text));
  }
  it('formatPct throws on a negative number, NaN and a non-number', () => {
    throwsMatch(() => formatPct(-0.01), /formatPct/);
    throwsMatch(() => formatPct(Number.NaN), /formatPct/);
    throwsMatch(() => formatPct('4'), /formatPct/);
  });
  it('pctCell prints ? for an unknown Measure and for null, and the percentage for a known one', () => {
    assert.equal(pctCell(null), '?');
    assert.equal(pctCell(unknown({ n: 3 })), '?');
    assert.equal(pctCell(known(4, { label: 'estimated', n: 1 })), '4.00%');
    assert.equal(pctCell(known(0, { label: 'estimated', n: 1 })), '0.00%');
  });
});
