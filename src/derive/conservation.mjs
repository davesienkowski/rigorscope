// checkConservation: the token conservation invariant over derived.db (COST-01, D-12, RR-04).
//
// For each token class, four legs must agree by known sum AND by known count:
//   roles   the sums over GROUP BY role (parts joined to their call)
//   models  the sums over GROUP BY model (a NULL model is its own group)
//   total   the total over api_call_part
//   store   the store-side total recorded in derive_state at build time, computed from the store
//           snapshot without the part builder (src/derive/build.mjs)
// The first three agree by arithmetic unless a part has no call; the store leg is what makes a deleted
// part, an added part or an altered token value visible. Sums are compared with IS, so two unknown
// (NULL) sums are equal and an empty database passes. Parts without a call and calls without a part are
// counted and are violations. NULL is never turned into 0. Violation entries hold class names and
// numbers only.
//
// OTel join (plan 01-07): the store leg is a transcript total, so it is compared with the parts of the main
// section (token_label transcript); the otel_only parts are compared with their source, the otel_only rows of
// otel_call; and the sum over GROUP BY api_call.section must equal the total. A violation entry gains
// `sections` (the section sum); the OK result keeps its keys.
import { CLASS_COLUMNS } from './schema.mjs';

const leg = (row) => ({ sum: row.sum, known: row.groups === 0 ? 0 : row.known });
const same = (a, b) => a.sum === b.sum && a.known === b.known;

export function checkConservation(db) {
  const state = db.prepare('SELECT * FROM derive_state WHERE id = 1').get() ?? null;
  const classes = [];
  const violations = [];
  for (const c of CLASS_COLUMNS) {
    const total = db.prepare(`SELECT sum(${c}) AS sum, count(${c}) AS known FROM api_call_part`).get();
    const roles = db.prepare(`
      SELECT count(*) AS groups, sum(s) AS sum, sum(k) AS known FROM (
        SELECT sum(p.${c}) AS s, count(p.${c}) AS k
          FROM api_call_part p JOIN api_call a ON a.call_key = p.call_key
         GROUP BY a.role)`).get();
    const models = db.prepare(`
      SELECT count(*) AS groups, sum(s) AS sum, sum(k) AS known FROM (
        SELECT sum(${c}) AS s, count(${c}) AS k FROM api_call_part GROUP BY model)`).get();
    const sections = db.prepare(`
      SELECT count(*) AS groups, sum(s) AS sum, sum(k) AS known FROM (
        SELECT sum(p.${c}) AS s, count(p.${c}) AS k
          FROM api_call_part p JOIN api_call a ON a.call_key = p.call_key
         GROUP BY a.section)`).get();
    const byLabel = (label) => db.prepare(`
      SELECT sum(p.${c}) AS sum, count(p.${c}) AS known
        FROM api_call_part p JOIN api_call a ON a.call_key = p.call_key
       WHERE a.token_label = '${label}'`).get();
    const main = byLabel('transcript');
    const otelParts = byLabel('otel');
    const otelSource = db.prepare(`SELECT sum(${c}) AS sum, count(${c}) AS known FROM otel_call WHERE state = 'otel_only'`).get();
    const entry = {
      column: c,
      total: { sum: total.sum, known: total.known },
      roles: leg(roles),
      models: leg(models),
      store: state ? { sum: state[`store_${c}_sum`], known: state[`store_${c}_known`] } : { sum: null, known: null },
      main: { sum: main.sum, known: main.known },
      sections: leg(sections),
      otel: { sum: otelParts.sum, known: otelParts.known },
      otel_source: { sum: otelSource.sum, known: otelSource.known },
    };
    entry.ok = same(entry.roles, entry.total) && same(entry.models, entry.total) && same(entry.store, entry.main)
      && same(entry.sections, entry.total) && same(entry.otel, entry.otel_source);
    classes.push(entry);
    if (!entry.ok) {
      violations.push({
        column: c, roles: entry.roles.sum, models: entry.models.sum, total: entry.total.sum, store: entry.store.sum,
        sections: entry.sections.sum,
        roles_known: entry.roles.known, models_known: entry.models.known, total_known: entry.total.known, store_known: entry.store.known,
        sections_known: entry.sections.known,
      });
    }
  }
  const orphanParts = db.prepare(
    'SELECT count(*) AS n FROM api_call_part p WHERE NOT EXISTS (SELECT 1 FROM api_call a WHERE a.call_key = p.call_key)',
  ).get().n;
  const callsWithoutParts = db.prepare(
    'SELECT count(*) AS n FROM api_call a WHERE NOT EXISTS (SELECT 1 FROM api_call_part p WHERE p.call_key = a.call_key)',
  ).get().n;
  if (orphanParts > 0) violations.push({ name: 'orphan_parts', n: orphanParts });
  if (callsWithoutParts > 0) violations.push({ name: 'calls_without_parts', n: callsWithoutParts });
  const counts = {
    calls: state?.api_call_rows ?? null,
    parts: state?.api_call_part_rows ?? null,
    duplicates_collapsed: state?.duplicate_occurrences ?? null,
    synthetic_skipped: state?.synthetic_skipped ?? null,
    top_level_only: state?.top_level_only_calls ?? null,
    iteration_mismatch: state?.iter_mismatch_calls ?? null,
    unknown_iteration_type: state?.iter_unknown_type_calls ?? null,
    role_conflicts: state?.role_conflict_calls ?? null,
    cache_split_mismatch: state?.cache_split_mismatch_parts ?? null,
    orphan_parts: orphanParts,
    calls_without_parts: callsWithoutParts,
  };
  return { ok: violations.length === 0, classes, counts, violations };
}

