// Byte-preserving scrub of rigorscope's own preserve copy of the OTel files (D-05, DATA-06, T-01-24,
// T-01-25). Rule sets: the default removes exactly tool_parameters, tool_input and error (D-05); the
// opt-in full set also removes prompt, prompt_text, response, vcs.ref.head.name, terminal.type and every
// user.* and organization.* key.
//
// Guarantees:
//   - a line that loses nothing is written back as its original bytes, terminator included (CRLF, BOM,
//     blank lines, a last line without a newline); only a line that lost a key is re-serialized, with
//     the order of its other keys intact
//   - a line that cannot be parsed is kept verbatim, unless its text holds a double-quoted key of the
//     active rule set: then it is dropped (fail closed), because a truncated line may still carry the value
//   - a line above the size cap is dropped and counted, never held in memory
//   - a file that needs no change is never opened for writing; a changed file is written to a 0600 temp
//     file in the same directory and renamed over the original, the temp file removed on any error
//   - only regular, non-symlink files named events-YYYY-MM-DD.jsonl or metrics-YYYY-MM-DD.jsonl directly
//     inside the given directory are considered; this module takes the directory as a parameter and has no
//     other target, so the live receiver directory is never reachable from here
import { closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  IDENTITY_PREFIXES, SCRUB_DEFAULT_KEYS, SCRUB_FULL_KEYS,
} from '../sources/otel/allowlist.mjs';
import { listOtelFiles } from '../sources/otel/dirs.mjs';

export const MAX_SCRUB_LINE_BYTES = 8388608;
const CHUNK_BYTES = 1024 * 1024;
const EMPTY = Buffer.alloc(0);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export class ScrubDirError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ScrubDirError';
    this.code = code;
  }
}

export function ruleSet(full) {
  return full
    ? { name: 'full', keys: [...SCRUB_FULL_KEYS, 'terminal.type'], prefixes: [...IDENTITY_PREFIXES] }
    : { name: 'default', keys: [...SCRUB_DEFAULT_KEYS], prefixes: [] };
}
const asRules = (r) => (r === 'full' ? ruleSet(true) : (r === undefined || r === 'default' ? ruleSet(false) : r));

// The fixed rule name of a key, or null: an exact key is its own name, a prefix match is `prefix*`.
function ruleOf(key, rules) {
  if (rules.keys.includes(key)) return key;
  const p = rules.prefixes.find((x) => key.startsWith(x));
  return p === undefined ? null : `${p}*`;
}

function hasQuotedKey(text, rules) {
  return rules.keys.some((k) => text.includes(`"${k}"`)) || rules.prefixes.some((p) => text.includes(`"${p}`));
}

const keepResult = (bytes, reason) => ({ action: 'keep', bytes, removed: {}, reason });

// One line without its terminator -> { action, bytes, removed, reason }.
export function scrubLine(bytes, rules) {
  const r = asRules(rules);
  const text = bytes.toString('utf8');
  if (text.trim() === '') return keepResult(bytes, 'blank');
  let obj;
  try {
    obj = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    obj = undefined;
  }
  if (!isObject(obj)) {
    if (hasQuotedKey(text, r)) return { action: 'drop', bytes: EMPTY, removed: {}, reason: 'unparseable_dropped' };
    return keepResult(bytes, 'unparseable_kept');
  }
  const removed = {};
  for (const container of [obj, isObject(obj.attrs) ? obj.attrs : null, isObject(obj.resource) ? obj.resource : null]) {
    if (container === null) continue;
    for (const key of Object.keys(container)) {
      const rule = ruleOf(key, r);
      if (rule === null) continue;
      delete container[key];
      removed[rule] = (removed[rule] ?? 0) + 1;
    }
  }
  if (Object.keys(removed).length === 0) return keepResult(bytes, 'clean');
  return { action: 'rewrite', bytes: Buffer.from(JSON.stringify(obj), 'utf8'), removed, reason: 'rewritten' };
}

