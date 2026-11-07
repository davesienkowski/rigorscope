// Allowlist normalizer for Claude Code assistant lines (DATA-05, RR-03).
//
// Deny by default: a field is read only if it has an entry in ALLOWLIST, by an explicit path (the
// parsed object is never spread or copied). Every string field must pass its shape check; a value
// that fails becomes NULL and only the COLUMN NAME is reported (never the value), so a hostile or
// accidentally sensitive string cannot ride through an allowed column. cwd is read and only its
// leading home prefix is normalized; no other path field, no message content and no other key is read here.
// Plan 02-04: message content is now read, by src/sources/transcript/refs.mjs only, for the four tool_use input path
// fields (file_path, path, notebook_path, and pattern for the Glob tool only) and the tool name, each shape-checked;
// nothing else of the content is read. ALLOWLIST, KNOWN_KEYS and the dropped gitBranch (amendment Q5) are unchanged.
//
// normalizeAssistantLine(obj, ctx?) -> { row, rejected, iterations, iterationsTruncated, unknown, dropped }
//   row       an object holding exactly the cc_message column names, or null when the line is dropped
//   rejected  column names whose value was present but failed its shape check
//   iterations / iterationsTruncated   usage.iterations entries by index (at most 16) and how many were cut
//   unknown   { line, message, usage }: names of unlisted keys, shape-checked, never values
//   dropped   the drop reason (usage, session_id, message_id, agent_id) or null
// ctx is optional ({ homeSet } for cwd normalization), so the 01-01 call shape still works.
import { normalizeCwd, safeName } from './home.mjs';

// The id and timestamp shapes, exported for the command picker of src/sources/transcript/refs.mjs (plan 02-04).
export const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// kind -> predicate. Counts must be non-negative safe integers; nothing is coerced.
const SHAPES = {
  id: (v) => typeof v === 'string' && ID_RE.test(v),
  name: (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(v),
  model: (v) => typeof v === 'string' && /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,99}|<synthetic>)$/.test(v),
  timestamp: (v) => typeof v === 'string' && TIMESTAMP_RE.test(v),
  label: (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(v),
  count: (v) => Number.isSafeInteger(v) && v >= 0,
  flag: (v) => typeof v === 'boolean',
};

export const ALLOWLIST = Object.freeze([
  { source: 'sessionId', column: 'session_id', kind: 'id' },
  { source: 'agentId', column: 'agent_id', kind: 'id' },
  { source: 'message.id', column: 'message_id', kind: 'id' },
  { source: 'requestId', column: 'request_id', kind: 'id' },
  { source: 'timestamp', column: 'ts_utc', kind: 'timestamp' },
  { source: 'message.model', column: 'model', kind: 'model' },
  { source: 'attributionAgent', column: 'attribution_agent', kind: 'name' },
  { source: 'effort', column: 'effort', kind: 'label' },
  { source: 'version', column: 'version', kind: 'label' },
  { source: 'message.usage.input_tokens', column: 'input_tokens', kind: 'count' },
  { source: 'message.usage.output_tokens', column: 'output_tokens', kind: 'count' },
  { source: 'message.usage.cache_read_input_tokens', column: 'cache_read', kind: 'count' },
  { source: 'message.usage.cache_creation_input_tokens', column: 'cache_creation', kind: 'count' },
  { source: 'message.usage.cache_creation.ephemeral_5m_input_tokens', column: 'cache_5m', kind: 'count' },
  { source: 'message.usage.cache_creation.ephemeral_1h_input_tokens', column: 'cache_1h', kind: 'count' },
  { source: 'message.usage.speed', column: 'speed', kind: 'label' },
  { source: 'message.usage.service_tier', column: 'service_tier', kind: 'label' },
  { source: 'message.usage.inference_geo', column: 'inference_geo', kind: 'label' },
  { source: 'uuid', column: 'uuid', kind: 'id' },
  { source: 'isSidechain', column: 'is_sidechain', kind: 'flag' },
  { source: 'attributionSkill', column: 'attribution_skill', kind: 'name' },
  { source: 'perTurnEffort', column: 'per_turn_effort', kind: 'label' },
  { source: 'advisorModel', column: 'advisor_model', kind: 'model' },
  { source: 'requestedModel', column: 'requested_model', kind: 'model' },
  { source: 'entrypoint', column: 'entrypoint', kind: 'label' },
  { source: 'cwd', column: 'cwd', kind: 'cwd' },
  { source: 'message.usage.iterations', column: 'has_iterations', kind: 'presence' },
  // Plan 01-12 (WR-03, U5): a tri-state count flag, not presence (see toolCountFlag); the column name is unchanged.
  { source: 'message.usage.server_tool_use', column: 'has_server_tool_use', kind: 'toolcount' },
].map((e) => Object.freeze(e)));

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// message.usage.server_tool_use -> 1, 0 or NULL (plan 01-12, review CR-01, RR-04). A readable member is a
// non-negative safe integer; a fractional, negative, string, boolean, null, nested-object or unsafe value is
// unreadable (it can never yield 1, and it may hide a real count above 0, so it can never yield 0 either).
//   1     any readable member is above 0 (whatever the other members are)
//   0     the key is absent, or the value is an object with at least one member and EVERY member is a readable 0
//   NULL  anything else: a non-object value, an empty object, or an unreadable member and no readable count above 0
function toolCountFlag(raw) {
  if (raw === undefined) return 0;
  if (!isObject(raw)) return null;
  const members = Object.values(raw);
  const counts = members.filter((v) => Number.isSafeInteger(v) && v >= 0);
  if (counts.some((v) => v > 0)) return 1;
  if (members.length > 0 && counts.length === members.length) return 0;
  return null;
}

