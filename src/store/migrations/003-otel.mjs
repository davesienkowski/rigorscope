// store.db schema version 3: the OTel source (D-03, D-05, D-12, DATA-03, RR-08).
//
// otel_event   one row per event, keyed on the FOUR fields (session.id, event.sequence, event.timestamp,
//              event name): the two-field key collides on about 1 percent of real lines. attrs holds the
//              allowlisted, shape-checked attributes as canonical JSON (the stored JSON type per key is
//              the allowlist's type); attrs_sha is the hash of that text. file_id and src_end_offset are
//              first-seen provenance only and are not part of the key.
// otel_metric  one row per metric line, keyed on (ts, metric, attrs_sha, ordinal). Metrics have no
//              sequence, so byte-identical lines in one file are told apart by an ordinal: the count of
//              earlier provenance rows of the same file and base key (see otel_metric_line).
// otel_metric_line  provenance of each kept metric line, keyed by (file_id, src_end_offset), so the
//              ordinal of a line is the same on a re-read, a copy in another file and an append.
// No identity, content or path column exists (RR-03). NULL means unknown, never 0. Every table is STRICT.
export const version = 3;

export const sql = `
CREATE TABLE otel_event (
  session_id     TEXT NOT NULL,
  event_seq      INTEGER NOT NULL CHECK (event_seq >= 0),
  event_ts       TEXT NOT NULL,
  kind           TEXT NOT NULL,
  ts_utc         TEXT NOT NULL,
  prompt_id      TEXT,
  request_id     TEXT,
  tool_use_id    TEXT,
  cc_version     TEXT,
  attrs          TEXT NOT NULL,
  attrs_sha      TEXT NOT NULL,
  file_id        INTEGER REFERENCES source_file (file_id),
  src_end_offset INTEGER,
  PRIMARY KEY (session_id, event_seq, event_ts, kind)
) STRICT;
CREATE INDEX otel_event_request_idx ON otel_event (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX otel_event_kind_idx ON otel_event (kind, session_id);

CREATE TABLE otel_metric (
  ts_utc         TEXT NOT NULL,
  metric         TEXT NOT NULL,
  attrs_sha      TEXT NOT NULL,
  ordinal        INTEGER NOT NULL CHECK (ordinal >= 0),
  value          REAL NOT NULL,
  session_id     TEXT,
  cc_version     TEXT,
  attrs          TEXT NOT NULL,
  file_id        INTEGER REFERENCES source_file (file_id),
  src_end_offset INTEGER,
  PRIMARY KEY (ts_utc, metric, attrs_sha, ordinal)
) STRICT;
CREATE INDEX otel_metric_session_idx ON otel_metric (metric, session_id);

CREATE TABLE otel_metric_line (
  file_id        INTEGER NOT NULL REFERENCES source_file (file_id),
  src_end_offset INTEGER NOT NULL,
  ts_utc         TEXT NOT NULL,
  metric         TEXT NOT NULL,
  attrs_sha      TEXT NOT NULL,
  PRIMARY KEY (file_id, src_end_offset)
) STRICT;
CREATE INDEX otel_metric_line_key_idx ON otel_metric_line (file_id, ts_utc, metric, attrs_sha);
`;
