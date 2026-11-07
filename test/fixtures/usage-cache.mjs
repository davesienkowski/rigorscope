// Usage-cache fixtures for plan 01-06 (D-11a). A helper, not a test: it is never collected by the quoted
// test glob, and it imports nothing from src/ (the tests it serves are written before the code).
//
//   USAGE_PLANTS   unique strings, each holding the canary marker, planted in every position of the main
//                  Claude Code config file that the allowlist pick must never touch
//   MONEY          two money numbers; MONEY_TEXT their decimal text forms (canary needles)
//   SNAPSHOTS      the A to E series of 2026-10-26 (A, B, C, E cache snapshots; D a transcript usageReport)
//   cacheFileObject(snap, opts)   the whole hostile .claude.json object for one cache snapshot
//   writeUsageCache(home, snap, opts)  writes HOME/.claude.json (mode 0644); opts: bom, crlfPretty,
//                  unicodeEscapes, raw (text written as is), osUser
//   usageReportLine(snap, opts)   the transcript line of snapshot D (type system, subtype local_command)
//   insertSnapshotRow(db, snap)   direct INSERT into usage_snapshot for derive-only tests
//   guarded(value, allow)         a guard Proxy that records (and throws on) any read outside `allow`
//   EXPECTED_WINDOW               every hand-computed literal of the plan, with its arithmetic beside it
//
// All instants are fixed. Epoch milliseconds are computed by hand from 2026-10-26T00:00:00Z =
// 20,752 days x 86,400,000 ms = 1,792,972,800,000; one hour is 3,600,000 ms.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The fake OS user name of the 01-01 plants (test/fixtures/build.mjs PLANTS.osUser), repeated here so this
// helper never imports build.mjs.
const OS_USER = 'CANARYuser';

export const USAGE_PLANTS = Object.freeze({
  accountId: 'CANARY-uacct-5e1d0b7a-41f2',
  email: 'CANARY-umail@canary-usage.invalid',
  orgId: 'CANARY-uorg-3c8f9a20',
  userId: 'CANARY-uuser-0a1b2c3d',
  moneyString: 'CANARY-usd-1234.56',
  hostileKeyEmail: 'CANARY-ukey@canary-usage.invalid',
  hostileKeyAccount: 'key-CANARY-uacct-5e1d0b7a-41f2-hostile',
  scope: 'CANARY-scope-text opus family only',
  reportTotal: 'CANARY-report-total-77777',
  content: 'CANARY-rendered usage text 51 percent weekly',
  nonAscii: 'CANARY usage café ☃ note',
  lockedReason: 'CANARY-locked-reason-text',
});

export const MONEY = Object.freeze([48271.93, 91357.42]);
export const MONEY_TEXT = Object.freeze(['48271.93', '91357.42']);

// Every string to scan for: the plants and the money numbers as text.
export const USAGE_NEEDLES = Object.freeze([...Object.values(USAGE_PLANTS), ...MONEY_TEXT]);

export const CACHE_SOURCE = 'claude-json-cache';
export const REPORT_SOURCE = 'transcript';

const HOUR = 3600000;
const DAY0 = 1792972800000; // 2026-10-26T00:00:00Z
export const MS = Object.freeze({
  h08: 1793001600000, // DAY0 + 8 h
  h09: 1793005200000, // DAY0 + 9 h (snapshot A)
  h10: 1793008800000, // DAY0 + 10 h (c1)
  h11: 1793012400000, // DAY0 + 11 h (c2)
  h1130: 1793014200000, // DAY0 + 11.5 h (c10)
  h12: 1793016000000, // DAY0 + 12 h (snapshot B, c3)
  h13: 1793019600000, // DAY0 + 13 h (five-hour reset of A and B)
  h1330: 1793021400000, // DAY0 + 13.5 h (c4)
  h15: 1793026800000, // DAY0 + 15 h (snapshot C)
  h1530: 1793028600000, // DAY0 + 15.5 h (c5)
  h16: 1793030400000, // DAY0 + 16 h (snapshot D)
  h1630: 1793032200000, // DAY0 + 16.5 h (c6)
  h17: 1793034000000, // DAY0 + 17 h (snapshot E)
  h1730: 1793035800000, // DAY0 + 17.5 h (c7)
  h18: 1793037600000, // DAY0 + 18 h (five-hour reset of C, D and E)
  oct31: 1793404800000, // DAY0 + 5 days x 86,400,000 = 1,792,972,800,000 + 432,000,000 (weekly reset)
});
if (MS.h09 !== DAY0 + 9 * HOUR || MS.oct31 !== DAY0 + 5 * 24 * HOUR) throw new Error('usage fixture instants are inconsistent');

