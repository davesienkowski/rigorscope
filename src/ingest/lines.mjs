// Byte-level line reader from an offset. Yields complete lines only (those ended by a newline), with
// the offset just past each newline, so a cursor can advance exactly to the last complete line.
//   - strips a trailing CR and, at offset 0, a UTF-8 BOM
//   - a line above maxLineBytes yields an oversized marker { oversized, head, size } holding at most
//     one chunk in memory: the rest of the line is discarded as it streams past
//   - the partial tail (bytes after the last newline) is never yielded; its size is reported through
//     opts.stats.pendingTailBytes
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export const MAX_LINE_BYTES = 32 * 1024 * 1024;
const HEAD_BYTES = 512;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function* readLinesFrom(path, start = 0, { maxLineBytes = MAX_LINE_BYTES, chunkBytes = 1024 * 1024, stats = {} } = {}) {
  const fd = openSync(path, 'r');
  try {
    // Never read past the size seen now: bytes appended during the read belong to the next run.
    const limit = fstatSync(fd).size;
    let pos = start;
    let lineStart = start;
    let parts = [];
    let partLen = 0;
    let over = false;
    let head = null;
    let size = 0;
    const append = (seg) => {
      if (over) { size += seg.length; return; }
      if (partLen + seg.length > maxLineBytes) {
        over = true;
        size = partLen + seg.length;
        head = Buffer.concat([...parts, seg]).subarray(0, HEAD_BYTES);
        parts = [];
        partLen = 0;
        return;
      }
      parts.push(seg);
      partLen += seg.length;
    };
    while (pos < limit) {
      const want = Math.min(chunkBytes, limit - pos);
      const chunk = Buffer.allocUnsafe(want);
      const n = readSync(fd, chunk, 0, want, pos);
      if (n <= 0) break;
      const data = n === want ? chunk : chunk.subarray(0, n);
      let i = 0;
      for (;;) {
        const j = data.indexOf(0x0a, i);
        if (j === -1) { append(data.subarray(i)); break; }
        append(data.subarray(i, j));
        const end = pos + j + 1;
        if (over) {
          yield { oversized: true, head, size, end };
        } else {
          let buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
          if (buf.length > 0 && buf[buf.length - 1] === 0x0d) buf = buf.subarray(0, buf.length - 1);
          if (lineStart === 0 && buf.length >= 3 && buf.subarray(0, 3).equals(BOM)) buf = buf.subarray(3);
          yield { buf, oversized: false, end };
        }
        parts = [];
        partLen = 0;
        over = false;
        head = null;
        size = 0;
        lineStart = end;
        i = j + 1;
      }
      pos += n;
    }
    stats.pendingTailBytes = over ? size : partLen;
    stats.pendingTail = over ? null : Buffer.concat(parts);
  } finally {
    closeSync(fd);
  }
}
