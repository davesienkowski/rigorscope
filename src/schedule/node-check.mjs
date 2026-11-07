// The node a daily run will use, found through the unit's own PATH (plan 01-09, DATA-01, D-02, T-01-82). The PATH
// literal of the repo service file is split on colons first and %h is expanded per entry, so install and doctor walk the
// PATH systemd will use. The floor is decided by checkRuntime and NODE_FLOOR of src/preflight.mjs: no second version
// literal. Never process.execPath, never `which`, never a shell.
import { accessSync, constants, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { NODE_FLOOR, checkRuntime } from '../preflight.mjs';

const FLOOR_TEXT = `${NODE_FLOOR.major}.${NODE_FLOOR.minor}.0`;
const VERSION = /^v(\d+\.\d+\.\d+)$/;
// A constant program: exit 0 when the built-in sqlite module is available, 1 otherwise.
const SQLITE_PROBE = "process.exit(require('node:module').isBuiltin('node:sqlite') ? 0 : 1)";
const SYSTEM_PREFIXES = ['/usr/', '/bin/', '/opt/', '/snap/'];

// A path under HOME prints as ~/..., a system path stays, anything else prints as <other>/BASENAME.
export function homeDisplay(path, home) {
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  if (SYSTEM_PREFIXES.some((p) => path.startsWith(p))) return path;
  return `<other>/${basename(path)}`;
}

export function parseUnitPath(serviceText, home) {
  const line = String(serviceText).split('\n').find((l) => l.startsWith('Environment=PATH='));
  if (!line) return [];
  return line.slice('Environment=PATH='.length).trim().split(':').map((e) => e.replaceAll('%h', home));
}

export function resolveUnitNode({ dirs, fsOps = { statSync, accessSync } }) {
  for (const dir of dirs) {
    const p = join(dir, 'node');
    let st;
    try { st = fsOps.statSync(p, { throwIfNoEntry: false }); } catch { st = undefined; }
    if (!st || !st.isFile()) continue;
    try { fsOps.accessSync(p, constants.X_OK); } catch { continue; }
    return p;
  }
  return null;
}

// -> { status: ok | below_floor | no_sqlite | not_found | unusable, display, version, floor }
export function checkUnitNode({ home, serviceText, run, fsOps }) {
  const floor = FLOOR_TEXT;
  const path = resolveUnitNode({ dirs: parseUnitPath(serviceText, home), fsOps });
  if (path === null) return { status: 'not_found', display: null, version: null, floor };
  const display = homeDisplay(path, home);
  const unusable = () => ({ status: 'unusable', display, version: null, floor });
  const v = run(path, ['--version']);
  if (!v || v.code !== 0 || typeof v.stdout !== 'string') return unusable();
  const m = VERSION.exec(v.stdout.replace(/\n$/, ''));
  if (!m) return unusable();
  const version = `v${m[1]}`;
  if (!checkRuntime({ node: m[1], hasSqlite: true }).ok) return { status: 'below_floor', display, version, floor };
  const p = run(path, ['--no-warnings', '-e', SQLITE_PROBE]);
  if (!p || p.code === null || p.error) return unusable();
  if (!checkRuntime({ node: m[1], hasSqlite: p.code === 0 }).ok) return { status: 'no_sqlite', display, version, floor };
  return { status: 'ok', display, version, floor };
}
