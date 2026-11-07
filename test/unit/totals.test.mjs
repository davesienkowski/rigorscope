// Plan 01-08 (TRUST-01, TRUST-02): the per-section rows-sum-to-total check over known sums and unknown counts.
// Written before the code (RED). A cell is { sum, unknown }: sum is the known sum (null when no member is known),
// unknown is the count of unknown members. Unknown is never coerced to zero.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOTAL_COLUMNS, checkTotals } from '../../src/measure/totals.mjs';

const cell = (sum, unknown = 0) => ({ sum, unknown });
const mk = (base) => Object.fromEntries(TOTAL_COLUMNS.map((c) => [c, base[c] ?? cell(0, 0)]));
const row = (o) => mk(o);

describe('checkTotals', () => {
  it('TOTAL_COLUMNS is the seven columns in the fixed order', () => {
    assert.deepEqual([...TOTAL_COLUMNS], ['input', 'output', 'cache_read', 'cache_write', 'notional_usd', 'window_5h', 'window_7d']);
  });
  it('rows that sum to the total are ok with no failing columns', () => {
    const rows = [row({ input: cell(100), output: cell(10), notional_usd: cell(15000) }), row({ input: cell(50), output: cell(20), notional_usd: cell(600000) })];
    const total = row({ input: cell(150), output: cell(30), notional_usd: cell(615000) });
    assert.deepEqual(checkTotals({ rows, total }), { ok: true, columns: [] });
  });
  it('a tampered known sum names its column', () => {
    const rows = [row({ notional_usd: cell(15000) })];
    assert.deepEqual(checkTotals({ rows, total: row({ notional_usd: cell(15001) }) }), { ok: false, columns: ['notional_usd'] });
  });
  it('a tampered unknown count names its column', () => {
    const rows = [row({ window_5h: cell(null, 2) })];
    assert.deepEqual(checkTotals({ rows, total: row({ window_5h: cell(null, 1) }) }), { ok: false, columns: ['window_5h'] });
  });
  it('failing columns come back in the fixed column order', () => {
    const rows = [row({ window_7d: cell(5), input: cell(1), cache_write: cell(2) })];
    const total = row({ window_7d: cell(6), input: cell(2), cache_write: cell(3) });
    assert.deepEqual(checkTotals({ rows, total }).columns, ['input', 'cache_write', 'window_7d']);
  });
  it('an all-unknown column matches an all-unknown total', () => {
    const rows = [row({ notional_usd: cell(null, 1) }), row({ notional_usd: cell(null, 3) })];
    assert.deepEqual(checkTotals({ rows, total: row({ notional_usd: cell(null, 4) }) }), { ok: true, columns: [] });
  });
  it('a partly unknown column compares its known sum and its unknown count separately', () => {
    const rows = [row({ input: cell(10, 1) }), row({ input: cell(5, 0) })];
    assert.equal(checkTotals({ rows, total: row({ input: cell(15, 1) }) }).ok, true);
    assert.deepEqual(checkTotals({ rows, total: row({ input: cell(15, 0) }) }).columns, ['input']);
    assert.deepEqual(checkTotals({ rows, total: row({ input: cell(null, 1) }) }).columns, ['input']);
  });
  it('an empty row list with a null total is ok', () => assert.deepEqual(checkTotals({ rows: [], total: null }), { ok: true, columns: [] }));
  it('rows with a null total fail every column, and a total with no rows fails the columns it fills', () => {
    assert.deepEqual(checkTotals({ rows: [row({ input: cell(1) })], total: null }).columns, [...TOTAL_COLUMNS]);
    assert.deepEqual(checkTotals({ rows: [], total: row({ output: cell(3) }) }).columns, ['output']);
  });
  it('a missing field is a failure, not a zero', () => {
    const rows = [row({})];
    const total = row({});
    delete total.cache_read;
    assert.deepEqual(checkTotals({ rows, total }).columns, ['cache_read']);
    const brokenRow = row({});
    delete brokenRow.output;
    assert.deepEqual(checkTotals({ rows: [brokenRow], total: row({}) }).columns, ['output']);
  });
  it('a known sum of null on one side and zero on the other compare equal only when both have no unknown members', () => {
    assert.equal(checkTotals({ rows: [row({ input: cell(null, 0) })], total: row({ input: cell(0, 0) }) }).ok, true);
  });
});
