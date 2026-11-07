// The tier rules of a reconstructed unit (plan 02-03; D-01..D-04, CONTEXT amendments Q1 and Q6, TIER-02). Pure: no
// import, no I/O. The gsd-core collector (src/adapters/gsd-core/signals.mjs) reads the observations and commit facts;
// derive (plan 02-05) calls these functions over the stored rows.
//
// D-01 precedence, highest first; each accepted observation is an artifact { role, rel_path, tier_letter, tier_place }:
//   1. role plan,           place frontmatter  -> tier_signal frontmatter      (PLAN over SUMMARY, plan 02-02)
//   2. role summary,        place frontmatter  -> tier_signal frontmatter
//   3. role rigor-tier,     place tier-line    -> tier_signal tier-file
//   4. role probes-skipped, place probes-line  -> tier_signal probes-skipped
// Within one place the bytewise-first rel_path wins. Nothing else is a signal and nothing is ever defaulted (D-02,
// Q6): a CONTEXT section, a SUMMARY body line, a plan-text mention of the quick command's validate or full flag, any
// other role or place, or a letter outside A, B, C is ignored, and a unit with no accepted observation has tier NULL
// with tier_signal none. tier_conflict (D-04) is true when the accepted observations carry two or more letters; the
// higher place still wins.
//
// Timing (Q1, tier_timing): from commit order, for every signal kind. The signal time is the oldest commit changing
// a `tier:` line of the winning file for a frontmatter signal (tier_commit_ms), else the winning file's first add
// commit (first_commit_ms), with no fallback between the two. declared-at-start when the signal is strictly before
// the first implementation commit; else declared-at-close when the SUMMARY exists and the signal is at or after its
// first commit; else declared-mid-unit when implementation commits exist; else NULL. NULL whenever the signal time is
// NULL (an untracked `.planning/`, git unavailable). `inferred` is reserved and never produced in phase 2: D-03's
// tier inferred from probe files is tier_signal probes-skipped, which inTierComparison leaves out by default.

export const TIER_LETTERS = Object.freeze(['A', 'B', 'C']);
export const TIER_SIGNALS = Object.freeze(['frontmatter', 'tier-file', 'probes-skipped', 'ledger', 'none']);
export const TIER_TIMINGS = Object.freeze(['declared-at-start', 'declared-at-close', 'declared-mid-unit', 'inferred']);
export const TIER_PRECEDENCE = Object.freeze([
  Object.freeze({ role: 'plan', place: 'frontmatter', signal: 'frontmatter' }),
  Object.freeze({ role: 'summary', place: 'frontmatter', signal: 'frontmatter' }),
  Object.freeze({ role: 'rigor-tier', place: 'tier-line', signal: 'tier-file' }),
  Object.freeze({ role: 'probes-skipped', place: 'probes-line', signal: 'probes-skipped' }),
]);

const PLANNING_PREFIX = '.planning/';

function compareBytes(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return Buffer.compare(x, y);
}

const rankOf = (a) => TIER_PRECEDENCE.findIndex((p) => p.role === a?.role && p.place === a?.tier_place);
const isMs = (v) => typeof v === 'number' && Number.isFinite(v);

// -> { tier, tier_native, tier_signal, tier_conflict, winner } (winner: the winning artifact or null).
export function tierOf(artifacts) {
  const accepted = [];
  for (const a of Array.isArray(artifacts) ? artifacts : []) {
    if (a === null || typeof a !== 'object') continue;
    if (!TIER_LETTERS.includes(a.tier_letter)) continue;
    const rank = rankOf(a);
    if (rank === -1) continue;
    accepted.push({ rank, a });
  }
  if (accepted.length === 0) {
    return { tier: null, tier_native: null, tier_signal: 'none', tier_conflict: false, winner: null };
  }
  accepted.sort((x, y) => x.rank - y.rank || compareBytes(x.a.rel_path, y.a.rel_path));
  const { rank, a } = accepted[0];
  const letters = new Set(accepted.map((x) => x.a.tier_letter));
  return {
    tier: a.tier_letter,
    tier_native: a.tier_letter,
    tier_signal: TIER_PRECEDENCE[rank].signal,
    tier_conflict: letters.size > 1,
    winner: a,
  };
}

