// fillOtel: the OTel join pass (plan 01-07, COST-02, COST-03, COST-05, COST-06, D-06, D-09, D-12). It runs inside
// the rebuild's single BEGIN IMMEDIATE transaction on the derived connection, after fillDerived (calls, parts,
// prices) and before fillWindows, with store.db attached read-only as schema `s`. It writes derived tables only
// and issues no statement that writes to schema s.
//
//   1. otel_call: one row per OTel request key (owner event of src/derive/otel-owner.mjs, kind api_request only).
//      Fields are read with json_extract at literal paths; a token count only when its JSON type is integer; the
//      measured cost is cost_usd x 1e9 rounded half up (a finite number from 0 to 9,000,000), else
//      cost_usd_micros x 1000, else NULL. query_source, agent name, model and effort are stored only when they
//      match their shape (query-source.mjs, the 01-03 name shape), else NULL. state is joined when a transcript
//      call has the request's request_id, else otel_only.
//   2. joined calls: join_state joined; role completed by resolveFullRole from the stored 01-04 columns
//      (attribution = role when role_rule is attribution, meta type = role_meta, agent id = owner_agent_id) plus
//      the request's query_source; qs, qs_role, qs_conflict, the OTel agent name and the cross-check state
//      against the transcript role (attribution, meta or main, never a role parsed from OTel); effort from OTel
//      only when the transcript has none. Their tokens, prices, costs and parts are NEVER updated (D-12).
//   3. otel_only calls: one api_call (call_key 'o:' + request key, no message id, token_label otel, price_basis
//      otel_executor_only, cost from OTel labeled otel or unavailable, section harness for a harness role else
//      otel) and one message part with the OTel token classes (NULL for an absent class).
//   4. otel_call.derived_nano: the NULL-propagating sum of the joined calls' derived cost; derived_flag 1 when one
//      of them is top_level_only or a cost floor.
//   5. join_stat: the counted join figures by fixed name.
import { checkShape } from '../redact/shapes.mjs';
import { CLASS_COLUMNS } from './schema.mjs';
import { DEFAULT_OTEL_OWNER_RULE, otelOwnerOrderBy, otelRequestsSql } from './otel-owner.mjs';
import { HARNESS_SOURCES, SDK_SOURCE, safeAgentName, safeQuerySource } from './query-source.mjs';
import { resolveFullRole } from './role.mjs';
import { classifyAgentName } from './agent-xcheck.mjs';

// derived token column -> api_request attribute (literal JSON paths)
const TOKEN_ATTRS = [
  ['input_tokens', 'input_tokens'], ['output_tokens', 'output_tokens'], ['cache_read', 'cache_read_tokens'],
  ['cache_creation', 'cache_creation_tokens'], ['cache_5m', 'cache_creation_5m_tokens'], ['cache_1h', 'cache_creation_1h_tokens'],
];
const MAX_COST_USD = 9000000; // 9e6 x 1e9 nano stays below 2^53

const requestRowsSql = (rule) => `
SELECT o.request_key, o.request_id, o.session_id, o.ts_utc, o.occurrences, o.conflicting, o.differing,
       json_extract(o.attrs, '$.model') AS model,
       json_extract(o.attrs, '$.query_source') AS query_source,
       json_extract(o.attrs, '$.effort') AS effort,
       json_extract(o.attrs, '$."agent.name"') AS agent_name,
       ${TOKEN_ATTRS.map(([col, attr]) => `CASE WHEN json_type(o.attrs, '$.${attr}') = 'integer' THEN json_extract(o.attrs, '$.${attr}') END AS ${col}`).join(',\n       ')},
       CASE WHEN json_type(o.attrs, '$.cost_usd') IN ('integer', 'real') THEN json_extract(o.attrs, '$.cost_usd') END AS cost_usd,
       CASE WHEN json_type(o.attrs, '$.cost_usd_micros') = 'integer' THEN json_extract(o.attrs, '$.cost_usd_micros') END AS cost_usd_micros
  FROM (${otelRequestsSql(rule)}) o
 ORDER BY o.request_key`;

