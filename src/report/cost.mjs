// loadCostReport: derived.db parts as Measures, grouped by the chosen dimensions. Numbers reach a
// renderer only through here, as plain data.
//
// --by dimensions come from a fixed whitelist: each name maps to a fixed column expression, and no user
// text ever reaches SQL (T-01-31). Plan 01-08 added effort, day, session and repo.
//
// Period and zone (plan 01-08, D-07): `period` is a plain object (src/measure/period.mjs) whose bounds are integer
// epoch milliseconds compared with api_call.ts_ms as bound parameters; the lower bound is inclusive and the upper
// bound exclusive. The day dimension calls the SQL function rs_local_day, registered on the read-only connection
// with the zone captured in a closure; nothing is interpolated. Each section ends with one total row computed by an
// independent aggregate (tokens from the parts, dollars from the call-level cost, windows from the window shares) and
// a check that the displayed rows sum to it (src/measure/totals.mjs).
//
// Sections (plan 01-07, D-07, D-12): rows never mix token sources. `rows` are the transcript-sourced calls
// (token_label transcript: transcript_only and joined calls), `otelRows` the otel_only calls whose role is not a
// harness role, `harnessRows` the otel_only calls of the six pure-harness sources; each is grouped by the same
// dimensions. Counts, totals, pricing and notional describe the transcript calls only; the window figures stay
// over every part; the OTel figures come from src/report/otel.mjs.
import { openDerivedReadOnly } from '../db.mjs';
import { fromAggregate } from '../measure/measure.mjs';
import { allPeriod, localDay, resolveTz } from '../measure/period.mjs';
import { buildRowKey, buildTotalKey } from '../measure/rowkey.mjs';
import { checkTotals } from '../measure/totals.mjs';
import { loadFreshness } from './freshness.mjs';
import { checkConservation, checkCostConservation, checkWindowConservation } from '../derive/conservation.mjs';
import { INTERVAL_STATUSES, WINDOW_WEIGHTS_TEXT } from '../derive/window.mjs';
import { loadOtelReport } from './otel.mjs';
import { selectedPopulations } from './population.mjs';
import { LOW_EVIDENCE_N } from './tier.mjs';
import { loadUnitCosts } from './unit-cost.mjs';
import { CALL_FILTERS, describeFilters, filterSqlFor, repoFilterSql, valueFilterSql } from './filters.mjs';

const NANO_PER_USD = 1e9;
const MICRO_PER_POINT = 1e6;
const HOUR_MS = 3600000;

// Plan 02-08 (RPT-01, D-13): the tier, unit and framework of a call are attributes of its scope's mode-medium attribution row
// (strict, the same mode `evidence ROW_KEY` lists). Each is a correlated scalar subquery over the call alias c: the unit
// attribute when the scope is attributed, `(<bucket>)` for the two unattributed buckets, NULL (printed ?) when the unit has
// no value (a tier-less unit) or the scope has no row. The guard c.token_label = 'transcript' is part of every expression: an
// otel-only or harness call carries its session id and an agent id of '' and would otherwise match a main-thread scope row.
// A tier inferred from probe files shows as `<letter>-inferred`, never folded into the plain letter (TIER-02). Fixed text only.
const SCOPE_ROW = "sa.session_id = c.owner_session_id AND sa.agent_id = c.owner_agent_id AND sa.link_confidence = 'medium'";
const ATTRIBUTED_UNIT = `(SELECT sa.unit_key FROM scope_attribution sa WHERE ${SCOPE_ROW} AND sa.bucket = 'attributed')`;
const BUCKET_NAME = `(SELECT '(' || sa.bucket || ')' FROM scope_attribution sa WHERE ${SCOPE_ROW} AND sa.bucket <> 'attributed')`;
const unitAttr = (expr) => `CASE WHEN c.token_label = 'transcript' THEN coalesce((SELECT ${expr} FROM unit u WHERE u.unit_key = ${ATTRIBUTED_UNIT}), ${BUCKET_NAME}) END`;
const UNIT_ATTR_SQL = Object.freeze({
  tier: unitAttr("CASE WHEN u.tier IS NOT NULL AND u.tier_signal = 'probes-skipped' THEN u.tier || '-inferred' ELSE u.tier END"),
  unit: unitAttr('u.unit_key'),
  framework: unitAttr('u.framework'),
  population: unitAttr('u.population'),
});

