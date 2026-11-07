// loadOtelReport: the OTel join figures of derived.db as plain data for the renderer (plan 01-07, COST-02,
// COST-03, COST-05, COST-06, TRUST-01). Read-only SQL with fixed text; no value is computed from OTel files here,
// only from the derived tables otel_call, join_stat and api_call.
//
//   join        every join_stat figure plus the three counted rates as numerator and denominator:
//               raw = joined / otel_requests; joinable = the same without the pure-harness requests;
//               excl_sdk = joinable without the sdk requests. A zero denominator stays a zero denominator
//               (the renderer prints 0/0 (?), never 0 percent).
//   roleRules   api_call counts by role rule in the order of FULL_ROLE_RULES, plus conflict_attr_meta (role_conflict
//               1), conflict_query_source (qs_conflict 1) and harness_joined (a harness role on a joined call)
//   otelOnly    otel_only calls, harness calls, and per token class and cost the known sum and the unknown count
//               over their parts (tokens executor-only, cost measured by OTel)
//   crosscheck  the tally of api_call.xcheck and up to five disagreeing (transcript role, OTel name) pairs
//   errorBand   bandStats over the joined requests: derived = the 01-05 cost of their calls, measured = OTel
//   harnessSources  the six pure-harness sources, for the rules line
import { bandStats } from '../measure/stats.mjs';
import { HARNESS_SOURCES } from '../derive/query-source.mjs';
import { FULL_ROLE_RULES } from '../derive/role.mjs';
import { tallyXcheck } from '../derive/agent-xcheck.mjs';

export const JOIN_STAT_NAMES = Object.freeze([
  'otel_requests', 'joined', 'harness_requests', 'harness_joined', 'sdk_requests', 'sdk_joined', 'otel_sessions',
  'sessions_no_transcript', 'sessions_zero_joined', 'duplicates', 'conflicting_duplicates', 'no_request_id',
  'multi_message_requests', 'transcript_calls', 'joined_calls', 'transcript_only_calls',
]);

const ROLE_RULE_SQL = 'SELECT role_rule, count(*) AS n FROM api_call GROUP BY role_rule';
const ROLE_FLAGS_SQL = `
SELECT count(CASE WHEN role_conflict = 1 THEN 1 END) AS conflict_attr_meta,
       count(CASE WHEN qs_conflict = 1 THEN 1 END) AS conflict_query_source,
       count(CASE WHEN role_rule = 'harness' AND join_state = 'joined' THEN 1 END) AS harness_joined
  FROM api_call`;

// [report class, part column]
const OTEL_CLASSES = [['input', 'input_tokens'], ['output', 'output_tokens'], ['cache_read', 'cache_read'], ['cache_write', 'cache_creation']];
const OTEL_ONLY_SQL = `
SELECT count(DISTINCT c.call_key) AS calls,
       count(DISTINCT CASE WHEN c.section = 'harness' THEN c.call_key END) AS harness_calls,
       count(p.call_key) AS parts,
       ${OTEL_CLASSES.map(([, col]) => `sum(p.${col}) AS ${col}_sum, count(p.call_key) - count(p.${col}) AS ${col}_unknown`).join(',\n       ')},
       sum(p.cost_nano) AS cost_sum, count(p.call_key) - count(p.cost_nano) AS cost_unknown
  FROM api_call c LEFT JOIN api_call_part p ON p.call_key = c.call_key
 WHERE c.join_state = 'otel_only'`;

const XCHECK_SQL = 'SELECT xcheck, count(*) AS n FROM api_call WHERE xcheck IS NOT NULL GROUP BY xcheck';
const DISAGREE_SQL = `
SELECT role AS transcript, otel_agent_name AS otel, count(*) AS n
  FROM api_call WHERE xcheck = 'disagree'
 GROUP BY role, otel_agent_name
 ORDER BY n DESC, role ASC, otel_agent_name ASC
 LIMIT 5`;

