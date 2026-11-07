// The transcript source descriptor (see src/ingest/sources.mjs for the contract). Claude Code
// transcripts live under <config dir>/projects/; every config dir is discovered (D-03).
// Plan 02-04: each kept message record also carries `refs`, the planning-file references of the line's structured
// tool_use path fields (src/sources/transcript/refs.mjs, never a Bash command string), and a user line holding a
// `<command-name>` tag becomes a `command` record holding only the command name (never its arguments).
import { statSync } from 'node:fs';
import { classifyLine, classifyType, hasTokenKey } from './classify.mjs';
import { buildHomeSet } from './home.mjs';
import { readLinesFrom } from '../../ingest/lines.mjs';
import { readMetaFile, normalizeMeta } from './meta.mjs';
import { normalizeAssistantLine } from './normalize.mjs';
import { normalizeCommandLine, normalizeRefs } from './refs.mjs';
import { discoverRoots } from './roots.mjs';
import { walkRoot } from './walk.mjs';
import { createWriter } from './write.mjs';
import { pickUsageReport } from '../usage/report.mjs';

export const name = 'transcript';
export const freshness = { live: true, staleAfterHours: 36 };
export { createWriter };

export async function discover(ctx) {
  const found = await discoverRoots({
    home: ctx.home, env: ctx.env, windowsUsersDir: ctx.windowsUsersDir, explicit: ctx.options.roots,
  });
  ctx.homeSet = buildHomeSet({ home: ctx.home, windowsUsers: found.windowsUsers });
  const units = [];
  for (const root of found.roots) {
    const res = walkRoot(root, { homeSet: ctx.homeSet });
    units.push(...res.units);
    for (const [reason, n] of Object.entries(res.skipped)) ctx.tally('walk_skip', reason, n);
  }
  return { roots: found.roots.map(({ alias, display, kind }) => ({ alias, display, kind })), units };
}

// Append units are read line by line from the cursor; a meta unit is one whole-file item.
export function* read(unit, start, opts) {
  if (unit.kind === 'meta') {
    yield { meta: readMetaFile(unit.abs), end: statSync(unit.abs).size };
    return;
  }
  yield* readLinesFrom(unit.abs, start, opts);
}

function routed(c, ctx) {
  switch (c.action) {
    case 'skip':
      if (c.reason === 'type') ctx.tally('skipped_type', c.type);
      else if (c.reason === 'untyped') ctx.tally('skipped_type', 'untyped');
      break;
    case 'oversized':
      ctx.tally('counter', 'oversized');
      ctx.tally('oversized', c.type);
      break;
    case 'deferred':
      ctx.tally('counter', 'deferred_token_bearing');
      ctx.tally('deferred_token', c.type);
      break;
    case 'unknown':
      ctx.tally('counter', 'unknown_token_bearing');
      ctx.tally('unknown_token', `${c.type}|${c.version}`);
      break;
    default:
  }
  return { records: [] };
}

// A usageReport line (plan 01-06, D-11a): parsed once and handed to the report pick (seam
// ctx.options.usageReportPick). A parse failure counts as unparseable; a line the pick does not recognize falls
// back to the type classification. Rejected fields are counted by REPORT_PICK path; no key name of the line is
// ever recorded. The snapshot goes to the usage writer through the transcript writer.
function usageReport(item, ctx) {
  let obj;
  try {
    obj = JSON.parse(item.buf.toString('utf8')); // never expose the parser message: V8 quotes the input
  } catch {
    ctx.tally('counter', 'unparseable');
    return { records: [] };
  }
  const pick = ctx.options?.usageReportPick ?? pickUsageReport;
  const res = pick(obj);
  if (res.status === 'not_report') {
    const t = obj !== null && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.type === 'string' ? obj.type : null;
    if (t === null) { ctx.tally('skipped_type', 'untyped'); return { records: [] }; }
    return routed(classifyType(t, hasTokenKey(item.buf), obj.version), ctx);
  }
  for (const r of res.rejected ?? []) ctx.tally('rejected_field', r.path, r.n);
  if (res.status !== 'ok' || !res.snapshot) return { records: [] };
  return { records: [{ kind: 'usage_snapshot', source: 'transcript', label: 'transcript', snapshot: res.snapshot }] };
}

