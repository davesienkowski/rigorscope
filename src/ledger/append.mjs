// The ledger appender (plan 03-01, D-01, T-03-02, T-03-04). The ledger is one file, <HOME>/.rigorscope/ledger/units.jsonl,
// written only by this function: one write of one LF-terminated line to a descriptor opened O_APPEND, so concurrent callers
// never interleave. Lines are never rewritten, truncated or deleted here. The directory is 0700 and the file 0600 (a wider
// existing mode is narrowed); a symlinked or non-directory `ledger`, a symlinked ledger file and a file that is not a
// regular file are refused with a StateDirError (exit 1) whose message holds no path. Nothing here opens a database.
import {
  closeSync, constants, chmodSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { StateDirError, ensureStateDir, stateDir } from '../db.mjs';

export const LEDGER_DIR = 'ledger';
export const LEDGER_FILE = 'units.jsonl';
const LINK_MESSAGE = 'the ledger directory or file is a symlink or not the expected kind; refusing to use it';
const WRITE_MESSAGE = 'the ledger file could not be written; nothing was appended or the line may be partial';
const STATE_MESSAGE = 'ledger: cannot write the state directory';
const REFUSED = new Set(['ELOOP', 'ENOTDIR', 'EISDIR', 'EMLINK']);

export const ledgerPath = (home) => join(stateDir(home), LEDGER_DIR, LEDGER_FILE);

// ensureStateDir's own refusals (a symlinked state directory) are StateDirErrors already; any other failure of it
// (an unwritable HOME, a read-only state directory) becomes one fixed message with no code and no path.
function stateDirOrThrow(home) {
  try {
    return ensureStateDir(home);
  } catch (err) {
    if (err instanceof StateDirError) throw err;
    throw new StateDirError(STATE_MESSAGE);
  }
}

function ensureLedgerDir(home) {
  const dir = join(stateDirOrThrow(home), LEDGER_DIR);
  let st = null;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new StateDirError(WRITE_MESSAGE);
  }
  if (st === null) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw new StateDirError(WRITE_MESSAGE);
      return ensureLedgerDirAgain(dir);
    }
    return dir;
  }
  return checkDir(dir, st);
}

function ensureLedgerDirAgain(dir) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new StateDirError(WRITE_MESSAGE);
  }
  return checkDir(dir, st);
}

function checkDir(dir, st) {
  if (st.isSymbolicLink() || !st.isDirectory()) throw new StateDirError(LINK_MESSAGE);
  if ((st.mode & 0o077) !== 0) {
    try { chmodSync(dir, 0o700); } catch { throw new StateDirError(WRITE_MESSAGE); }
  }
  return dir;
}

// Appends `text` (one LF-terminated, already validated line) and returns the number of bytes written. When the file is
// not empty and its last byte is not LF (a torn tail from an earlier short write), the same single write starts with a
// LF, so the new line is never glued to the torn bytes. O_NONBLOCK keeps an open of a FIFO from waiting for a reader
// (it has no effect on a regular file); the fstat below then refuses anything that is not a regular file.
export function appendLine(home, text) {
  const dir = ensureLedgerDir(home);
  const flags = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(join(dir, LEDGER_FILE), flags, 0o600);
  } catch (err) {
    throw new StateDirError(REFUSED.has(err.code) ? LINK_MESSAGE : WRITE_MESSAGE);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new StateDirError(LINK_MESSAGE);
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
    let torn = false;
    if (st.size > 0) {
      const last = Buffer.alloc(1);
      torn = readSync(fd, last, 0, 1, st.size - 1) === 1 && last[0] !== 0x0a;
    }
    const buf = Buffer.from(torn ? `\n${text}` : text, 'utf8');
    const n = writeSync(fd, buf);
    if (n !== buf.length) throw new StateDirError(WRITE_MESSAGE);
    return n;
  } catch (err) {
    if (err instanceof StateDirError) throw err;
    throw new StateDirError(WRITE_MESSAGE);
  } finally {
    closeSync(fd);
  }
}
