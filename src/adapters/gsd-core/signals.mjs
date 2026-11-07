// The collector readers of the gsd-core adapter for tier, timing, risk and novelty (plan 02-03; D-01, D-05..D-07,
// amendments Q1 and Q6, D-24). They read metadata only; plan 02-05 wires them into ingest and stores what they return,
// and derive computes the unit attributes from the stored rows with the pure rules of src/units/.
//
// What is read, and nothing else:
//   - the leading frontmatter of `<id>-PLAN.md` and `<id>-SUMMARY.md` in the unit dir (the tier letter through
//     tierLetter, and the PLAN's `files_modified:` list through filesModified);
//   - for a quick unit only: the `Tier:` line of the bytewise-first `RIGOR-TIER.md` or `RIGOR-TIERS.txt`, and the first
//     non-empty line of the bytewise-first `*-PROBES-SKIPPED.md` of the unit dir;
//   - git history: the oldest add commit of each planning file; for a PLAN or SUMMARY frontmatter letter, the oldest
//     commit changing a column-0 `tier:` line of that file whose blob at that commit carries a tier letter in its
//     leading frontmatter (review CR-01: a body or code-fence `tier:` line never sets the signal time); and per unit
//     the commits whose subject's conventional-commit scope is the unit (review WR-02: `type(<id>):`, and for a quick
//     unit `type(quick-<id>):` or a comma- or space-separated scope list naming it; merge commits skipped), with their
//     author time and the status (A, M, D) of each path. The subject is tested here and never kept.
// A CONTEXT file, any body line and any other file of the unit dir are never read (D-01, Q6). No return value, message
// or error ever holds file text, a commit subject or body, or an author or committer name or email.
//
// Paths are kept only repo-relative or home-relative (`~/...`): normalizeTouchedPath strips a leading `./`, turns an
// absolute path under the repo into a repo-relative one and one under HOME into `~/...` (a path written `$HOME/...`
// is kept as written: it holds no identity, and the risk table's global-config rule names that form), and drops (and
// counts) any other absolute path, a drive or backslash path, a `~user` path, a path with a `..` segment,
// a control character, whitespace (free text after a list item), more than FILES_MODIFIED_MAX_CHARS characters, or
// the HOME user name as a word (a quick-dir slug can carry it; ownerNamesOf, review of the real golden snapshot).
//
// git safety: execFileSync with an args array that begins `-C <top> -c core.quotepath=off -c core.fsmonitor=false`,
// GIT_OPTIONAL_LOCKS=0, the repository-location variables removed from the child environment, stdin and stderr
// ignored, a timeout (GIT_TIMEOUT_MS) and an output cap (GIT_MAX_BUFFER). A unit id reaches git only after its shape
// check and only as a `--fixed-strings --grep=` value; a module dir only after the path checks. A spawn error, a
// timeout, a cap overflow or a non-zero exit makes that repo's commit facts NULL (`git: unavailable`), never an empty
// list. The `run` option is a test seam: run(args) -> { status, stdout, errorCode }, never throws.
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildHomeSet, normalizeCwd } from '../../sources/transcript/home.mjs';
import {
  FILES_MODIFIED_MAX_CHARS, FRONTMATTER_MAX_BYTES, filesModified, frontmatterLines, readHead, tierLetter,
} from './frontmatter.mjs';
import { addedCodePaths, moduleDirOf } from '../../units/novelty.mjs';
import { PLAN_ID_RE, idShapeOk } from '../../units/unit-key.mjs';
import { QUICK_DIR_RE } from './index.mjs';
import {
  PLANNING_PATHSPECS, archiveRootKind, compareLabels, dirAcceptsPlan, formerLivePath,
} from './layout.mjs';

