// Hermetic temporary git repositories for the repo resolver and the gsd-core adapter (plan 02-02, D-08, UNIT-02).
// A helper, not a test: it is never collected by the quoted test glob. It does not import test/fixtures/build.mjs,
// so a case module (case 98) can import it.
//
// Every repository is created inside a temporary HOME. git runs with an environment built from an allowlist: no
// system or global config, no terminal prompt, a fixed author and committer date, and the plain word `fixture` as
// the author and committer name and email (not email-shaped, so the canary's email scan stays meaningful).
// Every helper is idempotent: a canary scenario rebuilds every fixture on one HOME for its second run, so a second
// call finds the repository, the worktree or the clean tree in place and changes nothing.
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, renameSync, utimesSync, writeFileSync,
} from 'node:fs';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';

export const GIT_FIXTURE_DATE = '2026-10-27T12:00:00Z';

export function gitEnv(home) {
  const env = {};
  for (const k of ['PATH', 'TMPDIR', 'LANG']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture',
    GIT_AUTHOR_DATE: GIT_FIXTURE_DATE,
    GIT_COMMITTER_DATE: GIT_FIXTURE_DATE,
  };
}

// Runs git in dir through an args array (no shell) and returns stdout.
export function git(dir, args, { home }) {
  return execFileSync('git', ['-C', dir, '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    env: gitEnv(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const insideWorkTree = (dir, home) => {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree'], { home }).trim() === 'true';
  } catch {
    return false;
  }
};

// files: { 'relative/path': 'text' }. untrackedPlanning: a .gitignore holding `.planning/`.
export function makeRepo(dir, { home, files = {}, untrackedPlanning = false } = {}) {
  if (existsSync(join(dir, '.git'))) return dir;
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet'], { home });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text, 'utf8');
  }
  if (untrackedPlanning) writeFileSync(join(dir, '.gitignore'), '.planning/\n', 'utf8');
  git(dir, ['add', '-A'], { home });
  git(dir, ['commit', '--quiet', '--allow-empty', '-m', 'fixture commit'], { home });
  return dir;
}

// Commits every change; does nothing on a clean tree.
export function commitAll(dir, { home }) {
  if (git(dir, ['status', '--porcelain'], { home }).trim() === '') return;
  git(dir, ['add', '-A'], { home });
  git(dir, ['commit', '--quiet', '-m', 'fixture update'], { home });
}

// A linked worktree of repoDir at wtDir on a new branch.
export function addWorktree(repoDir, wtDir, branch, { home }) {
  if (existsSync(wtDir) && insideWorkTree(wtDir, home)) return wtDir;
  mkdirSync(dirname(wtDir), { recursive: true });
  git(repoDir, ['worktree', 'add', '--quiet', '-b', branch, wtDir], { home });
  return wtDir;
}

// A planning file body: frontmatter with an optional `tier:` line and extra lines, then body. Plan 03.1-01 exports it as
// planText so the stock-layout fixtures can write PLAN and SUMMARY files without a second copy of the shape.
function artifactText({ tier, extra = [], body = '' }) {
  const head = ['---'];
  if (tier !== undefined && tier !== null) head.push(`tier: ${tier}`);
  head.push(...extra, '---', '', body);
  return `${head.join('\n')}\n`;
}

// Writes <top>/.planning/quick/<id>-<slug>/ with <id>-PLAN.md and <id>-SUMMARY.md; plan and summary are
// { tier, extra, body } or null (no file). Returns the directory.
export function writeQuickDir(top, { id, slug, plan = null, summary = null }) {
  const dir = join(top, '.planning', 'quick', `${id}-${slug}`);
  mkdirSync(dir, { recursive: true });
  if (plan) writeFileSync(join(dir, `${id}-PLAN.md`), artifactText(plan), 'utf8');
  if (summary) writeFileSync(join(dir, `${id}-SUMMARY.md`), artifactText(summary), 'utf8');
  return dir;
}

