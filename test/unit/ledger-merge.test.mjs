// Plan 03-03 Task 3 (LEDG-03, D-13, D-14, J4, J5): the pure per-field merge of one unit's ledger rows. Hand-built rows with
// the ledger_line column names; expectations are computed by hand from the J4 rule. Written before the code (RED).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedger } from '../../src/derive/ledger-merge.mjs';

const T = (s) => `2026-10-28T${s}.000Z`;
const ms = (iso) => Date.parse(iso);
let n = 0;
const row = (over = {}) => {
  n += 1;
  return {
    line_id: String(n).padStart(32, '0'), record: 'start', ts_utc: T('12:00:00'), tier: null, tier_source: 'unknown', command: null,
    runtime: null, session_id: null, start_utc: null, end_utc: null, status: null, ...over,
  };
};

describe('mergeLedger: the J4 rule per field', () => {
  it('a start row alone: incomplete, its tier, start and metadata', () => {
    const m = mergeLedger([row({
      record: 'start', ts_utc: T('12:00:05'), tier: 'A', tier_source: 'plan-at-start', start_utc: T('12:00:01'), command: 'gsd-quick',
      runtime: 'claude-code', session_id: 's1',
    })]);
    assert.equal(m.lines, 1);
    assert.equal(m.status, 'incomplete');
    assert.equal(m.tier, 'A');
    assert.equal(m.tier_source, 'plan-at-start');
    assert.equal(m.tier_signal, 'ledger');
    assert.equal(m.tier_timing, 'declared-at-start');
    assert.equal(m.tier_comparable, 1);
    assert.equal(m.start_ms, ms(T('12:00:01')));
    assert.equal(m.end_ms, null);
    assert.deepEqual([m.command, m.runtime, m.session_id], ['gsd-quick', 'claude-code', 's1']);
    assert.equal(m.recorded_at_utc, T('12:00:05'));
  });

  it('a close row alone: its status and end, no start, no incomplete', () => {
    const m = mergeLedger([row({
      record: 'close', ts_utc: T('13:00:00'), status: 'complete', end_utc: T('12:59:00'), command: 'gsd-quick', runtime: 'codex',
    })]);
    assert.equal(m.status, 'complete');
    assert.equal(m.start_ms, null);
    assert.equal(m.end_ms, ms(T('12:59:00')));
    assert.equal(m.tier, null);
    assert.equal(m.tier_signal, 'none');
    assert.equal(m.tier_timing, null);
    assert.equal(m.tier_comparable, 0);
    assert.deepEqual([m.command, m.runtime], ['gsd-quick', 'codex']);
  });

  it('start plus close: complete, and a start-row command wins over a close-row command', () => {
    const m = mergeLedger([
      row({ record: 'close', ts_utc: T('13:00:00'), status: 'failed', end_utc: T('12:59:00'), command: 'closer', runtime: 'rc' }),
      row({ record: 'start', ts_utc: T('12:00:00'), start_utc: T('11:59:00'), command: 'starter', tier: 'B', tier_source: 'declared-at-start' }),
    ]);
    assert.equal(m.status, 'failed');
    assert.equal(m.command, 'starter');
    assert.equal(m.runtime, 'rc', 'no start-row runtime, so the latest close row supplies it');
    assert.equal(m.recorded_at_utc, T('12:00:00'), 'the earliest line time, whatever the input order');
  });

  it('two starts: the earliest start and the earliest start-row tier win', () => {
    const m = mergeLedger([
      row({ record: 'start', ts_utc: T('12:10:00'), start_utc: T('12:09:00'), tier: 'C', tier_source: 'declared-at-start' }),
      row({ record: 'start', ts_utc: T('12:00:00'), start_utc: T('11:00:00'), tier: 'A', tier_source: 'declared-at-start' }),
    ]);
    assert.equal(m.tier, 'A');
    assert.equal(m.start_ms, ms(T('11:00:00')));
    assert.equal(m.status, 'incomplete');
  });

  it('two closes: the latest end and the latest close status win', () => {
    const m = mergeLedger([
      row({ record: 'close', ts_utc: T('13:00:00'), status: 'abandoned', end_utc: T('12:58:00') }),
      row({ record: 'close', ts_utc: T('14:00:00'), status: 'complete', end_utc: T('13:58:00') }),
    ]);
    assert.equal(m.status, 'complete');
    assert.equal(m.end_ms, ms(T('13:58:00')));
  });

  it('a null tier on the start row with a declared-at-close tier on the close row: the close tier, comparable 0', () => {
    const m = mergeLedger([
      row({ record: 'start', ts_utc: T('12:00:00'), tier: null, tier_source: 'unknown' }),
      row({ record: 'close', ts_utc: T('13:00:00'), tier: 'B', tier_source: 'declared-at-close', status: 'complete' }),
    ]);
    assert.equal(m.tier, 'B');
    assert.equal(m.tier_source, 'declared-at-close');
    assert.equal(m.tier_signal, 'ledger');
    assert.equal(m.tier_timing, 'declared-at-close');
    assert.equal(m.tier_comparable, 0);
  });

  it('a start-row tier beats a later close-row tier', () => {
    const m = mergeLedger([
      row({ record: 'start', ts_utc: T('12:00:00'), tier: 'A', tier_source: 'declared-at-start' }),
      row({ record: 'close', ts_utc: T('13:00:00'), tier: 'C', tier_source: 'declared-at-close', status: 'complete' }),
    ]);
    assert.equal(m.tier, 'A');
    assert.equal(m.tier_comparable, 1);
  });
});

