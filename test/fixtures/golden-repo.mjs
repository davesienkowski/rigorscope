// Fixture git repositories for the golden inputs snapshot and the pure tier, timing and novelty rules (plan 02-03,
// D-01..D-04, D-07, amendments Q1 and Q6, TRUST-10). A helper, not a test: it is never collected by the quoted test
// glob. It imports only gitEnv and assertOutsideWorkTree from test/fixtures/git-repo.mjs and node built-ins.
//
// buildGoldenRepo({ home }) creates, inside the temporary HOME:
//   gamma  <home>/src/gamma, `.planning/` tracked: quick units 261020-aaa (tier only in a RIGOR-TIER file; a CONTEXT
//          file, a SUMMARY body line and a plan-text mention of the quick command's flags that must never count) and
//          261021-bbb (PLAN A, SUMMARY C, PROBES-SKIPPED C in one closing commit), phase plan 03-01 (PLAN A), and a
//          commit whose subject holds the plan id only as part of a date
//   delta  <home>/src/delta, `.planning/` gitignored: quick unit 261022-ccc whose PLAN says tier B but has no commit
//   zeta   <home>/src/zeta: a root commit naming quick unit 261025-rrr that adds pkg/a.mjs (novelty, Task 2)
// and writes a manifest naming six units (one absent from gamma, one in a repo that is never given). Every commit is
// made by commitAt with GIT_AUTHOR_DATE and GIT_COMMITTER_DATE set to one of GOLDEN_TIMES; the identity is the
// non-email word of gitEnv. Planted phrases (body text, a tier reason, a commit subject) must never reach the
// snapshot.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertOutsideWorkTree, gitEnv } from './git-repo.mjs';

export const GOLDEN_TIMES = Object.freeze({
  TI: '2026-10-20T09:00:00Z',
  T0: '2026-10-20T10:00:00Z',
  T1: '2026-10-20T11:00:00Z',
  T2: '2026-10-20T12:00:00Z',
  T3: '2026-10-20T13:00:00Z',
  T4: '2026-10-20T14:00:00Z',
  P0: '2026-10-20T10:10:00Z',
  P1: '2026-10-20T12:10:00Z',
  P2: '2026-10-20T13:10:00Z',
});
export const goldenMs = (name) => Date.parse(GOLDEN_TIMES[name]);

// Text that must never appear in the snapshot.
export const GOLDEN_PLANTS = Object.freeze({
  body: 'planted-body-quartz-meridian',
  reason: 'planted-reason-cobalt-lantern',
  subject: 'planted-subject-amber-falcon',
  contextLine: 'Rigor tier for this task: A',
  summaryBody: 'Tier: A',
});