// One row per joined request: its derived and measured cost, its call count, the role and model of its first
// call by call_key, and whether any of its calls is top_level_only or a cost floor.
const BAND_SQL = `
SELECT o.request_key AS key, o.derived_nano, o.cost_nano AS measured_nano, o.transcript_calls AS calls,
       (SELECT a.role FROM api_call a WHERE a.request_id = o.request_id AND a.token_label = 'transcript' ORDER BY a.call_key LIMIT 1) AS role,
       (SELECT a.model FROM api_call a WHERE a.request_id = o.request_id AND a.token_label = 'transcript' ORDER BY a.call_key LIMIT 1) AS model,
       (SELECT max(CASE WHEN a.price_basis = 'top_level_only' THEN 1 ELSE 0 END) FROM api_call a
         WHERE a.request_id = o.request_id AND a.token_label = 'transcript') AS top_level_only,
       (SELECT max(a.cost_floor) FROM api_call a WHERE a.request_id = o.request_id AND a.token_label = 'transcript') AS floor
  FROM otel_call o
 WHERE o.state = 'joined'
 ORDER BY o.request_key`;

const RULE_NAMES = { main: 'transcript_main', none: 'unknown' };

export function loadOtelReport(db) {
  const stat = Object.fromEntries(JOIN_STAT_NAMES.map((n) => [n, 0]));
  for (const r of db.prepare('SELECT name, n FROM join_stat').all()) if (Object.hasOwn(stat, r.name)) stat[r.name] = r.n;
  const harnessOut = stat.joined - stat.harness_joined;
  const join = {
    ...stat,
    rates: {
      raw: { n: stat.joined, d: stat.otel_requests },
      joinable: { n: harnessOut, d: stat.otel_requests - stat.harness_requests },
      excl_sdk: { n: harnessOut - stat.sdk_joined, d: stat.otel_requests - stat.harness_requests - stat.sdk_requests },
    },
  };

  const byRule = Object.fromEntries(db.prepare(ROLE_RULE_SQL).all().map((r) => [r.role_rule, r.n]));
  const flags = db.prepare(ROLE_FLAGS_SQL).get();
  const roleRules = {
    rules: FULL_ROLE_RULES.map((rule) => ({ name: RULE_NAMES[rule] ?? rule, n: byRule[rule] ?? 0 })),
    conflict_attr_meta: flags.conflict_attr_meta,
    conflict_query_source: flags.conflict_query_source,
    harness_joined: flags.harness_joined,
  };

  const o = db.prepare(OTEL_ONLY_SQL).get();
  // Over no parts a sum is a real 0, not unknown: there is nothing to add.
  const sumOf = (sum) => (o.parts === 0 ? 0 : sum);
  const otelOnly = {
    calls: o.calls,
    harness_calls: o.harness_calls,
    classes: OTEL_CLASSES.map(([name, col]) => ({ class: name, sum: sumOf(o[`${col}_sum`]), unknown: o[`${col}_unknown`] })),
    cost: { sum: sumOf(o.cost_sum), unknown: o.cost_unknown },
  };

  const states = [];
  for (const r of db.prepare(XCHECK_SQL).all()) for (let i = 0; i < r.n; i += 1) states.push(r.xcheck);
  const crosscheck = {
    ...tallyXcheck(states),
    pairs: db.prepare(DISAGREE_SQL).all().map((r) => ({ transcript: r.transcript, otel: r.otel, n: r.n })),
  };

  const errorBand = bandStats(db.prepare(BAND_SQL).all().map((r) => ({
    key: r.key, derivedNano: r.derived_nano, measuredNano: r.measured_nano, calls: r.calls, role: r.role, model: r.model,
    topLevelOnly: r.top_level_only, floor: r.floor,
  })));

  return { join, roleRules, otelOnly, crosscheck, errorBand, harnessSources: [...HARNESS_SOURCES] };
}
