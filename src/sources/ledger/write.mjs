// Prepared-statement writer for the ledger source (plan 03-03, D-12, ADR-0011). One row per validated ledger line,
// INSERT OR IGNORE on line_id: a stored row is never updated or deleted. When the key already exists, the stored line_sha
// is compared; a different one is a CONFLICT (counted by the caller as conflict / key_conflict, the stored row stays).
//
// The statements are prepared on the first write, not at createWriter: the runner calls createWriter for every source on
// every run, including against a store that has no ledger_line table yet (a run before migration 008 is applied is
// refused by the store guard earlier, but a unit test may hand a v7 store to the runner).
const INSERT_SQL = `
INSERT OR IGNORE INTO ledger_line (line_id, line_sha, v, record, ts_utc, unit_key, framework, repo_key, kind, native_id, tier,
                                   tier_source, command_name, runtime, session_id, model_hint, start_utc, end_utc, status,
                                   gsd_version, first_seen_run)
VALUES ($line_id, $line_sha, $v, $record, $ts_utc, $unit_key, $framework, $repo_key, $kind, $native_id, $tier,
        $tier_source, $command_name, $runtime, $session_id, $model_hint, $start_utc, $end_utc, $status,
        $gsd_version, $first_seen_run)`;
const SHA_SQL = 'SELECT line_sha FROM ledger_line WHERE line_id = $line_id';

export const ROW_COLUMNS = Object.freeze([
  'line_id', 'line_sha', 'v', 'record', 'ts_utc', 'unit_key', 'framework', 'repo_key', 'kind', 'native_id', 'tier',
  'tier_source', 'command_name', 'runtime', 'session_id', 'model_hint', 'start_utc', 'end_utc', 'status', 'gsd_version',
]);

// write(record, fileId, runId) -> the number of rows newly inserted (what ingest_source_run.rows_upserted counts).
export function createWriter(db) {
  let ins = null;
  let sel = null;
  return {
    write(rec, _fileId, runId) {
      ins ??= db.prepare(INSERT_SQL);
      sel ??= db.prepare(SHA_SQL);
      const row = Object.fromEntries(ROW_COLUMNS.map((c) => [c, rec.row[c] ?? null]));
      const res = ins.run({ ...row, first_seen_run: runId });
      if (Number(res.changes) > 0) return 1;
      const stored = sel.get({ line_id: row.line_id });
      // INSERT OR IGNORE also skips a row that violates a CHECK; a row that is neither stored nor inserted must not vanish silently.
      if (stored === undefined) throw new Error('ledger_line row rejected by the schema');
      if (stored.line_sha !== row.line_sha && typeof rec.onConflict === 'function') rec.onConflict();
      return 0;
    },
  };
}
