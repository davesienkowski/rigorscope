// Repo resolution at ingest (plan 02-02, UNIT-02, D-08, D-09, amendment Q2). Every session directory stored in
// cc_message.cwd is resolved once, while it may still exist, to the repository it belongs to:
//
//   repo_key   the realpath of `git rev-parse --path-format=absolute --git-common-dir`, home-normalized with `~`
//              against both HOME and the realpath of HOME (a HOME reached through a symlink still yields `~/...`);
//              a linked worktree and its main checkout share one key
//   repo_name  the basename of the parent when the common dir ends in `/.git`, else the common dir's basename without
//              a trailing `.git`; NULL when it fails the segment shape. A display value only. It is read from the
//              home-normalized repo_key, never from the absolute common dir, so a repository rooted at a home (HOME
//              itself, `~/.git`, or another user's or a Windows profile's home, `~other/.git`, `~win/.git`) gets NULL:
//              that basename would be the OS user name (review 02-02 CR-01, RR-03).
//   method     git       the directory exists and git answered for it
//              ancestor  the directory is gone and git answered for its nearest existing ancestor, which must lie
//                        strictly below HOME for a dir at or below HOME or its realpath (a `~` form, or an absolute
//                        path recorded in the physical form of a symlinked HOME), strictly below the filesystem root
//                        otherwise; for such a dir the repository git finds must also lie strictly below HOME (git's
//                        ceiling is HOME's realpath on this call), so a HOME that is a git work tree never answers for a vanished dir
//              none      anything else: not a repository, an unusable stored form (`~win/...`, `~other/...`, a
//                        relative value, a `..` segment) with no git call and no filesystem access, or no ancestor
//                        inside the bound. No directory-layout rule ever decides a repo.
//
// Decaying facts: a clean non-zero git exit records the dir once with method none; git missing from PATH, older than
// 2.31, a spawn error or a timeout records NO row, so the next run retries (the ingest line says git=unavailable, or
// counts the dir under deferred=). A dir with a row is never re-resolved.
//
// git runs through an args array with no shell, `-c core.fsmonitor=false`, GIT_OPTIONAL_LOCKS=0, the repository-
// location variables removed from its environment, GIT_CEILING_DIRECTORIES set to the parent of HOME's realpath for an
// existing dir at or below HOME and to HOME's realpath for the ancestor of a vanished one, stdin and stderr ignored, and a timeout. No path, cwd or git output is ever printed, logged or put in an
// error message. The `run` option is a test seam: run(args, { env }) -> { status, stdout, errorCode }, never throws.
import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { buildHomeSet, normalizeCwd } from '../sources/transcript/home.mjs';

export const REPO_METHODS = Object.freeze(['git', 'ancestor', 'none']);
// The first git with --path-format.
export const GIT_MIN_VERSION = Object.freeze([2, 31]);
export const GIT_TIMEOUT_MS = 10000;
const GIT_MAX_BUFFER = 1 << 20;

// Distinct stored directories with no dir_repo row, bytewise: every non-NULL session cwd, and (plan 02-04) every
// planning-ref directory of cc_message_ref, so a repo reached only through a tool_use ref is resolved once at ingest
// and scanned for units like a cwd repo. UNION removes a dir present in both.
export const DIR_SOURCES_SQL = `
SELECT s.dir AS dir FROM (
  SELECT m.cwd AS dir FROM cc_message m WHERE m.cwd IS NOT NULL
  UNION
  SELECT r.ref_dir AS dir FROM cc_message_ref r
) s
 WHERE NOT EXISTS (SELECT 1 FROM dir_repo d WHERE d.dir = s.dir)
 ORDER BY 1`;

// The repository-location variables removed from every git child's environment. Exported, with defaultRun and
// childEnv, for the environment snapshot's local-mods HEAD (plan 02-04): one runner and one variable list.
export const LOCATION_VARS = Object.freeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
]);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NONE = Object.freeze({ repoKey: null, repoName: null, method: 'none', isWorktree: null });
const DEFERRED = Object.freeze({ deferred: true });

// The default runner: never throws.
export function defaultRun(args, { env } = {}) {
  try {
    const stdout = execFileSync('git', args, {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER,
    });
    return { status: 0, stdout, errorCode: null };
  } catch (err) {
    if (err?.signal || err?.code === 'ETIMEDOUT') return { status: null, stdout: '', errorCode: 'ETIMEDOUT' };
    if (typeof err?.status === 'number') return { status: err.status, stdout: '', errorCode: null };
    return { status: null, stdout: '', errorCode: typeof err?.code === 'string' ? err.code : 'EUNKNOWN' };
  }
}

