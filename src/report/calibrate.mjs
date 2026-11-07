// The accuracy check of reconstruction against the forward ledger (plan 03-05, LEDG-06, D-19): for every unit that has BOTH a
// ledger line and a reconstruction (a pair), each field is compared on its own: tier, start, end and the session link. Plain
// data only, no sentences, no total, no rate and no per-unit verdict: four fields, four figures.
//
// Rules (J1 to J3):
//   tier     the ledger side is the unit tier when tier_signal is `ledger`; the reconstruction side is recon_tier. agree when the
//            letters are equal, disagree when both are known and differ, unknown when recon_tier is NULL or the reconstruction
//            was not single-valued (tier_conflict 1). A pair without a ledger tier is left out of n (ledger_unrecorded).
//   start    ledger_start_ms against recon_start_ms; end: ledger_end_ms against recon_end_ms (the reconstruction end before its
//            clamp). A pair whose derived end_source is `clamped`, or whose reconstruction end was itself raised to its start
//            (recon_end_source `clamped`), counts its end as unknown (it stays in n). A NULL ledger value leaves the pair out
//            (ledger_unrecorded); a NULL reconstruction value is unknown. The ledger side is always an instant. When the
//            reconstruction source (recon_date_source, recon_end_source) is a day source (DAY_SOURCES: a quick id date, a
//            SUMMARY `completed:` date) the pair is compared by local day in the report zone: agree iff the same day, no minute
//            difference exists, so it stays out of median_min and max_min; a precision mismatch is never a disagree (review
//            03-05 H1). Otherwise (an instant source) agree when the whole-minute absolute difference is at most
//            TIME_TOLERANCE_MIN, else disagree. median_min and max_min are over the instant pairs with both sides known, whatever
//            the tolerance, by nearest rank; a field with no such pair has null (the renderers print `?`). compared_by counts
//            the compared (agree + disagree) pairs by instant and by day.
//   session  ledger_session_id NULL leaves the pair out; no unit_link row for the unit is unknown; some unit_link row with that
//            session id agrees (any method or confidence), else disagree. A /clear between start and close can read as disagree.
// n is agree + disagree + unknown and is shown as such; `compared` is agree + disagree. A field with compared below
// LOW_EVIDENCE_PAIRS carries low_evidence true: an unknown pair compares nothing, so it does not count towards the floor (review
// 03-05 M2). A ledger-only unit (no
// reconstruction) is counted in ledger_only and in no field. Nothing here prints a session id, command, path or branch.
import { openDerivedReadOnly } from '../db.mjs';
import { buildUnitEvidenceId } from '../measure/rowkey.mjs';
import { DAY_SOURCES, localDay } from '../measure/period.mjs';
import { nearestRank } from '../measure/stats.mjs';
import { loadFreshness } from './freshness.mjs';

