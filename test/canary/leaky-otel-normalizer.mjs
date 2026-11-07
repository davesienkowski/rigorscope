// A deliberately leaking stand-in for the OTel normalizer (plan 01-03). The canary injects it through the
// seam ctx.options.otelNormalize to prove the raw-byte scan has teeth for OTel: it stores the whole raw line,
// the attrs and the resource inside an allowed column (attrsJson).
//
// It builds a valid result by itself and must not import anything from src/. Contract: it receives the
// line text and returns the normalizer result shape documented in test/fixtures/otel.mjs.
import { createHash } from 'node:crypto';

const sha = (t) => createHash('sha256').update(t).digest('hex');
const drop = (reason) => ({ type: 'drop', row: null, reason, rejected: [], unknown: [], unknownToken: null, recordTs: null });

export function leakyOtelNormalize(rawLine) {
  const text = typeof rawLine === 'string' ? rawLine : Buffer.from(rawLine).toString('utf8');
  if (text.trim() === '') return { type: 'skip' };
  let obj;
  try { obj = JSON.parse(text); } catch { return { type: 'unparseable' }; }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return drop('record_type');
  const attrs = obj.attrs !== null && typeof obj.attrs === 'object' ? obj.attrs : {};
  const attrsJson = JSON.stringify({ line: text, attrs, resource: obj.resource }); // the leak
  const attrsSha = sha(attrsJson);
  if (typeof obj.event === 'string') {
    if (typeof attrs['session.id'] !== 'string' || typeof attrs['event.timestamp'] !== 'string' || !Number.isInteger(attrs['event.sequence'])) {
      return drop('session_id');
    }
    return {
      type: 'event',
      row: {
        sessionId: attrs['session.id'], seq: attrs['event.sequence'], eventTs: attrs['event.timestamp'], kind: obj.event,
        tsUtc: obj.ts, promptId: null, requestId: null, toolUseId: null, ccVersion: null, attrsJson, attrsSha,
      },
      rejected: [], unknown: [], unknownToken: null, recordTs: obj.ts,
    };
  }
  if (typeof obj.metric === 'string' && typeof obj.value === 'number') {
    return {
      type: 'metric',
      row: {
        tsUtc: obj.ts, metric: obj.metric, attrsSha, value: obj.value, sessionId: null, ccVersion: null, attrsJson,
      },
      rejected: [], unknown: [], unknownToken: null, recordTs: obj.ts,
    };
  }
  return drop('record_type');
}
