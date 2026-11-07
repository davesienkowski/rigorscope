// Deny-by-default normalizer for OTel receiver lines (D-05, D-06, DATA-03, DATA-05, DATA-06, RR-03).
//
// normalizeOtelLine(text, unit, ctx) -> { type: 'skip' } | { type: 'unparseable' } | normalizeOtelRecord(...)
// normalizeOtelRecord(obj, ctx) -> { type, row, reason, rejected, unknown, unknownToken, recordTs }
//   type          'event', 'metric' or 'drop'
//   row           event: { sessionId, seq, eventTs, kind, tsUtc, promptId, requestId, toolUseId, ccVersion, attrsJson, attrsSha }
//                 metric: { tsUtc, metric, attrsSha, value, sessionId, ccVersion, attrsJson }
//   reason        drop reason: ts, record_type, session_id, event_sequence, event_timestamp, event_name, metric_name, value
//   rejected      names of kept keys whose value failed its shape: '<kind>.<key>', 'metric.<key>', 'header.event.name'
//   unknown       [{ scope, name }] shape-checked names only: scope is an event kind, 'event_kind', 'metric',
//                 'metric_name' or 'resource'; a hostile name becomes '?'
//   unknownToken  'name|version' when an unknown kind carries a token key or an unknown metric name contains token or cost
//   recordTs      the line timestamp when a row was produced, else null
// It never carries line content: no value outside `row`, no parser message. Order of checks, the first
// failure decides the drop reason. Identity keys, terminal.type and content keys are checked before the
// allowlist (isSensitiveKey), so they are dropped silently and never even named.
import { checkShape } from '../../redact/shapes.mjs';
import { safeName } from '../transcript/home.mjs';
import {
  HEADER_KEYS, EVENT_ALLOW, HEADER_ONLY_KINDS, METRIC_ALLOW, KNOWN_METRICS, NOISE_RESOURCE_KEYS, RESOURCE_KEEP, TOKEN_KEYS,
  isSensitiveKey,
} from './allowlist.mjs';
import { canonicalJson, sha256Hex } from './key.mjs';

export const MAX_ATTR_KEYS = 256;
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const METRIC_NAME = /^[a-z][a-z0-9_.]{0,79}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);
const drop = (reason) => ({ type: 'drop', row: null, reason, rejected: [], unknown: [], unknownToken: null, recordTs: null });
const zero = (n) => (n === 0 ? 0 : n);

// Keys of an attribute object, capped. Values of null are treated as absent.
const keysOf = (obj) => Object.keys(obj).slice(0, MAX_ATTR_KEYS);

function resourceInfo(resource, unknown) {
  if (!isObject(resource)) return null;
  const version = checkShape('version', own(resource, 'service.version')) ?? null;
  for (const key of keysOf(resource)) {
    if (RESOURCE_KEEP.includes(key) || NOISE_RESOURCE_KEYS.includes(key) || isSensitiveKey(key)) continue;
    unknown.push({ scope: 'resource', name: safeName(key) });
  }
  return version;
}

function finish(type, row, rejected, unknown, unknownToken, recordTs) {
  return { type, row, reason: null, rejected, unknown, unknownToken, recordTs };
}

