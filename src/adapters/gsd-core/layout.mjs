// The stock gsd-core `.planning/` layout rules (plan 03.1-01, ADPT-05, D-04, D-05, D-06): which directories hold units,
// how archive roots are named and ordered, and the closed list of location counters. Pure: no I/O, no import that
// reads the file system. The adapter (index.mjs) applies these rules to a working tree.
//
// Locations (stock gsd-core, researched in 03.1-RESEARCH.md Q6):
//   live      `.planning/phases/<dir>` and `.planning/quick/<dir>`
//   archive   `.planning/milestones/<label>-phases/<dir>` (/gsd-complete-milestone, default on) and
//             `.planning/milestones/<label>-quick/<dir>` (opt-in), where `<label>` is the writer's grammar LABEL_RE
// A dir's class (`live`, `archive-phases`, `archive-quick`) and root are computed from its stored `dir_rel` by locationOf;
// nothing is stored for them (no column, no migration, D-18).
//
// Names are checked against the shapes of gsd-core's writers (research Q5): a phases-root directory is `<phase>-<slug>`
// (standard), `<CODE>-<phase>-<slug>` with a project_code (coded), `<CODE>.<digits>-<phase>-<slug>` (the bracket form,
// not read), or anything else (custom, not read); a plan file is `<phase>-<plan>-PLAN.md` (read) or one of the forms
// planFileForm names (counted, never guessed into a unit).
//
// This module is imported by index.mjs, signals.mjs and facts.mjs, which import each other, so any symbol it takes from
// another module is read inside a function, never at module evaluation.

import { PLAN_FILE_RE } from './artifacts.mjs';

// The label grammar of the writer (gsd-core src/milestone.cts:85): at most 64 characters, starting with a letter or digit.
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The planning dirs every git log of the adapter asks about (plan 03.1-03, D-07): the first-add index and the tier-line log
// (signals.mjs) and the last-change log (facts.mjs) share this one frozen list. `.planning/milestones` is in it so an
// archive move is visible to git; the times of an archived artifact are still read through formerLivePath, never from the
// archive path itself. No rename option is added anywhere (the rename-aware todo stays open).
export const PLANNING_PATHSPECS = Object.freeze(['.planning/quick', '.planning/phases', '.planning/milestones']);

const ARCHIVE_SUFFIXES = Object.freeze([['-phases', 'phases'], ['-quick', 'quick']]);

// name: an entry name under `.planning/milestones/`. -> 'phases' | 'quick' when it is `<label>-phases` or
// `<label>-quick` with a label of the writer's grammar, else null (a sibling, a file such as `v1.0-ROADMAP.md`, an empty
// or over-long label).
export function archiveRootKind(name) {
  if (typeof name !== 'string') return null;
  for (const [suffix, kind] of ARCHIVE_SUFFIXES) {
    if (name.endsWith(suffix) && LABEL_RE.test(name.slice(0, -suffix.length))) return kind;
  }
  return null;
}

const chunksOf = (s) => s.match(/\d+|\D+/g) ?? [];
const isDigits = (s) => s.charCodeAt(0) >= 48 && s.charCodeAt(0) <= 57;
const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// Natural order of two labels: digit runs compare by value (v1.2 before v1.10, 3.1 before v10), other text bytewise; two
// distinct labels never compare equal (a padded run, `v01`, sorts before `v1`), so the order is total and stable.
export function compareLabels(a, b) {
  const ca = chunksOf(a);
  const cb = chunksOf(b);
  for (let i = 0; i < Math.min(ca.length, cb.length); i += 1) {
    const x = ca[i];
    const y = cb[i];
    if (isDigits(x) && isDigits(y)) {
      const xs = x.replace(/^0+(?=\d)/, '');
      const ys = y.replace(/^0+(?=\d)/, '');
      if (xs.length !== ys.length) return xs.length < ys.length ? -1 : 1;
      const c = cmpBytes(xs, ys);
      if (c !== 0) return c;
    } else {
      const c = cmpBytes(x, y);
      if (c !== 0) return c;
    }
  }
  if (ca.length !== cb.length) return ca.length < cb.length ? -1 : 1;
  return cmpBytes(a, b);
}

