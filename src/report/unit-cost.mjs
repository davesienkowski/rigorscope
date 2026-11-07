// Per-unit attributed cost, the attribution bucket totals with their check, and the link counts (plan 02-07, UNIT-06,
// UNIT-01, D-13). Read by `units` (this plan) and by `tier` and `cost` (plan 02-08). Every function takes an open
// derived.db handle from its caller and opens nothing itself. Fixed SQL text; the mode and every filter value are bound;
// the optional callWhere fragment ({ sql, params } over the call alias c) comes only from src/report/filters.mjs.
//
// Sums use the CASE guard of src/report/cost.mjs: a group with any NULL member is NULL (unknown), never its partial sum.
// tokens is the guarded sum of input, output, cache_read and cache_creation (cache_5m and cache_1h split cache_creation
// and are not added). Money is integer nano-dollars. Only main-section calls (token_label transcript) are attributed.
import { checkAttribution } from '../derive/attribution.mjs';

const MAIN = "c.token_label = 'transcript'";
const CLASSES = [['input', 'input_tokens'], ['output', 'output_tokens'], ['cache_read', 'cache_read'], ['cache_write', 'cache_creation']];
const guard = (col) => `CASE WHEN count(${col}) = count(*) THEN sum(${col}) END`;
const TOKENS = `CASE WHEN ${CLASSES.map(([, c]) => `count(p.${c}) = count(*)`).join(' AND ')}
             THEN ${CLASSES.map(([, c]) => `sum(p.${c})`).join(' + ')} END`;
const fragment = (callWhere) => (callWhere && callWhere.sql ? { sql: ` AND (${callWhere.sql})`, params: callWhere.params } : { sql: '', params: [] });
const POINT = 1e6;
const points = (micro) => (micro === null || micro === undefined ? null : micro / POINT);

// -> Map(unit_key -> { calls, scopes, input, output, cache_read, cache_write, tokens, usd_nano, usd_floor, window_5h, window_7d }),
// usd_floor is true when any contributing part is floor-priced (cost_floor, as `cost` marks with >=: the dollars are a lower bound),
// window values in percent points of the window (NULL when any member part has no usable share).
export function loadUnitCosts(db, { mode = 'medium', callWhere = null } = {}) {
  const w = fragment(callWhere);
  const rows = db.prepare(`
SELECT sa.unit_key AS unit_key, count(DISTINCT p.call_key) AS calls,
       count(DISTINCT c.owner_session_id || char(0) || c.owner_agent_id) AS scopes,
       ${CLASSES.map(([name, c]) => `${guard(`p.${c}`)} AS ${name}`).join(',\n       ')},
       ${TOKENS} AS tokens, ${guard('p.cost_nano')} AS usd_nano, max(p.cost_floor) AS cost_floor,
       ${guard('w5.share_micro')} AS w5, ${guard('w7.share_micro')} AS w7
  FROM api_call_part p
  JOIN api_call c ON c.call_key = p.call_key
  JOIN scope_attribution sa ON sa.session_id = c.owner_session_id AND sa.agent_id = c.owner_agent_id
                           AND sa.link_confidence = ? AND sa.bucket = 'attributed'
  LEFT JOIN api_call_part_window w5 ON w5.call_key = p.call_key AND w5.part_seq = p.part_seq AND w5.win = 'five_hour'
  LEFT JOIN api_call_part_window w7 ON w7.call_key = p.call_key AND w7.part_seq = p.part_seq AND w7.win = 'seven_day'
 WHERE ${MAIN}${w.sql}
 -- the unary plus keeps the planner from using the unit index for the GROUP BY, which forces a full api_call scan per scope
 GROUP BY +sa.unit_key
 ORDER BY sa.unit_key`).all(mode, ...w.params);
  return new Map(rows.map((r) => [r.unit_key, {
    calls: r.calls,
    scopes: r.scopes,
    input: r.input,
    output: r.output,
    cache_read: r.cache_read,
    cache_write: r.cache_write,
    tokens: r.tokens,
    usd_nano: r.usd_nano,
    usd_floor: r.cost_floor === 1,
    window_5h: points(r.w5),
    window_7d: points(r.w7),
  }]));
}

