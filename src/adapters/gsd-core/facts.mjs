// The git facts of reconstructed units, stored at ingest (plan 02-05; D-01, D-04, D-06, D-07, D-10, D-17, D-23;
// UNIT-03, UNIT-04). Derive runs no git (02-03 handoff), so this ingest step stores what 02-03's pure rules need from
// git: per artifact its first add time, its last change time and the commit that set its frontmatter tier letter; per
// unit its commits (02-03's unitCommits) with each file's status and numstat line counts, and the module-dir answers
// of 02-03's noveltyInputs. Messages and identities stay in git: this module asks git only for `%H`, `%aI`,
// `--numstat` counts and ref lists, and calls 02-03's collector functions unchanged (unitCommits tests a subject's
// conventional-commit scope in memory and never returns it). No subject, body, author or committer name or email is
// ever requested here, returned, stored or printed.
//
// Incremental: a unit is scanned again only when the sha256 of its repo's `show-ref --head` output differs from the
// refs_sha of its unit_git_scan row (a cursor, updated in place). A scan row is written only after a complete scan of
// the unit; git missing or older than 2.31 (`facts: unavailable`), a spawn error, a timeout or an output cap overflow
// on any call for the unit, or a failed repo-level call, leaves the unit without a new row (counted deferred), so the
// next run retries and derive treats its commit facts as unknown, never as "no commits". Rows are only added or merged
// (NULL-safe minimum or maximum), never deleted (ADR-0009 A4). Review WR-02: every unit_commit row a complete scan
// sees gets that run as its last_seen_run, in the transaction that writes the scan row's scanned_run, and derive
// counts only the rows of the unit's last complete scan, so a rewritten commit (an amend, a rebase) or any row a later
// scan no longer sees stops counting; a failed scan changes neither.
//
// git runs only through the injected runner (default 02-03's defaultGitRun: an args array, no shell, a timeout and an
// output cap, the repository-location variables removed), with `-C <common dir>` first, so a bare common dir works
// too. A unit id reaches git only after its shape check, as a `--fixed-strings --grep=` value. No path, id or git
// output is ever put in a message. The `run` option is a test seam: run(args) -> { status, stdout, errorCode }.
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { expandStoredDir, gitProbe } from '../../units/repo-resolve.mjs';
import {
  artifactCommitIndex, defaultGitRun, formerPathLookup, frontmatterTierMs, homeSetOf, noveltyInputs, ownerNamesOf, unitCommits,
} from './signals.mjs';
import { idShapeOk } from '../../units/unit-key.mjs';
import { factPathOk } from './artifacts.mjs';
import { PLANNING_PATHSPECS, formerLivePath } from './layout.mjs';

export const FACTS_BATCH_UNITS = 32;
// At most this many working trees of one repo are scanned for units (the rest are counted, never read).
export const MAX_TREES_PER_REPO = 64;

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const STATUSES = new Set(['A', 'M', 'D']);
const compareBytes = (a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const gitArgs = (top, rest) => [
  '-C', top, '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false',
  '-c', 'color.ui=false', ...rest,
];
const answered = (r) => r !== null && typeof r === 'object' && r.errorCode === null && r.status === 0 && typeof r.stdout === 'string';
const timeOf = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

const CONTROL = /[\u0000-\u001f\u007f]/;

// The live working trees of a repo (plan 02-05, the worktree gap): `worktree list --porcelain` from the repo's
// common dir. A block marked `bare` or `prunable`, a path that is not absolute or holds a control character, and a
// path whose lstat is not a real directory (missing, a symlink, a file) are dropped. The first listed tree (the main
// working tree when there is one) comes first, the rest bytewise, at most MAX_TREES_PER_REPO. The paths are used only
// as directories to list, never as git arguments. -> { trees, dropped } or null on any git failure.
export function treesOf({ repoKey, home, run = defaultGitRun } = {}) {
  const top = commonDirOf(repoKey, home);
  if (top === null) return null;
  const r = run(gitArgs(top, ['worktree', 'list', '--porcelain']));
  if (!answered(r)) return null;
  const blocks = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), drop: false };
      blocks.push(cur);
    } else if (cur && (line === 'bare' || line === 'prunable' || line.startsWith('prunable '))) {
      cur.drop = true;
    }
  }
  let dropped = 0;
  const kept = [];
  for (const b of blocks) {
    if (b.drop || !b.path.startsWith('/') || CONTROL.test(b.path)) { dropped += 1; continue; }
    let ok = false;
    try { ok = lstatSync(b.path).isDirectory(); } catch { ok = false; }
    if (!ok) { dropped += 1; continue; }
    if (!kept.includes(b.path)) kept.push(b.path);
  }
  const ordered = kept.length === 0 ? [] : [kept[0], ...kept.slice(1).sort(compareBytes)];
  dropped += Math.max(0, ordered.length - MAX_TREES_PER_REPO);
  return { trees: ordered.slice(0, MAX_TREES_PER_REPO), dropped };
}

