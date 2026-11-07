// Direct-row OTel helpers for the join tests (plan 01-07). A helper, not a test: the quoted test glob never
// collects it. It writes otel_event rows straight into a store.db (no ingest) and digests the OTel tables of
// derived.db defensively.
//
// Independence rule: this file imports nothing from src/derive. It builds the attrs text the 01-03 writer
// would store (the allowlisted api_request keys, keys sorted) without calling the normalizer, so a test can
// also store a value the normalizer would never write (a string-typed count, a planted label).
import { createHash } from 'node:crypto';
import { openTempStore, queryOrEmpty } from './derive-rows.mjs';

export { openTempStore };

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// Argument name -> stored attrs key (01-03 allowlist names for api_request).
const ATTR_KEYS = [
  ['model', 'model'], ['input', 'input_tokens'], ['output', 'output_tokens'], ['cacheRead', 'cache_read_tokens'],
  ['cacheCreation', 'cache_creation_tokens'], ['cache5m', 'cache_creation_5m_tokens'], ['cache1h', 'cache_creation_1h_tokens'],
  ['costUsd', 'cost_usd'], ['costMicros', 'cost_usd_micros'], ['requestId', 'request_id'], ['querySource', 'query_source'],
  ['effort', 'effort'], ['agentName', 'agent.name'],
];

// The JSON text of an api_request attrs object, keys sorted; a key given as undefined is omitted. Values are
// stored as given (a string count stays a string).
export function apiRequestAttrs(args = {}) {
  const obj = {};
  for (const [arg, key] of ATTR_KEYS) if (args[arg] !== undefined) obj[key] = args[arg];
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`).join(',')}}`;
}

const COLUMNS = ['session_id', 'event_seq', 'event_ts', 'kind', 'ts_utc', 'prompt_id', 'request_id', 'tool_use_id', 'cc_version',
  'attrs', 'attrs_sha', 'file_id', 'src_end_offset'];

// Inserts one otel_event row binding every column explicitly; creates nothing else. tsUtc defaults to eventTs.
export function insertOtelEvent(db, {
  sessionId, seq, eventTs, kind = 'api_request', tsUtc, requestId = null, attrs = '{}',
}) {
  const row = {
    session_id: sessionId,
    event_seq: seq,
    event_ts: eventTs,
    kind,
    ts_utc: tsUtc ?? eventTs,
    prompt_id: null,
    request_id: requestId,
    tool_use_id: null,
    cc_version: null,
    attrs,
    attrs_sha: sha256Hex(attrs),
    file_id: null,
    src_end_offset: null,
  };
  db.prepare(`INSERT INTO otel_event (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`)
    .run(...COLUMNS.map((c) => row[c]));
}

// sha256 over canonical JSON of otel_call (by request_key) and join_stat (by name) of a derived.db. A missing
// table reads as an empty list, so a RED run fails on an assertion, never on a SQL error.
export function otelDigest(db) {
  const calls = queryOrEmpty(db, 'SELECT * FROM otel_call ORDER BY request_key');
  const stats = queryOrEmpty(db, 'SELECT * FROM join_stat ORDER BY name');
  const canon = (rows) => rows.map((r) => Object.keys(r).sort().map((k) => [k, r[k]]));
  return createHash('sha256').update(JSON.stringify([canon(calls), canon(stats)])).digest('hex');
}