const OTEL_CALL_COLUMNS = ['request_key', 'request_id', 'session_id', 'ts_utc', 'model', 'query_source', 'effort', 'agent_name',
  ...CLASS_COLUMNS, 'cost_nano', 'occurrences', 'conflicting', 'state', 'transcript_calls'];
const INSERT_OTEL_CALL = `INSERT INTO otel_call (${OTEL_CALL_COLUMNS.join(', ')}) VALUES (${OTEL_CALL_COLUMNS.map((c) => `$${c}`).join(', ')})`;

const JOINED_SQL = `
SELECT a.call_key, a.role, a.role_rule, a.role_meta, a.owner_agent_id, a.effort,
       o.query_source, o.agent_name, o.effort AS otel_effort
  FROM api_call a
  JOIN otel_call o ON o.request_id = a.request_id
 WHERE a.token_label = 'transcript'
 ORDER BY a.call_key`;

const UPDATE_JOINED = `
UPDATE api_call SET join_state = 'joined', role = $role, role_rule = $role_rule, role_source = $role_source, qs = $qs,
       qs_role = $qs_role, qs_conflict = $qs_conflict, otel_agent_name = $otel_agent_name, xcheck = $xcheck, effort = $effort,
       effort_source = $effort_source
 WHERE call_key = $call_key`;

const CALL_COLUMNS = ['call_key', 'message_id', 'owner_session_id', 'owner_agent_id', 'occurrences', 'request_id', 'ts_utc', 'model',
  'role', 'role_rule', 'role_source', 'role_meta', 'role_conflict', 'effort', 'join_state', 'price_basis', 'iter_mismatch',
  'iter_unknown_type', 'token_label', 'speed', 'service_tier', 'inference_geo', 'server_tool_use', 'cost_nano', 'cost_floor',
  'cost_label', 'section', 'qs', 'qs_role', 'qs_conflict', 'otel_agent_name', 'xcheck', 'effort_source'];
const INSERT_CALL = `INSERT INTO api_call (${CALL_COLUMNS.join(', ')}) VALUES (${CALL_COLUMNS.map((c) => `$${c}`).join(', ')})`;
const PART_COLUMNS = ['call_key', 'part_seq', 'kind', 'model', ...CLASS_COLUMNS, 'price_model', 'price_status', 'price_tier', 'geo_us',
  'cost_nano', 'cost_floor', 'floor_reason', 'price_version'];
const INSERT_PART = `INSERT INTO api_call_part (${PART_COLUMNS.join(', ')}) VALUES (${PART_COLUMNS.map((c) => `$${c}`).join(', ')})`;

const DERIVED_COST_SQL = `
UPDATE otel_call SET
  derived_nano = (SELECT CASE WHEN count(a.cost_nano) = count(*) THEN sum(a.cost_nano) END
                    FROM api_call a WHERE a.request_id = otel_call.request_id AND a.token_label = 'transcript'),
  derived_flag = (SELECT max(CASE WHEN a.price_basis = 'top_level_only' OR a.cost_floor = 1 THEN 1 ELSE 0 END)
                    FROM api_call a WHERE a.request_id = otel_call.request_id AND a.token_label = 'transcript')
 WHERE state = 'joined'`;

