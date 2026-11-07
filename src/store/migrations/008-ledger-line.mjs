// store.db schema version 8: the forward ledger's validated lines (phase 3, plan 03-03, D-12, ADR-0011, Proposed).
//
// Adds one table, `ledger_line`: one row per ledger line that the ingest `ledger` source accepted, keyed by the line's
// own line_id (a content hash made by the writer, src/ledger/line.mjs). The ledger file is read only through the one rule
// set the writer uses (validateLine), so a row holds nothing the writer could not have written: no branch, no path other
// than the home-normalized repo key, no prompt, response or command text (ADR-0010). A rejected line, a key outside the
// allowlist and the text of a dropped line are never stored; ingest counts them by closed reason names instead.
//
// The line key `command` is stored as `command_name` (as cc_command does): it holds a command NAME, and the canary
// schema test refuses any column called command.
//
// Rows are insert-or-ignore: a line is never updated or deleted here. line_sha (sha256 of the canonical JSON of the
// validated line) lets the writer tell a re-read of the same line from a second line that reuses a line_id with different
// content; the stored row stays and the clash is counted. The store is the record: removing lines from the file by hand
// does not remove their rows (ADR-0011).
//
// The CHECKs are looser than or equal to validateLine, never stricter, so the code rejects a line first with a counted
// reason and a CHECK is only a backstop (a CHECK failure aborts a whole ingest chunk). Time columns hold the canonical
// UTC form `...sssZ`; unit_key must equal its parts. No existing table is touched, no row is deleted or rewritten, and
// every CREATE carries IF NOT EXISTS so the rewind tests of migrations 005 to 007 run this file harmlessly on a store
// that already has the table. Nothing depends on the environment, the date or the machine.
//
// Section contract (as 007): an ordered list of sections; a later plan appends a section and never edits or reorders an
// earlier one. test/unit/migration-008.test.mjs pins the sha256 of `sql`, so any later store change is a new migration.
export const version = 8;

const HEX = (col, n) => `length(${col}) = ${n} AND ${col} NOT GLOB '*[^0-9a-f]*'`;
const ISO = (col) => `${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'`;
const PRINTABLE = (col, max) => `length(${col}) BETWEEN 1 AND ${max} AND ${col} NOT GLOB '*[^ -~]*'`;

const LEDGER_LINE = `
CREATE TABLE IF NOT EXISTS ledger_line (
  line_id        TEXT NOT NULL PRIMARY KEY CHECK (${HEX('line_id', 32)}),
  line_sha       TEXT NOT NULL CHECK (${HEX('line_sha', 64)}),
  v              INTEGER NOT NULL CHECK (v = 1),
  record         TEXT NOT NULL CHECK (record IN ('start', 'close')),
  ts_utc         TEXT NOT NULL CHECK (${ISO('ts_utc')}),
  unit_key       TEXT NOT NULL CHECK (${PRINTABLE('unit_key', 1200)}),
  framework      TEXT NOT NULL CHECK (length(framework) BETWEEN 1 AND 32 AND framework NOT GLOB '*[^a-z0-9-]*'),
  repo_key       TEXT NOT NULL CHECK (${PRINTABLE('repo_key', 1024)}),
  kind           TEXT NOT NULL CHECK (kind IN ('quick', 'plan')),
  native_id      TEXT NOT NULL CHECK (length(native_id) BETWEEN 1 AND 64 AND native_id NOT GLOB '*[^A-Za-z0-9._-]*'),
  tier           TEXT CHECK (tier IS NULL OR tier IN ('A', 'B', 'C')),
  tier_source    TEXT CHECK (tier_source IS NULL OR tier_source IN ('declared-at-start', 'plan-at-start', 'declared-at-close', 'unknown')),
  command_name   TEXT CHECK (command_name IS NULL OR (length(command_name) BETWEEN 1 AND 64 AND command_name NOT GLOB '*[^A-Za-z0-9:_.-]*')),
  runtime        TEXT CHECK (runtime IS NULL OR (length(runtime) BETWEEN 1 AND 32 AND runtime NOT GLOB '*[^a-z0-9-]*')),
  session_id     TEXT CHECK (session_id IS NULL OR (length(session_id) BETWEEN 1 AND 128 AND session_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
  model_hint     TEXT CHECK (model_hint IS NULL),
  start_utc      TEXT CHECK (start_utc IS NULL OR ${ISO('start_utc')}),
  end_utc        TEXT CHECK (end_utc IS NULL OR ${ISO('end_utc')}),
  status         TEXT CHECK (status IS NULL OR status IN ('complete', 'failed', 'abandoned')),
  gsd_version    TEXT CHECK (gsd_version IS NULL OR (length(gsd_version) BETWEEN 1 AND 64 AND gsd_version NOT GLOB '*[^0-9A-Za-z.-]*')),
  first_seen_run INTEGER NOT NULL,
  CHECK (unit_key = framework || ':' || repo_key || ':' || kind || ':' || native_id)
) STRICT;

CREATE INDEX IF NOT EXISTS ledger_line_unit_idx ON ledger_line (unit_key, record);
`;

export const SECTIONS = Object.freeze([
  Object.freeze({ id: 'ledger-line', plan: '03-03', sql: LEDGER_LINE }),
]);

export const sql = SECTIONS.map((s) => s.sql).join('\n');

// The object names this migration adds, for the live gate (plan 03-03 Task 4, G4): the automatic index SQLite creates
// for the primary key (sqlite_autoindex_ledger_line_1) is not listed because it is not named here.
export const TABLE_NAMES = Object.freeze(['ledger_line']);
export const INDEX_NAMES = Object.freeze(['ledger_line_unit_idx']);
