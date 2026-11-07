// Comparator for the public demo: flattens the `units --json` and `cost --json` documents of the demo fixture into the
// keys of expected.json and compares value by value. Shared by test/public-demo.test.mjs and scripts/demo.mjs.
import { deepStrictEqual } from 'node:assert/strict';

const shortOf = (unit) => unit.native_id.split('-')[1];

// -> { key: value } for every key of expected.json
export function collect({ units, cost }) {
  const out = {};
  const list = units.units;
  out['units.count'] = list.length;
  out['units.repos'] = new Set(list.map((u) => u.repo.key)).size;
  for (const u of list) {
    const s = shortOf(u);
    out[`tier.${s}`] = u.tier.value;
    out[`start.${s}`] = u.start.utc.slice(0, 10);
    const size = u.confounders.unit_size.value;
    out[`size.${s}.files`] = size.files;
    out[`size.${s}.added`] = size.added;
    for (const k of ['calls', 'input', 'output', 'cache_read', 'cache_write', 'tokens', 'usd_nano']) out[`cost.${s}.${k}`] = u.cost[k];
    out[`model.${s}`] = u.confounders.model.by_role.main.value[0];
    out[`repeat.${s}`] = u.idRepeats;
  }
  const total = cost.sections.main.total;
  out['total.calls'] = total.calls;
  for (const k of ['input', 'output', 'cache_read', 'cache_write']) out[`total.${k}`] = total[k].value;
  out['total.tokens'] = total.input.value + total.output.value + total.cache_read.value + total.cache_write.value;
  out['total.usd_nano'] = total.notional_usd.value;
  const { attributed, unlinked } = units.attribution;
  out['unlinked.calls'] = unlinked.calls;
  out['unlinked.tokens'] = unlinked.tokens;
  out['unlinked.usd_nano'] = unlinked.usd_nano;
  out['attributed.calls'] = attributed.calls;
  out['attributed.tokens'] = attributed.tokens;
  out['attributed.usd_nano'] = attributed.usd_nano;
  for (const block of ['catch', 'escape', 'rework']) {
    out[block] = list.every((u) => u[block].label === 'unavailable') ? 'unavailable' : 'available';
  }
  const noCode = list.find((u) => shortOf(u) === 'd3c');
  out['no_code_unit.cost_known'] = noCode.cost.usd_nano !== null;
  out['no_code_unit.escape'] = noCode.escape.label;
  const c = units.locations.counters;
  out['locations.units_archived'] = c.units_archived;
  out['locations.moved'] = c.moved;
  out['locations.repeat_id'] = c.repeat_id;
  return out;
}

// -> { ok, declared, compared, mismatches: [key] }. A key missing from `expected` lowers `compared` below `declared`.
export function check(expected, actual) {
  const mismatches = [];
  let compared = 0;
  for (const [key, { value }] of Object.entries(expected.values)) {
    compared += 1;
    try {
      deepStrictEqual(actual[key], value);
    } catch {
      mismatches.push(key);
    }
  }
  const declared = expected.declared_values;
  return { ok: mismatches.length === 0 && compared >= declared, declared, compared, mismatches };
}
