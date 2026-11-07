// Prepared-statement writer for the transcript source (D-12, RR-04). Every column is bound
// explicitly (NULL when absent). Streaming messages repeat across lines and across files with growing
// usage, and the last line equals the field-wise maximum (verified on real data), so:
//   integer columns:  coalesce(max(old, new), old, new)   NULL-safe; never sums; a later smaller or
//                                                         NULL value never lowers a stored one
//                     SQLite's scalar max(X, Y) is NULL when either argument is NULL, so the coalesce falls
//                     through to the stored value and then to the incoming one: a reread value replaces a stored
//                     NULL and a NULL never lowers a stored count. Do not simplify this to a bare max(old, new).
//   toolcount columns (has_server_tool_use; review CR-01, RR-04): 1 when either copy is 1, else NULL when either is
//                     NULL, else 0. A copy that reported an unreadable value may hide a count above 0, so a 0 from
//                     another copy never answers for it, in either order; a 1 is never lost. A NULL set by
//                     migration 006 looks like any other NULL, so a reread refills it to 1 only (a reread 0 stays
//                     NULL: over-unknown, never a wrong 0).
//   text columns:     coalesce(old, new)                  keeps the first non-NULL value
//   ts_utc:           the earlier of old and new          by unixepoch(...,'subsec'), NULL-safe (01-04)
// cc_message_file is insert-or-ignore on (key, file_id); cc_agent_meta keeps the latest non-NULL
// value of each column. Table and column names come from the fixed registries below, never from data.
// Plan 02-04 (ADR-0009 A4 and its 2026-10-30 amendment, review CR-01): each planning-file ref of a message record is a
// child row of cc_message_ref, written after the message upsert of the same record (the foreign key) with ON CONFLICT
// (session_id, agent_id, message_id, ref_dir, rel_path) DO UPDATE SET n to the NULL-safe maximum and tool_name to the
// bytewise minimum (SQLite's scalar min on a NOT NULL TEXT column with the BINARY collation), so a message whose tool
// calls sit on several lines stores the same row in any read order; ref_kind follows rel_path. Never the
// ignore-conflict insert form (it also swallows CHECK and NOT NULL violations), and no row is ever deleted.
// A `command` record (a slash-command name of a user line) is one cc_command row, ON CONFLICT (session_id, agent_id,
// uuid) DO NOTHING: the first stored ts_utc and command_name are kept; no cc_message_file row is written for it.
import { ALLOWLIST, ITER_ALLOWLIST } from './normalize.mjs';
import { META_ALLOWLIST } from './meta.mjs';
import { createUsageWriter } from '../usage/write.mjs';

const INT_KINDS = new Set(['count', 'flag', 'presence', 'toolcount']);
const TOOLCOUNT = new Set(ALLOWLIST.filter((e) => e.kind === 'toolcount').map((e) => e.column));
const KEY = ['session_id', 'agent_id', 'message_id'];
const MSG_COLS = ALLOWLIST.map((e) => e.column).filter((c) => !KEY.includes(c));
const MSG_INT = ALLOWLIST.filter((e) => INT_KINDS.has(e.kind)).map((e) => e.column);
const ITER_COLS = ITER_ALLOWLIST.map((e) => e.column);
const ITER_INT = ITER_ALLOWLIST.filter((e) => INT_KINDS.has(e.kind)).map((e) => e.column);
const META_COLS = META_ALLOWLIST.map((e) => e.column);

const maxSet = (table, c) => (TOOLCOUNT.has(c)
  ? `${c} = CASE WHEN ${table}.${c} = 1 OR excluded.${c} = 1 THEN 1
    WHEN ${table}.${c} IS NULL OR excluded.${c} IS NULL THEN NULL ELSE 0 END`
  : `${c} = coalesce(max(${table}.${c}, excluded.${c}), ${table}.${c}, excluded.${c})`);
const firstSet = (table, c) => `${c} = coalesce(${table}.${c}, excluded.${c})`;
// ts_utc is the one text column that is not keep-first (plan 01-04): it keeps the EARLIEST line time,
// compared as a number so ...01Z and ...01.000Z tie, NULL-safe. Keep-first would make it depend on the
// order the lines were read in, and the derivation's owner rule orders by it.
const earliestSet = (table, c) => `${c} = CASE
    WHEN ${table}.${c} IS NULL THEN excluded.${c}
    WHEN excluded.${c} IS NULL THEN ${table}.${c}
    WHEN unixepoch(excluded.${c}, 'subsec') < unixepoch(${table}.${c}, 'subsec') THEN excluded.${c}
    ELSE ${table}.${c} END`;
const EARLIEST = new Set(['ts_utc']);
const setList = (table, cols, ints) => cols.map((c) => {
  if (ints.includes(c)) return maxSet(table, c);
  return EARLIEST.has(c) ? earliestSet(table, c) : firstSet(table, c);
}).join(',\n  ');

