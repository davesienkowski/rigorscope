// store.db schema version 1 (DATA-02, DATA-05, RR-03, RR-04).
//
// Two STRICT tables. Unknown stays NULL, never a default of 0. cc_message has no path, cwd or
// content column on purpose: every stored column must have an entry in the transcript allowlist
// (src/sources/transcript/normalize.mjs), and a canary test asserts the two sets are equal.
// agent_id is the empty string for a main-thread line (a line with no agentId).
export const version = 1;

export const sql = `
CREATE TABLE ingest_run (
  run_id          INTEGER PRIMARY KEY,
  started_utc     TEXT NOT NULL,
  ended_utc       TEXT,
  trigger         TEXT NOT NULL,
  files           INTEGER,
  lines_read      INTEGER,
  assistant_lines INTEGER,
  rows_upserted   INTEGER,
  unparseable     INTEGER
) STRICT;

CREATE TABLE cc_message (
  session_id        TEXT NOT NULL,
  agent_id          TEXT NOT NULL DEFAULT '',
  message_id        TEXT NOT NULL,
  request_id        TEXT,
  ts_utc            TEXT,
  model             TEXT,
  attribution_agent TEXT,
  effort            TEXT,
  version           TEXT,
  input_tokens      INTEGER CHECK (input_tokens  IS NULL OR input_tokens  >= 0),
  output_tokens     INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read        INTEGER CHECK (cache_read    IS NULL OR cache_read    >= 0),
  cache_creation    INTEGER CHECK (cache_creation IS NULL OR cache_creation >= 0),
  cache_5m          INTEGER CHECK (cache_5m      IS NULL OR cache_5m      >= 0),
  cache_1h          INTEGER CHECK (cache_1h      IS NULL OR cache_1h      >= 0),
  speed             TEXT,
  service_tier      TEXT,
  inference_geo     TEXT,
  PRIMARY KEY (session_id, agent_id, message_id)
) STRICT;
`;