// -> the sorted author_ms of the commits that change at least one path outside `.planning/`, or null for null.
export function implementationTimes(commits) {
  if (commits === null || commits === undefined) return null;
  if (!Array.isArray(commits)) return null;
  const out = [];
  for (const c of commits) {
    if (!isMs(c?.author_ms) || !Array.isArray(c.files)) continue;
    if (c.files.some((f) => typeof f?.path === 'string' && !f.path.startsWith(PLANNING_PREFIX))) out.push(c.author_ms);
  }
  return out.sort((x, y) => x - y);
}

// -> one of the declared-* values or null (see the header).
export function tierTiming({ signalMs, implMs, summaryFirstMs } = {}) {
  if (!isMs(signalMs)) return null;
  const impl = Array.isArray(implMs) ? implMs.filter(isMs) : [];
  if (impl.length > 0 && signalMs < impl[0]) return 'declared-at-start';
  if (isMs(summaryFirstMs) && signalMs >= summaryFirstMs) return 'declared-at-close';
  if (impl.length > 0) return 'declared-mid-unit';
  return null;
}

// -> { tier, tier_native, tier_signal, tier_timing, tier_conflict } of one unit.
export function unitTier({ artifacts, commits } = {}) {
  const t = tierOf(artifacts);
  if (t.tier === null) {
    return { tier: null, tier_native: null, tier_signal: 'none', tier_timing: null, tier_conflict: false };
  }
  const w = t.winner;
  const signalMs = w.tier_place === 'frontmatter' ? w.tier_commit_ms : w.first_commit_ms;
  const summaries = (Array.isArray(artifacts) ? artifacts : [])
    .filter((a) => a?.role === 'summary')
    .sort((x, y) => compareBytes(x.rel_path, y.rel_path));
  const summaryFirstMs = summaries.length > 0 ? summaries[0].first_commit_ms : null;
  const implMs = implementationTimes(commits);
  return {
    tier: t.tier,
    tier_native: t.tier_native,
    tier_signal: t.tier_signal,
    tier_timing: tierTiming({ signalMs, implMs, summaryFirstMs }),
    tier_conflict: t.tier_conflict,
  };
}

// TIER-02, D-03: whether a unit takes part in a tier comparison. A unit with no tier never does; a tier read from a
// PROBES-SKIPPED line only when the caller asks to include inferred tiers; a ledger tier (plan 03-03) only when its timing is
// declared-at-start.
export function inTierComparison(unit, { includeInferred = false } = {}) {
  if (!unit || !TIER_LETTERS.includes(unit.tier)) return false;
  if (unit.tier_signal === 'none' || !TIER_SIGNALS.includes(unit.tier_signal)) return false;
  if (unit.tier_signal === 'probes-skipped') return includeInferred === true;
  // Plan 03-03 (D-04): a tier the ledger recorded takes part only when it was declared at the start; a tier declared at the
  // close (or with no timing) is known only after the work, so it is not compared.
  if (unit.tier_signal === 'ledger') return unit.tier_timing === 'declared-at-start';
  return true;
}

// Plan 03-04 (D-04): a FORWARD unit whose tier the ledger recorded at the close. One definition, used by the tier report's
// stratify and by the units report's strata: the tier letter is known AND the signal is `ledger` AND the timing is
// declared-at-close. A reconstructed unit never has the signal `ledger`, so it is never matched (it keeps inTierComparison's
// timing-blind behavior).
export const isForwardDeclaredAtClose = (unit) => TIER_LETTERS.includes(unit?.tier) && unit.tier_signal === 'ledger'
  && unit.tier_timing === 'declared-at-close';
