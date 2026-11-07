// fillRepoLabels and fillUnits (plans 02-02 and 02-05, UNIT-01, UNIT-03, UNIT-04, D-01..D-07, D-10, D-11, D-17,
// TIER-02, ADR-0004): the derived repo display and the unit record, read from the store's migration 007 tables
// (attached read-only as schema s) inside the one rebuild transaction. Fixed SQL text; every value is bound.
//
//   repo_label  display = repo_name when it is not NULL and exactly one store repo carries that name, else the
//               repo_key, so grouping by the display groups by the key and two repos named alike stay apart
//   unit        one row per s.unit_obs row (plan 03-03: plus one per ledger unit_key that has no unit_obs row, a
//               ledger-only unit built through the same code with empty reconstruction inputs): repo and repo_name from
//               repo_label; present = the unit was seen by the last scan of its repo; population reconstructed (forward
//               when the unit has ledger lines: see below); recorded_at_utc = the start time of the ingest run
//               that first saw the unit. Plan 02-05: every other attribute comes from the stored facts through
//               02-03's pure rules, unchanged: unitTier (tier, tier_native, tier_signal, tier_timing, tier_conflict),
//               inTierComparison with includeInferred false (tier_comparable), touchedPaths and riskOf (risk_class as
//               the JSON text of the sorted tags, risk_source; NULL with `no-rules` when no table is usable),
//               noveltyOf (novelty, novelty_source), unitDates (start, end, their sources, git_evidence) and
//               unitSize (D-17), commits_bounded (review WR-01) and interval_trusted (review 02-07 WR-01, link-fill.mjs). Only artifacts under the unit's stored dir_rel
//               count (review 02-02 CR-02), where an archive path counts as its former live path (plan 03.1-02, memberArtifacts). The
//               commit list and the artifacts' git times reach the rules only for a unit with a unit_git_scan row,
//               else they are null (unknown), exactly as 02-03's collector reports a git-unavailable unit; the list
//               holds only the unit_commit rows whose last_seen_run is that row's scanned_run (review WR-02).
//   unit_role   the number of the unit's artifacts per role.
//   repo_scan_count  plan 03.1-02 (D-03): per repo, the location counters of its latest scan (the ingest_count rows of source
//               `units` of the repo's last_scanned_run, kinds LOCATION_KINDS but `repeat_id` and the sentinel), only for a repo
//               whose latest scan wrote the `trees_scanned` sentinel, with one row per counter (n 0 where the scan counted nothing, review CR-03);
//               a repo without the sentinel has no row (unknown, never zero).
//   unit.id_repeats  the number of second dirs of the unit's id in another location in the unit's latest scan (the `repeat_id`
//               rows of that run for the unit key): 0 when the repo has the sentinel and no row, NULL when it has no sentinel
//               for its latest scan or the unit has no stored observation (a ledger-only unit). Never a zero for an unknown.
//
// Plan 03-03 (D-04, D-12, D-13, D-14; ADR-0011): a unit_key with ledger_line rows is ONE row, population forward. The pure
// merge of src/derive/ledger-merge.mjs gives its tier, start, end, status, command, runtime, session id and the earliest
// line time; each field takes the ledger value first (labels: tier_signal `ledger`, date_source and end_source `ledger`)
// and falls back per field to the reconstruction. recon_tier, recon_start_ms and recon_end_ms keep what reconstruction
// alone computed (review 03-05: with recon_date_source and recon_end_source, its own sources), ledger_start_ms and ledger_end_ms the merge result before the clamp (calibrate, plan 03-05), has_recon
// whether a unit_obs row exists. The merged start and end go through the same clamp (a raised end is labeled `clamped`).
// The overlay is written into the inserted row, before the trust loop reads the unit rows, so interval_trusted follows the
// overlaid end_source (a ledger end is not a git end: 0). link-fill.mjs and confounders.mjs are not edited.
import { unitTier, inTierComparison } from '../units/tier.mjs';
import { riskOf, touchedPaths } from '../units/risk.mjs';
import { noveltyOf } from '../units/novelty.mjs';
import { intervalTrust } from './link-fill.mjs';
import { mergeLedger } from './ledger-merge.mjs';
import {
  LOCATION_KINDS, SENTINEL_KIND, canonicalDir, formerLivePath,
} from '../adapters/gsd-core/layout.mjs';

