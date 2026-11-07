// The ledger source descriptor (plan 03-03, D-12, ADR-0011; see src/ingest/sources.mjs for the contract). One unit: the
// forward ledger file <HOME>/.rigorscope/ledger/units.jsonl that `unit-start` and `unit-close` append to (plan 03-01).
// It is read through the cursor framework, so a second run reads nothing, an appended line is read from the stored
// offset, a final line without LF waits for its LF, and a replaced or truncated file is reread from 0 (the writer's
// insert-or-ignore on line_id makes a reread harmless).
//
// The reader cap is 8192 bytes a line, looser than the writer's MAX_LINE_BYTES (2048), so the code that knows the rules
// rejects first (R3); a longer line is counted `oversized`.
// A line is stored only after validateLine (src/ledger/line.mjs, the one rule set the writer uses) accepted it.
//
// Counter mapping onto the per-source columns of ingest_source_run (documented in docs/cli.md). Every item the reader
// yields gets exactly ONE outcome (J12), so for a run: lines_read = blank + oversized + unparseable + sum(dropped) + kept.
//   blank        ingest_count lines/blank          an empty line (not a candidate)
//   oversized    counter oversized                 a line above the 8192-byte cap (not a candidate)
//   unparseable  counter unparseable               not JSON (shown by doctor as bad_json; never also a dropped row)
//   dropped      ingest_count dropped/<reason>     not_object, unknown_version, or a REJECT_REASONS code of validateLine
//   kept         ingest_count lines/kept and counter kept   a line handed to the writer (printed as "kept=")
//   assistant_parsed   every parsed object of version 1 (kept plus the REJECT_REASONS drops)
//   rows_upserted      rows newly inserted; kept minus rows_upserted were lines already stored
//   conflict/key_conflict   write side: a stored line_id met a line with different content (a subset of kept; the
//                           stored row stays), so rows_upserted + key_conflict <= kept
//   rejected_field    keys outside the allowlist, by shape-checked name or `?`, at most MAX_UNKNOWN_NAMES names a run
// No rejected value, no key value and no text of a dropped line is stored or printed.
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../../db.mjs';
import { canonicalJson } from '../../env/snapshot.mjs';
import { readLinesFrom } from '../../ingest/lines.mjs';
import { LEDGER_DIR, LEDGER_FILE } from '../../ledger/append.mjs';
import { LINE_FIELDS, validateLine } from '../../ledger/line.mjs';
import { checkShape } from '../../redact/shapes.mjs';
import { MAX_UNKNOWN_NAMES } from '../transcript/normalize.mjs';
import { createWriter } from './write.mjs';

export { createWriter };

export const name = 'ledger';
// Not live: an idle or unused ledger must never make a report STALE (state `not_rated`).
export const freshness = { live: false, staleAfterHours: 24 };
export const MAX_LEDGER_LINE_BYTES = 8192;
export const ROOT_ALIAS = 'state';
export const ROOT_DISPLAY = '~/.rigorscope/ledger';

// lstat only: a symlinked directory or file is skipped and counted, never opened through.
export function discover(ctx) {
  const dir = join(stateDir(ctx.home), LEDGER_DIR);
  const check = (p, wantDir) => {
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
      ctx.tally('walk_skip', 'unreadable');
      return false;
    }
    if (st.isSymbolicLink()) { ctx.tally('walk_skip', 'symlink'); return false; }
    if (wantDir ? !st.isDirectory() : !st.isFile()) { ctx.tally('walk_skip', 'not_regular'); return false; }
    return true;
  };
  if (!check(dir, true)) return { roots: [], units: [] };
  const abs = join(dir, LEDGER_FILE);
  if (!check(abs, false)) return { roots: [], units: [] };
  return {
    roots: [{ alias: ROOT_ALIAS, display: ROOT_DISPLAY, kind: 'ledger' }],
    units: [{ rootAlias: ROOT_ALIAS, rel: LEDGER_FILE, abs, kind: 'ledger' }],
  };
}

export function read(unit, start, opts = {}) {
  return readLinesFrom(unit.abs, start, { ...opts, maxLineBytes: Math.min(opts.maxLineBytes ?? MAX_LEDGER_LINE_BYTES, MAX_LEDGER_LINE_BYTES) });
}

const canonicalTime = (v) => (v === null ? null : new Date(Date.parse(v)).toISOString());

// A validated line -> the ledger_line columns (ts -> ts_utc, start -> start_utc, end -> end_utc, command -> command_name; times in canonical form).
export function rowOf(line) {
  return {
    line_id: line.line_id,
    line_sha: createHash('sha256').update(canonicalJson(line)).digest('hex'),
    v: line.v,
    record: line.record,
    ts_utc: canonicalTime(line.ts),
    unit_key: line.unit_key,
    framework: line.framework,
    repo_key: line.repo_key,
    kind: line.kind,
    native_id: line.native_id,
    tier: line.tier,
    tier_source: line.tier_source,
    command_name: line.command,
    runtime: line.runtime,
    session_id: line.session_id,
    model_hint: line.model_hint,
    start_utc: canonicalTime(line.start),
    end_utc: canonicalTime(line.end),
    status: line.status,
    gsd_version: line.gsd_version,
  };
}

// At most MAX_UNKNOWN_NAMES distinct key names per run; the rest fall into the question-mark bucket.
const seenNames = new WeakMap();
function keyNameOf(ctx, key) {
  if (checkShape('name', key) === undefined) return '?';
  let set = seenNames.get(ctx);
  if (!set) { set = new Set(); seenNames.set(ctx, set); }
  if (set.has(key)) return key;
  if (set.size >= MAX_UNKNOWN_NAMES) return '?';
  set.add(key);
  return key;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function normalize(item, unit, ctx) {
  if (item.oversized) {
    ctx.tally('counter', 'oversized');
    return { records: [] };
  }
  const text = item.buf.toString('utf8');
  if (text.trim() === '') {
    ctx.tally('lines', 'blank');
    return { records: [] };
  }
  ctx.tally('counter', 'candidates');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    ctx.tally('counter', 'unparseable');
    return { records: [] };
  }
  if (!isPlainObject(parsed)) {
    ctx.tally('dropped', 'not_object');
    return { records: [] };
  }
  if (parsed.v !== 1) {
    ctx.tally('dropped', 'unknown_version');
    return { records: [] };
  }
  ctx.tally('counter', 'assistant_parsed');
  // Keys outside the allowlist are removed and counted by name; only allowlisted own keys reach validateLine.
  const known = {};
  for (const k of Object.keys(parsed)) {
    if (LINE_FIELDS.includes(k)) known[k] = parsed[k];
    else ctx.tally('rejected_field', keyNameOf(ctx, k));
  }
  const checked = validateLine(known);
  if (!checked.ok) {
    ctx.tally('dropped', checked.reason);
    return { records: [] };
  }
  ctx.tally('counter', 'kept');
  ctx.tally('lines', 'kept');
  const record = { kind: 'ledger_line', row: rowOf(checked.line), end: item.end, onConflict: () => ctx.tally('conflict', 'key_conflict') };
  return { records: [record], ts: record.row.ts_utc };
}