// The rules tag of the facts cursor (plan 03.1-03, orchestrator decision 2b, R1 W3). The cursor is the digest of the
// repo's refs, so it cannot see that the RULES for a unit's git times changed: a unit first scanned by earlier code (an
// archived unit with null times and no bound) would keep its stale facts for as long as the refs do not move. For a repo
// that holds archive-class artifacts the digest is therefore salted with this tag (still a sha256 hex, so the 007 CHECK on
// unit_git_scan.refs_sha holds and no migration is needed): the first ingest after the rules changed rescans such a repo
// once, and a live-only repo is untouched. A later change of the time rules bumps the tag.
export const FACTS_RULES_TAG = 'facts-rules:former-path-times:1';

// -> the sha256 hex of `show-ref --head` (exit 1 with no output: a repo with no ref, the hash of ''), or null. salt: a
// non-empty string (FACTS_RULES_TAG) is hashed in front of the text, newline separated; the default is unsalted.
export function refsDigest({ top, run = defaultGitRun, salt = '' } = {}) {
  if (typeof top !== 'string' || top === '') return null;
  const hashed = (text) => sha256(salt === '' ? text : `${salt}\n${text}`);
  const r = run(gitArgs(top, ['show-ref', '--head']));
  if (answered(r)) return hashed(r.stdout);
  if (r && r.errorCode === null && r.status === 1 && r.stdout === '') return hashed('');
  return null;
}

// -> Map planning path -> its newest author time (epoch ms), from one log over the planning dirs, or null when git did
// not answer. Quoted (unusual) paths are left out. Review CR-02: only an add, a modification or a type change counts
// (`--diff-filter=AMT` with rename detection on): a deletion (an archive `git mv` out of the planning dirs lists every
// old path as deleted) and a rename inside them (a move re-adds the file under its new path) are never a last change,
// so they never become a unit's git end. A rename that also edits the file is skipped with it.
export function artifactLastChange({ top, run = defaultGitRun } = {}) {
  if (typeof top !== 'string' || top === '') return null;
  const r = run(gitArgs(top, [
    'log', '--all', '--find-renames', '--diff-filter=AMT', '--no-color', '--format=%x01%aI', '--name-only', '--', ...PLANNING_PATHSPECS,
  ]));
  if (!answered(r)) return null;
  const out = new Map();
  let t = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('\x01')) { t = timeOf(line.slice(1).trim()); continue; }
    if (line === '' || t === null || line.startsWith('"')) continue;
    const prev = out.get(line);
    if (prev === undefined || t > prev) out.set(line, t);
  }
  return out;
}

// -> the newest author time (epoch ms) strictly before boundMs of an add, modification or type change of the ONE planning
// path relPath, or null when it has none; undefined when git did not answer (plan 03.1-03, truth 3). Used only for an
// archive-class artifact whose former live path was edited again after it was archived (a reused dir name): the bound is
// the archive path's own first-add time, kept in JS on the author time (git's --before filters on the committer date, which
// the other logs do not use). One path, no rename option (a rename into the path therefore reads as an add here; accepted).
export function lastChangeBefore({
  top, relPath, boundMs, run = defaultGitRun,
} = {}) {
  if (typeof top !== 'string' || top === '' || typeof relPath !== 'string' || !relPath.startsWith('.planning/')) return undefined;
  if (!Number.isFinite(boundMs) || CONTROL.test(relPath)) return undefined;
  const r = run(gitArgs(top, [
    'log', '--all', '--diff-filter=AMT', '--no-color', '--format=%x01%aI', '--name-only', '--', relPath,
  ]));
  if (!answered(r)) return undefined;
  let best = null;
  let t = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('\x01')) { t = timeOf(line.slice(1).trim()); continue; }
    if (line === '' || t === null || line !== relPath) continue;
    if (t < boundMs && (best === null || t > best)) best = t;
  }
  return best;
}

