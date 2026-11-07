#!/usr/bin/env node
// Snapshot of the gsd-core collector's metadata for the golden units (plan 02-03, TRUST-10, Pitfall 8, D-24).
//
// The golden units live in other repositories on the labeler's machine, so the suite cannot read them. This script
// is run by hand with explicit repo roots; it writes what the collector (src/adapters/gsd-core/signals.mjs) reads for
// each unit named in a manifest, and the file is reviewed and committed under test/golden/inputs/. The golden tests
// then score the pure rules from the committed file, hermetically.
//
//   node scripts/golden-inputs.mjs --manifest <manifest.json> --out <inputs.jsonl> <repo root> [<repo root> ...]
//
// Manifest: { "schema": "rigorscope.golden-manifest/1", "units": [{ "repo", "kind": "quick" | "plan", "native_id" }] }.
// A root is any directory inside a git working tree; its repo name is the basename of its main working tree (the
// common dir's parent), and its main working tree is what is read. Output, schema rigorscope.golden-inputs/1, one JSON
// object per line, rows sorted bytewise by repo, kind and native_id:
//   located: { schema, repo, kind, native_id, located: true, dir_rel, git, artifacts, files_modified, commits,
//              dropped_paths }
//   missing: { schema, repo, kind, native_id, located: false, reason: unit_not_found | repo_not_given }
// Metadata only: tier letters and the places they were read from, repo-relative or `~/` paths, epoch-ms commit
// times, commit shas and per-file statuses. No file text, commit subject or body, author or committer identity, or
// absolute path is written. It reads only the manifest, the named roots' `.planning/` files and their git history,
// never a golden label file and never rigorscope's state directory, and makes no network call. The output is written
// to a temporary file beside --out and renamed into place.
//
// Exit 0 on success; 2 on a usage error (one fixed stderr line, never a path); 1 when the output cannot be written.
import { lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { mainTreeOf } from '../src/adapters/gsd-core/index.mjs';
import { artifactCommitIndex, collectUnitSignals } from '../src/adapters/gsd-core/signals.mjs';
import { resolveDir } from '../src/units/repo-resolve.mjs';

const SCHEMA = 'rigorscope.golden-inputs/1';
const MANIFEST_SCHEMA = 'rigorscope.golden-manifest/1';
const MAX_UNITS = 1000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_RE = { quick: /^\d{6}-[a-z0-9]{3}$/, plan: /^\d{2,3}(?:\.\d{1,3})?-\d{2,3}$/ };

class UsageError extends Error {}
const usage = (message) => { throw new UsageError(message); };
const compareBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const compareUnits = (a, b) => compareBytes(a.repo, b.repo) || compareBytes(a.kind, b.kind) || compareBytes(a.native_id, b.native_id);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keysExactly = (obj, keys) => Object.keys(obj).length === keys.length && keys.every((k) => Object.hasOwn(obj, k));

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, options: { manifest: { type: 'string' }, out: { type: 'string' } }, allowPositionals: true, strict: true,
    });
  } catch {
    usage('unknown option or missing option value');
  }
  const { values, positionals } = parsed;
  if (typeof values.manifest !== 'string' || values.manifest === '') usage('--manifest is required');
  if (typeof values.out !== 'string' || values.out === '') usage('--out is required');
  if (positionals.length === 0) usage('at least one repo root is required');
  return { manifest: values.manifest, out: values.out, roots: positionals };
}

function readManifest(file) {
  let obj;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) usage('the manifest cannot be read');
    obj = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err instanceof UsageError) throw err;
    usage('the manifest cannot be read');
  }
  if (!isPlainObject(obj) || !keysExactly(obj, ['schema', 'units']) || obj.schema !== MANIFEST_SCHEMA) usage('the manifest has the wrong shape');
  if (!Array.isArray(obj.units) || obj.units.length > MAX_UNITS) usage('the manifest has the wrong shape');
  const seen = new Set();
  const units = [];
  for (const u of obj.units) {
    if (!isPlainObject(u) || !keysExactly(u, ['repo', 'kind', 'native_id'])) usage('a manifest entry has the wrong shape');
    if (typeof u.repo !== 'string' || !REPO_RE.test(u.repo)) usage('a manifest entry has a bad repo name');
    if (!Object.hasOwn(ID_RE, u.kind)) usage('a manifest entry has a bad kind');
    if (typeof u.native_id !== 'string' || !ID_RE[u.kind].test(u.native_id)) usage('a manifest entry has a bad id');
    const key = `${u.repo}\u0000${u.kind}\u0000${u.native_id}`;
    if (seen.has(key)) usage('the manifest names a unit twice');
    seen.add(key);
    units.push({ repo: u.repo, kind: u.kind, native_id: u.native_id });
  }
  return units.sort(compareUnits);
}