// Throws when dir is inside a git work tree: a temporary directory inside someone's work tree would make every
// fixture repository meaningless (git would find the outer repository first).
export function assertOutsideWorkTree(dir) {
  if (insideWorkTree(dir, dir)) {
    throw new Error('the temporary directory is inside a git work tree; set TMPDIR to a directory outside any repository');
  }
}

// Plan 02-05. Writes <top>/<rel> (creating its directories); mtimeMs sets the file's access and modification time.
export function writeFileAt(top, rel, text, { mtimeMs } = {}) {
  const abs = join(top, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
  if (mtimeMs !== undefined) utimesSync(abs, new Date(mtimeMs), new Date(mtimeMs));
  return abs;
}

// Plan 02-05. Writes <top>/.planning/phases/<name>/ with files: { 'file name': 'text' }. Returns the directory.
export function writePhaseDir(top, { name, files = {} }) {
  const dir = join(top, '.planning', 'phases', name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text, 'utf8');
  return dir;
}

// Plan 02-05. Stages every change and commits it with `message`, authored and committed at `date` (ISO); does
// nothing on a clean tree. -> the HEAD sha.
export function commitAt(dir, { home, date, message }) {
  const env = { ...gitEnv(home), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const g = (args) => execFileSync('git', ['-C', dir, '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (g(['status', '--porcelain']).trim() !== '') {
    g(['add', '-A']);
    g(['commit', '--quiet', '-m', message]);
  }
  return g(['rev-parse', 'HEAD']).trim();
}

// Plan 02-05. Like commitAt, with the given author and committer name and email in the environment of this one commit
// only (the prohibition test and the canary plant a commit identity). Does nothing on a clean tree. -> the HEAD sha.
export function commitWith(dir, {
  home, date, message, name, email,
}) {
  const env = {
    ...gitEnv(home),
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
  const g = (args) => execFileSync('git', ['-C', dir, '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (g(['status', '--porcelain']).trim() !== '') {
    g(['add', '-A']);
    g(['commit', '--quiet', '-m', message]);
  }
  return g(['rev-parse', 'HEAD']).trim();
}

// Plan 03.1-01. The text of a PLAN or SUMMARY file: `{ tier, extra, body }` as artifactText takes it.
export const planText = (spec = {}) => artifactText(spec);

// Plan 03.1-01. Writes <top>/.planning/<under>/<name>/ with files: { 'file name': 'text' } for any layout under
// `.planning/` (`under` is a plain relative path such as `phases`, `milestones/v1.0-phases` or `workstreams/api/phases`).
// Returns the directory. writePhaseDir stays as it is; this is a new function.
export function writePlanningDir(top, { under, name, files = {} }) {
  const dir = join(top, '.planning', ...under.split('/'), name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text, 'utf8');
  return dir;
}

// Plan 03.1-01. Archives <top>/.planning/phases/<name> (kind 'phases') or .planning/quick/<name> (kind 'quick') into
// .planning/milestones/<label>-<kind>/<name> the way /gsd-complete-milestone does: `git mv` when track is true and the
// path is tracked, a plain rename otherwise. Creates the archive parent. -> the new directory.
export function archiveDir(top, {
  home, name, label, kind = 'phases', track = true,
}) {
  const sub = kind === 'quick' ? 'quick' : 'phases';
  const fromRel = `.planning/${sub}/${name}`;
  const toParentRel = `.planning/milestones/${label}-${kind}`;
  mkdirSync(join(top, toParentRel), { recursive: true });
  const toRel = `${toParentRel}/${name}`;
  const tracked = track && git(top, ['ls-files', '--', fromRel], { home }).trim() !== '';
  if (tracked) git(top, ['mv', fromRel, toRel], { home });
  else renameSync(join(top, fromRel), join(top, toRel));
  return join(top, toRel);
}
