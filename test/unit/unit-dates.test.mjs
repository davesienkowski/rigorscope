// Plan 02-05 (D-10): unitDates of src/derive/unit-fill.mjs, every branch and fallback order with synthetic inputs.
// Imported inside each case, so the file loads before the code exists.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const dates = async (o) => (await import('../../src/derive/unit-fill.mjs')).unitDates(o);
const DAY = Date.UTC(2026, 9, 25);
const art = (o) => ({
  role: 'plan', first_commit_ms: null, last_commit_ms: null, mtime_ms: null, fm_date: null, fm_offset_min: null, ...o,
});

describe('unitDates (D-10)', () => {
  it('start: quick-id first, then the earliest git time, then the earliest mtime, else none', async () => {
    const git = [art({ first_commit_ms: DAY + 5000, last_commit_ms: DAY + 9000, mtime_ms: DAY + 1 })];
    assert.deepEqual(
      [(await dates({ idStartMs: DAY, own: git, commits: [{ author_ms: DAY + 3000 }] })).date_source],
      ['quick-id'],
    );
    const g = await dates({ own: git, commits: [{ author_ms: DAY + 3000 }] });
    assert.deepEqual([g.start_ms, g.date_source], [DAY + 3000, 'git']);
    const m = await dates({ own: [art({ mtime_ms: DAY + 7 }), art({ mtime_ms: DAY + 4 })], commits: [] });
    assert.deepEqual([m.start_ms, m.date_source], [DAY + 4, 'mtime']);
    const n = await dates({ own: [], commits: null });
    assert.deepEqual([n.start_ms, n.date_source, n.end_ms, n.end_source, n.git_evidence], [null, 'none', null, 'none', 0]);
  });

  it('end: the latest git time, then the own SUMMARY completed day, then the latest mtime', async () => {
    const g = await dates({ own: [art({ first_commit_ms: DAY + 5000, last_commit_ms: DAY + 9000 })], commits: [{ author_ms: DAY + 12000 }] });
    assert.deepEqual([g.end_ms, g.end_source, g.git_evidence], [DAY + 12000, 'git', 1]);
    const f = await dates({
      idStartMs: DAY,
      own: [art({ mtime_ms: DAY + 99 * 86400000 }), art({ role: 'summary', fm_date: '2026-10-26', fm_offset_min: -240 })],
      commits: [],
    });
    assert.deepEqual([f.end_ms, f.end_source], [Date.UTC(2026, 9, 26) + 240 * 60000 + 86400000 - 1, 'frontmatter']);
    const m = await dates({ own: [art({ mtime_ms: DAY + 7 }), art({ mtime_ms: DAY + 40 })], commits: [] });
    assert.deepEqual([m.end_ms, m.end_source, m.git_evidence], [DAY + 40, 'mtime', 0]);
  });

  it('a non-summary artifact\'s date is not a frontmatter end', async () => {
    const r = await dates({ own: [art({ role: 'plan', fm_date: '2026-10-26', fm_offset_min: 0, mtime_ms: DAY + 1 })], commits: [] });
    assert.deepEqual([r.end_source, r.end_ms], ['mtime', DAY + 1]);
  });

  it('an end before the start is raised to the start, flagged clamped and labeled clamped (review 02-05 WR-03)', async () => {
    const r = await dates({ idStartMs: DAY, own: [art({ first_commit_ms: DAY - 86400000, last_commit_ms: DAY - 3600000 })], commits: [] });
    assert.deepEqual([r.start_ms, r.date_source, r.end_ms, r.end_source, r.clamped, r.git_evidence], [DAY, 'quick-id', DAY, 'clamped', true, 1]);
    const ok = await dates({ idStartMs: DAY, own: [art({ last_commit_ms: DAY + 1 })], commits: [] });
    assert.equal(ok.clamped, false);
  });

  it('no git time is used for a unit without a scan row', async () => {
    const r = await dates({
      scanned: false, own: [art({ first_commit_ms: DAY + 5, last_commit_ms: DAY + 9, mtime_ms: DAY + 2 })], commits: null,
    });
    assert.deepEqual([r.start_ms, r.date_source, r.end_ms, r.end_source, r.git_evidence], [DAY + 2, 'mtime', DAY + 2, 'mtime', 0]);
  });
});
