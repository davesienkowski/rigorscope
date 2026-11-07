// Period and zone arithmetic for the cost report (plan 01-08, COST-05, D-07). Pure: built-ins only.
//
// A day is a local-zone day of an instant, found with Intl formatToParts in the stated zone, never with the
// process C-library zone and never by comparing date strings. A period is a half-open range of integer
// milliseconds: the lower bound is the first instant of the local --since day (inclusive) and the upper bound is
// the first instant of the day after --until (exclusive), so --until is inclusive of its whole local day.
export const DEFAULT_PERIOD_HOURS = 168;

const HOUR_MS = 3600000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z][A-Za-z0-9_+-]*)*$/;
const MAX_MS = 8.64e15;
const DATE_MESSAGE = 'a date must be YYYY-MM-DD, a real calendar date from 1970-01-01 to 2199-12-31';
const TZ_MESSAGE = 'the --tz value must be a known IANA zone name such as UTC or America/Los_Angeles';
const PERIOD_MESSAGE = 'the --since date must not be after the --until date';

const pad = (n, w) => String(n).padStart(w, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// -> { year, month, day, text }. Throws RangeError for anything but a real YYYY-MM-DD date in 1970..2199.
export function parseDateArg(text) {
  const m = typeof text === 'string' ? DATE_RE.exec(text) : null;
  if (!m) throw new RangeError(DATE_MESSAGE);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1970 || year > 2199 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) throw new RangeError(DATE_MESSAGE);
  return { year, month, day, text };
}

const formatters = new Map();
function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

// -> the canonical zone name. undefined gives the process zone. Throws RangeError for a shape failure or a zone Intl rejects.
export function resolveTz(text) {
  if (text === undefined) return new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (typeof text !== 'string' || text.length === 0 || text.length > 64 || !ZONE_RE.test(text)) throw new RangeError(TZ_MESSAGE);
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: text }).resolvedOptions().timeZone;
  } catch {
    throw new RangeError(TZ_MESSAGE);
  }
}

// -> 'YYYY-MM-DD' of the instant in the zone, or null for a value that is not an integer millisecond count in range.
// The date sources whose value is a local day, not an instant (a quick id date; a SUMMARY `completed:` date). One definition for
// the units document (precision) and the calibrate comparison (review 03-05 H1), so the two never drift.
export const DAY_SOURCES = new Set(['quick-id', 'frontmatter']);

export function localDay(ms, tz) {
  if (typeof ms !== 'number' || !Number.isInteger(ms) || Math.abs(ms) > MAX_MS) return null;
  let year = '';
  let month = '';
  let day = '';
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
  }
  return `${year.padStart(4, '0')}-${month}-${day}`;
}

// The earliest instant whose local day in the zone is the date: a scan from 16 hours before to 14 hours after the UTC
// midnight of the date in 15-minute steps, then a minute-by-minute refinement downward. Valid for zones whose offset
// is a whole number of minutes that changes at most once a day.
export function startOfLocalDay(dateText, tz) {
  const d = parseDateArg(dateText);
  const base = Date.UTC(d.year, d.month - 1, d.day);
  const STEP = 15 * 60000;
  let found = null;
  for (let t = base - 16 * HOUR_MS; t <= base + 14 * HOUR_MS; t += STEP) {
    if (localDay(t, tz) === d.text) { found = t; break; }
  }
  if (found === null) throw new RangeError(DATE_MESSAGE);
  let t = found;
  while (localDay(t - 60000, tz) === d.text) t -= 60000;
  return t;
}

const nextDate = (d) => {
  const n = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
  return `${pad(n.getUTCFullYear(), 4)}-${pad(n.getUTCMonth() + 1, 2)}-${pad(n.getUTCDate(), 2)}`;
};

export function allPeriod() {
  return { mode: 'all', tz: null, sinceMs: null, untilMs: null, sinceDate: null, untilDate: null, nowMs: null };
}

// since and until are YYYY-MM-DD texts or undefined. Throws RangeError for a bad date or a lower bound after the upper.
export function resolvePeriod({ since, until, tz, nowMs }) {
  if (since === undefined && until === undefined) {
    return { mode: 'default', tz, sinceMs: nowMs - DEFAULT_PERIOD_HOURS * HOUR_MS, untilMs: null, sinceDate: null, untilDate: null, nowMs };
  }
  const s = since === undefined ? null : parseDateArg(since);
  const u = until === undefined ? null : parseDateArg(until);
  const sinceMs = s ? startOfLocalDay(s.text, tz) : null;
  // The day after a 2199-12-31 until is outside the date range; it is computed with Date arithmetic, not parsed.
  const untilMs = u ? startOfLocalDay(nextDate(u), tz) : null;
  if (sinceMs !== null && untilMs !== null && sinceMs >= untilMs) throw new RangeError(PERIOD_MESSAGE);
  return { mode: 'range', tz, sinceMs, untilMs, sinceDate: s ? s.text : null, untilDate: u ? u.text : null, nowMs };
}

const iso = (ms) => new Date(ms).toISOString();

export function formatPeriodLine(period, { tsUnknown = 0 } = {}) {
  if (period.mode === 'all') return 'period: all ingested records';
  const tail = `tz=${period.tz}, calls_ts_unknown=${tsUnknown}`;
  if (period.mode === 'default') return `period: last 7 days, from ${iso(period.sinceMs)} (default), ${tail}`;
  const from = period.sinceMs === null ? 'the first record' : `${period.sinceDate} (${iso(period.sinceMs)})`;
  const to = period.untilMs === null ? 'the last record' : `${period.untilDate} inclusive (before ${iso(period.untilMs)})`;
  return `period: from ${from} to ${to}, ${tail}`;
}
