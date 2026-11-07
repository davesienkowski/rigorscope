// The ledger overhead of the `units` report (plan 03-04, LEDG-07, D-18; research Q5): a static estimate of the prompt text the
// ledger steps add per unit kind, from the byte sizes of the shipped capability files, and the ledger CLI calls per forward unit
// (its ledger lines). The estimate is characters / 4, the rule of capabilities/forward-ledger/tests/forward-ledger.test.mjs F2:
// a plan unit renders the start and the close skill, a quick unit the planner fragment alone (a quick task has no execute:post
// step). It is an estimate of file sizes, never a measurement of rendered prompt cost, and a missing file is unknown, never 0.
// Plain data only: no text, no absolute path. The directory is resolved relative to this module; tests pass their own.
import { statSync } from 'node:fs';
import { nearestRank } from '../measure/stats.mjs';

export const OVERHEAD_CAP_TOKENS = 300;
export const OVERHEAD_LABEL = 'estimate (chars/4)';
export const OVERHEAD_KINDS = Object.freeze(['plan', 'quick']);
const DEFAULT_DIR = new URL('../../capabilities/forward-ledger/', import.meta.url);
const FILES = Object.freeze({
  start: 'skills/forward-ledger-start/SKILL.md',
  close: 'skills/forward-ledger-close/SKILL.md',
  fragment: 'fragments/plan-pre-quick-unit.md',
});

export const estimateTokens = (chars) => chars / 4;
export const overCap = (chars) => estimateTokens(chars) > OVERHEAD_CAP_TOKENS;

// dir: a URL or path of the capability directory. -> { start, close, fragment } byte sizes, a missing file null.
export function readSizes(dir = DEFAULT_DIR) {
  const base = dir instanceof URL ? dir : new URL(`file://${String(dir).replace(/\/?$/, '/')}`);
  const out = {};
  for (const [name, rel] of Object.entries(FILES)) {
    try {
      out[name] = statSync(new URL(rel, base)).size;
    } catch {
      out[name] = null;
    }
  }
  return out;
}

const sum = (...v) => (v.some((x) => x === null || x === undefined) ? null : v.reduce((a, b) => a + b, 0));

// sizes: { start, close, fragment } (null where unknown). -> { kinds: { plan, quick } each { chars, tokens } or null, finding }:
// finding is the kinds over the cap (an array, empty for none), or null when any kind is unknown.
export function overheadFromSizes(sizes) {
  const chars = { plan: sum(sizes?.start, sizes?.close), quick: sum(sizes?.fragment) };
  const kinds = Object.fromEntries(OVERHEAD_KINDS.map((k) => [k, chars[k] === null ? null : { chars: chars[k], tokens: estimateTokens(chars[k]) }]));
  const unknown = OVERHEAD_KINDS.some((k) => kinds[k] === null);
  return { kinds, finding: unknown ? null : OVERHEAD_KINDS.filter((k) => overCap(chars[k])) };
}

// units: the report's units (toUnit shape). Ledger calls per forward unit = its ledger lines; median by nearest rank (the lower
// middle for an even n) and max; null with no forward unit. Failed calls that wrote no line are not counted (disclosed in the text).
export function ledgerCalls(units) {
  const lines = units.filter((u) => u.population === 'forward' && u.ledger !== null).map((u) => u.ledger.lines).sort((a, b) => a - b);
  if (lines.length === 0) return { n: 0, median: null, max: null };
  return { n: lines.length, median: nearestRank(lines, 50), max: lines[lines.length - 1] };
}

export function loadOverhead(units, { dir } = {}) {
  return {
    ...overheadFromSizes(readSizes(dir)), cap_tokens: OVERHEAD_CAP_TOKENS, label: OVERHEAD_LABEL, ledger_calls: ledgerCalls(units),
  };
}
