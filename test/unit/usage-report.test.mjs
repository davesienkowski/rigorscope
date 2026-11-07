// The transcript usageReport pick (plan 01-06, outline 01-06, D-11a, T-01-58). Written before the code. A
// guard Proxy proves the pick reads only the timestamp and the six limit fields (REPORT_PICK), never the
// session totals, extra_usage, scope, rendered content or commandRun.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS, REPORT_ALLOW, SNAPSHOTS, USAGE_NEEDLES, guarded, usageReportLine } from '../fixtures/usage-cache.mjs';
import { leakyReportPick } from '../canary/leaky-usage-pick.mjs';
import { LIMIT_KIND_TO_WINDOW, REPORT_PICK, pickUsageReport } from '../../src/sources/usage/report.mjs';
import { CACHE_PICK } from '../../src/sources/usage/cache.mjs';

const rejectedOf = (res) => Object.fromEntries((res.rejected ?? []).map((r) => [r.path, r.n]));
const lineD = () => JSON.parse(usageReportLine(SNAPSHOTS.D));
const withLimits = (limits, extra = {}) => ({ ...lineD(), ...extra, usageReport: { rate_limits: { limits } } });
const lim = (o = {}) => ({ kind: 'session', group: 'all', percent: 3, severity: 'normal', resets_at: '2026-10-26T18:00:00Z', is_active: true, ...o });

// Hand-computed snapshot D: session 9 -> five_hour, weekly_all 49 -> seven_day; severity kept.
const SNAPSHOT_D = {
  fetchedAtMs: MS.h16,
  windows: {
    five_hour: { pct: 9, resetsMs: MS.h18 }, seven_day: { pct: 49, resetsMs: MS.oct31 }, seven_day_opus: null, seven_day_sonnet: null,
  },
  limits: [
    { kind: 'session', grp: 'all', percent: 9, resetsMs: MS.h18, severity: 'normal', isActive: 1 },
    { kind: 'weekly_all', grp: 'all', percent: 49, resetsMs: MS.oct31, severity: 'normal', isActive: 0 },
    { kind: 'weekly_scoped', grp: 'opus', percent: 0, resetsMs: MS.oct31, severity: 'normal', isActive: 0 },
  ],
};