const countOf = (v) => (/^\d+$/.test(v) ? Number(v) : null);

// -> { counts, reported } for the commits whose message holds the unit's needle (02-03's rule: the quick id, or the
// plan id in parentheses), or null when the id fails its shape or git did not answer. counts: Map `<sha>\0<path>` ->
// { added, deleted } (null for a binary file's `-`); reported: Map sha -> the number of paths git listed for the
// commit, quoted (unusual) paths included although they have no counts entry (review CR-01: a commit that lost a path
// is told apart from one that did not). Only `%H` and `--numstat` are asked; the caller keeps only the commits
// unitCommits returned.
export function unitLineCounts({
  top, kind, nativeId, run = defaultGitRun,
} = {}) {
  if (typeof top !== 'string' || top === '' || !idShapeOk(kind, nativeId)) return null;
  const needle = kind === 'quick' ? nativeId : `(${nativeId})`;
  const r = run(gitArgs(top, [
    'log', '--all', '--no-merges', '--no-renames', '--no-textconv', '--no-ext-diff', '--no-color', '--fixed-strings',
    `--grep=${needle}`, '--format=%x01%H', '--numstat',
  ]));
  if (!answered(r)) return null;
  const counts = new Map();
  const reported = new Map();
  let sha = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('\x01')) {
      const s = line.slice(1).trim();
      sha = SHA_RE.test(s) ? s : null;
      continue;
    }
    if (line === '' || sha === null) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    reported.set(sha, (reported.get(sha) ?? 0) + 1);
    const path = parts.slice(2).join('\t');
    if (path.startsWith('"')) continue;
    counts.set(`${sha}\0${path}`, { added: countOf(parts[0]), deleted: countOf(parts[1]) });
  }
  return { counts, reported };
}

// A commit total is known only when the commit kept a file and every kept file has a count (review CR-01, RR-04: a
// sum over the known counts alone would read as a known total).
const sumOf = (files, key) => (files.length === 0 || files.some((f) => typeof f[key] !== 'number')
  ? null : files.reduce((a, f) => a + f[key], 0));

// A runner that records whether any call failed to run (a spawn error, a timeout, an output cap overflow); a clean
// non-zero exit is an answer.
function tracked(run) {
  const t = { failed: false };
  t.run = (args) => {
    const r = run(args);
    if (!r || typeof r !== 'object' || r.errorCode !== null) t.failed = true;
    return r;
  };
  return t;
}

// -> null when the unit cannot be scanned completely now (unitCommits null, a git call did not run, or git gave no
// line counts for a unit with commits), else { commits, moduleDirs, dropped }: commits in 02-03's order, each { sha,
// author_ms, files: [{ path, status, added, deleted }], files_n, added, deleted, touches_code }; moduleDirs
// [{ module_dir, existed }] bytewise. files_n is the number of paths git listed for the commit (review CR-01), so it
// exceeds files.length exactly when a path was dropped (unitCommits' normalization, a quoted path, or a value that
// would fail a 007 CHECK); added and deleted are then NULL. dropped counts every dropped path and commit.
// sinceMs (review WR-01): for a plan unit whose PLAN file has a first-add commit, its author time; a commit authored
// before it is not the unit's (a plan id reused by an earlier milestone) and is left out, uncounted. null: no bound.
export function collectUnitFacts({
  top, kind, nativeId, home, run = defaultGitRun, sinceMs = null,
} = {}) {
  const t = tracked(run);
  const unit = unitCommits({
    top, kind, nativeId, run: t.run, homeSet: homeSetOf(home), denyNames: ownerNamesOf(home),
  });
  if (unit === null || t.failed) return null;
  const own = Number.isFinite(sinceMs) ? unit.commits.filter((c) => c.author_ms >= sinceMs) : unit.commits;
  const lines = own.length > 0 ? unitLineCounts({
    top, kind, nativeId, run: t.run,
  }) : { counts: new Map(), reported: new Map() };
  if (lines === null || t.failed) return null;
  let dropped = Number.isInteger(unit.dropped) && unit.dropped > 0 ? unit.dropped : 0;
  const commits = [];
  for (const c of own) {
    if (!SHA_RE.test(c.sha) || !Number.isSafeInteger(c.author_ms)) { dropped += 1; continue; }
    const files = [];
    for (const f of c.files) {
      if (!factPathOk(f.path) || !STATUSES.has(f.status)) { dropped += 1; continue; }
      const n = lines.counts.get(`${c.sha}\0${f.path}`);
      files.push({
        path: f.path, status: f.status, added: n ? n.added : null, deleted: n ? n.deleted : null,
      });
    }
    const filesN = Math.max(files.length, c.files.length, lines.reported.get(c.sha) ?? 0);
    const lost = filesN > files.length;
    commits.push({
      sha: c.sha,
      author_ms: c.author_ms,
      files,
      files_n: filesN,
      added: lost ? null : sumOf(files, 'added'),
      deleted: lost ? null : sumOf(files, 'deleted'),
      touches_code: files.some((f) => !f.path.startsWith('.planning/')) ? 1 : 0,
    });
  }
  const answers = noveltyInputs({ top, commits: own, run: t.run });
  if (t.failed) return null;
  const moduleDirs = [];
  for (const [dir, existed] of answers === null ? [] : [...answers.entries()].sort((a, b) => compareBytes(a[0], b[0]))) {
    if (!factPathOk(dir, { allowEmpty: true })) { dropped += 1; continue; }
    moduleDirs.push({ module_dir: dir, existed: existed === null ? null : (existed ? 1 : 0) });
  }
  return { commits, moduleDirs, dropped };
}

