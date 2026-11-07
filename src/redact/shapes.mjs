// Shape checkers for values read from untrusted files (DATA-05, RR-03). A checker returns the
// normalized value or undefined; nothing is coerced beyond the documented string forms, and every
// string kind is ASCII-only by construction, so free text, email shapes and decoded non-ASCII plants
// cannot ride through a kept key. Shared by the OTel normalizer; a future source reuses it.
//
// Kinds: iso, id, name, label, pattern, hex, version (strings); count, ms, money, bool (typed values
// that also accept the string forms the receiver writes: a count "3", a duration "-4", a bool "true").
export const SHAPE_KINDS = Object.freeze(['iso', 'id', 'name', 'label', 'pattern', 'hex', 'version', 'count', 'ms', 'money', 'bool']);

const str = (re, max = Infinity) => (v) => (typeof v === 'string' && v.length <= max && re.test(v) ? v : undefined);
const zero = (n) => (n === 0 ? 0 : n); // never -0, so JSON and hashes agree

const MS_LIMIT = 1e12;
const MONEY_LIMIT = 1e6;

const CHECKS = {
  iso: str(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
  id: str(/^[A-Za-z0-9._:-]{1,128}$/),
  name: str(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/),
  label: str(/^[A-Za-z0-9][A-Za-z0-9._:,-]*(?: [A-Za-z0-9._:,-]+){0,3}$/, 64),
  pattern: str(/^[A-Za-z0-9_.*+?^$()|[\]-]{1,120}$/),
  hex: str(/^[0-9a-f]{7,64}$/),
  version: str(/^\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.]{1,16})?$/),
  count(v) {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? zero(v) : undefined;
    if (typeof v === 'string' && /^\d{1,16}$/.test(v)) {
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : undefined;
    }
    return undefined;
  },
  ms(v) {
    if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= MS_LIMIT ? zero(v) : undefined;
    if (typeof v === 'string' && /^-?\d{1,13}(?:\.\d{1,6})?$/.test(v)) {
      const n = Number(v);
      return Math.abs(n) <= MS_LIMIT ? zero(n) : undefined;
    }
    return undefined;
  },
  money: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MONEY_LIMIT ? zero(v) : undefined),
  bool(v) {
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return undefined;
  },
};

export function checkShape(kind, value) {
  if (typeof kind !== 'string' || !Object.hasOwn(CHECKS, kind)) return undefined;
  return CHECKS[kind](value);
}
