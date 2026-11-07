// Prepared-statement writer for the OTel source (DATA-03, RR-04, RR-08). Every column is bound
// explicitly (NULL when absent).
//   events:   INSERT OR IGNORE on the four-field key; when the key exists, the stored attrs_sha is
//             compared and a different one is a CONFLICT (counted by the caller, the stored row stays)
//   metrics:  the ordinal of a line is the count of earlier provenance rows (same file, ts, metric and
//             attrs_sha, smaller line end offset), read BEFORE the provenance row of this line is
//             inserted; the provenance insert is idempotent on (file_id, src_end_offset), so a re-read,
//             a copy in another file and an append all give the same ordinal for the same line
//   reread:   provenance holds the metric lines of the LAST FULL PASS of a file. When the runner rereads a file
//             from offset 0 (truncated, replaced or rewritten, for example by the preserve scrub, which moves
//             line offsets), it first calls onReread(fileId) inside the same transaction, before any write:
//             the file's otel_metric_line rows are deleted, so the ordinal of a later byte-identical line never
//             counts a stale row of the earlier pass (plan 01-12, WR-02). otel_metric and otel_event rows are
//             never deleted; the reread finds them again by their natural keys.
const EVENT_SQL = `
INSERT OR IGNORE INTO otel_event (session_id, event_seq, event_ts, kind, ts_utc, prompt_id, request_id, tool_use_id, cc_version,
                                  attrs, attrs_sha, file_id, src_end_offset)
VALUES ($session_id, $event_seq, $event_ts, $kind, $ts_utc, $prompt_id, $request_id, $tool_use_id, $cc_version,
        $attrs, $attrs_sha, $file_id, $src_end_offset)`;

const EVENT_SHA_SQL = `
SELECT attrs_sha FROM otel_event WHERE session_id = $session_id AND event_seq = $event_seq AND event_ts = $event_ts AND kind = $kind`;

const ORDINAL_SQL = `
SELECT count(*) AS n FROM otel_metric_line
WHERE file_id = $file_id AND ts_utc = $ts_utc AND metric = $metric AND attrs_sha = $attrs_sha AND src_end_offset < $src_end_offset`;

const LINE_SQL = `
INSERT OR IGNORE INTO otel_metric_line (file_id, src_end_offset, ts_utc, metric, attrs_sha)
VALUES ($file_id, $src_end_offset, $ts_utc, $metric, $attrs_sha)`;

const METRIC_SQL = `
INSERT OR IGNORE INTO otel_metric (ts_utc, metric, attrs_sha, ordinal, value, session_id, cc_version, attrs, file_id, src_end_offset)
VALUES ($ts_utc, $metric, $attrs_sha, $ordinal, $value, $session_id, $cc_version, $attrs, $file_id, $src_end_offset)`;

const DROP_LINES_SQL = 'DELETE FROM otel_metric_line WHERE file_id = $file_id';

const METRIC_VALUE_SQL = `
SELECT value FROM otel_metric WHERE ts_utc = $ts_utc AND metric = $metric AND attrs_sha = $attrs_sha AND ordinal = $ordinal`;

// write(record, fileId) -> number of rows newly inserted (what ingest_source_run.rows_upserted counts).
export function createWriter(db) {
  const insEvent = db.prepare(EVENT_SQL);
  const selEventSha = db.prepare(EVENT_SHA_SQL);
  const countBefore = db.prepare(ORDINAL_SQL);
  const insLine = db.prepare(LINE_SQL);
  const insMetric = db.prepare(METRIC_SQL);
  const selValue = db.prepare(METRIC_VALUE_SQL);
  const dropLines = db.prepare(DROP_LINES_SQL);

  function writeEvent(row, loc) {
    const key = { session_id: row.sessionId, event_seq: row.seq, event_ts: row.eventTs, kind: row.kind };
    const res = insEvent.run({
      ...key,
      ts_utc: row.tsUtc,
      prompt_id: row.promptId ?? null,
      request_id: row.requestId ?? null,
      tool_use_id: row.toolUseId ?? null,
      cc_version: row.ccVersion ?? null,
      attrs: row.attrsJson,
      attrs_sha: row.attrsSha,
      file_id: loc.file_id ?? null,
      src_end_offset: loc.src_end_offset ?? null,
    });
    if (Number(res.changes) > 0) return { inserted: 1, conflict: false };
    const stored = selEventSha.get(key);
    // INSERT OR IGNORE also skips a row that violates a CHECK; a row that is neither stored nor inserted must not vanish silently.
    if (stored === undefined) throw new Error('otel_event row rejected by the schema');
    return { inserted: 0, conflict: stored.attrs_sha !== row.attrsSha };
  }

  function writeMetric(row, loc) {
    const base = { ts_utc: row.tsUtc, metric: row.metric, attrs_sha: row.attrsSha };
    const ordinal = countBefore.get({ ...base, file_id: loc.file_id, src_end_offset: loc.src_end_offset }).n;
    insLine.run({ ...base, file_id: loc.file_id, src_end_offset: loc.src_end_offset });
    const res = insMetric.run({
      ...base,
      ordinal,
      value: row.value,
      session_id: row.sessionId ?? null,
      cc_version: row.ccVersion ?? null,
      attrs: row.attrsJson,
      file_id: loc.file_id,
      src_end_offset: loc.src_end_offset,
    });
    if (Number(res.changes) > 0) return { inserted: 1, conflict: false };
    const stored = selValue.get({ ...base, ordinal });
    if (stored === undefined) throw new Error('otel_metric row rejected by the schema');
    return { inserted: 0, conflict: stored.value !== row.value };
  }

  return {
    writeEvent,
    writeMetric,
    // Called by the runner once per reread of a file, in the first transaction of that pass, before any write.
    onReread(fileId) {
      dropLines.run({ file_id: fileId });
    },
    write(rec, fileId) {
      const loc = { file_id: fileId, src_end_offset: rec.end };
      const res = rec.kind === 'metric' ? writeMetric(rec.row, loc) : writeEvent(rec.row, loc);
      if (res.conflict && typeof rec.onConflict === 'function') rec.onConflict();
      return res.inserted;
    },
  };
}