const COMMIT_SQL = `
INSERT INTO unit_commit (unit_key, sha, author_ms, files, added, deleted, touches_code, first_seen_run, last_seen_run)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
ON CONFLICT (unit_key, sha) DO UPDATE SET
  last_seen_run = max(unit_commit.last_seen_run, excluded.last_seen_run),
  files = max(unit_commit.files, excluded.files),
  added = CASE WHEN unit_commit.added IS NULL THEN excluded.added WHEN excluded.added IS NULL THEN unit_commit.added
               ELSE max(unit_commit.added, excluded.added) END,
  deleted = CASE WHEN unit_commit.deleted IS NULL THEN excluded.deleted WHEN excluded.deleted IS NULL THEN unit_commit.deleted
                 ELSE max(unit_commit.deleted, excluded.deleted) END,
  touches_code = max(unit_commit.touches_code, excluded.touches_code)`;

const COMMIT_FILE_SQL = `
INSERT INTO unit_commit_file (unit_key, sha, rel_path, status, added, deleted) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (unit_key, sha, rel_path) DO UPDATE SET
  added = CASE WHEN unit_commit_file.added IS NULL THEN excluded.added WHEN excluded.added IS NULL THEN unit_commit_file.added
               ELSE max(unit_commit_file.added, excluded.added) END,
  deleted = CASE WHEN unit_commit_file.deleted IS NULL THEN excluded.deleted WHEN excluded.deleted IS NULL THEN unit_commit_file.deleted
                 ELSE max(unit_commit_file.deleted, excluded.deleted) END`;

const MODULE_DIR_SQL = `
INSERT INTO unit_module_dir (unit_key, module_dir, existed, first_seen_run) VALUES (?, ?, ?, ?)
ON CONFLICT (unit_key, module_dir) DO UPDATE SET
  existed = CASE WHEN unit_module_dir.existed IS NULL THEN excluded.existed WHEN excluded.existed IS NULL THEN unit_module_dir.existed
                 ELSE max(unit_module_dir.existed, excluded.existed) END`;

const FIRST_COMMIT_SQL = `
UPDATE unit_artifact SET first_commit_ms = CASE WHEN first_commit_ms IS NULL THEN ?1 ELSE min(first_commit_ms, ?1) END
 WHERE unit_key = ?2 AND rel_path = ?3`;

const TIME_SQL = `
INSERT INTO unit_artifact_time (unit_key, rel_path, tier_commit_ms, last_commit_ms) VALUES (?, ?, ?, ?)
ON CONFLICT (unit_key, rel_path) DO UPDATE SET
  tier_commit_ms = CASE WHEN unit_artifact_time.tier_commit_ms IS NULL THEN excluded.tier_commit_ms
                        WHEN excluded.tier_commit_ms IS NULL THEN unit_artifact_time.tier_commit_ms
                        ELSE min(unit_artifact_time.tier_commit_ms, excluded.tier_commit_ms) END,
  last_commit_ms = CASE WHEN unit_artifact_time.last_commit_ms IS NULL THEN excluded.last_commit_ms
                        WHEN excluded.last_commit_ms IS NULL THEN unit_artifact_time.last_commit_ms
                        ELSE max(unit_artifact_time.last_commit_ms, excluded.last_commit_ms) END`;