export const TIER_ROLES = Object.freeze(['plan', 'summary', 'rigor-tier', 'probes-skipped']);
export const TIER_PLACES = Object.freeze(['frontmatter', 'tier-line', 'probes-line']);
export const TIER_FILE_RE = /^(?:RIGOR-TIER\.md|RIGOR-TIERS\.txt)$/;
export const PROBES_FILE_RE = /^[A-Za-z0-9._-]+-PROBES-SKIPPED\.md$/;
export const GIT_TIMEOUT_MS = 20000;
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;
export const NOVELTY_MAX_DIRS = 32;
// At most this many `tier:`-line commits of one file are shown to find its frontmatter tier commit (review CR-01).
export const TIER_CANDIDATES_MAX = 16;

// The research rules (02-RESEARCH.md, tier-risk.mjs): a `Tier:` line anywhere in a tier file; the first non-empty
// line of a probes-skipped file starting `Tier B` or `Tier C`.
const TIER_FILE_LINE_RE = /^Tier:\s*([ABC])\b/m;
const PROBES_LINE_RE = /^\s*Tier ([BC])\b/;
const NAME_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const STATUS = Object.freeze({ A: 'A', M: 'M', D: 'D', T: 'M' });
const LOCATION_VARS = Object.freeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);
const DROPPED = Object.freeze({ dropped: true });
const WHITESPACE = /\s/;
// Shorter names and these ordinary words are not treated as owner names (the floor and list of
// test/prohibitions/no-owner-literals.test.mjs): as a whole word they occur in ordinary paths.
const OWNER_NAME_FLOOR = 4;
const OWNER_NAME_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;
const GENERIC_NAMES = new Set([
  'root', 'runner', 'ubuntu', 'user', 'test', 'node', 'dev', 'main', 'admin', 'build', 'builder', 'ci', 'github',
  'jenkins', 'docker', 'vagrant', 'nobody', 'default', 'www-data',
]);
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const compareBytes = (a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));

// -> 'A', 'B', 'C' or null: the first `Tier:` line of a tier file.
export function tierFileLetter(text) {
  if (typeof text !== 'string') return null;
  const m = TIER_FILE_LINE_RE.exec(text.replace(/\r/g, ''));
  return m ? m[1] : null;
}

// -> 'B', 'C' or null: the first non-empty line of a probes-skipped file, when it starts `Tier B` or `Tier C`.
export function probesSkippedTier(text) {
  if (typeof text !== 'string') return null;
  const first = text.replace(/\r/g, '').split('\n').find((l) => l.trim() !== '');
  if (first === undefined) return null;
  const m = PROBES_LINE_RE.exec(first);
  return m ? m[1] : null;
}

// raw: a path as read from a planning file or git. top: the repo's working tree (topReal: its realpath, optional).
// homeSet: from homeSetOf. -> { path } (repo-relative or `~/...`) or { dropped: true }.
// denyNames: lower-case owner names (ownerNamesOf); a path holding one as a word (no letter or digit around it,
// any case) is dropped.
export function normalizeTouchedPath(raw, {
  top, topReal, homeSet, denyNames = [],
} = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > FILES_MODIFIED_MAX_CHARS) return DROPPED;
  if (CONTROL.test(raw) || raw.trim() === '') return DROPPED;
  let p = raw;
  while (p.startsWith('./')) p = p.slice(2);
  if (p.includes('\\') || /^[A-Za-z]:/.test(p)) return DROPPED;
  if (p.startsWith('/')) {
    let rel = null;
    for (const t of [top, topReal]) {
      if (typeof t !== 'string' || !t.startsWith('/')) continue;
      const base = t.replace(/\/+$/, '');
      if (base !== '' && p.startsWith(`${base}/`)) { rel = p.slice(base.length + 1); break; }
    }
    if (rel === null) {
      const n = normalizeCwd(p, homeSet);
      if (typeof n !== 'string' || !n.startsWith('~/')) return DROPPED;
      rel = n;
    }
    p = rel;
  }
  if (p.startsWith('~') && !p.startsWith('~/')) return DROPPED;
  const rest = p.startsWith('~/') ? p.slice(2) : p;
  if (rest === '' || WHITESPACE.test(p) || rest.split('/').some((s) => s === '..' || s === '.')) return DROPPED;
  for (const name of denyNames) {
    if (typeof name === 'string' && name !== '' && new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, 'i').test(p)) return DROPPED;
  }
  return { path: p };
}

