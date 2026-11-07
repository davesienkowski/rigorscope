// Measure: the only shape a number takes on its way to a report (TRUST-01, TRUST-02, RR-04, RR-05).
//
//   { value, n, label, coverage, evidence }
//
// value is a finite number or null. null means unknown, never zero, and forces the label
// `unavailable`. n is the number of members the value covers. coverage is known/n for a partial
// aggregate (null when it does not apply). evidence is null until a later plan fills it (null means
// "not computed in this build"). Labels are ASCII constants and are never taken from file content.
export const LABELS = Object.freeze([
  'measured', 'otel', 'transcript', 'derived', 'estimated', 'reconstructed', 'unavailable',
]);

export function makeMeasure({ value = null, n = 0, label, coverage = null, evidence = null } = {}) {
  if (value !== null && !(typeof value === 'number' && Number.isFinite(value))) {
    throw new TypeError('Measure value must be a finite number or null');
  }
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('Measure n must be a non-negative integer');
  if (coverage !== null && !(typeof coverage === 'number' && coverage >= 0 && coverage <= 1)) {
    throw new TypeError('Measure coverage must be null or a number from 0 to 1');
  }
  let finalLabel = label;
  if (value === null) {
    if (finalLabel === undefined) finalLabel = 'unavailable';
    if (finalLabel !== 'unavailable') throw new TypeError('an unknown Measure must carry the label unavailable');
  } else {
    if (!LABELS.includes(finalLabel) || finalLabel === 'unavailable') {
      throw new TypeError('a known Measure needs one of the six source labels other than unavailable');
    }
  }
  return Object.freeze({ value, n, label: finalLabel, coverage, evidence });
}

export function known(value, { label, n = 1, coverage = 1, evidence = null } = {}) {
  return makeMeasure({ value, n, label, coverage, evidence });
}

// The label is forced: whatever the caller says, an unknown value is unavailable.
export function unknown({ n = 0, coverage = null, evidence = null } = {}) {
  return makeMeasure({ value: null, n, label: 'unavailable', coverage, evidence });
}

// Turns an aggregate into a Measure. `sum` is only trusted when every member was known; an
// aggregate with an unknown member is unknown with coverage known/n, and one over no members is
// unknown with n 0. This is the guard SQL sum() lacks, because sum() skips NULLs silently.
export function fromAggregate({ sum, known: knownCount, n, label }) {
  // More known members than members is a bug in the caller's query, never something to clamp.
  if (Number.isSafeInteger(knownCount) && Number.isSafeInteger(n) && knownCount > n) {
    throw new RangeError('aggregate has more known members than members');
  }
  if (!Number.isSafeInteger(n) || n <= 0) return unknown({ n: 0, coverage: null });
  if (knownCount === n && typeof sum === 'number' && Number.isFinite(sum)) {
    return known(sum, { label, n, coverage: 1 });
  }
  const k = Number.isSafeInteger(knownCount) && knownCount >= 0 && knownCount <= n ? knownCount : 0;
  return unknown({ n, coverage: k / n });
}

// A cell is "?" for unknown and the plain integer text otherwise. No rounding or formatting that
// could turn null into 0.
export function cell(measure) {
  if (measure === null || typeof measure !== 'object' || measure.value === null || measure.value === undefined) return '?';
  return String(measure.value);
}

// Dollar formatting (plan 01-05). value is a dollar amount derived from integer nano-dollars; it is turned
// back into nano-dollars, rounded half up to micro-dollars in integer arithmetic and printed with six
// decimals. A positive amount that rounds to zero micro-dollars prints "<0.000001", so a tiny cost never
// reads as a genuine zero; 0 prints "0.000000". Anything other than a finite number at least 0 throws.
export function formatUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('formatUsd needs a finite number at least 0');
  }
  const nano = Math.round(value * 1e9);
  if (!Number.isSafeInteger(nano)) throw new TypeError('formatUsd value is out of range');
  const micro = Math.floor((nano + 500) / 1000);
  if (micro === 0 && nano > 0) return '<0.000001';
  return `${Math.floor(micro / 1e6)}.${String(micro % 1e6).padStart(6, '0')}`;
}

// A dollar cell: "?" for an unknown Measure, otherwise formatUsd, prefixed ">=" when the value is a floor
// (a known lower bound). A floor flag on an unknown cell still prints "?".
export function usdCell(measure, { floor = false } = {}) {
  if (measure === null || typeof measure !== 'object' || measure.value === null || measure.value === undefined) return '?';
  return `${floor ? '>=' : ''}${formatUsd(measure.value)}`;
}

// Percentage formatting (plan 01-06). value is a share of a subscription window in percentage points, derived
// from integer micro-points (1 point = 1,000,000); it is turned back into micro-points and rounded half up to
// hundredths in integer arithmetic. 0 prints "0.00%"; a positive share below half a hundredth prints "<0.01%",
// so a tiny share never reads as a genuine zero. Anything other than a finite number at least 0 throws.
export function formatPct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('formatPct needs a finite number at least 0');
  }
  const micro = Math.round(value * 1e6);
  if (!Number.isSafeInteger(micro)) throw new TypeError('formatPct value is out of range');
  if (micro === 0) return '0.00%';
  if (micro < 5000) return '<0.01%';
  const hundredths = Math.floor((micro + 5000) / 10000);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}%`;
}

// A window-share cell: "?" for an unknown Measure (or none), otherwise formatPct of its value.
export function pctCell(measure) {
  if (measure === null || typeof measure !== 'object' || measure.value === null || measure.value === undefined) return '?';
  return formatPct(measure.value);
}
