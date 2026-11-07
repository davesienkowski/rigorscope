// Plan 01-07 Task 2: error-band arithmetic, nearest-rank percentiles and counted rates (COST-05, TRUST-01, D-09).
// Written before src/measure/stats.mjs (RED). Money is integer nano-dollars; errors are integer parts per million
// of the measured cost, rounded half up with BigInt; nothing unknown is ever rendered as 0. Every expected value
// is hand-computed in a comment beside it.
//
// bandStats(rows) row: { key, derivedNano, measuredNano, calls, role, model, topLevelOnly, floor }
//   -> { n, excluded: { derived_unknown, measured_unknown, zero_measured }, medianPpm, p99Ppm, maxPpm,
//        sumDerivedNano, sumMeasuredNano, diffNano, diffPpm, topLevelOnly, floor, outliers: [{ key, errPpm, ... }] }
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  errPpm, nearestRank, bandStats, rateBp, formatRate, formatPpmPercent,
} = await import(new URL('../../src/measure/stats.mjs', import.meta.url).href);

// The joined requests of case otel-join: [key, derived, measured, calls, role, model].
const FIXTURE = [
  ['req_oj_a', 600000, 600000, 1, 'main', 'claude-opus-5-5'],
  ['req_oj_b', 250000, 250000, 1, 'Explore', 'claude-haiku-5-5'],
  ['req_oj_c', 2000000, 2100000, 1, 'fork', 'claude-sonnet-5-5'],
  ['req_oj_d', 15000, 15600, 1, 'claude-code-guide', 'claude-haiku-5-5'],
  ['req_oj_e', 120000, 125000, 1, 'gsd-executor', 'claude-sonnet-5-5'],
  ['req_oj_g', 12000, 12100, 1, 'main', 'claude-haiku-5-5'],
].map(([key, derivedNano, measuredNano, calls, role, model]) => ({
  key, derivedNano, measuredNano, calls, role, model, topLevelOnly: 1, floor: 0,
}));
const row = (key, derivedNano, measuredNano, extra = {}) => ({
  key, derivedNano, measuredNano, calls: 1, role: 'main', model: 'claude-haiku-5-5', topLevelOnly: 0, floor: 0, ...extra,
});

describe('errPpm', () => {
  it('equal derived and measured costs give 0', () => {
    assert.equal(errPpm(600000, 600000), 0);
    assert.equal(errPpm(250000, 250000), 0);
  });

  it('gives the fixture errors: G 8264, D 38462, E 40000, C 47619', () => {
    assert.equal(errPpm(12000, 12100), 8264); //       100 x 1e6 / 12,100 = 8264.46
    assert.equal(errPpm(15000, 15600), 38462); //      600 x 1e6 / 15,600 = 38461.54
    assert.equal(errPpm(120000, 125000), 40000); //    5,000 x 1e6 / 125,000
    assert.equal(errPpm(2000000, 2100000), 47619); //  100,000 x 1e6 / 2,100,000 = 47619.05
  });

  it('is an absolute error: derived 0 against a positive measured cost is 1,000,000; above and below are symmetric', () => {
    assert.equal(errPpm(0, 5000), 1000000);
    assert.equal(errPpm(110, 100), 100000); // 10 x 1e6 / 100
    assert.equal(errPpm(90, 100), 100000);
  });

  it('rounds half up: exactly half a ppm rounds away from zero, just below rounds down', () => {
    assert.equal(errPpm(2000001, 2000000), 1); // 1 x 1e6 / 2,000,000 = 0.5
    assert.equal(errPpm(1999999, 2000000), 1);
    assert.equal(errPpm(2000000, 2000001), 0); // 1e6 / 2,000,001 = 0.4999998
    assert.equal(errPpm(1, 3), 666667); //       2 x 1e6 / 3 = 666666.67
  });

  it('is exact for values near 1e11 nano-dollars', () => {
    assert.equal(errPpm(100000050000, 100000000000), 1); //  50,000 x 1e6 / 1e11 = 0.5
    assert.equal(errPpm(99999999999, 100000000000), 0); //   1e6 / 1e11 = 0.00001
    assert.equal(errPpm(400000000000, 300000000000), 333333); // 1e11 x 1e6 / 3e11 = 333333.33
  });

  it('is null for an unknown, negative, fractional or non-number input, and for a measured cost of 0', () => {
    for (const [d, m] of [[null, 1], [1, null], [undefined, 1], [-1, 5], [5, -1], [1.5, 2], [1, 2.5], ['5', 5], [Number.NaN, 5], [5, 0], [0, 0], [2 ** 53, 5]]) {
      assert.equal(errPpm(d, m), null, `${String(d)} ${String(m)}`);
    }
  });
});

