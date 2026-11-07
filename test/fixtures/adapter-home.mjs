// The adapter fixture of plan 02-05 (ADPT-01, UNIT-05, D-09, D-10): phase plans, every artifact role, a duplicate
// and a misplaced plan id, an untracked repo with a worktree-only quick dir, and a repo reached only through a
// configured root. A helper, not a test. It uses only test/fixtures/git-repo.mjs helpers, the transcript helpers of
// test/fixtures/build.mjs and node built-ins; every expectation below is computed by hand from what this module
// writes, never by the code under test. Read with TZ=UTC.
//
//   repos/omega      `.planning/` tracked. Phase dir 02-alpha: 02-01 (PLAN tier B with files_modified src/omega/a.mjs,
//                    SUMMARY tier B), 02-02 (PLAN without tier, its own REVIEW), the phase-level CONTEXT (tier A, never a
//                    signal), VERIFICATION, REVIEW and REVIEW-2, and a RESEARCH file (no role). 02.1-hotfix: 02.1-01
//                    (PLAN tier C). 02-alpha-old: a second 02-01 PLAN (a duplicate id). 03-beta: 04-01-PLAN.md (another
//                    phase's id: not a unit). Quick dir 261021-k1m-roles holds every quick role plus three files with no
//                    role and a symlink; quick dir 261024-pq1-probes holds only a probes-skipped file (Tier C).
//                    Commits: the fixture commit, T1 `docs(02-01)` adding every planning file, T2 `feat(02-01)` adding
//                    src/omega/a.mjs, T3 `feat(261021-k1m)` adding src/omega/k.mjs.
//   repos/sigma      `.planning/` ignored. Quick dir 261025-s1a-main (PLAN tier B, SUMMARY `completed: 2026-10-26`) and
//                    phase dir 05-gamma with 05-01-PLAN.md (no tier, mtime M1). A linked worktree wt/sigma-wip holds
//                    the untracked quick dir 261027-w2b-wt-only (PLAN tier A, mtime M2); it is never a session cwd.
//   elsewhere/tau    `.planning/` tracked: quick dir 261028-t3c-root (PLAN tier B); never a cwd, reached only through
//                    RIGORSCOPE_REPO_ROOTS.
//   plain-dir        a directory outside any repository.
// Sessions: one with cwd repos/omega and one with cwd repos/sigma. Every file body holds a planted phrase that must
// never reach a database or an output.
import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeAssistant, makeUsage, mangleHome, writeJsonl } from './build.mjs';
import {
  addWorktree, assertOutsideWorkTree, commitAt, makeRepo, writeFileAt, writePhaseDir,
} from './git-repo.mjs';

export const ADAPTER_TIMES = Object.freeze({
  T1: '2026-10-28T09:00:00.000Z',
  T2: '2026-10-28T10:00:00.000Z',
  T3: '2026-10-28T11:00:00.000Z',
  M1: '2026-10-29T10:00:00.000Z',
  M2: '2026-10-29T11:00:00.000Z',
});

// Text that must never reach store.db, derived.db or any output.
export const ADAPTER_PLANT = 'planted-adapter-body-saffron';
export const ADAPTER_SESSIONS = Object.freeze({
  omega: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
  sigma: 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2',
});

const md = (front, body = ADAPTER_PLANT) => `${['---', ...front, '---', '', body, ''].join('\n')}`;
const json = () => `${JSON.stringify({ note: ADAPTER_PLANT })}\n`;

const KEY = {
  omega: '~/repos/omega/.git',
  sigma: '~/repos/sigma/.git',
  tau: '~/elsewhere/tau/.git',
};
const unitKey = (repo, kind, id) => `gsd-core:${KEY[repo]}:${kind}:${id}`;

const ROLES = ['plan', 'summary', 'context', 'verification', 'review', 'windows', 'rigor-tier', 'probes-skipped', 'probe', 'refute-pass'];
const roles = (counts) => Object.fromEntries(ROLES.map((r) => [r, counts[r] ?? 0]));