// column: the fixed SQL expression; header: the table heading; level: call (a column of api_call) or part (a column of
// api_call_part, so a call with advisor parts appears under each of its models); labels: the source label of the
// dimension for main rows and for otel and harness rows (ASCII constants, never taken from data).
export const BY_DIMENSIONS = Object.freeze(Object.assign(Object.create(null), {
  role: Object.freeze({ column: 'c.role', header: 'role', level: 'call', labels: Object.freeze({ main: 'derived', side: 'otel' }) }),
  model: Object.freeze({ column: 'p.model', header: 'model', level: 'part', labels: Object.freeze({ main: 'transcript', side: 'otel' }) }),
  // An advisor iteration carries no effort of its own (no effort key on it in the transcript), so an advisor part is NULL (printed ?)
  // and a message part keeps the effort of its call; the advisor tokens and dollars stay on the advisor model.
  effort: Object.freeze({ column: "CASE WHEN p.kind = 'advisor' THEN NULL ELSE c.effort END", header: 'effort', level: 'part', labels: Object.freeze({ main: 'derived', side: 'otel' }) }),
  day: Object.freeze({ column: 'rs_local_day(c.ts_ms)', header: 'day', level: 'call', labels: Object.freeze({ main: 'derived', side: 'derived' }) }),
  session: Object.freeze({ column: 'c.owner_session_id', header: 'session', level: 'call', labels: Object.freeze({ main: 'transcript', side: 'otel' }) }),
  repo: Object.freeze({ column: 'c.repo', header: 'repo', level: 'call', labels: Object.freeze({ main: 'reconstructed', side: 'unavailable' }) }),
  // Plan 03-04 (T-03-25, D-15): the population of the unit a call is attributed to (forward or reconstructed). A forward row's tier,
  // unit and framework are recorded where the ledger gave them, so those three labels are `derived`, not `reconstructed` (ADR-0004).
  population: Object.freeze({ column: UNIT_ATTR_SQL.population, header: 'population', level: 'call', labels: Object.freeze({ main: 'derived', side: 'unavailable' }) }),
  tier: Object.freeze({ column: UNIT_ATTR_SQL.tier, header: 'tier', level: 'call', labels: Object.freeze({ main: 'derived', side: 'unavailable' }) }),
  unit: Object.freeze({ column: UNIT_ATTR_SQL.unit, header: 'unit', level: 'call', labels: Object.freeze({ main: 'derived', side: 'unavailable' }) }),
  framework: Object.freeze({ column: UNIT_ATTR_SQL.framework, header: 'framework', level: 'call', labels: Object.freeze({ main: 'derived', side: 'unavailable' }) }),
  // The call runtime rule (plan 02-08): every source rigorscope reads today is written by Claude Code, so every call is
  // `claude-code`. A later source of another runtime replaces this literal with a column of api_call.
  runtime: Object.freeze({ column: "'claude-code'", header: 'runtime', level: 'call', labels: Object.freeze({ main: 'reconstructed', side: 'reconstructed' }) }),
}));

export const DEFAULT_BY = Object.freeze(['role', 'model']);

// Plan 02-08 (RPT-01, D-19): the six filters of `cost`, each a function of the parsed values building a fragment over the call
// alias c. repo goes through the fixed subquery of repoFilterSql over c.repo_key (a name selects every key of that name, a key
// one, ? the calls with no repo); model, role and runtime act on the call (role ? is the stored unknown, role_source
// unavailable, as in `units`); tier and framework keep main-section calls whose mode-medium scope is attributed to a matching
// unit, so otel-only and harness rows are empty under them. The runtime rule: every call is claude-code, so a list holding it
// selects every call and any other list none.
const ATTRIBUTED_TO_UNIT = (inner) => ({
  sql: `EXISTS (SELECT 1 FROM scope_attribution sa JOIN unit u ON u.unit_key = sa.unit_key WHERE ${SCOPE_ROW} AND sa.bucket = 'attributed' `
    + `AND c.token_label = 'transcript' AND ${inner.sql})`,
  params: inner.params,
});
// The tier filter (review 02-08 WR-04): a letter selects the units of that tier letter, and a tier inferred from probe files
// (tier_signal probes-skipped, TIER-02) is not the plain letter, so it is left out unless includeInferred (`cost --include-inferred`,
// the flag `tier` has). `?` (tier NULL, signal none) is unaffected. Only this filter changes: the `--by tier` dimension keeps its
// `<letter>-inferred` rows so the rows still sum to the total row.
function tierFilterSql(values, includeInferred) {
  const letters = values.filter((v) => v !== null);
  const or = [];
  const params = [];
  if (letters.length > 0) {
    or.push(`(u.tier IN (${letters.map(() => '?').join(', ')})${includeInferred ? '' : " AND u.tier_signal <> 'probes-skipped'"})`);
    params.push(...letters);
  }
  if (values.some((v) => v === null)) or.push('u.tier IS NULL');
  return { sql: `(${or.join(' OR ')})`, params };
}
export const COST_FILTER_COLUMNS = Object.freeze({
  repo: (values) => repoFilterSql('c.repo_key', values),
  model: (values) => valueFilterSql('c.model', values),
  role: (values) => valueFilterSql('c.role', values, CALL_FILTERS.role.unknownSql),
  runtime: (values) => ({ sql: values.includes('claude-code') ? '1 = 1' : '1 = 0', params: [] }),
  tier: (values, { includeInferred = false } = {}) => ATTRIBUTED_TO_UNIT(tierFilterSql(values, includeInferred === true)),
  framework: (values) => ATTRIBUTED_TO_UNIT(valueFilterSql('u.framework', values)),
});
// -> { sql, params } over the call alias c for the parsed filters, or null with none. `loadEvidence` takes the same fragment.
// Plan 03-04: `population` (forward or reconstructed; `all` adds nothing) filters unit-attributed calls the way --tier does.
export const costFilterWhere = (filters, { includeInferred = false, population = 'all' } = {}) => {
  const base = filterSqlFor(filters, COST_FILTER_COLUMNS, { includeInferred });
  if (population === 'all') return base;
  const pop = ATTRIBUTED_TO_UNIT(valueFilterSql('u.population', [population]));
  return base === null ? pop : { sql: `(${base.sql}) AND ${pop.sql}`, params: [...base.params, ...pop.params] };
};



