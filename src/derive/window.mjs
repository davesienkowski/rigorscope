// The window-share estimator (plan 01-06, D-11a, D-09, RR-04). Pure: no file, no database, no clock.
//
// The subscription windows are account-level percentages recorded at snapshot instants. Between two
// consecutive snapshots of one window, the percentage delta is spread over the token parts of the calls in
// that interval in proportion to their weight, and labeled estimated. An interval gives no share (unknown,
// never 0) when the window reset between the snapshots, the percentage fell without a reset, it did not move
// (below the one-point resolution of the source), a part in it has an unknown token class, or its parts weigh
// nothing at all. A zero-weight part inside a usable interval gets the share 0.
//
// Rules:
//   - weight = input + output + cache_read + cache_creation with the equal weights of WINDOW_WEIGHTS (a plain
//     reading of "token deltas", not a claim about how the provider counts usage); changing them means
//     raising PASS_VERSION
//   - same window: reset instants at most SAME_WINDOW_TOLERANCE_MS apart (the cache may jitter)
//   - interval membership is half-open: (earlier snapshot, later snapshot]
//   - shares are integer micro-points (1 point = MICRO), distributed with BigInt products and the largest
//     remainder rule (ties by position), so the shares of an interval sum to its delta exactly
//   - deterministic orders: snapshots by (fetchedAtMs, source bytewise; a later one in the same millisecond is
//     dropped), parts by (timestamp, call key bytewise, part seq)
export const WINDOWS = Object.freeze(['five_hour', 'seven_day']);
export const WINDOW_WEIGHTS = Object.freeze({ input: 1, output: 1, cache_read: 1, cache_creation: 1 });
// Weight name -> api_call_part column, in the printed order.
const WEIGHT_COLUMNS = Object.freeze([
  ['input', 'input_tokens'], ['output', 'output_tokens'], ['cache_read', 'cache_read'], ['cache_creation', 'cache_creation'],
]);
export const WINDOW_WEIGHTS_TEXT = WEIGHT_COLUMNS.map(([k]) => `${k}:${WINDOW_WEIGHTS[k]}`).join(',');
export const SAME_WINDOW_TOLERANCE_MS = 60000;
export const MICRO = 1000000;
export const INTERVAL_STATUSES = Object.freeze(['usable', 'reset', 'falling', 'flat', 'unknown_tokens', 'zero_weight']);

const RANGE = 'window estimator value out of range';
const safe = (v) => {
  if (!Number.isSafeInteger(v)) throw new Error(RANGE);
  return v;
};
const bytewise = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// tokens: { input_tokens, output_tokens, cache_read, cache_creation }. null when any class is unknown or the
// weighted sum is not a safe integer; never 0 for an unknown.
export function partWeight(tokens, weights = WINDOW_WEIGHTS) {
  let total = 0;
  for (const [name, column] of WEIGHT_COLUMNS) {
    const v = tokens?.[column];
    if (v === null || v === undefined || !Number.isSafeInteger(v) || v < 0) return null;
    total += v * weights[name];
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

// a, b: { tsMs, pct, resetsMs } of one window, a before b. null when the timestamps are equal; otherwise the
// status by precedence reset, falling, flat, usable, and for usable the delta in micro-points.
export function classifyInterval(a, b) {
  if (a.tsMs === b.tsMs) return null;
  if (Math.abs(b.resetsMs - a.resetsMs) > SAME_WINDOW_TOLERANCE_MS) return { status: 'reset', deltaMicro: null };
  if (b.pct < a.pct) return { status: 'falling', deltaMicro: null };
  const delta = Math.round((b.pct - a.pct) * MICRO);
  if (delta <= 0) return { status: 'flat', deltaMicro: null };
  return { status: 'usable', deltaMicro: safe(delta) };
}

// Splits deltaMicro over the weights: floor(delta x w / total) each, then one extra micro-point to each of the
// (delta - sum of floors) largest remainders, ties by position. A zero weight always gets 0. null for an
// empty list or a zero total.
export function distribute(deltaMicro, weights) {
  if (!Array.isArray(weights) || weights.length === 0) return null;
  let total = 0n;
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) throw new Error(RANGE);
    total += BigInt(w);
  }
  if (total === 0n) return null;
  const d = BigInt(safe(deltaMicro));
  const floors = [];
  const rems = [];
  let sum = 0n;
  for (const w of weights) {
    const p = d * BigInt(w);
    floors.push(p / total);
    rems.push(p % total);
    sum += p / total;
  }
  const extra = Number(d - sum);
  const order = weights.map((_, i) => i).sort((i, j) => (rems[j] > rems[i] ? 1 : rems[j] < rems[i] ? -1 : i - j));
  for (let k = 0; k < extra; k += 1) floors[order[k]] += 1n;
  return floors.map((f, i) => (weights[i] === 0 ? 0 : safe(Number(f))));
}

// snapshots: [{ source, fetchedAtMs, five_hour, seven_day }] with each window { pct, resetsMs } or null.
// parts: [{ callKey, partSeq, tsMs, weight }] (tsMs or weight may be null).
// Returns { intervals, shares }: one interval per consecutive snapshot pair of a window, and one share row
// per part inside an interval (shareMicro null unless the interval is usable).
export function estimateWindowShares({ snapshots, parts }) {
  const ordered = parts
    .filter((p) => typeof p.tsMs === 'number' && Number.isFinite(p.tsMs))
    .sort((a, b) => (a.tsMs - b.tsMs) || bytewise(a.callKey, b.callKey) || (a.partSeq - b.partSeq));
  const intervals = [];
  const shares = [];
  for (const win of WINDOWS) {
    const sorted = snapshots
      .filter((s) => s[win] !== null && s[win] !== undefined)
      .map((s) => ({ source: s.source, tsMs: s.fetchedAtMs, pct: s[win].pct, resetsMs: s[win].resetsMs }))
      .sort((a, b) => (a.tsMs - b.tsMs) || bytewise(a.source, b.source));
    const series = sorted.filter((s, i) => i === 0 || s.tsMs !== sorted[i - 1].tsMs);
    let next = 0;
    if (series.length > 0) while (next < ordered.length && ordered[next].tsMs <= series[0].tsMs) next += 1;
    for (let i = 1; i < series.length; i += 1) {
      const a = series[i - 1];
      const b = series[i];
      const c = classifyInterval(a, b);
      const members = [];
      while (next < ordered.length && ordered[next].tsMs <= b.tsMs) {
        members.push(ordered[next]);
        next += 1;
      }
      let weightTotal = 0;
      for (const m of members) {
        if (m.weight === null || m.weight === undefined) { weightTotal = null; break; }
        weightTotal = safe(weightTotal + m.weight);
      }
      let status = c.status;
      if (status === 'usable' && weightTotal === null) status = 'unknown_tokens';
      else if (status === 'usable' && weightTotal === 0) status = 'zero_weight';
      const deltaMicro = status === 'usable' ? c.deltaMicro : null;
      const split = status === 'usable' ? distribute(deltaMicro, members.map((m) => m.weight)) : null;
      const seq = i - 1;
      intervals.push({
        win, seq, startMs: a.tsMs, endMs: b.tsMs, startPct: a.pct, endPct: b.pct, resetsMs: b.resetsMs,
        status, deltaMicro, parts: members.length, weightTotal,
      });
      members.forEach((m, k) => shares.push({
        callKey: m.callKey, partSeq: m.partSeq, win, intervalSeq: seq, shareMicro: split === null ? null : split[k],
      }));
    }
  }
  return { intervals, shares };
}