const realpathOr = (p) => {
  try { return realpathSync(p); } catch { return null; }
};
const isDir = (p) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

// `~` gives HOME, `~/rest` gives HOME joined with rest, an absolute posix path is returned as is; anything else
// (`~win/...`, `~other/...`, a relative value, a non-string, a `.` or `..` segment) gives null.
export function expandStoredDir(stored, home) {
  if (typeof stored !== 'string' || stored === '' || typeof home !== 'string' || home === '') return null;
  let abs;
  if (stored === '~') abs = home;
  else if (stored.startsWith('~/')) abs = `${home.replace(/\/+$/, '')}/${stored.slice(2)}`;
  else if (stored.startsWith('/') && isAbsolute(stored)) abs = stored;
  else return null;
  const rest = stored === '~' ? '' : stored.startsWith('~/') ? stored.slice(2) : stored.slice(1);
  if (rest.split('/').some((s) => s === '.' || s === '..')) return null;
  return abs.length > 1 ? abs.replace(/\/+$/, '') : abs;
}

// Takes an absolute common dir or a home-normalized repo_key; resolveDir passes the key (see repo_name above).
export function repoNameOf(commonDirAbs) {
  if (typeof commonDirAbs !== 'string' || commonDirAbs === '') return null;
  const p = commonDirAbs.replace(/\/+$/, '');
  const name = p.endsWith('/.git') ? basename(dirname(p)) : basename(p).replace(/\.git$/, '');
  return SEGMENT.test(name) ? name : null;
}

function homeSetFor(home) {
  const real = realpathOr(home);
  const cwd = [...buildHomeSet({ home }).cwd];
  if (real && real !== home) cwd.push(...buildHomeSet({ home: real }).cwd);
  return { cwd, project: [] };
}

// The realpath of the common dir, home-normalized against HOME and its realpath; null when unusable.
export function repoKeyOf(commonDirAbs, home) {
  const real = realpathOr(commonDirAbs);
  if (real === null) return null;
  const key = normalizeCwd(real, homeSetFor(home));
  return typeof key === 'string' && key.length >= 1 && key.length <= 1024 ? key : null;
}

export function childEnv({ ceiling }) {
  const env = { ...process.env };
  for (const k of LOCATION_VARS) delete env[k];
  env.GIT_OPTIONAL_LOCKS = '0';
  if (ceiling) env.GIT_CEILING_DIRECTORIES = ceiling;
  return env;
}

// -> { ok, reason } with reason null, 'missing', 'old' or 'unparseable'.
export function gitProbe({ run = defaultRun } = {}) {
  const r = run(['--version'], { env: childEnv({}) });
  if (r.errorCode) return { ok: false, reason: 'missing' };
  const m = r.status === 0 ? /^git version (\d+)\.(\d+)/.exec(String(r.stdout)) : null;
  if (!m) return { ok: false, reason: 'unparseable' };
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const [wantMajor, wantMinor] = GIT_MIN_VERSION;
  if (major < wantMajor || (major === wantMajor && minor < wantMinor)) return { ok: false, reason: 'old' };
  return { ok: true, reason: null };
}

// The HOME base (HOME or its realpath) an absolute path lies strictly below, or null. A `~` form is under HOME by
// construction; an absolute form is decided by the expanded path, so a cwd recorded in the physical form of a symlinked
// HOME is treated like its `~` form (re-review 02-02 WR-01).
function homeBaseOf(abs, home) {
  const bases = [home, realpathOr(home)].filter((b) => typeof b === 'string' && b !== '').map((b) => b.replace(/\/+$/, ''));
  for (const b of bases) if (abs === b || abs.startsWith(`${b}/`)) return b;
  return null;
}

