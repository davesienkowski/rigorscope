// KNOWN-BAD subject for test/prohibitions/unknown-tier-not-compared.test.mjs: "put every unit somewhere". A unit with an unknown
// tier is sent to the C row and a tier inferred from probe files stays in its letter row by default, the two folds the
// prohibition forbids. Everything else is the real module.
import { stratify as real } from '../../../src/report/tier.mjs';

export {
  LOW_EVIDENCE_N, MAX_MIN_N, SCRIPT_SPECIFIC, STRATUM_NONE, STRATUM_ORDER, STRATUM_UNKNOWN, TIER_KEYS, TIER_ROWS, isLowEvidence,
  loadTierReport, parseMinN, sideOf, strataOf, summarizeRow,
} from '../../../src/report/tier.mjs';

export function stratify(units, opts) {
  return real(units.map((u) => (u.tier === null ? { ...u, tier: 'C', tier_signal: 'frontmatter' }
    : (u.tier_signal === 'probes-skipped' ? { ...u, tier_signal: 'frontmatter' } : u))), opts);
}
