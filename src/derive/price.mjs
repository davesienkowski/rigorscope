// Pure per-part pricing (plan 01-05, COST-04, D-09, D-10, RR-04). No file, environment or database is read
// here: the table is passed in (src/derive/price-table.mjs builds it), and every result is plain data.
//
// Money is integer nano-dollars (one billionth of a US dollar). Table rates are whole nano-dollars per
// token, so a part's cost is an exact integer sum of tokens x rate; the data-residency multiplier is the
// only division and is rounded half up once per part. Every product and sum is checked with
// Number.isSafeInteger; an unsafe value prices NULL (unknown_tokens), never a float or a wrapped number.
//
// Order of decisions in pricePart (the status follows the first problem in this precedence):
//   1. no table                                  -> no_table
//   2. model id (one -YYYYMMDD stripped) not a table row, matched byte-exactly through a Map
//                                                -> unpriced_model
//   3. modifiers: speed (fast uses the model's fast rates on message parts only), service tier,
//      inference geo (us multiplies by the table's geo_us), prompt-length tier per request; an
//      unrecognized value, a fast rate the table lacks, a fast advisor part, fast over the long tier, or
//      requests on both sides of the tier threshold
//                                                -> unknown_modifier
//   4. tokens: input, output, cache read and cache creation must be known; cache creation is split by
//      TTL (1h tokens at the 1h rate, the rest at the 5m rate); a split above the total, a missing total
//      or an unsafe integer                      -> unknown_tokens
//   5. priced; floors: ttl_unresolved when the split does not resolve the total (the unresolved tokens are
//      priced at the 5m rate, the cheaper write), server_tool_use on the message part of a call that used
//      server tools (their per-use charge is not a token price)
//
// Values that apply no modifier: an absent speed, service tier or geo, and standard, global and
// not_available. Planner decisions recorded in the 01-05 SUMMARY: speed and geo are call-level facts;
// fast applies to message parts only, because the transcript does not say whether an advisor iteration ran
// fast.
export const NANO_PER_USD = 1e9;
export const PRICE_STATUSES = Object.freeze(['priced', 'unpriced_model', 'unknown_tokens', 'unknown_modifier', 'no_table']);
export const FLOOR_REASONS = Object.freeze([
  'ttl_unresolved', 'server_tool_use', 'ttl_unresolved+server_tool_use',
  'server_tool_use_unknown', 'ttl_unresolved+server_tool_use_unknown',
]);
export const PRICE_TIERS = Object.freeze(['standard', 'long_prompt', 'fast']);

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const DATE_SUFFIX_RE = /-\d{8}$/;
const NEUTRAL = new Set(['standard', 'global', 'not_available']);

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const neutral = (v) => v === null || v === undefined || NEUTRAL.has(v);

// One trailing hyphen plus exactly eight digits is removed once. No case folding, trimming or Unicode
// normalization: anything outside the ASCII model-id shape is null (and so never a table row).
export function normalizeModelId(id) {
  if (typeof id !== 'string' || !MODEL_ID_RE.test(id)) return null;
  return id.replace(DATE_SUFFIX_RE, '');
}

const requestOf = (r) => ({
  input: r.input_tokens ?? null,
  cacheRead: r.cache_read ?? null,
  cacheCreation: r.cache_creation ?? null,
  cache5m: r.cache_5m ?? null,
  cache1h: r.cache_1h ?? null,
});

// The requests a part was billed as (one iteration is one request, research assumption A10): a message
// part takes the call's message iterations, an advisor part the advisor iterations of its own model (a
// NULL model is its own group). With no such iteration the part itself is the one request.
// call: { iterations: [{ iter_type, model, input_tokens, cache_read, cache_creation, cache_5m, cache_1h }] }
export function requestsFor(part, call = {}) {
  const iters = Array.isArray(call?.iterations) ? call.iterations : [];
  const rows = part.kind === 'advisor'
    ? iters.filter((i) => i.iter_type === 'advisor_message' && (i.model ?? null) === (part.model ?? null))
    : iters.filter((i) => i.iter_type === 'message');
  return rows.length > 0 ? rows.map(requestOf) : [requestOf(part)];
}

// -> { n5, n1, floor } or null when the split cannot be priced (unknown_tokens).
function splitCreation(part) {
  const c = part.cache_creation;
  const c5 = part.cache_5m ?? null;
  const c1 = part.cache_1h ?? null;
  if ((c5 !== null && !isCount(c5)) || (c1 !== null && !isCount(c1))) return null;
  const k5 = c5 ?? 0;
  const k1 = c1 ?? 0;
  if (k5 + k1 > c) return null;
  const resolved = c === 0
    || (c5 !== null && c1 !== null && c5 + c1 === c)
    || (c5 === null && c1 !== null && c1 === c)
    || (c1 === null && c5 !== null && c5 === c);
  if (resolved) return { n5: c - k1, n1: k1, floor: false };
  // The top-level split may cover only the last iteration (research); the message requests resolve it when
  // their creation, 5m and 1h values all sum to the part's total.
  const reqs = part.requests;
  if (Array.isArray(reqs) && reqs.length > 0
      && reqs.every((r) => isCount(r.cacheCreation) && isCount(r.cache5m) && isCount(r.cache1h))) {
    const sc = reqs.reduce((a, r) => a + r.cacheCreation, 0);
    const s5 = reqs.reduce((a, r) => a + r.cache5m, 0);
    const s1 = reqs.reduce((a, r) => a + r.cache1h, 0);
    if (sc === c && s5 + s1 === c) return { n5: s5, n1: s1, floor: false };
  }
  return { n5: c - k1, n1: k1, floor: true };
}

