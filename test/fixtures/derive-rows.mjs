// Direct-row helpers for the derivation tests (plan 01-04). A helper, not a test: it is never collected
// by the quoted test glob. It writes rows straight into a store.db (no ingest), reads derived.db
// defensively, and recounts tokens from the store independently of the derivation code.
//
// Independence rule: this file imports nothing from src/derive. tokenTotalsFromStore is the
// independent recount the conservation test compares the derived parts with; it is written from the
// store tables directly and never calls the part builder, the owner rule or the dedup SQL.
import { createHash } from 'node:crypto';
import { openStore } from '../../src/db.mjs';

export const CLASSES = ['input_tokens', 'output_tokens', 'cache_read', 'cache_creation', 'cache_5m', 'cache_1h'];
export const SYNTHETIC = '<synthetic>';

// Opens (creating) the store of a temporary HOME with every migration applied.
export function openTempStore({ home }) {
  return openStore({ home });
}

const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);

// INSERT binding every column of the table explicitly (NULL when absent from row).
function insertAll(db, table, row) {
  const cols = columnsOf(db, table);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return db.prepare(sql).run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
}

// Creates the source_root on demand and the source_file row; returns file_id.
export function insertFile(db, {
  source = 'transcript', alias = 'claude', rel_path, kind = 'session', first_record_utc = null, last_record_utc = null,
}) {
  let root = db.prepare('SELECT root_id FROM source_root WHERE source = ? AND alias = ?').get(source, alias);
  if (!root) {
    db.prepare('INSERT INTO source_root (source, alias, kind, display) VALUES (?, ?, ?, ?)').run(source, alias, 'config', `~/.${alias}`);
    root = db.prepare('SELECT root_id FROM source_root WHERE source = ? AND alias = ?').get(source, alias);
  }
  const have = db.prepare('SELECT file_id FROM source_file WHERE root_id = ? AND rel_path = ?').get(root.root_id, rel_path);
  if (have) return have.file_id;
  insertAll(db, 'source_file', {
    root_id: root.root_id, rel_path, kind, offset: 0, first_record_utc, last_record_utc,
  });
  return db.prepare('SELECT file_id FROM source_file WHERE root_id = ? AND rel_path = ?').get(root.root_id, rel_path).file_id;
}

// row: cc_message columns (session_id, agent_id, message_id required; agent_id defaults to '';
// has_server_tool_use defaults to 0, what the normalizer stores for a line without the server_tool_use key, since
// plan 01-12 made NULL mean an unknown count) plus an optional `files` list of insertFile arguments, each linked
// through cc_message_file.
export function insertMessage(db, row) {
  const { files = [], ...cols } = row;
  const r = { agent_id: '', has_server_tool_use: 0, ...cols };
  insertAll(db, 'cc_message', r);
  for (const f of files) {
    const fileId = insertFile(db, f);
    db.prepare('INSERT OR IGNORE INTO cc_message_file (session_id, agent_id, message_id, file_id) VALUES (?, ?, ?, ?)')
      .run(r.session_id, r.agent_id, r.message_id, fileId);
  }
}

export function insertIter(db, row) {
  insertAll(db, 'cc_message_iter', { agent_id: '', ...row });
}

export function insertMeta(db, row) {
  insertAll(db, 'cc_agent_meta', row);
}

// Rows of a query, or [] when the table or column does not exist yet (so a RED run fails on an
// assertion about rows, never on a SQL error). Rows are spread: node:sqlite rows have a null prototype.
export function queryOrEmpty(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params).map((r) => ({ ...r }));
  } catch (err) {
    if (/no such (table|column)/.test(String(err?.message))) return [];
    throw err;
  }
}

// sha256 over canonical JSON of api_call and api_call_part (ordered by key) and derive_state without
// built_utc. Equal digests mean equal derived content.
export function derivedDigest(db) {
  const calls = queryOrEmpty(db, 'SELECT * FROM api_call ORDER BY call_key');
  const parts = queryOrEmpty(db, 'SELECT * FROM api_call_part ORDER BY call_key, part_seq');
  const state = queryOrEmpty(db, 'SELECT * FROM derive_state').map(({ built_utc: _b, ...rest }) => rest);
  const canon = (rows) => rows.map((r) => Object.keys(r).sort().map((k) => [k, r[k]]));
  return createHash('sha256').update(JSON.stringify([canon(calls), canon(parts), canon(state)])).digest('hex');
}

// The independent recount, per class: { sum, known } where
//   sum   = (sum over distinct message ids of the maximum over that id's non-synthetic occurrences)
//         + (sum of advisor_message iteration rows, collapsed by maximum per (message id, iter_seq))
//   known = how many of those terms were known (NULL terms are left out of sum, never counted as 0)
// The occurrence filter keeps a NULL model (only the literal synthetic marker is skipped).
export function tokenTotalsFromStore(db) {
  const out = {};
  for (const c of CLASSES) {
    const exec = db.prepare(`
      SELECT sum(v) AS sum, count(v) AS known FROM (
        SELECT max(${c}) AS v FROM cc_message
         WHERE model IS NOT '${SYNTHETIC}'
         GROUP BY message_id)`).get();
    const adv = db.prepare(`
      SELECT sum(v) AS sum, count(v) AS known FROM (
        SELECT max(i.${c}) AS v FROM cc_message_iter i
         WHERE i.iter_type = 'advisor_message'
         GROUP BY i.message_id, i.iter_seq)`).get();
    const parts = [exec.sum, adv.sum].filter((v) => v !== null);
    out[c] = { sum: parts.length ? parts.reduce((a, b) => a + b, 0) : null, known: exec.known + adv.known };
  }
  return out;
}
