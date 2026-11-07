// Prepared-statement writer for usage snapshots (plan 01-06, D-11a, DATA-03). Used by the usage source (the
// cache) and by the transcript source (usageReport lines). Every column is bound explicitly by a literal
// named parameter (NULL when absent); nothing from the snapshot reaches the SQL text.
//   insertSnapshot({ source, label, snapshot }, { runId }) -> { inserted: 0 | 1 }
//     INSERT OR IGNORE on the natural key (source, fetched_at_ms); the limit rows are inserted only when the
//     snapshot row is new, so a replay adds nothing. A row that is neither inserted nor stored (a CHECK
//     failure under OR IGNORE) throws instead of vanishing.
//   write(record, fileId, runId) -> rows newly inserted (what ingest_source_run.rows_upserted counts)
const SNAPSHOT_SQL = `
INSERT OR IGNORE INTO usage_snapshot (
  source, label, fetched_at_ms, fetched_utc, first_run_id,
  five_hour_pct, five_hour_resets_ms, seven_day_pct, seven_day_resets_ms,
  seven_day_opus_pct, seven_day_opus_resets_ms, seven_day_sonnet_pct, seven_day_sonnet_resets_ms)
VALUES (
  $source, $label, $fetched_at_ms, $fetched_utc, $first_run_id,
  $five_hour_pct, $five_hour_resets_ms, $seven_day_pct, $seven_day_resets_ms,
  $seven_day_opus_pct, $seven_day_opus_resets_ms, $seven_day_sonnet_pct, $seven_day_sonnet_resets_ms)`;

const ID_SQL = 'SELECT snapshot_id FROM usage_snapshot WHERE source = $source AND fetched_at_ms = $fetched_at_ms';

const LIMIT_SQL = `
INSERT INTO usage_limit (snapshot_id, seq, kind, grp, percent, resets_ms, severity, is_active)
VALUES ($snapshot_id, $seq, $kind, $grp, $percent, $resets_ms, $severity, $is_active)`;

const pctOf = (w) => (w === null || w === undefined ? null : w.pct);
const resetOf = (w) => (w === null || w === undefined ? null : w.resetsMs);
const orNull = (v) => (v === undefined ? null : v);

export function createUsageWriter(db) {
  const insSnapshot = db.prepare(SNAPSHOT_SQL);
  const selId = db.prepare(ID_SQL);
  const insLimit = db.prepare(LIMIT_SQL);

  function insertSnapshot(rec, { runId = null } = {}) {
    const s = rec.snapshot;
    const w = s.windows;
    const res = insSnapshot.run({
      source: rec.source,
      label: rec.label,
      fetched_at_ms: s.fetchedAtMs,
      fetched_utc: new Date(s.fetchedAtMs).toISOString(),
      first_run_id: orNull(runId),
      five_hour_pct: pctOf(w.five_hour),
      five_hour_resets_ms: resetOf(w.five_hour),
      seven_day_pct: pctOf(w.seven_day),
      seven_day_resets_ms: resetOf(w.seven_day),
      seven_day_opus_pct: pctOf(w.seven_day_opus),
      seven_day_opus_resets_ms: resetOf(w.seven_day_opus),
      seven_day_sonnet_pct: pctOf(w.seven_day_sonnet),
      seven_day_sonnet_resets_ms: resetOf(w.seven_day_sonnet),
    });
    const stored = selId.get({ source: rec.source, fetched_at_ms: s.fetchedAtMs });
    if (stored === undefined) throw new Error('usage_snapshot row rejected by the schema');
    if (Number(res.changes) === 0) return { inserted: 0 };
    s.limits.forEach((l, seq) => {
      insLimit.run({
        snapshot_id: stored.snapshot_id,
        seq,
        kind: l.kind,
        grp: orNull(l.grp),
        percent: l.percent,
        resets_ms: l.resetsMs,
        severity: orNull(l.severity),
        is_active: orNull(l.isActive),
      });
    });
    return { inserted: 1 };
  }

  return {
    insertSnapshot,
    write(rec, fileId, runId) {
      return insertSnapshot(rec, { runId: orNull(runId) }).inserted;
    },
  };
}
