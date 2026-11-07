// Transcript file listing and line reading. Sources are untrusted and read-only.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readLinesFrom } from '../../ingest/lines.mjs';
import { classifyLine } from './classify.mjs';

// A cheap substring test before any JSON.parse: most lines (attachments, blobs, user text) never
// reach the parser. The marker can also sit in a nested object, so parseCandidate checks the type
// again after parsing.
export const ASSISTANT_MARKER = '"type":"assistant"';

const bytewise = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// Regular, non-symlink files matching projects/*/*.jsonl under root, as full paths sorted bytewise,
// so ingest order is deterministic whatever the directory creation order. Nothing else is listed:
// not nested sub-agent files (a later plan), not backups, not symlinks.
export function listTranscriptFiles(root) {
  const projects = join(root, 'projects');
  let dirs;
  try {
    dirs = readdirSync(projects, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue; // a Dirent for a symlink is not a directory
    const dir = join(projects, d.name);
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith('.jsonl')) out.push(join(dir, f.name));
    }
  }
  return out.sort(bytewise);
}

// Yields the lines that hold the assistant marker: CR stripped, blank lines skipped. A thin wrapper
// over the byte-level line reader and the classifier (the ingest runner uses those directly). Unlike
// the runner, this whole-file helper also yields an unterminated last line: the file is complete when
// read through this helper.
export async function* readCandidateLines(file) {
  const stats = {};
  for (const item of readLinesFrom(file, 0, { stats })) {
    if (classifyLine(item).action === 'candidate') yield item.buf.toString('utf8');
  }
  const tail = stats.pendingTail;
  if (tail && tail.length > 0) {
    const buf = tail[tail.length - 1] === 0x0d ? tail.subarray(0, tail.length - 1) : tail;
    if (classifyLine({ buf, oversized: false }).action === 'candidate') yield buf.toString('utf8');
  }
}

// Never exposes the parser message: V8 quotes an excerpt of the input in it.
export function parseCandidate(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj) || obj.type !== 'assistant') {
    return { ok: false, reason: 'not-assistant' };
  }
  return { ok: true, obj };
}