// Plan 03-04 (D-17, J4): main-section dollars attributed (link confidence medium, whatever --link-confidence says) to the units of
// each population, and the main-section total, both over the same calls: the optional callWhere fragment and an optional lower
// bound sinceMs on the call time (the forward denominator starts at the first ledger line). Integer nano-dollars; the CASE guard
// makes a set with any unpriced part NULL (unknown), never its partial sum. Grouped on `+u.population` (R9). A population with
// no attributed call has no row: the caller reads that as a genuine 0 when the total is known.
export function loadPopulationDollars(db, { callWhere = null, sinceMs = null } = {}) {
  const w = fragment(callWhere);
  const since = sinceMs === null ? { sql: '', params: [] } : { sql: ' AND c.ts_ms >= ?', params: [sinceMs] };
  const attributed = new Map(db.prepare(`
SELECT +u.population AS population, ${guard('p.cost_nano')} AS usd_nano
  FROM api_call_part p
  JOIN api_call c ON c.call_key = p.call_key
  JOIN scope_attribution sa ON sa.session_id = c.owner_session_id AND sa.agent_id = c.owner_agent_id
                           AND sa.link_confidence = ? AND sa.bucket = 'attributed'
  JOIN unit u ON u.unit_key = sa.unit_key
 WHERE ${MAIN}${w.sql}${since.sql}
 GROUP BY +u.population`).all('medium', ...w.params, ...since.params).map((r) => [r.population, r.usd_nano]));
  const total = db.prepare(`
SELECT ${guard('p.cost_nano')} AS usd_nano, count(*) AS parts
  FROM api_call_part p JOIN api_call c ON c.call_key = p.call_key
 WHERE ${MAIN}${w.sql}${since.sql}`).get(...w.params, ...since.params);
  return { attributed, total_nano: total.parts === 0 ? null : total.usd_nano };
}

// Plan 03-04 review fix (HIGH-1, D-24): the main-section calls at or after sinceMs by attribution bucket (link confidence medium,
// whatever --link-confidence says), the attributed bucket split by the population of its unit, and the independent total of the
// same calls. rows: { bucket, population (null outside the attributed bucket), calls, usd_nano }; the CASE guard makes a group
// with any unpriced part NULL. The optional callWhere fragment narrows both queries alike; unit filters are not applied here.
// Grouped on `+col` (R9). The caller (src/report/strata.mjs windowSplit) adds the rows up and checks them against the total.
export function loadWindowBuckets(db, { callWhere = null, sinceMs }) {
  const w = fragment(callWhere);
  const rows = db.prepare(`
SELECT +sa.bucket AS bucket, +u.population AS population, count(DISTINCT p.call_key) AS calls, ${guard('p.cost_nano')} AS usd_nano
  FROM api_call_part p
  JOIN api_call c ON c.call_key = p.call_key
  JOIN scope_attribution sa ON sa.session_id = c.owner_session_id AND sa.agent_id = c.owner_agent_id AND sa.link_confidence = ?
  LEFT JOIN unit u ON u.unit_key = sa.unit_key
 WHERE ${MAIN}${w.sql} AND c.ts_ms >= ?
 GROUP BY +sa.bucket, +u.population
 ORDER BY bucket, population`).all('medium', ...w.params, sinceMs).map((r) => ({
    bucket: r.bucket, population: r.population, calls: r.calls, usd_nano: r.usd_nano,
  }));
  const t = db.prepare(`
SELECT count(DISTINCT p.call_key) AS calls, ${guard('p.cost_nano')} AS usd_nano
  FROM api_call_part p JOIN api_call c ON c.call_key = p.call_key
 WHERE ${MAIN}${w.sql} AND c.ts_ms >= ?`).get(...w.params, sinceMs);
  return { rows, total: { calls: t.calls, usd_nano: t.calls === 0 ? 0 : t.usd_nano } };
}

// An empty group is a genuine zero (no call), so calls 0 gives tokens and usd 0; otherwise the CASE guard applies.
const bucketOf = (r) => (r === undefined || r.calls === 0
  ? {
    calls: 0, tokens: 0, usd_nano: 0, refs_unknown_calls: 0,
  }
  : {
    calls: r.calls, tokens: r.tokens, usd_nano: r.usd_nano, refs_unknown_calls: r.refs_unknown_calls,
  });

