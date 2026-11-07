// Cursor identity and the start-offset decision (DATA-03, TRUST-05).
//   - device and inode are read as BigInt and kept as TEXT: inodes on the Windows mount can exceed 2^53
//   - size and offset are JS numbers (exact below 2^53); mtime is truncated to whole milliseconds
//   - head and tail window hashes (first 32 hex of sha256 over HASH_WINDOW bytes) catch a rewrite that
//     keeps the size and the inode
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';

export const HASH_WINDOW = 4096;

export function statIdentity(path, { lstat = (p) => lstatSync(p, { bigint: true }) } = {}) {
  const st = lstat(path);
  if (!st.isFile()) {
    const err = new Error('not a regular file');
    err.code = 'ERR_NOT_REGULAR';
    throw err;
  }
  return {
    dev: String(st.dev),
    ino: String(st.ino),
    size: Number(st.size),
    mtimeMs: Number(st.mtimeNs / 1_000_000n),
  };
}

export function windowHash(path, start, end) {
  const length = Math.max(0, end - start);
  const buf = Buffer.alloc(length);
  let got = 0;
  if (length > 0) {
    const fd = openSync(path, 'r');
    try {
      while (got < length) {
        const n = readSync(fd, buf, got, length - got, start + got);
        if (n <= 0) break;
        got += n;
      }
    } finally {
      closeSync(fd);
    }
  }
  return createHash('sha256').update(buf.subarray(0, got)).digest('hex').slice(0, 32);
}

const value = (h) => (typeof h === 'function' ? h() : h);

// stored: the source_file row (or null); current: statIdentity of the file now; hashes: { head, tail },
// each a string or a function, the CURRENT hash of the windows the stored cursor covers (a function is
// called only when the answer needs it).
export function decideStart(stored, current, hashes) {
  if (!stored) return { start: 0, reason: 'new' };
  if (stored.dev !== current.dev || stored.ino !== current.ino) return { start: 0, reason: 'replaced' };
  if (current.size < stored.offset) return { start: 0, reason: 'truncated' };
  if (value(hashes.head) !== stored.head_hash || value(hashes.tail) !== stored.tail_hash) return { start: 0, reason: 'rewritten' };
  if (stored.state === 'reading') return { start: stored.offset, reason: 'appended' };
  return { start: stored.offset, reason: current.size === stored.size ? 'unchanged' : 'appended' };
}