const BY_MESSAGE = 'the --by value must be a comma-separated list of distinct names from: role, model, effort, day, session, repo, population, tier, unit, framework, runtime (no spaces)';

// Splits on commas with no trimming; rejects empty, unknown, duplicate and padded names with one fixed
// message that never echoes the input.
export function parseBy(text) {
  if (typeof text !== 'string' || text.length === 0) throw new RangeError(BY_MESSAGE);
  const names = text.split(',');
  const seen = new Set();
  for (const n of names) {
    if (!Object.hasOwn(BY_DIMENSIONS, n) || seen.has(n)) throw new RangeError(BY_MESSAGE);
    seen.add(n);
  }
  return names;
}

// Plan 03-04 (T-03-25): a unit-level dimension (tier, unit, framework) always comes with `population` first, so no row merges
// forward and reconstructed calls.
const UNIT_DIMS = Object.freeze(['tier', 'unit', 'framework']);
export const withPopulation = (names) => (names.some((n) => UNIT_DIMS.includes(n)) && !names.includes('population') ? ['population', ...names] : names);

function checkedBy(by) {
  if (!Array.isArray(by) || by.length === 0) throw new RangeError(BY_MESSAGE);
  return parseBy(by.join(','));
}

// Report class name -> api_call_part column, in the fixed footer order.
const TOTAL_CLASSES = [
  ['input', 'input_tokens'], ['output', 'output_tokens'], ['cache_read', 'cache_read'],
  ['cache_write', 'cache_creation'], ['cache_5m', 'cache_5m'], ['cache_1h', 'cache_1h'],
];
const CELL_CLASSES = [['input', 'input_tokens'], ['output', 'output_tokens'], ['cacheRead', 'cache_read'], ['cacheWrite', 'cache_creation']];

// One grouped query over parts. The CASE guard makes a group with any NULL member unknown: plain sum()
// skips NULLs and would report a partial total as if it were complete. The same guard covers the notional
// cost (cost_nano, plan 01-05): one unpriced part makes the group's dollar cell unknown, never its known sum. calls counts distinct calls with
// a part in the group, so a call with advisor parts appears under each model it has a part for. A NULL
// model groups together and sorts last (NULLS LAST on every dimension).
// The three sections: a fixed WHERE clause and the labels of their token and dollar cells.
const SECTIONS = Object.freeze({
  main: Object.freeze({ where: "c.token_label = 'transcript'", tokens: 'transcript', usd: 'derived' }),
  otel: Object.freeze({ where: "c.section = 'otel'", tokens: 'otel', usd: 'otel' }),
  harness: Object.freeze({ where: "c.section = 'harness'", tokens: 'otel', usd: 'otel' }),
});

// The period filter: bound parameters on the integer ts_ms (lower bound inclusive, upper bound exclusive). A call with
// a NULL ts_ms never satisfies a comparison, so a bounded period drops it (and callsTsUnknown counts it).
export function rangeFragment(period) {
  const parts = [];
  const params = [];
  if (period?.sinceMs !== null && period?.sinceMs !== undefined) { parts.push(' AND c.ts_ms >= ?'); params.push(period.sinceMs); }
  if (period?.untilMs !== null && period?.untilMs !== undefined) { parts.push(' AND c.ts_ms < ?'); params.push(period.untilMs); }
  return { sql: parts.join(''), params, bounded: parts.length > 0 };
}

// The day dimension: a deterministic SQL function over ts_ms with the zone captured in a closure. A zone offset
// changes only on whole minutes, so memoizing by whole minute is exact.
export function registerDayFunction(db, tz) {
  const memo = new Map();
  db.function('rs_local_day', { deterministic: true }, (ms) => {
    if (typeof ms !== 'number') return null;
    const minute = Math.floor(ms / 60000);
    let day = memo.get(minute);
    if (day === undefined) {
      day = localDay(minute * 60000, tz);
      memo.set(minute, day);
    }
    return day;
  });
}

