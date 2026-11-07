// The environment snapshot of an ingest run (plan 02-04, DATA-07, D-16 with amendment Q3, D-24, ADR-0009).
//
// One row per ingest run that holds the lock, in env_snapshot: what was installed and configured when the run read
// its sources, so plan 02-07 can attach the GSD version and local-mods state to units as confounders. Snapshots are
// forward-only: nothing is inferred for runs before the first one.
//
// Sources, every one optional (D-24): absent, not a regular file, above its size cap, unparseable, failing its shape or
// a git failure gives NULL for that field only, never an error and never a guess.
//   config dir        CLAUDE_CONFIG_DIR of the ingest `env` option when set, non-empty and absolute, else HOME/.claude
//   gsd_version       the trimmed `<config dir>/gsd-core/VERSION` (source `version-file`), else the top-level `version`
//                     of `<config dir>/gsd-file-manifest.json` (source `manifest`); the safeVersion shape, 1 to 32
//                     characters
//   settings.json     `<config dir>/settings.json`, only its `hooks`, `model` and `advisorModel` keys, picked by
//                     literal name: hook_events, the canonical JSON object of event name to the number of hook entries
//                     (the sum of each matcher group's `hooks` array length; a name failing EVENT_NAME_RE adds to `?`);
//                     hooks_sha, the sha256 hex of the canonical JSON of the `hooks` value (keys sorted bytewise at
//                     every level), a change detector over configuration holding no identity (amendment Q3); a readable
//                     settings file without `hooks` counts as `{}`; model_default and advisor_model when they match
//                     MODEL_RE
//   base_sha          the top-level `sha` (40 or 64 lower-case hex) of the JSON file named by
//                     RIGORSCOPE_INSTALLED_BASE_FILE (an absolute path)
//   local_mods_head   `git -C <dir> -c core.fsmonitor=false rev-parse --verify HEAD` of the directory named by
//                     RIGORSCOPE_LOCAL_MODS_DIR (absolute only), through the repo resolver's runner: location variables
//                     removed, GIT_OPTIONAL_LOCKS=0, GIT_CEILING_DIRECTORIES the parent of the directory's realpath, a
//                     timeout
// Never read: every settings key but `hooks`, `model` and `advisorModel` (no hook command text is kept, no `env` value,
// no permission, no statusLine); every manifest key but `version`; every base-file key but `sha`; `.gsd-source`. The
// configured locations are read from the ingest `env` option only, never from process.env directly, so a test HOME
// never reaches a developer's own config dir. The `hooks` value is serialized only in memory, for its hash. No value
// read is ever printed, logged or put in an error message; a JSON parse error is swallowed without its message.
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { safeVersion } from '../sources/transcript/home.mjs';
import { GIT_TIMEOUT_MS, childEnv, defaultRun } from '../units/repo-resolve.mjs';

export const LOCAL_MODS_ENV = 'RIGORSCOPE_LOCAL_MODS_DIR';
export const INSTALLED_BASE_ENV = 'RIGORSCOPE_INSTALLED_BASE_FILE';
export const SNAPSHOT_LIMITS = Object.freeze({
  versionMaxBytes: 64,
  manifestMaxBytes: 4194304,
  settingsMaxBytes: 4194304,
  baseFileMaxBytes: 65536,
  maxEvents: 64,
  maxDepth: 32,
  gitTimeoutMs: GIT_TIMEOUT_MS,
});

const EVENT_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}(\[[A-Za-z0-9]{1,16}\])?$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const VERSION_MAX_CHARS = 32;
const DEPTH_ERROR = 'canonicalJson: nesting deeper than the cap';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => (isObject(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const compareBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function configDirOf({ home, env = {} }) {
  const c = env?.CLAUDE_CONFIG_DIR;
  if (typeof c === 'string' && c !== '' && isAbsolute(c)) return c;
  return join(home, '.claude');
}

// The text of a regular file of at most maxBytes, or null. Opened read-only and non-blocking (a FIFO never stalls the
// run); never throws.
export function readCapped(path, maxBytes) {
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let at = 0;
    while (at < st.size) {
      const n = readSync(fd, buf, at, st.size - at, at);
      if (n === 0) break;
      at += n;
    }
    return buf.subarray(0, at).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
}

// JSON with object keys sorted bytewise at every level and arrays in order. Throws a fixed error past maxDepth.
export function canonicalJson(value, depth = 0) {
  if (depth > SNAPSHOT_LIMITS.maxDepth) throw new Error(DEPTH_ERROR);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort(compareBytes);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k], depth + 1)}`).join(',')}}`;
  }
  const s = JSON.stringify(value);
  return s === undefined ? 'null' : s;
}

const parseJson = (text) => {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // never expose the parser message: V8 quotes the input
  }
};
const versionOf = (v) => (typeof v === 'string' && v.length <= VERSION_MAX_CHARS && safeVersion(v) !== '?' ? v : null);

// -> { value, source } with source 'version-file', 'manifest' or null (then value is null).
export function readGsdVersion(configDir) {
  const text = readCapped(join(configDir, 'gsd-core', 'VERSION'), SNAPSHOT_LIMITS.versionMaxBytes);
  const fromFile = text === null ? null : versionOf(text.trim());
  if (fromFile !== null) return { value: fromFile, source: 'version-file' };
  const manifest = parseJson(readCapped(join(configDir, 'gsd-file-manifest.json'), SNAPSHOT_LIMITS.manifestMaxBytes));
  const fromManifest = versionOf(own(manifest, 'version'));
  if (fromManifest !== null) return { value: fromManifest, source: 'manifest' };
  return { value: null, source: null };
}