const REPO_LABEL_SQL = `
INSERT INTO repo_label (repo_key, repo_name, display)
SELECT r.repo_key, r.repo_name,
       CASE WHEN r.repo_name IS NOT NULL
             AND (SELECT count(*) FROM s.repo r2 WHERE r2.repo_name = r.repo_name) = 1
            THEN r.repo_name ELSE r.repo_key END
  FROM s.repo r`;

const BASE_SQL = `
SELECT o.unit_key, o.framework, o.repo_key, l.display AS repo, l.repo_name, o.kind, o.native_id, o.dir_rel,
       CASE WHEN o.last_seen_run = r.last_scanned_run THEN 1 ELSE 0 END AS present,
       (SELECT ir.started_utc FROM s.ingest_run ir WHERE ir.run_id = o.first_seen_run) AS recorded_at_utc,
       CASE WHEN o.id_date IS NULL THEN NULL ELSE unixepoch(o.id_date) * 1000 - o.id_offset_min * 60000 END AS id_start_ms,
       (SELECT 1 FROM s.unit_git_scan g WHERE g.unit_key = o.unit_key) AS scanned
  FROM s.unit_obs o
  JOIN s.repo r ON r.repo_key = o.repo_key
  JOIN repo_label l ON l.repo_key = o.repo_key
 ORDER BY o.unit_key`;

const ARTIFACTS_SQL = `
SELECT a.unit_key, a.rel_path, a.role, a.mtime_ms, a.first_mtime_ms, a.first_commit_ms, a.tier_letter, a.tier_place,
       t.tier_commit_ms, t.last_commit_ms, t.fm_date, t.fm_offset_min
  FROM s.unit_artifact a
  LEFT JOIN s.unit_artifact_time t ON t.unit_key = a.unit_key AND t.rel_path = a.rel_path
 ORDER BY a.unit_key, a.rel_path`;
const PATHS_SQL = 'SELECT unit_key, rel_path FROM s.unit_path ORDER BY unit_key, rel_path';
// Review WR-02: only the commits the unit's last complete git scan saw (unit_commit rows are never deleted, so a
// rewritten commit's old sha stays stored and must not count).
const COMMITS_SQL = `
SELECT c.unit_key, c.sha, c.author_ms, c.files
  FROM s.unit_commit c
  JOIN s.unit_git_scan g ON g.unit_key = c.unit_key AND g.scanned_run = c.last_seen_run
 ORDER BY c.unit_key, c.author_ms, c.sha`;
const COMMIT_FILES_SQL = 'SELECT unit_key, sha, rel_path, status, added, deleted FROM s.unit_commit_file ORDER BY unit_key, sha, rel_path';
const MODULE_DIRS_SQL = 'SELECT unit_key, module_dir, existed FROM s.unit_module_dir ORDER BY unit_key, module_dir';

// Plan 03.1-02 (D-03, J5). The repos whose latest scan wrote the sentinel; their counters; the repeat rows by unit key.
const SCAN_KINDS = LOCATION_KINDS.filter((k) => k !== 'repeat_id' && k !== SENTINEL_KIND);
const SENTINEL_REPOS_SQL = `
SELECT r.repo_key, r.last_scanned_run AS run_id
  FROM s.repo r
 WHERE r.last_scanned_run IS NOT NULL
   AND EXISTS (SELECT 1 FROM s.ingest_count c
                WHERE c.source = 'units' AND c.kind = ? AND c.name = r.repo_key AND c.run_id = r.last_scanned_run)
 ORDER BY r.repo_key`;
