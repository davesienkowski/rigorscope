// The gsd-core artifact roster and its name-only classifier (plan 03.1-04, ADPT-04, D-08, D-21).
//
// roster.json is the one data file the adapter and the drift check both read. It records the gsd-core ref it was taken from
// and, per artifact, a name pattern, a class and a source cite. The roster is a snapshot at a ref and is not proven complete
// (src/adapters/gsd-core/ROSTER-PROVENANCE.md): a name that matches no entry is counted `unclassified` and worded "not in the
// roster at ref X", never as a score.
//
// Classes (the roster document's): F finding-bearing, E step evidence, S state or scratch, O outside the scanned planning
// locations. Scopes name the listing a name is looked up in: `phase` and `quick` (the files of a unit dir), `phases-root` and
// `quick-root` (loose files in a root), `milestones` (files directly in `.planning/milestones`), and `root` (project-root
// state files, which rigorscope never lists). An entry given as a path glob classifies no file by name. Class O entries and
// path globs have no scopes and never match a scanned name; `notLookedFor()` returns them, grouped by reason, from the shipped
// roster.
//
// A name is classified by its text only (no file is opened). It is normalized by stripping, in this order and each only when
// its full shape matches: a leading quick id (`YYMMDD-xxx-`), then a leading project code only when the caller says the file
// lives in a coded phase dir (`coded: true`, whose name already carries the code) and a phase or plan id follows it, then a
// leading phase or plan id (`NN-`, `NN.N-`, `NN-MM-`). Anywhere else a leading word before an id is part of the name, so a
// copy such as `old-03-REVIEW.md` is not taken for a REVIEW (WR-04). The remainder is looked up by stem and extension, or by
// a roster regex over the part before the extension.
//
// Pure: no import. The owner words to keep out of a stem are passed in (adapter signals.mjs ownerNamesOf), so this module is
// safe to import from the report layer and from the adapter alike.
import { readFileSync } from 'node:fs';

export const SCOPES = Object.freeze(['phase', 'quick', 'phases-root', 'quick-root', 'milestones', 'root']);
export const CLASSES = Object.freeze(['F', 'E', 'S', 'O']);
export const ROSTER_ERROR = 'roster.json is invalid';

// The persisted counter kinds, a frozen ordered list (hyrums-law: the names are contracts). The first four are per repo (name
// = the repo key); the last two are run level (name = a stem, or `*` for the remainder).
export const STEM_KIND = 'unclassified_stem';
export const STEM_OTHER_KIND = 'unclassified_stem_other';
export const REPO_CLASS_KINDS = Object.freeze(['recognized_f', 'recognized_e', 'recognized_s', 'unclassified']);
export const CLASS_KINDS = Object.freeze([...REPO_CLASS_KINDS, STEM_KIND, STEM_OTHER_KIND]);
export const KIND_OF_CLASS = Object.freeze({ F: 'recognized_f', E: 'recognized_e', S: 'recognized_s' });
export const STEM_MAX = 50;

export class RosterError extends Error {
  constructor(reason) {
    super(ROSTER_ERROR);
    this.name = 'RosterError';
    this.code = 'roster_invalid';
    this.reason = reason;
  }
}

const REF_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STEM_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;
const isText = (v) => typeof v === 'string' && v.trim() !== '';