// checkCostConservation: the dollar invariant over derived.db (plan 01-05, RR-01, RR-04).
//
// For the part costs (cost_nano, integer nano-dollars) three legs must agree by known sum AND known count:
//   total   the total over api_call_part
//   roles   the sums over GROUP BY role (parts joined to their call)
//   models  the sums over GROUP BY model (a NULL model is its own group)
// and every call's cost_nano must equal the NULL-propagating sum of its parts (NULL when one part is
// NULL). The call leg is what makes an altered or deleted part visible: the three part legs agree by
// arithmetic. Sums are compared with IS, so two NULL sums are equal and an empty database passes; no NULL
// is ever turned into 0. Violation entries hold fixed names and integers only.
const COST_PARTS_SQL = 'SELECT sum(cost_nano) AS sum, count(cost_nano) AS known, count(*) AS n FROM api_call_part';
const COST_ROLES_SQL = `
  SELECT count(*) AS groups, sum(s) AS sum, sum(k) AS known FROM (
    SELECT sum(p.cost_nano) AS s, count(p.cost_nano) AS k
      FROM api_call_part p JOIN api_call a ON a.call_key = p.call_key
     GROUP BY a.role)`;
const COST_MODELS_SQL = `
  SELECT count(*) AS groups, sum(s) AS sum, sum(k) AS known FROM (
    SELECT sum(cost_nano) AS s, count(cost_nano) AS k FROM api_call_part GROUP BY model)`;
const CALL_MISMATCH_SQL = `
  SELECT count(*) AS n FROM api_call a
   WHERE a.cost_nano IS NOT (
     SELECT CASE WHEN count(p.cost_nano) = count(*) AND count(*) > 0 THEN sum(p.cost_nano) END
       FROM api_call_part p WHERE p.call_key = a.call_key)`;

export function checkCostConservation(db) {
  const total = db.prepare(COST_PARTS_SQL).get();
  const roles = leg(db.prepare(COST_ROLES_SQL).get());
  const models = leg(db.prepare(COST_MODELS_SQL).get());
  const callMismatch = db.prepare(CALL_MISMATCH_SQL).get().n;
  const t = { sum: total.sum, known: total.known };
  const violations = [];
  if (!same(roles, t)) {
    violations.push({ name: 'role_sum', roles: roles.sum, total: t.sum, roles_known: roles.known, total_known: t.known });
  }
  if (!same(models, t)) {
    violations.push({ name: 'model_sum', models: models.sum, total: t.sum, models_known: models.known, total_known: t.known });
  }
  if (callMismatch > 0) violations.push({ name: 'call_cost_mismatch', n: callMismatch });
  return {
    ok: violations.length === 0,
    total_nano: t.sum,
    known_parts: t.known,
    unknown_parts: total.n - total.known,
    role_nano: roles.sum,
    model_nano: models.sum,
    call_mismatch_calls: callMismatch,
    violations,
  };
}

// checkWindowConservation: the window-share invariant over derived.db (plan 01-06, RR-01, RR-04).
//
// For every usable interval the shares of its parts sum to its delta exactly (integer micro-points, compared
// with IS so two empty sets pass), every member of a usable interval has a share, and no part of an interval
// that is not usable has one. NULL is never turned into 0. Violation entries hold fixed names, window names and
// integers only. An empty derived database passes.
const WINDOW_INTERVALS_SQL = `
SELECT i.win, i.seq, i.delta_micro,
       (SELECT sum(w.share_micro) FROM api_call_part_window w WHERE w.win = i.win AND w.interval_seq = i.seq) AS share_sum,
       (SELECT count(*) - count(w.share_micro) FROM api_call_part_window w WHERE w.win = i.win AND w.interval_seq = i.seq) AS missing
  FROM window_interval i
 WHERE i.status = 'usable'
 ORDER BY i.win, i.seq`;
const WINDOW_STRAY_SQL = `
SELECT count(*) AS n FROM api_call_part_window w JOIN window_interval i ON i.win = w.win AND i.seq = w.interval_seq
 WHERE i.status <> 'usable' AND w.share_micro IS NOT NULL`;

export function checkWindowConservation(db) {
  const rows = db.prepare(WINDOW_INTERVALS_SQL).all();
  const violations = [];
  for (const r of rows) {
    if (r.share_sum !== r.delta_micro || r.missing > 0) {
      violations.push({ name: 'interval_sum', win: r.win, seq: r.seq, delta: r.delta_micro, sum: r.share_sum, missing: r.missing });
    }
  }
  const stray = db.prepare(WINDOW_STRAY_SQL).get().n;
  if (stray > 0) violations.push({ name: 'share_outside_usable', n: stray });
  return { ok: violations.length === 0, intervals_checked: rows.length, violations };
}
