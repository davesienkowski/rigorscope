// The strata fixture of plan 03-04 (TRUST-03, D-15): a units home (or the tier home) plus forward ledger lines. A helper, not a
// test. It wraps buildUnitsHome / buildTierHome and the 03-01 line builder and appender, so a unit becomes forward exactly the
// way the product makes it: a line in <HOME>/.rigorscope/ledger/units.jsonl that the next ingest reads. Nothing here opens a
// database. Expectations are written by the tests from what this module appends, never from rigorscope output.
import assert from 'node:assert/strict';
import { appendLine } from '../../src/ledger/append.mjs';
import { buildLine } from '../../src/ledger/line.mjs';
import { buildTierHome, REPO_KEY as TIER_REPO_KEY } from './tier-home.mjs';
import { buildUnitsHome } from './units-home.mjs';

export const STRATA_NOW = '2026-11-01T00:00:00Z';
export const ALPHA_KEY = '~/repos/alpha/.git';
export const keyOf = (repoKey, nativeId, kind = 'quick') => `gsd-core:${repoKey}:${kind}:${nativeId}`;
export const A1 = keyOf(ALPHA_KEY, '261030-a1b');
export const C2D = keyOf(ALPHA_KEY, '261029-c2d');
export const E3F = keyOf('~/work/beta/.git', '261028-e3f');

// One buildLine call; the defaults are the alpha quick units of buildUnitsHome. Returns the line text.
export function lineText(over) {
  const r = buildLine({ repo_key: ALPHA_KEY, kind: 'quick', record: 'start', tier_source: 'unknown', ...over });
  assert.equal(r.ok, true, `${r.reason} ${JSON.stringify(over)}`);
  return r.text;
}

// A start line that declares tier C at the plan stage for one quick unit (a forward unit in the comparable row of its letter).
export const planAtStart = (nativeId, ts, { tier = 'C', repoKey = ALPHA_KEY } = {}) => lineText({
  record: 'start', ts, native_id: nativeId, repo_key: repoKey, tier, tier_source: 'plan-at-start',
});
// A start line with no tier plus a close line that declares one (timing declared-at-close).
export const declaredAtClose = (nativeId, tsStart, tsClose, { tier = 'B', repoKey = ALPHA_KEY } = {}) => [
  lineText({ record: 'start', ts: tsStart, native_id: nativeId, repo_key: repoKey, tier_source: 'unknown' }),
  lineText({
    record: 'close', ts: tsClose, native_id: nativeId, repo_key: repoKey, tier, tier_source: 'declared-at-close', status: 'complete',
  }),
];

// base: 'units' (3 reconstructed units, no attributed calls) or 'tier' (36 generated units with attributed calls).
// texts: ledger line texts appended in order. The caller runs ingest afterwards.
export function buildStrataHome({
  home, root, base = 'units', texts = [],
}) {
  const built = base === 'tier' ? buildTierHome({ home, root }) : buildUnitsHome({ home, root });
  for (const t of texts) appendLine(home, t);
  return { built, repoKey: base === 'tier' ? TIER_REPO_KEY : ALPHA_KEY };
}

// Plan 03-04 (J1): a tier document of a HOME with no forward unit, with its reconstructed population lifted to the old
// top-level names (counts, strata, leads, leads_omitted), so the phase 2 assertions on a reconstructed-only HOME read unchanged
// while the new `populations` array stays in the document. The document keys themselves are asserted on the raw document.
export function reconstructedView(doc) {
  const p = doc?.populations?.find((x) => x.population === 'reconstructed');
  if (!p) return doc;
  return {
    ...doc, counts: p.counts, strata: p.strata, leads: p.leads, leads_omitted: p.leads_omitted, empty_strata: p.empty_strata,
  };
}