// The owner names a path must not carry: the basename of HOME and of its realpath (D-24: locations resolve through
// HOME, never through a machine lookup), each kept only when it is a plain name of at least OWNER_NAME_FLOOR
// characters and not an ordinary word. -> lower-case names.
export function ownerNamesOf(home) {
  const raw = [];
  if (typeof home === 'string' && home !== '') {
    raw.push(basename(home));
    try { raw.push(basename(realpathSync(home))); } catch { /* HOME may not exist */ }
  }
  const out = new Set();
  for (const n of raw) {
    if (typeof n !== 'string' || !OWNER_NAME_SHAPE.test(n) || n.length < OWNER_NAME_FLOOR) continue;
    if (GENERIC_NAMES.has(n.toLowerCase())) continue;
    out.add(n.toLowerCase());
  }
  return [...out].sort();
}

// The home set of HOME and of its realpath (a HOME reached through a symlink still gives `~/...`).
export function homeSetOf(home) {
  if (typeof home !== 'string' || home === '') return buildHomeSet({});
  const set = buildHomeSet({ home });
  let real = null;
  try { real = realpathSync(home); } catch { real = null; }
  if (real && real !== home) set.cwd.push(...buildHomeSet({ home: real }).cwd);
  return set;
}

// lstat that answers 'missing', 'symlink', 'dir', 'file' or 'other'; every error reads as 'missing'.
function kindOf(p) {
  let st;
  try { st = lstatSync(p); } catch { return 'missing'; }
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

function sortedEntries(abs) {
  try {
    return readdirSync(abs, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
  } catch {
    return [];
  }
}

// -> the repo-relative unit dir or null. quick: the bytewise-first `.planning/quick/` entry whose name starts with the
// id (02-02's duplicate rule); plan: the bytewise-first `.planning/phases/<dir>/` whose name starts with the id's phase
// part and a dash and which holds a regular file `<id>-PLAN.md`. Symlinks are never followed. includeArchive (plan 03.1-03,
// D-07; default false, so src/ledger/record.mjs is unchanged): after the live root, the archive roots of the same kind
// (`.planning/milestones/<label>-phases` or `-quick`) in natural label order, oldest first; a plan dir is then also
// accepted when it carries a project_code prefix (dirAcceptsPlan).
export function locateUnitDir({
  top, kind, nativeId, includeArchive = false,
} = {}) {
  if (typeof top !== 'string' || !idShapeOk(kind, nativeId)) return null;
  const sub = kind === 'quick' ? 'quick' : 'phases';
  if (kindOf(join(top, '.planning')) !== 'dir') return null;
  const roots = [];
  if (kindOf(join(top, '.planning', sub)) === 'dir') roots.push(`.planning/${sub}`);
  if (includeArchive && kindOf(join(top, '.planning', 'milestones')) === 'dir') {
    const labels = sortedEntries(join(top, '.planning', 'milestones'))
      .filter((e) => e.isDirectory() && NAME_SHAPE.test(e.name) && archiveRootKind(e.name) === sub)
      .map((e) => e.name)
      .sort((a, b) => compareLabels(a.slice(0, -(sub.length + 1)), b.slice(0, -(sub.length + 1))));
    for (const name of labels) roots.push(`.planning/milestones/${name}`);
  }
  if (roots.length === 0) return null;
  const phase = kind === 'quick' ? null : PLAN_ID_RE.exec(nativeId)[1];
  for (const root of roots) {
    for (const e of sortedEntries(join(top, root))) {
      if (!e.isDirectory() || !NAME_SHAPE.test(e.name) || e.name.includes('..')) continue;
      if (kind === 'quick') {
        const m = QUICK_DIR_RE.exec(e.name);
        if (m && m[1] === nativeId) return `${root}/${e.name}`;
      } else {
        const accepted = includeArchive ? dirAcceptsPlan(e.name, nativeId) : e.name.startsWith(`${phase}-`);
        if (accepted && kindOf(join(top, root, e.name, `${nativeId}-PLAN.md`)) === 'file') return `${root}/${e.name}`;
      }
    }
  }
  return null;
}

function gitChildEnv() {
  const env = { ...process.env };
  for (const k of LOCATION_VARS) delete env[k];
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

// The default git runner: never throws.
export function defaultGitRun(args) {
  try {
    const stdout = execFileSync('git', args, {
      env: gitChildEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER,
    });
    return { status: 0, stdout, errorCode: null };
  } catch (err) {
    if (err?.code === 'ENOBUFS') return { status: null, stdout: '', errorCode: 'ENOBUFS' };
    if (err?.signal || err?.code === 'ETIMEDOUT') return { status: null, stdout: '', errorCode: 'ETIMEDOUT' };
    if (typeof err?.status === 'number') return { status: err.status, stdout: '', errorCode: null };
    return { status: null, stdout: '', errorCode: typeof err?.code === 'string' ? err.code : 'EUNKNOWN' };
  }
}

export const gitArgs = (top, rest) => [
  '-C', top, '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false',
  '-c', 'log.showRoot=true', '-c', 'color.ui=false', ...rest,
];
const answered = (r) => r !== null && typeof r === 'object' && r.errorCode === null && r.status === 0 && typeof r.stdout === 'string';
const timeOf = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

// `%x01%aI` headers followed by `--name-only` paths -> Map path -> the oldest time.
function oldestByPath(stdout) {
  const out = new Map();
  let t = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('\x01')) { t = timeOf(line.slice(1).trim()); continue; }
    if (line === '' || t === null || line.startsWith('"')) continue;
    const prev = out.get(line);
    if (prev === undefined || t < prev) out.set(line, t);
  }
  return out;
}

// `%x01%H%x1f%aI` headers followed by `--name-only` paths -> Map path -> [{ sha, ms }] sorted by ms then sha.
function commitsByPath(stdout) {
  const out = new Map();
  let cur = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('\x01')) {
      const [sha, iso] = line.slice(1).split('\x1f');
      const ms = timeOf(String(iso ?? '').trim());
      cur = SHA_RE.test(sha ?? '') && ms !== null ? { sha, ms } : null;
      continue;
    }
    if (line === '' || cur === null || line.startsWith('"')) continue;
    const list = out.get(line) ?? [];
    if (!list.some((c) => c.sha === cur.sha)) list.push(cur);
    out.set(line, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.ms - b.ms || compareBytes(a.sha, b.sha));
  return out;
}