// The hook facts of a `hooks` value: { hookEvents, hooksSha, hookEventCount, hookCount }, all NULL when unusable.
function hookFacts(hooks) {
  const none = { hookEvents: null, hooksSha: null, hookEventCount: null, hookCount: null };
  if (!isObject(hooks)) return none;
  let hooksSha;
  try {
    hooksSha = sha256(canonicalJson(hooks));
  } catch {
    return none;
  }
  // A null-prototype map (review WR-01): an event named `constructor` or `toString` must not read an inherited member.
  const counts = Object.create(null);
  let total = 0;
  let seen = 0;
  for (const name of Object.keys(hooks)) {
    seen += 1;
    const key = seen <= SNAPSHOT_LIMITS.maxEvents && EVENT_NAME_RE.test(name) ? name : '?';
    const groups = hooks[name];
    let n = 0;
    if (Array.isArray(groups)) for (const g of groups) { const list = own(g, 'hooks'); if (Array.isArray(list)) n += list.length; }
    counts[key] = (counts[key] ?? 0) + n;
    total += n;
  }
  return { hookEvents: canonicalJson(counts), hooksSha, hookEventCount: Object.keys(counts).length, hookCount: total };
}

// -> { hookEvents, hooksSha, hookEventCount, hookCount, model, advisorModel }; only the three keys are read.
export function readSettingsFacts(configDir) {
  const settings = parseJson(readCapped(join(configDir, 'settings.json'), SNAPSHOT_LIMITS.settingsMaxBytes));
  if (!isObject(settings)) {
    return { hookEvents: null, hooksSha: null, hookEventCount: null, hookCount: null, model: null, advisorModel: null };
  }
  const hooks = Object.hasOwn(settings, 'hooks') ? settings.hooks : {};
  const model = own(settings, 'model');
  const advisor = own(settings, 'advisorModel');
  return {
    ...hookFacts(hooks),
    model: typeof model === 'string' && MODEL_RE.test(model) ? model : null,
    advisorModel: typeof advisor === 'string' && MODEL_RE.test(advisor) ? advisor : null,
  };
}

export function readBaseSha(env = {}) {
  const file = env?.[INSTALLED_BASE_ENV];
  if (typeof file !== 'string' || file === '' || !isAbsolute(file)) return null;
  const sha = own(parseJson(readCapped(file, SNAPSHOT_LIMITS.baseFileMaxBytes)), 'sha');
  return typeof sha === 'string' && SHA_RE.test(sha) ? sha : null;
}

export function readLocalModsHead(env = {}, { run = defaultRun } = {}) {
  const dir = env?.[LOCAL_MODS_ENV];
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) return null;
  let real;
  try {
    real = realpathSync(dir);
    if (!statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  const r = run(['-C', real, '-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD'], { env: childEnv({ ceiling: dirname(real) }) });
  if (!r || r.errorCode || r.status !== 0) return null;
  const head = String(r.stdout).trim();
  return SHA_RE.test(head) ? head : null;
}

// -> { row, line }: row holds every env_snapshot column but run_id; line the eight values the ingest `env:` line
// prints (NULL stays null: the command prints `?`).
export function takeSnapshot({ home, env = {}, now = () => new Date(), run } = {}) {
  const configDir = configDirOf({ home, env });
  const version = readGsdVersion(configDir);
  const s = readSettingsFacts(configDir);
  const baseSha = readBaseSha(env);
  const head = readLocalModsHead(env, run ? { run } : {});
  const row = {
    taken_utc: now().toISOString(),
    gsd_version: version.value,
    gsd_version_source: version.source,
    base_sha: baseSha,
    local_mods_head: head,
    hooks_sha: s.hooksSha,
    hook_events: s.hookEvents,
    model_default: s.model,
    advisor_model: s.advisorModel,
  };
  const line = {
    gsd_version: version.value,
    gsd_version_source: version.source,
    base_sha: baseSha === null ? null : baseSha.slice(0, 12),
    local_mods_head: head === null ? null : head.slice(0, 12),
    hook_events: s.hookEventCount,
    hooks: s.hookCount,
    model_default: s.model,
    advisor_model: s.advisorModel,
  };
  return { row, line };
}

const COLUMNS = ['taken_utc', 'gsd_version', 'gsd_version_source', 'base_sha', 'local_mods_head', 'hooks_sha', 'hook_events',
  'model_default', 'advisor_model'];
const INSERT_SQL = `INSERT INTO env_snapshot (run_id, ${COLUMNS.join(', ')}) VALUES ($run_id, ${COLUMNS.map((c) => `$${c}`).join(', ')})
ON CONFLICT (run_id) DO NOTHING`;

// One row per run, written once, in its own BEGIN IMMEDIATE transaction (rolled back and rethrown on a SQLite error).
export function writeSnapshot({ db, runId, row }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(INSERT_SQL).run({ run_id: runId, ...Object.fromEntries(COLUMNS.map((c) => [c, row[c] ?? null])) });
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
    throw err;
  }
}
