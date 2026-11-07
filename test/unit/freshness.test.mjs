// Plan 01-08 (TRUST-05, D-14): the pure freshness evaluation, age formatting and header lines. Written before the
// code (RED). Ages are whole seconds floored once; the limit is 36 hours = 129600 s; STALE only when strictly greater.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRESHNESS_STATES, evaluateFreshness, formatAge, freshnessLines,
} from '../../src/measure/freshness.mjs';

// 2026-11-03T12:00:00Z = 1793707200 s.
const NOW = 1793707200000;
const ago = (s, ms = 0) => new Date(NOW - s * 1000 - ms).toISOString();
const LIMIT = 129600; // 36 x 3600
const src = (over = {}) => ({
  name: 'transcript', live: true, staleAfterHours: 36, newestRecordUtc: ago(60), lastRunUtc: ago(60), ...over,
});
const one = (over, nowMs = NOW) => evaluateFreshness({ sources: [src(over)], nowMs }).sources[0];

describe('formatAge', () => {
  const cases = [[129601, '36h00m01s'], [0, '0h00m00s'], [-5, '-0h00m05s'], [null, '?'], [3600, '1h00m00s'], [59, '0h00m59s'], [3661, '1h01m01s'], [338 * 3600, '338h00m00s'], [-129601, '-36h00m01s']];
  for (const [s, text] of cases) it(`formats ${s} as ${text}`, () => assert.equal(formatAge(s), text));
});

describe('evaluateFreshness', () => {
  it('FRESHNESS_STATES lists the five states', () => assert.deepEqual([...FRESHNESS_STATES], ['ok', 'stale', 'empty', 'never_run', 'not_rated']));
  for (const clock of ['newestRecordUtc', 'lastRunUtc']) {
    const ageKey = clock === 'newestRecordUtc' ? 'recordAgeSec' : 'runAgeSec';
    for (const [secs, stale] of [[LIMIT - 1, false], [LIMIT, false], [LIMIT + 1, true]]) {
      it(`${clock} ${secs} s old is ${stale ? 'stale' : 'not stale'}`, () => {
        const s = one({ [clock]: ago(secs) });
        assert.equal(s[ageKey], secs);
        assert.equal(s.state, stale ? 'stale' : 'ok');
      });
    }
  }
  it('a 999 ms excess over 36 hours is floored away and not stale', () => {
    const s = one({ newestRecordUtc: ago(LIMIT, 999) });
    assert.equal(s.recordAgeSec, LIMIT);
    assert.equal(s.state, 'ok');
  });
  it('1000 ms over 36 hours is stale', () => assert.equal(one({ newestRecordUtc: ago(LIMIT, 1000) }).state, 'stale'));
  it('a future-dated newest record gives a negative age and is not stale', () => {
    const s = one({ newestRecordUtc: ago(-7200) });
    assert.equal(s.recordAgeSec, -7200);
    assert.equal(s.state, 'ok');
  });
  it('a future instant with a fractional second floors toward minus infinity once', () => {
    assert.equal(one({ newestRecordUtc: ago(-1, -500) }).recordAgeSec, -2); // 1.5 s ahead: floor(-1.5) = -2
  });
  it('an old record with a recent run is stale for the record only and flagged idle', () => {
    const s = one({ newestRecordUtc: ago(LIMIT + 1) });
    assert.deepEqual([s.state, s.reasons, s.idle], ['stale', ['record_old'], true]);
  });
  it('an old run is stale for the run only', () => {
    const s = one({ lastRunUtc: ago(LIMIT + 1) });
    assert.deepEqual([s.state, s.reasons, s.idle], ['stale', ['run_old'], false]);
  });
  it('an old record and an old run name both reasons', () => {
    const s = one({ newestRecordUtc: ago(LIMIT + 5), lastRunUtc: ago(LIMIT + 1) });
    assert.deepEqual([s.state, s.reasons, s.idle], ['stale', ['record_old', 'run_old'], false]);
  });
  it('a live source with a run but no record is empty and not stale', () => {
    const s = one({ newestRecordUtc: null });
    assert.deepEqual([s.state, s.recordAgeSec], ['empty', null]);
  });
  it('a live source without a run is never_run and stale in the verdict', () => {
    const r = evaluateFreshness({ sources: [src({ lastRunUtc: null }), src({ name: 'otel' })], nowMs: NOW });
    assert.equal(r.sources[0].state, 'never_run');
    assert.equal(r.verdict, 'stale');
  });
  it('a source that is not live is not_rated and never stale', () => {
    const s = one({ live: false, staleAfterHours: 168, newestRecordUtc: ago(10 * 86400), lastRunUtc: ago(10 * 86400) });
    assert.equal(s.state, 'not_rated');
  });
  it('no run at all gives verdict none', () => {
    const r = evaluateFreshness({ sources: [src({ lastRunUtc: null }), src({ name: 'otel', lastRunUtc: null })], nowMs: NOW });
    assert.equal(r.verdict, 'none');
  });
  it('an ok source set gives verdict ok and keeps the input order', () => {
    const r = evaluateFreshness({ sources: [src({ name: 'zeta' }), src({ name: 'alpha' })], nowMs: NOW });
    assert.equal(r.verdict, 'ok');
    assert.deepEqual(r.sources.map((s) => s.name), ['zeta', 'alpha']);
  });
  it('a not-live source with a run counts toward having an ingest recorded', () => {
    const r = evaluateFreshness({ sources: [src({ live: false, lastRunUtc: ago(60) })], nowMs: NOW });
    assert.equal(r.verdict, 'ok');
  });
  it('the limit follows each source staleAfterHours', () => {
    const s = one({ staleAfterHours: 1, newestRecordUtc: ago(3601) });
    assert.equal(s.state, 'stale');
    assert.equal(s.limitHours, 1);
  });
  it('the result carries nowMs for the header', () => assert.equal(evaluateFreshness({ sources: [src()], nowMs: NOW }).nowMs, NOW));
});