const inList = (values) => values.map((v) => `'${v}'`).join(', ');
const HARNESS_IN = inList(HARNESS_SOURCES);
// join_stat: fixed names and fixed SQL; every value is a real count (0 when none).
const STAT_SQL = [
  ['otel_requests', 'SELECT count(*) AS n FROM otel_call'],
  ['joined', "SELECT count(*) AS n FROM otel_call WHERE state = 'joined'"],
  ['harness_requests', `SELECT count(*) AS n FROM otel_call WHERE query_source IN (${HARNESS_IN})`],
  ['harness_joined', `SELECT count(*) AS n FROM otel_call WHERE query_source IN (${HARNESS_IN}) AND state = 'joined'`],
  ['sdk_requests', `SELECT count(*) AS n FROM otel_call WHERE query_source = '${SDK_SOURCE}'`],
  ['sdk_joined', `SELECT count(*) AS n FROM otel_call WHERE query_source = '${SDK_SOURCE}' AND state = 'joined'`],
  ['otel_sessions', 'SELECT count(DISTINCT session_id) AS n FROM otel_call'],
  ['sessions_no_transcript', `SELECT count(*) AS n FROM (SELECT DISTINCT session_id FROM otel_call) o
     WHERE NOT EXISTS (SELECT 1 FROM s.cc_message m WHERE m.session_id = o.session_id)`],
  ['sessions_zero_joined', `SELECT count(*) AS n FROM (SELECT session_id FROM otel_call GROUP BY session_id
     HAVING count(CASE WHEN state = 'joined' THEN 1 END) = 0)`],
  ['duplicates', 'SELECT coalesce(sum(occurrences - 1), 0) AS n FROM otel_call'],
  ['no_request_id', 'SELECT count(*) AS n FROM otel_call WHERE request_id IS NULL'],
  ['multi_message_requests', 'SELECT count(*) AS n FROM otel_call WHERE transcript_calls > 1'],
  ['transcript_calls', "SELECT count(*) AS n FROM api_call WHERE token_label = 'transcript'"],
  ['joined_calls', "SELECT count(*) AS n FROM api_call WHERE join_state = 'joined'"],
  ['transcript_only_calls', "SELECT count(*) AS n FROM api_call WHERE join_state = 'transcript_only'"],
];

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const shaped = (kind, v) => {
  const ok = checkShape(kind, v);
  return ok === undefined ? null : ok;
};

// The measured cost in nano-dollars: cost_usd preferred (it keeps sub-micro precision), cost_usd_micros the fallback.
export function otelCostNano(costUsd, costMicros) {
  if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0 && costUsd <= MAX_COST_USD) {
    return Math.round(costUsd * 1e9);
  }
  const micros = count(costMicros);
  return micros === null || micros > Number.MAX_SAFE_INTEGER / 1000 ? null : micros * 1000;
}

const TRANSCRIPT_ROLE_RULES = ['attribution', 'meta', 'main'];