// A line classified `command` (plan 02-04, D-14): parsed once and handed to the command name picker (seam
// ctx.options.pickCommand). A parse failure counts `capture`/`command_unparseable` and the line is routed as it was
// before the command branch; a parsed line of another type is routed by its type like the usage-report fallback; a
// user line yields a `command` record (counted `capture`/`commands`) or a reason (counted `capture`/`command_<reason>`,
// and the line stays a skipped `user` line). A command line returns no `ts`: record times stay assistant times.
const COMMAND_REASONS = new Set(['not_user', 'tool_result', 'no_text', 'no_name', 'unanchored', 'dropped']);
function commandLine(item, unit, ctx) {
  let obj;
  try {
    obj = JSON.parse(item.buf.toString('utf8')); // never expose the parser message: V8 quotes the input
  } catch {
    ctx.tally('capture', 'command_unparseable');
    return routed(classifyLine(item, { commands: false }), ctx);
  }
  const t = obj !== null && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.type === 'string' ? obj.type : null;
  if (t === null) { ctx.tally('skipped_type', 'untyped'); return { records: [] }; }
  if (t !== 'user') return routed(classifyType(t, hasTokenKey(item.buf), obj.version), ctx);
  const pick = ctx.options.pickCommand ?? normalizeCommandLine;
  const res = pick(obj, { agentId: unit.agentId });
  if (res?.row) {
    ctx.tally('capture', 'commands');
    return { records: [{ kind: 'command', row: res.row }] };
  }
  ctx.tally('capture', `command_${COMMAND_REASONS.has(res?.reason) ? res.reason : 'dropped'}`);
  ctx.tally('skipped_type', 'user');
  return { records: [] };
}

export function normalize(item, unit, ctx) {
  if (unit.kind === 'meta') {
    if (!item.meta.ok) { ctx.tally('meta_skip', item.meta.reason); return { records: [] }; }
    const { row, rejected, unknown } = normalizeMeta(item.meta.obj);
    for (const r of rejected) ctx.tally('rejected_field', r);
    for (const u of unknown) ctx.attr('meta', u);
    return { records: [{ kind: 'meta', session_id: unit.sessionId, agent_id: unit.agentId, row }] };
  }
  const c = classifyLine(item);
  if (c.action === 'usage_report') return usageReport(item, ctx);
  if (c.action === 'command') return commandLine(item, unit, ctx);
  if (c.action !== 'candidate') return routed(c, ctx);
  ctx.tally('counter', 'candidates');
  let obj;
  try {
    obj = JSON.parse(item.buf.toString('utf8')); // never expose the parser message: V8 quotes the input
  } catch {
    ctx.tally('counter', 'unparseable');
    return { records: [] };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj) || obj.type !== 'assistant') {
    const t = obj !== null && typeof obj === 'object' && typeof obj.type === 'string' ? obj.type : null;
    if (t === null) { ctx.tally('skipped_type', 'untyped'); return { records: [] }; }
    return routed(classifyType(t, hasTokenKey(item.buf), obj.version), ctx);
  }
  ctx.tally('counter', 'assistant_parsed');
  const fn = ctx.options.normalize ?? normalizeAssistantLine;
  const res = fn(obj, ctx);
  for (const r of res.rejected ?? []) ctx.tally('rejected_field', r);
  if (!res.row) {
    if (res.dropped) ctx.tally('dropped', res.dropped);
    return { records: [] };
  }
  for (const [scope, names] of Object.entries(res.unknown ?? {})) for (const n of names) ctx.attr(scope, n);
  if (res.iterationsTruncated > 0) ctx.tally('iterations_truncated', 'messages');
  ctx.tally('counter', 'kept');
  // Plan 02-04: the planning-file refs of the line's tool_use path fields (seam ctx.options.extractRefs). Counts go to
  // ingest_count kind `capture` by reason name; the existing counters and the `rejected=` line do not change.
  const extract = ctx.options.extractRefs ?? normalizeRefs;
  const found = extract(obj, { homeSet: ctx.homeSet, cwd: res.row.cwd });
  const refs = Array.isArray(found?.refs) ? found.refs : [];
  for (const [reason, n] of Object.entries(found?.counts ?? {})) if (n > 0) ctx.tally('capture', reason, n);
  if (refs.length > 0) ctx.tally('capture', 'refs', refs.length);
  return {
    records: [{ kind: 'message', row: res.row, iterations: res.iterations ?? [], refs }],
    ts: res.row.ts_utc ?? undefined,
  };
}