// Prompt-length tier per request: 'standard', 'long_prompt', or a problem.
function tierOf(part, longPrompt) {
  if (!longPrompt) return { tier: 'standard' };
  const reqs = Array.isArray(part.requests) && part.requests.length > 0 ? part.requests : [requestOf(part)];
  let over = 0;
  let under = 0;
  let missing = false;
  for (const r of reqs) {
    if (!isCount(r.input) || !isCount(r.cacheRead) || !isCount(r.cacheCreation)) { missing = true; continue; }
    const prompt = r.input + r.cacheRead + r.cacheCreation;
    if (!Number.isSafeInteger(prompt)) { missing = true; continue; }
    if (prompt > longPrompt.over) over += 1; else under += 1;
  }
  if (over > 0 && under > 0) return { problem: 'unknown_modifier' };
  if (missing) return { problem: 'unknown_tokens' };
  return { tier: over > 0 ? 'long_prompt' : 'standard' };
}

function mulAdd(acc, tokens, rate) {
  if (acc === null) return null;
  const p = tokens * rate;
  if (!Number.isSafeInteger(p)) return null;
  const s = acc + p;
  return Number.isSafeInteger(s) ? s : null;
}

// part: the api_call_part columns (kind, model, input_tokens, output_tokens, cache_read, cache_creation,
// cache_5m, cache_1h) plus `requests` (requestsFor). ctx: { speed, serviceTier, inferenceGeo,
// serverToolUse } of the call. table: { models, geoUs } or null.
// -> { status, priceModel, tier, geoUs, costNano, floor, floorReason }
export function pricePart(part, ctx = {}, table = null) {
  const geoUs = ctx.inferenceGeo === 'us' ? 1 : 0;
  const result = (status, priceModel = null) => ({
    status, priceModel, tier: null, geoUs, costNano: null, floor: false, floorReason: null,
  });
  if (!table || !(table.models instanceof Map)) return result('no_table');
  const id = normalizeModelId(part.model);
  const row = id === null ? undefined : table.models.get(id);
  if (row === undefined) return result('unpriced_model');

  let modifier = false;
  let tokens = false;
  const fast = ctx.speed === 'fast';
  if (!fast && !neutral(ctx.speed)) modifier = true;
  if (!neutral(ctx.serviceTier)) modifier = true;
  if (!geoUs && !neutral(ctx.inferenceGeo)) modifier = true;
  if (fast && (part.kind !== 'message' || !row.fast)) modifier = true;
  const t = tierOf(part, row.longPrompt);
  if (t.problem === 'unknown_modifier') modifier = true;
  if (t.problem === 'unknown_tokens') tokens = true;
  if (fast && t.tier === 'long_prompt') modifier = true;
  if (modifier) return result('unknown_modifier', id);

  for (const c of ['input_tokens', 'output_tokens', 'cache_read', 'cache_creation']) if (!isCount(part[c])) tokens = true;
  if (tokens) return result('unknown_tokens', id);
  const split = splitCreation(part);
  if (split === null) return result('unknown_tokens', id);

  const tier = fast ? 'fast' : t.tier;
  const r = fast ? row.fast : (tier === 'long_prompt' ? row.longPrompt.rates : row);
  let cost = 0;
  cost = mulAdd(cost, part.input_tokens, r.input);
  cost = mulAdd(cost, part.output_tokens, r.output);
  cost = mulAdd(cost, part.cache_read, r.read);
  cost = mulAdd(cost, split.n5, r.write5m);
  cost = mulAdd(cost, split.n1, r.write1h);
  if (cost !== null && geoUs) {
    const { num, den } = table.geoUs;
    const x = cost * num * 2 + den;
    // Half up, once: floor((cost x num / den) + 1/2) in integers.
    cost = Number.isSafeInteger(x) ? Math.floor(x / (2 * den)) : null;
  }
  if (cost === null) return result('unknown_tokens', id);

  const reasons = [];
  if (split.floor) reasons.push('ttl_unresolved');
  // Plan 01-12: the stored flag is a tri-state. 1 (a stored count above 0) is a floor; NULL (the count was not
  // readable or never stored) is a floor with its own reason, so the lower bound stays honest without claiming a
  // count; 0 and an absent value add nothing.
  if (part.kind === 'message' && ctx.serverToolUse === 1) reasons.push('server_tool_use');
  else if (part.kind === 'message' && ctx.serverToolUse === null) reasons.push('server_tool_use_unknown');
  return {
    status: 'priced',
    priceModel: id,
    tier,
    geoUs,
    costNano: cost,
    floor: reasons.length > 0,
    floorReason: reasons.length > 0 ? reasons.join('+') : null,
  };
}

// Prices every part of one call. The call cost is the sum of its part costs, NULL when any part is NULL
// (never the known sum); it is a floor when any part is; its label is derived when known.
export function priceCall(parts, ctx = {}, table = null) {
  const out = parts.map((p) => pricePart(p, ctx, table));
  let cost = out.length > 0 ? 0 : null;
  for (const r of out) {
    if (cost === null || r.costNano === null) { cost = null; break; }
    cost += r.costNano;
    if (!Number.isSafeInteger(cost)) { cost = null; break; }
  }
  return {
    parts: out,
    costNano: cost,
    floor: cost !== null && out.some((r) => r.floor),
    label: cost === null ? 'unavailable' : 'derived',
  };
}