// -> { git: 'ok', firstAddMs, tierLineCommits } or { git: 'unavailable' }. firstAddMs: Map of repo-relative planning
// paths to the oldest add time (epoch ms); tierLineCommits: Map path -> the commits whose diff adds or removes a
// column-0 `tier:` line anywhere in that file (body and code fences included), oldest first. frontmatterTierMs picks
// the signal time from these.
export function artifactCommitIndex({ top, run = defaultGitRun } = {}) {
  if (typeof top !== 'string' || top === '') return { git: 'unavailable' };
  const base = ['log', '--all', '--no-renames', '--no-color', '--name-only'];
  const added = run(gitArgs(top, [...base, '--format=%x01%aI', '--diff-filter=A', '--', ...PLANNING_PATHSPECS]));
  if (!answered(added)) return { git: 'unavailable' };
  const tierLine = run(gitArgs(top, [...base, '--format=%x01%H%x1f%aI', '-G', '^tier:', '--', ...PLANNING_PATHSPECS]));
  if (!answered(tierLine)) return { git: 'unavailable' };
  return { git: 'ok', firstAddMs: oldestByPath(added.stdout), tierLineCommits: commitsByPath(tierLine.stdout) };
}

// Review 03.1-03 CR-01: the git lookup of one artifact path against an artifactCommitIndex. relPath under an archive root
// is read through its former live path (formerLivePath), and the archive path's own first-add time is an exclusive upper
// bound on EVERY time taken from that former path: a later milestone that reused the dir name adds and edits the same
// former path after this archive, and none of that history is this artifact's. -> { lookup, boundMs, first, candidates }:
// first is the former path's oldest add when it is before the bound (else null: unknown), candidates its tier-line commits
// before the bound (undefined when it has none), boundMs the archive path's first-add time (undefined for a live path or an
// archive path git has no add for, an uncommitted move: no bound).
export function formerPathLookup(index, relPath) {
  const lookup = formerLivePath(relPath);
  const boundMs = lookup === relPath ? undefined : index.firstAddMs.get(relPath);
  const before = (ms) => boundMs === undefined || ms < boundMs;
  const first = index.firstAddMs.get(lookup) ?? null;
  const all = index.tierLineCommits.get(lookup);
  return {
    lookup,
    boundMs,
    first: first !== null && before(first) ? first : null,
    candidates: Array.isArray(all) ? all.filter((c) => before(c.ms)) : undefined,
  };
}