const SCAN_SQL = `
INSERT INTO unit_git_scan (unit_key, refs_sha, commits, scanned_run) VALUES (?, ?, ?, ?)
ON CONFLICT (unit_key) DO UPDATE SET refs_sha = excluded.refs_sha, commits = excluded.commits, scanned_run = excluded.scanned_run`;

const UNITS_OF_REPO_SQL = `
SELECT o.unit_key, o.kind, o.native_id, o.dir_rel, s.refs_sha
  FROM unit_obs o LEFT JOIN unit_git_scan s ON s.unit_key = o.unit_key
 WHERE o.repo_key = ? AND o.framework = 'gsd-core'
 ORDER BY o.unit_key`;

// The archive-located artifact rows of a repo's units (no scan filter): the repo is archive-tagged when any exists, even when
// the owning unit's stored dir is still live (a moved unit, plan 03.1-02). The prefix is a case-sensitive prefilter; the
// class is decided in code by formerLivePath.
const ARCHIVE_ARTIFACTS_OF_REPO_SQL = `
SELECT a.rel_path FROM unit_artifact a JOIN unit_obs o ON o.unit_key = a.unit_key
 WHERE o.repo_key = ? AND o.framework = 'gsd-core' AND a.rel_path GLOB '.planning/milestones/*'`;

const ARTIFACTS_OF_UNIT_SQL = `
SELECT rel_path, tier_letter, tier_place FROM unit_artifact WHERE unit_key = ? ORDER BY rel_path`;

// The common dir of a repo key when it is a real directory, else null.
function commonDirOf(repoKey, home) {
  const abs = expandStoredDir(repoKey, home);
  if (abs === null) return null;
  try {
    return lstatSync(abs).isDirectory() ? abs : null;
  } catch {
    return null;
  }
}

// The artifact times of one unit: first add, last change, and the frontmatter tier commit for a frontmatter artifact
// with a letter. -> [{ rel_path, first, last, tier }] or null when a git call did not run.
// Plan 03.1-03 (D-07, D-19): an artifact under a milestone archive root is looked up through its FORMER live path
// (formerLivePath, a pure rewrite, no rename detection) for its first add, its tier commit and its last change; the
// archive path's own add or edit is the archive commit and never a time of the artifact (02-05 WR-06, CR-02). Where the
// former path has no history before the archive path's own first-add time the time is null (review CR-01: that first-add time
// bounds the first add, the tier candidates and the last change alike, since a dir name reused by a later milestone adds and
// edits the same former path again after this archive, and that history is not this unit's; formerPathLookup holds the
// first two). The last change of an archive-class artifact is the newest change of the former path strictly before that
// bound: when the newest-per-path answer is already before that
// bound it is used with no further git call, otherwise one targeted log of that path answers (lastChangeBefore). An
// archive path with no first-add time (an uncommitted move) has no bound.
function artifactTimes({
  top, artifacts, index, last, run,
}) {
  const t = tracked(run);
  const out = [];
  for (const a of artifacts) {
    const {
      lookup, boundMs, first, candidates,
    } = formerPathLookup(index, a.rel_path);
    let lastMs = last.get(lookup) ?? null;
    if (boundMs !== undefined && lastMs !== null && lastMs >= boundMs) {
      const before = lastChangeBefore({
        top, relPath: lookup, boundMs, run: t.run,
      });
      if (before === undefined) return null;
      lastMs = before;
    }
    const tier = a.tier_letter !== null && a.tier_place === 'frontmatter'
      ? frontmatterTierMs({
        top, relPath: lookup, candidates, run: t.run,
      })
      : null;
    if (t.failed) return null;
    if (first !== null || lastMs !== null || tier !== null) {
      out.push({
        rel_path: a.rel_path, first, last: lastMs, tier,
      });
    }
  }
  return out;
}

