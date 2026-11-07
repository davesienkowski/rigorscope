// Configured repo roots (plan 02-05, D-09, UNIT-05): an optional list of repositories to reconstruct units from although
// no session worked in them. RIGORSCOPE_REPO_ROOTS holds absolute directories separated by `:`; each entry is a
// directory inside one git repository, resolved like a session working directory (02-02's resolveDir) and never
// walked: a parent directory of several repositories adds none of them. The environment is read only from the `env`
// argument (the ingest command's environment), so the scheduled ingest sees the list only when its service
// environment sets it.
//
// An entry is skipped and counted, with nothing written, when it is relative, longer than MAX_ROOT_CHARS, holds a
// control character, lies past the first MAX_REPO_ROOTS entries, is not an existing directory, is not inside a
// repository (resolveDir answers none or ancestor), or git gave no answer this run (deferred: retried next run). An
// entry that resolves upserts its `repo` row with 02-02's rule and records its home-normalized directory in
// `dir_repo` (written once), so the adapter then scans the repository's trees for units. No entry, path or git output
// is ever printed or put in a message: only the two counts leave this module.
import { statSync } from 'node:fs';
import { buildHomeSet, normalizeCwd } from '../sources/transcript/home.mjs';
import { defaultRun, resolveDir } from './repo-resolve.mjs';

export const REPO_ROOTS_ENV = 'RIGORSCOPE_REPO_ROOTS';
export const MAX_REPO_ROOTS = 64;
const MAX_ROOT_CHARS = 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;

// -> { roots: [absolute entries, in order], skipped }. Empty entries (two separators in a row, a leading or trailing
// one) are ignored, never counted.
export function parseRepoRoots(env) {
  const raw = env && typeof env[REPO_ROOTS_ENV] === 'string' ? env[REPO_ROOTS_ENV] : '';
  const roots = [];
  let skipped = 0;
  for (const entry of raw.split(':')) {
    if (entry === '') continue;
    if (!entry.startsWith('/') || entry.length > MAX_ROOT_CHARS || CONTROL.test(entry)) { skipped += 1; continue; }
    if (roots.length >= MAX_REPO_ROOTS) { skipped += 1; continue; }
    roots.push(entry);
  }
  return { roots, skipped };
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const REPO_SQL = `
INSERT INTO repo (repo_key, repo_name, first_seen_run, last_seen_run) VALUES (?, ?, ?, ?)
ON CONFLICT (repo_key) DO UPDATE SET repo_name = coalesce(repo.repo_name, excluded.repo_name),
  last_seen_run = max(repo.last_seen_run, excluded.last_seen_run)`;
const DIR_SQL = `
INSERT INTO dir_repo (dir, repo_key, method, is_worktree, resolved_run) VALUES (?, ?, 'git', ?, ?)
ON CONFLICT (dir) DO NOTHING`;

// Resolves every kept entry with no transaction open, then writes the repos and their dirs in one BEGIN IMMEDIATE.
// run: 02-02's git runner seam, run(args, { env }). -> { roots: entries that added a repo, skipped }.
export function resolveConfiguredRoots({
  db, home, env, runId, run = defaultRun,
}) {
  const parsed = parseRepoRoots(env);
  const out = { roots: 0, skipped: parsed.skipped };
  if (parsed.roots.length === 0) return out;
  const homeSet = buildHomeSet({ home });
  const found = [];
  for (const entry of parsed.roots) {
    const stored = normalizeCwd(entry.replace(/\/+$/, '') || '/', homeSet);
    if (!isDir(entry) || typeof stored !== 'string') { out.skipped += 1; continue; }
    const res = resolveDir(stored, { home, run });
    if (res.deferred || res.method !== 'git' || res.repoKey === null) { out.skipped += 1; continue; }
    found.push([stored, res]);
  }
  if (found.length === 0) return out;
  db.exec('BEGIN IMMEDIATE');
  try {
    const upRepo = db.prepare(REPO_SQL);
    const insDir = db.prepare(DIR_SQL);
    for (const [, res] of found) upRepo.run(res.repoKey, res.repoName, runId, runId);
    for (const [dir, res] of found) insDir.run(dir, res.repoKey, res.isWorktree, runId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
    throw err;
  }
  out.roots = found.length;
  return out;
}
