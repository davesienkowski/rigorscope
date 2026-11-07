// Home-prefix normalization (RR-03, T-01-10). The OS user name rides in two places in a Claude Code
// transcript tree: the `cwd` field and the project directory name (the working directory with every
// non-alphanumeric character replaced by a dash). Both are rewritten before anything is stored:
//   the WSL home                          -> ~
//   a known Windows profile               -> ~win
//   any other user's home (Linux, macOS,
//   Windows, WSL mount forms)             -> ~other
// Residual, documented in docs/privacy.md: a mangled project directory name of ANOTHER user's home
// cannot be told from an ordinary name once mangled, so it is stored verbatim.

export const mangle = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-');

const CONTROL = /[\u0000-\u001f\u007f]/;
const NAME = /^[A-Za-z0-9._:-]{1,48}$/;
const VERSION = /^\d+(?:\.\d+){0,3}(?:-[A-Za-z0-9.]{1,16})?$/;

// A key or type name read from a file is stored only if it passes this shape; otherwise it goes
// into the question-mark bucket. Never a value, never an unchecked name.
export const safeName = (v) => (typeof v === 'string' && NAME.test(v) ? v : '?');
export const safeVersion = (v) => (typeof v === 'string' && VERSION.test(v) ? v : '?');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '(?=[\\\\/]|$)';

// Generic forms of someone else's home. Built from escapes so no absolute home path appears in this file.
const OTHER = [
  new RegExp(`^\\/home\\/[^/]+${SEP}`),
  new RegExp(`^\\/Users\\/[^/]+${SEP}`),
  new RegExp(`^\\/mnt\\/[a-zA-Z]\\/Users\\/[^/]+${SEP}`),
  new RegExp(`^[A-Za-z]:[\\\\/]Users[\\\\/][^\\\\/]+${SEP}`),
];

const EMPTY = Object.freeze({ cwd: [], project: [] });

// homeSet: { cwd: [{ re, repl }], project: [{ prefix, repl }] } built from the WSL home and the
// discovered Windows profiles ({ alias, user, usersDir }).
export function buildHomeSet({ home, windowsUsers = [] } = {}) {
  const cwd = [];
  const project = [];
  if (typeof home === 'string' && home.length > 1) {
    cwd.push({ re: new RegExp(`^${escapeRe(home.replace(/\/+$/, ''))}${SEP}`), repl: '~' });
    project.push({ prefix: mangle(home), repl: '~' });
  }
  for (const { user, usersDir } of windowsUsers) {
    if (typeof user !== 'string' || user === '') continue;
    const u = escapeRe(user);
    cwd.push({ re: new RegExp(`^[A-Za-z]:[\\\\/]Users[\\\\/]${u}${SEP}`, 'i'), repl: '~win' });
    cwd.push({ re: new RegExp(`^\\/mnt\\/[a-zA-Z]\\/Users\\/${u}${SEP}`, 'i'), repl: '~win' });
    project.push({ prefix: mangle(`C:\\Users\\${user}`), repl: '~win' });
    project.push({ prefix: mangle(`/mnt/c/Users/${user}`), repl: '~win' });
    if (typeof usersDir === 'string' && usersDir !== '') {
      cwd.push({ re: new RegExp(`^${escapeRe(usersDir.replace(/\/+$/, ''))}\\/${u}${SEP}`), repl: '~win' });
      project.push({ prefix: mangle(`${usersDir}/${user}`), repl: '~win' });
    }
  }
  return { cwd, project };
}

// Returns the normalized cwd, or null when the value is not a usable string (non-string, empty,
// a control character, or longer than 1024 characters).
export function normalizeCwd(value, homeSet = EMPTY) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || CONTROL.test(value)) return null;
  let best = null;
  for (const { re, repl } of homeSet.cwd) {
    const m = re.exec(value);
    if (m && (best === null || m[0].length > best.len)) best = { len: m[0].length, repl };
  }
  if (best === null) {
    for (const re of OTHER) {
      const m = re.exec(value);
      if (m) { best = { len: m[0].length, repl: '~other' }; break; }
    }
  }
  if (best === null) return value;
  return best.repl + value.slice(best.len).replace(/\\/g, '/');
}

// Replaces a leading mangled known home followed by a dash or the end of the name. A home that is
// only a prefix of a longer name is left alone.
export function normalizeProjectSegment(name, homeSet = EMPTY) {
  if (typeof name !== 'string') return name;
  let best = null;
  for (const { prefix, repl } of homeSet.project) {
    if ((name === prefix || name.startsWith(`${prefix}-`)) && (best === null || prefix.length > best.prefix.length)) {
      best = { prefix, repl };
    }
  }
  return best === null ? name : best.repl + name.slice(best.prefix.length);
}