export const ADAPTER_EXPECTED = Object.freeze({
  keys: KEY,
  // The units of an ingest without configured roots, in listing order.
  units: [
    unitKey('omega', 'plan', '02-01'), unitKey('omega', 'plan', '02-02'), unitKey('omega', 'plan', '02.1-01'),
    unitKey('omega', 'quick', '261021-k1m'), unitKey('omega', 'quick', '261024-pq1'),
    unitKey('sigma', 'plan', '05-01'), unitKey('sigma', 'quick', '261025-s1a'), unitKey('sigma', 'quick', '261027-w2b'),
  ],
  worktreeOnly: unitKey('sigma', 'quick', '261027-w2b'),
  rootOnly: unitKey('tau', 'quick', '261028-t3c'),
  artifacts: {
    [unitKey('omega', 'plan', '02-01')]: roles({
      plan: 1, summary: 1, context: 1, verification: 1, review: 2,
    }),
    [unitKey('omega', 'plan', '02-02')]: roles({
      plan: 1, context: 1, verification: 1, review: 3,
    }),
    [unitKey('omega', 'quick', '261021-k1m')]: roles({
      plan: 1, summary: 1, context: 1, verification: 1, review: 1, windows: 1, 'rigor-tier': 1, 'probes-skipped': 1, probe: 3, 'refute-pass': 2,
    }),
  },
  // [value, signal, conflict, comparable]
  tiers: {
    [unitKey('omega', 'plan', '02-01')]: ['B', 'frontmatter', false, true],
    [unitKey('omega', 'plan', '02-02')]: [null, 'none', false, false],
    [unitKey('omega', 'plan', '02.1-01')]: ['C', 'frontmatter', false, true],
    [unitKey('omega', 'quick', '261021-k1m')]: ['A', 'tier-file', true, true],
    [unitKey('omega', 'quick', '261024-pq1')]: ['C', 'probes-skipped', false, false],
    [unitKey('sigma', 'quick', '261027-w2b')]: ['A', 'frontmatter', false, true],
  },
  // start and end: [utc, date_source, precision]
  dates: {
    [unitKey('sigma', 'quick', '261025-s1a')]: {
      start: ['2026-10-25T00:00:00.000Z', 'quick-id', 'day'], end: ['2026-10-26T23:59:59.999Z', 'frontmatter', 'day'], git: false,
    },
    [unitKey('sigma', 'plan', '05-01')]: {
      start: [ADAPTER_TIMES.M1, 'mtime', 'instant'], end: [ADAPTER_TIMES.M1, 'mtime', 'instant'], git: false,
    },
    [unitKey('sigma', 'quick', '261027-w2b')]: {
      start: ['2026-10-27T00:00:00.000Z', 'quick-id', 'day'], end: [ADAPTER_TIMES.M2, 'mtime', 'instant'], git: false,
    },
    [unitKey('omega', 'plan', '02-01')]: {
      start: [ADAPTER_TIMES.T1, 'git', 'instant'], end: [ADAPTER_TIMES.T2, 'git', 'instant'], git: true,
    },
  },
  dupIds: 1,
  skipped: 2,
});

function writeSession(root, cwd, session, sec) {
  const line = makeAssistant({
    session, ts: `2026-10-28T15:00:0${sec}.000Z`, id: `msg_adapter_${sec}`, model: 'claude-opus-5-5', cwd,
    use: makeUsage({ input: 4, output: 2, read: 0, creation: 0 }),
  });
  writeJsonl(join(root, 'projects', mangleHome(cwd), `${session}.jsonl`), [JSON.stringify(line)]);
}