const rawCols = (alias, col, name) => `sum(${alias}${col}) AS ${name}_raw, count(${alias}${col}) AS ${name}_known`;
const CELL_RAW = CELL_CLASSES.map(([, col]) => rawCols('p.', col, col)).join(',\n  ');

// The fixed WHERE fragment of each section, for the evidence loader.
export const SECTION_WHERE = Object.freeze(Object.fromEntries(Object.entries(SECTIONS).map(([name, v]) => [name, v.where])));

function costSql(by, section, range) {
  const dims = by.map((name, i) => `${BY_DIMENSIONS[name].column} AS d${i}`);
  const exprs = by.map((name) => BY_DIMENSIONS[name].column);
  const cells = CELL_CLASSES.map(([, col]) => `
  CASE WHEN count(p.${col}) = count(*) THEN sum(p.${col}) END AS ${col}_sum, count(p.${col}) AS ${col}_known`).join(',');
  // Window shares (plan 01-06): one LEFT JOIN per window, the window name a fixed literal; the primary key
  // (call_key, part_seq, win) keeps one row per part, and the same guard makes a group with any part outside
  // every interval, or in an interval that is not usable, unknown (window_5h, window_7d).
  return `
SELECT ${dims.join(', ')}, count(DISTINCT p.call_key) AS calls, count(*) AS n,${cells},
  CASE WHEN count(p.cost_nano) = count(*) THEN sum(p.cost_nano) END AS cost_sum, count(p.cost_nano) AS cost_known,
  max(p.cost_floor) AS cost_floor,
  CASE WHEN count(w5.share_micro) = count(*) THEN sum(w5.share_micro) END AS w5_sum, count(w5.share_micro) AS w5_known,
  CASE WHEN count(w7.share_micro) = count(*) THEN sum(w7.share_micro) END AS w7_sum, count(w7.share_micro) AS w7_known,
  ${CELL_RAW}, sum(p.cost_nano) AS cost_raw, sum(w5.share_micro) AS w5_raw, sum(w7.share_micro) AS w7_raw
FROM api_call_part p
JOIN api_call c ON c.call_key = p.call_key
LEFT JOIN api_call_part_window w5 ON w5.call_key = p.call_key AND w5.part_seq = p.part_seq AND w5.win = 'five_hour'
LEFT JOIN api_call_part_window w7 ON w7.call_key = p.call_key AND w7.part_seq = p.part_seq AND w7.win = 'seven_day'
WHERE ${SECTIONS[section].where}${range.sql}
GROUP BY ${exprs.join(', ')}
ORDER BY ${exprs.map((e) => `${e} ASC NULLS LAST`).join(', ')}`;
}

// The total row of a section: one aggregate with no grouping and a different shape from the grouped rows, so the
// check that the rows sum to it can fail. Tokens come straight from the parts; the known dollar sum is the call-level
// cost (api_call.cost_nano) with the known part costs of a call whose cost is unknown; the window shares come from
// api_call_part_window without the per-window LEFT JOINs of the rows.
const TOTAL_TOKENS_SQL = (section, range) => `
SELECT count(DISTINCT p.call_key) AS calls, count(*) AS n, ${CELL_CLASSES.map(([, col]) => rawCols('p.', col, col)).join(', ')},
  count(p.cost_nano) AS cost_known, max(p.cost_floor) AS cost_floor
FROM api_call_part p JOIN api_call c ON c.call_key = p.call_key
WHERE ${SECTIONS[section].where}${range.sql}`;
const TOTAL_COST_SQL = (section, range) => `
SELECT sum(CASE WHEN c.cost_nano IS NOT NULL THEN c.cost_nano
                ELSE (SELECT sum(q.cost_nano) FROM api_call_part q WHERE q.call_key = c.call_key) END) AS cost_raw
FROM api_call c WHERE ${SECTIONS[section].where}${range.sql}`;
const TOTAL_WINDOW_SQL = (section, range) => `
SELECT sum(pw.share_micro) AS raw, count(pw.share_micro) AS known
FROM api_call_part_window pw JOIN api_call c ON c.call_key = pw.call_key
WHERE pw.win = ? AND ${SECTIONS[section].where}${range.sql}`;

