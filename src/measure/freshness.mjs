// Freshness evaluation, age formatting and the header lines of every report (plan 01-08, TRUST-05, D-14). Pure:
// built-ins only, integer arithmetic only. A live source is STALE when the age of its newest record, or the age of
// its last ok ingest run, is strictly greater than its limit; ages are whole seconds floored once, so 36 hours
// (129600 s) is not stale and 129601 s is. The verdict is advice: it never changes an exit status or withholds output.
export const FRESHNESS_STATES = Object.freeze(['ok', 'stale', 'empty', 'never_run', 'not_rated']);

const ageOf = (nowMs, utc) => {
  if (utc === null || utc === undefined) return null;
  const t = Date.parse(utc);
  return Number.isNaN(t) ? null : Math.floor((nowMs - t) / 1000);
};
const isoOf = (utc) => (utc === null || utc === undefined || Number.isNaN(Date.parse(utc)) ? null : new Date(Date.parse(utc)).toISOString());

// sources: [{ name, live, staleAfterHours, newestRecordUtc, lastRunUtc }] in registry order.
// -> { verdict: 'none' | 'ok' | 'stale', nowMs, sources: [{ name, live, limitHours, newestRecordUtc, lastRunUtc,
//      recordAgeSec, runAgeSec, state, reasons, idle }] }
export function evaluateFreshness({ sources, nowMs }) {
  const out = sources.map((s) => {
    const limitSec = Math.round(s.staleAfterHours * 3600);
    const recordAgeSec = ageOf(nowMs, s.newestRecordUtc);
    const runAgeSec = ageOf(nowMs, s.lastRunUtc);
    const base = {
      name: s.name, live: s.live === true, limitHours: s.staleAfterHours, newestRecordUtc: s.newestRecordUtc ?? null,
      lastRunUtc: s.lastRunUtc ?? null, recordAgeSec, runAgeSec, reasons: [], idle: false,
    };
    if (s.live !== true) return { ...base, state: 'not_rated' };
    if (runAgeSec === null) return { ...base, state: 'never_run', reasons: ['never_run'] };
    if (recordAgeSec === null) return { ...base, state: 'empty' };
    const reasons = [];
    if (recordAgeSec > limitSec) reasons.push('record_old');
    if (runAgeSec > limitSec) reasons.push('run_old');
    if (reasons.length === 0) return { ...base, state: 'ok' };
    return { ...base, state: 'stale', reasons, idle: reasons.length === 1 && reasons[0] === 'record_old' };
  });
  let verdict = 'ok';
  if (!out.some((s) => s.lastRunUtc !== null && s.runAgeSec !== null)) verdict = 'none';
  else if (out.some((s) => s.state === 'stale' || s.state === 'never_run')) verdict = 'stale';
  return { verdict, nowMs, sources: out };
}

// Whole seconds as HhMMmSSs, hours unbounded; negative with a leading minus; null is "?".
export function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return '?';
  const neg = seconds < 0;
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${neg ? '-' : ''}${h}h${String(m).padStart(2, '0')}m${String(s % 60).padStart(2, '0')}s`;
}

function stateText(s) {
  const limit = `${s.limitHours}h`;
  switch (s.state) {
    case 'ok': return 'ok';
    case 'empty': return 'no records (not stale)';
    case 'never_run': return 'STALE: no ingest run recorded for this source';
    case 'stale': {
      const rec = s.reasons.includes('record_old');
      const run = s.reasons.includes('run_old');
      if (rec && run) return `STALE: newest record older than ${limit}; last ingest run older than ${limit}`;
      if (run) return `STALE: last ingest run older than ${limit}`;
      return `STALE: newest record older than ${limit}; last ingest run ${formatAge(s.runAgeSec)} ago, so ingest is current and the source looks idle`;
    }
    default: return 'not rated';
  }
}

// The header block: a verdict line then one line per source (see the grammar in docs/cli.md).
export function freshnessLines(result, { clockFixed = false } = {}) {
  if (result.verdict === 'none') return ['freshness: no ingest recorded'];
  const mark = clockFixed ? ' (clock fixed by RIGORSCOPE_NOW)' : '';
  const lines = [`freshness: ${result.verdict === 'ok' ? 'OK' : 'STALE'} as of ${new Date(result.nowMs).toISOString()}${mark}`];
  const width = Math.max(0, ...result.sources.map((s) => s.name.length));
  for (const s of result.sources) {
    const tail = s.state === 'not_rated' ? 'not rated' : `limit ${s.limitHours}h; ${stateText(s)}`;
    lines.push(
      `  ${s.name.padEnd(width)} newest record ${isoOf(s.newestRecordUtc) ?? 'none'} (age ${formatAge(s.recordAgeSec)}); `
      + `last run ${isoOf(s.lastRunUtc) ?? 'none'} (age ${formatAge(s.runAgeSec)}); ${tail}`,
    );
  }
  return lines;
}
