// The pure part builder (COST-01, research Pitfall 1). One API call becomes one or more parts, each
// priced later (plan 01-05) at its own model:
//
//   part 0     kind message, at the call model, with the TOP-LEVEL token fields. The top level equals the
//              sum of the message-type iterations on every real message checked (243,064 of 243,064) and
//              does not depend on the iteration order being stable across streaming lines, so the
//              iterations are never used for the executor part.
//   part 1..   kind advisor, one per distinct advisor_message model, summing that model's iterations with
//              NULL propagation (one unknown member makes the class unknown). A NULL model is its own
//              group. Models are ordered bytewise with NULL last.
//
// A call whose has_iterations is 0, NULL or absent gets one part and price basis top_level_only.
// Consistency flags are counted, never corrected: iterMismatch (the message-iteration sum differs from
// the top level in a class where both are known), iterUnknownType (an iteration type other than message
// or advisor_message, which adds no part), cacheSplitMismatch (parts whose cache_creation differs from
// cache_5m + cache_1h, all three known).
export const PART_COLUMNS = Object.freeze(['input_tokens', 'output_tokens', 'cache_read', 'cache_creation', 'cache_5m', 'cache_1h']);

const MESSAGE = 'message';
const ADVISOR = 'advisor_message';

// NULL-propagating sum: unknown when any member is unknown (or there is no member).
function sumOrNull(rows, column) {
  if (rows.length === 0) return null;
  let total = 0;
  for (const r of rows) {
    const v = r[column];
    if (v === null || v === undefined) return null;
    total += v;
  }
  return total;
}

const bytewise = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

export function buildParts({ callModel = null, tokens = {}, hasIterations = 0, iterations = [] } = {}) {
  const executor = { part_seq: 0, kind: 'message', model: callModel ?? null };
  for (const c of PART_COLUMNS) executor[c] = tokens[c] ?? null;
  const parts = [executor];
  let iterMismatch = 0;
  let iterUnknownType = 0;
  const withIterations = Boolean(hasIterations);

  if (withIterations) {
    const messages = [];
    const advisors = new Map(); // model (or null) -> iteration rows
    for (const it of iterations ?? []) {
      if (it.iter_type === MESSAGE) messages.push(it);
      else if (it.iter_type === ADVISOR) {
        const key = it.model ?? null;
        if (!advisors.has(key)) advisors.set(key, []);
        advisors.get(key).push(it);
      } else iterUnknownType = 1;
    }
    if (messages.length > 0) {
      for (const c of PART_COLUMNS) {
        const sum = sumOrNull(messages, c);
        if (sum !== null && executor[c] !== null && sum !== executor[c]) iterMismatch = 1;
      }
    }
    const models = [...advisors.keys()].sort((a, b) => {
      if (a === null) return b === null ? 0 : 1;
      if (b === null) return -1;
      return bytewise(a, b);
    });
    models.forEach((model, i) => {
      const rows = advisors.get(model);
      const part = { part_seq: i + 1, kind: 'advisor', model };
      for (const c of PART_COLUMNS) part[c] = sumOrNull(rows, c);
      parts.push(part);
    });
  }

  let cacheSplitMismatch = 0;
  for (const p of parts) {
    if (p.cache_creation !== null && p.cache_5m !== null && p.cache_1h !== null && p.cache_creation !== p.cache_5m + p.cache_1h) {
      cacheSplitMismatch += 1;
    }
  }
  return {
    parts,
    priceBasis: withIterations ? 'iterations' : 'top_level_only',
    iterMismatch,
    iterUnknownType,
    cacheSplitMismatch,
  };
}
