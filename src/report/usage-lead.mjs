// The window-percentage discontinuity lead (plan 01-09, D-11a, TRUST-05): over the stored usage snapshots, count per
// window the consecutive pairs with the same reset instant (within the 01-06 tolerance) whose percentage falls. The
// series is built the way estimateWindowShares builds it (sorted by instant, then source bytewise; a later snapshot in
// the same millisecond is dropped) and classified by classifyInterval, so there is no second rule. A fall is a lead,
// never a verdict: a different signed-in account or another machine can cause it.
import { WINDOWS, classifyInterval } from '../derive/window.mjs';

const MAX_LATEST = 5;
const bytewise = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// snapshots: rows { source, fetched_at_ms, <window>_pct, <window>_resets_ms }.
// -> { five_hour: { points, intervals, falling, latest: [{ atMs, fromPct, toPct }] }, seven_day: {...} }
export function findWindowLeads({ snapshots }) {
  const out = {};
  for (const win of WINDOWS) {
    const sorted = snapshots
      .filter((s) => s[`${win}_pct`] !== null && s[`${win}_pct`] !== undefined && s[`${win}_resets_ms`] !== null && s[`${win}_resets_ms`] !== undefined)
      .map((s) => ({ source: s.source, tsMs: s.fetched_at_ms, pct: s[`${win}_pct`], resetsMs: s[`${win}_resets_ms`] }))
      .sort((a, b) => (a.tsMs - b.tsMs) || bytewise(a.source, b.source));
    const series = sorted.filter((s, i) => i === 0 || s.tsMs !== sorted[i - 1].tsMs);
    const falls = [];
    for (let i = 1; i < series.length; i += 1) {
      const c = classifyInterval(series[i - 1], series[i]);
      if (c?.status === 'falling') falls.push({ atMs: series[i].tsMs, fromPct: series[i - 1].pct, toPct: series[i].pct });
    }
    out[win] = { points: series.length, intervals: Math.max(0, series.length - 1), falling: falls.length, latest: falls.slice(-MAX_LATEST) };
  }
  return out;
}
