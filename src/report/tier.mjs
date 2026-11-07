// loadTierReport (plan 02-08, D-18, D-02, D-03, D-06, D-13, TRUST-07, TIER-02): per-unit cost by rigor tier inside each risk
// stratum, as plain data. Report-time only: nothing here is stored or derived, every flag (--min-n, --include-inferred,
// --link-confidence, the period) is a parameter of this call, and both databases are opened read-only after the caller ran
// ensureDerived.
//
// Strata (D-06): the order of RISK_TAGS, then `none` (risk_class [], a known empty set) and `unknown` (risk_class NULL: no
// touched path or no usable rule table); the two are never merged. A unit counts once in every stratum its risk_class names
// (script is dropped when a SCRIPT_SPECIFIC tag is present), and nothing is summed across strata. Rows are A, B, C and `?`.
// A unit with tier NULL is in the `?` row of each of its strata and never in A, B or C; the `?` row is never compared. A
// unit whose tier was inferred from probe files (tier_signal probes-skipped) is in no row by default (D-03, TIER-02): it is
// counted as inferred_excluded, and --include-inferred puts it in its letter row. sideOf uses inTierComparison so the rule
// lives in one place.
//
// Statistic (D-18, TRUST-07): per row, the median and p75 over the costed units' per-unit values, by nearest rank (the
// element at rank ceil(p x n / 100) of the ascending values, the lower middle for an even n; equal values ordered by unit
// key). They are elements of the data, never an average or an interpolation. A costed unit has at least one attributed call
// and known tokens; `n` counts every unit of the row; a unit with attributed calls but unknown tokens is not costed
// (tokens_unknown); a costed unit with unknown dollars or window share is left out of that measure's `known`
// (usd_unknown, window_share_unknown). The low-evidence flag compares the costed count with --min-n (default 10). Catch
// and escape are unavailable until Phases 4 and 5.
import { openDerivedReadOnly } from '../db.mjs';
import { buildUnitEvidenceId } from '../measure/rowkey.mjs';
import { nearestRank } from '../measure/stats.mjs';
import { RISK_TAGS } from '../units/risk.mjs';
import { inTierComparison, isForwardDeclaredAtClose, TIER_LETTERS } from '../units/tier.mjs';
import { selectedPopulations } from './population.mjs';
import {
  CONFOUNDER_KINDS, comparisonWindow, dayWindow, diffConfounders, unitConfounderValues, unitPartialFlags,
} from './confounder-diff.mjs';
import { loadFreshness } from './freshness.mjs';
import { callFilterSql, describeFilters, unitFilterSql } from './filters.mjs';
import { buildLeads } from './leads.mjs';
import { loadAttributionTotals, loadUnitCosts } from './unit-cost.mjs';

export const TIER_ROWS = Object.freeze([...TIER_LETTERS, '?']);
export const STRATUM_NONE = 'none';
export const STRATUM_UNKNOWN = 'unknown';
export const STRATUM_ORDER = Object.freeze([...RISK_TAGS, STRATUM_NONE, STRATUM_UNKNOWN]);
// The tags that make `script` a non-stratum: RISK_TAGS without script and docs. A test pins this to the shipped table.
export const SCRIPT_SPECIFIC = Object.freeze(RISK_TAGS.filter((t) => t !== 'script' && t !== 'docs'));
export const LOW_EVIDENCE_N = 10;
export const MAX_MIN_N = 1000;
export const TIER_KEYS = Object.freeze({
  document: Object.freeze(['schema', 'as_of_utc', 'clock_fixed', 'freshness', 'tz', 'period', 'population', 'link_confidence',
    'include_inferred', 'min_n', 'filters', 'statistic', 'attribution', 'populations']),
  // Plan 03-04 (J1): each population is built apart; nothing is added across populations.
  population: Object.freeze(['population', 'counts', 'declared_at_close', 'costed', 'low_evidence', 'strata', 'empty_strata', 'leads',
    'leads_omitted']),
  counts: Object.freeze(['units', 'tiered', 'comparable', 'inferred_excluded', 'untiered', 'risk_unknown', 'start_unknown',
    'strata_shown', 'strata_empty']),
  stratum: Object.freeze(['stratum', 'units', 'compared', 'low_evidence', 'inferred_excluded', 'declared_at_close', 'window', 'tokens_unknown',
    'usd_unknown', 'window_share_unknown', 'rows', 'confounders']),
  row: Object.freeze(['tier', 'n', 'costed', 'compared', 'low_evidence', 'tokens', 'usd', 'window_5h', 'window_7d', 'catch',
    'escape', 'evidence_ids']),
  statistic: Object.freeze(['median', 'p75', 'known', 'usd_floor']),
});

