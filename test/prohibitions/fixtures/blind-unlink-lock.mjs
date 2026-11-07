// Known-bad fixture for test/prohibitions/lock-single-holder.test.mjs: a self-contained copy of the pre-01-11
// stale-lock takeover. It judges the lock stale, then unlinks it and creates its own without re-checking, so a
// rival that took the lock over in between loses it. Same option names as src/ingest/lock.mjs, including the
// onJudgedStale seam. Imports nothing from src/; creates the state directory itself.
import {
  closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

const YOUNG_MS = 60_000;

function isAliveDefault(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function tryCreate(path, body) {
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try { writeSync(fd, body); } finally { closeSync(fd); }
  return true;
}

export function acquireLock({
  home, now = () => new Date(), pid = process.pid, isAlive = isAliveDefault, startToken = () => '', waitMs = 0,
  onJudgedStale,
}) {
  const dir = join(home, '.rigorscope');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'ingest.lock');
  const t0 = Date.now();
  const body = () => `${JSON.stringify({ pid, started_utc: now().toISOString(), proc_start: startToken(pid) })}\n`;
  for (;;) {
    if (tryCreate(path, body())) return { acquired: true, handle: { path, pid } };
    let st;
    try { st = lstatSync(path); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    let holder = null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && Number.isSafeInteger(parsed.pid)) holder = parsed;
    } catch { /* unparseable */ }
    let stale;
    if (holder) {
      const token = isAlive(holder.pid) ? startToken(holder.pid) : null;
      stale = token === null || (Boolean(holder.proc_start) && Boolean(token) && token !== holder.proc_start);
    } else {
      stale = now().getTime() - st.mtimeMs >= YOUNG_MS;
    }
    if (stale) {
      if (onJudgedStale) onJudgedStale({ path });
      try { unlinkSync(path); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (tryCreate(path, body())) return { acquired: true, handle: { path, pid } };
    }
    if (Date.now() - t0 >= waitMs) return { acquired: false, holder: { pid: holder ? holder.pid : null } };
  }
}
