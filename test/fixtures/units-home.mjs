// The shared units fixture (plan 02-02, UNIT-01, UNIT-02, UNIT-05, ADPT-01): fixture git repositories with quick
// directories, a linked worktree, an untracked .planning/ and transcript sessions whose working directories point at
// them. A helper, not a test. Every expectation below is computed by hand from what this module writes, never by the
// code under test.
//
//   repos/alpha        tracked .planning/; quick dirs 261030-a1b-first-task (PLAN tier A with words after the
//                      letter, SUMMARY tier A), 261029-c2d-second-task (PLAN frontmatter with no tier key, no SUMMARY)
//                      and 261030-a1b-zz-copy (a duplicate id; PLAN tier B; never read)
//   wt/alpha-fix       a linked worktree of alpha on branch fix; the only session cwd that reaches alpha
//   work/beta          .planning/ ignored by .gitignore (untracked); quick dir 261028-e3f-third (PLAN tier C,
//                      SUMMARY tier B: a conflict, the PLAN letter wins)
//   gone/place         a session cwd that does not exist (its nearest existing ancestor is HOME: method none)
// sameName: true adds a/proj and b/proj (two repos named proj), each with one session and one quick dir.
// plants: true puts PLANTS.prompt in a quick PLAN body, PLANTS.command on the tier line after the letter and
// PLANTS.email in a SUMMARY body, never in a directory or file name; plan 02-05 adds one commit in alpha whose scope
// names 261030-a1b, with the subject text PLANTS.prompt, the body PLANTS.command, and the author and committer name
// PLANTS.osUser and email PLANTS.email (the git fact collector must keep none of them).
import { dirname, join } from 'node:path';
import {
  PLANTS, makeAssistant, makeUsage, mangleHome, writeJsonl,
} from './build.mjs';
import {
  addWorktree, assertOutsideWorkTree, commitAll, commitWith, makeRepo, writeFileAt, writeQuickDir,
} from './git-repo.mjs';

export const UNIT_SESSIONS = {
  worktree: 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1',
  beta: 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
  gone: 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3',
  projA: 'b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4',
  projB: 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b5b5',
};

const KEY = {
  alpha: '~/repos/alpha/.git',
  beta: '~/work/beta/.git',
  projA: '~/a/proj/.git',
  projB: '~/b/proj/.git',
};

// The three units of the default fixture, in the order `units` prints them (repo display, kind, native id).
const BASE_UNITS = [
  {
    key: `gsd-core:${KEY.alpha}:quick:261029-c2d`, repo: 'alpha', repoKey: KEY.alpha, nativeId: '261029-c2d',
    dir: '.planning/quick/261029-c2d-second-task', tier: null, signal: 'none', conflict: false,
    idDate: '2026-10-29', startUtcNewYork: '2026-10-29T04:00:00.000Z', day: '2026-10-29',
  },
  {
    key: `gsd-core:${KEY.alpha}:quick:261030-a1b`, repo: 'alpha', repoKey: KEY.alpha, nativeId: '261030-a1b',
    dir: '.planning/quick/261030-a1b-first-task', tier: 'A', signal: 'frontmatter', conflict: false,
    idDate: '2026-10-30', startUtcNewYork: '2026-10-30T04:00:00.000Z', day: '2026-10-30',
  },
  {
    key: `gsd-core:${KEY.beta}:quick:261028-e3f`, repo: 'beta', repoKey: KEY.beta, nativeId: '261028-e3f',
    dir: '.planning/quick/261028-e3f-third', tier: 'C', signal: 'frontmatter', conflict: true,
    idDate: '2026-10-28', startUtcNewYork: '2026-10-28T04:00:00.000Z', day: '2026-10-28',
  },
];

// The two same-name units: their repos share the name proj, so both display by their full key.
const SAME_NAME_UNITS = [
  {
    key: `gsd-core:${KEY.projA}:quick:261027-p1a`, repo: KEY.projA, repoKey: KEY.projA, nativeId: '261027-p1a',
    dir: '.planning/quick/261027-p1a-same', tier: 'B', signal: 'frontmatter', conflict: false,
    idDate: '2026-10-27', startUtcNewYork: '2026-10-27T04:00:00.000Z', day: '2026-10-27',
  },
  {
    key: `gsd-core:${KEY.projB}:quick:261027-p1b`, repo: KEY.projB, repoKey: KEY.projB, nativeId: '261027-p1b',
    dir: '.planning/quick/261027-p1b-same', tier: null, signal: 'none', conflict: false,
    idDate: '2026-10-27', startUtcNewYork: '2026-10-27T04:00:00.000Z', day: '2026-10-27',
  },
];

