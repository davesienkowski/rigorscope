// The bounded leading-frontmatter reader of the gsd-core adapter (plan 02-02, D-01 signal 1, D-02).
//
// A planning file is read only up to its first FRONTMATTER_MAX_BYTES bytes, only when it is a regular file (never
// through a symlink), and only its leading `---` block is looked at. Only the tier letter and the `files_modified:`
// path list (plan 02-03) leave this module: text after the letter, every other frontmatter key and the body never
// reach store.db, derived.db or any output. The paths are bounded here and normalized by the collector
// (src/adapters/gsd-core/signals.mjs) before anything keeps them.
import { closeSync, constants, lstatSync, openSync, readSync } from 'node:fs';

export const FRONTMATTER_MAX_BYTES = 65536;
export const FRONTMATTER_MAX_LINES = 400;

// The research rule (02-RESEARCH.md, tier-risk.mjs): a top-level `tier:` key whose value starts with A, B or C,
// optionally quoted, followed by a word boundary.
const TIER_RE = /^tier:\s*["']?([ABC])\b/;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

// -> the decoded head of a regular file, or null when the path is missing, a symlink or not a regular file. Other
// errors (EACCES, EPERM) are thrown for the caller to count.
export function readHead(abs) {
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
  if (!st.isFile()) return null;
  const fd = openSync(abs, constants.O_RDONLY | NO_FOLLOW);
  try {
    const buf = Buffer.alloc(Math.min(FRONTMATTER_MAX_BYTES, Math.max(0, st.size)));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// -> the lines between a leading `---` line and the next `---` line, or null when the text does not open with one or
// the block does not close within FRONTMATTER_MAX_LINES lines.
export function frontmatterLines(text) {
  if (typeof text !== 'string') return null;
  const lines = text.replace(/^﻿/, '').split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0].trimEnd() !== '---') return null;
  const out = [];
  for (let i = 1; i < lines.length && out.length <= FRONTMATTER_MAX_LINES; i += 1) {
    if (lines[i].trimEnd() === '---') return out;
    out.push(lines[i]);
  }
  return null;
}

// -> 'A', 'B', 'C' or null: the first top-level line matching the tier rule.
export function tierLetter(lines) {
  if (!Array.isArray(lines)) return null;
  for (const line of lines) {
    const m = TIER_RE.exec(line);
    if (m) return m[1];
  }
  return null;
}

export const FILES_MODIFIED_MAX_ITEMS = 500;
export const FILES_MODIFIED_MAX_CHARS = 512;

const FILES_KEY_RE = /^files_modified:(.*)$/;
const ITEM_RE = /^\s*-(?:\s+(.*)|\s*)$/;

// One scalar of a YAML list: a quoted value up to its closing quote, or a plain value with a trailing ` #` comment
// removed. -> the value, or null when it is empty.
function scalar(raw) {
  const t = raw.trim();
  if (t === '') return null;
  const q = t[0];
  if (q === '"' || q === "'") {
    const end = t.indexOf(q, 1);
    const v = end === -1 ? t.slice(1) : t.slice(1, end);
    return v === '' ? null : v;
  }
  const v = t.replace(/\s+#.*$/, '').trim();
  return v === '' || v.startsWith('#') ? null : v;
}

// Splits the inside of an inline `[a, "b", 'c']` list on commas outside quotes.
function inlineItems(inner) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// -> the `files_modified:` list of the frontmatter lines, or null when there is no top-level key (a line starting
// `files_modified:` at column 0) or its value is not a list. An inline `[a, b]` list or a block list of `-` items at
// any indent is read; a block list stops at the first line that is neither an item, a blank line nor a YAML comment
// line (`#` after optional indent; review WR-05: a comment between items is legal YAML). Quotes and a trailing
// space-hash comment are removed; at most FILES_MODIFIED_MAX_ITEMS items of at most FILES_MODIFIED_MAX_CHARS
// characters are kept (a longer item is dropped).
export function filesModified(lines) {
  if (!Array.isArray(lines)) return null;
  const at = lines.findIndex((l) => typeof l === 'string' && FILES_KEY_RE.test(l));
  if (at === -1) return null;
  const rest = FILES_KEY_RE.exec(lines[at])[1].trim();
  const raw = [];
  if (rest.startsWith('[')) {
    const close = rest.lastIndexOf(']');
    if (close === -1) return null;
    const tail = rest.slice(close + 1).trim();
    if (tail !== '' && !tail.startsWith('#')) return null;
    raw.push(...inlineItems(rest.slice(1, close)));
  } else if (rest === '' || rest.startsWith('#')) {
    for (let i = at + 1; i < lines.length; i += 1) {
      const line = lines[i];
      const t = line.trim();
      if (t === '' || t.startsWith('#')) continue;
      const m = ITEM_RE.exec(line);
      if (!m) break;
      raw.push(m[1] ?? '');
      if (raw.length > FILES_MODIFIED_MAX_ITEMS * 4) break;
    }
  } else {
    return null;
  }
  const out = [];
  for (const r of raw) {
    const v = scalar(r);
    if (v === null || v.length > FILES_MODIFIED_MAX_CHARS) continue;
    out.push(v);
    if (out.length === FILES_MODIFIED_MAX_ITEMS) break;
  }
  return out;
}