// Streams the lines of a file: { buf, term, oversized }. term is '\n', '\r\n' or '' (a last line without a newline).
function* iterLines(path, maxLineBytes) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let pos = 0;
    let parts = [];
    let len = 0;
    let over = false;
    const add = (seg) => {
      if (over) { len += seg.length; return; }
      if (len + seg.length > maxLineBytes) { over = true; parts = []; len += seg.length; return; }
      parts.push(Buffer.from(seg));
      len += seg.length;
    };
    while (pos < size) {
      const n = readSync(fd, chunk, 0, Math.min(CHUNK_BYTES, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const view = chunk.subarray(0, n);
      let i = 0;
      while (i < n) {
        const j = view.indexOf(0x0a, i);
        if (j === -1) { add(view.subarray(i)); break; }
        add(view.subarray(i, j));
        if (over) {
          yield { buf: EMPTY, term: '\n', oversized: true };
        } else {
          let buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
          let term = '\n';
          if (buf.length > 0 && buf[buf.length - 1] === 0x0d) { buf = buf.subarray(0, buf.length - 1); term = '\r\n'; }
          yield { buf, term, oversized: false };
        }
        parts = [];
        len = 0;
        over = false;
        i = j + 1;
      }
    }
    if (over) yield { buf: EMPTY, term: '', oversized: true };
    else if (len > 0) yield { buf: parts.length === 1 ? parts[0] : Buffer.concat(parts), term: '', oversized: false };
  } finally {
    closeSync(fd);
  }
}

// One pass over a file. With `out` (a writer) the kept and rewritten lines are written too.
function passOver(path, name, rules, maxLineBytes, out) {
  const st = {
    name, lines: 0, rewritten: 0, dropped: 0, oversizedDropped: 0, unparseableKept: 0, removed: {}, changed: false,
  };
  for (const line of iterLines(path, maxLineBytes)) {
    st.lines += 1;
    if (line.oversized) {
      st.dropped += 1;
      st.oversizedDropped += 1;
      st.changed = true;
      continue;
    }
    const res = scrubLine(line.buf, rules);
    for (const [k, n] of Object.entries(res.removed)) st.removed[k] = (st.removed[k] ?? 0) + n;
    if (res.action === 'drop') {
      st.dropped += 1;
      st.changed = true;
      continue;
    }
    if (res.action === 'rewrite') { st.rewritten += 1; st.changed = true; }
    if (res.reason === 'unparseable_kept') st.unparseableKept += 1;
    if (out) {
      out.write(res.bytes);
      if (line.term) out.write(Buffer.from(line.term));
    }
  }
  return st;
}

function rewriteFile(abs, name, dir, rules, maxLineBytes, beforeRename) {
  const temp = join(dir, `.scrub-${process.pid}-${randomBytes(6).toString('hex')}-${name}`);
  let fd = null;
  try {
    fd = openSync(temp, 'wx', 0o600);
    fchmodSync(fd, 0o600);
    const fdLocal = fd;
    const stats = passOver(abs, name, rules, maxLineBytes, { write: (b) => { if (b.length > 0) writeSync(fdLocal, b); } });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (beforeRename) beforeRename({ temp, file: abs });
    renameSync(temp, abs);
    return stats;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    rmSync(temp, { force: true }); // gone after a successful rename; removes the partial file on any error
  }
}

export function scrubPreserveDir({ dir, apply = false, full = false, beforeRename, maxLineBytes = MAX_SCRUB_LINE_BYTES } = {}) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new ScrubDirError('the preserve directory does not exist', 'absent');
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new ScrubDirError('the preserve directory is a symlink or not a directory; refusing to use it', 'refused');
  }
  const rules = ruleSet(full);
  const { files: found, skipped } = listOtelFiles(dir);
  const files = [];
  for (const f of found) {
    const first = passOver(f.abs, f.name, rules, maxLineBytes, null); // read-only pass decides whether anything changes
    if (apply && first.changed) files.push(rewriteFile(f.abs, f.name, dir, rules, maxLineBytes, beforeRename));
    else files.push(first);
  }
  const totals = {
    files: files.length,
    changedFiles: files.filter((f) => f.changed).length,
    unchangedFiles: files.filter((f) => !f.changed).length,
    lines: 0, rewritten: 0, dropped: 0, oversizedDropped: 0, unparseableKept: 0, removed: {},
  };
  for (const f of files) {
    for (const k of ['lines', 'rewritten', 'dropped', 'oversizedDropped', 'unparseableKept']) totals[k] += f[k];
    for (const [k, n] of Object.entries(f.removed)) totals.removed[k] = (totals.removed[k] ?? 0) + n;
  }
  return { files, skipped, totals, applied: apply, rules: rules.name };
}
