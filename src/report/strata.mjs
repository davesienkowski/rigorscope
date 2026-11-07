// The per-population figures of the `units` report (plan 03-04, TRUST-03, D-14 to D-17): plain data only, no text. Every
// function takes the units of src/report/units.mjs (toUnit shape) and returns integers, nulls and small objects; the renderers
// format them (`?` for a zero denominator or a NULL sum, ADR-0004). Nothing here adds the forward and the reconstructed
// population: each function is called once per population, or reads the units whole where the definition says so (the
// unrecorded share, D-16).
import { localDay } from '../measure/period.mjs';
import { LOW_EVIDENCE_N, declaredAtCloseOf, isLowEvidence } from './tier.mjs';

export const BASELINE_MIN_FORWARD = 10;
export const INCOMPLETE_LIST_CAP = 20;
export const TIERED_TARGET_PERCENT = 90;
export const COVERAGE_LINK_MODE = 'medium';

export function countUnits(units) {
  return {
    units: units.length,
    quick: units.filter((u) => u.kind === 'quick').length,
    plan: units.filter((u) => u.kind === 'plan').length,
    tiered: units.filter((u) => u.tier.value !== null).length,
    untiered: units.filter((u) => u.tier.value === null).length,
    conflicts: units.filter((u) => u.tier.conflict).length,
    repos: new Set(units.map((u) => u.repo.key)).size,
    present: units.filter((u) => u.present).length,
    comparable: units.filter((u) => u.tier.comparable).length,
    git_evidence: units.filter((u) => u.gitEvidence).length,
    risk_known: units.filter((u) => u.risk.value !== null).length,
    plan_unbounded: units.filter((u) => u.kind === 'plan' && u.commitsBounded === false).length,
    end_clamped: units.filter((u) => u.endSource === 'clamped').length,
  };
}

// The tier-report row shape of a units-report unit, so one predicate serves both reports.
const rowShape = (u) => ({ tier: u.tier.value, tier_signal: u.tier.signal, tier_timing: u.tier.timing });
export const costedUnit = (u) => u.cost.calls > 0 && u.cost.tokens !== null && u.cost.tokens !== undefined;

// One population's units: n, the counts of countUnits, declared_at_close, costed (an attributed call and known tokens) and the
// low-evidence flag against minN (default 10). An empty stratum is n 0, costed 0, low_evidence true, never omitted.
export function stratumSummary(units, { minN = LOW_EVIDENCE_N } = {}) {
  const costed = units.filter(costedUnit).length;
  return {
    n: units.length,
    counts: countUnits(units),
    declared_at_close: declaredAtCloseOf(units.map(rowShape)),
    costed,
    low_evidence: isLowEvidence(costed, minN),
    min_n: minN,
  };
}

const ms = (iso) => {
  if (typeof iso !== 'string') return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
};
const byteCompare = (a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));

// D-14: the forward units whose ledger has a start and no close, oldest first by the earliest ledger line time. Age is the
// report's as-of minus that time, in whole milliseconds (null when the time is unknown). Rows hold repo display, kind, id and
// age only. -> { n, listed: rows (at most INCOMPLETE_LIST_CAP), omitted, oldest_age_ms }.
export function incompleteList(units, nowMs, { cap = INCOMPLETE_LIST_CAP } = {}) {
  const all = units.filter((u) => u.population === 'forward' && u.ledger !== null && u.ledger.status === 'incomplete')
    .map((u) => {
      const at = ms(u.recordedAtUtc);
      return {
        repo: u.repo.display, kind: u.kind, id: u.nativeId, key: u.key, at, age_ms: at === null ? null : Math.max(0, nowMs - at),
      };
    })
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || byteCompare(a.key, b.key));
  const listed = all.slice(0, cap).map(({ at, key, ...row }) => row);
  const known = all.filter((r) => r.age_ms !== null);
  return {
    n: all.length, listed, omitted: all.length - listed.length, oldest_age_ms: known.length === 0 ? null : Math.max(...known.map((r) => r.age_ms)),
  };
}

// D-16, J3: the share of the units reconstruction saw (recon start known) whose first-seen local day is on or after the cutoff
// day (the day of the earliest ledger line time among forward units) that have no ledger line. A unit of unknown first-seen is
// counted apart and left out; a ledger-only unit is out of n by definition. No ledger line: cutoff none, n 0.
export function unrecordedShare(units, { tz }) {
  const lines = units.filter((u) => u.population === 'forward').map((u) => ms(u.recordedAtUtc)).filter((v) => v !== null);
  const seen = units.filter((u) => u.hasRecon === true);
  const unknown = seen.filter((u) => u.reconStartMs === null || u.reconStartMs === undefined).length;
  if (lines.length === 0) return { cutoff_day: null, n: 0, k: 0, first_seen_unknown: unknown };
  const cutoff = localDay(Math.min(...lines), tz);
  const inScope = seen.filter((u) => typeof u.reconStartMs === 'number' && localDay(u.reconStartMs, tz) >= cutoff);
  return {
    cutoff_day: cutoff, n: inScope.length, k: inScope.filter((u) => u.ledger === null).length, first_seen_unknown: unknown,
  };
}