describe('freshnessLines', () => {
  const lines = (sources, opts = { clockFixed: false }) => freshnessLines(evaluateFreshness({ sources, nowMs: NOW }), opts);
  const MARK = ' (clock fixed by RIGORSCOPE_NOW)';
  it('no run at all is exactly one line, with or without a fixed clock', () => {
    const none = [src({ lastRunUtc: null })];
    assert.deepEqual(lines(none), ['freshness: no ingest recorded']);
    assert.deepEqual(lines(none, { clockFixed: true }), ['freshness: no ingest recorded']);
  });
  it('an ok header names the instant and a source line follows with both ages and the limit', () => {
    assert.deepEqual(lines([src({ newestRecordUtc: ago(LIMIT), lastRunUtc: ago(3600) })]), [
      'freshness: OK as of 2026-11-03T12:00:00.000Z',
      `  transcript newest record ${ago(LIMIT)} (age 36h00m00s); last run ${ago(3600)} (age 1h00m00s); limit 36h; ok`,
    ]);
  });
  it('a fixed clock appends the marker to the first line only', () => {
    const out = lines([src()], { clockFixed: true });
    assert.equal(out[0], `freshness: OK as of 2026-11-03T12:00:00.000Z${MARK}`);
    assert.equal(out[1].includes('RIGORSCOPE_NOW'), false);
  });
  it('a stale record with a recent run explains that ingest is current and the source looks idle', () => {
    const out = lines([src({ newestRecordUtc: ago(LIMIT + 1), lastRunUtc: ago(3600) })]);
    assert.equal(out[0], 'freshness: STALE as of 2026-11-03T12:00:00.000Z');
    assert.match(out[1], /limit 36h; STALE: newest record older than 36h; last ingest run 1h00m00s ago, so ingest is current and the source looks idle$/);
  });
  it('an old run is named', () => {
    assert.match(lines([src({ lastRunUtc: ago(LIMIT + 1) })])[1], /limit 36h; STALE: last ingest run older than 36h$/);
  });
  it('an old record and an old run are both named', () => {
    assert.match(lines([src({ newestRecordUtc: ago(LIMIT + 9), lastRunUtc: ago(LIMIT + 1) })])[1], /limit 36h; STALE: newest record older than 36h; last ingest run older than 36h$/);
  });
  it('a live source with no record reads no records (not stale)', () => {
    assert.match(lines([src({ newestRecordUtc: null })])[1], /newest record none \(age \?\); last run .* limit 36h; no records \(not stale\)$/);
  });
  it('a live source that never ran reads STALE no ingest run recorded', () => {
    const out = lines([src({ lastRunUtc: null }), src({ name: 'otel' })]);
    assert.match(out[1], /newest record .*; last run none \(age \?\); limit 36h; STALE: no ingest run recorded for this source$/);
    assert.equal(out[0].startsWith('freshness: STALE'), true);
  });
  it('a source that is not live prints not rated with no limit part', () => {
    assert.match(lines([src({ live: false, staleAfterHours: 168, name: 'usage', newestRecordUtc: null })])[1], /^ {2}usage newest record none \(age \?\); last run .* \(age 0h01m00s\); not rated$/);
  });
  it('source names are padded to the longest name and kept in input order', () => {
    const out = lines([src({ name: 'otel' }), src({ name: 'transcript' }), src({ name: 'usage', live: false })]);
    assert.deepEqual(out.slice(1).map((l) => l.slice(0, 14)), ['  otel       n', '  transcript n', '  usage      n']);
  });
  it('a future-dated record prints a negative age', () => {
    assert.match(lines([src({ newestRecordUtc: ago(-5) })])[1], /\(age -0h00m05s\)/);
  });
  it('a verdict of stale for any live source makes the first line STALE even when others are ok', () => {
    const out = lines([src({ name: 'otel' }), src({ newestRecordUtc: ago(LIMIT + 1) })]);
    assert.equal(out[0], 'freshness: STALE as of 2026-11-03T12:00:00.000Z');
  });
});