describe('pickUsageReport', () => {
  it('reads only REPORT_PICK paths of line D (guard proxy) and returns the hand-computed snapshot', () => {
    const { proxy, violations } = guarded(lineD(), REPORT_ALLOW);
    const res = pickUsageReport(proxy);
    assert.deepEqual(violations, []);
    assert.equal(res.status, 'ok');
    assert.deepEqual(res.snapshot, SNAPSHOT_D);
    assert.deepEqual(res.rejected, []);
  });

  it('the guard has teeth: the leaking report stub trips it, and unguarded it would carry the plants', () => {
    const { proxy, violations } = guarded(lineD(), REPORT_ALLOW);
    try { leakyReportPick(proxy); } catch { /* the guard throws */ }
    assert.ok(violations.length > 0);
    const res = leakyReportPick(lineD());
    assert.ok(USAGE_NEEDLES.some((n) => res.snapshot.limits[0].kind.includes(n)));
  });

  it('maps kind session to five_hour and weekly_all to seven_day, nothing else', () => {
    assert.equal(LIMIT_KIND_TO_WINDOW.session, 'five_hour');
    assert.equal(LIMIT_KIND_TO_WINDOW.weekly_all, 'seven_day');
    assert.equal(Object.keys(LIMIT_KIND_TO_WINDOW).length, 2);
    assert.ok(Object.isFrozen(LIMIT_KIND_TO_WINDOW));
  });

  const notReports = [
    ['an assistant line', { type: 'assistant', subtype: 'local_command' }],
    ['a system line of another subtype', { ...lineD(), subtype: 'compact_boundary' }],
    ['a report line without usageReport', { ...lineD(), usageReport: undefined }],
    ['an array usageReport', { ...lineD(), usageReport: [1] }],
    ['no rate_limits', { ...lineD(), usageReport: { session: {} } }],
    ['limits that are not an array', withLimits({ 0: lim() })],
    ['null', null],
    ['a string', 'system'],
    ['an array', [lineD()]],
  ];
  for (const [title, line] of notReports) {
    it(`${title} is not_report and counts nothing`, () => {
      const res = pickUsageReport(line);
      assert.equal(res.status, 'not_report');
      assert.equal(res.snapshot, null);
      assert.deepEqual(res.rejected, []);
    });
  }

  it('an invalid timestamp is rejected under the timestamp path', () => {
    for (const ts of ['yesterday', '2026-10-26T16:00:00', 1793030400000]) {
      const res = pickUsageReport({ ...lineD(), timestamp: ts });
      assert.equal(res.status, 'rejected');
      assert.deepEqual(rejectedOf(res), { timestamp: 1 });
    }
  });

  it('severity must match the short name shape, else it is NULL with its path counted; absent is NULL uncounted', () => {
    const res = pickUsageReport(withLimits([lim({ severity: 'Bad Severity' }), lim({ severity: `s${'x'.repeat(32)}` }), lim({ severity: `s${'x'.repeat(31)}` }), lim({ severity: undefined })]));
    assert.deepEqual(res.snapshot.limits.map((l) => l.severity), [null, null, `s${'x'.repeat(31)}`, null]);
    assert.deepEqual(rejectedOf(res), { 'usageReport.rate_limits.limits[].severity': 2 });
  });

  it('a kind in email shape is dropped with its path counted and never becomes a window', () => {
    const res = pickUsageReport(withLimits([lim({ kind: 'someone@x.invalid' }), lim({ kind: 'weekly_all', percent: 7 })]));
    assert.deepEqual(res.snapshot.limits.map((l) => l.kind), ['weekly_all']);
    assert.equal(res.snapshot.windows.five_hour, null);
    assert.deepEqual(res.snapshot.windows.seven_day, { pct: 7, resetsMs: MS.h18 });
    assert.deepEqual(rejectedOf(res), { 'usageReport.rate_limits.limits[].kind': 1 });
  });

  it('the first entry of a kind sets the window; weekly_scoped sets none', () => {
    const res = pickUsageReport(withLimits([lim({ percent: 4 }), lim({ percent: 8 }), lim({ kind: 'weekly_scoped', percent: 2 })]));
    assert.deepEqual(res.snapshot.windows.five_hour, { pct: 4, resetsMs: MS.h18 });
    assert.equal(res.snapshot.windows.seven_day, null);
    assert.equal(res.snapshot.limits.length, 3);
  });

  it('an empty limits array is an ok snapshot with no window and no limit', () => {
    const res = pickUsageReport(withLimits([]));
    assert.equal(res.status, 'ok');
    assert.deepEqual(res.snapshot, {
      fetchedAtMs: MS.h16, windows: { five_hour: null, seven_day: null, seven_day_opus: null, seven_day_sonnet: null }, limits: [],
    });
  });

  it('REPORT_PICK is a separate frozen constant: timestamp plus the six limit fields, severity included', () => {
    assert.ok(Object.isFrozen(REPORT_PICK));
    assert.notEqual(REPORT_PICK, CACHE_PICK);
    assert.deepEqual(REPORT_PICK.map((e) => e.path), [
      'timestamp',
      ...['kind', 'group', 'percent', 'resets_at', 'severity', 'is_active'].map((f) => `usageReport.rate_limits.limits[].${f}`),
    ]);
    for (const e of REPORT_PICK) assert.ok(!/extra_usage|session|content|scope|commandRun/.test(e.path), e.path);
    assert.ok(!CACHE_PICK.some((e) => /severity/.test(e.path)), 'the cache pick never reads severity');
  });
});
