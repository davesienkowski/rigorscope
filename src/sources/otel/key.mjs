// Keys for OTel rows (DATA-03). Events key on four fields because (session.id, event.sequence) alone
// collides on about 1 percent of real lines; metrics have no sequence, so they key on the timestamp, the
// metric name, a hash of the canonical kept attributes and an ordinal that the writer derives from file
// provenance.
import { createHash } from 'node:crypto';

// Recursive, keys sorted by UTF-16 code unit, no whitespace. Undefined members are omitted.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export function eventKey({ sessionId, seq, ts, kind }) {
  const n = Number(seq);
  return { sessionId, seq: n, ts, kind, display: `${sessionId}|${n}|${ts}|${kind}` };
}

export const metricBaseKey = ({ ts, metric, attrsSha }) => `${ts}|${metric}|${attrsSha}`;
