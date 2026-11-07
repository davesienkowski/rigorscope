// fillDerived: the derivation pass (plan 01-04, D-03, D-12, COST-01, COST-02). It runs inside the
// rebuild's single BEGIN IMMEDIATE transaction on the derived connection, with store.db attached
// read-only as schema `s`, so every read below comes from one snapshot of the store.
//
//   1. stream one owner row per message id (dedupSelectSql), each joined to its collapsed iterations
//      (maximum per message id and iter_seq over all non-synthetic occurrences)
//   2. per row: resolveRole -> role columns; buildParts -> parts and flags; priceCall -> the notional
//      cost of every part at its own model (plan 01-05) and of the call; insert api_call and parts
//   3. one derive_state row: provenance, the pass counters, the store-side per-class totals that
//      checkConservation compares the parts with, and the price table used (file, date read, sha)
//
// Rows are streamed with iterate() and inserted with prepared statements; nothing is held in memory but
// the current row. The run-level sub-agent token total is never read: per-call tokens come from the
// transcript messages only (D-12). No statement here writes to schema s.
import { CLASS_COLUMNS } from './schema.mjs';
import { SYNTHETIC_MODEL, dedupSelectSql } from './owner.mjs';
import { resolveRole } from './role.mjs';
import { buildParts } from './parts.mjs';
import { priceCall, requestsFor } from './price.mjs';

const ITER_FIELDS = ['iter_seq', 'iter_type', 'model', ...CLASS_COLUMNS];

// Iterations of non-synthetic occurrences, collapsed per (message_id, iter_seq) by maximum (text by
// lexicographic maximum), mirroring the field-wise maximum of the message row itself.
const COLLAPSED_ITERS = `
SELECT i.message_id, i.iter_seq, max(i.iter_type) AS iter_type, max(i.model) AS model,
       ${CLASS_COLUMNS.map((c) => `max(i.${c}) AS ${c}`).join(', ')}
  FROM s.cc_message_iter i
  JOIN s.cc_message m ON m.session_id = i.session_id AND m.agent_id = i.agent_id AND m.message_id = i.message_id
 WHERE m.model IS NOT '${SYNTHETIC_MODEL}'
 GROUP BY i.message_id, i.iter_seq`;

const rowsSql = (ownerRule) => `
SELECT d.*, it.iters
  FROM (${dedupSelectSql(ownerRule)}) d
  LEFT JOIN (
    SELECT message_id, json_group_array(json_array(${ITER_FIELDS.join(', ')})) AS iters
      FROM (${COLLAPSED_ITERS})
     GROUP BY message_id
  ) it ON it.message_id = d.message_id
 ORDER BY d.message_id`;

const INSERT_CALL = `
INSERT INTO api_call (
  call_key, message_id, owner_session_id, owner_agent_id, occurrences, request_id, ts_utc, model,
  role, role_rule, role_source, role_meta, role_conflict, effort, join_state, price_basis,
  iter_mismatch, iter_unknown_type, token_label, speed, service_tier, inference_geo, server_tool_use,
  cost_nano, cost_floor, cost_label)
VALUES (
  $call_key, $message_id, $owner_session_id, $owner_agent_id, $occurrences, $request_id, $ts_utc, $model,
  $role, $role_rule, $role_source, $role_meta, $role_conflict, $effort, 'transcript_only', $price_basis,
  $iter_mismatch, $iter_unknown_type, 'transcript', $speed, $service_tier, $inference_geo, $server_tool_use,
  $cost_nano, $cost_floor, $cost_label)`;

const PRICE_COLUMNS = ['price_model', 'price_status', 'price_tier', 'geo_us', 'cost_nano', 'cost_floor', 'floor_reason', 'price_version'];
const INSERT_PART = `
INSERT INTO api_call_part (call_key, part_seq, kind, model, ${CLASS_COLUMNS.join(', ')}, ${PRICE_COLUMNS.join(', ')})
VALUES ($call_key, $part_seq, $kind, $model, ${CLASS_COLUMNS.map((c) => `$${c}`).join(', ')}, ${PRICE_COLUMNS.map((c) => `$${c}`).join(', ')})`;

// Store-side totals per class, computed from the store snapshot with SQL that does not use the part
// builder: executor = the field-wise maximum per message id; advisor = the collapsed advisor_message
// iterations of calls with iterations, grouped per (message id, model) with NULL propagation. Each leg
// gives a known sum (NULL terms left out) and a known count.
const storeTotalsSql = (c) => `
WITH occ AS (
  SELECT message_id, has_iterations, ${c} FROM s.cc_message WHERE model IS NOT '${SYNTHETIC_MODEL}'
),
calls AS (
  SELECT message_id, max(has_iterations) AS has_iterations, max(${c}) AS v FROM occ GROUP BY message_id
),
adv AS (
  SELECT ci.message_id, ci.model, CASE WHEN count(ci.${c}) = count(*) THEN sum(ci.${c}) END AS v
    FROM (${COLLAPSED_ITERS}) ci
    JOIN calls ON calls.message_id = ci.message_id AND calls.has_iterations = 1
   WHERE ci.iter_type = 'advisor_message'
   GROUP BY ci.message_id, ci.model
)
SELECT (SELECT sum(v) FROM calls) AS exec_sum, (SELECT count(v) FROM calls) AS exec_known,
       (SELECT sum(v) FROM adv) AS adv_sum, (SELECT count(v) FROM adv) AS adv_known`;

