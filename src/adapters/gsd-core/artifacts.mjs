// The planning artifacts of a gsd-core unit (plan 02-05, ADPT-01, UNIT-05, D-10): which files of a unit's directory
// are artifacts, and of which role. Pure: a role comes from the file name only, never from the file's content.
//
// The ten roles are the set of migration 007's unit_artifact CHECK, in its order. A name maps to at most one role
// through ARTIFACT_RULES:
//   plan            `<id>-PLAN.md`                      summary         `<id>-SUMMARY.md`
//   context         `<id>-CONTEXT.md`                   verification    `<id>-VERIFICATION.md`
//   review          `<id>-REVIEW.md`, `<id>-REVIEW-<n>.md`, `<id>-REVIEW-R<n>.md`
//   windows         `<id>-WINDOWS.md`
//   rigor-tier      `RIGOR-TIER.md` or `RIGOR-TIERS.txt` (02-03's TIER_FILE_RE; quick units only)
//   probes-skipped  `<anything>-PROBES-SKIPPED.md` (02-03's PROBES_FILE_RE; quick units only)
//   probe           `<id>-EDGE-REQS.json`, `-EDGE-RESOLUTIONS.json`, `-EDGES.json`, `-PROHIBITIONS.json`,
//                   `-UI-CONSIDERATIONS.json`, `-PROBE-GATE.json`
//   refute-pass     `<id>-REFUTE.md`, `<id>-REFUTE-<n>.md`, `<id>-REFUTE-GATE.json`, `<id>-CLAIMS.json`
// Every other name (RESEARCH, PATTERNS, VALIDATION, RED and log files, notes) is not an artifact. A quick unit owns the
// files of its quick dir. A phase plan `NN-MM` owns the files of its phase dir whose name starts with its own id and a
// dash; a file whose name starts with the phase part and a dash and whose rest is in PHASE_LEVEL_SUFFIXES (CONTEXT,
// VERIFICATION, a review name, WINDOWS) is a phase-level artifact of every plan unit of that dir; another plan's
// id-prefixed file never is (its rest begins with that plan's number, which no suffix matches).
//
// What the adapter opens (src/adapters/gsd-core/index.mjs): the unit's own `<id>-PLAN.md` (tier letter and
// files_modified) and `<id>-SUMMARY.md` (tier letter and the top-level `completed:` date), and for a quick unit the
// bytewise-first rigor-tier file and the bytewise-first probes-skipped file (tier letter), each through a bounded head
// read. Every other artifact is lstat-ed for its mtime only.
//
// The signals module is imported for its two file-name patterns only, and they are read inside functions, never at
// module evaluation (signals.mjs imports index.mjs, which imports this module).
import { PROBES_FILE_RE, TIER_FILE_RE } from './signals.mjs';

export const ARTIFACT_ROLES = Object.freeze([
  'plan', 'summary', 'context', 'verification', 'review', 'windows', 'rigor-tier', 'probes-skipped', 'probe', 'refute-pass',
]);

// A phase plan file: `<phase>-<plan>-PLAN.md`, the phase two or three digits with an optional `.N` decimal part and
// the plan two or three digits (the id shape 02-03's collector accepts, so every plan unit can be asked to git).
export const PLAN_FILE_RE = /^(\d{2,3}(?:\.\d{1,3})?-\d{2,3})-PLAN\.md$/;

const REVIEW_RE = /^REVIEW(?:-R?\d{1,4})?\.md$/;
const PROBE_RE = /^(?:EDGE-REQS|EDGE-RESOLUTIONS|EDGES|PROHIBITIONS|UI-CONSIDERATIONS|PROBE-GATE)\.json$/;
const REFUTE_RE = /^(?:REFUTE(?:-\d{1,4})?\.md|REFUTE-GATE\.json|CLAIMS\.json)$/;

// rest: the name after `<id>-` (or the whole name for a `whole` rule, quick units only).
export const ARTIFACT_RULES = Object.freeze([
  Object.freeze({ role: 'plan', suffix: 'PLAN.md' }),
  Object.freeze({ role: 'summary', suffix: 'SUMMARY.md' }),
  Object.freeze({ role: 'context', suffix: 'CONTEXT.md' }),
  Object.freeze({ role: 'verification', suffix: 'VERIFICATION.md' }),
  Object.freeze({ role: 'review', re: REVIEW_RE }),
  Object.freeze({ role: 'windows', suffix: 'WINDOWS.md' }),
  Object.freeze({ role: 'rigor-tier', whole: (name) => TIER_FILE_RE.test(name) }),
  Object.freeze({ role: 'probes-skipped', whole: (name) => PROBES_FILE_RE.test(name) }),
  Object.freeze({ role: 'probe', re: PROBE_RE }),
  Object.freeze({ role: 'refute-pass', re: REFUTE_RE }),
]);

