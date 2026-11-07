// The gsd-core adapter (plans 02-02 and 02-05, UNIT-05, ADPT-01, D-10 first half, D-11): the quick directories and the
// phase plans of every live working tree of each repo become units, with every planning artifact recorded by role.
// It lives outside src/sources/ on purpose: that directory auto-registers ingest sources, and this is a post-step of the
// ingest run, not a source.
//
// For every repo row (repo_key order) it scans every live working tree that `git worktree list --porcelain` reports
// (facts.mjs treesOf: bare and prunable entries and unusable paths skipped, at most MAX_TREES_PER_REPO), or the main
// working tree alone (the parent of a key ending in `/.git`) when that call fails, and lists each tree's
// `.planning/quick/` and `.planning/phases/` bytewise.
//   quick  a directory entry whose name starts with the quick id `YYMMDD-xxx` and fits the name shape is a unit
//          candidate.
//   plan   (plan 02-05) a regular file `<id>-PLAN.md` matching PLAN_FILE_RE inside `.planning/phases/<dir>/`, whose
//          dir name starts with the id's phase part and a dash, is a phase plan unit with dir_rel
//          `.planning/phases/<dir>`; a PLAN file in a dir with another phase part is not a unit and is counted in
//          skipped.
// The unit's dir is fixed when the unit is first seen (unit_obs.dir_rel keeps its first value, ADR-0009): for an id
// that already has a unit_obs row only that stored dir is read, and every other dir with the id is counted as dup_ids,
// never read or merged, in any later run and whatever its sort order; when the stored dir is gone (removed or
// renamed), nothing is read for the id, so the unit keeps its stored tier and artifacts and is no longer present. For
// a new id the bytewise-first dir is the unit and later ones are dup_ids (review 02-02 CR-02). The same rule holds per
// kind.
//
// Plan 03.1-01 (ADPT-05, D-04): archived milestone dirs are read too. `.planning/milestones/<label>-phases/<dir>` holds
// phase plan units and `.planning/milestones/<label>-quick/<dir>` quick units (layout.mjs: the label grammar of the
// writer; a sibling such as `.planning/milestones-v1-03-alpha`, a file such as `v1.0-ROADMAP.md` and a directory that is
// no `<label>-phases` or `-quick` root are not archive roots; the last is counted). The roots of a kind are read oldest
// archive first (labels in natural numeric order), the live root last, with one `seen` set per kind across all of them.
// A unit's dir_rel is the path of the dir the unit was first read in (ADR-0009), live or archive. What a scan could not
// read as a unit is counted by name (`notRead`, layout.mjs LOCATION_KINDS) and persisted per repo and run by
// collectUnits, never dropped silently.
//
// Plan 03.1-02 (ADPT-05, D-02, D-18, D-22): a unit whose dir moved into a milestone archive keeps its key, its stored dir_rel
// and its place in the store, and stays present. collectUnits decides moves after every tree of the repo is scanned (the stored
// dir can still exist in a linked worktree): for a known id whose stored dir is absent from every tree, exactly one archive
// dir with the stored dir's name is that unit's location (read through readUnitAt, so last_seen_run advances); two or more
// are `move_ambiguous` (counted, nothing read); none is not a move. A stored dir still present wins, and its archive copy is a
// `repeat_id`. No rename detection: the rule needs the stored dir and the trees only.
//
// Plan 03.1-04 (ADPT-04, D-08, D-21): every regular file of a listed dir is also classified once by name against the roster
// (roster.mjs), independent of the unit and of the ten stored roles: the loose files of the phases, quick and milestones
// roots, the files of each read unit dir and of each standard or coded phase dir that was not skipped as a second dir of an
// id (repeat_id, dup_ids), and never the files of a bracket, custom or workstream dir. A name outside the shape, a symlink
// and a `..` name are counted in skipped, not classified. The result is a map rel path -> class (null: unclassified), merged
// per repo by rel path, so a file is counted once whatever the number of units, trees or moves that list it.
//
// Every regular file of the unit's dir is mapped to a role by its name only (artifacts.mjs); a file with a role is an
// artifact row (role, path, integer mtime). Only four are opened, through the bounded frontmatter reader: the own
// `<id>-PLAN.md` (tier letter, files_modified) and `<id>-SUMMARY.md` (tier letter, the top-level `completed:` date,
// stored in unit_artifact_time with its local-midnight offset), and for a quick unit the
// bytewise-first rigor-tier file and the bytewise-first probes-skipped file (tier letter, 02-03's readers). The
// files_modified paths are normalized by 02-03's normalizeTouchedPath (repo-relative or `~/...`, others dropped and
// counted) and stored in unit_path. The filesystem is read whether or not `.planning/` is tracked by git (D-10, first
// half).
//
// Never followed, always counted in skipped (once per path per repo): a symlinked `.planning`, `.planning/quick`,
// `.planning/phases`, unit dir or any symlink inside a unit dir; a dir or artifact name outside the shape
// [A-Za-z0-9._-]{1,128} (or holding `..`); an unreadable directory or file (EACCES, EPERM). A `~win`/`~other` key has
// no tree. Units of several trees merge on their natural keys (the stored dir of each id decides).
//
// Unit keys: `gsd-core:<repo_key>:quick:<id>` and `gsd-core:<repo_key>:plan:<id>`. The quick id is read as the local
// calendar date 20YY-MM-DD in the zone of the ingest process; the stored offset is the UTC offset in minutes of that
// date's local midnight (where midnight does not exist because DST starts then, the offset that puts it at the day's
// first instant), never a zone name; an impossible date keeps the unit with id_date NULL. A plan unit has no id date.
import { lstatSync, opendirSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { expandStoredDir } from '../../units/repo-resolve.mjs';
import { filesModified, frontmatterLines, readHead, tierLetter } from './frontmatter.mjs';
import {
  PLAN_FILE_RE, artifactRole, completedDate, factPathOk, localMidnightOffsetMin,
} from './artifacts.mjs';
import { FRAMEWORK, unitKeyOf } from '../../units/unit-key.mjs';
import { treesOf } from './facts.mjs';
import {
  LOCATION_KINDS, SENTINEL_KIND, archiveRootKind, compareLabels, dirAcceptsPlan, formerLivePath, locationOf, phaseDirForm,
  planFileForm, shownKinds,
} from './layout.mjs';
import {
  defaultGitRun, homeSetOf, normalizeTouchedPath, ownerNamesOf, probesSkippedTier, tierFileLetter,
} from './signals.mjs';
import {
  KIND_OF_CLASS, REPO_CLASS_KINDS, STEM_KIND, STEM_OTHER_KIND, classifyFile, pickStems, safeStem,
} from './roster.mjs';

export { FRAMEWORK };
export const QUICK_DIR_RE = /^(\d{6}-[a-z0-9]{3})(?:-|$)/;
const NAME_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;
const UNREADABLE = new Set(['EACCES', 'EPERM']);
const KIND_QUICK = 'quick';
const KIND_PLAN = 'plan';
const compareBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
// The counter of each plan file form that is not a unit (layout.mjs planFileForm).
const PLAN_FORM_KIND = Object.freeze({
  bare: 'not_read_bare_plan',
  id1: 'not_read_plan_id_1seg',
  id3: 'not_read_plan_id_3seg',
  coded: 'not_read_plan_file_coded',
  other: 'not_read_plan_file_other',
});
// Per tree, at most this many workstream dirs are counted and at most this many names (phase dirs and files together,
// under all workstreams) are read; the rest is counted in skipped. A listing is read entry by entry (opendirSync) and
// stops at the cap, so the bound is on what is read, not only on what is counted (review WR-02).
const MAX_WORKSTREAM_DIRS = 256;
const MAX_WORKSTREAM_NAMES = 4096;
// At most this many paths are kept per counter kind and tree; further paths are one `skipped` entry per kind.
const MAX_NOTED_PATHS = 4096;
const dirnameOf = (rel) => rel.slice(0, rel.lastIndexOf('/'));
const pad2 = (n) => String(n).padStart(2, '0');

// -> { id, date, offsetMin } (date and offsetMin null for an impossible date), or null when the name has no quick id.
export function parseQuickId(name) {
  const m = typeof name === 'string' ? QUICK_DIR_RE.exec(name) : null;
  if (!m) return null;
  const id = m[1];
  const year = 2000 + Number(id.slice(0, 2));
  const month = Number(id.slice(2, 4));
  const day = Number(id.slice(4, 6));
  const local = new Date(year, month - 1, day);
  const ok = month >= 1 && month <= 12 && local.getFullYear() === year && local.getMonth() === month - 1 && local.getDate() === day;
  if (!ok) return { id, date: null, offsetMin: null };
  // The offset that puts the local midnight of the date at the first instant JS chose for that day. Where DST starts at
  // midnight the day starts at 01:00 and getTimezoneOffset() would give the post-transition offset, one hour off, on
  // the previous local day (review 02-02 WR-02).
  const offsetMin = (Date.UTC(year, month - 1, day) - local.getTime()) / 60000;
  return { id, date: `${year}-${pad2(month)}-${pad2(day)}`, offsetMin: offsetMin || 0 };
}

// The main working tree of a repo key, or null: only a key ending in `/.git` has one (its parent), and only when that
// directory exists.
export function mainTreeOf(repoKey, home) {
  const abs = expandStoredDir(repoKey, home);
  if (abs === null || !abs.endsWith('/.git')) return null;
  const top = dirname(abs);
  try {
    return lstatSync(top).isDirectory() ? top : null;
  } catch {
    return null;
  }
}

// lstat that answers 'missing', 'symlink', 'dir', 'file' or 'other'; unreadable errors are thrown.
function kindOf(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return 'missing';
    throw err;
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

// lstat that answers like kindOf, with EACCES and EPERM as 'unreadable'.
function safeKind(p) {
  try {
    return kindOf(p);
  } catch (err) {
    if (UNREADABLE.has(err?.code)) return 'unreadable';
    throw err;
  }
}

// The entries of a directory sorted bytewise, or null when it is unreadable (counted as skipped under rel).
function listDir(abs, rel, c) {
  try {
    return readdirSync(abs, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
  } catch (err) {
    if (UNREADABLE.has(err?.code)) { c.skip(rel); return null; }
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
}

// Up to `cap` entries of a directory, read one at a time and sorted bytewise (which entries are read past the cap is the
// file system's order). -> { entries, more } (more: the directory holds entries beyond the cap), or null as listDir does.
function listDirCapped(abs, rel, c, cap) {
  let dir;
  try {
    dir = opendirSync(abs);
    const entries = [];
    let more = false;
    for (let e = dir.readSync(); e !== null; e = dir.readSync()) {
      if (entries.length >= cap) { more = true; break; }
      entries.push(e);
    }
    return { entries: entries.sort((a, b) => compareBytes(a.name, b.name)), more };
  } catch (err) {
    if (UNREADABLE.has(err?.code)) { c.skip(rel); return null; }
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  } finally {
    try { dir?.closeSync(); } catch { /* already closed */ }
  }
}

// The bounded head of a regular file, or undefined when it is unreadable (counted) and null when it is gone.
function headOf(abs, rel, c) {
  try {
    return readHead(abs);
  } catch (err) {
    if (UNREADABLE.has(err?.code)) { c.skip(rel); return undefined; }
    throw err;
  }
}

// Plan 03.1-04. Classifies the regular files of one listing by name into `sink` (Map rel path -> { cls, name }, cls null when
// no roster entry of the scope matches, coded true for a file of a coded phase dir, the only place a project code is stripped),
// once per rel path. A symlink and a name outside the shape (or holding `..`) are never
// classified: they are counted through `skip`. Directories and other entries are not files and are not classified.
function classifyListing({ sink, skip }, dirRel, entries, scope) {
  const coded = scope === 'phase' && phaseDirForm(basename(dirRel)).form === 'coded';
  for (const e of entries) {
    const rel = `${dirRel}/${e.name}`;
    if (e.isSymbolicLink()) { skip(rel); continue; }
    if (!e.isFile()) continue;
    if (!NAME_SHAPE.test(e.name) || e.name.includes('..')) { skip(rel); continue; }
    if (sink.has(rel)) continue;
    const hit = classifyFile(e.name, { scope, coded });
    sink.set(rel, { cls: hit === null ? null : hit.class, name: e.name, coded });
  }
}

// The artifacts of one unit dir: every regular file whose name has a role, with its integer mtime; the four tier
// files are opened (see the header), nothing else. A symlink in the dir is never followed and always counted.
// -> { artifacts, filesModified } (filesModified null without a readable own PLAN or without a list in it).
function unitArtifacts({
  top, dirRel, kind, nativeId, c, paths,
}) {
  const dirAbs = join(top, dirRel);
  const entries = listDir(dirAbs, dirRel, c);
  const artifacts = [];
  let files = null;
  if (entries === null) return { artifacts, filesModified: files };
  c.classify(dirRel, entries, kind === KIND_QUICK ? 'quick' : 'phase');
  let tierFileSeen = false;
  let probesSeen = false;
  for (const e of entries) {
    const rel = `${dirRel}/${e.name}`;
    if (e.isSymbolicLink()) { c.skip(rel); continue; }
    const role = artifactRole(e.name, { kind, nativeId });
    if (role === null || !e.isFile()) continue;
    if (!NAME_SHAPE.test(e.name) || e.name.includes('..')) { c.skip(rel); continue; }
    const abs = join(dirAbs, e.name);
    let st;
    try {
      st = lstatSync(abs);
    } catch (err) {
      if (UNREADABLE.has(err?.code)) { c.skip(rel); continue; }
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') continue;
      throw err;
    }
    if (st.isSymbolicLink()) { c.skip(rel); continue; }
    if (!st.isFile()) continue;
    let letter = null;
    let place = null;
    let fmDate = null;
    const open = role === 'plan' || role === 'summary'
      || (role === 'rigor-tier' && !tierFileSeen) || (role === 'probes-skipped' && !probesSeen);
    if (open) {
      const text = headOf(abs, rel, c);
      if (text === undefined) continue;
      if (role === 'rigor-tier') {
        tierFileSeen = true;
        letter = tierFileLetter(text);
        place = 'tier-line';
      } else if (role === 'probes-skipped') {
        probesSeen = true;
        letter = probesSkippedTier(text);
        place = 'probes-line';
      } else {
        const lines = frontmatterLines(text);
        letter = tierLetter(lines);
        place = 'frontmatter';
        if (role === 'summary') fmDate = completedDate(lines);
        if (role === 'plan') {
          const listed = filesModified(lines);
          if (Array.isArray(listed)) {
            const kept = new Set();
            for (const raw of listed) {
              const n = normalizeTouchedPath(raw, paths);
              if (n.dropped || !factPathOk(n.path)) c.dropped += 1;
              else kept.add(n.path);
            }
            files = [...kept].sort(compareBytes);
          }
        }
      }
    }
    artifacts.push({
      relPath: rel,
      role,
      mtimeMs: Math.trunc(st.mtimeMs),
      tierLetter: letter,
      tierPlace: letter === null ? null : place,
      fmDate,
      fmOffsetMin: fmDate === null ? null : localMidnightOffsetMin(fmDate),
    });
  }
  return { artifacts, filesModified: files };
}

// The path context normalizeTouchedPath needs for a scanned tree.
function pathContext(top, home) {
  let topReal = null;
  try { topReal = realpathSync(top); } catch { topReal = null; }
  return {
    top, topReal, homeSet: homeSetOf(home), denyNames: ownerNamesOf(home),
  };
}

// -> true when `.planning/<sub>` of top is a real directory; a symlink or an unreadable entry on the way is counted.
function planningDirOk(top, sub, c) {
  for (const rel of ['.planning', `.planning/${sub}`]) {
    const kind = safeKind(join(top, rel));
    if (kind === 'unreadable' || kind === 'symlink') { c.skip(rel); return false; }
    if (kind !== 'dir') return false;
  }
  return true;
}

// -> { phases: [dirRel...], quick: [dirRel...] }: the archive roots of `.planning/milestones/` in natural label order
// (oldest first). A symlinked milestones dir or archive root is counted as skipped and never followed; a directory that
// is no archive root is noted under not_read_milestones_other_dir; a name outside the shape is skipped; a plain file
// (v1.0-ROADMAP.md, a generated README) is neither.
function archiveRootsOf(top, c, note) {
  const found = { phases: [], quick: [] };
  if (!planningDirOk(top, 'milestones', c)) return { phases: [], quick: [] };
  const entries = listDir(join(top, '.planning', 'milestones'), '.planning/milestones', c) ?? [];
  c.classify('.planning/milestones', entries.filter((e) => !e.isDirectory()), 'milestones');
  for (const e of entries) {
    const rel = `.planning/milestones/${e.name}`;
    if (e.isSymbolicLink()) { c.skip(rel); continue; }
    if (!e.isDirectory()) continue;
    if (!NAME_SHAPE.test(e.name) || e.name.includes('..')) { c.skip(rel); continue; }
    const kind = archiveRootKind(e.name);
    if (kind === null) { note('not_read_milestones_other_dir', rel); continue; }
    found[kind].push({ rel, label: e.name.slice(0, -(kind.length + 1)) });
  }
  const order = (list) => list.sort((a, b) => compareLabels(a.label, b.label)).map((r) => r.rel);
  return { phases: order(found.phases), quick: order(found.quick) };
}

// Workstream trees (`.planning/workstreams/<ws>/phases/<dir>/*PLAN.md`) number independently of the main tree, so reading
// them under the current key would collide ids: they are only counted (D-05), by dir and by plan file, from names alone.
// Bounded (MAX_WORKSTREAM_DIRS, MAX_WORKSTREAM_NAMES); a symlink or a name outside the shape is skipped and not followed.
function countWorkstreams(top, c, note) {
  if (!planningDirOk(top, 'workstreams', c)) return;
  const wsRoot = '.planning/workstreams';
  const listed = listDirCapped(join(top, wsRoot), wsRoot, c, MAX_WORKSTREAM_NAMES);
  if (listed === null) return;
  if (listed.more) c.skip(wsRoot);
  // The names left to read under all workstreams of this tree. A listing that stops at the budget counts its dir.
  let left = MAX_WORKSTREAM_NAMES;
  const take = (rel) => {
    const got = listDirCapped(join(top, rel), rel, c, left);
    if (got === null) return [];
    left -= got.entries.length;
    if (got.more) { c.skip(rel); left = 0; }
    return got.entries;
  };
  let dirs = 0;
  for (const e of listed.entries) {
    const wsRel = `${wsRoot}/${e.name}`;
    if (e.isSymbolicLink()) { c.skip(wsRel); continue; }
    if (!e.isDirectory()) continue;
    if (!NAME_SHAPE.test(e.name) || e.name.includes('..')) { c.skip(wsRel); continue; }
    dirs += 1;
    if (dirs > MAX_WORKSTREAM_DIRS) { c.skip(wsRel); continue; }
    note('not_read_workstream_dir', wsRel);
    if (left <= 0) { c.skip(wsRel); continue; }
    const phasesRel = `${wsRel}/phases`;
    const kind = safeKind(join(top, phasesRel));
    if (kind === 'unreadable' || kind === 'symlink') { c.skip(phasesRel); continue; }
    if (kind !== 'dir') continue;
    for (const d of take(phasesRel)) {
      const dRel = `${phasesRel}/${d.name}`;
      if (d.isSymbolicLink()) { c.skip(dRel); continue; }
      if (!d.isDirectory()) continue;
      if (!NAME_SHAPE.test(d.name) || d.name.includes('..')) { c.skip(dRel); continue; }
      if (left <= 0) { c.skip(dRel); break; }
      for (const f of take(dRel)) {
        if (!f.name.endsWith('PLAN.md')) continue;
        const rel = `${dRel}/${f.name}`;
        if (f.isSymbolicLink() || !NAME_SHAPE.test(f.name) || f.name.includes('..')) { c.skip(rel); continue; }
        if (f.isFile()) note('not_read_workstream_plan_files', rel);
      }
    }
  }
}

// known: Map native id -> stored dir_rel of the quick ids that already have a unit (empty on a first scan);
// knownPlans: the same for plan ids. home: for the files_modified normalization (HOME-relative `~/...` paths).
// -> { units: [{ kind, nativeId, dirRel, idDate, idOffsetMin, artifacts, filesModified }], quick, plan, artifacts,
// dupIds, skipped, dropped, archived, dupDirs, skippedPaths, repeatDirs, repeatIds, dupEntries, moveCandidates, notRead }: the counts of this tree,
// and the duplicate dir names and the skipped paths (relative to the tree) so a caller scanning several trees of one repo
// counts each name once. archived: the units read from an archive root. notRead: kind (layout.mjs LOCATION_KINDS) ->
// array of tree-relative paths counted under that name, only the kinds with a path. Plain rows, no I/O beyond lstat,
// readdir and the bounded heads.
export function scanRepo({
  top, known = new Map(), knownPlans = new Map(), home,
}) {
  const dupDirs = new Set();
  const skippedPaths = new Set();
  const notReadSets = new Map();
  const note = (kind, rel) => {
    if (!notReadSets.has(kind)) notReadSets.set(kind, new Set());
    const set = notReadSets.get(kind);
    if (set.size >= MAX_NOTED_PATHS && !set.has(rel)) skippedPaths.add(`.planning#more-${kind}`);
    else set.add(rel);
  };
  const classified = new Map();
  const c = {
    quick: 0, plan: 0, artifacts: 0, dropped: 0, archived: 0, skip: (rel) => skippedPaths.add(rel),
  };
  c.classify = (dirRel, entries, scope) => classifyListing({ sink: classified, skip: c.skip }, dirRel, entries, scope);
  const units = [];
  const paths = pathContext(top, home);
  const addUnit = (u) => {
    const a = unitArtifacts({
      top, dirRel: u.dirRel, kind: u.kind, nativeId: u.nativeId, c, paths,
    });
    c.artifacts += a.artifacts.length;
    if (locationOf(u.dirRel)?.cls.startsWith('archive-')) c.archived += 1;
    units.push({ ...u, artifacts: a.artifacts, filesModified: a.filesModified });
  };
  // A second dir for an id that has a chosen dir: another root means an id reused (--reset-phase-numbers) or a dir renamed
  // and archived later, which are not told apart, so it is a repeat; the same root is a duplicate. Neither is ever
  // opened or merged into the unit.
  // moveCandidates: the archive dirs of a known id that were counted as repeats (plan 03.1-02): collectUnits claims one when
  // the id's stored dir is gone from every tree. dupEntries: the second dirs of the stored root with their id, so a later move
  // can reclassify them.
  const repeats = new Map();
  const candidates = new Map();
  const dupEntries = new Map();
  const second = (kind, nativeId, chosenDir, dirRel) => {
    const key = `${kind}\0${nativeId}\0${dirRel}`;
    if (dirnameOf(chosenDir) === dirnameOf(dirRel)) {
      dupDirs.add(dirRel);
      dupEntries.set(key, { kind, nativeId, dirRel });
    } else {
      repeats.set(key, { kind, nativeId, dirRel });
      if (locationOf(dirRel)?.cls.startsWith('archive-')) {
        candidates.set(key, {
          kind, nativeId, dirRel, basename: basename(dirRel), top,
        });
      }
    }
  };
  const archive = archiveRootsOf(top, c, note);
  countWorkstreams(top, c, note);
  // The roots of a kind in read order: the archive roots oldest first, then the live root. The live root is listed only
  // when `.planning/<sub>` is a real directory (a symlink or an unreadable entry on the way is counted).
  const rootEntries = (rel, live, sub) => {
    if (live && !planningDirOk(top, sub, c)) return [];
    return listDir(join(top, rel), rel, c) ?? [];
  };
  const quickSeen = new Map();
  for (const rootRel of [...archive.quick, '.planning/quick']) {
    const entries = rootEntries(rootRel, rootRel === '.planning/quick', 'quick');
    c.classify(rootRel, entries.filter((e) => !e.isDirectory()), 'quick-root');
    for (const e of entries) {
      const dirRel = `${rootRel}/${e.name}`;
      if (e.isSymbolicLink()) { c.skip(dirRel); continue; }
      if (!e.isDirectory()) continue;
      const parsed = parseQuickId(e.name);
      if (!NAME_SHAPE.test(e.name) || e.name.includes('..')) {
        // A bad name is never read: with a quick id it is a skipped path, without one it is the no-id form (review WR-04).
        if (parsed !== null) c.skip(dirRel);
        else note('not_read_quick_dir_name', dirRel);
        continue;
      }
      if (parsed === null) { note('not_read_quick_dir_name', dirRel); continue; }
      const chosen = known.get(parsed.id) ?? quickSeen.get(parsed.id);
      if (chosen !== undefined && chosen !== dirRel) { second(KIND_QUICK, parsed.id, chosen, dirRel); continue; }
      quickSeen.set(parsed.id, dirRel);
      c.quick += 1;
      addUnit({
        kind: KIND_QUICK, nativeId: parsed.id, dirRel, idDate: parsed.date, idOffsetMin: parsed.offsetMin,
      });
    }
  }
  const planSeen = new Map();
  for (const rootRel of [...archive.phases, '.planning/phases']) {
    const dirs = rootEntries(rootRel, rootRel === '.planning/phases', 'phases');
    c.classify(rootRel, dirs.filter((d) => !d.isDirectory()), 'phases-root');
    for (const d of dirs) {
      const dirRel = `${rootRel}/${d.name}`;
      if (d.isSymbolicLink()) { c.skip(dirRel); continue; }
      if (!d.isDirectory()) continue;
      if (!NAME_SHAPE.test(d.name) || d.name.includes('..')) { c.skip(dirRel); continue; }
      const dirForm = phaseDirForm(d.name).form;
      if (dirForm === 'bracket') note('not_read_bracket_phase_dir', dirRel);
      else if (dirForm === 'custom') note('not_read_custom_phase_dir', dirRel);
      const files = listDir(join(top, dirRel), dirRel, c) ?? [];
      let readHere = 0;
      let secondHere = 0;
      for (const f of files) {
        const form = planFileForm(f.name);
        if (form === null) continue;
        const rel = `${dirRel}/${f.name}`;
        if (f.isSymbolicLink()) { c.skip(rel); continue; }
        if (!f.isFile()) continue;
        if (form !== 'plan') { note(PLAN_FORM_KIND[form], rel); continue; }
        const id = PLAN_FILE_RE.exec(f.name)[1];
        if (!dirAcceptsPlan(d.name, id)) { c.skip(rel); continue; }
        const chosen = knownPlans.get(id) ?? planSeen.get(id);
        if (chosen !== undefined && chosen !== dirRel) { second(KIND_PLAN, id, chosen, dirRel); secondHere += 1; continue; }
        planSeen.set(id, dirRel);
        c.plan += 1;
        readHere += 1;
        addUnit({
          kind: KIND_PLAN, nativeId: id, dirRel, idDate: null, idOffsetMin: null,
        });
      }
      // A standard or coded phase dir is classified unless it was only ever a second dir of an id (never opened); a dir with a
      // read unit was already classified by unitArtifacts, the call is a no-op for it.
      if ((dirForm === 'standard' || dirForm === 'coded') && (readHere > 0 || secondHere === 0)) c.classify(dirRel, files, 'phase');
    }
  }
  return {
    units,
    quick: c.quick,
    plan: c.plan,
    artifacts: c.artifacts,
    dupIds: dupDirs.size,
    skipped: skippedPaths.size,
    dropped: c.dropped,
    archived: c.archived,
    dupDirs: [...dupDirs],
    skippedPaths: [...skippedPaths],
    repeatDirs: [...new Set([...repeats.values()].map((r) => r.dirRel))],
    repeatIds: [...repeats.values()],
    dupEntries: [...dupEntries.values()],
    moveCandidates: [...candidates.values()],
    notRead: Object.fromEntries([...notReadSets].map(([kind, set]) => [kind, [...set]])),
    classified: [...classified],
  };
}

// Plan 03.1-02. The unit row of one dir, read like scanRepo reads a unit: the artifacts of the dir (a symlink and a name
// outside the shape are never followed or read, counted in skippedPaths) and the files_modified list of its own PLAN. A dir that
// is gone or unreadable has no artifacts. kind/nativeId/dirRel name the unit and the dir to read in the tree `top`.
// -> { kind, nativeId, dirRel, idDate, idOffsetMin, artifacts, filesModified, skippedPaths, dropped, classified }.
export function readUnitAt({
  top, kind, nativeId, dirRel, home,
}) {
  const skippedPaths = new Set();
  const classified = new Map();
  const c = {
    quick: 0, plan: 0, artifacts: 0, dropped: 0, archived: 0, skip: (rel) => skippedPaths.add(rel),
  };
  c.classify = (rel, entries, scope) => classifyListing({ sink: classified, skip: c.skip }, rel, entries, scope);
  const a = unitArtifacts({
    top, dirRel, kind, nativeId, c, paths: pathContext(top, home),
  });
  const parsed = kind === KIND_QUICK ? parseQuickId(basename(dirRel)) : null;
  return {
    kind,
    nativeId,
    dirRel,
    idDate: parsed?.date ?? null,
    idOffsetMin: parsed?.offsetMin ?? null,
    artifacts: a.artifacts,
    filesModified: a.filesModified,
    skippedPaths: [...skippedPaths],
    dropped: c.dropped,
    classified: [...classified],
  };
}

const UNIT_SQL = `
INSERT INTO unit_obs (unit_key, framework, repo_key, kind, native_id, dir_rel, id_date, id_offset_min, first_seen_run, last_seen_run)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (unit_key) DO UPDATE SET last_seen_run = max(unit_obs.last_seen_run, excluded.last_seen_run)`;

// mtime_ms: NULL-safe max; first_mtime_ms: NULL-safe min (review 02-05 WR-05: the start fallback reads the earliest
// mtime ever seen, the end fallback the latest); first_commit_ms: NULL-safe min; the tier letter and its place are kept
// as a pair from the first non-NULL observation; last_seen_run: the larger.
const ARTIFACT_SQL = `
INSERT INTO unit_artifact (unit_key, rel_path, role, mtime_ms, first_mtime_ms, first_commit_ms, tier_letter, tier_place,
                           first_seen_run, last_seen_run)
VALUES (?1, ?2, ?3, ?4, ?4, NULL, ?5, ?6, ?7, ?8)
ON CONFLICT (unit_key, rel_path) DO UPDATE SET
  mtime_ms = CASE WHEN unit_artifact.mtime_ms IS NULL THEN excluded.mtime_ms
                  WHEN excluded.mtime_ms IS NULL THEN unit_artifact.mtime_ms
                  ELSE max(unit_artifact.mtime_ms, excluded.mtime_ms) END,
  first_mtime_ms = CASE WHEN unit_artifact.first_mtime_ms IS NULL THEN excluded.first_mtime_ms
                        WHEN excluded.first_mtime_ms IS NULL THEN unit_artifact.first_mtime_ms
                        ELSE min(unit_artifact.first_mtime_ms, excluded.first_mtime_ms) END,
  first_commit_ms = CASE WHEN unit_artifact.first_commit_ms IS NULL THEN excluded.first_commit_ms
                         WHEN excluded.first_commit_ms IS NULL THEN unit_artifact.first_commit_ms
                         ELSE min(unit_artifact.first_commit_ms, excluded.first_commit_ms) END,
  tier_letter = CASE WHEN unit_artifact.tier_letter IS NULL THEN excluded.tier_letter ELSE unit_artifact.tier_letter END,
  tier_place = CASE WHEN unit_artifact.tier_letter IS NULL THEN excluded.tier_place ELSE unit_artifact.tier_place END,
  last_seen_run = max(unit_artifact.last_seen_run, excluded.last_seen_run)`;

// Plan 03.1-01 (D-03, J2): the location counters of a repo and run. The run must exist: ingest_count.run_id references
// ingest_run, so a wrong run id fails loudly (review WR-01) instead of losing the counters and the sentinel.
const COUNT_SQL = `
INSERT INTO ingest_count (run_id, source, kind, name, n)
VALUES (?1, 'units', ?2, ?3, ?4)
ON CONFLICT (run_id, source, kind, name) DO UPDATE SET n = excluded.n`;

const PATH_SQL = `
INSERT INTO unit_path (unit_key, rel_path, path_source, first_seen_run) VALUES (?, ?, 'files_modified', ?)
ON CONFLICT (unit_key, rel_path) DO NOTHING`;

// The SUMMARY `completed:` date and its offset: the first non-NULL pair is kept (like the tier letter and place).
const FM_DATE_SQL = `
INSERT INTO unit_artifact_time (unit_key, rel_path, fm_date, fm_offset_min) VALUES (?, ?, ?, ?)
ON CONFLICT (unit_key, rel_path) DO UPDATE SET
  fm_date = CASE WHEN unit_artifact_time.fm_date IS NULL THEN excluded.fm_date ELSE unit_artifact_time.fm_date END,
  fm_offset_min = CASE WHEN unit_artifact_time.fm_date IS NULL THEN excluded.fm_offset_min ELSE unit_artifact_time.fm_offset_min END`;

// The artifacts a unit already has stored under an archive dir: a move recorded by an earlier run (moved counts new moves).
const RECORDED_SQL = 'SELECT 1 AS n FROM unit_artifact WHERE unit_key = ?1 AND substr(rel_path, 1, length(?2)) = ?2 LIMIT 1';

// Plan 03.1-02 (D-02, D-18). After every tree of a repo is scanned, reads the archived location of each known id whose
// stored dir is gone. stored: { quick, plan } -> Map native id -> stored dir_rel, as it was before this run's scan; units, repeats
// (unit key -> Set of dirs), dupDirs, dupEntries (key -> { kind, nativeId, dirRel }) and skippedPaths are the repo's merged
// scan results and are updated in place. A unit already read in some tree is case a (stored dir present); a stored dir that
// still exists on disk in any tree (even without a readable unit) is case a too, and an unreadable one counts as present.
// -> { moved, ambiguous }: moved counts the moves seen for the first time (no artifact stored under that archive dir yet).
function resolveMoves({
  repoKey, trees, home, stored, units, repeats, dupDirs, dupEntries, candidates, skippedPaths, recorded, classified,
}) {
  let moved = 0;
  let ambiguous = 0;
  for (const kind of [KIND_QUICK, KIND_PLAN]) {
    for (const [nativeId, storedDir] of stored[kind]) {
      const mapKey = `${kind}:${nativeId}`;
      if (units.has(mapKey)) continue;
      // GSD only moves live -> archive (review CR-01): a stored archive dir (or any dir outside the live roots) is never a move source.
      if (locationOf(storedDir)?.cls !== 'live') continue;
      const mine = candidates.filter((c) => c.kind === kind && c.nativeId === nativeId);
      if (mine.length === 0) continue;
      if (trees.some((top) => safeKind(join(top, storedDir)) !== 'missing')) continue;
      // A candidate is a move target only when its former live path (archive prefix rewritten) is the stored dir.
      const dirs = [...new Set(mine.filter((c) => formerLivePath(c.dirRel) === storedDir).map((c) => c.dirRel))].sort(compareBytes);
      if (dirs.length === 0) continue;
      // Several archive dirs of the former live path (review CR-02): the one that already holds rows of this unit is its recorded
      // move; the others stay repeats. With none or several holding rows the id is ambiguous and nothing is adopted.
      const unitKey = unitKeyOf(repoKey, kind, nativeId);
      if (dirs.length > 1) {
        const held = dirs.filter((d) => recorded(unitKey, d));
        if (held.length !== 1) { ambiguous += 1; continue; }
        dirs.splice(0, dirs.length, held[0]);
      }
      const [dirRel] = dirs;
      let unit = null;
      for (const c of mine.filter((x) => x.dirRel === dirRel)) {
        const u = readUnitAt({
          top: c.top, kind, nativeId, dirRel, home,
        });
        for (const p of u.skippedPaths) skippedPaths.add(p);
        // The moved dir was only a repeat while the trees were scanned, so nothing classified its files yet (plan 03.1-04).
        for (const [rel, v] of u.classified) if (!classified.has(rel)) classified.set(rel, v);
        if (unit === null) {
          unit = u;
        } else {
          unit.artifacts.push(...u.artifacts);
          if (u.filesModified) unit.filesModified = [...new Set([...(unit.filesModified ?? []), ...u.filesModified])].sort(compareBytes);
        }
      }
      units.set(mapKey, unit);
      const set = repeats.get(unitKey);
      if (set) {
        set.delete(dirRel);
        if (set.size === 0) repeats.delete(unitKey);
      }
      // A second dir of the id in another root than the moved dir is a repeat relative to it, not a duplicate.
      for (const [key, e] of [...dupEntries]) {
        if (e.kind !== kind || e.nativeId !== nativeId || dirnameOf(e.dirRel) === dirnameOf(dirRel)) continue;
        dupEntries.delete(key);
        if (![...dupEntries.values()].some((x) => x.dirRel === e.dirRel)) dupDirs.delete(e.dirRel);
        if (!repeats.has(unitKey)) repeats.set(unitKey, new Set());
        repeats.get(unitKey).add(e.dirRel);
      }
      if (!recorded(unitKey, dirRel)) moved += 1;
    }
  }
  return { moved, ambiguous };
}

// Every tree of a repo to scan: the live working trees git lists (plan 02-05), or the main working tree alone when
// the list call fails (the 02-02 behaviour). -> { trees: [absolute dirs], dropped }: dropped counts the listed trees
// not scanned (bare, prunable, missing or not a directory, or past MAX_TREES_PER_REPO; review WR-04), 0 when the list
// call failed.
function treesToScan(repoKey, home, run) {
  const listed = treesOf({ repoKey, home, run });
  if (listed !== null) return { trees: listed.trees, dropped: listed.dropped };
  const top = mainTreeOf(repoKey, home);
  return { trees: top === null ? [] : [top], dropped: 0 };
}

// The ingest post-step's second half. For each repo it scans every live working tree with no transaction open (the
// stored dir of each id, extended by the trees scanned before, decides which dir a tree reads), merges the units of
// all trees on their natural keys, then writes the units, artifacts, files_modified paths and SUMMARY dates in one
// BEGIN IMMEDIATE and awaits checkpoint() between repos. quick, plan, dup_ids, skipped and artifacts count distinct
// ids, dir names, paths and artifact rows per repo, so a tree that mirrors another adds nothing. run: the git runner
// for the worktree list (a test seam). -> { repos, scanned, quick, plan, artifacts, dupIds, skipped, trees,
// treesDropped, locations, locationsRepos, classes, classesRepos } (treesDropped: the listed trees not scanned, review WR-04).
//
// Plan 03.1-01 (D-03): in the same transaction as the units of a scanned repo it writes the ingest_count rows of source
// `units`: one sentinel row (kind trees_scanned, name the repo key, n the trees scanned) and one row per location counter
// with n > 0 (kind a LOCATION_KINDS name, name the repo key). A repo without the sentinel for its latest run is unknown,
// never zero. locations is the sum of each counter over the repos scanned in this run (null when none was: every counter
// then reads unknown), locationsRepos the number of those repos.
export async function collectUnits({
  db, home, runId, checkpoint = async () => {}, run = defaultGitRun,
}) {
  const out = {
    repos: 0, scanned: 0, quick: 0, plan: 0, artifacts: 0, dupIds: 0, skipped: 0, trees: 0, treesDropped: 0,
    locations: null, locationsRepos: 0, classes: null, classesRepos: 0,
  };
  const totals = Object.fromEntries(shownKinds().map((k) => [k, 0]));
  // Plan 03.1-04. The class counts over the repos scanned in this run, and the unclassified stems of the run (stem -> files of
  // the stems that passed safeStem, and the files whose stem did not).
  const classTotals = Object.fromEntries(REPO_CLASS_KINDS.map((k) => [k, 0]));
  const stemTally = new Map();
  let stemRejected = 0;
  const denyNames = ownerNamesOf(home);
  const repos = db.prepare('SELECT repo_key FROM repo ORDER BY repo_key').all().map((r) => r.repo_key);
  out.repos = repos.length;
  const upUnit = db.prepare(UNIT_SQL);
  const upArtifact = db.prepare(ARTIFACT_SQL);
  const insPath = db.prepare(PATH_SQL);
  const upFmDate = db.prepare(FM_DATE_SQL);
  let insCount = null;
  const scanned = db.prepare('UPDATE repo SET last_scanned_run = ? WHERE repo_key = ?');
  const recordedStmt = db.prepare(RECORDED_SQL);
  const recorded = (unitKey, dirRel) => recordedStmt.get(unitKey, `${dirRel}/`) !== undefined;
  const knownOf = db.prepare('SELECT native_id, dir_rel FROM unit_obs WHERE framework = ? AND repo_key = ? AND kind = ?');
  const knownMap = (repoKey, kind) => new Map(knownOf.all(FRAMEWORK, repoKey, kind).map((r) => [r.native_id, r.dir_rel]));
  for (const repoKey of repos) {
    const listed = treesToScan(repoKey, home, run);
    out.treesDropped += listed.dropped;
    const { trees } = listed;
    if (trees.length === 0) continue;
    const known = knownMap(repoKey, KIND_QUICK);
    const knownPlans = knownMap(repoKey, KIND_PLAN);
    // The stored dirs before this run's scan: known and knownPlans grow as trees are read, the move rule needs the stored ones.
    const stored = { [KIND_QUICK]: new Map(known), [KIND_PLAN]: new Map(knownPlans) };
    const units = new Map();
    const dupDirs = new Set();
    const dupEntries = new Map();
    const candidates = [];
    const skippedPaths = new Set();
    const notRead = new Map();
    const repeats = new Map();
    const classified = new Map();
    for (const top of trees) {
      const res = scanRepo({
        top, known, knownPlans, home,
      });
      for (const u of res.units) {
        const k = `${u.kind}:${u.nativeId}`;
        const prev = units.get(k);
        if (prev) {
          prev.artifacts.push(...u.artifacts);
          if (u.filesModified) prev.filesModified = [...new Set([...(prev.filesModified ?? []), ...u.filesModified])].sort(compareBytes);
        } else {
          units.set(k, { ...u, artifacts: [...u.artifacts] });
          (u.kind === KIND_QUICK ? known : knownPlans).set(u.nativeId, u.dirRel);
        }
      }
      for (const [rel, v] of res.classified) if (!classified.has(rel)) classified.set(rel, v);
      for (const d of res.dupDirs) dupDirs.add(d);
      for (const e of res.dupEntries) dupEntries.set(`${e.kind}\0${e.nativeId}\0${e.dirRel}`, e);
      candidates.push(...res.moveCandidates);
      for (const p of res.skippedPaths) skippedPaths.add(p);
      for (const r of res.repeatIds) {
        const key = unitKeyOf(repoKey, r.kind, r.nativeId);
        if (!repeats.has(key)) repeats.set(key, new Set());
        repeats.get(key).add(r.dirRel);
      }
      for (const [kind, list] of Object.entries(res.notRead)) {
        if (!notRead.has(kind)) notRead.set(kind, new Set());
        for (const p of list) notRead.get(kind).add(p);
      }
    }
    const { moved, ambiguous } = resolveMoves({
      repoKey, trees, home, stored, units, repeats, dupDirs, dupEntries, candidates, skippedPaths, recorded, classified,
    });
    const classCounts = Object.fromEntries(REPO_CLASS_KINDS.map((k) => [k, 0]));
    for (const v of classified.values()) {
      if (v.cls === null) {
        classCounts.unclassified += 1;
        const stem = safeStem(v.name, denyNames, { coded: v.coded === true });
        if (stem === null) stemRejected += 1;
        else stemTally.set(stem, (stemTally.get(stem) ?? 0) + 1);
      } else if (Object.hasOwn(KIND_OF_CLASS, v.cls)) {
        classCounts[KIND_OF_CLASS[v.cls]] += 1;
      }
    }
    const counts = new Map();
    for (const [kind, set] of notRead) counts.set(kind, set.size);
    if (moved > 0) counts.set('moved', moved);
    if (ambiguous > 0) counts.set('move_ambiguous', ambiguous);
    const archived = [...units.values()].filter((u) => locationOf(u.dirRel)?.cls.startsWith('archive-')).length;
    if (archived > 0) counts.set('units_archived', archived);
    const repeatTotal = [...repeats.values()].reduce((n, set) => n + set.size, 0);
    if (repeatTotal > 0) counts.set('repeat_id', repeatTotal);
    out.scanned += 1;
    out.trees += trees.length;
    out.dupIds += dupDirs.size;
    out.skipped += skippedPaths.size;
    for (const u of units.values()) {
      if (u.kind === KIND_QUICK) out.quick += 1;
      else out.plan += 1;
      out.artifacts += new Set(u.artifacts.map((a) => a.relPath)).size;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const u of units.values()) {
        const unitKey = unitKeyOf(repoKey, u.kind, u.nativeId);
        upUnit.run(unitKey, FRAMEWORK, repoKey, u.kind, u.nativeId, u.dirRel, u.idDate, u.idOffsetMin, runId, runId);
        for (const a of u.artifacts) {
          upArtifact.run(unitKey, a.relPath, a.role, a.mtimeMs, a.tierLetter, a.tierPlace, runId, runId);
          if (a.fmDate !== null && a.fmOffsetMin !== null) upFmDate.run(unitKey, a.relPath, a.fmDate, a.fmOffsetMin);
        }
        for (const p of u.filesModified ?? []) insPath.run(unitKey, p, runId);
      }
      insCount ??= db.prepare(COUNT_SQL);
      insCount.run(runId, SENTINEL_KIND, repoKey, trees.length);
      // The class rows are written even at 0: their presence is what tells a run that classified from a run of an earlier
      // release (a sentinel with no class rows), which is unknown, never zero.
      for (const kind of REPO_CLASS_KINDS) insCount.run(runId, kind, repoKey, classCounts[kind]);
      for (const kind of LOCATION_KINDS) {
        const n = counts.get(kind) ?? 0;
        if (kind === SENTINEL_KIND || n === 0) continue;
        if (kind === 'repeat_id') for (const [unitKey, set] of repeats) insCount.run(runId, kind, unitKey, set.size);
        else insCount.run(runId, kind, repoKey, n);
      }
      scanned.run(runId, repoKey);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
      throw err;
    }
    for (const [kind, n] of counts) if (kind in totals) totals[kind] += n;
    for (const kind of REPO_CLASS_KINDS) classTotals[kind] += classCounts[kind];
    await checkpoint();
  }
  if (out.scanned > 0) {
    out.locations = totals;
    out.locationsRepos = out.scanned;
    out.classes = classTotals;
    out.classesRepos = out.scanned;
    // The run-level stem rows, written once after every repo, always through safeStem and pickStems: listed stems plus the
    // remainder row equal the run's unclassified total. The remainder row is written even at 0 (it marks the run as classified).
    const picked = pickStems(stemTally, stemRejected);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const s of picked.listed) insCount.run(runId, STEM_KIND, s.stem, s.n);
      insCount.run(runId, STEM_OTHER_KIND, '*', picked.other);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
      throw err;
    }
  }
  return out;
}