const SCAN_COUNT_SQL = `
SELECT c.name AS repo_key, c.kind, c.n, c.run_id
  FROM s.ingest_count c
 WHERE c.source = 'units' AND c.name = ?1 AND c.run_id = ?2 AND c.kind IN (${SCAN_KINDS.map((_, i) => `?${i + 3}`).join(', ')})
 ORDER BY c.kind`;
const INSERT_SCAN_COUNT_SQL = 'INSERT INTO repo_scan_count (repo_key, kind, n, run_id) VALUES (?, ?, ?, ?)';
const REPEATS_SQL = `
SELECT c.name AS unit_key, c.n
  FROM s.ingest_count c
  JOIN s.unit_obs o ON o.unit_key = c.name
  JOIN s.repo r ON r.repo_key = o.repo_key
 WHERE c.source = 'units' AND c.kind = ? AND c.run_id = r.last_scanned_run`;

const INSERT_UNIT_SQL = `
INSERT INTO unit (unit_key, framework, repo_key, repo, repo_name, kind, native_id, dir_rel, present, population,
                  recorded_at_utc, start_ms, end_ms, date_source, branch, runtime, tier_native, tier, tier_signal,
                  tier_timing, tier_conflict, risk_class, risk_source, novelty, novelty_source, end_source, git_evidence,
                  tier_comparable, size_commits, size_files, size_added, size_deleted, commits_bounded, status, tier_source,
                  ledger_lines, ledger_command, ledger_runtime, ledger_session_id, recon_tier, recon_start_ms, recon_end_ms,
                  recon_date_source, recon_end_source, has_recon, ledger_start_ms, ledger_end_ms, id_repeats)
VALUES ($unit_key, $framework, $repo_key, $repo, $repo_name, $kind, $native_id, $dir_rel, $present, $population,
        $recorded_at_utc, $start_ms, $end_ms, $date_source, NULL, NULL, $tier_native, $tier, $tier_signal,
        $tier_timing, $tier_conflict, $risk_class, $risk_source, $novelty, $novelty_source, $end_source, $git_evidence,
        $tier_comparable, $size_commits, $size_files, $size_added, $size_deleted, $commits_bounded, $status, $tier_source,
        $ledger_lines, $ledger_command, $ledger_runtime, $ledger_session_id, $recon_tier, $recon_start_ms, $recon_end_ms,
        $recon_date_source, $recon_end_source, $has_recon, $ledger_start_ms, $ledger_end_ms, $id_repeats)`;
const REPO_LABELS_SQL = 'SELECT repo_key, repo_name, display FROM repo_label';
// Plan 03-03 (D-12, D-13): the validated ledger lines, read once and grouped by unit key in memory. Ordered by time then
// line id (bytewise), the order the merge rule of src/derive/ledger-merge.mjs reads them in. A store without the table
// (a store older than migration 008) has none.
const LEDGER_EXISTS_SQL = "SELECT 1 AS present FROM s.sqlite_master WHERE type = 'table' AND name = 'ledger_line'";
const LEDGER_SQL = `
SELECT unit_key, line_id, record, ts_utc, framework, repo_key, kind, native_id, tier, tier_source, command_name AS command, runtime,
       session_id, start_utc, end_utc, status
  FROM s.ledger_line ORDER BY unit_key, ts_utc, line_id`;
const TRUST_SQL = `
SELECT unit_key, repo_key, kind, start_ms, end_ms, date_source, end_source, git_evidence, commits_bounded FROM unit ORDER BY unit_key`;
const SET_TRUST_SQL = 'UPDATE unit SET interval_trusted = ? WHERE unit_key = ?';
const INSERT_ROLE_SQL = 'INSERT INTO unit_role (unit_key, role, n) VALUES (?, ?, ?)';
const STATE_SQL = `
UPDATE derive_state SET risk_rules_file = ?, risk_rules_version = ?, risk_rules_sha = ?, units_n = ?, units_end_clamped = ?
 WHERE id = 1`;

