// The usage cache reader (plan 01-06, D-11a). Claude Code keeps one overwritten cache of the subscription
// window utilization inside its main config file in HOME, a file that also holds account data, project
// paths and money figures. This module is the only place in src that names that file. It:
//   - opens HOME/<CACHE_FILE_NAME> read-only and without following a symlink, refuses anything but a regular
//     file, checks the size cap on the open descriptor before reading, and reads with a bounded loop
//   - parses inside a try/catch that keeps only the status (a parser or system error text quotes input or
//     paths and is never kept, printed or stored)
//   - keeps an explicit allowlist pick by literal property access (CACHE_PICK): no enumeration of any object,
//     no copy, no serialization, no read of any key outside the pick (the account id key included)
// Every result holds fixed status strings, numbers, CACHE_PICK paths and the picked snapshot only.
//
// Snapshot shape (shared with report.mjs and the usage writer):
//   { fetchedAtMs, windows: { five_hour, seven_day, seven_day_opus, seven_day_sonnet }, limits }
//   window = { pct, resetsMs } or null; limit = { kind, grp, percent, resetsMs, severity, isActive }
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

export const CACHE_FILE_NAME = '.claude.json';
// The fixed text used whenever a line must name the file; never the absolute path (it holds the OS user name).
export const CACHE_DISPLAY = '~/.claude.json';
// The real file is a few hundred KB and grows with project history; 16 MiB leaves room and bounds the read.
export const MAX_CACHE_BYTES = 16 * 1024 * 1024;
export const MAX_LIMITS = 16;
// fetchedAtMs must be an integer between 2000-01-01 and 2100-01-01 (UTC).
export const MIN_FETCHED_MS = 946684800000;
export const MAX_FETCHED_MS = 4102444800000;

