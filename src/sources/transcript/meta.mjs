// Sub-agent meta files (agent-ID.meta.json). Only the twelve allowlisted fields are kept, each through
// a shape check. description (task text) and the worktree keys are dropped silently and never
// stored; any other key is recorded by shape-checked NAME only (RR-03, T-01-11).
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { safeName } from './home.mjs';

export const MAX_META_BYTES = 64 * 1024;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SHAPES = {
  name: (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(v),
  id: (v) => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v),
  model: (v) => typeof v === 'string' && /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,99}|<synthetic>)$/.test(v),
  depth: (v) => Number.isSafeInteger(v) && v >= 0 && v <= 1000,
  flag: (v) => typeof v === 'boolean',
  phase: (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(v)) || (Number.isSafeInteger(v) && v >= 0),
};

export const META_ALLOWLIST = Object.freeze([
  { source: 'agentType', column: 'agent_type', kind: 'name' },
  { source: 'spawnDepth', column: 'spawn_depth', kind: 'depth' },
  { source: 'model', column: 'model', kind: 'model' },
  { source: 'toolUseId', column: 'tool_use_id', kind: 'id' },
  { source: 'parentAgentId', column: 'parent_agent_id', kind: 'id' },
  { source: 'isFork', column: 'is_fork', kind: 'flag' },
  { source: 'workflowPhase', column: 'workflow_phase', kind: 'phase' },
  { source: 'finished', column: 'finished', kind: 'flag' },
  { source: 'spawnedWithWorktree', column: 'spawned_with_worktree', kind: 'flag' },
  { source: 'stoppedByUser', column: 'stopped_by_user', kind: 'flag' },
  { source: 'launchedWithDefaults', column: 'launched_with_defaults', kind: 'flag' },
  { source: 'requestNonInteractive', column: 'request_non_interactive', kind: 'flag' },
].map((e) => Object.freeze(e)));

export const META_DROPPED = Object.freeze(['description', 'worktreePath', 'worktreeBranch', 'worktreeCleanlyRemoved', 'requestShape']);

const LISTED = new Set([...META_ALLOWLIST.map((e) => e.source), ...META_DROPPED]);

// -> { row, rejected, unknown }: row holds exactly the twelve cc_agent_meta value columns.
export function normalizeMeta(obj) {
  const row = {};
  const rejected = [];
  for (const { source, column, kind } of META_ALLOWLIST) {
    const raw = isObject(obj) && Object.hasOwn(obj, source) ? obj[source] : undefined;
    if (raw === undefined || raw === null) row[column] = null;
    else if (!SHAPES[kind](raw)) { row[column] = null; rejected.push(column); }
    else if (kind === 'flag') row[column] = raw ? 1 : 0;
    else if (kind === 'phase') row[column] = String(raw);
    else row[column] = raw;
  }
  const unknown = isObject(obj) ? Object.keys(obj).filter((k) => !LISTED.has(k)).map(safeName) : [];
  return { row, rejected, unknown };
}

// Reads one meta file with a size cap. Never throws on content: returns { ok, obj } or { ok: false, reason }.
export function readMetaFile(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size > MAX_META_BYTES) return { ok: false, reason: 'too_large' };
    const buf = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const n = readSync(fd, buf, got, size - got, got);
      if (n <= 0) break;
      got += n;
    }
    const text = buf.subarray(0, got).toString('utf8').replace(/^﻿/, '');
    if (text.trim() === '') return { ok: false, reason: 'empty' };
    let obj;
    try { obj = JSON.parse(text); } catch { return { ok: false, reason: 'not_json' }; }
    if (!isObject(obj)) return { ok: false, reason: 'not_object' };
    return { ok: true, obj };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
