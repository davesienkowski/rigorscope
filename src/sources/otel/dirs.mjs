// Directory resolution and listing for the OTel receiver files (D-03, T-01-27). Two directories:
//   live      HOOK_TELEMETRY_DIR when it is an absolute path, else ~/.local/share/hook-telemetry (an optional
//             integration: an absent default directory is "not_configured", not a fault)
//   preserve  ~/.local/share/rigorscope/preserve/hook-telemetry (rigorscope's own backed-up copy)
// Everything is a parameter (home, env): this module never reads process.env or os.homedir. It lists
// names and file types only and never opens a file. Display strings never hold an absolute path.
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { compareBytes } from '../transcript/roots.mjs';

export const OTEL_FILE_RE = /^(events|metrics)-\d{4}-\d{2}-\d{2}\.jsonl$/;

const overrideOf = (env) => {
  const v = env?.HOOK_TELEMETRY_DIR;
  return typeof v === 'string' && v !== '' && isAbsolute(v) ? v : null;
};

export const liveDir = (home, env) => overrideOf(env) ?? join(home, '.local', 'share', 'hook-telemetry');
export const preserveDir = (home) => join(home, '.local', 'share', 'rigorscope', 'preserve', 'hook-telemetry');

// -> { roots: [{ alias, kind, display, path }], skipped: [{ alias, display, reason }] }, live first.
export function discoverOtelRoots({ home, env = {} } = {}) {
  const candidates = [
    { alias: 'live', kind: 'live', path: liveDir(home, env), display: overrideOf(env) ? '$HOOK_TELEMETRY_DIR' : '~/.local/share/hook-telemetry' },
    { alias: 'preserve', kind: 'preserve', path: preserveDir(home), display: '~/.local/share/rigorscope/preserve/hook-telemetry' },
  ];
  const roots = [];
  const skipped = [];
  const seen = new Set();
  for (const c of candidates) {
    let real;
    try {
      real = realpathSync(c.path);
    } catch (err) {
      const missing = err.code === 'ENOENT' || err.code === 'ENOTDIR';
      const reason = missing ? (c.kind === 'live' && !overrideOf(env) ? 'not_configured' : 'absent') : 'unreadable';
      skipped.push({ alias: c.alias, display: c.display, reason });
      continue;
    }
    let isDir = false;
    try { isDir = statSync(real).isDirectory(); } catch { isDir = false; }
    if (!isDir) { skipped.push({ alias: c.alias, display: c.display, reason: 'not_directory' }); continue; }
    if (seen.has(real)) { skipped.push({ alias: c.alias, display: c.display, reason: 'duplicate' }); continue; }
    seen.add(real);
    roots.push({ alias: c.alias, kind: c.kind, display: c.display, path: real });
  }
  return { roots, skipped };
}

// -> { files: [{ name, abs }] in bytewise order, skipped: { name?, symlink?, not_regular? } }.
export function listOtelFiles(dir) {
  const files = [];
  const skipped = {};
  const skip = (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { files, skipped };
  }
  for (const name of names.sort(compareBytes)) {
    if (!OTEL_FILE_RE.test(name)) { skip('name'); continue; }
    let st;
    try { st = lstatSync(join(dir, name)); } catch { skip('not_regular'); continue; }
    if (st.isSymbolicLink()) skip('symlink');
    else if (!st.isFile()) skip('not_regular');
    else files.push({ name, abs: join(dir, name) });
  }
  return { files, skipped };
}
