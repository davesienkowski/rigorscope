// store.db schema version 5: reread every OTel file once (plan 01-12, WR-02, T-01-23, RR-08).
//
// Before plan 01-12 a reread of a rewritten OTel file (the preserve scrub moves line offsets) left the
// otel_metric_line rows of the earlier pass in place, and those stale provenance rows could feed the ordinal of a
// later byte-identical metric line. The writer now drops a file's provenance in the first transaction of a reread.
// This migration only sets head_hash to NULL on the source_file rows of the otel source: the cursor logic then sees
// a head window that no longer matches, classifies each such file as rewritten, and the next ingest rereads it from
// offset 0 under the fix, which replaces its provenance rows. Nothing is deleted here and no measured row changes;
// the reread finds otel_metric and otel_event rows again by their natural keys. A file that no longer exists is
// never reread and keeps its rows (documented in docs/data-model.md).
export const version = 5;

export const sql = `
UPDATE source_file SET head_hash = NULL
WHERE root_id IN (SELECT root_id FROM source_root WHERE source = 'otel');
`;