function storeTotals(db) {
  const out = {};
  for (const c of CLASS_COLUMNS) {
    const r = db.prepare(storeTotalsSql(c)).get();
    const known = r.exec_known + r.adv_known;
    const terms = [r.exec_sum, r.adv_sum].filter((v) => v !== null);
    out[c] = { sum: known > 0 ? terms.reduce((a, b) => a + b, 0) : null, known };
  }
  return out;
}

function parseIters(text) {
  if (text === null || text === undefined) return [];
  return JSON.parse(text)
    .map((a) => Object.fromEntries(ITER_FIELDS.map((f, i) => [f, a[i]])))
    .sort((x, y) => x.iter_seq - y.iter_seq);
}

// opts: { db, ownerRule, passVersion, builtUtc, storeFingerprint, storeUserVersion, prices }
// prices: the object from loadPrices (src/derive/price-table.mjs) or null for no table, in which case every
// part is priced no_table with a NULL cost.
export function fillDerived({
  db, ownerRule, passVersion, builtUtc, storeFingerprint, storeUserVersion, prices = null,
}) {
  const table = prices ? prices.table : null;
  const priceVersion = prices ? prices.version : null;
  const insertCall = db.prepare(INSERT_CALL);
  const insertPart = db.prepare(INSERT_PART);
  const n = {
    calls: 0, parts: 0, duplicates: 0, topLevelOnly: 0, mismatch: 0, unknownType: 0, conflict: 0, cacheSplit: 0,
  };
  for (const row of db.prepare(rowsSql(ownerRule)).iterate()) {
    const callKey = `m:${row.message_id}`;
    const role = resolveRole({ attribution: row.attribution_agent, metaType: row.meta_agent_type, agentId: row.owner_agent_id });
    const iterations = parseIters(row.iters);
    const built = buildParts({
      callModel: row.model, tokens: row, hasIterations: row.has_iterations, iterations,
    });
    // Each part is priced at its own model; its requests are the call's iterations of its kind (only
    // when the call carries iterations, mirroring buildParts), or the part itself.
    const call = { iterations: row.has_iterations ? iterations : [] };
    const priced = priceCall(
      built.parts.map((p) => ({ ...p, requests: requestsFor(p, call) })),
      {
        speed: row.speed, serviceTier: row.service_tier, inferenceGeo: row.inference_geo, serverToolUse: row.has_server_tool_use,
      },
      table,
    );
    insertCall.run({
      call_key: callKey,
      message_id: row.message_id,
      owner_session_id: row.owner_session_id,
      owner_agent_id: row.owner_agent_id,
      occurrences: row.occurrences,
      request_id: row.request_id,
      ts_utc: row.ts_utc,
      model: row.model,
      role: role.role,
      role_rule: role.rule,
      role_source: role.source,
      role_meta: role.meta,
      role_conflict: role.conflict,
      effort: row.effort,
      price_basis: built.priceBasis,
      iter_mismatch: built.iterMismatch,
      iter_unknown_type: built.iterUnknownType,
      speed: row.speed,
      service_tier: row.service_tier,
      inference_geo: row.inference_geo,
      server_tool_use: row.has_server_tool_use,
      cost_nano: priced.costNano,
      cost_floor: priced.floor ? 1 : 0,
      cost_label: priced.label,
    });
    built.parts.forEach((p, i) => {
      const r = priced.parts[i];
      insertPart.run({
        call_key: callKey,
        ...p,
        price_model: r.priceModel,
        price_status: r.status,
        price_tier: r.tier,
        geo_us: r.geoUs,
        cost_nano: r.costNano,
        cost_floor: r.floor ? 1 : 0,
        floor_reason: r.floorReason,
        price_version: priceVersion,
      });
    });
    n.calls += 1;
    n.parts += built.parts.length;
    n.duplicates += row.occurrences - 1;
    if (built.priceBasis === 'top_level_only') n.topLevelOnly += 1;
    n.mismatch += built.iterMismatch;
    n.unknownType += built.iterUnknownType;
    if (role.conflict === 1) n.conflict += 1;
    n.cacheSplit += built.cacheSplitMismatch;
  }

  const synthetic = db.prepare(`SELECT count(*) AS n FROM s.cc_message WHERE model = '${SYNTHETIC_MODEL}'`).get().n;
  const fresh = db.prepare('SELECT (SELECT max(ts_utc) FROM s.cc_message) AS newest, (SELECT max(ended_utc) FROM s.ingest_run) AS last_end').get();
  const totals = storeTotals(db);
  const cols = {
    id: 1,
    built_utc: builtUtc,
    pass_version: passVersion,
    store_user_version: storeUserVersion,
    store_fingerprint: storeFingerprint,
    owner_rule: ownerRule,
    newest_record_utc: fresh.newest,
    last_run_end_utc: fresh.last_end,
    api_call_rows: n.calls,
    api_call_part_rows: n.parts,
    duplicate_occurrences: n.duplicates,
    synthetic_skipped: synthetic,
    top_level_only_calls: n.topLevelOnly,
    iter_mismatch_calls: n.mismatch,
    iter_unknown_type_calls: n.unknownType,
    role_conflict_calls: n.conflict,
    cache_split_mismatch_parts: n.cacheSplit,
    price_file: prices ? prices.file : null,
    price_date_read: prices ? prices.dateRead : null,
    price_sha: prices ? prices.sha : null,
  };
  for (const c of CLASS_COLUMNS) {
    cols[`store_${c}_sum`] = totals[c].sum;
    cols[`store_${c}_known`] = totals[c].known;
  }
  const names = Object.keys(cols);
  db.prepare(`INSERT INTO derive_state (${names.join(', ')}) VALUES (${names.map((k) => `$${k}`).join(', ')})`).run(cols);
  return { calls: n.calls, parts: n.parts };
}