export const FIELDS = Object.freeze(['tier', 'start', 'end', 'session']);
export const TIME_TOLERANCE_MIN = 30;
export const LOW_EVIDENCE_PAIRS = 5;
export const MAX_FIELD_EVIDENCE = 5;
const MINUTE_MS = 60_000;
const byteCompare = (a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// One comparison outcome: 'skip' (ledger side absent), 'agree', 'disagree' or 'unknown'; time outcomes carry diff (whole minutes).
function tierOutcome(r) {
  if (r.tier_signal !== 'ledger' || r.tier === null || r.tier === undefined) return { outcome: 'skip' };
  if (r.recon_tier === null || r.recon_tier === undefined || r.tier_conflict === 1) return { outcome: 'unknown' };
  return { outcome: r.recon_tier === r.tier ? 'agree' : 'disagree' };
}

function timeOutcome(ledgerMs, reconMs, { clamped = false, source = null, tz = 'UTC' } = {}) {
  if (!isNum(ledgerMs)) return { outcome: 'skip' };
  if (clamped || !isNum(reconMs)) return { outcome: 'unknown' };
  if (DAY_SOURCES.has(source)) {
    const same = localDay(ledgerMs, tz) === localDay(reconMs, tz);
    return { outcome: same ? 'agree' : 'disagree', by: 'day' };
  }
  const diff = Math.round(Math.abs(ledgerMs - reconMs) / MINUTE_MS);
  return { outcome: diff <= TIME_TOLERANCE_MIN ? 'agree' : 'disagree', diff, by: 'instant' };
}

function sessionOutcome(r, links) {
  if (r.ledger_session_id === null || r.ledger_session_id === undefined) return { outcome: 'skip' };
  const set = links.get(r.unit_key);
  if (set === undefined || set.size === 0) return { outcome: 'unknown' };
  return { outcome: set.has(r.ledger_session_id) ? 'agree' : 'disagree' };
}

function summarize(field, items) {
  const counted = items.filter((i) => i.outcome !== 'skip');
  const count = (o) => counted.filter((i) => i.outcome === o).length;
  const disagree = counted.filter((i) => i.outcome === 'disagree').map((i) => i.key).sort(byteCompare);
  const ids = (keys) => keys.slice(0, MAX_FIELD_EVIDENCE).map(buildUnitEvidenceId);
  const out = {
    field,
    agree: count('agree'),
    disagree: count('disagree'),
    unknown: count('unknown'),
    n: counted.length,
    compared: count('agree') + count('disagree'),
    ledger_unrecorded: items.length - counted.length,
    low_evidence: count('agree') + count('disagree') < LOW_EVIDENCE_PAIRS,
    disagree_ids: ids(disagree),
    disagree_omitted: Math.max(0, disagree.length - MAX_FIELD_EVIDENCE),
    pair_ids: ids(counted.map((i) => i.key).sort(byteCompare)),
  };
  if (field === 'start' || field === 'end') {
    const diffs = counted.filter((i) => i.diff !== undefined).map((i) => i.diff).sort((a, b) => a - b);
    out.median_min = diffs.length === 0 ? null : nearestRank(diffs, 50);
    out.max_min = diffs.length === 0 ? null : diffs[diffs.length - 1];
    out.within_min = TIME_TOLERANCE_MIN;
    const by = (k) => counted.filter((i) => i.by === k).length;
    out.compared_by = { instant: by('instant'), day: by('day') };
  }
  return out;
}

// rows: plain derived `unit` rows of the units that have a ledger line (columns unit_key, ledger_lines, has_recon, tier,
// tier_signal, recon_tier, tier_conflict, ledger_start_ms, ledger_end_ms, recon_start_ms, recon_end_ms, end_source,
// ledger_session_id, recon_date_source, recon_end_source); links: Map(unit_key -> Set(session id)) of the unit_link rows; tz: the
// report zone for day comparisons. -> { pairs, ledger_only, fields }.
export function calibrateFields(rows, links = new Map(), { tz = 'UTC' } = {}) {
  const forward = (Array.isArray(rows) ? rows : []).filter((r) => r.ledger_lines > 0);
  const pairs = forward.filter((r) => r.has_recon === 1);
  const per = {
    tier: pairs.map((r) => ({ key: r.unit_key, ...tierOutcome(r) })),
    start: pairs.map((r) => ({ key: r.unit_key, ...timeOutcome(r.ledger_start_ms, r.recon_start_ms, { source: r.recon_date_source, tz }) })),
    end: pairs.map((r) => ({
      key: r.unit_key,
      ...timeOutcome(r.ledger_end_ms, r.recon_end_ms, {
        clamped: r.end_source === 'clamped' || r.recon_end_source === 'clamped', source: r.recon_end_source, tz,
      }),
    })),
    session: pairs.map((r) => ({ key: r.unit_key, ...sessionOutcome(r, links) })),
  };
  return {
    pairs: pairs.length,
    ledger_only: forward.length - pairs.length,
    fields: FIELDS.map((f) => summarize(f, per[f])),
  };
}

const PAIRS_SQL = `
SELECT unit_key, ledger_lines, has_recon, tier, tier_signal, recon_tier, tier_conflict, ledger_start_ms, ledger_end_ms,
       recon_start_ms, recon_end_ms, recon_date_source, recon_end_source, end_source, ledger_session_id
  FROM unit WHERE ledger_lines > 0 ORDER BY unit_key`;
const LINK_SESSIONS_SQL = 'SELECT DISTINCT session_id FROM unit_link WHERE unit_key = ?';

// The calibration of the derived units (read-only; the caller runs ensureDerived first). The unit_link read is one indexed
// lookup per forward pair with a ledger session (fixed SQL, the unit key bound).
export function loadCalibration({
  home, now = () => new Date(), tz, clockFixed = false,
}) {
  const nowMs = now().getTime();
  const db = openDerivedReadOnly({ home });
  let rows;
  const links = new Map();
  try {
    rows = db.prepare(PAIRS_SQL).all();
    const lookup = db.prepare(LINK_SESSIONS_SQL);
    for (const r of rows) {
      if (r.has_recon !== 1 || r.ledger_session_id === null) continue;
      links.set(r.unit_key, new Set(lookup.all(r.unit_key).map((x) => x.session_id)));
    }
  } finally {
    db.close();
  }
  return {
    asOfMs: nowMs, clockFixed, tz, freshnessCheck: loadFreshness({ home, nowMs }), ...calibrateFields(rows, links, { tz }),
  };
}
