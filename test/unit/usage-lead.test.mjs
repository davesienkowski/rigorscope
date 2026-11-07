// Plan 01-09 contract for src/report/usage-lead.mjs (D-11a, TRUST-05): the window-percentage discontinuity lead over
// the stored usage snapshots, using the 01-06 interval classifier. Written before the code (RED). Hand-computed
// literals; instants are milliseconds since the epoch of 2026-10-28T00:00:00Z plus hours.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import(new URL('../../src/report/usage-lead.mjs', import.meta.url).href);
const D = Date.parse('2026-10-28T00:00:00.000Z');
const H = 3600000;
const R1 = Date.parse('2026-10-28T15:00:00.000Z');
const R2 = Date.parse('2026-10-28T20:00:00.000Z');
const W7 = Date.parse('2026-10-31T00:00:00.000Z');
// A stored usage_snapshot row (the columns findWindowLeads reads).
const row = (h, five, seven, { source = 'claude-json-cache', r5 = R1, r7 = W7 } = {}) => ({
  source, fetched_at_ms: D + h * H,
  five_hour_pct: five, five_hour_resets_ms: five === null ? null : r5,
  seven_day_pct: seven, seven_day_resets_ms: seven === null ? null : r7,
});
const five = async (snapshots) => (await mod()).findWindowLeads({ snapshots })?.five_hour;

describe('findWindowLeads', () => {
  it('a rise is not counted and gives one interval', async () => {
    const r = await five([row(9, 40, null), row(10, 55, null)]);
    assert.equal(r?.points, 2);
    assert.equal(r?.intervals, 1);
    assert.equal(r?.falling, 0);
  });

  it('a fall without a reset is counted and listed with its instant and both percentages', async () => {
    const r = await five([row(10, 55, null), row(11, 20, null)]);
    assert.equal(r?.falling, 1);
    assert.deepEqual(r?.latest, [{ atMs: D + 11 * H, fromPct: 55, toPct: 20 }]);
  });

  it('a flat pair is not counted', async () => {
    assert.equal((await five([row(11, 20, null), row(12, 20, null)]))?.falling, 0);
  });

  it('a fall across a reset (new reset instant) is not counted', async () => {
    assert.equal((await five([row(12, 20, null), row(13, 5, null, { r5: R2 })]))?.falling, 0);
  });

  it('reset instants 60000 ms apart are the same window, so a fall is counted', async () => {
    const r = await five([row(10, 55, null), row(11, 20, null, { r5: R1 + 60000 })]);
    assert.equal(r?.falling, 1);
  });

  it('reset instants 60001 ms apart are a reset, so a fall is not counted', async () => {
    const r = await five([row(10, 55, null), row(11, 20, null, { r5: R1 + 60001 })]);
    assert.equal(r?.falling, 0);
  });

  it('a null window percentage is no point', async () => {
    const r = await five([row(9, null, 30), row(10, 55, null), row(11, null, 29), row(12, 50, null)]);
    assert.equal(r?.points, 2);
    assert.equal(r?.falling, 1);
  });

  it('one point is none checkable: no interval, no fall', async () => {
    const r = await five([row(10, 55, null)]);
    assert.equal(r?.points, 1);
    assert.equal(r?.intervals, 0);
    assert.equal(r?.falling, 0);
  });

  it('no snapshots give zero points for both windows', async () => {
    const r = (await mod()).findWindowLeads({ snapshots: [] });
    assert.equal(r?.five_hour?.points, 0);
    assert.equal(r?.seven_day?.points, 0);
  });

  it('two snapshots in the same millisecond keep the source that sorts first bytewise (claude-json-cache before transcript)', async () => {
    // cache 50 then transcript 10 at 10:00 keeps the cache point (50); 11:00 at 40 is then a fall 50 to 40.
    // Keeping the transcript point (10) would make 10 to 40 a rise and the count 0.
    const r = await five([row(10, 10, null, { source: 'transcript' }), row(10, 50, null), row(11, 40, null)]);
    assert.equal(r?.points, 2);
    assert.equal(r?.falling, 1);
    assert.deepEqual(r?.latest, [{ atMs: D + 11 * H, fromPct: 50, toPct: 40 }]);
  });

  it('the two windows are counted independently', async () => {
    const out = (await mod()).findWindowLeads({ snapshots: [row(10, 55, 30), row(11, 20, 29)] });
    assert.equal(out?.five_hour?.falling, 1);
    assert.equal(out?.seven_day?.falling, 1);
    assert.deepEqual(out?.seven_day?.latest, [{ atMs: D + 11 * H, fromPct: 30, toPct: 29 }]);
  });

  it('only the latest five falls are listed, oldest of them first', async () => {
    // 14 snapshots alternating 90 and 10 at hours 1..14: seven falls (90 to 10) at hours 2, 4, ..., 14.
    const snaps = [];
    for (let h = 1; h <= 14; h += 1) snaps.push(row(h, h % 2 === 1 ? 90 : 10, null));
    const r = await five(snaps);
    assert.equal(r?.falling, 7);
    assert.deepEqual((r?.latest ?? []).map((x) => x.atMs), [6, 8, 10, 12, 14].map((h) => D + h * H));
  });

  it('input order does not matter: snapshots are sorted by instant first', async () => {
    const r = await five([row(11, 20, null), row(10, 55, null)]);
    assert.equal(r?.falling, 1);
  });

  it('seven_day only snapshots leave five_hour with no points', async () => {
    const out = (await mod()).findWindowLeads({ snapshots: [row(10, null, 30), row(11, null, 29)] });
    assert.equal(out?.five_hour?.points, 0);
    assert.equal(out?.seven_day?.points, 2);
  });
});