// The series. Window entries are { pct, resetsAt } (resetsAt spelled as the file spells it) or null.
// Limit entries are written as the file holds them (severity and scope included, so a pick that reads
// them is caught).
const W = (pct, resetsAt) => ({ pct, resetsAt });
export const SNAPSHOTS = Object.freeze({
  A: Object.freeze({
    id: 'A', source: CACHE_SOURCE, fetchedAtMs: MS.h09, iso: '2026-10-26T09:00:00Z',
    five_hour: W(10, '2026-10-26T13:00:00+00:00'), seven_day: W(40, '2026-10-31T00:00:00+00:00'),
    seven_day_opus: null, seven_day_sonnet: null, limits: [],
  }),
  B: Object.freeze({
    id: 'B', source: CACHE_SOURCE, fetchedAtMs: MS.h12, iso: '2026-10-26T12:00:00Z',
    five_hour: W(22, '2026-10-26T13:00:00Z'), seven_day: W(46, '2026-10-31T00:00:00Z'),
    seven_day_opus: null, seven_day_sonnet: null, limits: [],
  }),
  C: Object.freeze({
    id: 'C', source: CACHE_SOURCE, fetchedAtMs: MS.h15, iso: '2026-10-26T15:00:00Z',
    five_hour: W(6, '2026-10-26T18:00:00+00:00'), seven_day: W(49, '2026-10-31T00:00:00+00:00'),
    seven_day_opus: null, seven_day_sonnet: null, limits: [],
  }),
  // D is a transcript usageReport line, not a cache file: its windows come from the limit kinds
  // session (five_hour) and weekly_all (seven_day).
  D: Object.freeze({
    id: 'D', source: REPORT_SOURCE, fetchedAtMs: MS.h16, iso: '2026-10-26T16:00:00.000Z',
    limits: [
      { kind: 'session', group: 'all', percent: 9, severity: 'normal', resets_at: '2026-10-26T18:00:00+00:00', scope: null, is_active: true },
      { kind: 'weekly_all', group: 'all', percent: 49, severity: 'normal', resets_at: '2026-10-31T00:00:00+00:00', scope: null, is_active: false },
      {
        kind: 'weekly_scoped', group: 'opus', percent: 0, severity: 'normal', resets_at: '2026-10-31T00:00:00+00:00',
        scope: { text: USAGE_PLANTS.scope, models: [USAGE_PLANTS.scope] }, is_active: false,
      },
    ],
  }),
  E: Object.freeze({
    id: 'E', source: CACHE_SOURCE, fetchedAtMs: MS.h17, iso: '2026-10-26T17:00:00Z',
    five_hour: W(5, '2026-10-26T18:00:00+00:00'), seven_day: W(51, '2026-10-31T00:00:00+00:00'),
    seven_day_opus: W(12, '2026-10-31T00:00:00Z'), seven_day_sonnet: null,
    limits: [
      { kind: 'session', group: 'all', percent: 5, severity: 'normal', resets_at: '2026-10-26T18:00:00+00:00', scope: null, is_active: true },
      { kind: 'weekly_all', group: 'all', percent: 51, severity: 'normal', resets_at: '2026-10-31T00:00:00+00:00', scope: null, is_active: false },
      {
        kind: 'weekly_scoped', group: 'opus', percent: 12, severity: 'warning', resets_at: '2026-10-31T00:00:00Z',
        scope: { text: USAGE_PLANTS.scope }, is_active: false,
      },
    ],
  }),
});