describe('nearestRank', () => {
  it('is null for an empty list', () => {
    assert.equal(nearestRank([], 50), null);
  });

  it('takes rank ceil(p x n / 100), 1-based', () => {
    const six = [0, 0, 8264, 38462, 40000, 47619];
    assert.equal(nearestRank(six, 50), 8264); //  rank ceil(3) = 3
    assert.equal(nearestRank(six, 99), 47619); // rank ceil(5.94) = 6
    assert.equal(nearestRank(six, 100), 47619);
    assert.equal(nearestRank(six, 1), 0); //       rank ceil(0.06) = 1
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(nearestRank(hundred, 99), 99);
    assert.equal(nearestRank(hundred, 50), 50);
    assert.equal(nearestRank([7], 99), 7);
  });
});

describe('bandStats', () => {
  it('gives the fixture band: n 6, median 8264, p99 and max 47619, the sums, the signed difference and its ppm', () => {
    const b = bandStats(FIXTURE);
    assert.equal(b.n, 6);
    assert.deepEqual([b.medianPpm, b.p99Ppm, b.maxPpm], [8264, 47619, 47619]);
    assert.equal(b.sumDerivedNano, 2997000); //   600,000+250,000+2,000,000+15,000+120,000+12,000
    assert.equal(b.sumMeasuredNano, 3102700); //  600,000+250,000+2,100,000+15,600+125,000+12,100
    assert.equal(b.diffNano, -105700);
    assert.equal(b.diffPpm, -34067); //           105,700 x 1e6 / 3,102,700 = 34067.1
    assert.deepEqual({ ...b.excluded }, { derived_unknown: 0, measured_unknown: 0, zero_measured: 0 });
    assert.deepEqual([b.topLevelOnly, b.floor], [6, 0]);
  });

  it('lists the non-zero errors as outliers, largest first: req_oj_c, req_oj_e, req_oj_d, req_oj_g', () => {
    const b = bandStats(FIXTURE);
    assert.deepEqual(b.outliers.map((o) => [o.key, o.errPpm, o.derivedNano, o.measuredNano, o.calls, o.role, o.model]), [
      ['req_oj_c', 47619, 2000000, 2100000, 1, 'fork', 'claude-sonnet-5-5'],
      ['req_oj_e', 40000, 120000, 125000, 1, 'gsd-executor', 'claude-sonnet-5-5'],
      ['req_oj_d', 38462, 15000, 15600, 1, 'claude-code-guide', 'claude-haiku-5-5'],
      ['req_oj_g', 8264, 12000, 12100, 1, 'main', 'claude-haiku-5-5'],
    ]);
  });

  it('excludes by the first applicable reason: derived_unknown, then measured_unknown, then zero_measured', () => {
    const b = bandStats([
      row('a', null, 0), row('b', null, null), row('c', 5, null), row('d', 5, 0), row('e', 0, 0), row('f', 10, 10),
    ]);
    assert.deepEqual({ ...b.excluded }, { derived_unknown: 2, measured_unknown: 1, zero_measured: 2 });
    assert.equal(b.n, 1);
    assert.deepEqual([b.medianPpm, b.sumDerivedNano, b.sumMeasuredNano, b.diffNano, b.diffPpm], [0, 10, 10, 0, 0]);
  });

  it('an empty band has n 0 and every figure null, never 0, with real exclusion and flag counts', () => {
    for (const rows of [[], [row('a', null, 5, { topLevelOnly: 1 }), row('b', 5, 0, { floor: 1 })]]) {
      const b = bandStats(rows);
      assert.equal(b.n, 0);
      for (const k of ['medianPpm', 'p99Ppm', 'maxPpm', 'sumDerivedNano', 'sumMeasuredNano', 'diffNano', 'diffPpm']) assert.equal(b[k], null, k);
      assert.deepEqual(b.outliers, []);
      assert.deepEqual([b.topLevelOnly, b.floor], [0, 0], 'excluded requests are not counted as band flags');
    }
  });

  it('keeps at most five outliers, ties ordered by request key, and never lists a zero error', () => {
    const rows = [
      row('k7', 110, 100), row('k2', 110, 100), row('k5', 120, 100), row('k1', 101, 100), row('k3', 100, 100),
      row('k9', 130, 100), row('k4', 105, 100), row('k8', 102, 100),
    ];
    const b = bandStats(rows);
    // errors: k9 300000, k5 200000, k2 100000, k7 100000, k4 50000, k8 20000, k1 10000, k3 0
    assert.deepEqual(b.outliers.map((o) => o.key), ['k9', 'k5', 'k2', 'k7', 'k4']);
    assert.equal(bandStats([row('z', 7, 7)]).outliers.length, 0);
  });

  it('does not depend on the order of the input rows', () => {
    const a = bandStats(FIXTURE);
    const b = bandStats([...FIXTURE].reverse());
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  });

  it('a positive difference keeps its sign: derived above measured', () => {
    const b = bandStats([row('a', 120, 100), row('b', 100, 100)]);
    assert.equal(b.diffNano, 20);
    assert.equal(b.diffPpm, 100000); // 20 x 1e6 / 200
    assert.equal(b.medianPpm, 0); //    rank ceil(1) = 1 of [0, 200000]
    assert.equal(b.p99Ppm, 200000); //  rank ceil(1.98) = 2
  });
});

