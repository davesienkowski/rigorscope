// Root discovery (D-03). Candidates, in alias order: claude (HOME/.claude), claude-contrib
// (HOME/.claude-contrib), env (CLAUDE_CONFIG_DIR when absolute and non-empty), then one profile per
// entry of the Windows users directory that has .claude/projects: win, win-2, win-3 ... in bytewise
// order of the directory name. Aliases are positional and never derived from a user name; display
// strings never hold an absolute path or a user name.
//
// Everything is a parameter (home, env, windowsUsersDir): this module never reads process.env or
// os.homedir, so tests are hermetic.
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const WINDOWS_USERS_ENV = 'RIGORSCOPE_WINDOWS_USERS_DIR';
// The WSL mount of the Windows Users directory. Written here once and nowhere else.
export const DEFAULT_WINDOWS_USERS_DIR = '/mnt/c/Users';

// The Windows users directory for an environment: unset gives the default constant, the empty string disables it.
// Shared by ingest and doctor so both apply one rule (plan 01-09).
export function windowsUsersDirFromEnv(env) {
  return Object.hasOwn(env ?? {}, WINDOWS_USERS_ENV) ? env[WINDOWS_USERS_ENV] : DEFAULT_WINDOWS_USERS_DIR;
}

export const compareBytes = (a, b) => Buffer.compare(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8'));

const isDir = (p) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};
const isRealDir = (p) => {
  try { const st = lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
};

function resolveRoot(path) {
  try {
    const real = realpathSync(path);
    return { real };
  } catch (err) {
    return { reason: err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'absent' : 'unreadable' };
  }
}

// defaultWindowsUsersDir is the value windowsUsersDirFromEnv gives when the environment names none; it is a parameter
// so tests can run the quiet-default rule on a host that does (WSL) or does not have the real mount.
export async function discoverRoots({ home, env = {}, windowsUsersDir = '', defaultWindowsUsersDir = DEFAULT_WINDOWS_USERS_DIR, explicit } = {}) {
  const candidates = [
    { alias: 'claude', path: join(home, '.claude'), display: '~/.claude', kind: 'home' },
    { alias: 'claude-contrib', path: join(home, '.claude-contrib'), display: '~/.claude-contrib', kind: 'home' },
  ];
  const cfg = env?.CLAUDE_CONFIG_DIR;
  if (typeof cfg === 'string' && cfg !== '' && isAbsolute(cfg)) {
    candidates.push({ alias: 'env', path: cfg, display: '$CLAUDE_CONFIG_DIR', kind: 'env' });
  }

  const skipped = [];
  const windowsUsers = [];
  if (typeof windowsUsersDir === 'string' && windowsUsersDir !== '') {
    let entries = null;
    try {
      entries = readdirSync(windowsUsersDir, { withFileTypes: true });
    } catch (err) {
      // The built-in default is a WSL mount; on a machine without it (native Linux, macOS) its absence is
      // expected and stays silent. A directory the user named through the environment is reported.
      const quietDefault = err.code === 'ENOENT' && windowsUsersDir === defaultWindowsUsersDir && !Object.hasOwn(env ?? {}, WINDOWS_USERS_ENV);
      if (!quietDefault) skipped.push({ display: '~win', reason: err.code === 'ENOENT' ? 'absent' : 'unreadable' });
    }
    if (entries) {
      const names = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name).sort(compareBytes);
      let n = 0;
      for (const user of names) {
        const dir = join(windowsUsersDir, user, '.claude');
        if (!isRealDir(dir) || !isRealDir(join(dir, 'projects'))) continue;
        n += 1;
        const alias = n === 1 ? 'win' : `win-${n}`;
        candidates.push({ alias, path: dir, display: `~${alias}/.claude`, kind: 'windows' });
        windowsUsers.push({ alias, user, usersDir: windowsUsersDir });
      }
    }
  }

  const discovered = [];
  const seen = new Map(); // realpath -> alias
  for (const c of candidates) {
    const res = resolveRoot(c.path);
    if (res.reason) { skipped.push({ alias: c.alias, display: c.display, reason: res.reason }); continue; }
    if (!isDir(res.real) || !isRealDir(join(res.real, 'projects'))) {
      skipped.push({ alias: c.alias, display: c.display, reason: 'no_projects' });
      continue;
    }
    if (seen.has(res.real)) { skipped.push({ alias: c.alias, display: c.display, reason: 'duplicate' }); continue; }
    seen.set(res.real, c.alias);
    discovered.push({ ...c, path: res.real });
  }

  const ignored = [];
  for (const r of discovered) {
    if (isRealDir(join(r.path, 'backups'))) ignored.push({ display: `${r.display}/backups` });
  }
  if (isRealDir(join(home, '.claude-backup'))) ignored.push({ display: '~/.claude-backup' });

  let roots = discovered;
  if (Array.isArray(explicit)) {
    roots = [];
    const used = new Set();
    let extra = 0;
    for (const p of explicit) {
      const res = resolveRoot(p);
      if (res.reason || !isDir(res.real)) { skipped.push({ display: 'explicit', reason: res.reason ?? 'no_projects' }); continue; }
      if (used.has(res.real)) continue;
      used.add(res.real);
      const match = discovered.find((d) => d.path === res.real);
      if (match) { roots.push({ ...match, kind: 'explicit' }); continue; }
      extra += 1;
      roots.push({ alias: `extra-${extra}`, path: res.real, display: `extra-${extra}`, kind: 'explicit' });
    }
  }
  return { roots, skipped, ignored, windowsUsers };
}