const P = USAGE_PLANTS;
const homeLike = (...parts) => ['', 'home', ...parts].join('/');

// One window object as the file holds it: the two picked fields plus money and text that must not be read.
function windowObject(w) {
  if (w === null || w === undefined) return null;
  return {
    utilization: w.pct,
    resets_at: w.resetsAt,
    limit_dollars: MONEY[0],
    used_dollars: MONEY[1],
    remaining_dollars: P.moneyString,
    locked_reason: P.lockedReason,
  };
}

// opts.utilization: replaces the utilization object (for shape tests); opts.cache: replaces the whole
// cachedUsageUtilization value; opts.fetchedAtMs overrides the snapshot's value; opts.osUser.
export function cacheFileObject(snap, opts = {}) {
  const osUser = opts.osUser ?? OS_USER;
  const utilization = opts.utilization ?? {
    five_hour: windowObject(snap.five_hour),
    seven_day: windowObject(snap.seven_day),
    seven_day_opus: windowObject(snap.seven_day_opus),
    seven_day_sonnet: windowObject(snap.seven_day_sonnet),
    limits: (snap.limits ?? []).map((l) => ({ ...l })),
    spend: { used_dollars: MONEY[0], cap_dollars: MONEY[1], label: P.moneyString },
    extra_usage: { credits_dollars: MONEY[1], note: P.moneyString, owner: P.email },
    seven_day_breakdown: { [P.hostileKeyAccount]: 3, other: 4 },
    weekly_scoped_shares: { opus: P.scope },
    [P.hostileKeyEmail]: 1,
    [P.hostileKeyAccount]: P.email,
    pace: null,
  };
  const cache = Object.hasOwn(opts, 'cache') ? opts.cache : {
    fetchedAtMs: Object.hasOwn(opts, 'fetchedAtMs') ? opts.fetchedAtMs : snap.fetchedAtMs,
    accountUuid: P.accountId,
    utilization,
  };
  return {
    numStartups: 12,
    userID: P.userId,
    oauthAccount: {
      accountUuid: P.accountId, emailAddress: P.email, organizationUuid: P.orgId, displayName: P.nonAscii,
      organizationName: P.content,
    },
    projects: {
      [homeLike(osUser, 'repos', 'x')]: { allowedTools: [], lastCost: MONEY[0], lastSessionId: P.accountId },
    },
    [P.hostileKeyEmail]: P.moneyString,
    [P.hostileKeyAccount]: { email: P.email },
    cachedUsageUtilization: cache,
  };
}

// Writes HOME/.claude.json. opts.raw writes that exact text; opts.bom prefixes a UTF-8 BOM; opts.crlfPretty
// pretty-prints with CRLF line ends; opts.unicodeEscapes writes every canary marker as a JSON unicode escape
// (the decoded file still holds the plants). Returns the path.
export function writeUsageCache(home, snap, opts = {}) {
  const file = join(home, '.claude.json');
  let text;
  if (typeof opts.raw === 'string') text = opts.raw;
  else {
    const obj = cacheFileObject(snap, opts);
    text = opts.crlfPretty ? JSON.stringify(obj, null, 2).replace(/\n/g, '\r\n') : JSON.stringify(obj);
    if (opts.unicodeEscapes) text = text.replaceAll('CANARY', '\\u0043ANARY');
  }
  const buf = Buffer.from(text, 'utf8');
  writeFileSync(file, opts.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]) : buf, { mode: 0o644 });
  return file;
}