describe('rateBp and formatRate', () => {
  it('rateBp is the half-up integer of n x 10000 / d', () => {
    assert.equal(rateBp(6, 15), 4000);
    assert.equal(rateBp(6, 13), 4615); // 4615.38
    assert.equal(rateBp(5, 10), 5000);
    assert.equal(rateBp(2, 3), 6667); //  6666.67
    assert.equal(rateBp(1, 32), 313); //  312.5, half up
    assert.equal(rateBp(0, 7), 0);
  });

  it('rateBp is null for a zero denominator and for inputs that are not non-negative integers', () => {
    for (const [n, d] of [[0, 0], [3, 0], [-1, 3], [1.5, 3], [1, null], [null, 3], ['1', 3]]) assert.equal(rateBp(n, d), null, `${String(n)}/${String(d)}`);
  });

  it('formatRate prints n/d with the percentage, or (?) for a zero denominator, never 0 percent', () => {
    assert.equal(formatRate(6, 15), '6/15 (40.00%)');
    assert.equal(formatRate(6, 13), '6/13 (46.15%)');
    assert.equal(formatRate(5, 10), '5/10 (50.00%)');
    assert.equal(formatRate(0, 1), '0/1 (0.00%)');
    assert.equal(formatRate(0, 0), '0/0 (?)');
    assert.equal(formatRate(1, 32), '1/32 (3.13%)');
    assert.equal(formatRate(15, 15), '15/15 (100.00%)');
  });
});

describe('formatPpmPercent', () => {
  it('prints the half-up two-decimal percent of a ppm value', () => {
    assert.equal(formatPpmPercent(8264), '0.83%');
    assert.equal(formatPpmPercent(47619), '4.76%');
    assert.equal(formatPpmPercent(40000), '4.00%');
    assert.equal(formatPpmPercent(38462), '3.85%');
    assert.equal(formatPpmPercent(50), '0.01%');
    assert.equal(formatPpmPercent(1000000), '100.00%');
  });

  it('keeps zero, tiny, and unknown apart: 0.00%, <0.01% and ?', () => {
    assert.equal(formatPpmPercent(0), '0.00%');
    assert.equal(formatPpmPercent(1), '<0.01%');
    assert.equal(formatPpmPercent(49), '<0.01%');
    assert.equal(formatPpmPercent(null), '?');
    assert.equal(formatPpmPercent(undefined), '?');
  });

  it('signed: a negative value gets a leading minus, a positive none', () => {
    assert.equal(formatPpmPercent(-34067, { signed: true }), '-3.41%');
    assert.equal(formatPpmPercent(34067, { signed: true }), '3.41%');
    assert.equal(formatPpmPercent(-10, { signed: true }), '-<0.01%');
    assert.equal(formatPpmPercent(0, { signed: true }), '0.00%');
  });
});
