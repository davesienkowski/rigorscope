// store.db schema version 2: the full transcript ingest (D-03, D-04, D-12, TRUST-05).
//
// Run log: ingest_run gains status, roots, unknown_token_bearing, lock_wait_ms and error_code;
// ingest_source_run (one row per run and source) and ingest_count (name-keyed counters) hold the
// progress `doctor` reads. Cursors: source_root and source_file keep a root alias plus a
// home-normalized relative path and the cursor (offset, size, hashes, first and last record time);
// no absolute path and no content is stored anywhere. Messages: cc_message gains the columns the
// derivation passes read, cc_message_file lists every file a message was seen in, cc_message_iter
// keeps usage.iterations per index, cc_agent_meta keeps the twelve allowlisted sub-agent meta fields,
// unknown_attr records unlisted key NAMES only (shape-checked, never values).
// Every table is STRICT; unknown stays NULL, never 0.
export const version = 2;

const tokenCols = `
  input_tokens   INTEGER CHECK (input_tokens   IS NULL OR input_tokens   >= 0),
  output_tokens  INTEGER CHECK (output_tokens  IS NULL OR output_tokens  >= 0),
  cache_read     INTEGER CHECK (cache_read     IS NULL OR cache_read     >= 0),
  cache_creation INTEGER CHECK (cache_creation IS NULL OR cache_creation >= 0),
  cache_5m       INTEGER CHECK (cache_5m       IS NULL OR cache_5m       >= 0),
  cache_1h       INTEGER CHECK (cache_1h       IS NULL OR cache_1h       >= 0)`;

export const sql = `
ALTER TABLE ingest_run ADD COLUMN status TEXT;
ALTER TABLE ingest_run ADD COLUMN roots INTEGER;
ALTER TABLE ingest_run ADD COLUMN unknown_token_bearing INTEGER;
ALTER TABLE ingest_run ADD COLUMN lock_wait_ms INTEGER;
ALTER TABLE ingest_run ADD COLUMN error_code TEXT;

ALTER TABLE cc_message ADD COLUMN uuid TEXT;
ALTER TABLE cc_message ADD COLUMN is_sidechain INTEGER CHECK (is_sidechain IS NULL OR is_sidechain IN (0, 1));
ALTER TABLE cc_message ADD COLUMN attribution_skill TEXT;
ALTER TABLE cc_message ADD COLUMN per_turn_effort TEXT;
ALTER TABLE cc_message ADD COLUMN advisor_model TEXT;
ALTER TABLE cc_message ADD COLUMN requested_model TEXT;
ALTER TABLE cc_message ADD COLUMN entrypoint TEXT;
ALTER TABLE cc_message ADD COLUMN cwd TEXT;
ALTER TABLE cc_message ADD COLUMN has_iterations INTEGER CHECK (has_iterations IS NULL OR has_iterations IN (0, 1));
ALTER TABLE cc_message ADD COLUMN has_server_tool_use INTEGER CHECK (has_server_tool_use IS NULL OR has_server_tool_use IN (0, 1));

CREATE TABLE source_root (
  root_id        INTEGER PRIMARY KEY,
  source         TEXT NOT NULL,
  alias          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  display        TEXT NOT NULL,
  first_seen_run INTEGER,
  last_seen_run  INTEGER,
  UNIQUE (source, alias)
) STRICT;

CREATE TABLE source_file (
  file_id          INTEGER PRIMARY KEY,
  root_id          INTEGER NOT NULL REFERENCES source_root (root_id),
  rel_path         TEXT NOT NULL,
  kind             TEXT NOT NULL,
  dev              TEXT,
  ino              TEXT,
  size             INTEGER,
  mtime_ms         INTEGER,
  offset           INTEGER NOT NULL DEFAULT 0,
  head_hash        TEXT,
  tail_hash        TEXT,
  state            TEXT,
  first_record_utc TEXT,
  last_record_utc  TEXT,
  last_seen_run    INTEGER,
  last_read_run    INTEGER,
  UNIQUE (root_id, rel_path)
) STRICT;

CREATE TABLE cc_message_file (
  session_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  message_id TEXT NOT NULL,
  file_id    INTEGER NOT NULL REFERENCES source_file (file_id),
  PRIMARY KEY (session_id, agent_id, message_id, file_id),
  FOREIGN KEY (session_id, agent_id, message_id) REFERENCES cc_message (session_id, agent_id, message_id)
) STRICT;

CREATE TABLE cc_message_iter (
  session_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  message_id TEXT NOT NULL,
  iter_seq   INTEGER NOT NULL CHECK (iter_seq >= 0),
  iter_type  TEXT,
  model      TEXT,${tokenCols},
  PRIMARY KEY (session_id, agent_id, message_id, iter_seq),
  FOREIGN KEY (session_id, agent_id, message_id) REFERENCES cc_message (session_id, agent_id, message_id)
) STRICT;

CREATE TABLE cc_agent_meta (
  session_id               TEXT NOT NULL,
  agent_id                 TEXT NOT NULL,
  agent_type               TEXT,
  spawn_depth              INTEGER CHECK (spawn_depth IS NULL OR spawn_depth >= 0),
  model                    TEXT,
  tool_use_id              TEXT,
  parent_agent_id          TEXT,
  is_fork                  INTEGER CHECK (is_fork IS NULL OR is_fork IN (0, 1)),
  workflow_phase           TEXT,
  finished                 INTEGER CHECK (finished IS NULL OR finished IN (0, 1)),
  spawned_with_worktree    INTEGER CHECK (spawned_with_worktree IS NULL OR spawned_with_worktree IN (0, 1)),
  stopped_by_user          INTEGER CHECK (stopped_by_user IS NULL OR stopped_by_user IN (0, 1)),
  launched_with_defaults   INTEGER CHECK (launched_with_defaults IS NULL OR launched_with_defaults IN (0, 1)),
  request_non_interactive  INTEGER CHECK (request_non_interactive IS NULL OR request_non_interactive IN (0, 1)),
  file_id                  INTEGER REFERENCES source_file (file_id),
  PRIMARY KEY (session_id, agent_id)
) STRICT;

CREATE TABLE ingest_source_run (
  run_id                 INTEGER NOT NULL REFERENCES ingest_run (run_id),
  source                 TEXT NOT NULL,
  files                  INTEGER,
  files_new              INTEGER,
  files_reread           INTEGER,
  files_unchanged        INTEGER,
  files_skipped          INTEGER,
  bytes_read             INTEGER,
  lines_read             INTEGER,
  assistant_parsed       INTEGER,
  rows_upserted          INTEGER,
  unparseable            INTEGER,
  oversized              INTEGER,
  unknown_token_bearing  INTEGER,
  deferred_token_bearing INTEGER,
  pending_tail_bytes     INTEGER,
  newest_record_utc      TEXT,
  PRIMARY KEY (run_id, source)
) STRICT;

CREATE TABLE ingest_count (
  run_id INTEGER NOT NULL REFERENCES ingest_run (run_id),
  source TEXT NOT NULL,
  kind   TEXT NOT NULL,
  name   TEXT NOT NULL,
  n      INTEGER NOT NULL CHECK (n >= 0),
  PRIMARY KEY (run_id, source, kind, name)
) STRICT;

CREATE TABLE unknown_attr (
  source       TEXT NOT NULL,
  scope        TEXT NOT NULL,
  name         TEXT NOT NULL,
  first_run_id INTEGER,
  last_run_id  INTEGER,
  last_run_n   INTEGER,
  PRIMARY KEY (source, scope, name)
) STRICT;
`;