// The transcript line of snapshot D (or of another report-shaped snapshot). opts: session, cwd, usageReport
// (replaces the whole usageReport value), extra (extra top-level keys).
export function usageReportLine(snap, opts = {}) {
  const usageReport = Object.hasOwn(opts, 'usageReport') ? opts.usageReport : {
    session: { total_cost_usd: MONEY[0], total_tokens: P.reportTotal, label: P.reportTotal },
    rate_limits: {
      limits: (snap.limits ?? []).map((l) => ({ ...l })),
      extra_usage: { used_dollars: MONEY[1], label: P.moneyString, owner: P.email },
    },
  };
  return JSON.stringify({
    type: 'system',
    subtype: 'local_command',
    uuid: `uuid-usage-${snap.id}`,
    parentUuid: null,
    sessionId: opts.session ?? '14141414-1414-4141-8141-141414141414',
    timestamp: snap.iso,
    cwd: opts.cwd ?? homeLike(OS_USER, 'repos', 'uwin'),
    version: '2.1.309',
    level: 'info',
    commandRun: '/usage',
    content: `<local-command-stdout>${P.content} ${P.nonAscii}</local-command-stdout>`,
    usageReport,
    ...(opts.extra ?? {}),
  });
}

// Direct INSERT of one snapshot row (derive-only tests). snap: { source, label, fetchedAtMs, five_hour,
// seven_day, seven_day_opus, seven_day_sonnet } with windows as { pct, resetsMs } or null. Column names are
// the plan's migration 004 names.
export function insertSnapshotRow(db, snap) {
  const w = (name) => snap[name] ?? null;
  const cols = {
    source: snap.source ?? CACHE_SOURCE,
    label: snap.label ?? ((snap.source ?? CACHE_SOURCE) === CACHE_SOURCE ? 'measured' : 'transcript'),
    fetched_at_ms: snap.fetchedAtMs,
    fetched_utc: new Date(snap.fetchedAtMs).toISOString(),
    first_run_id: null,
    five_hour_pct: w('five_hour')?.pct ?? null,
    five_hour_resets_ms: w('five_hour')?.resetsMs ?? null,
    seven_day_pct: w('seven_day')?.pct ?? null,
    seven_day_resets_ms: w('seven_day')?.resetsMs ?? null,
    seven_day_opus_pct: w('seven_day_opus')?.pct ?? null,
    seven_day_opus_resets_ms: w('seven_day_opus')?.resetsMs ?? null,
    seven_day_sonnet_pct: w('seven_day_sonnet')?.pct ?? null,
    seven_day_sonnet_resets_ms: w('seven_day_sonnet')?.resetsMs ?? null,
  };
  const names = Object.keys(cols);
  return db.prepare(`INSERT INTO usage_snapshot (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...names.map((n) => cols[n])).lastInsertRowid;
}

// A guard Proxy over a parsed value. `allow` is a tree: an object maps each readable key to `true` (a leaf,
// returned as is) or to a sub-tree; an array `[sub]` describes the elements of an array value. Any other read,
// any enumeration, any `in` test and any write is recorded in `violations` and throws. Messages name no key,
// because a key of the file may itself be a plant.
export function guarded(value, allow) {
  const violations = [];
  const fail = (what) => {
    violations.push(what);
    throw new Error(`guard: forbidden ${what}`);
  };
  const wrap = (v, spec) => {
    if (v === null || typeof v !== 'object' || spec === true) return v;
    const isArr = Array.isArray(v);
    return new Proxy(v, {
      get(t, k) {
        if (typeof k === 'symbol') return fail('symbol read');
        if (isArr) {
          if (!Array.isArray(spec)) return fail('array read');
          if (k === 'length') return t.length;
          if (/^(0|[1-9][0-9]*)$/.test(k)) return wrap(t[k], spec[0]);
          return fail('array property read');
        }
        if (spec === null || typeof spec !== 'object' || Array.isArray(spec) || !Object.hasOwn(spec, k)) return fail('read');
        return wrap(t[k], spec[k]);
      },
      ownKeys: () => fail('enumeration'),
      getOwnPropertyDescriptor: () => fail('descriptor read'),
      has: () => fail('in test'),
      set: () => fail('write'),
      defineProperty: () => fail('define'),
      deleteProperty: () => fail('delete'),
    });
  };
  return { proxy: wrap(value, allow), violations };
}

const WINDOW_ALLOW = { utilization: true, resets_at: true };
// What the cache pick may read (D-11a): note there is no severity, scope or money key.
export const CACHE_ALLOW = Object.freeze({
  cachedUsageUtilization: {
    fetchedAtMs: true,
    utilization: {
      five_hour: WINDOW_ALLOW,
      seven_day: WINDOW_ALLOW,
      seven_day_opus: WINDOW_ALLOW,
      seven_day_sonnet: WINDOW_ALLOW,
      limits: [{ kind: true, group: true, percent: true, resets_at: true, is_active: true }],
    },
  },
});
// What the report pick may read (outline 01-06): severity is allowed here, never session, extra_usage,
// content, scope or commandRun.
export const REPORT_ALLOW = Object.freeze({
  type: true,
  subtype: true,
  timestamp: true,
  usageReport: {
    rate_limits: {
      limits: [{ kind: true, group: true, percent: true, resets_at: true, severity: true, is_active: true }],
    },
  },
});

// ---------------------------------------------------------------------------------------------------------
// Hand-computed expectations (never computed by the code under test).
// ---------------------------------------------------------------------------------------------------------

// usage_snapshot rows in fetched_at_ms order:
// [source, label, fetched_at_ms, five_hour_pct, five_hour_resets_ms, seven_day_pct, seven_day_resets_ms,
//  seven_day_opus_pct, seven_day_opus_resets_ms, seven_day_sonnet_pct, seven_day_sonnet_resets_ms]
// Every +00:00 and Z spelling of one instant gives the same value (13:00 for A and B, 18:00 for C, D and E).
const SNAPSHOT_ROWS = [
  [CACHE_SOURCE, 'measured', MS.h09, 10, MS.h13, 40, MS.oct31, null, null, null, null], // A
  [CACHE_SOURCE, 'measured', MS.h12, 22, MS.h13, 46, MS.oct31, null, null, null, null], // B (Z spellings)
  [CACHE_SOURCE, 'measured', MS.h15, 6, MS.h18, 49, MS.oct31, null, null, null, null], // C
  [REPORT_SOURCE, 'transcript', MS.h16, 9, MS.h18, 49, MS.oct31, null, null, null, null], // D: session 9, weekly_all 49
  [CACHE_SOURCE, 'measured', MS.h17, 5, MS.h18, 51, MS.oct31, 12, MS.oct31, null, null], // E (opus 12, sonnet null)
];

export const SNAPSHOT_COLUMNS = Object.freeze([
  'source', 'label', 'fetched_at_ms', 'five_hour_pct', 'five_hour_resets_ms', 'seven_day_pct', 'seven_day_resets_ms',
  'seven_day_opus_pct', 'seven_day_opus_resets_ms', 'seven_day_sonnet_pct', 'seven_day_sonnet_resets_ms',
]);

// usage_limit rows: [seq, kind, grp, percent, resets_ms, severity, is_active]. The cache pick never reads
// severity (NULL for E); the report pick keeps it (D).
const LIMIT_ROWS_E = [
  [0, 'session', 'all', 5, MS.h18, null, 1],
  [1, 'weekly_all', 'all', 51, MS.oct31, null, 0],
  [2, 'weekly_scoped', 'opus', 12, MS.oct31, null, 0], // resets_at spelled with Z
];
const LIMIT_ROWS_D = [
  [0, 'session', 'all', 9, MS.h18, 'normal', 1],
  [1, 'weekly_all', 'all', 49, MS.oct31, 'normal', 0],
  [2, 'weekly_scoped', 'opus', 0, MS.oct31, 'normal', 0],
];

// Window intervals: [win, seq, start_ms, end_ms, start_pct, end_pct, resets_ms (of the later snapshot),
// status, delta_micro, parts, weight_total]. Part weights: c1 100, c2 200, c10 0, c3 300, c4 50, c5 unknown,
// c6 100 (c8 and c7 lie outside every interval).
const INTERVALS = [
  // five-hour series A 10, B 22, C 6, D 9, E 5
  ['five_hour', 0, MS.h09, MS.h12, 10, 22, MS.h13, 'usable', 12000000, 4, 600], // (22 - 10) x 1e6; c1 c2 c10 c3: 100+200+0+300
  ['five_hour', 1, MS.h12, MS.h15, 22, 6, MS.h18, 'reset', null, 1, 50], // resets 13:00 vs 18:00, 5 h apart; c4
  ['five_hour', 2, MS.h15, MS.h16, 6, 9, MS.h18, 'unknown_tokens', null, 1, null], // delta 3 but c5 has no cache_creation
  ['five_hour', 3, MS.h16, MS.h17, 9, 5, MS.h18, 'falling', null, 1, 100], // 9 -> 5 with the same reset; c6
  // weekly series A 40, B 46, C 49, D 49, E 51 (one reset instant, Oct 31)
  ['seven_day', 0, MS.h09, MS.h12, 40, 46, MS.oct31, 'usable', 6000000, 4, 600], // (46 - 40) x 1e6
  ['seven_day', 1, MS.h12, MS.h15, 46, 49, MS.oct31, 'usable', 3000000, 1, 50], // (49 - 46) x 1e6; c4 alone
  ['seven_day', 2, MS.h15, MS.h16, 49, 49, MS.oct31, 'flat', null, 1, null], // equal percentages; c5
  ['seven_day', 3, MS.h16, MS.h17, 49, 51, MS.oct31, 'usable', 2000000, 1, 100], // (51 - 49) x 1e6; c6 alone
];

// Shares per call: [message id, win, interval seq, share_micro]. Every call has one part (part_seq 0).
const SHARES = [
  ['msg_w01', 'five_hour', 0, 2000000], // 12,000,000 x 100 / 600
  ['msg_w02', 'five_hour', 0, 4000000], // 12,000,000 x 200 / 600
  ['msg_w10', 'five_hour', 0, 0], // weight 0 inside a usable interval
  ['msg_w03', 'five_hour', 0, 6000000], // 12,000,000 x 300 / 600; sum 2 + 4 + 0 + 6 = 12 points
  ['msg_w04', 'five_hour', 1, null], // reset
  ['msg_w05', 'five_hour', 2, null], // unknown tokens
  ['msg_w06', 'five_hour', 3, null], // falling
  ['msg_w01', 'seven_day', 0, 1000000], // 6,000,000 x 100 / 600
  ['msg_w02', 'seven_day', 0, 2000000], // 6,000,000 x 200 / 600
  ['msg_w10', 'seven_day', 0, 0],
  ['msg_w03', 'seven_day', 0, 3000000], // 6,000,000 x 300 / 600; sum 1 + 2 + 0 + 3 = 6 points
  ['msg_w04', 'seven_day', 1, 3000000], // 3,000,000 x 50 / 50
  ['msg_w05', 'seven_day', 2, null], // flat
  ['msg_w06', 'seven_day', 3, 2000000], // 2,000,000 x 100 / 100
];

// cost --by role,model rows, selected by header name:
// [role, model, calls, input, output, cache_read, cache_write, window_5h, window_7d]
const ROWS = [
  // c8 (8, 2, 0, 0) + c7 (10, 5, 0, 0); both outside every interval
  ['Explore', 'claude-haiku-5-5', '2', '18', '7', '0', '0', '?', '?'],
  // c2: 4,000,000 micro = 4.00 points; 2,000,000 = 2.00
  ['gsd-executor', 'claude-sonnet-5-5', '1', '120', '40', '30', '10', '4.00%', '2.00%'],
  // c5: no cache_creation field, unknown in both windows
  ['gsd-verifier', 'claude-sonnet-5-5', '1', '40', '10', '0', '?', '?', '?'],
  // c10 (0, 0, 0, 0) + c3 (200, 60, 30, 10); five-hour 0 + 6 = 6.00, weekly 0 + 3 = 3.00
  ['main', 'claude-haiku-5-5', '2', '200', '60', '30', '10', '6.00%', '3.00%'],
  // c1 (60, 20, 15, 5) + c4 (30, 10, 5, 5) + c6 (70, 20, 5, 5) = (160, 50, 25, 15);
  // five-hour: c4 reset and c6 falling, so ?; weekly 1 + 3 + 2 = 6.00
  ['main', 'claude-opus-5-5', '3', '160', '50', '25', '15', '?', '6.00%'],
];
// --by role: [role, window_5h, window_7d]; main weekly = c1 1 + c4 3 + c6 2 + c3 3 + c10 0 = 9.00
const BY_ROLE = [['Explore', '?', '?'], ['gsd-executor', '4.00%', '2.00%'], ['gsd-verifier', '?', '?'], ['main', '?', '9.00%']];
// --by model: haiku holds c8 and c7 (outside), opus holds c4 (reset) and c6 (falling) in the five-hour window,
// sonnet holds c5 (unknown); weekly opus 1 + 3 + 2 = 6.00
const BY_MODEL = [['claude-haiku-5-5', '?', '?'], ['claude-opus-5-5', '?', '6.00%'], ['claude-sonnet-5-5', '?', '?']];

export const EXPECTED_WINDOW = Object.freeze({
  snapshotColumns: SNAPSHOT_COLUMNS,
  snapshotRows: SNAPSHOT_ROWS,
  limitRowsE: LIMIT_ROWS_E,
  limitRowsD: LIMIT_ROWS_D,
  intervals: INTERVALS,
  shares: SHARES,
  rows: ROWS,
  byRole: BY_ROLE,
  byModel: BY_MODEL,
  // Five-hour deltas sum: 2,000,000 + 4,000,000 + 0 + 6,000,000 = 12,000,000; weekly 1 + 2 + 0 + 3 = 6,
  // 3, and 2 points (6,000,000; 3,000,000; 2,000,000).
  usableDeltas: { five_hour: [12000000], seven_day: [6000000, 3000000, 2000000] },
  header: /^window usage: latest recorded session 5% \(resets 2026-10-26T18:00:00Z\), weekly 51% \(resets 2026-10-31T00:00:00Z\), weekly_opus 12% \(resets 2026-10-31T00:00:00Z\); recorded 2026-10-26T17:00:00Z via claude-json-cache \(measured\), age (<1h|\d+h)$/,
  labels: 'labels: tokens=transcript notional_usd=derived window_share=estimated; ? means unknown (label unavailable), never zero',
  // snapshots 5 (A B C E cache, D transcript); five-hour intervals usable 1, reset 1, falling 1, unknown 1;
  // weekly usable 3, flat 1; parts with a share: five-hour c1 c2 c10 c3 = 4 of 9, weekly c1 c2 c10 c3 c4 c6 = 6 of 9
  footer: 'window: weights=input:1,output:1,cache_read:1,cache_creation:1 snapshots=5 ' +
    'intervals_5h=usable:1,reset:1,falling:1,unknown_tokens:1 intervals_7d=usable:3,flat:1 ' +
    'parts_5h=4/9 parts_7d=6/9 window_conservation=OK',
  noSnapshotFooter: (n) => `window: weights=input:1,output:1,cache_read:1,cache_creation:1 snapshots=0 intervals_5h=none intervals_7d=none parts_5h=0/${n} parts_7d=0/${n} window_conservation=OK`,
});
