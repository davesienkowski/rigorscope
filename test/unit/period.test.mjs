// Plan 01-08 (COST-05, D-07): date and zone parsing, local-day arithmetic across daylight-saving changes, and
// period resolution. Written before the code (RED). Epoch milliseconds are hand-computed; the report-shape
// instants are the ones of test/fixtures/cases/98-report-shape.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PERIOD_HOURS, allPeriod, formatPeriodLine, localDay, parseDateArg, resolvePeriod, resolveTz, startOfLocalDay,
} from '../../src/measure/period.mjs';
import { TS_MS } from '../fixtures/cases/98-report-shape.mjs';

const LA = 'America/Los_Angeles';
const HOUR = 3600000;
// 2026-11-03T12:00:00Z = 1793491200 s (2026-11-01T00:00Z) + 2 x 86400 s + 43200 s = 1793707200 s.
const NOW = 1793707200000;
const iso = (ms) => new Date(ms).toISOString();
const throwsRange = (fn) => assert.throws(fn, (e) => e instanceof RangeError && /^[ -~]+$/.test(e.message));

describe('parseDateArg', () => {
  for (const ok of ['2026-11-01', '1970-01-01', '2199-12-31', '2024-02-29', '2000-02-29']) {
    it(`accepts the real calendar date ${ok}`, () => {
      const d = parseDateArg(ok);
      assert.deepEqual([d?.year, d?.month, d?.day], ok.split('-').map(Number));
    });
  }
  for (const bad of ['2026-1-1', '2026-02-30', '2025-02-29', '2100-02-29', ' 2026-11-01', '2026-11-01 ', '2026-11-01T00:00', '1969-12-31',
    '2200-01-01', '', '2026-13-01', '2026-00-10', '2026-11-00', 'abc', '2026-11-1', '２０２６-11-01', '2026/11/01', 20261101, null, undefined]) {
    it(`rejects ${JSON.stringify(bad)} with a fixed message that does not echo it`, () => {
      throwsRange(() => parseDateArg(bad));
      try { parseDateArg(bad); } catch (e) { assert.equal(typeof bad === 'string' && bad.length > 3 ? e.message.includes(bad) : false, false); }
    });
  }
});