const MSG_SQL = `
INSERT INTO cc_message (${[...KEY, ...MSG_COLS].join(', ')})
VALUES (${[...KEY, ...MSG_COLS].map((c) => `$${c}`).join(', ')})
ON CONFLICT (${KEY.join(', ')}) DO UPDATE SET
  ${setList('cc_message', MSG_COLS, MSG_INT)}`;

const ITER_KEY = [...KEY, 'iter_seq'];
const ITER_SQL = `
INSERT INTO cc_message_iter (${[...ITER_KEY, ...ITER_COLS].join(', ')})
VALUES (${[...ITER_KEY, ...ITER_COLS].map((c) => `$${c}`).join(', ')})
ON CONFLICT (${ITER_KEY.join(', ')}) DO UPDATE SET
  ${setList('cc_message_iter', ITER_COLS, ITER_INT)}`;

const FILE_SQL = `
INSERT OR IGNORE INTO cc_message_file (session_id, agent_id, message_id, file_id)
VALUES ($session_id, $agent_id, $message_id, $file_id)`;

const META_SQL = `
INSERT INTO cc_agent_meta (session_id, agent_id, ${META_COLS.join(', ')}, file_id)
VALUES ($session_id, $agent_id, ${META_COLS.map((c) => `$${c}`).join(', ')}, $file_id)
ON CONFLICT (session_id, agent_id) DO UPDATE SET
  ${[...META_COLS.map((c) => `${c} = coalesce(excluded.${c}, cc_agent_meta.${c})`), 'file_id = excluded.file_id'].join(',\n  ')}`;

const REF_SQL = `
INSERT INTO cc_message_ref (session_id, agent_id, message_id, ref_dir, rel_path, ref_kind, tool_name, n)
VALUES ($session_id, $agent_id, $message_id, $ref_dir, $rel_path, $ref_kind, $tool_name, $n)
ON CONFLICT (session_id, agent_id, message_id, ref_dir, rel_path) DO UPDATE SET
  ${maxSet('cc_message_ref', 'n')},
  tool_name = min(cc_message_ref.tool_name, excluded.tool_name)`;

const CMD_SQL = `
INSERT INTO cc_command (session_id, agent_id, uuid, ts_utc, command_name)
VALUES ($session_id, $agent_id, $uuid, $ts_utc, $command_name)
ON CONFLICT (session_id, agent_id, uuid) DO NOTHING`;

const bind = (cols, row) => Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));

// write(record, fileId, runId) -> number of primary rows written (a message or a meta row, or a usage
// snapshot newly inserted: plan 01-06 delegates usageReport snapshots to the usage writer; a command row newly
// inserted, 0 or 1, plan 02-04).
export function createWriter(db) {
  const msg = db.prepare(MSG_SQL);
  const iter = db.prepare(ITER_SQL);
  const file = db.prepare(FILE_SQL);
  const meta = db.prepare(META_SQL);
  // Prepared on the first ref, so a writer on a store below version 7 (the migration tests) still writes messages.
  let ref = null;
  let cmd = null;
  const usage = createUsageWriter(db);
  return {
    write(rec, fileId, runId) {
      if (rec.kind === 'usage_snapshot') return usage.write(rec, fileId, runId);
      if (rec.kind === 'command') {
        cmd ??= db.prepare(CMD_SQL);
        const r = rec.row;
        return Number(cmd.run({
          session_id: r.session_id, agent_id: r.agent_id, uuid: r.uuid, ts_utc: r.ts_utc ?? null, command_name: r.command_name,
        }).changes);
      }
      if (rec.kind === 'meta') {
        meta.run({ session_id: rec.session_id, agent_id: rec.agent_id, ...bind(META_COLS, rec.row), file_id: fileId });
        return 1;
      }
      const row = rec.row;
      msg.run({ session_id: row.session_id, agent_id: row.agent_id, message_id: row.message_id, ...bind(MSG_COLS, row) });
      for (const it of rec.iterations ?? []) {
        iter.run({
          session_id: row.session_id, agent_id: row.agent_id, message_id: row.message_id, iter_seq: it.iter_seq, ...bind(ITER_COLS, it),
        });
      }
      for (const r of rec.refs ?? []) {
        ref ??= db.prepare(REF_SQL);
        ref.run({
          session_id: row.session_id, agent_id: row.agent_id, message_id: row.message_id,
          ref_dir: r.ref_dir, rel_path: r.rel_path, ref_kind: r.ref_kind, tool_name: r.tool_name, n: r.n,
        });
      }
      file.run({ session_id: row.session_id, agent_id: row.agent_id, message_id: row.message_id, file_id: fileId });
      return 1;
    },
  };
}