// dirRel: a unit's `dir_rel`. -> { cls: 'live' | 'archive-phases' | 'archive-quick', root, label } (label null for a
// live dir) when it is exactly one directory below a live or archive root, else null.
export function locationOf(dirRel) {
  if (typeof dirRel !== 'string') return null;
  const parts = dirRel.split('/');
  if (parts[0] !== '.planning') return null;
  if (parts.length === 3 && (parts[1] === 'phases' || parts[1] === 'quick') && parts[2] !== '') {
    return { cls: 'live', root: `.planning/${parts[1]}`, label: null };
  }
  if (parts.length === 4 && parts[1] === 'milestones' && parts[3] !== '') {
    const kind = archiveRootKind(parts[2]);
    if (kind === null) return null;
    return {
      cls: `archive-${kind}`,
      root: `.planning/milestones/${parts[2]}`,
      label: parts[2].slice(0, -(kind.length + 1)),
    };
  }
  return null;
}

// rel: a repo-relative path. -> the path a file under an archive root had before its dir was archived
// (`.planning/milestones/<label>-phases/<rest>` -> `.planning/phases/<rest>`, `-quick` -> `.planning/quick/<rest>`), else the
// path unchanged. A pure rewrite of two path shapes, no rename detection (plan 03.1-02, D-02, D-19): the label is the
// writer's grammar (archiveRootKind), `<rest>` must be non-empty and have no empty, `.` or `..` segment, and anything else
// (a milestone-level file, a sibling dir, an over-long label, a live path) comes back as it was.
export function formerLivePath(rel) {
  if (typeof rel !== 'string') return rel;
  const parts = rel.split('/');
  if (parts.length < 4 || parts[0] !== '.planning' || parts[1] !== 'milestones') return rel;
  const kind = archiveRootKind(parts[2]);
  if (kind === null) return rel;
  const rest = parts.slice(3);
  if (rest.some((p) => p === '' || p === '.' || p === '..')) return rel;
  return ['.planning', kind, ...rest].join('/');
}

// dirRel: a unit's dir path. -> its canonical form: the same rewrite as formerLivePath. Two dirs name the same unit location
// when their canonical forms are equal; a live dir is its own canonical form.
export const canonicalDir = (dirRel) => formerLivePath(dirRel);

// dirRel: a unit's stored `dir_rel` or null. -> canonicalDir, null-safe (the dir that session refs and git lookups use).
export const linkDirOf = (dirRel) => (typeof dirRel === 'string' ? canonicalDir(dirRel) : null);

// A phase part in a directory name: two or three digits with an optional `.N` decimal part (the plan id shape of
// PLAN_FILE_RE), and after a project_code the padded two-digit part.
const PHASE_PART_RE = /^\d{2,3}(?:\.\d{1,3})?-/;
const CODED_PART_RE = /^\d{2}(?:\.\d{1,3})?-/;
const CODE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
const MAX_CODE = 32;

// name: a child of `.planning/phases` (or an archive phases root). -> { form: 'standard' | 'coded' | 'bracket' | 'custom',
// code } (code null unless coded or bracket). A code is the shortest dash-delimited prefix of up to 32 characters that
// starts with a letter and is followed by a padded phase part and a dash; a code that ends in `.` plus digits
// (`GSD.02`) is the bracket form.
export function phaseDirForm(name) {
  if (typeof name !== 'string') return { form: 'custom', code: null };
  if (PHASE_PART_RE.test(name)) return { form: 'standard', code: null };
  for (let at = name.indexOf('-'); at > 0 && at <= MAX_CODE; at = name.indexOf('-', at + 1)) {
    const code = name.slice(0, at);
    if (CODE_RE.test(code) && CODED_PART_RE.test(name.slice(at + 1))) {
      return { form: /\.\d+$/.test(code) ? 'bracket' : 'coded', code };
    }
  }
  return { form: 'custom', code: null };
}