// Pricing counts for the footer: parts by price status, floor parts, the known cost sum, and the calls
// that carried server_tool_use (flag 1), whose server_tool_use count is unknown (flag NULL, plan 01-12) or had no
// iteration detail. count() of a CASE is a real count (0 when none).
// Plan 01-07: restricted to the transcript calls (the otel_only parts carry OTel cost, never a table price).
const PRICING_SQL = (range) => `
SELECT count(CASE WHEN p.price_status = 'priced' THEN 1 END) AS priced_parts,
       count(CASE WHEN p.price_status <> 'priced' THEN 1 END) AS unpriced_parts,
       count(CASE WHEN p.price_status = 'unpriced_model' THEN 1 END) AS unpriced_model,
       count(CASE WHEN p.price_status = 'unknown_tokens' THEN 1 END) AS unknown_tokens,
       count(CASE WHEN p.price_status = 'unknown_modifier' THEN 1 END) AS unknown_modifier,
       count(CASE WHEN p.price_status = 'no_table' THEN 1 END) AS no_table,
       count(CASE WHEN p.cost_floor = 1 THEN 1 END) AS floor_parts,
       sum(p.cost_nano) AS known_nano, count(p.cost_nano) AS known_parts
  FROM api_call_part p JOIN api_call c ON c.call_key = p.call_key
 WHERE c.token_label = 'transcript'${range.sql}`;
const PRICING_CALLS_SQL = (range) => `
SELECT count(CASE WHEN c.server_tool_use = 1 THEN 1 END) AS server_tool_use_calls,
       count(CASE WHEN c.server_tool_use IS NULL THEN 1 END) AS server_tool_use_unknown_calls,
       count(CASE WHEN c.price_basis = 'top_level_only' THEN 1 END) AS top_level_only_calls
  FROM api_call c
 WHERE c.token_label = 'transcript'${range.sql}`;

// The counts line over a bounded period (plan 01-08): recomputed from the transcript calls in the period.
// synthetic_skipped stays the global derive count (a skipped synthetic line has no call and no time).
const COUNTS_SQL = (range) => `
SELECT count(*) AS calls, coalesce(sum(c.occurrences), 0) - count(*) AS duplicates_collapsed,
       count(CASE WHEN c.price_basis = 'top_level_only' THEN 1 END) AS top_level_only,
       count(CASE WHEN c.iter_mismatch = 1 THEN 1 END) AS iteration_mismatch,
       count(CASE WHEN c.iter_unknown_type = 1 THEN 1 END) AS unknown_iteration_type,
       (SELECT count(*) FROM api_call_part p JOIN api_call c2 ON c2.call_key = p.call_key
         WHERE c2.token_label = 'transcript'${range.sql.replace(/\bc\./g, 'c2.')}) AS parts
  FROM api_call c
 WHERE c.token_label = 'transcript'${range.sql}`;

// The otel-only line over a bounded period: the same figures as src/report/otel.mjs, restricted to the period.
const OTEL_ONLY_SCOPED_SQL = (range) => `
SELECT count(DISTINCT c.call_key) AS calls,
       count(DISTINCT CASE WHEN c.section = 'harness' THEN c.call_key END) AS harness_calls,
       count(p.call_key) AS parts,
       ${CELL_CLASSES.map(([, col]) => `sum(p.${col}) AS ${col}_sum, count(p.call_key) - count(p.${col}) AS ${col}_unknown`).join(',\n       ')},
       sum(p.cost_nano) AS cost_sum, count(p.call_key) - count(p.cost_nano) AS cost_unknown
  FROM api_call c LEFT JOIN api_call_part p ON p.call_key = c.call_key
 WHERE c.join_state = 'otel_only'${range.sql}`;

const TS_UNKNOWN_SQL = 'SELECT count(*) AS n FROM api_call WHERE ts_ms IS NULL';

// Window footer and header data (plan 01-06).
const INTERVAL_COUNTS_SQL = 'SELECT win, status, count(*) AS n FROM window_interval GROUP BY win, status';
const PARTS_KNOWN_SQL = 'SELECT win, count(share_micro) AS k FROM api_call_part_window GROUP BY win';
const PARTS_TOTAL_SQL = 'SELECT count(*) AS n FROM api_call_part';
const LATEST_SQL = 'SELECT * FROM usage_latest WHERE id = 1';
// The windows of the header line, in print order: [column prefix, printed name].
const HEADER_WINDOWS = [['five_hour', 'session'], ['seven_day', 'weekly'], ['seven_day_opus', 'weekly_opus'], ['seven_day_sonnet', 'weekly_sonnet']];

const pointsOf = (micro) => (micro === null ? null : micro / MICRO_PER_POINT);

function windowUsageOf(db, now) {
  const r = db.prepare(LATEST_SQL).get();
  if (!r) return null;
  const windows = [];
  for (const [col, printed] of HEADER_WINDOWS) {
    if (r[`${col}_pct`] !== null) windows.push({ name: printed, pct: r[`${col}_pct`], resetsMs: r[`${col}_resets_ms`] });
  }
  const nowMs = now().getTime();
  return {
    source: r.source, label: r.label, fetchedAtMs: r.fetched_at_ms, windows,
    ageHours: Math.floor(Math.max(0, nowMs - r.fetched_at_ms) / HOUR_MS),
  };
}