// Review CR-01: the frontmatter signal time of relPath -> epoch ms or null. The candidates (tierLineCommits of the
// file, oldest first, at most TIER_CANDIDATES_MAX) are shown one at a time with `cat-file blob <sha>:<path>`; the
// first whose leading frontmatter (its first FRONTMATTER_MAX_BYTES bytes, read by frontmatterLines and tierLetter)
// carries a tier letter gives its author time. Any candidate git cannot show (a spawn error, a timeout or a non-zero
// exit, a commit that deleted the file included) makes the time unknown (null) rather than a later or earlier one,
// and so does running out of candidates.
export function frontmatterTierMs({ top, relPath, candidates, run = defaultGitRun } = {}) {
  if (typeof top !== 'string' || top === '' || typeof relPath !== 'string' || !Array.isArray(candidates)) return null;
  if (relPath.startsWith('-') || !relPath.startsWith('.planning/')) return null;
  for (const c of candidates.slice(0, TIER_CANDIDATES_MAX)) {
    if (!SHA_RE.test(c?.sha ?? '') || !Number.isFinite(c?.ms)) return null;
    const r = run(gitArgs(top, ['cat-file', 'blob', `${c.sha}:${relPath}`]));
    if (!answered(r)) return null;
    const head = Buffer.from(r.stdout, 'utf8').subarray(0, FRONTMATTER_MAX_BYTES).toString('utf8');
    if (tierLetter(frontmatterLines(head)) !== null) return c.ms;
  }
  return null;
}

// Review WR-02: `type(scope)!:` at the start of a subject; the scope is split on commas and whitespace.
const SUBJECT_SCOPE_RE = /^[A-Za-z][A-Za-z0-9_-]*\(([^()]*)\)!?:/;

// -> true when the subject's conventional-commit scope names the unit: for a quick unit the id or `quick-<id>`, as
// the whole scope or as one comma- or space-separated item of it; for a phase plan the plan id as the whole scope
// (the git needle `(<plan id>)` finds no other shape).
export function scopeNamesUnit(subject, { kind, nativeId } = {}) {
  if (typeof subject !== 'string' || typeof nativeId !== 'string') return false;
  const m = SUBJECT_SCOPE_RE.exec(subject);
  if (!m) return false;
  if (kind !== 'quick') return m[1] === nativeId;
  return m[1].split(/[\s,]+/).some((t) => t === nativeId || t === `quick-${nativeId}`);
}