const PLANNING_PREFIX = '.planning/';
const isMs = (v) => typeof v === 'number' && Number.isFinite(v);
const minOf = (xs) => (xs.length === 0 ? null : Math.min(...xs));
const maxOf = (xs) => (xs.length === 0 ? null : Math.max(...xs));

const groupBy = (rows) => {
  const out = new Map();
  for (const r of rows) {
    const list = out.get(r.unit_key);
    if (list) list.push(r);
    else out.set(r.unit_key, [r]);
  }
  return out;
};

// D-10 dates of one unit. own: the unit's own artifacts ({ role, first_commit_ms, last_commit_ms, mtime_ms, fm_date,
// fm_offset_min }); commits: null without a scan row, else [{ author_ms }]; scanned: false when the unit has no
// unit_git_scan row, so no git time is used at all.
//   start  quick-id (idStartMs) when the unit has an id date; else the earliest git time (own artifacts' first commit,
//          unit commit author times) with source git; else the earliest own-artifact mtime ever seen (first_mtime_ms,
//          or mtime_ms for a row without it; review WR-05) (mtime); else none
//   end    the latest git time (own artifacts' last commit, unit commit author times) with source git; else the own
//          SUMMARY's `completed:` date read as a local day (its last millisecond: the local midnight from fm_date and
//          fm_offset_min plus one day minus 1 ms) with source frontmatter; else the latest own-artifact mtime
//          (mtime); else none
// An end before the start is raised to the start (clamped true) and its source is `clamped` (review WR-03, RR-05: the
// raised value never carries the source of the value it replaced). git_evidence is 1 exactly when a git time exists.
// -> { start_ms, date_source, end_ms, end_source, git_evidence, clamped, unclamped_end_ms, unclamped_end_source }.
const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function frontmatterEndMs(own) {
  const summaries = own.filter((a) => a?.role === 'summary' && typeof a.fm_date === 'string' && Number.isInteger(a.fm_offset_min))
    .sort((x, y) => (String(x.rel_path) < String(y.rel_path) ? -1 : String(x.rel_path) > String(y.rel_path) ? 1 : 0));
  for (const a of summaries) {
    const m = DATE_RE.exec(a.fm_date);
    if (!m) continue;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - a.fm_offset_min * 60000 + DAY_MS - 1;
  }
  return null;
}

export function unitDates({
  idStartMs = null, own = [], commits = null, scanned = true,
} = {}) {
  const list = Array.isArray(own) ? own : [];
  const authored = scanned ? (Array.isArray(commits) ? commits : []).map((c) => c?.author_ms).filter(isMs) : [];
  const firstGit = scanned ? [...list.map((a) => a?.first_commit_ms).filter(isMs), ...authored] : [];
  const lastGit = scanned ? [...list.map((a) => a?.last_commit_ms).filter(isMs), ...authored] : [];
  const mtimes = list.map((a) => a?.mtime_ms).filter(isMs);
  const firstMtimes = list.map((a) => (isMs(a?.first_mtime_ms) ? a.first_mtime_ms : a?.mtime_ms)).filter(isMs);
  let start = { ms: null, source: 'none' };
  if (isMs(idStartMs)) start = { ms: idStartMs, source: 'quick-id' };
  else if (firstGit.length > 0) start = { ms: minOf(firstGit), source: 'git' };
  else if (firstMtimes.length > 0) start = { ms: minOf(firstMtimes), source: 'mtime' };
  let end = { ms: null, source: 'none' };
  const fmEnd = frontmatterEndMs(list);
  if (lastGit.length > 0) end = { ms: maxOf(lastGit), source: 'git' };
  else if (fmEnd !== null) end = { ms: fmEnd, source: 'frontmatter' };
  else if (mtimes.length > 0) end = { ms: maxOf(mtimes), source: 'mtime' };
  const clamped = start.ms !== null && end.ms !== null && end.ms < start.ms;
  return {
    start_ms: start.ms,
    date_source: start.source,
    end_ms: clamped ? start.ms : end.ms,
    end_source: clamped ? 'clamped' : end.source,
    git_evidence: firstGit.length > 0 || lastGit.length > 0 ? 1 : 0,
    clamped,
    // Plan 03-03: the end before the clamp, so a ledger start can be merged with the reconstructed end it really had.
    unclamped_end_ms: end.ms,
    unclamped_end_source: end.source,
  };
}

