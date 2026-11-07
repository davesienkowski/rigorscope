// The unit post-step of an ingest run (plan 02-02, D-08, UNIT-05). The runner (src/ingest/run.mjs) calls it inside the
// ingest lock, after every source and before the run row is closed; it is not a source, so the source list and the
// first output line of `ingest` do not change. It resolves every new session directory to a repo (repo-resolve.mjs),
// yields at an interrupt checkpoint with no transaction open, adds the configured repo roots (plan 02-05, D-09), then
// reconstructs the quick units of every known repo
// and phase plans of every known repo (the gsd-core adapter), yields again, and stores the git facts of the units whose
// repo refs changed (plan 02-05, src/adapters/gsd-core/facts.mjs). -> the merged counts in the order of the ingest
// `units:` line.
import { collectUnits } from '../adapters/gsd-core/index.mjs';
import { collectFacts } from '../adapters/gsd-core/facts.mjs';
import { resolveRepos } from './repo-resolve.mjs';
import { resolveConfiguredRoots } from './roots.mjs';

// env: the ingest environment; only RIGORSCOPE_REPO_ROOTS is read from it (src/units/roots.mjs, plan 02-05).
export async function runUnitSteps({
  db, home, runId, checkpoint = async () => {}, run, env = {},
}) {
  const r = resolveRepos({ db, home, runId, ...(run ? { run } : {}) });
  await checkpoint();
  const roots = resolveConfiguredRoots({
    db, home, env, runId, ...(run ? { run } : {}),
  });
  await checkpoint();
  const u = await collectUnits({ db, home, runId, checkpoint });
  await checkpoint();
  const f = await collectFacts({ db, home, runId, checkpoint });
  return {
    git: r.git,
    dirs: r.dirs,
    resolved: r.resolved,
    ancestor: r.ancestor,
    none: r.none,
    deferred: r.deferred,
    repos: u.repos,
    scanned: u.scanned,
    quick: u.quick,
    dup_ids: u.dupIds,
    skipped: u.skipped,
    plan: u.plan,
    artifacts: u.artifacts,
    facts: f.facts,
    facts_units: f.units,
    facts_deferred: f.deferred,
    facts_dropped: f.dropped,
    roots: roots.roots,
    root_skipped: roots.skipped,
    trees: u.trees,
    trees_dropped: u.treesDropped,
    // Plan 03.1-01: the location counters summed over the repos scanned in this run (null when none was), printed on the
    // `locations:` line, not on the `units:` line.
    locations: u.locations,
    locations_repos: u.locationsRepos,
    // Plan 03.1-04: the artifact class counts of the repos scanned in this run (null when none was), printed on the
    // `classes:` line right after `locations:`.
    classes: u.classes,
    classes_repos: u.classesRepos,
  };
}
