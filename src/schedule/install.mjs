// Plan and apply `schedule install` (plan 01-09, D-13, DATA-04, T-01-81). planInstall only reads. applyInstall stages
// temp files in the unit directory (mode 0600, then 0644), saves a differing destination as NAME.bak-STAMP, renames,
// removes any temp file in a finally block, and only then runs `systemctl --user daemon-reload` and
// `systemctl --user enable --now rigorscope-ingest.timer` (argument arrays, unless noSystemctl). The unit text comes
// only from the repo files: no flag or environment value enters it. Paths are printed through homeDisplay.
import {
  chmodSync, copyFileSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { diffLines } from './diff.mjs';
import { checkUnitNode, homeDisplay } from './node-check.mjs';
import { runSystemctl } from './systemctl.mjs';
import {
  CHECKOUT_SUBPATH, UNIT_NAMES, UNIT_TIMER, readRepoUnits, unitDir,
} from './units.mjs';

export { homeDisplay };

export class InstallError extends Error {
  constructor(message, { step = null, code = null } = {}) {
    super(message);
    this.name = 'InstallError';
    this.step = step;
    this.code = code;
  }
}

const HINTS = {
  node_missing: 'no node was found on the unit PATH; install Node 24.15 or newer into ~/.local/bin',
  node_below_floor: 'the node on the unit PATH is below 24.15.0; run: nvm install 24 && nvm alias default 24, then link it into ~/.local/bin',
  node_no_sqlite: 'the node on the unit PATH lacks the built-in sqlite module; use an official Node 24.15 or newer binary',
  node_unusable: 'the node on the unit PATH printed an unreadable version or could not be run',
  checkout_mismatch: 'the unit runs ~/repos/rigorscope; install from that checkout, or point ~/repos/rigorscope at this one',
  destination_symlink: 'a unit file path is a symlink; remove it or install over a regular file',
  destination_not_file: 'a unit file path is not a regular file; remove it and run again',
};
const NODE_CODES = { not_found: 'node_missing', below_floor: 'node_below_floor', no_sqlite: 'node_no_sqlite', unusable: 'node_unusable' };

const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };

// -> { ok, display }. Real paths are compared, so a symlink to the same checkout is ok.
export function checkoutCheck({ home, checkoutRoot }) {
  const link = join(home, CHECKOUT_SUBPATH);
  const want = realOf(link);
  const have = realOf(checkoutRoot);
  return { ok: want !== null && have !== null && want === have, display: homeDisplay(link, home) };
}

const refusal = (code) => ({ code, hint: HINTS[code] });

export function planInstall({ home, env = {}, checkoutRoot, run, nowMs }) {
  const repo = readRepoUnits();
  const dir = unitDir({ home, env });
  const node = checkUnitNode({ home, serviceText: repo.service, run });
  const checkout = checkoutCheck({ home, checkoutRoot });
  const refusals = [];
  if (node.status !== 'ok') refusals.push(refusal(NODE_CODES[node.status]));
  if (!checkout.ok) refusals.push(refusal('checkout_mismatch'));
  let dirSt = null;
  // The unit directory may itself be a symlink to a directory (dotfile setups); only a destination FILE may not be.
  try { dirSt = statSync(dir); } catch { dirSt = null; }
  if (dirSt && !dirSt.isDirectory()) refusals.push(refusal('destination_not_file'));
  const texts = { 'rigorscope-ingest.service': repo.service, [UNIT_TIMER]: repo.timer };
  const units = UNIT_NAMES.map((name) => {
    const dest = join(dir, name);
    const newText = texts[name];
    let st = null;
    try { st = lstatSync(dest); } catch { st = null; }
    if (st === null) return { name, dest, status: 'new', oldText: null, newText, diff: diffLines(null, newText) };
    if (st.isSymbolicLink()) { refusals.push(refusal('destination_symlink')); return { name, dest, status: 'blocked', oldText: null, newText, diff: [] }; }
    if (!st.isFile()) { refusals.push(refusal('destination_not_file')); return { name, dest, status: 'blocked', oldText: null, newText, diff: [] }; }
    const oldText = readFileSync(dest, 'utf8');
    if (oldText === newText) return { name, dest, status: 'unchanged', oldText, newText, diff: [] };
    return { name, dest, status: 'changed', oldText, newText, diff: diffLines(oldText, newText) };
  });
  return { home, dir, dirDisplay: homeDisplay(dir, home), node, checkout, units, refusals, nowMs };
}

const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');

function backupName(dir, name, nowMs) {
  const base = `${name}.bak-${stamp(nowMs)}`;
  let candidate = base;
  for (let n = 1; existsSync(join(dir, candidate)); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

export function applyInstall(plan, { run, noSystemctl = false, nowMs, beforeRename } = {}) {
  if (plan.refusals.length > 0) throw new InstallError('the plan holds refusals; nothing was written', { step: 'plan' });
  const dir = plan.dir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    try { chmodSync(dir, 0o755); } catch { /* best effort on the leaf */ }
  }
  const written = [];
  const backups = [];
  const staged = [];
  try {
    for (const u of plan.units) {
      if (u.status === 'unchanged') continue;
      const tmp = join(dir, `.rigorscope-ingest.${u.name}.tmp-${process.pid}`);
      staged.push(tmp);
      writeFileSync(tmp, u.newText, { mode: 0o600 });
      chmodSync(tmp, 0o644);
    }
    for (const u of plan.units) {
      if (u.status === 'unchanged') continue;
      const tmp = join(dir, `.rigorscope-ingest.${u.name}.tmp-${process.pid}`);
      if (beforeRename) beforeRename(u.name);
      // Decide at rename time: another process may have installed the same bytes since the plan was made.
      let current = null;
      try { current = readFileSync(u.dest, 'utf8'); } catch { current = null; }
      if (current !== null && current !== u.newText) {
        const bak = backupName(dir, u.name, nowMs);
        copyFileSync(u.dest, join(dir, bak), constants.COPYFILE_EXCL);
        backups.push(bak);
      }
      renameSync(tmp, u.dest);
      written.push(u.name);
    }
  } finally {
    for (const tmp of staged) rmSync(tmp, { force: true });
  }
  const steps = [];
  const stepList = [['daemon-reload', ['daemon-reload']], ['enable --now rigorscope-ingest.timer', ['enable', '--now', UNIT_TIMER]]];
  for (const [label, args] of stepList) {
    const step = `systemctl --user ${label}`;
    if (noSystemctl) { steps.push({ step, status: 'skipped' }); continue; }
    const r = runSystemctl(run, args);
    if (!r || r.code !== 0) throw new InstallError(`step failed: ${step}`, { step, code: r?.code ?? null });
    steps.push({ step, status: 'ok' });
  }
  return { written, backups, steps };
}