describe('resolveTz', () => {
  it('returns UTC and a canonical name for a canonical input', () => {
    assert.equal(resolveTz('UTC'), 'UTC');
    assert.equal(resolveTz(LA), LA);
  });
  it('canonicalizes a lower-case spelling', () => {
    assert.equal(resolveTz('america/los_angeles'), LA);
    assert.equal(resolveTz('utc'), 'UTC');
  });
  it('returns the process zone for undefined', () => {
    assert.equal(resolveTz(undefined), new Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
  for (const bad of ['+05:00', '../x', 'a b', 'x'.repeat(65), '', 5, 'Not/AZone', 'America/../x', '.hidden', 'America//Chicago', null]) {
    it(`rejects ${JSON.stringify(bad)?.slice(0, 20)}`, () => throwsRange(() => resolveTz(bad)));
  }
});

describe('localDay', () => {
  // [letter, Los_Angeles day, UTC day]
  const rows = [['A', '2026-10-31', '2026-11-01'], ['B', '2026-11-01', '2026-11-01'], ['C', '2026-11-01', '2026-11-01'],
    ['D', '2026-11-01', '2026-11-01'], ['E', '2026-11-01', '2026-11-02'], ['F', '2026-11-02', '2026-11-02']];
  for (const [l, la, utc] of rows) {
    it(`call ${l} falls on ${la} in Los_Angeles and ${utc} in UTC`, () => {
      assert.equal(localDay(TS_MS[l], LA), la);
      assert.equal(localDay(TS_MS[l], 'UTC'), utc);
    });
  }
  it('the instants 06:59:59Z, 07:00:00Z, 07:59:59.999Z next day and 08:00:00Z next day fall on Oct 31, Nov 1, Nov 1 and Nov 2', () => {
    assert.deepEqual([1793516399000, 1793516400000, 1793606399999, 1793606400000].map((ms) => localDay(ms, LA)), ['2026-10-31', '2026-11-01', '2026-11-01', '2026-11-02']);
  });
  it('both 01:30 occurrences of the repeated hour give the same day', () => {
    assert.equal(localDay(TS_MS.C, LA), localDay(TS_MS.D, LA));
  });
  it('returns null for null, NaN, a non-integer and an out-of-range value', () => {
    for (const v of [null, undefined, Number.NaN, 1.5, 8.64e15 + 1, '1793516400000', Infinity]) assert.equal(localDay(v, 'UTC'), null);
  });
});

describe('startOfLocalDay', () => {
  it('2026-11-01 and 2026-11-02 in Los_Angeles start 25 hours apart', () => {
    assert.equal(startOfLocalDay('2026-11-01', LA), 1793516400000);
    assert.equal(startOfLocalDay('2026-11-02', LA), 1793606400000);
    assert.equal(1793606400000 - 1793516400000, 90000000); // 25 x 3600000
  });
  it('2026-03-08 and 2026-03-09 in Los_Angeles start 23 hours apart', () => {
    assert.equal(iso(startOfLocalDay('2026-03-08', LA)), '2026-03-08T08:00:00.000Z');
    assert.equal(iso(startOfLocalDay('2026-03-09', LA)), '2026-03-09T07:00:00.000Z');
  });
  it('UTC starts at midnight', () => assert.equal(startOfLocalDay('2026-11-01', 'UTC'), 1793491200000));
  it('America/Sao_Paulo 2018-11-04 starts at 03:00Z because the 00:00 hour does not exist', () => {
    assert.equal(iso(startOfLocalDay('2018-11-04', 'America/Sao_Paulo')), '2018-11-04T03:00:00.000Z');
  });
  it('a half-hour zone (Asia/Kolkata) starts at 18:30Z of the previous UTC day', () => {
    assert.equal(iso(startOfLocalDay('2026-11-01', 'Asia/Kolkata')), '2026-10-31T18:30:00.000Z');
  });
  it('the first instant of the day belongs to the day and the millisecond before does not', () => {
    const s = startOfLocalDay('2026-11-01', LA);
    assert.equal(localDay(s, LA), '2026-11-01');
    assert.equal(localDay(s - 1, LA), '2026-10-31');
  });
});

describe('resolvePeriod', () => {
  it('neither bound gives mode default with the lower bound 168 hours before now and no upper bound', () => {
    assert.equal(DEFAULT_PERIOD_HOURS, 168);
    assert.deepEqual(resolvePeriod({ tz: LA, nowMs: NOW }), {
      mode: 'default', tz: LA, sinceMs: NOW - 168 * HOUR, untilMs: null, sinceDate: null, untilDate: null, nowMs: NOW,
    });
  });
  it('since only gives the start of that local day and no upper bound', () => {
    const p = resolvePeriod({ since: '2026-11-01', tz: LA, nowMs: NOW });
    assert.deepEqual([p.mode, p.sinceMs, p.untilMs, p.sinceDate, p.untilDate], ['range', 1793516400000, null, '2026-11-01', null]);
  });
  it('until only gives no lower bound and an exclusive bound at the start of the next day', () => {
    const p = resolvePeriod({ until: '2026-11-01', tz: LA, nowMs: NOW });
    assert.deepEqual([p.mode, p.sinceMs, p.untilMs, p.sinceDate, p.untilDate], ['range', null, 1793606400000, null, '2026-11-01']);
  });
  it('both bounds give both, and the same date for both is valid', () => {
    const p = resolvePeriod({ since: '2026-11-01', until: '2026-11-01', tz: LA, nowMs: NOW });
    assert.deepEqual([p.sinceMs, p.untilMs], [1793516400000, 1793606400000]);
  });
  for (const [until, next] of [['2026-12-31', Date.UTC(2027, 0, 1)], ['2024-02-28', Date.UTC(2024, 1, 29)], ['2023-02-28', Date.UTC(2023, 2, 1)], ['2024-02-29', Date.UTC(2024, 2, 1)]]) {
    it(`until ${until} rolls over to the next calendar day in UTC`, () => {
      assert.equal(resolvePeriod({ until, tz: 'UTC', nowMs: NOW }).untilMs, next);
    });
  }
  it('a lower bound after the upper bound throws a RangeError', () => {
    throwsRange(() => resolvePeriod({ since: '2026-11-02', until: '2026-11-01', tz: 'UTC', nowMs: NOW }));
  });
  it('allPeriod gives mode all with no bounds', () => {
    assert.deepEqual(allPeriod(), { mode: 'all', tz: null, sinceMs: null, untilMs: null, sinceDate: null, untilDate: null, nowMs: null });
  });
});

describe('formatPeriodLine', () => {
  it('mode all ignores tsUnknown', () => {
    assert.equal(formatPeriodLine(allPeriod(), { tsUnknown: 5 }), 'period: all ingested records');
  });
  it('mode default says last 7 days, the lower instant, default and the zone', () => {
    assert.equal(formatPeriodLine(resolvePeriod({ tz: LA, nowMs: NOW }), { tsUnknown: 0 }), `period: last 7 days, from ${iso(NOW - 168 * HOUR)} (default), tz=${LA}, calls_ts_unknown=0`);
  });
  it('a range with both bounds names the dates and instants', () => {
    assert.equal(formatPeriodLine(resolvePeriod({ since: '2026-11-01', until: '2026-11-01', tz: LA, nowMs: NOW }), { tsUnknown: 2 }),
      `period: from 2026-11-01 (2026-11-01T07:00:00.000Z) to 2026-11-01 inclusive (before 2026-11-02T08:00:00.000Z), tz=${LA}, calls_ts_unknown=2`);
  });
  it('a range with only until says from the first record', () => {
    assert.equal(formatPeriodLine(resolvePeriod({ until: '2026-11-01', tz: 'UTC', nowMs: NOW }), { tsUnknown: 0 }),
      'period: from the first record to 2026-11-01 inclusive (before 2026-11-02T00:00:00.000Z), tz=UTC, calls_ts_unknown=0');
  });
  it('a range with only since says to the last record', () => {
    assert.equal(formatPeriodLine(resolvePeriod({ since: '2026-11-01', tz: 'UTC', nowMs: NOW }), { tsUnknown: 0 }),
      'period: from 2026-11-01 (2026-11-01T00:00:00.000Z) to the last record, tz=UTC, calls_ts_unknown=0');
  });
});