const run = (dir, args, env) => execFileSync('git', ['-C', dir, '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
  env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

function write(dir, rel, text) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

function init(dir, home) {
  mkdirSync(dir, { recursive: true });
  run(dir, ['init', '--quiet'], gitEnv(home));
}

// Stages every change and commits it at `date` (ISO) with `message`.
export function commitAt(dir, { home, date, message }) {
  const env = { ...gitEnv(home), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  run(dir, ['add', '-A'], env);
  run(dir, ['commit', '--quiet', '-m', message], env);
  return run(dir, ['rev-parse', 'HEAD'], env).trim();
}

const AAA = '.planning/quick/261020-aaa-tier-file';
const BBB = '.planning/quick/261021-bbb-close';
const CCC = '.planning/quick/261022-ccc-untracked';
const PHASE = '.planning/phases/03-alpha';

function buildGamma(dir, home) {
  const T = GOLDEN_TIMES;
  init(dir, home);
  write(dir, 'README.md', '# gamma\n');
  write(dir, 'scripts/tool.sh', '#!/bin/sh\necho one\n');
  write(dir, 'hooks/base.mjs', 'export const base = 1;\n');
  write(dir, 'src/commands/old.mjs', 'export const old = 1;\n');
  write(dir, 'notes.txt', 'notes\n');
  commitAt(dir, { home, date: T.TI, message: 'init' });

  write(dir, `${AAA}/261020-aaa-PLAN.md`, [
    '---',
    'phase: quick',
    'files_modified:',
    '  - hooks/gate.mjs',
    '  - ./scripts/tool.sh',
    `  - "${home}/.claude/settings.json"`,
    '  - /srv/shared/tool.mjs',
    'autonomous: true',
    '---',
    '',
    `${GOLDEN_PLANTS.body}: run the quick command with --validate and --full before starting.`,
    '',
  ].join('\n'));
  write(dir, `${AAA}/261020-aaa-CONTEXT.md`, ['---', 'tier: A', '---', '', '## Rigor', GOLDEN_PLANTS.contextLine, ''].join('\n'));
  commitAt(dir, { home, date: T.T0, message: 'docs(261020-aaa): plan' });

  write(dir, `${PHASE}/03-01-PLAN.md`, ['---', 'phase: 03-alpha', 'plan: 01', 'tier: A', '---', '', 'Plan body.', ''].join('\n'));
  commitAt(dir, { home, date: T.P0, message: 'docs(03-01): plan' });

  write(dir, `${AAA}/RIGOR-TIER.md`, ['# Rigor tier', '', 'Tier: B', GOLDEN_PLANTS.reason, ''].join('\n'));
  commitAt(dir, { home, date: T.T1, message: 'docs(261020-aaa): tier file' });

  write(dir, 'hooks/gate.mjs', 'export const gate = 1;\n');
  write(dir, 'scripts/tool.sh', '#!/bin/sh\necho two\n');
  commitAt(dir, { home, date: T.T2, message: `feat(261020-aaa): ${GOLDEN_PLANTS.subject}` });

  write(dir, 'src/commands/zap.mjs', 'export const zap = 1;\n');
  commitAt(dir, { home, date: T.P1, message: 'feat(03-01): zap' });

  write(dir, `${AAA}/261020-aaa-SUMMARY.md`, ['---', 'phase: quick', 'status: complete', '---', '', GOLDEN_PLANTS.summaryBody, ''].join('\n'));
  commitAt(dir, { home, date: T.T3, message: 'docs(261020-aaa): summary' });

  write(dir, 'notes.txt', 'notes\nmore\n');
  commitAt(dir, { home, date: T.P2, message: 'chore: notes for 2026-03-01' });

  write(dir, `${BBB}/261021-bbb-PLAN.md`, ['---', 'tier: A', '---', '', 'Plan.', ''].join('\n'));
  write(dir, `${BBB}/261021-bbb-SUMMARY.md`, ['---', 'tier: C', '---', '', 'Done.', ''].join('\n'));
  write(dir, `${BBB}/261021-bbb-PROBES-SKIPPED.md`, 'Tier C advisory script; two parse tests\n');
  write(dir, 'src/new/mod.mjs', 'export const mod = 1;\n');
  commitAt(dir, { home, date: T.T4, message: 'feat(261021-bbb): close' });
}

function buildDelta(dir, home) {
  init(dir, home);
  write(dir, 'README.md', '# delta\n');
  write(dir, '.gitignore', '.planning/\n');
  commitAt(dir, { home, date: GOLDEN_TIMES.TI, message: 'init' });
  write(dir, `${CCC}/261022-ccc-PLAN.md`, ['---', 'tier: B', '---', '', 'Untracked plan.', ''].join('\n'));
}

function buildZeta(dir, home) {
  init(dir, home);
  write(dir, 'pkg/a.mjs', 'export const a = 1;\n');
  commitAt(dir, { home, date: GOLDEN_TIMES.TI, message: 'feat(261025-rrr): start' });
}

const unit = (repo, kind, nativeId) => ({ repo, kind, native_id: nativeId });
const label = (repo, kind, nativeId, value, source) => ({
  schema_version: 1,
  unit: { repo, framework: 'gsd-core', kind, native_id: nativeId },
  tier: { value, source },
  risk_class: [],
  held_out: false,
});

export const GOLDEN_MANIFEST = Object.freeze({
  schema: 'rigorscope.golden-manifest/1',
  units: [
    unit('delta', 'quick', '261022-ccc'),
    unit('epsilon', 'quick', '261024-yyy'),
    unit('gamma', 'plan', '03-01'),
    unit('gamma', 'quick', '261020-aaa'),
    unit('gamma', 'quick', '261021-bbb'),
    unit('gamma', 'quick', '261023-zzz'),
  ],
});

export const GOLDEN_LABELS = Object.freeze([
  label('gamma', 'quick', '261020-aaa', 'B', 'declared-at-start'),
  label('gamma', 'quick', '261021-bbb', 'A', 'declared-at-close'),
  label('gamma', 'phase-plan', '03-01', 'A', 'declared-at-start'),
  label('delta', 'quick', '261022-ccc', 'B', 'declared-at-start'),
  label('gamma', 'quick', '261023-zzz', 'none', 'unknown'),
  label('epsilon', 'quick', '261024-yyy', 'none', 'unknown'),
]);

export const GOLDEN_EXPECTED = Object.freeze({
  stdout: [
    'golden-inputs: units=6 located=4 repos=2 not_found=1 repo_not_given=1 dropped_paths=1',
    'golden-inputs: repos not given: epsilon',
  ],
  order: ['delta/quick/261022-ccc', 'epsilon/quick/261024-yyy', 'gamma/plan/03-01', 'gamma/quick/261020-aaa',
    'gamma/quick/261021-bbb', 'gamma/quick/261023-zzz'],
  predictions: {
    'gamma:quick:261020-aaa': { tier: 'B', tier_signal: 'tier-file', tier_timing: 'declared-at-start', tier_conflict: false },
    'gamma:quick:261021-bbb': { tier: 'A', tier_signal: 'frontmatter', tier_timing: 'declared-at-close', tier_conflict: true },
    'gamma:plan:03-01': { tier: 'A', tier_signal: 'frontmatter', tier_timing: 'declared-at-start', tier_conflict: false },
    'delta:quick:261022-ccc': { tier: 'B', tier_signal: 'frontmatter', tier_timing: null, tier_conflict: false },
  },
  score: { units: 6, located: 4, tierValue: [4, 6], tierTiming: [3, 4] },
});

// A HOME whose last segment is `userName`, holding repo theta with quick unit 261026-uuu: its PLAN's files_modified
// lists a plain path, a path with free text after it and a path holding the user name as a slug word, and its commit
// changes a path holding the user name. -> { home, theta, manifest }. Review of the real snapshot (plan 02-03 step 7).
export function buildNameLeakRepo({ parent, userName }) {
  const home = join(parent, userName);
  mkdirSync(home, { recursive: true });
  assertOutsideWorkTree(parent);
  const theta = join(home, 'src', 'theta');
  init(theta, home);
  write(theta, 'README.md', '# theta\n');
  commitAt(theta, { home, date: GOLDEN_TIMES.TI, message: 'init' });
  const dir = '.planning/quick/261026-uuu-names';
  write(theta, `${dir}/261026-uuu-PLAN.md`, [
    '---',
    'files_modified:',
    '  - docs/notes.md',
    '  - capabilities/kit/  (bundle regen by a build script, never hand-edited)',
    `  - .planning/quick/261026-vvv-with-${userName}-notes/x.md`,
    '---',
    '',
  ].join('\n'));
  write(theta, `.planning/quick/261026-vvv-with-${userName}-notes/x.md`, 'x\n');
  write(theta, 'docs/notes.md', 'notes\n');
  commitAt(theta, { home, date: GOLDEN_TIMES.T0, message: 'feat(261026-uuu): names' });
  const manifest = join(home, 'golden', 'manifest.json');
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, `${JSON.stringify({
    schema: 'rigorscope.golden-manifest/1', units: [unit('theta', 'quick', '261026-uuu')],
  }, null, 2)}\n`, 'utf8');
  return { home, theta, manifest };
}

// Review CR-01 (02-03 code review): repo eta with quick unit 261027-fff. At T0 its PLAN is added with no frontmatter
// `tier:` and a column-0 `tier: B` inside a fenced block of the body; at T1 an implementation commit names the id; at
// T2 one closing commit adds `tier: A` to the PLAN frontmatter and adds the SUMMARY. The frontmatter signal time is T2
// (declared-at-close), never the T0 body line. -> { home, eta, dirRel, nativeId }.
export function buildFencedTierRepo({ home }) {
  assertOutsideWorkTree(dirname(home));
  const eta = join(home, 'src', 'eta');
  const T = GOLDEN_TIMES;
  const nativeId = '261027-fff';
  const dirRel = `.planning/quick/${nativeId}-fence`;
  init(eta, home);
  write(eta, 'README.md', '# eta\n');
  commitAt(eta, { home, date: T.TI, message: 'init' });
  const body = ['', 'Example frontmatter:', '', '```yaml', 'tier: B', '```', ''];
  write(eta, `${dirRel}/${nativeId}-PLAN.md`, ['---', 'phase: quick', '---', ...body].join('\n'));
  commitAt(eta, { home, date: T.T0, message: `docs(${nativeId}): plan` });
  write(eta, 'src/a.mjs', 'export const a = 1;\n');
  commitAt(eta, { home, date: T.T1, message: `feat(${nativeId}): code` });
  write(eta, `${dirRel}/${nativeId}-PLAN.md`, ['---', 'phase: quick', 'tier: A', '---', ...body].join('\n'));
  write(eta, `${dirRel}/${nativeId}-SUMMARY.md`, ['---', 'status: complete', '---', '', 'Done.', ''].join('\n'));
  commitAt(eta, { home, date: T.T2, message: `docs(${nativeId}): close` });
  return { home, eta, dirRel, nativeId };
}

// Review WR-02 (02-03 code review): repo iota with quick unit 261028-sss and phase plan 05-02. Commits whose
// conventional scope is the unit (`type(<id>):`, `type(quick-<id>):`, a scope list naming it, `type(<plan id>)!:`)
// belong to it; a commit of another unit whose body mentions the id, a commit naming the id outside its scope, and a
// merge commit naming the id do not. -> { home, iota, quickId, planId, own: { quick, plan }, foreign } where own lists
// the shas that belong to each unit and foreign the shas that name an id but belong to neither.
export function buildScopeRepo({ home }) {
  assertOutsideWorkTree(dirname(home));
  const iota = join(home, 'src', 'iota');
  const T = GOLDEN_TIMES;
  const q = '261028-sss';
  const p = '05-02';
  init(iota, home);
  write(iota, 'README.md', '# iota\n');
  commitAt(iota, { home, date: T.TI, message: 'init' });
  const own = { quick: [], plan: [] };
  const foreign = [];
  write(iota, `.planning/quick/${q}-scope/${q}-PLAN.md`, ['---', 'tier: B', '---', ''].join('\n'));
  own.quick.push(commitAt(iota, { home, date: T.T0, message: `docs(${q}): plan` }));
  write(iota, `.planning/phases/05-beta/${p}-PLAN.md`, ['---', 'tier: A', '---', ''].join('\n'));
  own.plan.push(commitAt(iota, { home, date: T.P0, message: `docs(${p}): plan` }));
  write(iota, 'src/own.mjs', 'export const own = 1;\n');
  own.quick.push(commitAt(iota, { home, date: T.T1, message: `feat(${q}): code` }));
  write(iota, 'test/own.test.mjs', 'export const t = 1;\n');
  own.quick.push(commitAt(iota, { home, date: T.T2, message: `test(quick-${q}): tests` }));
  write(iota, 'scripts/both.sh', '#!/bin/sh\necho both\n');
  own.quick.push(commitAt(iota, { home, date: T.T2, message: `fix(quick-${q},abc): shared script` }));
  write(iota, 'hooks/other.mjs', 'export const other = 1;\n');
  foreign.push(commitAt(iota, { home, date: T.T3, message: `fix(261028-ttt): other unit\n\nFollow-up to ${q} and (${p}).` }));
  write(iota, 'docs/adr.md', '# adr\n');
  foreign.push(commitAt(iota, { home, date: T.T3, message: `docs(adr): record ${q}, closes (${p})` }));
  write(iota, 'src/zap.mjs', 'export const zap = 1;\n');
  own.plan.push(commitAt(iota, { home, date: T.P1, message: `feat(${p})!: zap` }));
  const env = { ...gitEnv(home), GIT_AUTHOR_DATE: T.T4, GIT_COMMITTER_DATE: T.T4 };
  run(iota, ['checkout', '--quiet', '-b', 'side'], env);
  write(iota, 'src/side.mjs', 'export const side = 1;\n');
  own.quick.push(commitAt(iota, { home, date: T.T4, message: `feat(${q}): side` }));
  run(iota, ['checkout', '--quiet', 'main'], env);
  write(iota, 'notes.txt', 'notes\n');
  commitAt(iota, { home, date: T.T4, message: 'chore: notes' });
  run(iota, ['merge', '--no-ff', '--quiet', '-m', `merge(${q}): side branch (${p})`, 'side'], env);
  foreign.push(run(iota, ['rev-parse', 'HEAD'], env).trim());
  return { home, iota, quickId: q, planId: p, own, foreign };
}

// -> { gamma, delta, zeta, manifest, labels, expected }: the three repo roots, the manifest file path, the label rows
// and the expected values above.
export function buildGoldenRepo({ home }) {
  assertOutsideWorkTree(dirname(home));
  const gamma = join(home, 'src', 'gamma');
  const delta = join(home, 'src', 'delta');
  const zeta = join(home, 'src', 'zeta');
  buildGamma(gamma, home);
  buildDelta(delta, home);
  buildZeta(zeta, home);
  const manifest = join(home, 'golden', 'manifest.json');
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, `${JSON.stringify(GOLDEN_MANIFEST, null, 2)}\n`, 'utf8');
  return { gamma, delta, zeta, manifest, labels: GOLDEN_LABELS, expected: GOLDEN_EXPECTED };
}