export const UNITS_EXPECTED = Object.freeze({
  keys: KEY,
  units: BASE_UNITS,
  // The `units:` line of the first ingest (TZ America/New_York) and the counts of `units`.
  // Plan 02-05: five artifacts (a1b PLAN and SUMMARY, c2d PLAN, e3f PLAN and SUMMARY), every unit scanned for git facts;
  // a1b and c2d have git times (alpha tracks .planning/), e3f does not (beta ignores it), and no unit has a commit
  // naming it, so no risk class is known. Three working trees: alpha's main tree and wt/alpha-fix, and beta's.
  ingestLine: 'units: git=ok dirs=3 resolved=2 ancestor=0 none=1 deferred=0 repos=2 scanned=2 quick=3 dup_ids=1 skipped=0 '
    + 'plan=0 artifacts=5 facts=ok facts_units=3 facts_deferred=0 facts_dropped=0 roots=0 root_skipped=0 trees=3 trees_dropped=0',
  counts: {
    units: 3, quick: 3, plan: 0, tiered: 2, untiered: 1, conflicts: 1, repos: 2, present: 3, comparable: 2, git_evidence: 2, risk_known: 0, plan_unbounded: 0, end_clamped: 2,
  },
  dirRepo: [
    { dir: '~/gone/place', repo_key: null, method: 'none', is_worktree: null },
    { dir: '~/work/beta', repo_key: KEY.beta, method: 'git', is_worktree: 0 },
    { dir: '~/wt/alpha-fix', repo_key: KEY.alpha, method: 'git', is_worktree: 1 },
  ],
  repos: [{ repo_key: KEY.alpha, repo_name: 'alpha' }, { repo_key: KEY.beta, repo_name: 'beta' }],
  // unit_artifact rows (unit native id, file name, role, tier letter): a1b PLAN and SUMMARY, c2d PLAN, e3f PLAN and
  // SUMMARY. The duplicate dir 261030-a1b-zz-copy contributes nothing.
  artifacts: [
    ['261028-e3f', '.planning/quick/261028-e3f-third/261028-e3f-PLAN.md', 'plan', 'C'],
    ['261028-e3f', '.planning/quick/261028-e3f-third/261028-e3f-SUMMARY.md', 'summary', 'B'],
    ['261029-c2d', '.planning/quick/261029-c2d-second-task/261029-c2d-PLAN.md', 'plan', null],
    ['261030-a1b', '.planning/quick/261030-a1b-first-task/261030-a1b-PLAN.md', 'plan', 'A'],
    ['261030-a1b', '.planning/quick/261030-a1b-first-task/261030-a1b-SUMMARY.md', 'summary', 'A'],
  ],
  sameName: { units: SAME_NAME_UNITS, displays: [KEY.projA, KEY.projB] },
});

function writeSession(root, home, cwd, session, sec) {
  const file = join(root, 'projects', mangleHome(cwd), `${session}.jsonl`);
  const line = makeAssistant({
    session, ts: `2026-10-27T15:00:${String(sec).padStart(2, '0')}.000Z`, id: `msg_units_${sec}`, model: 'claude-opus-5-5', cwd,
    use: makeUsage({ input: 10, output: 5, read: 0, creation: 0 }),
  });
  writeJsonl(file, [JSON.stringify(line)]);
  return file;
}

export function buildUnitsHome({
  home, root = join(home, '.claude'), plants = false, sameName = false,
}) {
  assertOutsideWorkTree(dirname(home));
  const alpha = join(home, 'repos', 'alpha');
  makeRepo(alpha, { home, files: { 'README.md': 'alpha fixture\n' } });
  writeQuickDir(alpha, {
    id: '261030-a1b',
    slug: 'first-task',
    plan: {
      tier: plants ? `A ${PLANTS.command}` : 'A (guard work; plain words after the letter)',
      extra: ['status: complete'],
      body: plants ? `Plan body. ${PLANTS.prompt}` : 'Plan body.',
    },
    summary: { tier: 'A', body: 'Summary body.' },
  });
  writeQuickDir(alpha, {
    id: '261029-c2d', slug: 'second-task', plan: { extra: ['status: draft'], body: 'No tier here.' }, summary: null,
  });
  writeQuickDir(alpha, {
    id: '261030-a1b', slug: 'zz-copy', plan: { tier: 'B', body: 'A duplicate id.' }, summary: null,
  });
  commitAll(alpha, { home });
  if (plants) {
    writeFileAt(alpha, 'src/alpha/canary.mjs', 'export const canary = 1;\n');
    commitWith(alpha, {
      home,
      date: '2026-10-27T13:00:00Z',
      message: `feat(261030-a1b): ${PLANTS.prompt}\n\n${PLANTS.command}`,
      name: PLANTS.osUser,
      email: PLANTS.email,
    });
  }
  const worktree = join(home, 'wt', 'alpha-fix');
  addWorktree(alpha, worktree, 'fix', { home });

  const beta = join(home, 'work', 'beta');
  makeRepo(beta, { home, files: { 'README.md': 'beta fixture\n' }, untrackedPlanning: true });
  writeQuickDir(beta, {
    id: '261028-e3f',
    slug: 'third',
    plan: { tier: 'C', body: 'Plan body.' },
    summary: { tier: 'B', body: plants ? `Summary body. ${PLANTS.email}` : 'Summary body.' },
  });
  commitAll(beta, { home });

  const files = [
    writeSession(root, home, worktree, UNIT_SESSIONS.worktree, 1),
    writeSession(root, home, beta, UNIT_SESSIONS.beta, 2),
    writeSession(root, home, join(home, 'gone', 'place'), UNIT_SESSIONS.gone, 3),
  ];
  const out = { alpha, beta, worktree, files, expected: UNITS_EXPECTED };
  if (sameName) {
    const projA = join(home, 'a', 'proj');
    const projB = join(home, 'b', 'proj');
    makeRepo(projA, { home, files: { 'README.md': 'proj a\n' } });
    makeRepo(projB, { home, files: { 'README.md': 'proj b\n' } });
    writeQuickDir(projA, { id: '261027-p1a', slug: 'same', plan: { tier: 'B', body: 'Plan body.' } });
    writeQuickDir(projB, { id: '261027-p1b', slug: 'same', plan: { body: 'Plan body.' } });
    commitAll(projA, { home });
    commitAll(projB, { home });
    files.push(writeSession(root, home, projA, UNIT_SESSIONS.projA, 4));
    files.push(writeSession(root, home, projB, UNIT_SESSIONS.projB, 5));
    Object.assign(out, { projA, projB });
  }
  return out;
}
