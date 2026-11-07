// The advisor-model trial reader of the decision sheet (plan 03-05, D-25). The owner changes the advisor model outside this
// repository; rigorscope never sets it. This module only reads two things that already exist: the advisor_model values of the
// environment snapshots (one per ingest run, store.db) and the advisor-part tokens and notional dollars by model (derived.db).
// It computes no score and gives no recommendation: it says whether a full window of data exists after the setting changed.
//
// Window definition (stated in the sheet row too): the trial window is ADVISOR_WINDOW_DAYS (7, the weekly usage window) long and
// starts at the first snapshot whose advisor_model differs from the earliest recorded value. The baseline window is the same length
// and ends where the trial window starts (review 03-05 M4), so the two can be read side by side. A window holds the parts whose call
// time is at or after its start and before its end. A snapshot with a NULL advisor_model
// (setting absent, unreadable or failing the model shape) is not a value: it is counted apart and never starts a window. The window
// is full when the report's as-of instant is at or past its end. The true change lies between the previous snapshot and the one
// that shows it, so the start is the snapshot instant, not a claimed change instant.
// Advisor parts sit inside the role rows of `cost`, so role-share figures carry that confounder; the sheet row says so.
import { existsSync } from 'node:fs';
import { openDerivedReadOnly, openStoreReadOnly, storePath } from '../db.mjs';

export const ADVISOR_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const SNAPSHOTS_SQL = 'SELECT run_id, taken_utc, advisor_model FROM env_snapshot ORDER BY unixepoch(taken_utc, \'subsec\'), run_id';
const guard = (col) => `CASE WHEN count(${col}) = count(*) THEN sum(${col}) END`;
// Fixed SQL; the only bound values are the window bounds. Grouped on `+p.model` so the planner does not walk the model index per row.
export const PARTS_SQL = (bounded) => `
SELECT +p.model AS model, count(*) AS parts, ${guard('p.cost_nano')} AS usd_nano
  FROM api_call_part p JOIN api_call c ON c.call_key = p.call_key
 WHERE p.kind = 'advisor' AND c.token_label = 'transcript'${bounded ? ' AND c.ts_ms >= ? AND c.ts_ms < ?' : ''}
 GROUP BY +p.model ORDER BY model`;

// snapshots: [{ taken_ms, advisor_model }] in time order. -> the plain state the sheet row reads. Pure.
export function advisorState(snapshots, asOfMs) {
  const values = snapshots.filter((s) => typeof s.advisor_model === 'string' && s.advisor_model !== '');
  const seen = [];
  for (const s of values) if (!seen.includes(s.advisor_model)) seen.push(s.advisor_model);
  const baseline = values.length === 0 ? null : values[0].advisor_model;
  const change = values.find((s) => s.advisor_model !== baseline) ?? null;
  const startMs = change === null ? null : change.taken_ms;
  const endMs = startMs === null ? null : startMs + ADVISOR_WINDOW_DAYS * DAY_MS;
  return {
    snapshots: snapshots.length,
    snapshots_null: snapshots.length - values.length,
    models_seen: seen,
    baseline,
    changed: change !== null,
    change_model: change === null ? null : change.advisor_model,
    baseline_start_ms: startMs === null ? null : startMs - ADVISOR_WINDOW_DAYS * DAY_MS,
    window_start_ms: startMs,
    window_end_ms: endMs,
    window_days: ADVISOR_WINDOW_DAYS,
    full: endMs !== null && asOfMs >= endMs,
  };
}

// -> { state, scope, models, baseline, trial }, each list [{ model, parts, usd_nano }]. When a trial window has started (scope
// 'window'): baseline = the advisor parts in [baseline_start, window_start), trial = those in [window_start, min(window_end,
// as-of + 1)), models empty. Otherwise (scope 'all') models = the advisor parts over all time and the windows are empty. usd_nano is
// null (unknown) when any part is unpriced, never a partial sum. Opens both databases read-only; the caller ran ensureDerived.
export function loadAdvisorTrial({ home, asOfMs }) {
  let snaps = [];
  if (existsSync(storePath(home))) {
    const db = openStoreReadOnly({ home });
    try {
      snaps = db.prepare(SNAPSHOTS_SQL).all().map((r) => ({ taken_ms: Date.parse(r.taken_utc), advisor_model: r.advisor_model }));
    } finally {
      db.close();
    }
  }
  const state = advisorState(snaps, asOfMs);
  const d = openDerivedReadOnly({ home });
  const plain = (rows) => rows.filter((r) => typeof r.model === 'string').map((r) => ({ model: r.model, parts: r.parts, usd_nano: r.usd_nano }));
  try {
    if (!state.changed) {
      return { state, scope: 'all', models: plain(d.prepare(PARTS_SQL(false)).all()), baseline: [], trial: [] };
    }
    const bounded = d.prepare(PARTS_SQL(true));
    return {
      state,
      scope: 'window',
      models: [],
      baseline: plain(bounded.all(state.baseline_start_ms, state.window_start_ms)),
      trial: plain(bounded.all(state.window_start_ms, Math.min(state.window_end_ms, asOfMs + 1))),
    };
  } finally {
    d.close();
  }
}
