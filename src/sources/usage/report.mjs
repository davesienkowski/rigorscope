// The transcript usageReport pick (plan 01-06, outline 01-06, D-11a). Claude Code writes a system line with
// subtype local_command and a top-level usageReport when the usage command runs; next to the limit entries
// it carries the rendered usage text, session totals, credit figures and scope text. This pick reads the
// line timestamp and the six limit fields of REPORT_PICK only (a separate constant from the cache pick:
// severity is read here, never there), by literal property access with no enumeration or copy.
//
// The windows of a report snapshot come from the limit kinds: session -> five_hour, weekly_all -> seven_day
// (the first entry of a kind wins). The per-model weekly windows are never set from a report.
import {
  isPlainObject, newCounter, parseInstant, pickLimitEntries,
} from './cache.mjs';

const PREFIX = 'usageReport.rate_limits.limits';
const limitEntry = (field, column) => Object.freeze({ path: `${PREFIX}[].${field}`, table: 'usage_limit', column });

export const REPORT_PICK = Object.freeze([
  Object.freeze({ path: 'timestamp', table: 'usage_snapshot', column: 'fetched_at_ms' }),
  limitEntry('kind', 'kind'),
  limitEntry('group', 'grp'),
  limitEntry('percent', 'percent'),
  limitEntry('resets_at', 'resets_ms'),
  limitEntry('severity', 'severity'),
  limitEntry('is_active', 'is_active'),
]);

const kindMap = Object.create(null);
kindMap.session = 'five_hour';
kindMap.weekly_all = 'seven_day';
export const LIMIT_KIND_TO_WINDOW = Object.freeze(kindMap);

const notReport = () => ({ status: 'not_report', snapshot: null, rejected: [] });

// line: one parsed transcript line. Returns { status, snapshot, rejected }: not_report for any other line
// (never counted), rejected when the timestamp is invalid, else ok.
export function pickUsageReport(line) {
  if (!isPlainObject(line)) return notReport();
  if (line.type !== 'system' || line.subtype !== 'local_command') return notReport();
  const report = line.usageReport;
  if (!isPlainObject(report)) return notReport();
  const rateLimits = report.rate_limits;
  if (!isPlainObject(rateLimits)) return notReport();
  const list = rateLimits.limits;
  if (!Array.isArray(list)) return notReport();
  const counter = newCounter();
  const fetchedAtMs = parseInstant(line.timestamp);
  if (fetchedAtMs === null) {
    counter.add('timestamp');
    return { status: 'rejected', snapshot: null, rejected: counter.list() };
  }
  const limits = pickLimitEntries(list, { prefix: PREFIX, withSeverity: true, counter });
  const windows = { five_hour: null, seven_day: null, seven_day_opus: null, seven_day_sonnet: null };
  for (const l of limits) {
    const w = Object.hasOwn(LIMIT_KIND_TO_WINDOW, l.kind) ? LIMIT_KIND_TO_WINDOW[l.kind] : null;
    if (w !== null && windows[w] === null) windows[w] = { pct: l.percent, resetsMs: l.resetsMs };
  }
  return { status: 'ok', snapshot: { fetchedAtMs, windows, limits }, rejected: counter.list() };
}