// -> the entry compiled (frozen), or throws a RosterError whose message is fixed and whose reason is one of
// ref, shape, class, scope, regex.
function compileEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new RosterError('shape');
  const forms = ['stem', 're', 'path_glob'].filter((k) => Object.hasOwn(raw, k));
  if (forms.length !== 1 || !isText(raw[forms[0]])) throw new RosterError('shape');
  if (!CLASSES.includes(raw.class)) throw new RosterError('class');
  if (!Array.isArray(raw.scopes) || raw.scopes.some((s) => !SCOPES.includes(s)) || new Set(raw.scopes).size !== raw.scopes.length) {
    throw new RosterError('scope');
  }
  if (raw.scopes.includes('root') && raw.scopes.length !== 1) throw new RosterError('scope');
  if ((raw.class === 'O' || forms[0] === 'path_glob') && raw.scopes.length !== 0) throw new RosterError('scope');
  if (!isText(raw.cite)) throw new RosterError('shape');
  if (raw.cite_path !== null && !isText(raw.cite_path)) throw new RosterError('shape');
  if (raw.cite_path === null && !isText(raw.cite_note)) throw new RosterError('shape');
  if (raw.example !== undefined && (!Array.isArray(raw.example) || raw.example.some((x) => !isText(x)))) throw new RosterError('shape');
  if (forms[0] !== 'path_glob' && typeof raw.ext !== 'string') throw new RosterError('shape');
  let test = null;
  if (forms[0] === 're') {
    let re;
    try { re = new RegExp(raw.re); } catch { throw new RosterError('regex'); }
    test = (base) => re.test(base);
  } else if (forms[0] === 'stem') {
    test = (base) => base === raw.stem;
  }
  return Object.freeze({
    ...raw, scopes: Object.freeze([...raw.scopes]), example: Object.freeze([...(raw.example ?? [])]), kind: forms[0], test,
  });
}

// doc: the parsed roster. -> { ref, version, taken, source, entries } with compiled entries; throws a RosterError.
export function validateRoster(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new RosterError('shape');
  if (typeof doc.ref !== 'string' || !REF_RE.test(doc.ref)) throw new RosterError('ref');
  if (typeof doc.version !== 'string' || !VERSION_RE.test(doc.version)) throw new RosterError('shape');
  if (typeof doc.taken !== 'string' || !DATE_RE.test(doc.taken)) throw new RosterError('shape');
  if (!isText(doc.source)) throw new RosterError('shape');
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) throw new RosterError('shape');
  const entries = doc.entries.map(compileEntry);
  return Object.freeze({
    ref: doc.ref, version: doc.version, taken: doc.taken, source: doc.source, entries: Object.freeze(entries),
  });
}

let cached = null;
// -> the validated shipped roster (read once). A malformed file throws the fixed-message RosterError; only a developer edit
// can cause that, and test/unit/artifact-roster.test.mjs catches it before release.
export function loadRoster() {
  cached ??= validateRoster(JSON.parse(readFileSync(new URL('./roster.json', import.meta.url), 'utf8')));
  return cached;
}

export const rosterRef12 = () => loadRoster().ref.slice(0, 12);

const QUICK_ID_RE = /^\d{6}-[a-z0-9]{3}-/;
// A project code: one or more dash-joined segments, each starting with a letter (so `gate-2026` in a dated name is not a code).
const CODE_RE = /^[A-Za-z][A-Za-z0-9_.]*(?:-[A-Za-z][A-Za-z0-9_.]*)*$/;
const ID_AFTER_CODE_RE = /^\d{2,3}(?:\.\d{1,3})?-/;
const PHASE_ID_RE = /^\d{2,3}(?:\.\d{1,3})?(?:-\d{2,3})?-/;
const MAX_CODE = 32;

// name: a file name; coded: the file is in a coded phase dir. -> the name with a leading quick id, project code (only when
// coded) and phase or plan id stripped (see the header).
function strip(name, coded) {
  let rest = name;
  const q = QUICK_ID_RE.exec(rest);
  if (q) rest = rest.slice(q[0].length);
  // The shortest dash-delimited prefix that looks like a project code and is followed by a phase or plan id and a dash.
  for (let at = coded === true ? rest.indexOf('-') : -1; at > 0 && at <= MAX_CODE; at = rest.indexOf('-', at + 1)) {
    if (CODE_RE.test(rest.slice(0, at)) && ID_AFTER_CODE_RE.test(rest.slice(at + 1))) {
      rest = rest.slice(at + 1);
      break;
    }
  }
  const p = PHASE_ID_RE.exec(rest);
  if (p) rest = rest.slice(p[0].length);
  return rest;
}