function buildOmega(omega, home) {
  const T = ADAPTER_TIMES;
  makeRepo(omega, { home, files: { 'README.md': 'omega\n' } });
  writePhaseDir(omega, {
    name: '02-alpha',
    files: {
      '02-01-PLAN.md': md(['tier: B', 'files_modified:', '  - src/omega/a.mjs']),
      '02-01-SUMMARY.md': md(['tier: B']),
      '02-02-PLAN.md': md(['phase: 02-alpha']),
      '02-02-REVIEW.md': md(['status: clean']),
      '02-CONTEXT.md': md(['tier: A']),
      '02-VERIFICATION.md': md(['status: passed']),
      '02-REVIEW.md': md(['status: clean']),
      '02-REVIEW-2.md': md(['status: clean']),
      '02-RESEARCH.md': md(['tier: A']),
    },
  });
  writePhaseDir(omega, { name: '02.1-hotfix', files: { '02.1-01-PLAN.md': md(['tier: C']) } });
  writePhaseDir(omega, { name: '02-alpha-old', files: { '02-01-PLAN.md': md(['tier: A']) } });
  writePhaseDir(omega, { name: '03-beta', files: { '04-01-PLAN.md': md(['tier: A']) } });
  const k = '.planning/quick/261021-k1m-roles';
  const files = {
    '261021-k1m-PLAN.md': md(['status: draft']),
    '261021-k1m-SUMMARY.md': md(['status: complete']),
    '261021-k1m-CONTEXT.md': md(['tier: C']),
    '261021-k1m-VERIFICATION.md': md(['status: passed']),
    '261021-k1m-REVIEW.md': md(['status: clean']),
    '261021-k1m-WINDOWS.md': md([]),
    'RIGOR-TIER.md': `# Rigor tier\n\nTier: A\n${ADAPTER_PLANT}\n`,
    '261021-k1m-PROBES-SKIPPED.md': `Tier B advisory ${ADAPTER_PLANT}\n`,
    '261021-k1m-EDGES.json': json(),
    '261021-k1m-EDGE-REQS.json': json(),
    '261021-k1m-PROHIBITIONS.json': json(),
    '261021-k1m-REFUTE.md': md([]),
    '261021-k1m-CLAIMS.json': json(),
    'notes.txt': `${ADAPTER_PLANT}\n`,
    '261021-k1m-RED.txt': `${ADAPTER_PLANT}\n`,
  };
  for (const [name, text] of Object.entries(files)) writeFileAt(omega, `${k}/${name}`, text);
  symlinkSync('261021-k1m-PLAN.md', join(omega, k, '261021-k1m-LINK.md'));
  writeFileAt(omega, '.planning/quick/261024-pq1-probes/261024-pq1-PROBES-SKIPPED.md', `Tier C advisory ${ADAPTER_PLANT}\n`);
  commitAt(omega, { home, date: T.T1, message: 'docs(02-01): planning files' });
  writeFileAt(omega, 'src/omega/a.mjs', 'export const a = 1;\nexport const b = 2;\n');
  commitAt(omega, { home, date: T.T2, message: 'feat(02-01): a' });
  writeFileAt(omega, 'src/omega/k.mjs', 'export const k = 1;\n');
  commitAt(omega, { home, date: T.T3, message: 'feat(261021-k1m): roles' });
}

function buildSigma(sigma, home) {
  makeRepo(sigma, { home, files: { 'README.md': 'sigma\n' }, untrackedPlanning: true });
  writeFileAt(sigma, '.planning/quick/261025-s1a-main/261025-s1a-PLAN.md', md(['tier: B']));
  writeFileAt(sigma, '.planning/quick/261025-s1a-main/261025-s1a-SUMMARY.md', md(['status: complete', 'completed: 2026-10-26']));
  writeFileAt(sigma, '.planning/phases/05-gamma/05-01-PLAN.md', md(['phase: 05-gamma']), { mtimeMs: Date.parse(ADAPTER_TIMES.M1) });
  const wt = join(dirname(dirname(sigma)), 'wt', 'sigma-wip');
  addWorktree(sigma, wt, 'wip', { home });
  writeFileAt(wt, '.planning/quick/261027-w2b-wt-only/261027-w2b-PLAN.md', md(['tier: A']), { mtimeMs: Date.parse(ADAPTER_TIMES.M2) });
  return wt;
}

function buildTau(tau, home) {
  makeRepo(tau, { home, files: { 'README.md': 'tau\n' } });
  writeFileAt(tau, '.planning/quick/261028-t3c-root/261028-t3c-PLAN.md', md(['tier: B']));
  commitAt(tau, { home, date: ADAPTER_TIMES.T1, message: 'docs(261028-t3c): plan' });
}

// -> { omega, sigma, sigmaWorktree, tau, plainDir, expected }.
export function buildAdapterHome({ home, root = join(home, '.claude') }) {
  assertOutsideWorkTree(dirname(home));
  const omega = join(home, 'repos', 'omega');
  const sigma = join(home, 'repos', 'sigma');
  const tau = join(home, 'elsewhere', 'tau');
  const plainDir = join(home, 'plain-dir');
  buildOmega(omega, home);
  const sigmaWorktree = buildSigma(sigma, home);
  buildTau(tau, home);
  mkdirSync(plainDir, { recursive: true });
  writeSession(root, omega, ADAPTER_SESSIONS.omega, 1);
  writeSession(root, sigma, ADAPTER_SESSIONS.sigma, 2);
  return {
    omega, sigma, sigmaWorktree, tau, plainDir, expected: ADAPTER_EXPECTED,
  };
}
