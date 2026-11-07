// Plan 01-04 Task 2: the pure part builder (COST-01, Pitfall 1). Written before src/derive/parts.mjs.
// buildParts({ callModel, tokens, hasIterations, iterations })
//   -> { parts, priceBasis, iterMismatch, iterUnknownType, cacheSplitMismatch }
// Part 0 is the executor part (kind message) at the call model with the TOP-LEVEL tokens; each distinct
// advisor_message model adds one advisor part (sums with NULL propagation, NULL model its own group,
// models ordered bytewise with NULL last, part_seq from 1).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { buildParts } = await import(new URL('../../src/derive/parts.mjs', import.meta.url).href);

const COLS = ['input_tokens', 'output_tokens', 'cache_read', 'cache_creation', 'cache_5m', 'cache_1h'];
const tok = (a) => Object.fromEntries(COLS.map((c, i) => [c, a[i]]));
const it_ = (iter_seq, iter_type, model, a) => ({ iter_seq, iter_type, model, ...tok(a) });
const part = (part_seq, kind, model, a) => ({ part_seq, kind, model, ...tok(a) });
const plain = (r) => ({ ...r, parts: r.parts.map((p) => ({ ...p })) });
const TOP = [100, 50, 1000, 200, 150, 50];

describe('buildParts without iterations', () => {
  for (const hasIterations of [0, null, undefined]) {
    it(`has_iterations ${hasIterations} gives one message part and price basis top_level_only`, () => {
      const r = plain(buildParts({ callModel: 'claude-opus-5-5', tokens: tok(TOP), hasIterations, iterations: [] }));
      assert.deepEqual(r, {
        parts: [part(0, 'message', 'claude-opus-5-5', TOP)], priceBasis: 'top_level_only', iterMismatch: 0, iterUnknownType: 0, cacheSplitMismatch: 0,
      });
    });
  }

  it('a NULL call model gives a part with a NULL model', () => {
    const r = buildParts({ callModel: null, tokens: tok([3, 4, 5, 6, null, null]), hasIterations: 0, iterations: [] });
    assert.deepEqual({ ...r.parts[0] }, part(0, 'message', null, [3, 4, 5, 6, null, null]));
  });

  it('has_iterations 1 with no stored iteration rows gives one part with price basis iterations', () => {
    const r = buildParts({ callModel: 'm', tokens: tok(TOP), hasIterations: 1, iterations: [] });
    assert.equal(r.parts.length, 1);
    assert.equal(r.priceBasis, 'iterations');
    assert.equal(r.iterMismatch, 0);
  });
});

describe('buildParts with advisor iterations', () => {
  it('lands the advisor tokens on the advisor model and keeps the executor part at the top-level tokens', () => {
    const r = plain(buildParts({
      callModel: 'claude-opus-5-5', tokens: tok([100, 40, 1000, 50, 50, 0]), hasIterations: 1,
      iterations: [it_(0, 'message', 'claude-opus-5-5', [100, 40, 1000, 50, 50, 0]), it_(1, 'advisor_message', 'claude-fable-5-0', [30, 20, 0, 0, 0, 0])],
    }));
    assert.deepEqual(r.parts, [
      part(0, 'message', 'claude-opus-5-5', [100, 40, 1000, 50, 50, 0]),
      part(1, 'advisor', 'claude-fable-5-0', [30, 20, 0, 0, 0, 0]),
    ]);
    assert.equal(r.priceBasis, 'iterations');
  });

  it('sums two advisor iterations of the same model into one part', () => {
    const r = buildParts({
      callModel: 'claude-opus-5-5', tokens: tok(TOP), hasIterations: 1,
      iterations: [
        it_(0, 'message', 'claude-opus-5-5', TOP),
        it_(1, 'advisor_message', 'claude-fable-5-0', [30, 20, 0, 0, 0, 0]),
        it_(2, 'advisor_message', 'claude-fable-5-0', [4, 6, 0, 0, 0, 0]),
      ],
    });
    assert.equal(r.parts.length, 2);
    assert.deepEqual({ ...r.parts[1] }, part(1, 'advisor', 'claude-fable-5-0', [34, 26, 0, 0, 0, 0]));
  });

  it('orders advisor parts by model bytewise (uppercase first) with part_seq from 1', () => {
    const r = buildParts({
      callModel: 'x', tokens: tok(TOP), hasIterations: 1,
      iterations: [
        it_(0, 'advisor_message', 'claude-fable-5-0', [1, 1, 1, 1, 1, 0]),
        it_(1, 'advisor_message', 'Claude-Upper', [2, 2, 2, 2, 2, 0]),
      ],
    });
    assert.deepEqual(r.parts.map((p) => [p.part_seq, p.model]), [[0, 'x'], [1, 'Claude-Upper'], [2, 'claude-fable-5-0']]);
  });

  it('keeps a NULL advisor model as its own group, ordered last', () => {
    const r = buildParts({
      callModel: 'claude-opus-5-5', tokens: tok(TOP), hasIterations: 1,
      iterations: [
        it_(0, 'advisor_message', null, [2, 3, 0, 0, 0, 0]),
        it_(1, 'advisor_message', 'claude-fable-5-0', [1, 1, 0, 0, 0, 0]),
        it_(2, 'advisor_message', null, [1, 1, 0, 0, 0, 0]),
      ],
    });
    assert.deepEqual(r.parts.map((p) => [p.part_seq, p.kind, p.model, p.input_tokens]), [
      [0, 'message', 'claude-opus-5-5', 100], [1, 'advisor', 'claude-fable-5-0', 1], [2, 'advisor', null, 3],
    ]);
  });

  it('propagates NULL: an advisor class with one unknown member is unknown in the part', () => {
    const r = buildParts({
      callModel: 'm', tokens: tok(TOP), hasIterations: 1,
      iterations: [it_(0, 'advisor_message', 'a', [1, 2, null, 0, 0, 0]), it_(1, 'advisor_message', 'a', [3, 4, 5, 0, 0, 0])],
    });
    assert.deepEqual({ ...r.parts[1] }, part(1, 'advisor', 'a', [4, 6, null, 0, 0, 0]));
  });
});