// name: a plain file name; scope: one of SCOPES; coded: true for a file of a coded phase dir. -> { class, entry } for the first roster entry of that scope whose pattern
// the normalized name matches, else null. A `root` scope, a class O entry and a path glob never match.
export function classifyFile(name, { scope, coded = false } = {}) {
  if (typeof name !== 'string' || name === '' || !SCOPES.includes(scope) || scope === 'root') return null;
  const rest = strip(name, coded === true && scope === 'phase');
  for (const entry of loadRoster().entries) {
    if (!entry.scopes.includes(scope)) continue;
    const ext = entry.ext;
    if (!rest.endsWith(ext)) continue;
    const base = ext === '' ? rest : rest.slice(0, -ext.length);
    if (base !== '' && entry.test(base)) return { class: entry.class, entry };
  }
  return null;
}

// name: a plain file name; coded: as for classifyFile. -> the name normalized (strip) with every digit run folded to N: a date
// or an id in a name is the likeliest identifier, so it never survives into a stem.
export const stemOf = (name, { coded = false } = {}) => strip(name, coded).replace(/\d+/g, 'N');

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// True when `text` holds one of the names as a word: no letter or digit around it, any case (the rule of
// normalizeTouchedPath in signals.mjs).
function holdsWord(text, names) {
  for (const n of names) {
    if (typeof n === 'string' && n !== '' && new RegExp(`(?<![A-Za-z0-9])${escapeRe(n)}(?![A-Za-z0-9])`, 'i').test(text)) return true;
  }
  return false;
}

// name: a plain file name; denyNames: lower-case owner names. -> the stem to persist, or null when the stem fails the shape
// `^[A-Za-z0-9._-]{1,64}$`, holds `..`, or the raw name or the stem holds an owner word. A null stem is counted in the
// remainder row and never stored or printed (T-03.1-11).
export function safeStem(name, denyNames = [], { coded = false } = {}) {
  if (typeof name !== 'string') return null;
  const stem = stemOf(name, { coded });
  if (!STEM_SHAPE.test(stem) || stem.includes('..')) return null;
  if (holdsWord(name, denyNames) || holdsWord(stem, denyNames)) return null;
  return stem;
}

const compareBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// classes: kind -> count over the repos scanned in the run, or null when none was (every count then prints `?`: an unknown is
// never shown as zero); repos: the number of repos scanned. -> the `classes:` ingest line, no newline. It states a ref and
// counts, never a share (T-03.1-13).
export function classesLine(classes, repos) {
  const fields = REPO_CLASS_KINDS.map((k) => `${k}=${classes === null || classes === undefined ? '?' : (classes[k] ?? 0)}`);
  return `classes: repos=${repos} ${fields.join(' ')} roster_ref=${rosterRef12()}`;
}

// tally: Map stem -> files (stems that passed safeStem); rejected: the files whose stem did not. -> { listed: [{ stem, n }],
// other }: at most `max` stems, most files first and ties bytewise by stem, and `other` the files of every stem past the cap
// plus `rejected`, so listed plus other equals every file counted.
export function pickStems(tally, rejected = 0, max = STEM_MAX) {
  const sorted = [...tally].sort((a, b) => b[1] - a[1] || compareBytes(a[0], b[0]));
  const listed = sorted.slice(0, max).map(([stem, n]) => ({ stem, n }));
  const rest = sorted.slice(max).reduce((acc, [, n]) => acc + n, 0);
  return { listed, other: rest + rejected };
}

// -> { root, path_glob, no_scanned_scope }: every roster entry rigorscope cannot recognize by design, from the shipped roster
// and never by hand. root: project-root state files (never listed); path_glob: entries the roster document gives as a path
// pattern (they document where gsd-core writes and classify no name); no_scanned_scope: the rest with no scanned scope (class
// O). Each item is { name, ext, class, cite } with name the stem, regex or glob.
export function notLookedFor() {
  const out = { root: [], path_glob: [], no_scanned_scope: [] };
  for (const e of loadRoster().entries) {
    const item = {
      name: e.stem ?? e.re ?? e.path_glob, ext: e.ext ?? '', class: e.class, cite: e.cite,
    };
    if (e.kind === 'path_glob') out.path_glob.push(item);
    else if (e.scopes.length === 1 && e.scopes[0] === 'root') out.root.push(item);
    else if (e.scopes.length === 0) out.no_scanned_scope.push(item);
  }
  return out;
}