const MIN_N_MESSAGE = `the --min-n value must be a whole number from 1 to ${MAX_MIN_N} written without a sign or a leading zero`;
const STRATA_MESSAGE = 'a unit has a risk class that is not a JSON array of known risk tags';
const DECIMAL = /^[1-9][0-9]{0,3}$/;
const byteCompare = (a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
const UNAVAILABLE = Object.freeze({ value: null, label: 'unavailable' });

export function parseMinN(text) {
  if (typeof text !== 'string' || !DECIMAL.test(text) || Number(text) > MAX_MIN_N) throw new RangeError(MIN_N_MESSAGE);
  return Number(text);
}

export const isLowEvidence = (costed, minN) => costed < minN;

// Plan 03-04 (D-04): rows of { tier, tier_signal, tier_timing } -> { n, A, B, C, '?' } of the FORWARD units whose ledger tier was
// declared at the close (isForwardDeclaredAtClose, one definition). They stay in the population n and in no comparable row.
export function declaredAtCloseOf(rows) {
  const out = { n: 0, A: 0, B: 0, C: 0, '?': 0 };
  for (const r of rows) {
    if (!isForwardDeclaredAtClose(r)) continue;
    out.n += 1;
    out[TIER_LETTERS.includes(r.tier) ? r.tier : '?'] += 1;
  }
  return out;
}

// riskClassText: the unit.risk_class column (JSON text of the tag array, NULL for unknown). -> the strata names.
export function strataOf(riskClassText) {
  if (riskClassText === null || riskClassText === undefined) return [STRATUM_UNKNOWN];
  let tags;
  try {
    tags = JSON.parse(riskClassText);
  } catch {
    throw new RangeError(STRATA_MESSAGE);
  }
  if (!Array.isArray(tags) || !tags.every((t) => RISK_TAGS.includes(t))) throw new RangeError(STRATA_MESSAGE);
  if (tags.length === 0) return [STRATUM_NONE];
  const set = new Set(tags);
  if (SCRIPT_SPECIFIC.some((t) => set.has(t))) set.delete('script');
  return RISK_TAGS.filter((t) => set.has(t));
}

// -> 'A' | 'B' | 'C' | '?' for the row the unit belongs to, or null when it is excluded (a tier inferred from probe files
// without includeInferred): the caller counts it and puts it in no row.
export function sideOf(unit, { includeInferred = false } = {}) {
  if (!TIER_LETTERS.includes(unit.tier)) return '?';
  return inTierComparison(unit, { includeInferred }) ? unit.tier : null;
}

// units: [{ unit_key, tier, tier_signal, risk_class }]. -> the non-empty strata in STRATUM_ORDER, each
// { stratum, rows: { A, B, C, '?' } (arrays of units bytewise by unit_key), inferredExcluded }. An unreadable risk class
// puts the unit in the unknown stratum (unknown is never an error and never a guess).
export function stratify(units, { includeInferred = false } = {}) {
  const map = new Map();
  const at = (name) => {
    if (!map.has(name)) map.set(name, { stratum: name, rows: { A: [], B: [], C: [], '?': [] }, inferredExcluded: 0, declaredAtClose: declaredAtCloseOf([]) });
    return map.get(name);
  };
  for (const u of [...units].sort((a, b) => byteCompare(a.unit_key, b.unit_key))) {
    let names;
    try {
      names = strataOf(u.risk_class);
    } catch {
      names = [STRATUM_UNKNOWN];
    }
    const side = sideOf(u, { includeInferred });
    for (const name of names) {
      const st = at(name);
      if (side === null) {
        // A forward unit whose ledger tier was declared at the close is shown apart, never as an inferred exclusion (D-04).
        if (isForwardDeclaredAtClose(u)) {
          st.declaredAtClose.n += 1;
          st.declaredAtClose[u.tier] += 1;
        } else st.inferredExcluded += 1;
      } else st.rows[side].push(u);
    }
  }
  return STRATUM_ORDER.filter((n) => map.has(n)).map((n) => map.get(n));
}

const costedOf = (u, costs) => {
  const c = costs.get(u.unit_key);
  return c && c.calls > 0 && c.tokens !== null && c.tokens !== undefined ? c : null;
};

// usd_floor (review 02-08 WR-01): true when any unit in the set the statistic is taken over (items, so a costed unit with a known
// value) has floor-priced dollars. A floored value is a lower bound and order statistics are monotone in every argument, so the
// true median and p75 are at least the printed ones: `>=` is never false, and it is the simple rule (it over-marks only when every
// floored unit ranks above the median). One flag is shared by the median and p75 and is false for tokens and window shares.
function statistic(items) {
  if (items.length === 0) return { median: null, p75: null, known: 0, usd_floor: false };
  const sorted = [...items].sort((a, b) => a.v - b.v || byteCompare(a.k, b.k));
  return {
    median: nearestRank(sorted, 50).v, p75: nearestRank(sorted, 75).v, known: sorted.length, usd_floor: sorted.some((i) => i.f === true),
  };
}

// The costed units of a row with a per-unit value. pick: the cost field; null values are left out.
function valuesOf(units, costs, pick, floorOf = null) {
  const out = [];
  for (const u of units) {
    const c = costedOf(u, costs);
    if (c === null) continue;
    const v = pick(c);
    if (v !== null && v !== undefined) out.push({ k: u.unit_key, v, f: floorOf !== null && floorOf(c) === true });
  }
  return out;
}

// units: the row's units; costs: Map(unit_key -> cost) from loadUnitCosts. -> a row object with exactly TIER_KEYS.row.
export function summarizeRow(units, costs, { minN = LOW_EVIDENCE_N, tier } = {}) {
  const costed = units.filter((u) => costedOf(u, costs) !== null).length;
  const letter = tier !== '?';
  return {
    tier,
    n: units.length,
    costed,
    compared: letter && costed > 0,
    low_evidence: letter ? isLowEvidence(costed, minN) : null,
    tokens: statistic(valuesOf(units, costs, (c) => c.tokens)),
    usd: statistic(valuesOf(units, costs, (c) => c.usd_nano, (c) => c.usd_floor)),
    window_5h: statistic(valuesOf(units, costs, (c) => c.window_5h)),
    window_7d: statistic(valuesOf(units, costs, (c) => c.window_7d)),
    catch: { ...UNAVAILABLE },
    escape: { ...UNAVAILABLE },
    evidence_ids: [...units].sort((a, b) => byteCompare(a.unit_key, b.unit_key)).map((u) => buildUnitEvidenceId(u.unit_key)),
  };
}

// The unknown counts of a stratum over all its rows: attributed calls with unknown tokens (not costed), costed units with
// unknown dollars, costed units with an unknown window share (either window).
function unknownCounts(rowUnits, costs) {
  let tokens = 0;
  let usd = 0;
  let window = 0;
  for (const u of rowUnits) {
    const c = costs.get(u.unit_key);
    if (!c || c.calls <= 0) continue;
    if (costedOf(u, costs) === null) { tokens += 1; continue; }
    if (c.usd_nano === null || c.usd_nano === undefined) usd += 1;
    if (c.window_5h === null || c.window_5h === undefined || c.window_7d === null || c.window_7d === undefined) window += 1;
  }
  return { tokens_unknown: tokens, usd_unknown: usd, window_share_unknown: window };
}

// The unit at the median rank of a row's ascending token values (equal values ordered by unit key): the unit the median is.
function medianUnitKey(units, costs) {
  const items = valuesOf(units, costs, (c) => c.tokens).sort((a, b) => a.v - b.v || byteCompare(a.k, b.k));
  return items.length === 0 ? null : nearestRank(items, 50).k;
}

const CONFOUNDERS_SQL = `
SELECT unit_key, name, role, value, unknown_calls FROM unit_confounder WHERE link_confidence = ? ORDER BY unit_key, name, role`;

// The confounder comparison of one stratum: the costed units of the compared letter sides, their values read once per unit.
function confoundersOf(st, rows, costs, valuesByUnit, partialByUnit, tz) {
  const compared = TIER_LETTERS.filter((t) => rows.find((r) => r.tier === t)?.compared === true);
  const sides = compared.map((t) => ({
    tier: t,
    units: st.rows[t].filter((u) => costedOf(u, costs) !== null).map((u) => ({
      key: u.unit_key, values: valuesByUnit.get(u.unit_key) ?? unitConfounderValues([]), partial: partialByUnit.get(u.unit_key) ?? {}, start_ms: u.start_ms, end_ms: u.end_ms,
    })),
  }));
  const w = comparisonWindow(sides.flatMap((s) => s.units));
  if (sides.length < 2) {
    return { status: 'no-comparison', sides: compared, window: dayWindow(w, tz), entries: [], unchanged: 0, sideUnits: sides };
  }
  const entries = diffConfounders(sides, { names: Object.keys(CONFOUNDER_KINDS) });
  return {
    status: 'compared',
    sides: compared,
    window: dayWindow(w, tz),
    entries,
    unchanged: entries.filter((e) => e.status === 'unchanged').length,
    sideUnits: sides,
  };
}

const UNITS_SELECT = `
SELECT u.unit_key, u.tier, u.tier_signal, u.tier_timing, u.risk_class, u.start_ms, u.end_ms, u.tier_comparable, u.population
  FROM unit u`;
const UNITS_ORDER = ' ORDER BY u.unit_key';

function inPeriod(u, period) {
  if (!period || period.mode === 'all') return true;
  if (u.start_ms === null || u.start_ms === undefined) return false;
  return (period.sinceMs === null || u.start_ms >= period.sinceMs) && (period.untilMs === null || u.start_ms < period.untilMs);
}

// mode: 'medium' or 'low' (the link-confidence mode of cost and attribution). period: allPeriod() or a resolved range; units
// are selected by their start. -> the plain-data report the renderers lay out.
export function loadTierReport({
  home, now = () => new Date(), tz, clockFixed = false, mode = 'medium', includeInferred = false, minN = LOW_EVIDENCE_N, period = null,
  filters = null, population = 'all',
}) {
  const nowMs = now().getTime();
  // Unit filters select units; call filters select calls: a unit stays only with an attributed call that matches, and its cost
  // counts those calls only. The confounders and the attribution of the unit stay as stored (the attribution line follows the
  // call filters, the confounders describe every attributed call).
  const unitWhere = unitFilterSql(filters);
  const callWhere = callFilterSql(filters);
  const db = openDerivedReadOnly({ home });
  let all;
  let costs;
  let attribution;
  const valuesByUnit = new Map();
  const partialByUnit = new Map();
  try {
    all = db.prepare(`${UNITS_SELECT}${unitWhere ? ` WHERE ${unitWhere.sql}` : ''}${UNITS_ORDER}`).all(...(unitWhere ? unitWhere.params : []));
    costs = loadUnitCosts(db, { mode, callWhere });
    attribution = loadAttributionTotals(db, { mode, callWhere });
    const byUnit = new Map();
    for (const r of db.prepare(CONFOUNDERS_SQL).all(mode)) {
      if (!byUnit.has(r.unit_key)) byUnit.set(r.unit_key, []);
      byUnit.get(r.unit_key).push(r);
    }
    for (const [k, rows] of byUnit) {
      valuesByUnit.set(k, unitConfounderValues(rows));
      partialByUnit.set(k, unitPartialFlags(rows));
    }
  } finally {
    db.close();
  }
  const inScope = all.filter((u) => inPeriod(u, period) && (callWhere === null || (costs.get(u.unit_key)?.calls ?? 0) > 0));
  // --tier limits the printed rows to the named tiers (the unit filter already selected the units).
  const tierRows = filters?.unit?.tier ? TIER_ROWS.filter((t) => filters.unit.tier.includes(t === '?' ? null : t)) : TIER_ROWS;
  // Plan 03-04 (J1): every population is built apart by the one builder below, on that population's units only, so no row,
  // statistic or lead crosses populations and nothing is added across them.
  const buildPopulation = (pop) => {
    const units = inScope.filter((u) => u.population === pop);
    // start_unknown (review 02-08 WR-06a): the units of unknown start among the selected ones, so after the unit filters and, with a
    // call filter, only units with an attributed call that matches it; counted BEFORE the period, because under a bounded period
    // such a unit is outside it (inPeriod) and under the default period it is in the rows.
    const startUnknown = all.filter((u) => u.population === pop && u.start_ms === null
      && (callWhere === null || (costs.get(u.unit_key)?.calls ?? 0) > 0)).length;
    const strata = stratify(units, { includeInferred }).map((st) => {
      const rows = tierRows.map((t) => summarizeRow(st.rows[t], costs, { minN, tier: t }));
      const compared = rows.filter((r) => r.compared).map((r) => r.tier);
      const comparedUnits = TIER_LETTERS.filter((t) => compared.includes(t)).flatMap((t) => st.rows[t].filter((u) => costedOf(u, costs) !== null));
      const confounders = confoundersOf(st, rows, costs, valuesByUnit, partialByUnit, tz);
      return {
        stratum: st.stratum,
        units: rows.reduce((s2, r) => s2 + r.n, 0),
        compared,
        low_evidence: rows.filter((r) => r.compared && r.low_evidence).map((r) => r.tier),
        inferred_excluded: st.inferredExcluded,
        declared_at_close: st.declaredAtClose,
        window: dayWindow(comparisonWindow(comparedUnits), tz),
        ...unknownCounts(tierRows.flatMap((t) => st.rows[t]), costs),
        rows,
        confounders,
        leadSides: confounders.sideUnits.map((side) => {
          const row = rows.find((r) => r.tier === side.tier);
          return {
            tier: side.tier,
            costed: row.costed,
            low_evidence: row.low_evidence,
            tokens_median: row.tokens.median,
            usd_median: row.usd.median,
            usd_floor: row.usd.usd_floor,
            median_unit_key: medianUnitKey(st.rows[side.tier], costs),
            units: side.units,
          };
        }),
      };
    });
    const { leads, omitted } = buildLeads(strata.map((st) => ({ stratum: st.stratum, sides: st.leadSides })), { tz });
    for (const st of strata) { delete st.leadSides; delete st.confounders.sideUnits; }
    const shown = new Set(strata.map((s2) => s2.stratum));
    const emptyStrata = STRATUM_ORDER.filter((n) => !shown.has(n));
    const costed = units.filter((u) => costedOf(u, costs) !== null).length;
    return {
      population: pop,
      counts: {
        units: units.length,
        tiered: units.filter((u) => u.tier !== null).length,
        comparable: units.filter((u) => inTierComparison(u, { includeInferred })).length,
        inferred_excluded: includeInferred ? 0 : units.filter((u) => TIER_LETTERS.includes(u.tier) && u.tier_signal === 'probes-skipped').length,
        untiered: units.filter((u) => u.tier === null).length,
        risk_unknown: units.filter((u) => u.risk_class === null).length,
        start_unknown: startUnknown,
        strata_shown: strata.length,
        strata_empty: emptyStrata.length,
      },
      declared_at_close: declaredAtCloseOf(units),
      costed,
      low_evidence: isLowEvidence(costed, minN),
      emptyStrata,
      strata,
      leads,
      leadsOmitted: omitted,
    };
  };
  const populations = selectedPopulations(population).map(buildPopulation);
  return {
    asOfMs: nowMs,
    clockFixed,
    tz,
    period,
    population,
    linkConfidence: mode,
    includeInferred,
    minN,
    filters,
    filterText: describeFilters(filters),
    attribution,
    populations,
    freshnessCheck: loadFreshness({ home, nowMs }),
  };
}
