// Line classification (D-04). Only about a quarter of the lines of a transcript start with the type
// key, so the type cannot be read from a fixed position. The cheap path is a byte search for the
// assistant marker and the four token key strings on the raw Buffer; only an ambiguous line (no
// known head type, a token key present) is parsed, and only to read its `type` and `version`.
// A result never carries line content and the parser's error message is never used.
// Plan 02-04 (D-14): a line holding the byte marker `<command-name>` whose head type is `user` or unreadable is
// classified `command` (the slash-command name picker reads it after a parse); any other head type keeps its routing.
// The branch runs after the assistant marker and the usage-report check and before the token checks.
import { safeName, safeVersion } from './home.mjs';

export const KNOWN_NON_TOKEN_TYPES = Object.freeze([
  'attachment', 'user', 'api-request-blob', 'last-prompt', 'mode', 'api-request', 'permission-mode', 'bridge-session',
  'atis-latch', 'ai-title', 'queue-operation', 'system', 'artifact-autoreact-ledger', 'fork-context-ref', 'continued-in',
  'started', 'result', 'failed', 'launched',
]);
// Cumulative per-session cost records (assumption A7 in 01-RESEARCH.md): counted, not stored in Phase 1.
export const DEFERRED_TOKEN_TYPES = Object.freeze(['cost-state']);

const KNOWN = new Set(KNOWN_NON_TOKEN_TYPES);
const DEFERRED = new Set(DEFERRED_TOKEN_TYPES);
const MARKER = Buffer.from('"type":"assistant"');
// A usageReport line (plan 01-06): a system line of subtype local_command carrying the usage report. Both byte
// markers must be present and the assistant marker absent; the strict type check happens after the parse.
const REPORT_MARKERS = ['"usageReport"', '"subtype":"local_command"'].map((k) => Buffer.from(k));
const isUsageReportLine = (buf) => REPORT_MARKERS.every((k) => buf.indexOf(k) !== -1);
const COMMAND_MARKER = Buffer.from('<command-name>');
const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map((k) => Buffer.from(k));
const HEAD = /^\{"type":"([^"\\]{1,64})"/;

export const hasTokenKey = (buf) => TOKEN_KEYS.some((k) => buf.indexOf(k) !== -1);
const headType = (buf) => {
  const m = HEAD.exec(buf.subarray(0, 100).toString('latin1'));
  return m ? m[1] : null;
};

// Shared routing by type, also used when a candidate parses to a non-assistant record.
export function classifyType(type, tokenBearing, version) {
  if (KNOWN.has(type)) return { action: 'skip', reason: 'type', type };
  if (DEFERRED.has(type)) return tokenBearing ? { action: 'deferred', type } : { action: 'skip', reason: 'type', type };
  if (!tokenBearing) return { action: 'skip', reason: 'type', type: safeName(type) };
  return { action: 'unknown', type: safeName(type), version: safeVersion(version) };
}

function parseTypeAndVersion(buf) {
  try {
    const obj = JSON.parse(buf.toString('utf8'));
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return {};
    return { type: obj.type, version: obj.version };
  } catch {
    return {};
  }
}

// item: { buf } for a complete line, or { oversized: true, head } for a line above the size cap.
// opts.commands false skips the command branch: the routing a command line had before plan 02-04, used by the
// transcript source when a command line does not parse.
export function classifyLine(item, { commands = true } = {}) {
  if (item.oversized) {
    const t = headType(item.head);
    return { action: 'oversized', type: t === null ? '?' : safeName(t) };
  }
  const buf = item.buf;
  if (buf.length === 0) return { action: 'skip', reason: 'empty' };
  if (buf.indexOf(MARKER) !== -1) return { action: 'candidate' };
  if (isUsageReportLine(buf)) return { action: 'usage_report' };
  const t = headType(buf);
  if (commands && (t === null || t === 'user') && buf.indexOf(COMMAND_MARKER) !== -1) return { action: 'command', type: t };
  const token = hasTokenKey(buf);
  if (t !== null) {
    if (KNOWN.has(t) || !token) return classifyType(t, token);
    return classifyType(t, token, parseTypeAndVersion(buf).version);
  }
  if (!token) return { action: 'skip', reason: 'untyped' };
  const parsed = parseTypeAndVersion(buf);
  if (typeof parsed.type !== 'string') return { action: 'skip', reason: 'untyped' };
  return classifyType(parsed.type, true, parsed.version);
}
