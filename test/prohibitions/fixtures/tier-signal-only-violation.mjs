// Violation fixture for test/prohibitions/tier-signal-only.test.mjs: takes the first artifact with any letter, whatever
// its role or place, and defaults to B when none has one. It must fail both tests.
export function tierOf(artifacts) {
  const hit = (Array.isArray(artifacts) ? artifacts : []).find((a) => typeof a?.tier_letter === 'string');
  if (hit) return { tier: hit.tier_letter, tier_native: hit.tier_letter, tier_signal: 'frontmatter', tier_conflict: false, winner: hit };
  return { tier: 'B', tier_native: 'B', tier_signal: 'frontmatter', tier_conflict: false, winner: null };
}