export function fillOtel({ db, otelRule = DEFAULT_OTEL_OWNER_RULE }) {
  otelOwnerOrderBy(otelRule); // an unknown rule name throws before anything is written
  // A transcript call that carries an effort has it from the transcript.
  db.exec("UPDATE api_call SET effort_source = 'transcript' WHERE effort IS NOT NULL AND token_label = 'transcript'");

  // 1. otel_call
  const insertOtel = db.prepare(INSERT_OTEL_CALL);
  const callsFor = db.prepare("SELECT count(*) AS n FROM api_call WHERE request_id = ? AND token_label = 'transcript'");
  let conflictingDuplicates = 0;
  for (const r of db.prepare(requestRowsSql(otelRule)).iterate()) {
    const transcriptCalls = r.request_id === null ? 0 : callsFor.get(r.request_id).n;
    const row = {
      request_key: r.request_key,
      request_id: r.request_id,
      session_id: r.session_id,
      ts_utc: r.ts_utc,
      model: shaped('name', r.model),
      query_source: safeQuerySource(r.query_source),
      effort: shaped('name', r.effort),
      agent_name: safeAgentName(r.agent_name),
      cost_nano: otelCostNano(r.cost_usd, r.cost_usd_micros),
      occurrences: r.occurrences,
      conflicting: r.conflicting,
      state: transcriptCalls > 0 ? 'joined' : 'otel_only',
      transcript_calls: transcriptCalls,
    };
    for (const [col] of TOKEN_ATTRS) row[col] = count(r[col]);
    insertOtel.run(row);
    conflictingDuplicates += r.differing ?? 0;
  }

  // 2. joined calls: reads streamed, updates applied after the scan (no update while api_call is being read).
  const updates = [];
  for (const a of db.prepare(JOINED_SQL).iterate()) {
    const full = resolveFullRole({
      attribution: a.role_rule === 'attribution' ? a.role : null, metaType: a.role_meta, agentId: a.owner_agent_id, querySource: a.query_source,
    });
    const transcriptRole = TRANSCRIPT_ROLE_RULES.includes(a.role_rule) ? a.role : null;
    let effort = a.effort;
    let effortSource = a.effort === null ? null : 'transcript';
    if (effort === null && a.otel_effort !== null) {
      effort = a.otel_effort;
      effortSource = 'otel';
    }
    updates.push({
      call_key: a.call_key,
      role: full.role,
      role_rule: full.rule,
      role_source: full.source,
      qs: a.query_source,
      qs_role: full.qsRole,
      qs_conflict: full.qsConflict,
      otel_agent_name: a.agent_name,
      xcheck: classifyAgentName({ joined: true, agentName: a.agent_name, transcriptRole }),
      effort,
      effort_source: effortSource,
    });
  }
  const updateJoined = db.prepare(UPDATE_JOINED);
  for (const u of updates) updateJoined.run(u);

  // 3. otel_only calls and their one part each
  const insertCall = db.prepare(INSERT_CALL);
  const insertPart = db.prepare(INSERT_PART);
  const onlyRows = db.prepare("SELECT * FROM otel_call WHERE state = 'otel_only' ORDER BY request_key").all();
  for (const o of onlyRows) {
    const full = resolveFullRole({ attribution: null, metaType: null, agentId: null, querySource: o.query_source });
    const callKey = `o:${o.request_key}`;
    const known = o.cost_nano !== null;
    insertCall.run({
      call_key: callKey,
      message_id: null,
      owner_session_id: o.session_id,
      owner_agent_id: '',
      occurrences: o.occurrences,
      request_id: o.request_id,
      ts_utc: o.ts_utc,
      model: o.model,
      role: full.role,
      role_rule: full.rule,
      role_source: full.source,
      role_meta: null,
      role_conflict: null,
      effort: o.effort,
      join_state: 'otel_only',
      price_basis: 'otel_executor_only',
      iter_mismatch: 0,
      iter_unknown_type: 0,
      token_label: 'otel',
      speed: null,
      service_tier: null,
      inference_geo: null,
      server_tool_use: null,
      cost_nano: o.cost_nano,
      cost_floor: 0,
      cost_label: known ? 'otel' : 'unavailable',
      section: full.rule === 'harness' ? 'harness' : 'otel',
      qs: o.query_source,
      qs_role: full.qsRole,
      qs_conflict: null,
      otel_agent_name: o.agent_name,
      xcheck: classifyAgentName({ joined: false }),
      effort_source: o.effort === null ? null : 'otel',
    });
    const part = {
      call_key: callKey,
      part_seq: 0,
      kind: 'message',
      model: o.model,
      price_model: null,
      price_status: known ? 'otel_measured' : 'otel_no_cost',
      price_tier: null,
      geo_us: 0,
      cost_nano: o.cost_nano,
      cost_floor: 0,
      floor_reason: null,
      price_version: null,
    };
    for (const c of CLASS_COLUMNS) part[c] = o[c];
    insertPart.run(part);
  }

  // 4. the derived side of the error band
  db.exec(DERIVED_COST_SQL);

  // 5. join_stat
  const insertStat = db.prepare('INSERT INTO join_stat (name, n) VALUES (?, ?)');
  for (const [name, sql] of STAT_SQL) insertStat.run(name, db.prepare(sql).get().n);
  insertStat.run('conflicting_duplicates', conflictingDuplicates);
}
