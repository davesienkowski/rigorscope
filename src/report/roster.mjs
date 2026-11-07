// The roster drift check of `rigorscope doctor` (plan 03.1-04, ADPT-04, D-09, D-21, T-03.1-12): does the gsd-core copy that is
// available still agree with the roster of src/adapters/gsd-core/roster.json? The roster is a snapshot at a recorded ref and
// is not proven complete, so this is a lead for the owner, never a gate.
//
// Signals, in this order, and the first that applies answers:
//   1. A checkout named by the environment variable RIGORSCOPE_GSD_CORE_CHECKOUT (an absolute directory): the paths the roster
//      cites that changed between the roster ref and the checkout's HEAD, from `git diff --no-renames --name-only <ref> HEAD --
//      <cited paths>`. Each cited path is anchored at the top of the work tree (`:(top,literal)`), so a variable that names a
//      subdirectory of the checkout evaluates the same set as the top and never answers a silent `changed:0` (CR-01); no rename
//      detection, so the user's diff.renames setting never applies and a blobless clone has no blob to fetch for it (WR-02).
//      Read only: an args array, the repository-location variables stripped and a timeout by the runner (the adapter's
//      defaultGitRun), nothing executed from the checkout and no file of it read except through git. When the variable is set
//      and the checkout cannot answer, the drift is unknown with the reason; the installed version is not used instead.
//   2. The installed version recorded by the latest ingest's environment snapshot (`gsd_version`) against the roster version.
//   3. Otherwise unknown, with the reason.
// Never a hash of an installed file (measured unreliable: the installer rewrites content and local patches change it) and no
// path in this module. Unknown is a value of the section, not a finding.
import { isAbsolute } from 'node:path';
import { loadRoster, notLookedFor } from '../adapters/gsd-core/roster.mjs';
import { defaultGitRun, gitArgs } from '../adapters/gsd-core/signals.mjs';

export const CHECKOUT_ENV = 'RIGORSCOPE_GSD_CORE_CHECKOUT';
const MAX_ENV_CHARS = 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
const VERSION_RE = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?)$/;
const compareBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const answered = (r) => r !== null && typeof r === 'object' && r.errorCode === null && r.status === 0 && typeof r.stdout === 'string';

// The value of the checkout variable: a string, an absolute path by the rules of the host platform (node:path), no control
// character, at most MAX_ENV_CHARS. isAbs is a test seam (path.win32.isAbsolute checks a native Windows path on any host).
export const isCheckoutValue = (raw, isAbs = isAbsolute) => typeof raw === 'string' && raw !== '' && raw.length <= MAX_ENV_CHARS
  && !CONTROL.test(raw) && isAbs(raw);

const unknown = (reason, installed = null) => ({
  state: 'unknown', changed: null, installed_version: installed, reason,
});

// The roster paths a gsd-core checkout is asked about: every non-null cite_path, sorted bytewise and unique.
export function citedPaths(roster = loadRoster()) {
  return [...new Set(roster.entries.map((e) => e.cite_path).filter((p) => typeof p === 'string'))].sort(compareBytes);
}

// dir: an absolute directory named by the environment. -> the drift of the checkout.
function checkoutDrift(dir, roster, run) {
  const cited = citedPaths(roster);
  const diff = run(gitArgs(dir, ['diff', '--no-renames', '--name-only', roster.ref, 'HEAD', '--', ...cited.map((p) => `:(top,literal)${p}`)]));
  if (answered(diff)) {
    const closed = new Set(cited);
    const changed = [...new Set(diff.stdout.split('\n').map((l) => l.trim()).filter((l) => closed.has(l)))].sort(compareBytes);
    return {
      state: 'changed', changed, installed_version: null, reason: null,
    };
  }
  // Why it failed: not a repository or git itself failing, or a repository without the roster ref (a shallow clone).
  if (!answered(run(gitArgs(dir, ['rev-parse', '--git-dir'])))) return unknown('checkout_unusable');
  if (!answered(run(gitArgs(dir, ['cat-file', '-e', `${roster.ref}^{commit}`])))) return unknown('ref_not_in_checkout');
  return unknown('checkout_unusable');
}

// db: the open read-only store.db handle, or null when there is none.
function installedDrift(db, roster) {
  if (db === null || db === undefined) return unknown('no_store');
  let row;
  try {
    row = db.prepare('SELECT gsd_version AS v FROM env_snapshot ORDER BY run_id DESC LIMIT 1').get();
  } catch {
    row = undefined;
  }
  if (row === undefined || row === null || row.v === null || row.v === undefined) return unknown('no_installed_version');
  const m = typeof row.v === 'string' ? VERSION_RE.exec(row.v) : null;
  if (m === null) return unknown('installed_version_unreadable');
  const installed = m[1];
  const same = installed === roster.version;
  return {
    state: same ? 'same_version' : 'version_differs', changed: null, installed_version: installed, reason: null,
  };
}

// env: the process environment as the command received it; db: the read-only store handle or null; run: a git runner
// run(args) -> { status, stdout, errorCode } that never throws (a test seam; default the adapter's defaultGitRun).
// -> { ref (12 hex), version, entries, not_looked_for: { root, path_glob, no_scanned_scope }, drift: { state, changed,
// installed_version, reason } } with state 'changed' (checkout: changed is the sorted cited paths that differ, possibly none),
// 'version_differs', 'same_version' or 'unknown' (changed null, reason one of env_invalid, checkout_unusable,
// ref_not_in_checkout, no_store, no_installed_version, installed_version_unreadable).
export function checkRoster({ env = {}, db = null, run = defaultGitRun } = {}) {
  const roster = loadRoster();
  const nl = notLookedFor();
  const raw = env?.[CHECKOUT_ENV];
  let drift;
  if (typeof raw === 'string' && raw !== '') {
    drift = isCheckoutValue(raw) ? checkoutDrift(raw, roster, run) : unknown('env_invalid');
  } else {
    drift = installedDrift(db, roster);
  }
  return {
    ref: roster.ref.slice(0, 12),
    version: roster.version,
    entries: roster.entries.length,
    not_looked_for: { root: nl.root.length, path_glob: nl.path_glob.length, no_scanned_scope: nl.no_scanned_scope.length },
    drift,
  };
}