function windowFooterOf(db, state) {
  const intervals = { five_hour: {}, seven_day: {} };
  for (const r of db.prepare(INTERVAL_COUNTS_SQL).all()) intervals[r.win][r.status] = r.n;
  const order = (byStatus) => INTERVAL_STATUSES.filter((s) => byStatus[s] > 0).map((s) => ({ status: s, n: byStatus[s] }));
  const total = db.prepare(PARTS_TOTAL_SQL).get().n;
  const known = { five_hour: 0, seven_day: 0 };
  for (const r of db.prepare(PARTS_KNOWN_SQL).all()) known[r.win] = r.k;
  const check = checkWindowConservation(db);
  return {
    weights: state?.window_weights ?? WINDOW_WEIGHTS_TEXT,
    snapshots: state?.usage_snapshots ?? null,
    intervals: { five_hour: order(intervals.five_hour), seven_day: order(intervals.seven_day) },
    parts: { five_hour: { known: known.five_hour, total }, seven_day: { known: known.seven_day, total } },
    conservation: check.ok ? 'OK' : 'VIOLATED',
  };
}

const TOTALS_SQL = (range) => `SELECT ${TOTAL_CLASSES.map(([, col]) => `sum(p.${col}) AS ${col}_sum, count(*) - count(p.${col}) AS ${col}_unknown`).join(', ')}
  FROM api_call_part p JOIN api_call c ON c.call_key = p.call_key WHERE c.token_label = 'transcript'${range.sql}`;

// The raw known sum and unknown count of a displayed column, for the totals check (integers: tokens, nano-dollars,
// micro-points). A missing aggregate (a group with no known member) is a null sum.
const sumsOf = (r, n) => ({
  input: { sum: r.input_tokens_raw, unknown: n - r.input_tokens_known },
  output: { sum: r.output_tokens_raw, unknown: n - r.output_tokens_known },
  cache_read: { sum: r.cache_read_raw, unknown: n - r.cache_read_known },
  cache_write: { sum: r.cache_creation_raw, unknown: n - r.cache_creation_known },
  notional_usd: { sum: r.cost_raw, unknown: n - r.cost_known },
  window_5h: { sum: r.w5_raw, unknown: n - r.w5_known },
  window_7d: { sum: r.w7_raw, unknown: n - r.w7_known },
});

function measuresOf(r, section) {
  const { tokens, usd } = SECTIONS[section];
  const out = { calls: r.calls };
  for (const [key, col] of CELL_CLASSES) {
    out[key] = fromAggregate({ sum: r[`${col}_sum`], known: r[`${col}_known`], n: r.n, label: tokens });
  }
  // Notional dollars (plan 01-05): known only when every part of the group is priced. For the otel and harness
  // sections (plan 01-07) the dollars are OTel's measured cost, labeled otel.
  out.notionalUsd = fromAggregate({
    sum: r.cost_sum === null ? null : r.cost_sum / NANO_PER_USD, known: r.cost_known, n: r.n, label: usd,
  });
  out.notionalFloor = r.cost_floor === 1;
  // Window shares (plan 01-06): estimated percentage points, known only when every part of the group has one.
  out.window_5h = fromAggregate({ sum: pointsOf(r.w5_sum), known: r.w5_known, n: r.n, label: 'estimated' });
  out.window_7d = fromAggregate({ sum: pointsOf(r.w7_sum), known: r.w7_known, n: r.n, label: 'estimated' });
  return out;
}

function rowsOf(db, dims, section, range) {
  const side = section === 'main' ? 'main' : 'side';
  return db.prepare(costSql(dims, section, range)).all(...range.params).map((r) => {
    const row = {};
    dims.forEach((name, i) => { row[name] = r[`d${i}`]; });
    Object.assign(row, measuresOf(r, section));
    row.key = buildRowKey(section, dims.map((name, i) => [name, r[`d${i}`]]));
    row.dims = dims.map((name, i) => ({ name, value: r[`d${i}`], label: BY_DIMENSIONS[name].labels[side] }));
    row.sums = sumsOf(r, r.n);
    return row;
  });
}

// The total row of a section, or null when the section has no part in the period.
function totalOf(db, section, range) {
  const t = db.prepare(TOTAL_TOKENS_SQL(section, range)).get(...range.params);
  if (t.n === 0) return null;
  const cost = db.prepare(TOTAL_COST_SQL(section, range)).get(...range.params);
  const win = (name) => db.prepare(TOTAL_WINDOW_SQL(section, range)).get(name, ...range.params);
  const w5 = win('five_hour');
  const w7 = win('seven_day');
  const allKnown = (raw, known) => (known === t.n ? raw : null);
  const r = {
    calls: t.calls, n: t.n, cost_floor: t.cost_floor, cost_known: t.cost_known, cost_raw: cost.cost_raw,
    cost_sum: allKnown(cost.cost_raw, t.cost_known), w5_raw: w5.raw, w5_known: w5.known, w5_sum: allKnown(w5.raw, w5.known),
    w7_raw: w7.raw, w7_known: w7.known, w7_sum: allKnown(w7.raw, w7.known),
  };
  for (const [, col] of CELL_CLASSES) {
    r[`${col}_raw`] = t[`${col}_raw`];
    r[`${col}_known`] = t[`${col}_known`];
    r[`${col}_sum`] = allKnown(t[`${col}_raw`], t[`${col}_known`]);
  }
  const row = { ...measuresOf(r, section), key: buildTotalKey(section), dims: [], sums: sumsOf(r, t.n) };
  return row;
}