// Walks an explicit dotted path over own properties only. Returns undefined when any step is absent.
function pick(obj, path) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (!isObject(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

// Entries of usage.iterations[]: the type, the model, the four token fields and the two
// cache_creation fields. Stored per index in cc_message_iter.
export const ITER_ALLOWLIST = Object.freeze([
  { source: 'type', column: 'iter_type', kind: 'name' },
  { source: 'model', column: 'model', kind: 'model' },
  { source: 'input_tokens', column: 'input_tokens', kind: 'count' },
  { source: 'output_tokens', column: 'output_tokens', kind: 'count' },
  { source: 'cache_read_input_tokens', column: 'cache_read', kind: 'count' },
  { source: 'cache_creation_input_tokens', column: 'cache_creation', kind: 'count' },
  { source: 'cache_creation.ephemeral_5m_input_tokens', column: 'cache_5m', kind: 'count' },
  { source: 'cache_creation.ephemeral_1h_input_tokens', column: 'cache_1h', kind: 'count' },
].map((e) => Object.freeze(e)));

export const MAX_ITERATIONS = 16;
export const MAX_UNKNOWN_NAMES = 200;

// Keys that are known (kept through ALLOWLIST or deliberately dropped). Anything else is reported by
// name through `unknown`; the first real run lists the names to triage (plan 01-10).
const usageKeys = ALLOWLIST.filter((e) => e.source.startsWith('message.usage.')).map((e) => e.source.split('.')[2]);
export const KNOWN_KEYS = Object.freeze({
  line: Object.freeze([
    ...ALLOWLIST.filter((e) => !e.source.includes('.')).map((e) => e.source),
    'type', 'message', 'parentUuid', 'gitBranch', 'requestRef', 'thinkingDurationMs',
  ]),
  message: Object.freeze(['id', 'model', 'content', 'type', 'role', 'stop_reason', 'stop_sequence', 'usage']),
  usage: Object.freeze([...new Set(usageKeys)]),
});

function unknownNames(obj, known) {
  const set = new Set(known);
  const distinct = new Set();
  const out = [];
  for (const k of Object.keys(obj)) {
    if (set.has(k)) continue;
    const name = safeName(k);
    if (name !== '?' && !distinct.has(name) && distinct.size >= MAX_UNKNOWN_NAMES) out.push('?');
    else {
      if (name !== '?') distinct.add(name);
      out.push(name);
    }
  }
  return out;
}

function normalizeIterations(arr, rejected) {
  if (!Array.isArray(arr)) return { iterations: [], truncated: 0 };
  const iterations = [];
  for (let i = 0; i < arr.length && i < MAX_ITERATIONS; i += 1) {
    const entry = arr[i];
    if (!isObject(entry)) continue;
    const it = { iter_seq: i };
    for (const { source, column, kind } of ITER_ALLOWLIST) {
      const raw = pick(entry, source);
      if (raw === undefined || raw === null) it[column] = null;
      else if (SHAPES[kind](raw)) it[column] = raw;
      else { it[column] = null; rejected.push(`iter_${column}`); }
    }
    iterations.push(it);
  }
  return { iterations, truncated: Math.max(0, arr.length - MAX_ITERATIONS) };
}

const NO_UNKNOWN = Object.freeze({ line: [], message: [], usage: [] });

export function normalizeAssistantLine(obj, ctx) {
  const dropped = (reason, rejected = []) => ({
    row: null, rejected, iterations: [], iterationsTruncated: 0, unknown: NO_UNKNOWN, dropped: reason,
  });
  if (!isObject(obj) || !isObject(obj.message) || !isObject(obj.message.usage)) return dropped('usage');
  const row = {};
  const rejected = [];
  for (const { source, column, kind } of ALLOWLIST) {
    const raw = pick(obj, source);
    if (kind === 'presence') {
      row[column] = Array.isArray(raw) ? (raw.length > 0 ? 1 : 0) : (isObject(raw) ? 1 : 0);
    } else if (kind === 'toolcount') {
      row[column] = toolCountFlag(raw);
    } else if (raw === undefined || raw === null) {
      row[column] = column === 'agent_id' ? '' : null; // no agentId: a main-thread line
    } else if (kind === 'cwd') {
      const n = normalizeCwd(raw, ctx?.homeSet);
      if (n === null) { row[column] = null; rejected.push(column); } else row[column] = n;
    } else if (SHAPES[kind](raw)) {
      row[column] = kind === 'flag' ? (raw ? 1 : 0) : raw;
    } else {
      row[column] = column === 'agent_id' ? '' : null;
      rejected.push(column);
    }
  }
  // The key columns must be real: a line without a valid session id or message id, or with an
  // agent id that is present but invalid (it would silently merge into the main thread), is dropped.
  if (row.session_id === null) return dropped('session_id', rejected);
  if (row.message_id === null) return dropped('message_id', rejected);
  if (rejected.includes('agent_id')) return dropped('agent_id', rejected);
  const { iterations, truncated } = normalizeIterations(obj.message.usage.iterations, rejected);
  return {
    row,
    rejected,
    iterations,
    iterationsTruncated: truncated,
    unknown: {
      line: unknownNames(obj, KNOWN_KEYS.line),
      message: unknownNames(obj.message, KNOWN_KEYS.message),
      usage: unknownNames(obj.message.usage, KNOWN_KEYS.usage),
    },
    dropped: null,
  };
}
