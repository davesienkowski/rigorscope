// Error-band arithmetic, nearest-rank percentiles, counted rates and their text forms (plan 01-07, COST-05,
// TRUST-01, D-09). Pure, integer arithmetic: money is integer nano-dollars, an error is an integer count of
// parts per million (ppm) of the measured cost, a rate an integer count of basis points. Every division that
// decides a printed digit is done in BigInt and rounded half up; nothing unknown becomes 0.
//
// The band compares, per joined OTel request, the derived cost (the 01-05 price table over the transcript
// tokens) with the measured cost (OTel cost_usd). A request is excluded, and counted, by the first applicable
// reason: derived_unknown, measured_unknown, zero_measured (a ppm of 0 measured is undefined).
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const big = (v) => BigInt(v);
// Half-up integer of num / den for BigInt num >= 0 and den > 0.
const halfUp = (num, den) => (2n * num + den) / (2n * den);

// abs(derived - measured) x 1,000,000 / measured, half up; null when an input is unknown or measured is 0.
export function errPpm(derivedNano, measuredNano) {
  if (!isCount(derivedNano) || !isCount(measuredNano) || measuredNano === 0) return null;
  const d = big(derivedNano);
  const m = big(measuredNano);
  const diff = d > m ? d - m : m - d;
  return Number(halfUp(diff * 1000000n, m));
}

// The element at rank ceil(p x n / 100) (1-based, clamped to 1..n) of an ascending list; null when empty.
export function nearestRank(sortedAsc, p) {
  const n = Array.isArray(sortedAsc) ? sortedAsc.length : 0;
  if (n === 0) return null;
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0 || p > 100) throw new RangeError('percentile must be in (0, 100]');
  // p is an integer percentile in practice; scale by 100 so ceil is exact for two decimals of p too.
  const num = big(Math.round(p * 100)) * big(n);
  const rank = Number((num + 9999n) / 10000n);
  return sortedAsc[Math.min(n, Math.max(1, rank)) - 1];
}

const EXCLUSION_REASONS = ['derived_unknown', 'measured_unknown', 'zero_measured'];
const MAX_OUTLIERS = 5;
const byteLess = (a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));

// rows: [{ key, derivedNano, measuredNano, calls, role, model, topLevelOnly, floor }] (any order).
export function bandStats(rows) {
  const excluded = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0]));
  const band = [];
  for (const r of rows ?? []) {
    if (!isCount(r.derivedNano)) excluded.derived_unknown += 1;
    else if (!isCount(r.measuredNano)) excluded.measured_unknown += 1;
    else if (r.measuredNano === 0) excluded.zero_measured += 1;
    else band.push({ ...r, errPpm: errPpm(r.derivedNano, r.measuredNano) });
  }
  const n = band.length;
  const out = {
    n,
    excluded,
    medianPpm: null,
    p99Ppm: null,
    maxPpm: null,
    sumDerivedNano: null,
    sumMeasuredNano: null,
    diffNano: null,
    diffPpm: null,
    topLevelOnly: band.filter((r) => r.topLevelOnly === 1 || r.topLevelOnly === true).length,
    floor: band.filter((r) => r.floor === 1 || r.floor === true).length,
    outliers: [],
  };
  if (n === 0) return out;
  const errors = band.map((r) => r.errPpm).sort((a, b) => a - b);
  out.medianPpm = nearestRank(errors, 50);
  out.p99Ppm = nearestRank(errors, 99);
  out.maxPpm = errors[n - 1];
  const sd = band.reduce((s, r) => s + big(r.derivedNano), 0n);
  const sm = band.reduce((s, r) => s + big(r.measuredNano), 0n);
  out.sumDerivedNano = Number(sd);
  out.sumMeasuredNano = Number(sm);
  out.diffNano = Number(sd - sm);
  const mag = sd >= sm ? sd - sm : sm - sd;
  const ppm = Number(halfUp(mag * 1000000n, sm));
  out.diffPpm = sd >= sm ? ppm : -ppm;
  out.outliers = band
    .filter((r) => r.errPpm > 0)
    .sort((a, b) => b.errPpm - a.errPpm || byteLess(a.key, b.key))
    .slice(0, MAX_OUTLIERS)
    .map((r) => ({
      key: r.key, errPpm: r.errPpm, derivedNano: r.derivedNano, measuredNano: r.measuredNano, calls: r.calls ?? null,
      role: r.role ?? null, model: r.model ?? null,
    }));
  return out;
}

// The half-up integer of n x 10000 / d (basis points); null when d is 0 or an input is not a non-negative integer.
export function rateBp(n, d) {
  if (!isCount(n) || !isCount(d) || d === 0) return null;
  return Number(halfUp(big(n) * 10000n, big(d)));
}

const twoDecimals = (hundredths) => `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}%`;

// "n/d (P.PP%)", or "n/d (?)" when the rate is unknown (a zero denominator), never 0 percent.
export function formatRate(n, d) {
  const bp = rateBp(n, d);
  return `${n}/${d} (${bp === null ? '?' : twoDecimals(bp)})`;
}

// A ppm value as a percent with two decimals, half up: "0.00%" for 0, "<0.01%" for a non-zero value below
// 50 ppm (half of 0.01 percent), "?" for null. signed: a negative value gets a leading minus.
export function formatPpmPercent(ppm, { signed = false } = {}) {
  if (ppm === null || ppm === undefined) return '?';
  if (!Number.isSafeInteger(ppm) || (!signed && ppm < 0)) throw new TypeError('formatPpmPercent needs an integer ppm');
  const neg = ppm < 0;
  const mag = Math.abs(ppm);
  let text;
  if (mag === 0) text = '0.00%';
  else if (mag < 50) text = '<0.01%';
  else text = twoDecimals(Math.floor((mag + 50) / 100));
  return neg ? `-${text}` : text;
}