// -> { mode, attributed, unattributed_overlap, unlinked, total } each { calls, tokens, usd_nano, refs_unknown_calls },
// plus unattributed_overlap.multi_unit_calls and .low_only_calls, attributed.widened_calls (reason one-low-unit),
// refs_unknown_calls (all buckets) and check ('ok' or 'mismatch', from checkAttribution).
export function loadAttributionTotals(db, { mode = 'medium', callWhere = null } = {}) {
  const w = fragment(callWhere);
  const select = `count(DISTINCT p.call_key) AS calls, ${TOKENS} AS tokens, ${guard('p.cost_nano')} AS usd_nano`;
  const rows = new Map(db.prepare(`
SELECT sa.bucket AS bucket, ${select},
       count(DISTINCT CASE WHEN sa.refs_known = 0 THEN p.call_key END) AS refs_unknown_calls,
       count(DISTINCT CASE WHEN sa.reason = 'multi-unit' THEN p.call_key END) AS multi_unit_calls,
       count(DISTINCT CASE WHEN sa.reason = 'low-only' THEN p.call_key END) AS low_only_calls,
       count(DISTINCT CASE WHEN sa.reason = 'one-low-unit' THEN p.call_key END) AS widened_calls
  FROM api_call_part p
  JOIN api_call c ON c.call_key = p.call_key
  JOIN scope_attribution sa ON sa.session_id = c.owner_session_id AND sa.agent_id = c.owner_agent_id AND sa.link_confidence = ?
 WHERE ${MAIN}${w.sql}
 GROUP BY sa.bucket ORDER BY sa.bucket`).all(mode, ...w.params).map((r) => [r.bucket, r]));
  const total = db.prepare(`
SELECT ${select}, count(DISTINCT CASE WHEN ls.refs_known = 0 THEN p.call_key END) AS refs_unknown_calls
  FROM api_call_part p
  JOIN api_call c ON c.call_key = p.call_key
  LEFT JOIN link_scope ls ON ls.session_id = c.owner_session_id AND ls.agent_id = c.owner_agent_id
 WHERE ${MAIN}${w.sql}`).get(...w.params);
  const overlap = rows.get('unattributed_overlap');
  const attributed = rows.get('attributed');
  const out = {
    mode,
    attributed: { ...bucketOf(attributed), widened_calls: attributed ? attributed.widened_calls : 0 },
    unattributed_overlap: {
      ...bucketOf(overlap),
      multi_unit_calls: overlap ? overlap.multi_unit_calls : 0,
      low_only_calls: overlap ? overlap.low_only_calls : 0,
    },
    unlinked: bucketOf(rows.get('unlinked')),
    total: bucketOf(total),
  };
  out.refs_unknown_calls = out.total.refs_unknown_calls;
  out.check = checkAttribution(db, { mode, callWhere }).ok ? 'ok' : 'mismatch';
  return out;
}

// -> { scopes, refs_unknown, methods: { 'tool-path': { high, medium, low }, ... }, lowered, dir_name, unmatched, ambiguous,
// phase_dropped, slash_ambiguous, no_interval_units, shared_end_units }: per method the (scope, unit) pairs by final confidence, then the
// derive_state link counters (0 for a counter the pass did not set, which happens only on a file built before 02-07).
export function loadLinkCounts(db) {
  const state = db.prepare(`
SELECT link_scopes, link_scopes_refs_unknown, link_lowered, link_dir_name, link_refs_unmatched, link_refs_ambiguous,
       link_phase_dropped, link_slash_ambiguous, link_units_no_interval, link_shared_end_units
  FROM derive_state WHERE id = 1`).get() ?? {};
  const methods = {};
  for (const m of ['tool-path', 'slash-command', 'interval']) methods[m] = { high: 0, medium: 0, low: 0 };
  for (const r of db.prepare('SELECT method, confidence, count(*) AS n FROM unit_link GROUP BY method, confidence ORDER BY method, confidence').all()) {
    methods[r.method][r.confidence] = r.n;
  }
  const n = (v) => v ?? 0;
  return {
    scopes: n(state.link_scopes),
    refs_unknown: n(state.link_scopes_refs_unknown),
    methods,
    lowered: n(state.link_lowered),
    dir_name: n(state.link_dir_name),
    unmatched: n(state.link_refs_unmatched),
    ambiguous: n(state.link_refs_ambiguous),
    phase_dropped: n(state.link_phase_dropped),
    slash_ambiguous: n(state.link_slash_ambiguous),
    no_interval_units: n(state.link_units_no_interval),
    shared_end_units: n(state.link_shared_end_units),
  };
}
