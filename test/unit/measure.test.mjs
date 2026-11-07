// Plan 01-04 Task 2: the full Measure test 01-01 left to this plan (TRUST-01, TRUST-02, RR-04, RR-05).
// Measure = { value, n, label, coverage, evidence }; null means unknown and forces the label unavailable.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const M = await import(new URL('../../src/measure/measure.mjs', import.meta.url).href);

describe('makeMeasure', () => {
  it('exposes exactly the seven source labels', () => {
    assert.deepEqual([...M.LABELS].sort(), ['derived', 'estimated', 'measured', 'otel', 'reconstructed', 'transcript', 'unavailable']);
  });

  for (const [name, value] of [['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['-Infinity', Number.NEGATIVE_INFINITY], ['a string', '12'], ['a bigint', 12n], ['a boolean', true]]) {
    it(`rejects ${name} as a value`, () => {
      assert.throws(() => M.makeMeasure({ value, n: 1, label: 'transcript' }), TypeError);
    });
  }

  it('rejects a label outside the seven, including a differently cased one', () => {
    for (const label of ['Transcript', 'otel ', 'guess', '', undefined]) {
      assert.throws(() => M.makeMeasure({ value: 1, n: 1, label }), TypeError);
    }
  });

  it('a null value with a label other than unavailable throws; with no label it is unavailable', () => {
    assert.throws(() => M.makeMeasure({ value: null, n: 1, label: 'transcript' }), TypeError);
    assert.equal(M.makeMeasure({ value: null, n: 1 }).label, 'unavailable');
  });

  it('rejects a negative or fractional n and a coverage outside 0 to 1', () => {
    assert.throws(() => M.makeMeasure({ value: 1, n: -1, label: 'transcript' }), TypeError);
    assert.throws(() => M.makeMeasure({ value: 1, n: 1.5, label: 'transcript' }), TypeError);
    assert.throws(() => M.makeMeasure({ value: 1, n: 1, label: 'transcript', coverage: 1.2 }), TypeError);
  });

  it('returns a frozen object with exactly the five fields', () => {
    const m = M.known(3, { label: 'otel', n: 2 });
    assert.ok(Object.isFrozen(m));
    assert.deepEqual(Object.keys(m).sort(), ['coverage', 'evidence', 'label', 'n', 'value']);
  });
});

describe('fromAggregate', () => {
  it('known equal to n and n above 0 is known with coverage 1', () => {
    assert.deepEqual({ ...M.fromAggregate({ sum: 12, known: 3, n: 3, label: 'transcript' }) }, {
      value: 12, n: 3, label: 'transcript', coverage: 1, evidence: null,
    });
  });

  it('a genuine zero sum stays 0, never unknown', () => {
    assert.equal(M.fromAggregate({ sum: 0, known: 2, n: 2, label: 'transcript' }).value, 0);
  });

  it('known below n is unknown with coverage known over n', () => {
    const m = M.fromAggregate({ sum: 29, known: 1, n: 2, label: 'transcript' });
    assert.deepEqual({ ...m }, { value: null, n: 2, label: 'unavailable', coverage: 0.5, evidence: null });
  });

  it('n equal to 0 is unknown with n 0 and coverage null', () => {
    assert.deepEqual({ ...M.fromAggregate({ sum: null, known: 0, n: 0, label: 'transcript' }) }, {
      value: null, n: 0, label: 'unavailable', coverage: null, evidence: null,
    });
  });

  it('known above n throws instead of being clamped', () => {
    assert.throws(() => M.fromAggregate({ sum: 5, known: 3, n: 2, label: 'transcript' }), RangeError);
  });
});

describe('cell', () => {
  it('prints ? for an unknown Measure and for a missing one, and 0 for a known zero', () => {
    assert.equal(M.cell(M.unknown({ n: 4 })), '?');
    assert.equal(M.cell(null), '?');
    assert.equal(M.cell(undefined), '?');
    assert.equal(M.cell(M.known(0, { label: 'transcript' })), '0');
    assert.equal(M.cell(M.known(1234, { label: 'transcript' })), '1234');
  });

  it('unknown() forces the label unavailable whatever is asked', () => {
    assert.equal(M.unknown({ n: 2, coverage: 0.5 }).label, 'unavailable');
    assert.equal(M.unknown().n, 0);
  });
});
