// Prohibition (plan 02-03, UNIT-03; D-01, D-02, amendment Q6): a tier MUST NOT come from anything but the four D-01
// places (PLAN frontmatter, SUMMARY frontmatter, a RIGOR-TIER line, a PROBES-SKIPPED first line), and an unknown tier
// MUST NOT become a letter. A letter observed in a CONTEXT section, a SUMMARY body line or a plan-text mention of the
// quick command's flags leaves the unit's tier NULL with tier_signal none; no observation at all is never defaulted.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a module exporting tierOf, resolved against process.cwd(); unset means
// src/units/tier.mjs. test/prohibitions/fixtures/tier-signal-only-violation.mjs (takes any letter and defaults to B)
// must fail both tests; test/prohibitions/fixtures/tier-signal-only-clean.mjs (re-exports the real function) must pass.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_SUBJECT = fileURLToPath(new URL('../../src/units/tier.mjs', import.meta.url));
const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : DEFAULT_SUBJECT;

const art = (role, place, letter, relPath) => ({
  role, rel_path: relPath, tier_letter: letter, tier_place: place, first_commit_ms: null, tier_commit_ms: null,
});
const unknownTier = (t) => ({ tier: t.tier, tier_signal: t.tier_signal, tier_conflict: t.tier_conflict });
const NONE = { tier: null, tier_signal: 'none', tier_conflict: false };

it('letters outside the four D-01 places never make a tier', async () => {
  const { tierOf } = await import(pathToFileURL(subject).href);
  const t = tierOf([
    art('context', 'section', 'A', 'q/261020-aaa-CONTEXT.md'),
    art('summary', 'body', 'A', 'q/261020-aaa-SUMMARY.md'),
    art('plan', 'mention', 'A', 'q/261020-aaa-PLAN.md'),
  ]);
  assert.deepEqual(unknownTier(t), NONE, 'a tier was read from outside the D-01 places');
});

it('no accepted observation leaves the tier unknown, never a letter', async () => {
  const { tierOf } = await import(pathToFileURL(subject).href);
  assert.deepEqual(unknownTier(tierOf([])), NONE, 'no observation became a letter');
  const t = tierOf([
    art('plan', 'frontmatter', null, 'q/261020-aaa-PLAN.md'),
    art('summary', 'frontmatter', null, 'q/261020-aaa-SUMMARY.md'),
    art('rigor-tier', 'tier-line', null, 'q/RIGOR-TIER.md'),
    art('probes-skipped', 'probes-line', null, 'q/261020-aaa-PROBES-SKIPPED.md'),
  ]);
  assert.deepEqual(unknownTier(t), NONE, 'artifacts without a letter became a letter');
});
