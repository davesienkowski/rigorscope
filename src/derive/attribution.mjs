// Attribution of each (session, agent) scope to at most one unit (plan 02-07, UNIT-06, D-13; V1 per scope). Read by
// fillAttribution inside the rebuild transaction from link_scope and unit_link; checked by checkAttribution.
//
// Modes (LINK_CONFIDENCE_MODES):
//   medium (strict, the default)  the counted links of a scope are its high and medium links. Exactly one distinct
//                                 counted unit takes every call of the scope (bucket attributed, reason one-unit); two or
//                                 more send the calls whole to unattributed_overlap (multi-unit), never spread over the
//                                 units; no counted link but a low one sends them to unattributed_overlap too (low-only:
//                                 D-13 puts cost from low-confidence links in the visible overlap bucket); no link at all
//                                 sends them to unlinked (no-link).
//   low (widened)                 a scope with any high or medium link is decided exactly as in mode medium; only a scope
//                                 with no high or medium link counts its low links: one unit is attributed with reason
//                                 one-low-unit, several are multi-unit overlap. Low mode never reverses a medium-mode
//                                 decision (an overlapping interval is weaker evidence than a write and must not turn a
//                                 scope with a write link into overlap), so the calls attributed in mode low are a
//                                 superset of mode medium's.
// Attribution covers the main section (token_label transcript) only; otel-only and harness calls stay in their
// sections. The bucket parts of every token class and of cost_nano sum to the main-section total (checkAttribution).
import { CLASS_COLUMNS } from './schema.mjs';

export const LINK_CONFIDENCE_MODES = Object.freeze(['medium', 'low']);
export const BUCKETS = Object.freeze(['attributed', 'unattributed_overlap', 'unlinked']);
export const REASONS = Object.freeze(['one-unit', 'one-low-unit', 'multi-unit', 'low-only', 'no-link']);

const MODE_MESSAGE = 'the link confidence mode must be medium or low';
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// links: one scope's link rows ({ unit_key, confidence }). -> { bucket, reason, unitKey, countedUnits } (exactly those
// keys). A unit with several rows (methods) counts once.
export function attributeScope({ links, mode }) {
  if (!LINK_CONFIDENCE_MODES.includes(mode)) throw new RangeError(MODE_MESSAGE);
  const rows = Array.isArray(links) ? links : [];
  const strong = [...new Set(rows.filter((l) => l.confidence === 'high' || l.confidence === 'medium').map((l) => l.unit_key))].sort(byKey);
  const weak = [...new Set(rows.filter((l) => l.confidence === 'low').map((l) => l.unit_key))].sort(byKey);
  const out = (bucket, reason, unitKey, countedUnits) => ({
    bucket, reason, unitKey, countedUnits,
  });
  if (strong.length === 1) return out('attributed', 'one-unit', strong[0], 1);
  if (strong.length > 1) return out('unattributed_overlap', 'multi-unit', null, strong.length);
  if (weak.length === 0) return out('unlinked', 'no-link', null, 0);
  if (mode === 'medium') return out('unattributed_overlap', 'low-only', null, 0);
  if (weak.length === 1) return out('attributed', 'one-low-unit', weak[0], 1);
  return out('unattributed_overlap', 'multi-unit', null, weak.length);
}