// The rests after `<phase part>-` that make a phase-level artifact of every plan unit of the dir.
export const PHASE_LEVEL_SUFFIXES = Object.freeze([
  Object.freeze({ role: 'context', suffix: 'CONTEXT.md' }),
  Object.freeze({ role: 'verification', suffix: 'VERIFICATION.md' }),
  Object.freeze({ role: 'review', re: REVIEW_RE }),
  Object.freeze({ role: 'windows', suffix: 'WINDOWS.md' }),
]);

// The phase part of a plan id: everything before the last dash (`03` for `03-01`, `02.1` for `02.1-01`).
export function phasePartOf(id) {
  if (typeof id !== 'string') return null;
  const at = id.lastIndexOf('-');
  return at > 0 ? id.slice(0, at) : null;
}

function restRole(rules, rest) {
  for (const r of rules) {
    if (r.whole) continue;
    if (r.suffix !== undefined ? rest === r.suffix : r.re.test(rest)) return r.role;
  }
  return null;
}

// fileName: a plain file name of the unit's directory. -> one of ARTIFACT_ROLES or null.
export function artifactRole(fileName, { kind, nativeId } = {}) {
  if (typeof fileName !== 'string' || typeof nativeId !== 'string' || nativeId === '') return null;
  if (kind === 'quick') {
    for (const r of ARTIFACT_RULES) if (r.whole && r.whole(fileName)) return r.role;
  } else if (kind !== 'plan') {
    return null;
  }
  const own = `${nativeId}-`;
  if (fileName.startsWith(own)) return restRole(ARTIFACT_RULES, fileName.slice(own.length));
  if (kind === 'plan') {
    const phase = phasePartOf(nativeId);
    if (phase !== null && fileName.startsWith(`${phase}-`)) return restRole(PHASE_LEVEL_SUFFIXES, fileName.slice(phase.length + 1));
  }
  return null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMPLETED_RE = /^completed:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/;

// -> [y, m, d] of a real calendar date `YYYY-MM-DD`, or null.
function calendarDate(text) {
  const m = typeof text === 'string' ? DATE_RE.exec(text) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return [y, mo, d];
}

// lines: the frontmatter lines of a SUMMARY (frontmatterLines). -> the date text of the first top-level line starting
// `completed:` when its whole value is a real `YYYY-MM-DD` date (optionally quoted), else null.
export function completedDate(lines) {
  if (!Array.isArray(lines)) return null;
  const line = lines.find((l) => typeof l === 'string' && l.startsWith('completed:'));
  if (line === undefined) return null;
  const m = COMPLETED_RE.exec(line.replace(/\r$/, ''));
  return m && calendarDate(m[1]) ? m[1] : null;
}

// -> the UTC offset in minutes of the local midnight of a `YYYY-MM-DD` date in the zone of this process (the value
// that puts that midnight at the day's first instant, where DST starts at midnight: review 02-02 WR-02), or null for
// an impossible date. Local midnight in epoch ms is Date.UTC(y, m - 1, d) - offset * 60000. Never a zone name.
export function localMidnightOffsetMin(dateText) {
  const ymd = calendarDate(dateText);
  if (ymd === null) return null;
  const [y, m, d] = ymd;
  const local = new Date(y, m - 1, d);
  return ((Date.UTC(y, m - 1, d) - local.getTime()) / 60000) || 0;
}

// The fact-path CHECK of migration 007 (plan 02-05): 1 to 512 characters (0 allowed for a module dir), no leading
// `/`, no `..` segment, no control character. A value outside it is dropped and counted before any insert.
const CONTROL = /[\u0000-\u001f\u007f]/;
export function factPathOk(p, { allowEmpty = false } = {}) {
  if (typeof p !== 'string' || p.length > 512 || (p.length === 0 && !allowEmpty) || p.startsWith('/')) return false;
  if (CONTROL.test(p)) return false;
  return !p.split('/').some((seg) => seg === '..');
}
