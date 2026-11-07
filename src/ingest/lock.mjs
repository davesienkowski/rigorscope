// The ingest lock file (D-13, DATA-04): HOME/.rigorscope/ingest.lock, created exclusively (mode 0600)
// inside the 0700 state directory, holding one JSON line with the pid, the start time and, on Linux,
// the process start token (field 22 of /proc/PID/stat) so a reused pid is told from the holder.
//   - a live holder: acquired false, nothing touched
//   - a dead holder, or a live pid whose start token differs: stale, taken over under the takeover guard
//     (plan 01-11, WR-04): the guard file ingest.lock.takeover is created exclusively, the lock is re-read
//     and re-judged while it is held, and only a lock that is still stale is unlinked and re-created; so two
//     processes that judged the same stale lock never both acquire it (losing any race counts as held).
//     A guard older than TAKEOVER_GUARD_MAX_AGE_MS or holding a dead pid is a crash leftover and is removed;
//     a young guard of a live pid means another takeover is in progress. The guard is always removed after
//     the takeover. Test seam (undocumented): onJudgedStale({ path }) is called after the stale judgment
//     and before the guard is taken.
//   - empty or unparseable content: held when younger than 60 seconds, stale after
//   - a symlink at the lock path is refused without writing through it
//   - released only when the file carries the caller's pid; withLock releases on success, on error
//     and on SIGTERM / SIGINT
// withLock signal modes (plan 01-11): `exit` (the default) releases the lock and exits 143 (SIGTERM) or 130
// (SIGINT) from the handler; `flag` only records the signal on handle.stopSignal, and the caller stops at its
// next safe point by throwing InterruptError (the ingest runner does this at every chunk boundary).
import {
  closeSync, constants, lstatSync, openSync, readFileSync, unlinkSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureStateDir, stateDir } from '../db.mjs';

export class LockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockError';
  }
}

// Thrown by the ingest runner at a chunk boundary after a signal recorded in `flag` mode. code is the signal
// name, exitCode the conventional 128 + signal number.
export const SIGNAL_EXIT = { SIGTERM: 143, SIGINT: 130 };
export class InterruptError extends Error {
  constructor(signal) {
    super(`interrupted by ${signal}`);
    this.name = 'InterruptError';
    this.code = signal;
    this.exitCode = SIGNAL_EXIT[signal] ?? 1;
  }
}

const YOUNG_MS = 60_000;
export const TAKEOVER_GUARD_MAX_AGE_MS = 10_000;
export const TAKEOVER_GUARD_SUFFIX = '.takeover';
export const lockPath = (home) => join(stateDir(home), 'ingest.lock');

export function procStartToken(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'latin1');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19] ?? '';
  } catch {
    return '';
  }
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function tryCreate(path, body) {
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    if (err.code === 'ELOOP') throw new LockError('the lock path is a symlink; refusing to use it');
    throw err;
  }
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  return true;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Reads the lock: null when it is gone, else { st, holder } (holder null for empty or unparseable content).
function inspect(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new LockError('the lock path is a symlink or not a file; refusing to use it');
  let holder = null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && Number.isSafeInteger(parsed.pid)) holder = parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    /* unparseable content is judged by its age */
  }
  return { st, holder };
}

// The one stale judgment, used before and during a takeover.
function isStale({ st, holder }, { now, isAlive, startToken }) {
  if (holder) {
    const token = isAlive(holder.pid) ? startToken(holder.pid) : null;
    return token === null || (Boolean(holder.proc_start) && Boolean(token) && token !== holder.proc_start);
  }
  return now().getTime() - st.mtimeMs >= YOUNG_MS;
}