export const WINDOW_NAMES = Object.freeze(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']);

const entry = (path, table, column, kind) => Object.freeze({ path, table, column, kind });
const windowEntries = (w) => [
  entry(`utilization.${w}.utilization`, 'usage_snapshot', `${w}_pct`, 'percent'),
  entry(`utilization.${w}.resets_at`, 'usage_snapshot', `${w}_resets_ms`, 'instant'),
];
// The allowlist (D-11a): key paths relative to cachedUsageUtilization, each with the column it fills and its
// shape rule. Rejected and capped items are counted under these paths (plus the parent utilization.limits for
// a non-array or an overflow). Severity is NOT in this pick; the transcript pick has its own constant.
export const CACHE_PICK = Object.freeze([entry('fetchedAtMs', 'usage_snapshot', 'fetched_at_ms', 'epoch_ms')].concat(
  windowEntries('five_hour'),
  windowEntries('seven_day'),
  windowEntries('seven_day_opus'),
  windowEntries('seven_day_sonnet'),
  [
    entry('utilization.limits[].kind', 'usage_limit', 'kind', 'name'),
    entry('utilization.limits[].group', 'usage_limit', 'grp', 'name_or_null'),
    entry('utilization.limits[].percent', 'usage_limit', 'percent', 'percent'),
    entry('utilization.limits[].resets_at', 'usage_limit', 'resets_ms', 'instant'),
    entry('utilization.limits[].is_active', 'usage_limit', 'is_active', 'flag'),
  ],
));

const NAME = /^[a-z][a-z0-9_]{0,47}$/;
export const SEVERITY = /^[a-z][a-z0-9_]{0,31}$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const MIN_INSTANT_MS = MIN_FETCHED_MS;
const MAX_INSTANT_MS = MAX_FETCHED_MS;

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isName = (v) => typeof v === 'string' && NAME.test(v);

// A percentage: a finite number from 0 to 100 inclusive, else null.
export function parsePercent(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

// An instant: YYYY-MM-DDTHH:MM:SS[.fraction] with Z or a +HH:MM / -HH:MM offset, every field in range and the
// instant between 2000 and 2100; returns UTC epoch milliseconds or null.
export function parseInstant(v) {
  if (typeof v !== 'string') return null;
  const m = INSTANT.exec(v);
  if (m === null) return null;
  const [, ys, mos, ds, hs, mis, ss, frac, zone, sign, ohs, oms] = m;
  const y = Number(ys);
  const mo = Number(mos);
  const d = Number(ds);
  const h = Number(hs);
  const mi = Number(mis);
  const s = Number(ss);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const ms = frac === undefined ? 0 : Math.floor(Number(`0.${frac}`) * 1000);
  const local = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (new Date(local).getUTCDate() !== d) return null; // February 30 and friends
  let offset = 0;
  if (zone !== 'Z') {
    const oh = Number(ohs);
    const om = Number(oms);
    if (oh > 23 || om > 59) return null;
    offset = (oh * 60 + om) * 60000 * (sign === '-' ? -1 : 1);
  }
  const t = local - offset;
  return Number.isSafeInteger(t) && t >= MIN_INSTANT_MS && t <= MAX_INSTANT_MS ? t : null;
}

// Counts per path, in first-seen order; the result is an array of { path, n }.
export function newCounter() {
  const counts = new Map();
  return {
    add(path, n = 1) { counts.set(path, (counts.get(path) ?? 0) + n); },
    list() {
      const out = [];
      for (const [path, n] of counts) out.push({ path, n });
      return out;
    },
  };
}

// The limit entries of an array (cache: utilization.limits, report: usageReport.rate_limits.limits). At most
// MAX_LIMITS entries are considered; the overflow is counted under `prefix`. kind, percent and resets_at are
// required (a bad one drops the entry); a bad group or is_active is stored NULL; severity is read only when
// `withSeverity` is true (the cache pick never reads it).
export function pickLimitEntries(list, { prefix, withSeverity, counter }) {
  const out = [];
  const n = list.length;
  const considered = n > MAX_LIMITS ? MAX_LIMITS : n;
  if (n > MAX_LIMITS) counter.add(prefix, n - MAX_LIMITS);
  for (let i = 0; i < considered; i += 1) {
    const e = list[i];
    if (!isPlainObject(e)) { counter.add(`${prefix}[].kind`); continue; }
    const kind = e.kind;
    if (!isName(kind)) { counter.add(`${prefix}[].kind`); continue; }
    const percent = parsePercent(e.percent);
    if (percent === null) { counter.add(`${prefix}[].percent`); continue; }
    const resetsMs = parseInstant(e.resets_at);
    if (resetsMs === null) { counter.add(`${prefix}[].resets_at`); continue; }
    const g = e.group;
    let grp = null;
    if (isName(g)) grp = g;
    else if (g !== null && g !== undefined) counter.add(`${prefix}[].group`);
    const a = e.is_active;
    let isActive = null;
    if (a === true) isActive = 1;
    else if (a === false) isActive = 0;
    else if (a !== null && a !== undefined) counter.add(`${prefix}[].is_active`);
    let severity = null;
    if (withSeverity) {
      const s = e.severity;
      if (typeof s === 'string' && SEVERITY.test(s)) severity = s;
      else if (s !== null && s !== undefined) counter.add(`${prefix}[].severity`);
    }
    out.push({ kind, grp, percent, resetsMs, severity, isActive });
  }
  return out;
}

// One window object: both fields valid, else null with the bad paths counted. A JSON null (or absent) window
// is absent and not counted.
function pickWindow(u, name, counter) {
  const w = u[name];
  if (w === null || w === undefined) return null;
  if (!isPlainObject(w)) { counter.add(`utilization.${name}.utilization`); return null; }
  const pct = parsePercent(w.utilization);
  const resetsMs = parseInstant(w.resets_at);
  if (pct === null) counter.add(`utilization.${name}.utilization`);
  if (resetsMs === null) counter.add(`utilization.${name}.resets_at`);
  return pct === null || resetsMs === null ? null : { pct, resetsMs };
}

// root: the parsed file. Returns { status, snapshot, rejected, counts }; status is ok (possibly partial),
// no_cache (the cache is not a plain object) or rejected (fetchedAtMs invalid).
export function pickUsageCache(root) {
  const counter = newCounter();
  const done = (status, snapshot) => ({ status, snapshot, rejected: counter.list(), counts: { limits: snapshot ? snapshot.limits.length : 0 } });
  if (!isPlainObject(root)) return done('no_cache', null);
  const c = root.cachedUsageUtilization;
  if (!isPlainObject(c)) return done('no_cache', null);
  const fetchedAtMs = c.fetchedAtMs;
  if (!Number.isSafeInteger(fetchedAtMs) || fetchedAtMs < MIN_FETCHED_MS || fetchedAtMs > MAX_FETCHED_MS) {
    counter.add('fetchedAtMs');
    return done('rejected', null);
  }
  const u = c.utilization;
  const windows = { five_hour: null, seven_day: null, seven_day_opus: null, seven_day_sonnet: null };
  let limits = [];
  if (isPlainObject(u)) {
    windows.five_hour = pickWindow(u, 'five_hour', counter);
    windows.seven_day = pickWindow(u, 'seven_day', counter);
    windows.seven_day_opus = pickWindow(u, 'seven_day_opus', counter);
    windows.seven_day_sonnet = pickWindow(u, 'seven_day_sonnet', counter);
    const list = u.limits;
    if (Array.isArray(list)) limits = pickLimitEntries(list, { prefix: 'utilization.limits', withSeverity: false, counter });
    else if (list !== null && list !== undefined) counter.add('utilization.limits');
  } else if (u !== null && u !== undefined) {
    counter.add('utilization.five_hour.utilization');
  }
  return done('ok', { fetchedAtMs, windows, limits });
}

// Reads HOME/<CACHE_FILE_NAME>. Returns { status, opened, bytes, snapshot, rejected }: status absent,
// not_regular, oversized, unreadable, unparseable, or the pick's status. `pick` is a test seam.
export function readUsageCache({ home, maxBytes = MAX_CACHE_BYTES, pick = pickUsageCache } = {}) {
  const result = (status, opened, bytes, picked) => ({
    status, opened, bytes, snapshot: picked ? picked.snapshot : null, rejected: picked ? picked.rejected : [],
  });
  const file = join(home, CACHE_FILE_NAME);
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = err !== null && typeof err === 'object' ? err.code : undefined;
    if (code === 'ENOENT') return result('absent', false, 0, null);
    if (code === 'ELOOP') return result('not_regular', false, 0, null);
    return result('unreadable', false, 0, null);
  }
  let buf;
  try {
    let st;
    try {
      st = fstatSync(fd);
    } catch {
      return result('unreadable', true, 0, null);
    }
    if (!st.isFile()) return result('not_regular', true, 0, null);
    if (st.size > maxBytes) return result('oversized', true, 0, null);
    buf = Buffer.alloc(st.size);
    let got = 0;
    try {
      while (got < st.size) {
        const n = readSync(fd, buf, got, st.size - got, got);
        if (n <= 0) break;
        got += n;
      }
    } catch {
      return result('unreadable', true, got, null);
    }
    buf = buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result('unparseable', true, buf.length, null);
  }
  const picked = pick(parsed);
  return result(picked.status, true, buf.length, picked);
}
