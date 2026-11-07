// The OTel request owner (plan 01-07, COST-02, D-12). One OTel request can be logged more than once: the receiver
// may write the same api_request twice, and a live file and its preserve copy are already collapsed by the 4-field
// event key at ingest (plan 01-03). The derivation keeps ONE row per request key, the owner event, chosen by the
// single named ordering OTEL_OWNER_TERMS (the lesson of a sibling transcript tool: define it once, derive every use from
// it). Rule `earliest` uses the base directions; rule `latest` reverses every direction and exists only to prove
// the ordering. NULL sorts last in both. A rule is chosen by NAME from a fixed registry; SQL text is never
// accepted as a rule and no data or flag text reaches the SQL.
//
// The request key is the request_id when it is neither NULL nor empty, else 'e:' + session_id + ':' + event_seq +
// ':' + event_ts (the event's own key, so an event without request_id is one request). Only events of kind
// api_request are read: api_error and assistant_response also carry a request_id and are never used. The run-level
// sub-agent token total of another event kind is never read (D-12).
//
// The SELECT runs on the derived connection with store.db attached read-only as schema `s`.
const term = (expr, dir) => Object.freeze({ expr, dir });

export const OTEL_OWNER_TERMS = Object.freeze([
  // Compared as instants, so ...01Z and ...01.000Z tie (as text they would not); then bytewise text.
  term("unixepoch(ts_utc,'subsec')", 'ASC'),
  term('session_id', 'ASC'),
  term('event_seq', 'ASC'),
  term('event_ts', 'ASC'),
]);

const flip = (dir) => (dir === 'ASC' ? 'DESC' : 'ASC');
const orderText = (dirOf) => OTEL_OWNER_TERMS.map((t) => `${t.expr} ${dirOf(t.dir)} NULLS LAST`).join(', ');

export const OTEL_OWNER_RULES = Object.freeze(Object.assign(Object.create(null), {
  earliest: orderText((d) => d),
  latest: orderText(flip),
}));

export const DEFAULT_OTEL_OWNER_RULE = 'earliest';

export function otelOwnerOrderBy(rule) {
  if (typeof rule !== 'string' || !Object.hasOwn(OTEL_OWNER_RULES, rule)) {
    throw new RangeError('unknown OTel owner rule; expected one of: earliest, latest');
  }
  return OTEL_OWNER_RULES[rule];
}

// The fields whose disagreement between two events of one request makes it a conflicting duplicate: the model,
// the four counted token fields and cost_usd. Paths are literals.
const TUPLE = `json_array(json_extract(attrs, '$.model'), json_extract(attrs, '$.input_tokens'), json_extract(attrs, '$.output_tokens'),
  json_extract(attrs, '$.cache_read_tokens'), json_extract(attrs, '$.cache_creation_tokens'), json_extract(attrs, '$.cost_usd'))`;

// One row per request key, ordered by request key:
//   request_key, request_id (NULL when absent or empty), session_id, event_seq, event_ts, ts_utc, attrs (the owner
//   event's), occurrences (events of the key), conflicting (1 when the key's events hold more than one distinct
//   tuple), differing (surplus events whose tuple differs from the owner's)
export function otelRequestsSql(rule) {
  const order = otelOwnerOrderBy(rule);
  return `
WITH ev AS (
  SELECT session_id, event_seq, event_ts, ts_utc, attrs,
         CASE WHEN request_id IS NOT NULL AND request_id <> '' THEN request_id END AS request_id,
         CASE WHEN request_id IS NOT NULL AND request_id <> '' THEN request_id
              ELSE 'e:' || session_id || ':' || event_seq || ':' || event_ts END AS request_key,
         ${TUPLE} AS tuple
    FROM s.otel_event
   WHERE kind = 'api_request'
),
ranked AS (
  SELECT ev.*,
         row_number() OVER w AS owner_rank,
         first_value(tuple) OVER w AS owner_tuple,
         count(*) OVER (PARTITION BY request_key) AS occurrences
    FROM ev
  WINDOW w AS (PARTITION BY request_key ORDER BY ${order})
),
agg AS (
  SELECT request_key, count(DISTINCT tuple) AS tuples, sum(tuple IS NOT owner_tuple) AS differing
    FROM ranked
   GROUP BY request_key
)
SELECT r.request_key, r.request_id, r.session_id, r.event_seq, r.event_ts, r.ts_utc, r.attrs, r.occurrences,
       CASE WHEN a.tuples > 1 THEN 1 ELSE 0 END AS conflicting, a.differing
  FROM ranked r
  JOIN agg a ON a.request_key = r.request_key
 WHERE r.owner_rank = 1
 ORDER BY r.request_key`;
}