describe('buildParts consistency flags', () => {
  it('sets iterMismatch when the message-iteration sum differs from the top level, and keeps the top level', () => {
    const r = buildParts({
      callModel: 'claude-sonnet-5-5', tokens: tok([10, 10, 10, 10, 10, 0]), hasIterations: 1,
      iterations: [it_(0, 'message', 'claude-sonnet-5-5', [9, 10, 10, 10, 10, 0])],
    });
    assert.equal(r.iterMismatch, 1);
    assert.deepEqual({ ...r.parts[0] }, part(0, 'message', 'claude-sonnet-5-5', [10, 10, 10, 10, 10, 0]));
  });

  it('sums several message iterations for the check (equal sum is no mismatch)', () => {
    const r = buildParts({
      callModel: 'm', tokens: tok([10, 10, 10, 10, 10, 0]), hasIterations: 1,
      iterations: [it_(0, 'message', 'm', [4, 5, 6, 7, 7, 0]), it_(1, 'message', 'm', [6, 5, 4, 3, 3, 0])],
    });
    assert.equal(r.iterMismatch, 0);
  });

  it('ignores a class where either side is unknown when checking the mismatch', () => {
    const r = buildParts({
      callModel: 'm', tokens: tok([10, 10, 10, 10, 10, null]), hasIterations: 1,
      iterations: [it_(0, 'message', 'm', [10, 10, 10, 10, null, 7])],
    });
    assert.equal(r.iterMismatch, 0);
  });

  it('reports no mismatch when there is no message iteration at all', () => {
    const r = buildParts({
      callModel: 'm', tokens: tok(TOP), hasIterations: 1, iterations: [it_(0, 'advisor_message', 'a', [1, 1, 1, 1, 1, 0])],
    });
    assert.equal(r.iterMismatch, 0);
  });

  it('an iteration of an unrecognized type adds no part and sets iterUnknownType', () => {
    const r = buildParts({
      callModel: 'claude-sonnet-5-5', tokens: tok([7, 7, 7, 7, 7, 0]), hasIterations: 1,
      iterations: [it_(0, 'message', 'claude-sonnet-5-5', [7, 7, 7, 7, 7, 0]), it_(1, 'tool_message', 'claude-sonnet-5-5', [100, 100, 100, 100, 100, 100])],
    });
    assert.equal(r.parts.length, 1);
    assert.equal(r.iterUnknownType, 1);
    assert.equal(r.iterMismatch, 0);
  });

  it('an iteration with a NULL type is unrecognized too', () => {
    const r = buildParts({ callModel: 'm', tokens: tok(TOP), hasIterations: 1, iterations: [it_(0, null, 'm', [1, 1, 1, 1, 1, 0])] });
    assert.equal(r.parts.length, 1);
    assert.equal(r.iterUnknownType, 1);
  });

  it('counts parts whose cache_creation differs from cache_5m plus cache_1h, all three known', () => {
    const r = buildParts({
      callModel: 'm', tokens: tok([1, 1, 1, 10, 4, 4]), hasIterations: 1,
      iterations: [it_(0, 'advisor_message', 'a', [1, 1, 1, 5, 2, 2]), it_(1, 'advisor_message', 'b', [1, 1, 1, 4, 3, 1])],
    });
    assert.equal(r.cacheSplitMismatch, 2, 'the executor part and advisor a, not advisor b');
  });

  it('does not count a cache split with an unknown member', () => {
    const r = buildParts({ callModel: 'm', tokens: tok([1, 1, 1, 10, null, null]), hasIterations: 0, iterations: [] });
    assert.equal(r.parts.length, 1, 'one part');
    assert.equal(r.cacheSplitMismatch, 0);
    assert.equal(r.parts[0].cache_creation, 10, 'cache_creation is never corrected');
  });

  it('does not mutate its inputs', () => {
    const tokens = tok(TOP);
    const iterations = [it_(0, 'advisor_message', 'a', [1, 1, 1, 1, 1, 0])];
    const snap = JSON.stringify({ tokens, iterations });
    buildParts({ callModel: 'm', tokens, hasIterations: 1, iterations });
    assert.equal(JSON.stringify({ tokens, iterations }), snap);
  });
});
