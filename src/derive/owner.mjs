// The dedup owner rule (D-03, D-12). One message id can be stored under several (session_id, agent_id)
// keys: a fork pair, a copied history, a backup root. The derivation keeps ONE api_call per message id.
// Its tokens are the field-wise maximum over all occurrences, so the choice of owner never changes a
// token total; the owner only decides the identity columns (session, agent, role, time, effort).
//
// OWNER_TERMS is the single named ordering (the lesson of a sibling transcript tool: define it once, derive
// every use from it). Rule `earliest` uses the base directions; rule `latest` flips every direction and
// exists to prove invariance. NULL sorts last in both. A rule is chosen by NAME from a fixed registry;
// SQL text is never accepted as a rule and no user text reaches the SQL.
//
// The SELECT runs on the derived connection with store.db attached read-only as schema `s`.

// The literal model Claude Code writes on harness-generated lines that carry no real API call.
export const SYNTHETIC_MODEL = '<synthetic>';

const term = (expr, dir) => Object.freeze({ expr, dir });

export const OWNER_TERMS = Object.freeze([
  // Compared as numbers, so ...01Z and ...01.000Z tie (as text they would not).
  term("unixepoch(ts_utc,'subsec')", 'ASC'),
  // The occurrence's earliest file: its first record time, then root alias, then relative path.
  term("unixepoch(file_first_record_utc,'subsec')", 'ASC'),
  // Alias and path are separate terms: in a joined string the dash of claude-contrib sorts before the
  // slash after claude, which would reverse the alias order.
  term('file_root_alias', 'ASC'),
  term('file_rel_path', 'ASC'),
  term('session_id', 'ASC'),
  term('agent_id', 'ASC'),
]);

const flip = (dir) => (dir === 'ASC' ? 'DESC' : 'ASC');
const orderText = (dirOf) => OWNER_TERMS.map((t) => `${t.expr} ${dirOf(t.dir)} NULLS LAST`).join(', ');

export const OWNER_RULES = Object.freeze(Object.assign(Object.create(null), {
  earliest: orderText((d) => d),
  latest: orderText(flip),
}));

export const DEFAULT_OWNER_RULE = 'earliest';

export function ownerOrderBy(rule) {
  if (typeof rule !== 'string' || !Object.hasOwn(OWNER_RULES, rule)) {
    throw new RangeError('unknown owner rule; expected one of: earliest, latest');
  }
  return OWNER_RULES[rule];
}

const TOKENS = ['input_tokens', 'output_tokens', 'cache_read', 'cache_creation', 'cache_5m', 'cache_1h'];

// One row per message id with at least one non-synthetic occurrence:
//   message_id, owner_session_id, owner_agent_id, occurrences, request_id, ts_utc, model,
//   attribution_agent, effort, has_iterations, meta_agent_type, speed, service_tier, inference_geo,
//   has_server_tool_use, and the six token columns.
// speed, service_tier and inference_geo come from the owner occurrence (plan 01-05 modifiers);
// has_server_tool_use over the non-synthetic occurrences (review CR-01, RR-04): 1 when any is 1, else NULL when any
// is NULL (an unknown copy may hide a count above 0, so a 0 from another copy cannot answer for it), else 0.
// Identity columns come from the owner occurrence; occurrences, has_iterations and the token columns
// are aggregated over all non-synthetic occurrences (has_iterations as a maximum, so whichever
// occurrence carried the iterations, the advisor parts are built). A NULL model is kept.
export function dedupSelectSql(rule) {
  const order = ownerOrderBy(rule);
  return `
WITH files AS (
  SELECT mf.session_id, mf.agent_id, mf.message_id,
         sf.first_record_utc AS file_first_record_utc, sr.alias AS file_root_alias, sf.rel_path AS file_rel_path,
         row_number() OVER (
           PARTITION BY mf.session_id, mf.agent_id, mf.message_id
           ORDER BY unixepoch(sf.first_record_utc,'subsec') ASC NULLS LAST, sr.alias ASC NULLS LAST, sf.rel_path ASC NULLS LAST
         ) AS file_rank
    FROM s.cc_message_file mf
    JOIN s.source_file sf ON sf.file_id = mf.file_id
    JOIN s.source_root sr ON sr.root_id = sf.root_id
),
occ AS (
  SELECT m.session_id, m.agent_id, m.message_id, m.request_id, m.ts_utc, m.model, m.attribution_agent, m.effort,
         m.has_iterations, m.speed, m.service_tier, m.inference_geo, m.has_server_tool_use,
         ${TOKENS.map((c) => `m.${c}`).join(', ')},
         f.file_first_record_utc, f.file_root_alias, f.file_rel_path
    FROM s.cc_message m
    LEFT JOIN files f
      ON f.session_id = m.session_id AND f.agent_id = m.agent_id AND f.message_id = m.message_id AND f.file_rank = 1
   WHERE m.model IS NOT '${SYNTHETIC_MODEL}'
),
ranked AS (
  SELECT occ.*, row_number() OVER (PARTITION BY message_id ORDER BY ${order}) AS owner_rank
    FROM occ
),
agg AS (
  SELECT message_id, count(*) AS occurrences, max(has_iterations) AS has_iterations,
         CASE WHEN max(has_server_tool_use) = 1 THEN 1
              WHEN count(has_server_tool_use) < count(*) THEN NULL ELSE 0 END AS has_server_tool_use,
         ${TOKENS.map((c) => `max(${c}) AS ${c}`).join(', ')}
    FROM occ
   GROUP BY message_id
)
SELECT r.message_id, r.session_id AS owner_session_id, r.agent_id AS owner_agent_id, a.occurrences,
       r.request_id, r.ts_utc, r.model, r.attribution_agent, r.effort, a.has_iterations,
       am.agent_type AS meta_agent_type, r.speed, r.service_tier, r.inference_geo, a.has_server_tool_use,
       ${TOKENS.map((c) => `a.${c}`).join(', ')}
  FROM ranked r
  JOIN agg a ON a.message_id = r.message_id
  LEFT JOIN s.cc_agent_meta am ON am.session_id = r.session_id AND am.agent_id = r.agent_id
 WHERE r.owner_rank = 1
 ORDER BY r.message_id`;
}