const SCOPES_SQL = 'SELECT session_id, agent_id, refs_known FROM link_scope ORDER BY session_id, agent_id';
const LINKS_SQL = 'SELECT session_id, agent_id, unit_key, confidence FROM unit_link ORDER BY session_id, agent_id, unit_key, method';
const INSERT_SQL = `
INSERT INTO scope_attribution (session_id, agent_id, link_confidence, bucket, reason, unit_key, counted_units, refs_known)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const UNIT_SQL = `
INSERT INTO unit_attribution (unit_key, link_confidence, scopes, sessions, subagent_scopes, calls, refs_unknown_scopes)
SELECT u.unit_key, m.mode, count(sa.session_id), count(DISTINCT sa.session_id), coalesce(sum(ls.subagent), 0),
       coalesce(sum(ls.calls), 0), coalesce(sum(1 - sa.refs_known), 0)
  FROM unit u
 CROSS JOIN (SELECT 'medium' AS mode UNION ALL SELECT 'low') m
  LEFT JOIN scope_attribution sa ON sa.unit_key = u.unit_key AND sa.link_confidence = m.mode AND sa.bucket = 'attributed'
  LEFT JOIN link_scope ls ON ls.session_id = sa.session_id AND ls.agent_id = sa.agent_id
 GROUP BY u.unit_key, m.mode
 ORDER BY u.unit_key, m.mode`;

export function fillAttribution({ db }) {
  const linksBy = new Map();
  for (const l of db.prepare(LINKS_SQL).all()) {
    const k = `${l.session_id}\0${l.agent_id}`;
    if (!linksBy.has(k)) linksBy.set(k, []);
    linksBy.get(k).push(l);
  }
  const ins = db.prepare(INSERT_SQL);
  for (const s of db.prepare(SCOPES_SQL).all()) {
    const links = linksBy.get(`${s.session_id}\0${s.agent_id}`) ?? [];
    for (const mode of LINK_CONFIDENCE_MODES) {
      const a = attributeScope({ links, mode });
      ins.run(s.session_id, s.agent_id, mode, a.bucket, a.reason, a.unitKey, a.countedUnits, s.refs_known);
    }
  }
  db.exec(UNIT_SQL);
}

// callWhere: an optional { sql, params } fragment over the call alias c (built only from src/report/filters.mjs
// whitelists), applied to every leg.
const MAIN = "c.token_label = 'transcript'";
const same = (a, b) => a.sum === b.sum && a.known === b.known;

// -> { ok, mode, classes: [{ column, attributed, unattributed_overlap, unlinked, total }], missing_calls }; every leg is
// { sum, known } (sum NULL when no member is known, never 0). Names and numbers only.
export function checkAttribution(db, { mode = 'medium', callWhere = null } = {}) {
  if (!LINK_CONFIDENCE_MODES.includes(mode)) throw new RangeError(MODE_MESSAGE);
  const where = callWhere && callWhere.sql ? ` AND (${callWhere.sql})` : '';
  const params = callWhere && callWhere.sql ? callWhere.params : [];
  const classes = [];
  for (const col of [...CLASS_COLUMNS, 'cost_nano']) {
    const total = db.prepare(`
SELECT sum(p.${col}) AS sum, count(p.${col}) AS known
  FROM api_call_part p JOIN api_call c ON c.call_key = p.call_key
 WHERE ${MAIN}${where}`).get(...params);
    const legs = Object.fromEntries(BUCKETS.map((b) => [b, { sum: null, known: 0 }]));
    for (const r of db.prepare(`
SELECT sa.bucket AS bucket, sum(p.${col}) AS sum, count(p.${col}) AS known
  FROM api_call_part p JOIN api_call c ON c.call_key = p.call_key
  JOIN scope_attribution sa ON sa.session_id = c.owner_session_id AND sa.agent_id = c.owner_agent_id AND sa.link_confidence = ?
 WHERE ${MAIN}${where}
 GROUP BY sa.bucket ORDER BY sa.bucket`).all(mode, ...params)) {
      legs[r.bucket] = { sum: r.sum, known: r.known };
    }
    const known = BUCKETS.map((b) => legs[b]).filter((l) => l.sum !== null);
    const parts = { sum: known.length === 0 ? null : known.reduce((n, l) => n + l.sum, 0), known: BUCKETS.reduce((n, b) => n + legs[b].known, 0) };
    const entry = { column: col, ...legs, total: { sum: total.sum, known: total.known } };
    entry.ok = same(parts, entry.total);
    classes.push(entry);
  }
  const missing = db.prepare(`
SELECT count(*) AS n FROM api_call c
 WHERE ${MAIN}${where}
   AND NOT EXISTS (SELECT 1 FROM scope_attribution sa
                    WHERE sa.session_id = c.owner_session_id AND sa.agent_id = c.owner_agent_id AND sa.link_confidence = ?)`)
    .get(...params, mode).n;
  return {
    ok: classes.every((c) => c.ok) && missing === 0, mode, classes, missing_calls: missing,
  };
}
