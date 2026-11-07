// mergeLedger (plan 03-03, D-04, D-13, D-14; ADR-0011): the pure per-field merge of one unit's ledger rows. No I/O, no
// clock, no store: unit-fill.mjs reads the ledger_line rows once, groups them by unit key and calls this per unit.
//
// Rows are ordered by line time (ts_utc, compared as instants) then line_id bytewise, so the result does not depend on
// the order the rows come in. The rule (J4), per field:
//   tier        the earliest START row with a usable tier, else the latest CLOSE row with a usable tier; usable means a
//               letter A, B or C with a tier_source other than `unknown` (an unknown source is not used, ADR-0004)
//   tier_timing D-04 / J5: declared-at-start and plan-at-start -> `declared-at-start`, comparable 1; declared-at-close ->
//               `declared-at-close`, comparable 0
//   start       the earliest non-null start_utc of any row; end: the latest non-null end_utc of the CLOSE rows
//   status      the latest close row's status (null when it has none); no close row at all and a start row -> incomplete
//   command, runtime, session_id   the earliest non-null over the start rows, else the latest non-null over the close rows
//   recorded_at_utc  the earliest line time (when the CLI ran; never compared with git times)
// An unparseable time is skipped (NULL when nothing else supplies one), never 0. Nothing is guessed: a field no row supplies
// is null. -> { lines, tier, tier_source, tier_signal, tier_timing, tier_comparable, start_ms, end_ms, status, command,
// runtime, session_id, recorded_at_utc }.
import { inTierComparison } from '../units/tier.mjs';

const TIERS = new Set(['A', 'B', 'C']);
const START_SOURCES = new Set(['declared-at-start', 'plan-at-start']);

const bytes = (s) => Buffer.from(String(s));
const compareBytes = (a, b) => Buffer.compare(bytes(a), bytes(b));
const parse = (v) => {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};
const tsKey = (r) => parse(r.ts_utc) ?? Number.POSITIVE_INFINITY;

function ordered(rows) {
  return [...rows].sort((x, y) => {
    const a = tsKey(x);
    const b = tsKey(y);
    if (a !== b) return a < b ? -1 : 1;
    return compareBytes(x.line_id, y.line_id);
  });
}

const usableTier = (r) => TIERS.has(r.tier) && r.tier_source !== 'unknown'
  && (START_SOURCES.has(r.tier_source) || r.tier_source === 'declared-at-close');

export function mergeLedger(rows) {
  const all = ordered(Array.isArray(rows) ? rows : []);
  const starts = all.filter((r) => r.record === 'start');
  const closes = all.filter((r) => r.record === 'close');

  const tierRow = starts.find(usableTier) ?? [...closes].reverse().find(usableTier) ?? null;
  const tier = tierRow === null ? null : tierRow.tier;
  const tierTiming = tierRow === null ? null : (START_SOURCES.has(tierRow.tier_source) ? 'declared-at-start' : 'declared-at-close');
  const tierSignal = tier === null ? 'none' : 'ledger';

  const startTimes = all.map((r) => parse(r.start_utc)).filter((v) => v !== null);
  const endTimes = closes.map((r) => parse(r.end_utc)).filter((v) => v !== null);

  let status = null;
  if (closes.length > 0) status = closes[closes.length - 1].status ?? null;
  else if (starts.length > 0) status = 'incomplete';

  const meta = (field) => starts.map((r) => r[field]).find((v) => v !== null && v !== undefined)
    ?? [...closes].reverse().map((r) => r[field]).find((v) => v !== null && v !== undefined) ?? null;

  return {
    lines: all.length,
    tier,
    tier_source: tierRow === null ? null : tierRow.tier_source,
    tier_signal: tierSignal,
    tier_timing: tierTiming,
    tier_comparable: inTierComparison({ tier, tier_signal: tierSignal, tier_timing: tierTiming }) ? 1 : 0,
    start_ms: startTimes.length === 0 ? null : Math.min(...startTimes),
    end_ms: endTimes.length === 0 ? null : Math.max(...endTimes),
    status,
    command: meta('command'),
    runtime: meta('runtime'),
    session_id: meta('session_id'),
    recorded_at_utc: all.length === 0 ? null : all[0].ts_utc,
  };
}
