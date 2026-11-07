// fillWindows: the window-share pass (plan 01-06, D-11a, D-09). It runs inside the rebuild's single BEGIN
// IMMEDIATE transaction on the derived connection, after fillDerived (parts and prices), with store.db attached
// read-only as schema `s`, so it reads the same store snapshot as the rest of the pass. It issues no statement
// that writes to schema s.
//
//   1. read the usage snapshots from s.usage_snapshot and the parts (with their call timestamp) from the
//      derived tables; a part's weight comes from partWeight and its timestamp is parsed in code (NULL or
//      unparseable gives no timestamp, so the part is in no interval)
//   2. estimateWindowShares -> intervals and per-part shares
//   3. write window_interval, api_call_part_window, the usage_latest row (no row when there is no snapshot),
//      and record the weights text and the snapshot count in derive_state
import { WINDOW_WEIGHTS_TEXT, estimateWindowShares, partWeight } from './window.mjs';

const WINDOW_NAMES = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

const SNAPSHOT_SQL = `
SELECT source, label, fetched_at_ms, ${WINDOW_NAMES.map((w) => `${w}_pct, ${w}_resets_ms`).join(', ')}
  FROM s.usage_snapshot
 ORDER BY fetched_at_ms, source`;

const PARTS_SQL = `
SELECT p.call_key, p.part_seq, p.input_tokens, p.output_tokens, p.cache_read, p.cache_creation, c.ts_utc
  FROM api_call_part p JOIN api_call c ON c.call_key = p.call_key`;

const INSERT_INTERVAL = `
INSERT INTO window_interval (win, seq, start_ms, end_ms, start_pct, end_pct, resets_ms, status, delta_micro, parts, weight_total)
VALUES ($win, $seq, $start_ms, $end_ms, $start_pct, $end_pct, $resets_ms, $status, $delta_micro, $parts, $weight_total)`;

const INSERT_SHARE = `
INSERT INTO api_call_part_window (call_key, part_seq, win, interval_seq, share_micro)
VALUES ($call_key, $part_seq, $win, $interval_seq, $share_micro)`;

const INSERT_LATEST = `
INSERT INTO usage_latest (id, source, label, fetched_at_ms, ${WINDOW_NAMES.map((w) => `${w}_pct, ${w}_resets_ms`).join(', ')})
VALUES (1, $source, $label, $fetched_at_ms, ${WINDOW_NAMES.map((w) => `$${w}_pct, $${w}_resets_ms`).join(', ')})`;

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
export function parseTsMs(text) {
  if (typeof text !== 'string' || !TS.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

const windowOf = (r, w) => (r[`${w}_pct`] === null ? null : { pct: r[`${w}_pct`], resetsMs: r[`${w}_resets_ms`] });

export function fillWindows({ db }) {
  const snapRows = db.prepare(SNAPSHOT_SQL).all();
  const snapshots = snapRows.map((r) => ({
    source: r.source, fetchedAtMs: r.fetched_at_ms, five_hour: windowOf(r, 'five_hour'), seven_day: windowOf(r, 'seven_day'),
  }));
  const parts = [];
  for (const r of db.prepare(PARTS_SQL).iterate()) {
    parts.push({ callKey: r.call_key, partSeq: r.part_seq, tsMs: parseTsMs(r.ts_utc), weight: partWeight(r) });
  }
  const { intervals, shares } = estimateWindowShares({ snapshots, parts });

  const insInterval = db.prepare(INSERT_INTERVAL);
  for (const x of intervals) {
    insInterval.run({
      win: x.win, seq: x.seq, start_ms: x.startMs, end_ms: x.endMs, start_pct: x.startPct, end_pct: x.endPct,
      resets_ms: x.resetsMs, status: x.status, delta_micro: x.deltaMicro, parts: x.parts, weight_total: x.weightTotal,
    });
  }
  const insShare = db.prepare(INSERT_SHARE);
  for (const s of shares) {
    insShare.run({ call_key: s.callKey, part_seq: s.partSeq, win: s.win, interval_seq: s.intervalSeq, share_micro: s.shareMicro });
  }

  // The latest snapshot: fetched_at_ms descending, then source ascending (bytewise).
  let latest = null;
  for (const r of snapRows) {
    if (latest === null || r.fetched_at_ms > latest.fetched_at_ms
      || (r.fetched_at_ms === latest.fetched_at_ms && Buffer.compare(Buffer.from(r.source), Buffer.from(latest.source)) < 0)) latest = r;
  }
  if (latest !== null) {
    const row = { source: latest.source, label: latest.label, fetched_at_ms: latest.fetched_at_ms };
    for (const w of WINDOW_NAMES) {
      row[`${w}_pct`] = latest[`${w}_pct`];
      row[`${w}_resets_ms`] = latest[`${w}_resets_ms`];
    }
    db.prepare(INSERT_LATEST).run(row);
  }
  db.prepare('UPDATE derive_state SET window_weights = ?, usage_snapshots = ? WHERE id = 1').run(WINDOW_WEIGHTS_TEXT, snapRows.length);
}