// D-17 unit size: commits counts every unit commit; files, added and deleted count the distinct paths outside
// `.planning/` of those commits and their summed numstat lines (NULL when a counted file has no line count, a binary
// file). Every value is NULL when no unit commit is known (commits null or empty), never 0. Review CR-01: a commit
// whose files_n (the paths git listed, unit_commit.files) exceeds its stored file rows lost a path, so files, added
// and deleted are NULL (unknown) while commits stays known.
// commits: [{ files_n, files: [{ path, added, deleted }] }]. -> { commits, files, added, deleted }.
export function unitSize(commits) {
  if (!Array.isArray(commits) || commits.length === 0) {
    return {
      commits: null, files: null, added: null, deleted: null,
    };
  }
  const lost = commits.some((c) => Number.isInteger(c?.files_n) && c.files_n > (Array.isArray(c?.files) ? c.files.length : 0));
  if (lost) {
    return {
      commits: commits.length, files: null, added: null, deleted: null,
    };
  }
  const paths = new Set();
  let added = 0;
  let deleted = 0;
  for (const c of commits) {
    for (const f of Array.isArray(c?.files) ? c.files : []) {
      if (typeof f?.path !== 'string' || f.path.startsWith(PLANNING_PREFIX)) continue;
      paths.add(f.path);
      added = added === null || !Number.isInteger(f.added) ? null : added + f.added;
      deleted = deleted === null || !Number.isInteger(f.deleted) ? null : deleted + f.deleted;
    }
  }
  return {
    commits: commits.length, files: paths.size, added, deleted,
  };
}

export function fillRepoLabels({ db }) {
  db.exec(REPO_LABEL_SQL);
}

// The merged start and end of a forward unit, ledger first per field, then the same clamp as unitDates (a raised end carries
// the source `clamped`, never the source of the value it replaced). -> { start_ms, date_source, end_ms, end_source, clamped }.
function mergeDates(dates, m) {
  const start = m.start_ms !== null ? { ms: m.start_ms, source: 'ledger' } : { ms: dates.start_ms, source: dates.date_source };
  const end = m.end_ms !== null ? { ms: m.end_ms, source: 'ledger' } : { ms: dates.unclamped_end_ms, source: dates.unclamped_end_source };
  const clamped = start.ms !== null && end.ms !== null && end.ms < start.ms;
  return {
    start_ms: start.ms,
    date_source: start.source,
    end_ms: clamped ? start.ms : end.ms,
    end_source: clamped ? 'clamped' : end.source,
    clamped,
  };
}

const compareBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const nullSafe = (pick) => (xs) => {
  const known = xs.filter(isMs);
  return known.length === 0 ? null : pick(...known);
};
const earliest = nullSafe(Math.min);
const latest = nullSafe(Math.max);