function normalizeEvent(obj) {
  const ts = checkShape('iso', obj.ts);
  if (ts === undefined) return drop('ts');
  const attrs = isObject(obj.attrs) ? obj.attrs : {};
  const sessionId = checkShape('id', own(attrs, 'session.id'));
  if (sessionId === undefined) return drop('session_id');
  const seq = checkShape('count', own(attrs, 'event.sequence'));
  if (seq === undefined) return drop('event_sequence');
  const eventTs = checkShape('iso', own(attrs, 'event.timestamp'));
  if (eventTs === undefined) return drop('event_timestamp');
  if (!EVENT_NAME.test(obj.event)) return drop('event_name');
  const kind = obj.event;

  const rejected = [];
  const unknown = [];
  const declared = own(attrs, 'event.name');
  if (declared !== undefined && declared !== kind) rejected.push('header.event.name');

  const allow = Object.hasOwn(EVENT_ALLOW, kind) ? EVENT_ALLOW[kind] : null;
  const headerOnly = HEADER_ONLY_KINDS.includes(kind);
  const unknownKind = allow === null && !headerOnly;
  let tokenBearing = false;
  if (unknownKind) unknown.push({ scope: 'event_kind', name: kind });

  const kept = {};
  for (const key of keysOf(attrs)) {
    if (HEADER_KEYS.includes(key) || isSensitiveKey(key)) continue;
    const value = attrs[key];
    if (allow !== null) {
      if (Object.hasOwn(allow, key)) {
        if (value === null || value === undefined) continue;
        const checked = checkShape(allow[key], value);
        if (checked === undefined) rejected.push(`${kind}.${key}`);
        else kept[key] = checked;
      } else {
        unknown.push({ scope: kind, name: safeName(key) });
      }
    } else if (unknownKind) {
      unknown.push({ scope: kind, name: safeName(key) });
      if (TOKEN_KEYS.includes(key)) tokenBearing = true;
    }
  }
  const ccVersion = resourceInfo(obj.resource, unknown);
  const attrsJson = canonicalJson(kept);
  const row = {
    sessionId,
    seq,
    eventTs,
    kind,
    tsUtc: ts,
    promptId: kept['prompt.id'] ?? null,
    requestId: kept.request_id ?? null,
    toolUseId: kept.tool_use_id ?? null,
    ccVersion,
    attrsJson,
    attrsSha: sha256Hex(attrsJson),
  };
  return finish('event', row, rejected, unknown, tokenBearing ? `${kind}|${ccVersion ?? '?'}` : null, ts);
}

function normalizeMetric(obj) {
  if (!METRIC_NAME.test(obj.metric)) return drop('metric_name');
  const ts = checkShape('iso', obj.ts);
  if (ts === undefined) return drop('ts');
  if (typeof obj.value !== 'number' || !Number.isFinite(obj.value)) return drop('value');
  const metric = obj.metric;
  const attrs = isObject(obj.attrs) ? obj.attrs : {};
  const rejected = [];
  const unknown = [];
  const known = KNOWN_METRICS.includes(metric);
  if (!known) unknown.push({ scope: 'metric_name', name: metric });

  const kept = {};
  for (const key of keysOf(attrs)) {
    if (isSensitiveKey(key)) continue;
    if (Object.hasOwn(METRIC_ALLOW, key)) {
      const value = attrs[key];
      if (value === null || value === undefined) continue;
      const checked = checkShape(METRIC_ALLOW[key], value);
      if (checked === undefined) rejected.push(`metric.${key}`);
      else kept[key] = checked;
    } else {
      unknown.push({ scope: 'metric', name: safeName(key) });
    }
  }
  const ccVersion = resourceInfo(obj.resource, unknown);
  const attrsJson = canonicalJson(kept);
  const row = {
    tsUtc: ts,
    metric,
    attrsSha: sha256Hex(attrsJson),
    value: zero(obj.value),
    sessionId: kept['session.id'] ?? null,
    ccVersion,
    attrsJson,
  };
  const tokenBearing = !known && /token|cost/.test(metric);
  return finish('metric', row, rejected, unknown, tokenBearing ? `${metric}|${ccVersion ?? '?'}` : null, ts);
}

// ctx is accepted for symmetry with the other sources; nothing here needs it.
export function normalizeOtelRecord(obj, ctx) { // eslint-disable-line no-unused-vars
  if (!isObject(obj)) return drop('record_type');
  if (typeof obj.event === 'string') return normalizeEvent(obj);
  if (typeof obj.metric === 'string') return normalizeMetric(obj);
  return drop('record_type');
}

export function normalizeOtelLine(text, unit, ctx) {
  if (typeof text !== 'string' || text.trim() === '') return { type: 'skip' };
  let obj;
  try {
    obj = JSON.parse(text); // never expose the parser message: V8 quotes the input
  } catch {
    return { type: 'unparseable' };
  }
  return normalizeOtelRecord(obj, ctx);
}