// Removes a guard left by a crashed takeover (older than the age limit, or holding a dead pid). Returns true
// when the caller may try to create the guard again.
function clearLeftoverGuard(guard, { now, isAlive }) {
  let st;
  let pidText;
  try {
    st = lstatSync(guard);
    if (st.isSymbolicLink() || !st.isFile()) throw new LockError('the lock guard path is a symlink or not a file; refusing to use it');
    pidText = readFileSync(guard, 'utf8').trim();
  } catch (err) {
    if (err.code === 'ENOENT') return true; // released in between
    throw err;
  }
  const pid = /^[0-9]{1,10}$/.test(pidText) ? Number(pidText) : null;
  const old = now().getTime() - st.mtimeMs > TAKEOVER_GUARD_MAX_AGE_MS;
  const dead = pid !== null && !isAlive(pid);
  if (!old && !dead) return false;
  try {
    if (lstatSync(guard).ino !== st.ino) return false; // replaced by a live takeover in between
    unlinkSync(guard);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return true;
}

// The guarded takeover. Returns { acquired, seen } (seen: the lock as read under the guard, null when gone).
function takeOver(path, body, judge, opts) {
  const guard = `${path}${TAKEOVER_GUARD_SUFFIX}`;
  const mark = `${opts.pid}\n`;
  if (!tryCreate(guard, mark)) {
    if (!clearLeftoverGuard(guard, opts) || !tryCreate(guard, mark)) return { acquired: false, seen: undefined };
  }
  try {
    const seen = inspect(path);
    if (seen && !judge(seen)) return { acquired: false, seen };
    if (seen) {
      try { unlinkSync(path); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    return { acquired: tryCreate(path, body()), seen };
  } finally {
    try {
      if (readFileSync(guard, 'utf8') === mark) unlinkSync(guard);
    } catch { /* already gone */ }
  }
}

export function acquireLock({
  home, now = () => new Date(), pid = process.pid, isAlive = defaultIsAlive, startToken = procStartToken, waitMs = 0,
  onJudgedStale,
}) {
  ensureStateDir(home);
  const path = lockPath(home);
  const t0 = Date.now();
  const body = () => `${JSON.stringify({ pid, started_utc: now().toISOString(), proc_start: startToken(pid) })}\n`;
  const judge = (seen) => isStale(seen, { now, isAlive, startToken });
  for (;;) {
    if (tryCreate(path, body())) return { acquired: true, handle: { path, pid }, waitedMs: Date.now() - t0 };
    let seen = inspect(path);
    if (seen === null) continue; // released between the create and the read
    if (judge(seen)) {
      if (onJudgedStale) onJudgedStale({ path });
      const res = takeOver(path, body, judge, { now, isAlive, pid });
      if (res.acquired) return { acquired: true, handle: { path, pid }, waitedMs: Date.now() - t0 };
      if (res.seen !== undefined) seen = res.seen ?? inspect(path) ?? seen;
    }
    if (Date.now() - t0 >= waitMs) {
      const holder = seen.holder;
      return {
        acquired: false,
        holder: { pid: holder ? holder.pid : null, started_utc: holder?.started_utc ?? null },
      };
    }
    sleep(50);
  }
}

export function releaseLock(handle) {
  try {
    const parsed = JSON.parse(readFileSync(handle.path, 'utf8'));
    if (parsed?.pid === handle.pid) unlinkSync(handle.path);
  } catch { /* already gone or not ours */ }
}

// Runs fn(handle) with the lock held. Returns { acquired: false, holder } without running fn when a
// live holder has it, else { acquired: true, value }. The third argument's onSignal is 'exit' (default) or 'flag'.
export async function withLock(opts, fn, { onSignal = 'exit' } = {}) {
  const got = acquireLock(opts);
  if (!got.acquired) return got;
  const handle = { ...got.handle, stopSignal: null };
  const listener = (signal) => () => {
    if (onSignal === 'flag') {
      handle.stopSignal = signal;
      return;
    }
    releaseLock(handle);
    process.exit(SIGNAL_EXIT[signal]);
  };
  const term = listener('SIGTERM');
  const int = listener('SIGINT');
  process.once('SIGTERM', term);
  process.once('SIGINT', int);
  try {
    const value = await fn(handle);
    return { acquired: true, value, waitedMs: got.waitedMs };
  } finally {
    process.removeListener('SIGTERM', term);
    process.removeListener('SIGINT', int);
    releaseLock(handle);
  }
}