// Plan 03.1-02 (D-02, J2, J3): the artifact rows that belong to a unit with stored dir `dirRel`, one record per file. A row
// belongs to the unit when its path, rewritten from an archive path back to its former live path (layout.mjs formerLivePath),
// lies under the unit's stored dir rewritten the same way: so the rows stored under the dir the unit was first seen in and the
// rows stored under the archive dir it moved to are one set. The rows of one file name (the path below the dir) merge into one
// record, so the role counts and the tier do not count a moved file twice: letters and their place are the first non-NULL one,
// the stored-dir row first; the first times (first_commit_ms, tier_commit_ms, first_mtime_ms) are the earliest; the last times
// (last_commit_ms, mtime_ms) the latest; the frontmatter date and its offset come from the first row that has a date. The
// record's rel_path is the stored dir plus the file name. A row of a dir with another name is never claimed, and nothing
// stored is dropped (the rows stay in the store; this only reads them). Rows come ordered by rel_path; the result is ordered
// bytewise by file name.
export function memberArtifacts(rows, dirRel) {
  const canon = canonicalDir(dirRel);
  const under = `${canon}/`;
  const groups = new Map();
  for (const a of rows) {
    const live = formerLivePath(a.rel_path);
    if (!live.startsWith(under) || live.length === under.length) continue;
    const name = live.slice(under.length);
    const list = groups.get(name);
    if (list) list.push(a);
    else groups.set(name, [a]);
  }
  const own = `${dirRel}/`;
  const out = [];
  for (const name of [...groups.keys()].sort(compareBytes)) {
    // The row stored under the unit's own dir first, then the others in path order (rows arrive ordered by rel_path).
    const list = [...groups.get(name)].sort((x, y) => (x.rel_path.startsWith(own) ? 0 : 1) - (y.rel_path.startsWith(own) ? 0 : 1));
    const withLetter = list.find((a) => a.tier_letter !== null && a.tier_letter !== undefined);
    const withDate = list.find((a) => typeof a.fm_date === 'string');
    out.push({
      ...list[0],
      rel_path: `${own}${name}`,
      tier_letter: withLetter ? withLetter.tier_letter : null,
      tier_place: withLetter ? withLetter.tier_place : null,
      first_commit_ms: earliest(list.map((a) => a.first_commit_ms)),
      tier_commit_ms: earliest(list.map((a) => a.tier_commit_ms)),
      first_mtime_ms: earliest(list.map((a) => (isMs(a.first_mtime_ms) ? a.first_mtime_ms : a.mtime_ms))),
      last_commit_ms: latest(list.map((a) => a.last_commit_ms)),
      mtime_ms: latest(list.map((a) => a.mtime_ms)),
      fm_date: withDate ? withDate.fm_date : null,
      fm_offset_min: withDate ? withDate.fm_offset_min : null,
    });
  }
  return out;
}

