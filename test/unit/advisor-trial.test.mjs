// Plan 03-05 (D-25): the advisor-trial window rule over environment snapshots. Pure: advisorState.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ADVISOR_WINDOW_DAYS, advisorState } from '../../src/report/advisor-trial.mjs';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);
const snap = (day, model) => ({ taken_ms: T0 + day * DAY, advisor_model: model });

describe('advisor trial window (03-05, D-25)', () => {
  it('the window is 7 days', () => assert.equal(ADVISOR_WINDOW_DAYS, 7));

  it('a single advisor_model in every snapshot starts no window', () => {
    const s = advisorState([snap(0, 'm-one'), snap(2, 'm-one')], T0 + 30 * DAY);
    assert.deepEqual([s.changed, s.full, s.window_start_ms, s.models_seen], [false, false, null, ['m-one']]);
  });

  it('two values: the window starts at the first snapshot that differs and is full 7 days later, not before', () => {
    const snaps = [snap(0, 'm-one'), snap(5, 'm-one'), snap(6, 'm-two'), snap(8, 'm-two')];
    const early = advisorState(snaps, T0 + 6 * DAY + 7 * DAY - 1);
    const done = advisorState(snaps, T0 + 6 * DAY + 7 * DAY);
    assert.equal(early.window_start_ms, T0 + 6 * DAY);
    assert.equal(early.change_model, 'm-two');
    assert.equal(early.full, false);
    assert.equal(done.full, true);
  });

  it('the baseline window is the 7 days before the trial window start (review M4)', () => {
    const s = advisorState([snap(0, 'm-one'), snap(6, 'm-two')], T0 + 30 * DAY);
    assert.equal(s.baseline_start_ms, T0 + 6 * DAY - 7 * DAY);
    assert.equal(s.window_start_ms - s.baseline_start_ms, 7 * DAY);
    assert.equal(advisorState([snap(0, 'm-one')], T0).baseline_start_ms, null);
  });

  it('a NULL advisor_model is not a value: it never starts a window and is counted apart', () => {
    const s = advisorState([snap(0, 'm-one'), snap(1, null), snap(2, 'm-one')], T0 + 30 * DAY);
    assert.deepEqual([s.changed, s.snapshots, s.snapshots_null], [false, 3, 1]);
  });

  it('no snapshot at all gives no model, no window', () => {
    const s = advisorState([], T0);
    assert.deepEqual([s.baseline, s.changed, s.full, s.models_seen], [null, false, false, []]);
  });
});
