// The row-key codec (plan 01-08, TRUST-04, D-08). A row key names one row of a cost report:
//   SECTION/total                      the total row of a section
//   SECTION/DIM=VALUE[/DIM=VALUE ...]  a data row, dimensions from the report's whitelist
// Values are percent-encoded UTF-8 (upper-case hex; every byte outside A-Z a-z 0-9 . _ : ~ - is escaped) and `?` is
// NULL, so a literal question mark is `%3F`. Parsing is strict and every failure is one fixed message that never
// echoes the key. Pure: built-ins only; the allowed dimension names are an argument.
export const SECTIONS = Object.freeze(['main', 'otel', 'harness']);

const MESSAGE = 'the row key must be SECTION/total or SECTION/DIM=VALUE[/DIM=VALUE ...] with whitelisted dimensions and percent-encoded values';
const MAX_KEY = 512;
const MAX_PAIRS = 6;
const UNRESERVED = /[A-Za-z0-9._:~-]/;
const VALUE_RE = /^(?:[A-Za-z0-9._:~-]|%[0-9A-F]{2})+$/;
const DIM_RE = /^[a-z]+$/;
const fail = () => { throw new RangeError(MESSAGE); };

export function encodeKeyValue(value) {
  if (value === null) return '?';
  if (typeof value !== 'string') return fail();
  let out = '';
  for (const byte of new TextEncoder().encode(value)) {
    const ch = String.fromCharCode(byte);
    out += byte < 128 && UNRESERVED.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

const checkSection = (section) => (SECTIONS.includes(section) ? section : fail());

export function buildTotalKey(section) {
  return `${checkSection(section)}/total`;
}

export function buildRowKey(section, pairs) {
  checkSection(section);
  return [section, ...pairs.map(([dim, value]) => `${dim}=${encodeKeyValue(value)}`)].join('/');
}

function decodeValue(text) {
  if (text === '?') return null;
  if (!VALUE_RE.test(text)) return fail();
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '%') { bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(text.charCodeAt(i));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return fail();
  }
}

// -> { section, total, pairs: [[dim, value|null], ...] }; throws RangeError(MESSAGE) for anything else.
export function parseRowKey(text, allowedDims) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_KEY) return fail();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(text)) return fail();
  const parts = text.split('/');
  if (parts.some((p) => p === '')) return fail();
  const section = checkSection(parts[0]);
  const rest = parts.slice(1);
  if (rest.length === 0) return fail();
  if (rest[0] === 'total') return rest.length === 1 ? { section, total: true, pairs: [] } : fail();
  if (rest.length > MAX_PAIRS) return fail();
  const allowed = new Set(allowedDims);
  const seen = new Set();
  const pairs = rest.map((p) => {
    const at = p.indexOf('=');
    if (at < 0) return fail();
    const dim = p.slice(0, at);
    const value = p.slice(at + 1);
    if (!DIM_RE.test(dim) || !allowed.has(dim) || seen.has(dim) || value.length === 0 || value.includes('=')) return fail();
    seen.add(dim);
    return [dim, decodeValue(value)];
  });
  return { section, total: false, pairs };
}

// Plan 02-07 (D-19, D-04, UNIT-01): evidence ids for units and links, next to the row keys.
//   u:UNIT                 a unit: UNIT is the percent-encoded unit key
//   l:UNIT/SESSION[/AGENT] one link: the encoded unit key, the encoded session id and, for a subagent scope only, the
//                          encoded agent id
// Every segment is non-empty and decoded with the strict decoder above (so `/` inside a key is always `%2F`); an id is
// at most MAX_ID characters. Any unit or link id failure is one fixed message that never echoes the id; anything else is
// parsed as a row key with parseRowKey (its own fixed message).
export const UNIT_ID_PREFIX = 'u:';
export const LINK_ID_PREFIX = 'l:';
const ID_MESSAGE = 'the evidence id must be u:UNIT or l:UNIT/SESSION[/AGENT] with percent-encoded non-empty segments (at most 1024 characters)';
const MAX_ID = 1024;
const idFail = () => { throw new RangeError(ID_MESSAGE); };

export function buildUnitEvidenceId(unitKey) {
  if (typeof unitKey !== 'string' || unitKey === '') return idFail();
  return `${UNIT_ID_PREFIX}${encodeKeyValue(unitKey)}`;
}

export function buildLinkEvidenceId(unitKey, sessionId, agentId = '') {
  if ([unitKey, sessionId].some((v) => typeof v !== 'string' || v === '') || typeof agentId !== 'string') return idFail();
  const tail = agentId === '' ? '' : `/${encodeKeyValue(agentId)}`;
  return `${LINK_ID_PREFIX}${encodeKeyValue(unitKey)}/${encodeKeyValue(sessionId)}${tail}`;
}

function decodeSegment(seg) {
  if (seg === '' || seg === '?') return idFail();
  try {
    const v = decodeValue(seg);
    return v === null || v === '' ? idFail() : v;
  } catch {
    return idFail();
  }
}

// -> { kind: 'unit', unitKey } | { kind: 'link', unitKey, sessionId, agentId } | { kind: 'row', ...parseRowKey(...) }.
export function parseEvidenceId(text, allowedDims) {
  if (typeof text === 'string' && (text.startsWith(UNIT_ID_PREFIX) || text.startsWith(LINK_ID_PREFIX))) {
    if (text.length > MAX_ID) return idFail();
    // eslint-disable-next-line no-control-regex
    if (/[\u0000- \u007f]/.test(text)) return idFail();
    const segs = text.slice(2).split('/');
    if (text.startsWith(UNIT_ID_PREFIX)) {
      if (segs.length !== 1) return idFail();
      return { kind: 'unit', unitKey: decodeSegment(segs[0]) };
    }
    if (segs.length !== 2 && segs.length !== 3) return idFail();
    const [unitKey, sessionId, agentId] = segs.map(decodeSegment);
    return {
      kind: 'link', unitKey, sessionId, agentId: agentId ?? '',
    };
  }
  return { kind: 'row', ...parseRowKey(text, allowedDims) };
}