// riskRules: a table from loadRiskRules, or null when none is usable.
export function fillUnits({ db, riskRules = null }) {
  const observed = db.prepare(BASE_SQL).all().map((o) => ({ ...o, has_recon: 1 }));
  // Plan 03.1-02: the per-repo counters of the latest scan and the repeated-id marker; a repo without the sentinel has neither.
  const scanRepos = new Set();
  const insScan = db.prepare(INSERT_SCAN_COUNT_SQL);
  const scanCountsOf = db.prepare(SCAN_COUNT_SQL);
  for (const r of db.prepare(SENTINEL_REPOS_SQL).all(SENTINEL_KIND)) {
    scanRepos.add(r.repo_key);
    // One row per counter for every repo that wrote the sentinel (review CR-03): 0 where the scan counted nothing, so a missing row
    // means only unknown (a repo never scanned under plan 03.1-01), never zero.
    const got = new Map(scanCountsOf.all(r.repo_key, r.run_id, ...SCAN_KINDS).map((c) => [c.kind, c.n]));
    for (const kind of SCAN_KINDS) insScan.run(r.repo_key, kind, got.get(kind) ?? 0, r.run_id);
  }
  const repeatsBy = new Map(db.prepare(REPEATS_SQL).all('repeat_id').map((r) => [r.unit_key, r.n]));
  const artifactsBy = groupBy(db.prepare(ARTIFACTS_SQL).all());
  const pathsBy = groupBy(db.prepare(PATHS_SQL).all());
  const commitsBy = groupBy(db.prepare(COMMITS_SQL).all());
  const filesBy = groupBy(db.prepare(COMMIT_FILES_SQL).all());
  const dirsBy = groupBy(db.prepare(MODULE_DIRS_SQL).all());
  const ledgerBy = db.prepare(LEDGER_EXISTS_SQL).get() === undefined ? new Map() : groupBy(db.prepare(LEDGER_SQL).all());
  // J7: a ledger unit_key with no unit_obs row is built by the same code from empty reconstruction inputs (no artifacts, no
  // commits, not scanned, no dir): every reconstruction-derived field is then unknown by the existing rules.
  const known = new Set(observed.map((o) => o.unit_key));
  const labels = new Map(db.prepare(REPO_LABELS_SQL).all().map((r) => [r.repo_key, r]));
  const ledgerOnly = [];
  for (const [unitKey, rows] of ledgerBy) {
    if (known.has(unitKey)) continue;
    const r = rows[0];
    const label = labels.get(r.repo_key);
    ledgerOnly.push({
      unit_key: unitKey,
      framework: r.framework,
      repo_key: r.repo_key,
      repo: label ? label.display : r.repo_key,
      repo_name: label ? label.repo_name : null,
      kind: r.kind,
      native_id: r.native_id,
      dir_rel: null,
      present: 0,
      recorded_at_utc: null,
      id_start_ms: null,
      scanned: null,
      has_recon: 0,
    });
  }
  const base = [...observed, ...ledgerOnly].sort((a, b) => compareBytes(a.unit_key, b.unit_key));
  const insUnit = db.prepare(INSERT_UNIT_SQL);
  const insRole = db.prepare(INSERT_ROLE_SQL);
  let clamped = 0;
  for (const o of base) {
    const scanned = o.scanned === 1;
    const under = o.dir_rel === null ? null : `${o.dir_rel}/`;
    const rows = under === null ? [] : memberArtifacts(artifactsBy.get(o.unit_key) ?? [], o.dir_rel);
    const artifacts = rows.map((a) => ({
      role: a.role,
      rel_path: a.rel_path,
      tier_letter: a.tier_letter,
      tier_place: a.tier_place,
      first_commit_ms: scanned ? a.first_commit_ms : null,
      tier_commit_ms: scanned ? a.tier_commit_ms : null,
      last_commit_ms: scanned ? a.last_commit_ms : null,
      mtime_ms: a.mtime_ms,
      first_mtime_ms: a.first_mtime_ms,
      fm_date: a.fm_date,
      fm_offset_min: a.fm_offset_min,
    }));
    const filesModified = (pathsBy.get(o.unit_key) ?? []).map((p) => p.rel_path);
    let commits = null;
    if (scanned) {
      const files = groupBy((filesBy.get(o.unit_key) ?? []).map((f) => ({ ...f, unit_key: f.sha })));
      commits = (commitsBy.get(o.unit_key) ?? []).map((c) => ({
        sha: c.sha,
        author_ms: c.author_ms,
        files_n: c.files,
        files: (files.get(c.sha) ?? []).map((f) => ({
          path: f.rel_path, status: f.status, added: f.added, deleted: f.deleted,
        })),
      }));
    }
    const newDirs = new Map((dirsBy.get(o.unit_key) ?? []).map((d) => [d.module_dir, d.existed === null ? null : d.existed === 1]));
    const tier = unitTier({ artifacts, commits });
    const comparable = inTierComparison(tier, { includeInferred: false }) ? 1 : 0;
    const risk = riskRules
      ? riskOf(touchedPaths({ filesModified, commits }), riskRules)
      : { risk_class: null, risk_source: 'no-rules' };
    const novelty = noveltyOf({ commits, newDirs });
    const own = o.kind === 'plan' && under !== null ? artifacts.filter((a) => a.rel_path.startsWith(`${under}${o.native_id}-`)) : artifacts;
    const dates = unitDates({
      idStartMs: o.id_start_ms, own, commits, scanned,
    });
    const size = unitSize(commits);
    // Review WR-01: whether ingest bounded this plan unit's commits by its own PLAN's first-add time.
    let bounded = null;
    if (scanned && o.kind === 'plan') {
      const plan = artifacts.find((a) => a.rel_path === `${under}${o.native_id}-PLAN.md`);
      bounded = plan !== undefined && isMs(plan.first_commit_ms) ? 1 : 0;
    }
    // Plan 03-03: the ledger overlay, per field, ledger first (D-13, J4 to J8).
    const ledgerRows = ledgerBy.get(o.unit_key) ?? [];
    const m = ledgerRows.length > 0 ? mergeLedger(ledgerRows) : null;
    const useLedgerTier = m !== null && m.tier !== null;
    const fin = {
      tier: useLedgerTier ? m.tier : tier.tier,
      tier_signal: useLedgerTier ? 'ledger' : tier.tier_signal,
      tier_timing: useLedgerTier ? m.tier_timing : tier.tier_timing,
      tier_comparable: useLedgerTier ? m.tier_comparable : comparable,
    };
    const merged = m === null
      ? { start_ms: dates.start_ms, date_source: dates.date_source, end_ms: dates.end_ms, end_source: dates.end_source, clamped: dates.clamped }
      : mergeDates(dates, m);
    insUnit.run({
      unit_key: o.unit_key,
      framework: o.framework,
      repo_key: o.repo_key,
      repo: o.repo,
      repo_name: o.repo_name,
      kind: o.kind,
      native_id: o.native_id,
      dir_rel: o.dir_rel,
      present: o.present,
      population: m === null ? 'reconstructed' : 'forward',
      recorded_at_utc: m === null ? o.recorded_at_utc : m.recorded_at_utc,
      start_ms: merged.start_ms,
      end_ms: merged.end_ms,
      date_source: merged.date_source,
      tier_native: tier.tier_native,
      tier: fin.tier,
      tier_signal: fin.tier_signal,
      tier_timing: fin.tier_timing,
      tier_conflict: tier.tier_conflict ? 1 : 0,
      risk_class: risk.risk_class === null ? null : JSON.stringify(risk.risk_class),
      risk_source: risk.risk_source,
      novelty: novelty.novelty,
      novelty_source: novelty.novelty_source,
      end_source: merged.end_source,
      git_evidence: dates.git_evidence,
      tier_comparable: fin.tier_comparable,
      size_commits: size.commits,
      size_files: size.files,
      size_added: size.added,
      size_deleted: size.deleted,
      commits_bounded: bounded,
      status: m === null ? null : m.status,
      tier_source: useLedgerTier ? m.tier_source : null,
      ledger_lines: ledgerRows.length,
      ledger_command: m === null ? null : m.command,
      ledger_runtime: m === null ? null : m.runtime,
      ledger_session_id: m === null ? null : m.session_id,
      recon_tier: tier.tier,
      recon_start_ms: dates.start_ms,
      // Review 03-05 M1: the reconstruction end before the clamp, with its own source (`clamped` when it was raised to its start).
      recon_end_ms: o.has_recon === 1 ? dates.unclamped_end_ms : null,
      recon_date_source: o.has_recon === 1 ? dates.date_source : null,
      recon_end_source: o.has_recon === 1 ? dates.end_source : null,
      has_recon: o.has_recon,
      ledger_start_ms: m === null ? null : m.start_ms,
      ledger_end_ms: m === null ? null : m.end_ms,
      id_repeats: o.has_recon === 1 && scanRepos.has(o.repo_key) ? (repeatsBy.get(o.unit_key) ?? 0) : null,
    });
    if (merged.clamped) clamped += 1;
    const roles = new Map();
    for (const a of artifacts) roles.set(a.role, (roles.get(a.role) ?? 0) + 1);
    for (const [role, n] of [...roles.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) insRole.run(o.unit_key, role, n);
  }
  // Review 02-07 WR-01: whether each usable interval may feed the medium link rules (needs every unit's end, so after the loop).
  const setTrust = db.prepare(SET_TRUST_SQL);
  for (const [unitKey, trusted] of intervalTrust(db.prepare(TRUST_SQL).all()).trusted) setTrust.run(trusted, unitKey);
  db.prepare(STATE_SQL).run(
    riskRules ? riskRules.file : null, riskRules ? riskRules.version : null, riskRules ? riskRules.sha : null, base.length, clamped,
  );
}