// The earliest forward ledger line instant (the cutoff of the forward dollar denominator), or null.
export function cutoffMs(units) {
  const v = units.filter((u) => u.population === 'forward').map((u) => ms(u.recordedAtUtc)).filter((x) => x !== null);
  return v.length === 0 ? null : Math.min(...v);
}

// D-17, J4: one population's coverage. tiered and comparable_source are { n, d } over the stratum n (forward only for the
// comparable source); attributed_usd is { n, d } in integer nano-dollars (null where unknown) from `dollars`, which the caller
// loads at link confidence medium and over all units (the dollar figures ignore the unit filters, review fix MEDIUM-3).
// attribution_target is the pending-baseline fact for the forward population; its count is baselineForward (the number of forward
// units before any unit filter) when the caller gives it, else the stratum n. No verdict.
export function coverageShares(population, units, dollars, { baselineForward = null, dollarsIgnoreUnitFilters = false } = {}) {
  const d = units.length;
  const forward = population === 'forward';
  const baselineN = baselineForward === null ? d : baselineForward;
  return {
    population,
    tiered: { n: units.filter((u) => u.tier.value !== null).length, d },
    comparable_source: forward ? { n: units.filter((u) => u.tier.comparable).length, d } : null,
    attributed_usd: { n: dollars?.attributed_nano ?? null, d: dollars?.total_nano ?? null },
    attributed_usd_since_ms: dollars?.since_ms ?? null,
    link_confidence: COVERAGE_LINK_MODE,
    tiered_target_percent: TIERED_TARGET_PERCENT,
    dollars_ignore_unit_filters: dollarsIgnoreUnitFilters === true,
    attribution_baseline: forward ? { forward_units: baselineN, needed: BASELINE_MIN_FORWARD, pending: baselineN < BASELINE_MIN_FORWARD } : null,
  };
}

export const WINDOW_BUCKETS = Object.freeze(['attributed_forward', 'attributed_reconstructed', 'unattributed_overlap', 'unlinked']);

// D-24 (review fix HIGH-1): the main-section calls at or after the cutoff instant split by bucket, from the rows and the independent
// total of loadWindowBuckets (src/report/unit-cost.mjs). The attributed bucket is split by the population of its unit; an attributed
// row of any other population is folded into no bucket, so it shows as a mismatch. A bucket with no row is a genuine zero. check:
// calls 'ok' | 'mismatch' (the bucket calls add up to the total calls), usd 'ok' | 'mismatch' | 'unknown' (unknown when any bucket or
// the total is NULL: no partial sum is compared). No cutoff (no ledger line) -> every field null.
export function windowSplit(sinceMs, rows, total) {
  if (sinceMs === null || sinceMs === undefined || total === null || total === undefined) {
    return { since_ms: null, buckets: null, total: null, check: null };
  }
  const pick = (bucket, population) => {
    const mine = rows.filter((r) => r.bucket === bucket && (population === undefined || r.population === population));
    if (mine.length === 0) return { calls: 0, usd_nano: 0 };
    return {
      calls: mine.reduce((n, r) => n + r.calls, 0),
      usd_nano: mine.some((r) => r.usd_nano === null) ? null : mine.reduce((n, r) => n + r.usd_nano, 0),
    };
  };
  const buckets = {
    attributed_forward: pick('attributed', 'forward'),
    attributed_reconstructed: pick('attributed', 'reconstructed'),
    unattributed_overlap: pick('unattributed_overlap'),
    unlinked: pick('unlinked'),
  };
  const all = Object.values(buckets);
  const calls = all.reduce((n, b) => n + b.calls, 0) === total.calls ? 'ok' : 'mismatch';
  let usd = 'unknown';
  if (total.usd_nano !== null && all.every((b) => b.usd_nano !== null)) {
    usd = all.reduce((n, b) => n + b.usd_nano, 0) === total.usd_nano ? 'ok' : 'mismatch';
  }
  return {
    since_ms: sinceMs, buckets, total: { calls: total.calls, usd_nano: total.usd_nano }, check: { calls, usd },
  };
}
