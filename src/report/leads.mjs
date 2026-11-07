// The ranked leads of the tier report (plan 02-08, TRUST-08, D-18): up to MAX_LEADS one-sentence pointers to the tier
// differences with the most evidence behind them, each with the `u:` ids to check. Pure.
//
// A candidate is a pair of compared letter sides (each has at least one costed unit) inside ONE risk stratum, in pair order
// A-B, A-C, B-C; a lead never pools strata and never names a tier of the `?` row. Candidates are ordered lexicographically by
// the smaller side's costed count (descending: evidence first), then the absolute median token gap (descending, an unknown gap
// last), then the stratum order (RISK_TAGS, none, unknown), then the pair order. No number combines them, no score or
// verdict exists, and the order does not depend on the order the strata are given. A lead's evidence ids are each side's
// median unit (the unit the median figure is); the full unit lists are in the tier rows. The confounders of a lead are the
// diff of the pair's two sides alone (diffConfounders): `changed` names, and `unknown` names (unknown and partly-unknown).
import { formatUsd } from '../measure/measure.mjs';
import { buildUnitEvidenceId } from '../measure/rowkey.mjs';
import { RISK_TAGS } from '../units/risk.mjs';
import {
  CONFOUNDER_KINDS, comparisonWindow, dayWindow, diffConfounders,
} from './confounder-diff.mjs';

export const MAX_LEADS = 5;
export const PAIR_ORDER = Object.freeze([Object.freeze(['A', 'B']), Object.freeze(['A', 'C']), Object.freeze(['B', 'C'])]);
export const LEAD_KEYS = Object.freeze(['rank', 'stratum', 'tiers', 'sentence', 'costed', 'low_evidence', 'median_tokens', 'median_usd',
  'notional_floor', 'gap_tokens', 'direction', 'confounders_changed', 'confounders_unknown', 'window', 'evidence_ids']);
const STRATUM_ORDER = Object.freeze([...RISK_TAGS, 'none', 'unknown']);
const stratumRank = (name) => {
  const i = STRATUM_ORDER.indexOf(name);
  return i === -1 ? STRATUM_ORDER.length : i;
};

// strata: [{ stratum, sides: [{ tier, costed, low_evidence, tokens_median, usd_median, median_unit_key, units }] }].
export function candidateLeads(strata) {
  const out = [];
  for (const st of Array.isArray(strata) ? strata : []) {
    const by = new Map((st.sides ?? []).filter((s) => s.costed > 0 && s.tokens_median !== null).map((s) => [s.tier, s]));
    PAIR_ORDER.forEach(([x, y], pairRank) => {
      if (!by.has(x) || !by.has(y)) return;
      const sx = by.get(x);
      const sy = by.get(y);
      out.push({
        stratum: st.stratum,
        tiers: [x, y],
        sides: [sx, sy],
        count: Math.min(sx.costed, sy.costed),
        gap: Math.abs(sx.tokens_median - sy.tokens_median),
        stratumRank: stratumRank(st.stratum),
        pairRank,
      });
    });
  }
  return out;
}

export function orderLeads(candidates) {
  return [...candidates].sort((a, b) => b.count - a.count
    || (a.gap === null ? 1 : 0) - (b.gap === null ? 1 : 0) || (b.gap ?? 0) - (a.gap ?? 0)
    || a.stratumRank - b.stratumRank || a.pairRank - b.pairRank);
}

// A floored side prints with >= like `cost` does (review 02-08 WR-01): its dollars are a lower bound.
const usdText = (nano, floor = false) => (nano === null || nano === undefined ? '?' : `${floor === true ? '>=' : ''}${formatUsd(nano / 1e9)}`);
const namesText = (names) => (names.length === 0 ? 'none' : names.join(', '));

// The sentence of one candidate with its computed parts: { direction, gap, changed, unknown, low, evidenceIds }.
export function leadSentence(c, parts) {
  const [x, y] = c.tiers;
  const [sx, sy] = c.sides;
  const how = parts.direction === 'same' ? 'the same median number of tokens as' : `a median of ${parts.gap} tokens ${parts.direction} than`;
  const low = parts.low.length === 0 ? '' : `, low evidence on ${parts.low.join(',')}`;
  return `In risk stratum ${c.stratum}, tier ${x} units cost ${how} tier ${y} (${sx.tokens_median} vs ${sy.tokens_median} tokens; `
    + `notional ${usdText(sx.usd_median, sx.usd_floor)} vs ${usdText(sy.usd_median, sy.usd_floor)}) (costed n=${sx.costed} vs ${sy.costed}${low}); `
    + `confounders changed: ${namesText(parts.changed)}; unknown: ${namesText(parts.unknown)}. `
    + `Evidence: ${parts.evidenceIds.join(', ')}.`;
}

function leadOf(c, rank, tz) {
  const [sx, sy] = c.sides;
  const entries = diffConfounders(c.tiers.map((t, i) => ({ tier: t, units: c.sides[i].units ?? [] })), { names: Object.keys(CONFOUNDER_KINDS) });
  const changed = entries.filter((e) => e.status === 'changed').map((e) => e.display);
  const unknown = entries.filter((e) => e.status === 'unknown' || e.status === 'partly-unknown').map((e) => e.display);
  const diff = sx.tokens_median - sy.tokens_median;
  const direction = diff > 0 ? 'more' : (diff < 0 ? 'fewer' : 'same');
  const low = c.tiers.filter((t, i) => c.sides[i].low_evidence === true);
  const evidenceIds = c.sides.map((s) => buildUnitEvidenceId(s.median_unit_key));
  const w = comparisonWindow(c.sides.flatMap((s) => s.units ?? []));
  const window = dayWindow(w, tz);
  const parts = { direction, gap: c.gap, changed, unknown, low, evidenceIds };
  return {
    rank,
    stratum: c.stratum,
    tiers: [...c.tiers],
    sentence: leadSentence(c, parts),
    costed: c.sides.map((s) => s.costed),
    low_evidence: low,
    median_tokens: c.sides.map((s) => s.tokens_median),
    median_usd: c.sides.map((s) => (s.usd_median === undefined ? null : s.usd_median)),
    notional_floor: c.sides.map((s) => s.usd_floor === true && s.usd_median !== null && s.usd_median !== undefined),
    gap_tokens: c.gap,
    direction,
    confounders_changed: changed,
    confounders_unknown: unknown,
    window,
    evidence_ids: evidenceIds,
  };
}

// -> { leads, omitted }: at most maxLeads leads in order, the rest counted.
export function buildLeads(strata, { maxLeads = MAX_LEADS, tz = 'UTC' } = {}) {
  const ordered = orderLeads(candidateLeads(strata));
  const shown = ordered.slice(0, maxLeads);
  return { leads: shown.map((c, i) => leadOf(c, i + 1, tz)), omitted: ordered.length - shown.length };
}