// The directory git is asked about and the method a git answer gives, or null (none without any git call). homeRel is
// true when the directory lies at or below HOME (or its realpath): its ancestor bound is then strictly below that HOME.
function targetOf(stored, home) {
  const abs = expandStoredDir(stored, home);
  if (abs === null) return null;
  const tilde = stored === '~' || stored.startsWith('~/');
  const base = tilde ? home.replace(/\/+$/, '') : homeBaseOf(abs, home);
  if (isDir(abs)) return { dir: abs, method: 'git', homeRel: base !== null };
  let p = abs;
  for (;;) {
    const up = dirname(p);
    if (up === p) return null;
    p = up;
    if (base !== null ? !p.startsWith(`${base}/`) : p === '/') return null;
    if (isDir(p)) return { dir: p, method: 'ancestor', homeRel: base !== null };
  }
}

// -> { repoKey, repoName, method, isWorktree } or { deferred: true }. One git call per examined directory.
export function resolveDir(stored, { home, run = defaultRun } = {}) {
  const target = targetOf(stored, home);
  if (target === null) return { ...NONE };
  const realHome = target.homeRel ? realpathOr(home) : null;
  // For an ancestor of a dir at or below HOME (a `~` form, or an absolute path under HOME or its realpath) the ceiling
  // is HOME's realpath itself, so git never examines HOME: a repository rooted at HOME cannot answer for a vanished dir
  // below it (review 02-02 WR-01, re-review WR-01). An existing dir keeps the parent of HOME, so `~` itself still
  // resolves.
  const ceiling = realHome ? (target.method === 'ancestor' ? realHome : dirname(realHome)) : null;
  const env = childEnv({ ceiling });
  const r = run(['-C', target.dir, '-c', 'core.fsmonitor=false', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { env });
  if (r.errorCode) return { ...DEFERRED };
  if (r.status !== 0) return { ...NONE };
  const lines = String(r.stdout).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length !== 2 || lines.some((l) => l.trim() === '')) return { ...NONE };
  const gitDir = realpathOr(lines[0]);
  const common = realpathOr(lines[1]);
  if (gitDir === null || common === null) return { ...NONE };
  const repoKey = repoKeyOf(common, home);
  if (repoKey === null) return { ...NONE };
  return { repoKey, repoName: repoNameOf(repoKey), method: target.method, isWorktree: gitDir === common ? 0 : 1 };
}

const UNAVAILABLE_RUN = () => ({ status: null, stdout: '', errorCode: 'EGITUNAVAILABLE' });

// The ingest post-step's first half: resolves every new stored dir with no transaction open, then writes the repo
// rows and only then the dir_repo rows in one BEGIN IMMEDIATE (the foreign key is checked per statement). git is
// probed once, lazily, before the first dir that needs a git call; when no dir needs one, git is 'not_needed'.
// -> { git, dirs, resolved, ancestor, none, deferred }.
export function resolveRepos({ db, home, runId, run = defaultRun }) {
  const dirs = db.prepare(DIR_SOURCES_SQL).all().map((r) => r.dir);
  const out = { git: 'not_needed', dirs: dirs.length, resolved: 0, ancestor: 0, none: 0, deferred: 0 };
  if (dirs.length === 0) return out;
  let probed = null;
  const gated = (args, opts) => {
    if (probed === null) {
      probed = gitProbe({ run });
      out.git = probed.ok ? 'ok' : 'unavailable';
    }
    return probed.ok ? run(args, opts) : UNAVAILABLE_RUN();
  };
  const results = [];
  for (const dir of dirs) {
    const res = resolveDir(dir, { home, run: gated });
    if (res.deferred) { out.deferred += 1; continue; }
    if (res.method === 'git') out.resolved += 1;
    else if (res.method === 'ancestor') out.ancestor += 1;
    else out.none += 1;
    results.push([dir, res]);
  }
  if (results.length === 0) return out;
  db.exec('BEGIN IMMEDIATE');
  try {
    const upRepo = db.prepare(
      `INSERT INTO repo (repo_key, repo_name, first_seen_run, last_seen_run) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo_key) DO UPDATE SET repo_name = coalesce(repo.repo_name, excluded.repo_name),
         last_seen_run = max(repo.last_seen_run, excluded.last_seen_run)`,
    );
    for (const [, res] of results) if (res.repoKey !== null) upRepo.run(res.repoKey, res.repoName, runId, runId);
    const insDir = db.prepare(
      `INSERT INTO dir_repo (dir, repo_key, method, is_worktree, resolved_run) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (dir) DO NOTHING`,
    );
    for (const [dir, res] of results) insDir.run(dir, res.repoKey, res.method, res.isWorktree, runId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
    throw err;
  }
  return out;
}