// -> { commits: [{ sha, author_ms, files: [{ path, status }] }], dropped } sorted by author_ms then sha, files by path;
// or null when the id fails its shape or git did not answer. git is asked with a `--fixed-strings --grep=` needle (the
// quick id, or the plan id in parentheses) and `--no-merges`; a commit is kept only when scopeNamesUnit holds for its
// subject (review WR-02), so another unit's commit that mentions the id in its body or outside its scope is left out.
export function unitCommits({
  top, kind, nativeId, run = defaultGitRun, topReal, homeSet, denyNames = [],
} = {}) {
  if (typeof top !== 'string' || top === '' || !idShapeOk(kind, nativeId)) return null;
  const needle = kind === 'quick' ? nativeId : `(${nativeId})`;
  const r = run(gitArgs(top, [
    'log', '--all', '--no-merges', '--no-renames', '--no-color', '--fixed-strings', `--grep=${needle}`, '--format=%x01%H%x1f%aI%x1f%s', '--name-status',
  ]));
  if (!answered(r)) return null;
  const bySha = new Map();
  let dropped = 0;
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('\x01')) {
      const [sha, iso, ...rest] = line.slice(1).split('\x1f');
      const ms = timeOf(String(iso ?? '').trim());
      const scoped = scopeNamesUnit(rest.join('\x1f'), { kind, nativeId });
      cur = scoped && SHA_RE.test(sha ?? '') && ms !== null ? (bySha.get(sha) ?? { sha, author_ms: ms, files: new Map() }) : null;
      if (cur) bySha.set(sha, cur);
      continue;
    }
    if (line === '' || cur === null) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const status = STATUS[line.slice(0, tab)];
    const raw = line.slice(tab + 1);
    if (status === undefined) continue;
    if (raw.startsWith('"')) { dropped += 1; continue; }
    const n = normalizeTouchedPath(raw, { top, topReal, homeSet, denyNames });
    if (n.dropped || n.path.startsWith('~')) { dropped += 1; continue; }
    cur.files.set(n.path, status);
  }
  const commits = [...bySha.values()]
    .map((c) => ({
      sha: c.sha,
      author_ms: c.author_ms,
      files: [...c.files.entries()].sort((a, b) => compareBytes(a[0], b[0])).map(([path, status]) => ({ path, status })),
    }))
    .sort((a, b) => a.author_ms - b.author_ms || compareBytes(a.sha, b.sha));
  return { commits, dropped };
}

// The text of a regular file (bounded head), or null: missing, a symlink, not a regular file or unreadable.
function readRegular(abs) {
  if (kindOf(abs) !== 'file') return null;
  try { return readHead(abs); } catch { return null; }
}

function firstFile(dirAbs, re) {
  for (const e of sortedEntries(dirAbs)) {
    if (e.isFile() && re.test(e.name) && kindOf(join(dirAbs, e.name)) === 'file') return e.name;
  }
  return null;
}

