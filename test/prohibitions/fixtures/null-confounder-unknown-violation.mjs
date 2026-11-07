// KNOWN-BAD subject for test/prohibitions/null-confounder-unknown.test.mjs: "no difference seen, so unchanged". Any entry with
// fewer than two distinct known values is reported unchanged, whatever its unknown units, the fold the prohibition forbids.
// Everything else is the real module.
import { diffConfounders as real } from '../../../src/report/confounder-diff.mjs';

export {
  CONFOUNDER_KINDS, DIFF_STATUSES, DISPLAY_NAMES, comparisonWindow, unitConfounderValues,
} from '../../../src/report/confounder-diff.mjs';

export function diffConfounders(sides, opts) {
  return real(sides, opts).map((e) => (e.status === 'unknown' || e.status === 'partly-unknown' ? { ...e, status: 'unchanged' } : e));
}