describe('mergeLedger: unknown stays unknown', () => {
  it('unknown stays unknown: an unknown tier only is not used: no tier, signal none, nothing invented', () => {
    const m = mergeLedger([row({ record: 'start', tier: null, tier_source: 'unknown' })]);
    assert.equal(m.tier, null);
    assert.equal(m.tier_source, null);
    assert.equal(m.tier_signal, 'none');
    assert.equal(m.tier_timing, null);
    assert.equal(m.tier_comparable, 0);
  });

  it('a row that carries a tier with the unknown source is not used either', () => {
    const m = mergeLedger([row({ record: 'start', tier: 'A', tier_source: 'unknown' })]);
    assert.equal(m.tier, null);
  });

  it('an unparseable ISO time gives NULL, never 0; the other rows still count', () => {
    const m = mergeLedger([
      row({ record: 'start', start_utc: 'not-a-time' }),
      row({ record: 'start', ts_utc: T('12:01:00'), start_utc: T('12:00:30') }),
      row({ record: 'close', ts_utc: T('13:00:00'), end_utc: '2026-13-45T99:99:99.000Z', status: 'complete' }),
    ]);
    assert.equal(m.start_ms, ms(T('12:00:30')));
    assert.equal(m.end_ms, null);
    const onlyBad = mergeLedger([row({ record: 'start', start_utc: 'not-a-time' })]);
    assert.equal(onlyBad.start_ms, null);
  });

  it('a close with no status has status null (not incomplete and not invented); no field is guessed', () => {
    const m = mergeLedger([row({ record: 'start' }), row({ record: 'close', ts_utc: T('13:00:00'), status: null })]);
    assert.equal(m.status, null);
    assert.equal(m.command, null);
    assert.equal(m.session_id, null);
    assert.equal(m.end_ms, null);
  });
});

describe('mergeLedger: ordering', () => {
  it('ties on the line time break on line_id bytewise, in either input order', () => {
    const a = row({ line_id: 'a'.repeat(32), record: 'start', ts_utc: T('12:00:00'), command: 'first', start_utc: T('11:00:00') });
    const b = row({ line_id: 'b'.repeat(32), record: 'start', ts_utc: T('12:00:00'), command: 'second', start_utc: T('11:30:00') });
    assert.equal(mergeLedger([b, a]).command, 'first');
    assert.equal(mergeLedger([a, b]).command, 'first');
    assert.equal(mergeLedger([a, b]).start_ms, ms(T('11:00:00')));
  });

  it('does not mutate its input and returns the same result for the same rows', () => {
    const rows = [row({ record: 'close', ts_utc: T('13:00:00') }), row({ record: 'start', ts_utc: T('12:00:00') })];
    const copy = JSON.stringify(rows);
    const m1 = mergeLedger(rows);
    assert.equal(JSON.stringify(rows), copy);
    assert.deepEqual(mergeLedger(rows), m1);
  });
});
