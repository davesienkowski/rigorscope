// store.db schema version 4: usage snapshots of the subscription windows (plan 01-06, D-11a, DATA-03).
//
// usage_snapshot  one row per distinct (source, fetched_at_ms): source claude-json-cache (the cache in the
//                 main Claude Code config file, label measured) or transcript (a usageReport line, label
//                 transcript). Each window percentage is a REAL from 0 to 100 and is NULL exactly when its
//                 reset instant is NULL. first_run_id is the ingest run that first stored the row.
// usage_limit     the limit entries of a snapshot, keyed (snapshot_id, seq). The word group is reserved in
//                 SQL, so the column is grp. severity is filled from transcript reports only.
// Only the allowlisted pick is stored: no money, identity, token, session, scope or path column exists, and
// a new stored field needs a pick entry first (RR-03). Both tables are STRICT; NULL means unknown, never 0.
export const version = 4;

const win = (w) => `
  ${w}_pct        REAL CHECK (${w}_pct IS NULL OR (${w}_pct >= 0 AND ${w}_pct <= 100)),
  ${w}_resets_ms  INTEGER,`;
const tie = (w) => `  CHECK ((${w}_pct IS NULL) = (${w}_resets_ms IS NULL))`;
const WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

export const sql = `
CREATE TABLE usage_snapshot (
  snapshot_id    INTEGER PRIMARY KEY,
  source         TEXT NOT NULL CHECK (source IN ('claude-json-cache', 'transcript')),
  label          TEXT NOT NULL,
  fetched_at_ms  INTEGER NOT NULL CHECK (fetched_at_ms > 0),
  fetched_utc    TEXT NOT NULL,
  first_run_id   INTEGER REFERENCES ingest_run (run_id),${WINDOWS.map(win).join('')}
  UNIQUE (source, fetched_at_ms),
  CHECK ((source = 'claude-json-cache' AND label = 'measured') OR (source = 'transcript' AND label = 'transcript')),
${WINDOWS.map(tie).join(',\n')}
) STRICT;

CREATE TABLE usage_limit (
  snapshot_id  INTEGER NOT NULL REFERENCES usage_snapshot (snapshot_id),
  seq          INTEGER NOT NULL CHECK (seq >= 0),
  kind         TEXT NOT NULL,
  grp          TEXT,
  percent      REAL NOT NULL CHECK (percent >= 0 AND percent <= 100),
  resets_ms    INTEGER NOT NULL,
  severity     TEXT,
  is_active    INTEGER CHECK (is_active IS NULL OR is_active IN (0, 1)),
  PRIMARY KEY (snapshot_id, seq)
) STRICT;
`;