// -> Map repo name -> main working tree.
function resolveRoots(roots, home) {
  const repos = new Map();
  for (const root of roots) {
    const abs = resolve(process.cwd(), root);
    let isDir = false;
    try { isDir = statSync(abs).isDirectory(); } catch { isDir = false; }
    if (!isDir) usage('a root is not a git working tree');
    const res = resolveDir(abs, { home });
    if (res.deferred) usage('git is unavailable');
    if (res.method !== 'git' || res.repoKey === null) usage('a root is not a git working tree');
    const top = mainTreeOf(res.repoKey, home);
    if (top === null) usage('a root has no main working tree');
    const name = res.repoName;
    if (typeof name !== 'string' || !REPO_RE.test(name)) usage('a root has an unusable repo name');
    if (repos.has(name)) usage('two roots name one repo');
    repos.set(name, top);
  }
  return repos;
}

function checkOut(out) {
  const abs = resolve(process.cwd(), out);
  let st = null;
  try { st = lstatSync(abs); } catch { st = null; }
  if (st !== null && !st.isFile()) usage('--out is not a regular file');
  let parent = false;
  try { parent = statSync(dirname(abs)).isDirectory(); } catch { parent = false; }
  if (!parent) usage('the --out directory does not exist');
  return abs;
}

function main(argv) {
  const home = process.env.HOME || homedir();
  const cli = parseCli(argv);
  const units = readManifest(resolve(process.cwd(), cli.manifest));
  const repos = resolveRoots(cli.roots, home);
  const out = checkOut(cli.out);

  const indexes = new Map();
  for (const name of [...repos.keys()].sort(compareBytes)) indexes.set(name, artifactCommitIndex({ top: repos.get(name) }));

  const counts = { units: 0, located: 0, notFound: 0, repoNotGiven: 0, dropped: 0 };
  const missingRepos = new Set();
  const lines = [];
  for (const u of units) {
    counts.units += 1;
    const head = { schema: SCHEMA, repo: u.repo, kind: u.kind, native_id: u.native_id };
    if (!repos.has(u.repo)) {
      counts.repoNotGiven += 1;
      missingRepos.add(u.repo);
      lines.push(JSON.stringify({ ...head, located: false, reason: 'repo_not_given' }));
      continue;
    }
    const row = collectUnitSignals({ top: repos.get(u.repo), kind: u.kind, nativeId: u.native_id, home, index: indexes.get(u.repo) });
    if (!row.located) {
      counts.notFound += 1;
      lines.push(JSON.stringify({ ...head, located: false, reason: row.reason }));
      continue;
    }
    counts.located += 1;
    counts.dropped += row.dropped_paths;
    lines.push(JSON.stringify({ ...head, ...row }));
  }

  const tmp = join(dirname(out), `.${basename(out)}.tmp-${process.pid}`);
  try {
    writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, out);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    process.stderr.write('golden-inputs: the snapshot could not be written\n');
    return 1;
  }
  process.stdout.write(`golden-inputs: units=${counts.units} located=${counts.located} repos=${repos.size} `
    + `not_found=${counts.notFound} repo_not_given=${counts.repoNotGiven} dropped_paths=${counts.dropped}\n`);
  if (missingRepos.size > 0) process.stdout.write(`golden-inputs: repos not given: ${[...missingRepos].sort(compareBytes).join(' ')}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`golden-inputs: ${err.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write('golden-inputs: unexpected failure\n');
    process.exitCode = 1;
  }
}