// The ingest step: scans every unit whose repo refs changed since its last complete scan. See the header.
// -> { facts: 'ok' | 'unavailable' | 'not_needed', units, deferred, dropped } (dropped: the paths and commits of the
// stored units that were left out, review CR-01).
export async function collectFacts({
  db, home, runId, checkpoint = async () => {}, run = defaultGitRun,
}) {
  const out = {
    facts: 'not_needed', units: 0, deferred: 0, dropped: 0,
  };
  const repos = db.prepare("SELECT DISTINCT repo_key FROM unit_obs WHERE framework = 'gsd-core' ORDER BY repo_key").all()
    .map((r) => r.repo_key);
  if (repos.length === 0) return out;
  const probe = gitProbe({ run: (args) => run(args) });
  if (!probe.ok) return { ...out, facts: 'unavailable' };
  const unitsOf = db.prepare(UNITS_OF_REPO_SQL);
  const artifactsOf = db.prepare(ARTIFACTS_OF_UNIT_SQL);
  const archiveRowsOf = db.prepare(ARCHIVE_ARTIFACTS_OF_REPO_SQL);
  const pending = [];
  let needed = false;
  for (const repoKey of repos) {
    const units = unitsOf.all(repoKey);
    const top = commonDirOf(repoKey, home);
    // R1 W3: salt the cursor of a repo that holds archive-class rows (a unit stored from an archive dir, or any artifact row
    // under an archive root, which also tags a moved unit whose stored dir is still live); a live-only repo is unsalted.
    const tagged = top !== null && (units.some((u) => formerLivePath(u.dir_rel) !== u.dir_rel)
      || archiveRowsOf.all(repoKey).some((r) => formerLivePath(r.rel_path) !== r.rel_path));
    const digest = top === null ? null : refsDigest({ top, run, salt: tagged ? FACTS_RULES_TAG : '' });
    const todo = digest === null ? units : units.filter((u) => u.refs_sha !== digest);
    if (todo.length === 0) continue;
    needed = true;
    if (digest === null) { out.deferred += todo.length; continue; }
    const index = artifactCommitIndex({ top, run });
    const last = index.git === 'ok' ? artifactLastChange({ top, run }) : null;
    if (index.git !== 'ok' || last === null) { out.deferred += todo.length; continue; }
    for (const u of todo) {
      // Review WR-01: a plan unit's commits are bounded below by its own PLAN file's first-add time when git has one
      // (`.planning/` tracked and the PLAN committed); otherwise there is no bound (derive flags the unit unbounded).
      // Plan 03.1-03: an archive dir's lower bound is the first add of the PLAN under its former live path, never the archive commit,
      // and only when that add is before the archive path's own first add (review CR-01: a later milestone's add is not this unit's).
      const since = u.kind === 'plan' ? formerPathLookup(index, `${u.dir_rel}/${u.native_id}-PLAN.md`).first : null;
      pending.push({
        u, top, digest, index, last, since,
      });
    }
  }
  if (!needed) return out;
  out.facts = 'ok';
  const upCommit = db.prepare(COMMIT_SQL);
  const upFile = db.prepare(COMMIT_FILE_SQL);
  const upDir = db.prepare(MODULE_DIR_SQL);
  const upFirst = db.prepare(FIRST_COMMIT_SQL);
  const upTime = db.prepare(TIME_SQL);
  const upScan = db.prepare(SCAN_SQL);
  for (let i = 0; i < pending.length; i += FACTS_BATCH_UNITS) {
    const batch = [];
    for (const p of pending.slice(i, i + FACTS_BATCH_UNITS)) {
      const facts = collectUnitFacts({
        top: p.top, kind: p.u.kind, nativeId: p.u.native_id, home, run, sinceMs: p.since,
      });
      const times = facts === null ? null : artifactTimes({
        top: p.top, artifacts: artifactsOf.all(p.u.unit_key), index: p.index, last: p.last, run,
      });
      if (facts === null || times === null) { out.deferred += 1; continue; }
      batch.push({
        key: p.u.unit_key, digest: p.digest, facts, times,
      });
    }
    if (batch.length === 0) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const b of batch) {
        for (const c of b.facts.commits) {
          upCommit.run(b.key, c.sha, c.author_ms, c.files_n, c.added, c.deleted, c.touches_code, runId);
          for (const f of c.files) upFile.run(b.key, c.sha, f.path, f.status, f.added, f.deleted);
        }
        for (const d of b.facts.moduleDirs) upDir.run(b.key, d.module_dir, d.existed, runId);
        for (const a of b.times) {
          if (a.first !== null) upFirst.run(a.first, b.key, a.rel_path);
          if (a.last !== null || a.tier !== null) upTime.run(b.key, a.rel_path, a.tier, a.last);
        }
        upScan.run(b.key, b.digest, b.facts.commits.length, runId);
        out.units += 1;
        out.dropped += b.facts.dropped;
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
      throw err;
    }
    await checkpoint();
  }
  return out;
}