const checkOf = (rows, total) => checkTotals({ rows: rows.map((r) => r.sums), total: total ? total.sums : null });

// Pure labels for the by-labels line: one label per named dimension, for main rows and for otel and harness rows.
function byLabelsOf(dims, hasSide) {
  const pick = (k) => Object.fromEntries(dims.map((d) => [d, BY_DIMENSIONS[d].labels[k]]));
  return { main: pick('main'), side: hasSide ? pick('side') : null };
}

function scopedOtelOnly(db, range) {
  const o = db.prepare(OTEL_ONLY_SCOPED_SQL(range)).get(...range.params);
  const sumOf = (sum) => (o.parts === 0 ? 0 : sum);
  return {
    calls: o.calls,
    harness_calls: o.harness_calls,
    classes: CELL_CLASSES.map(([, col], i) => ({ class: ['input', 'output', 'cache_read', 'cache_write'][i], sum: sumOf(o[`${col}_sum`]), unknown: o[`${col}_unknown`] })),
    cost: { sum: sumOf(o.cost_sum), unknown: o.cost_unknown },
  };
}

export function loadCostReport({
  home, by = DEFAULT_BY, now = () => new Date(), period = allPeriod(), tz, clockFixed = false, filters = null, includeInferred = false,
  population = 'all', withPopulations = false,
}) {
  const dims = withPopulation(checkedBy([...by]));
  const zone = tz ?? period?.tz ?? resolveTz();
  const periodRange = rangeFragment(period);
  // The filters limit every figure the period limits (rows, totals, counts, pricing, notional, otel-only), so they ride on the
  // same fragment; `bounded` then selects the scoped counts and otel-only queries, and `periodBounded` keeps the unknown-time
  // count tied to the period alone.
  const filterWhere = costFilterWhere(filters, { includeInferred, population });
  const range = filterWhere === null
    ? { ...periodRange, periodBounded: periodRange.bounded }
    : {
      sql: `${periodRange.sql} AND (${filterWhere.sql})`, params: [...periodRange.params, ...filterWhere.params], bounded: true, periodBounded: periodRange.bounded,
    };
  const nowMs = now().getTime();
  const db = openDerivedReadOnly({ home });
  try {
    registerDayFunction(db, zone);
    const state = db.prepare('SELECT * FROM derive_state WHERE id = 1').get();
    const rows = rowsOf(db, dims, 'main', range);
    const otelRows = rowsOf(db, dims, 'otel', range);
    const harnessRows = rowsOf(db, dims, 'harness', range);
    const sideRows = [...otelRows, ...harnessRows];
    const totalRow = totalOf(db, 'main', range);
    const otelTotalRow = totalOf(db, 'otel', range);
    const harnessTotalRow = totalOf(db, 'harness', range);
    const totalsCheck = {};
    if (rows.length > 0) totalsCheck.main = checkOf(rows, totalRow);
    if (otelRows.length > 0) totalsCheck.otel = checkOf(otelRows, otelTotalRow);
    if (harnessRows.length > 0) totalsCheck.harness = checkOf(harnessRows, harnessTotalRow);
    const callsTsUnknown = range.periodBounded ? db.prepare(TS_UNKNOWN_SQL).get().n : 0;
    const otel = loadOtelReport(db);
    const t = db.prepare(TOTALS_SQL(range)).get(...range.params);
    const conservation = checkConservation(db);
    const costCheck = checkCostConservation(db);
    const pr = db.prepare(PRICING_SQL(range)).get(...range.params);
    const pc = db.prepare(PRICING_CALLS_SQL(range)).get(...range.params);
    let counts = {
      calls: conservation.counts.calls,
      parts: conservation.counts.parts,
      duplicates_collapsed: conservation.counts.duplicates_collapsed,
      synthetic_skipped: conservation.counts.synthetic_skipped,
      top_level_only: conservation.counts.top_level_only,
      iteration_mismatch: conservation.counts.iteration_mismatch,
      unknown_iteration_type: conservation.counts.unknown_iteration_type,
    };
    let otelOnly = otel.otelOnly;
    if (range.bounded) {
      const k = db.prepare(COUNTS_SQL(range)).get(...range.params, ...range.params);
      counts = { ...counts, ...k };
      otelOnly = scopedOtelOnly(db, range);
    }
    // Plan 03-04 (J1): one block per selected population when the population dimension or flag is used, else null.
    let populations = null;
    let populationSamples = null;
    if (dims.includes('population') || population !== 'all' || withPopulations === true) {
      const rw = range.sql.trim() === '' ? null : { sql: range.sql.replace(/^\s*AND\s+/, ''), params: range.params };
      const costs = loadUnitCosts(db, { mode: 'medium', callWhere: rw });
      const popOf = new Map(db.prepare('SELECT unit_key, population FROM unit').all().map((r) => [r.unit_key, r.population]));
      const totals = new Map(db.prepare('SELECT population, count(*) AS n FROM unit GROUP BY +population').all().map((r) => [r.population, r.n]));
      populations = selectedPopulations(population).map((pop) => {
        const costed = [...costs].filter(([k, c]) => popOf.get(k) === pop && c.calls > 0 && c.tokens !== null && c.tokens !== undefined).length;
        return { population: pop, units: totals.get(pop) ?? 0, costed, low_evidence: costed < LOW_EVIDENCE_N };
      });
      // Plan 03-05 (J6): up to five costed unit keys per population, bytewise order, for the decision sheet's evidence ids. Taken from
      // the same `costs` map (no second query); the document renderers do not read this field, so no default output changes.
      if (withPopulations === true) {
        const byteCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
        populationSamples = Object.fromEntries(selectedPopulations(population).map((pop) => [pop,
          [...costs].filter(([k, c]) => popOf.get(k) === pop && c.calls > 0 && c.tokens !== null && c.tokens !== undefined)
            .map(([k]) => k).sort(byteCompare).slice(0, 5)]));
      }
    }
    return {
      by: dims,
      population,
      populations,
      populationSamples,
      filters,
      includeInferred: includeInferred === true,
      filterText: describeFilters(filters),
      period,
      tz: zone,
      clockFixed,
      asOfMs: nowMs,
      freshnessCheck: loadFreshness({ home, nowMs }),
      freshness: {
        newestRecordUtc: state?.newest_record_utc ?? null,
        lastRunEndUtc: state?.last_run_end_utc ?? null,
        rows: state?.api_call_rows ?? null,
      },
      rows,
      otelRows,
      harnessRows,
      totalRow,
      otelTotalRow,
      harnessTotalRow,
      totalsCheck,
      callsTsUnknown,
      byLabels: byLabelsOf(dims, sideRows.length > 0),
      conservation: {
        ok: conservation.ok,
        violations: conservation.violations.map((v) => (v.column
          ? {
            class: TOTAL_CLASSES.find(([, col]) => col === v.column)[0], roles: v.roles, models: v.models, total: v.total, store: v.store,
            sections: v.sections,
          }
          : { name: v.name, n: v.n })),
      },
      counts,
      totals: TOTAL_CLASSES.map(([name, col]) => ({ class: name, sum: t[`${col}_sum`], unknown: t[`${col}_unknown`] })),
      labels: {
        notional_usd: rows.some((r) => r.notionalUsd.value !== null) ? 'derived' : 'unavailable',
        window_share: rows.some((r) => r.window_5h.value !== null || r.window_7d.value !== null) ? 'estimated' : 'unavailable',
        // Plan 01-07: the second labels line, only when otel or harness rows exist.
        otel_rows: sideRows.length === 0 ? null : {
          tokens: 'otel',
          notional_usd: 'otel',
          window_share: sideRows.some((r) => r.window_5h.value !== null || r.window_7d.value !== null) ? 'estimated' : 'unavailable',
        },
      },
      windowUsage: windowUsageOf(db, now),
      window: windowFooterOf(db, state),
      pricing: {
        table: state?.price_file ?? null,
        read: state?.price_date_read ?? null,
        priced_parts: pr.priced_parts,
        unpriced_parts: pr.unpriced_parts,
        unpriced_model: pr.unpriced_model,
        unknown_tokens: pr.unknown_tokens,
        unknown_modifier: pr.unknown_modifier,
        no_table: pr.no_table,
        floor_parts: pr.floor_parts,
        server_tool_use_calls: pc.server_tool_use_calls,
        server_tool_use_unknown_calls: pc.server_tool_use_unknown_calls,
        top_level_only_calls: pc.top_level_only_calls,
        cost_conservation: costCheck.ok ? 'OK' : 'VIOLATED',
      },
      notional: {
        known_nano: pr.known_nano,
        known_parts: pr.known_parts,
        unknown_parts: pr.unpriced_parts,
        floor_parts: pr.floor_parts,
      },
      join: otel.join,
      roleRules: otel.roleRules,
      otelOnly,
      crosscheck: otel.crosscheck,
      errorBand: otel.errorBand,
      harnessSources: otel.harnessSources,
    };
  } finally {
    db.close();
  }
}
