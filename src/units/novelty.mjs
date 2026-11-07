// The novelty of a reconstructed unit (plan 02-03, D-07). Pure: no import, no I/O. The collector
// (noveltyInputs in src/adapters/gsd-core/signals.mjs) answers, from git, whether each module dir existed before the
// unit; derive (plan 02-05) calls noveltyOf over the stored commit facts and answers. In phase 2 novelty is a column
// only, never a stratum.
//
// Rules, in order (version NOVELTY_RULES_VERSION):
//   unknown          commits NULL or empty, or an added code path whose module dir was not answered (true or false)
//                    -> novelty NULL, novelty_source `no-evidence`
//   new-dir          an added code path (status A) lies in a module dir (its first NOVELTY_DIR_DEPTH directory
//                    segments) that did not exist at the parent of the unit's oldest commit -> first-of-kind
//   new-command      an added code file sits directly in a dir named `commands` or `bin` -> first-of-kind
//   incremental      anything else, including units that add no code path -> incremental
// Code is any path outside `.planning/`, outside test and fixture dirs (a segment named test, tests, fixture,
// fixtures or __tests__), not a `.test.` file and not ending in `.md` or `.txt`. Sources: `rule:<name>@<version>`.

export const NOVELTY_RULES_VERSION = 1;
export const NOVELTY_DIR_DEPTH = 3;

const EXCLUDED_DIRS = new Set(['test', 'tests', 'fixture', 'fixtures', '__tests__']);
const COMMAND_DIRS = new Set(['commands', 'bin']);
const UNKNOWN = Object.freeze({ novelty: null, novelty_source: 'no-evidence' });
const source = (rule) => `rule:${rule}@${NOVELTY_RULES_VERSION}`;

// -> the first NOVELTY_DIR_DEPTH directory segments of a repo-relative path ('' for a root file).
export function moduleDirOf(path) {
  if (typeof path !== 'string') return '';
  const dirs = path.split('/').slice(0, -1);
  return dirs.slice(0, NOVELTY_DIR_DEPTH).join('/');
}

export function isNoveltyCodePath(path) {
  if (typeof path !== 'string' || path === '' || path.startsWith('.planning/')) return false;
  const segs = path.split('/');
  const name = segs[segs.length - 1];
  if (segs.slice(0, -1).some((s) => EXCLUDED_DIRS.has(s))) return false;
  if (name.includes('.test.')) return false;
  return !/\.(md|txt)$/i.test(name);
}

// -> the added code paths of the commits (status A), in order.
export function addedCodePaths(commits) {
  const out = [];
  for (const c of Array.isArray(commits) ? commits : []) {
    for (const f of Array.isArray(c?.files) ? c.files : []) if (f?.status === 'A' && isNoveltyCodePath(f.path)) out.push(f.path);
  }
  return out;
}

// newDirs: Map module dir -> true (existed before the unit), false (did not) or null (not answered).
// -> { novelty, novelty_source }.
export function noveltyOf({ commits, newDirs } = {}) {
  if (!Array.isArray(commits) || commits.length === 0) return { ...UNKNOWN };
  const added = addedCodePaths(commits);
  const answers = added.map((p) => (newDirs instanceof Map ? newDirs.get(moduleDirOf(p)) : undefined));
  if (answers.some((a) => a !== true && a !== false)) return { ...UNKNOWN };
  if (answers.some((a) => a === false)) return { novelty: 'first-of-kind', novelty_source: source('new-dir') };
  const inCommandDir = added.some((p) => {
    const segs = p.split('/');
    return segs.length >= 2 && COMMAND_DIRS.has(segs[segs.length - 2]);
  });
  if (inCommandDir) return { novelty: 'first-of-kind', novelty_source: source('new-command') };
  return { novelty: 'incremental', novelty_source: source('incremental') };
}