// -> the located row (without schema, repo and kind) or { located: false, reason: 'unit_not_found' }.
//   { located: true, dir_rel, git, artifacts: [{ role, rel_path, tier_letter, tier_place, first_commit_ms,
//     tier_commit_ms }], files_modified, commits, dropped_paths }
// index: an artifactCommitIndex result for the repo (computed here when absent).
export function collectUnitSignals({ top, kind, nativeId, home, run = defaultGitRun, index } = {}) {
  const dirRel = locateUnitDir({
    top, kind, nativeId, includeArchive: true,
  });
  if (dirRel === null) return { located: false, reason: 'unit_not_found' };
  const homeSet = homeSetOf(home);
  const denyNames = ownerNamesOf(home);
  let topReal = null;
  try { topReal = realpathSync(top); } catch { topReal = null; }
  const dirAbs = join(top, dirRel);
  const found = [];
  let planText = null;
  for (const [suffix, role] of [['PLAN', 'plan'], ['SUMMARY', 'summary']]) {
    const relPath = `${dirRel}/${nativeId}-${suffix}.md`;
    const text = readRegular(join(top, relPath));
    if (text === null) continue;
    if (role === 'plan') planText = text;
    found.push({ role, relPath, letter: tierLetter(frontmatterLines(text)), place: 'frontmatter' });
  }
  if (kind === 'quick') {
    const tierName = firstFile(dirAbs, TIER_FILE_RE);
    if (tierName !== null) {
      found.push({ role: 'rigor-tier', relPath: `${dirRel}/${tierName}`, letter: tierFileLetter(readRegular(join(dirAbs, tierName))), place: 'tier-line' });
    }
    const probesName = firstFile(dirAbs, PROBES_FILE_RE);
    if (probesName !== null) {
      found.push({ role: 'probes-skipped', relPath: `${dirRel}/${probesName}`, letter: probesSkippedTier(readRegular(join(dirAbs, probesName))), place: 'probes-line' });
    }
  }
  let dropped = 0;
  let files = null;
  const listed = planText === null ? null : filesModified(frontmatterLines(planText));
  if (Array.isArray(listed)) {
    const kept = new Set();
    for (const raw of listed) {
      const n = normalizeTouchedPath(raw, { top, topReal, homeSet, denyNames });
      if (n.dropped) dropped += 1;
      else kept.add(n.path);
    }
    files = [...kept].sort(compareBytes);
  }
  const idx = index ?? artifactCommitIndex({ top, run });
  const unit = idx?.git === 'ok' ? unitCommits({
    top, kind, nativeId, run, topReal, homeSet, denyNames,
  }) : null;
  const gitOk = idx?.git === 'ok' && unit !== null;
  if (gitOk) dropped += unit.dropped;
  const artifacts = found
    .sort((a, b) => compareBytes(a.relPath, b.relPath))
    .map((a) => {
      const letter = a.letter ?? null;
      // An archive-class artifact is looked up through its former live path (plan 03.1-03, D-19); the archive path's own
      // add time is the archive commit and is never a first-commit or tier time, only the upper bound of both (CR-01).
      const former = gitOk ? formerPathLookup(idx, a.relPath) : null;
      const first = former === null ? null : former.first;
      const tierMs = gitOk && letter !== null && a.place === 'frontmatter'
        ? frontmatterTierMs({ top, relPath: former.lookup, candidates: former.candidates, run })
        : null;
      return {
        role: a.role, rel_path: a.relPath, tier_letter: letter, tier_place: letter === null ? null : a.place, first_commit_ms: first, tier_commit_ms: tierMs,
      };
    });
  return {
    located: true,
    dir_rel: dirRel,
    git: gitOk ? 'ok' : 'unavailable',
    artifacts,
    files_modified: files,
    commits: gitOk ? unit.commits : null,
    dropped_paths: dropped,
  };
}

// D-07 inputs: for the module dirs (moduleDirOf) of the added code paths of a unit's commits, sorted bytewise, one
// `cat-file -e <oldest sha>^:<dir>` each (the oldest commit by author_ms then sha): exit 0 means the dir existed before
// the unit (true); a clean non-zero exit, a root commit included, means it did not (false); a spawn error or a timeout
// is unknown (null). At most NOVELTY_MAX_DIRS dirs are asked; the rest are null. A dir reaches git only after the path
// checks of normalizeTouchedPath. -> Map dir -> true | false | null, or null when commits is null or empty.
export function noveltyInputs({ top, commits, run = defaultGitRun } = {}) {
  if (!Array.isArray(commits) || commits.length === 0) return null;
  const oldest = [...commits]
    .filter((c) => typeof c?.sha === 'string' && SHA_RE.test(c.sha) && Number.isFinite(c.author_ms))
    .sort((a, b) => a.author_ms - b.author_ms || compareBytes(a.sha, b.sha))[0];
  const dirs = [...new Set(addedCodePaths(commits).map(moduleDirOf))].sort(compareBytes);
  const out = new Map();
  dirs.forEach((dir, i) => {
    if (i >= NOVELTY_MAX_DIRS || oldest === undefined || typeof top !== 'string' || top === '') { out.set(dir, null); return; }
    if (dir !== '') {
      const n = normalizeTouchedPath(dir, {});
      if (n.dropped || n.path !== dir || dir.startsWith('~') || dir.startsWith('-') || dir.startsWith('$')) { out.set(dir, null); return; }
    }
    const r = run(gitArgs(top, ['cat-file', '-e', `${oldest.sha}^:${dir}`]));
    if (r === null || typeof r !== 'object' || r.errorCode !== null) out.set(dir, null);
    else out.set(dir, r.status === 0);
  });
  return out;
}