// -> true when a plan with this id (`NN-MM`) belongs in a directory of this name: the name starts with the plan's phase
// part and a dash, or is a coded name whose part after the code does. The bracket and custom forms accept nothing.
export function dirAcceptsPlan(dirName, planId) {
  if (typeof dirName !== 'string' || typeof planId !== 'string') return false;
  const at = planId.lastIndexOf('-');
  if (at <= 0) return false;
  const want = `${planId.slice(0, at)}-`;
  if (dirName.startsWith(want)) return true;
  const form = phaseDirForm(dirName);
  return form.form === 'coded' && dirName.slice(form.code.length + 1).startsWith(want);
}

const ID1_RE = /^\d{1,3}(?:\.\d{1,3})?-PLAN\.md$/;
const ID3_RE = /^\d{1,3}(?:\.\d{1,3})?-\d{1,3}-\d{1,3}-PLAN\.md$/;
const CODED_PLAN_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,31}-\d{2,3}(?:\.\d{1,3})?-\d{2,3}-PLAN\.md$/;

// fileName: a plain file name. -> null when it does not end in PLAN.md; else 'plan' (`NN-MM-PLAN.md`, the only readable
// form), 'bare' (`PLAN.md`), 'id1' (`NN-PLAN.md`, `N.N-PLAN.md`), 'id3' (`NN-MM-KK-PLAN.md`), 'coded' (`ABC-04-01-PLAN.md`)
// or 'other' (any other name ending PLAN.md). Every PLAN-named file lands in exactly one form, so none drops silently.
export function planFileForm(fileName) {
  if (typeof fileName !== 'string' || !fileName.endsWith('PLAN.md')) return null;
  if (PLAN_FILE_RE.test(fileName)) return 'plan';
  if (fileName === 'PLAN.md') return 'bare';
  if (ID1_RE.test(fileName)) return 'id1';
  if (ID3_RE.test(fileName)) return 'id3';
  if (CODED_PLAN_RE.test(fileName)) return 'coded';
  return 'other';
}

// The location counters, a frozen closed list: the order is the order of the `locations:` ingest line and of the docs
// (hyrums-law: the names are contracts). Every kind but trees_scanned is a counter shown on the line; trees_scanned is the
// per-repo sentinel row that tells a zero (sentinel present, no row) from an unknown (no sentinel).
export const LOCATION_KINDS = Object.freeze([
  'units_archived',
  'repeat_id',
  'moved',
  'move_ambiguous',
  'not_read_workstream_dir',
  'not_read_workstream_plan_files',
  'not_read_bare_plan',
  'not_read_plan_id_1seg',
  'not_read_plan_id_3seg',
  'not_read_plan_file_other',
  'not_read_plan_file_coded',
  'not_read_bracket_phase_dir',
  'not_read_custom_phase_dir',
  'not_read_quick_dir_name',
  'not_read_milestones_other_dir',
  'trees_scanned',
]);
export const SENTINEL_KIND = 'trees_scanned';

// kinds: a test seam (the list the line is built from).
export const shownKinds = (kinds = LOCATION_KINDS) => kinds.filter((k) => k !== SENTINEL_KIND);

// locations: kind -> count over the scanned repos, or null when no repo was scanned (every counter then prints `?`: an
// unknown is never shown as zero). repos: the number of repos scanned. -> the `locations:` ingest line, no newline.
export function locationsLine(locations, repos, kinds = LOCATION_KINDS) {
  const fields = shownKinds(kinds).map((k) => `${k}=${locations === null || locations === undefined ? '?' : (locations[k] ?? 0)}`);
  return `locations: repos=${repos} ${fields.join(' ')}`;
}
