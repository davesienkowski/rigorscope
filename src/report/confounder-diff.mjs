// The confounders of one tier comparison (plan 02-08, TRUST-06, D-17): which of the confounders 02-07 stored per unit changed
// between the compared units, and which are unknown. Pure: imports only src/measure/ modules.
//
// A unit's value for a name is read from its unit_confounder rows of the report's mode (unitConfounderValues). Categorical
// names (model, effort, speed, cc_version, worker_mode, repo and the env fields) are compared as the canonical JSON text of
// the sorted union of the values over the unit's roles (an array of strings, so two byte-equal texts are one value); numeric
// names (unit_size by lines added plus deleted, worker_count, subagents) are compared by the nearest-rank median of each
// side, because every unit has its own size and a distinct-value rule would always fire.
//
// Four states per name over the compared units (the costed units of the compared letter sides):
//   changed         two or more distinct known values occur (categorical), or the per-side medians that exist differ (numeric)
//   unknown         no compared unit has a known value
//   partly-unknown  nothing changed among the known values, but at least one compared unit (or one side, for a numeric name)
//                   has no known value
//   unchanged       every compared unit has a known value and all are equal (the medians are equal)
// A NULL is never read as "unchanged": an unknown confounder can hide a difference, so unknown wins over unchanged (TRUST-06;
// the prohibition test test/prohibitions/null-confounder-unknown.test.mjs holds this). A changed entry reports its unknown
// units too. A unit can also be known for a name yet unknown for some of its calls (unit_confounder.unknown_calls above 0,
// written for model, effort, speed and cc_version; review 02-08 WR-02): the unit keeps its known value, is flagged `partial`
// (unitPartialFlags) and counts in unknown_units but not in the per-side unknown count. A partial unit makes an otherwise equal
// name partly-unknown, never unchanged; changed still wins, because a known difference must not be hidden by a partial unit. Entries come in the order of `names` (02-07's CONFOUNDER_NAMES), values inside an entry are sorted bytewise, and
// the speed confounder is displayed as fast_mode.
import { localDay } from '../measure/period.mjs';
import { nearestRank } from '../measure/stats.mjs';

export const DIFF_STATUSES = Object.freeze(['changed', 'unknown', 'partly-unknown', 'unchanged']);
const KIND_LIST = [
  ['model', 'categorical'], ['effort', 'categorical'], ['speed', 'categorical'], ['cc_version', 'categorical'],
  ['worker_mode', 'categorical'], ['worker_count', 'numeric'], ['subagents', 'numeric'], ['repo', 'categorical'],
  ['unit_size', 'numeric'], ['gsd_version', 'categorical'], ['base_sha', 'categorical'], ['local_mods_head', 'categorical'],
  ['hooks_sha', 'categorical'], ['hook_events', 'categorical'], ['model_default', 'categorical'], ['advisor_model', 'categorical'],
];
export const CONFOUNDER_KINDS = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(KIND_LIST)));
export const DISPLAY_NAMES = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(
  KIND_LIST.map(([n]) => [n, n === 'speed' ? 'fast_mode' : n]),
)));
// Names whose stored value is the JSON text of a sorted array of strings; every other categorical value is plain text.
const ARRAY_NAMES = new Set(['model', 'effort', 'speed', 'cc_version']);
const byteCompare = (a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
const INTEGER_TEXT = /^(0|[1-9][0-9]{0,15})$/;

function categoricalOf(name, rows) {
  const known = new Set();
  for (const r of rows) {
    if (r.value === null || r.value === undefined) continue;
    if (ARRAY_NAMES.has(name)) {
      let list;
      try {
        list = JSON.parse(r.value);
      } catch {
        continue;
      }
      if (Array.isArray(list)) for (const v of list) if (typeof v === 'string') known.add(v);
    } else {
      known.add(String(r.value));
    }
  }
  return known.size === 0 ? null : JSON.stringify([...known].sort(byteCompare));
}

function numericOf(name, rows) {
  const r = rows.find((x) => x.value !== null && x.value !== undefined);
  if (!r) return null;
  if (name === 'unit_size') {
    try {
      const s = JSON.parse(r.value);
      return Number.isSafeInteger(s?.added) && Number.isSafeInteger(s?.deleted) ? s.added + s.deleted : null;
    } catch {
      return null;
    }
  }
  return INTEGER_TEXT.test(String(r.value)) ? Number(r.value) : null;
}

// rows: the unit_confounder rows of one unit and one mode ({ name, role, value }). -> an object with every name in
// CONFOUNDER_KINDS order: the canonical JSON text (categorical), an integer (numeric) or null (unknown).
export function unitConfounderValues(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = {};
  for (const name of Object.keys(CONFOUNDER_KINDS)) {
    const mine = list.filter((r) => r.name === name);
    out[name] = CONFOUNDER_KINDS[name] === 'numeric' ? numericOf(name, mine) : categoricalOf(name, mine);
  }
  return out;
}

// rows: the unit_confounder rows of one unit and one mode ({ name, unknown_calls }). -> { name: true } for every name with a role
// row that has unknown_calls above 0 (some of the unit's calls have no value for it); no other key is present.
export function unitPartialFlags(rows) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    if (Number.isInteger(r?.unknown_calls) && r.unknown_calls > 0) out[r.name] = true;
  }
  return out;
}

// units: [{ start_ms, end_ms }]. -> { start_ms, end_ms, unknown_dates }: the closed span from the earliest known start to the
// latest known end; a unit with an unknown start or end is counted in unknown_dates and its known bound is still used.
export function comparisonWindow(units) {
  let start = null;
  let end = null;
  let unknown = 0;
  for (const u of Array.isArray(units) ? units : []) {
    const s = Number.isFinite(u?.start_ms) ? u.start_ms : null;
    const e = Number.isFinite(u?.end_ms) ? u.end_ms : null;
    if (s === null || e === null) unknown += 1;
    if (s !== null && (start === null || s < start)) start = s;
    if (e !== null && (end === null || e > end)) end = e;
  }
  return { start_ms: start, end_ms: end, unknown_dates: unknown };
}

// w: a comparisonWindow result. -> { first_day, last_day, unknown_dates } in the zone tz (a day is null when no compared unit has that
// bound known), or null when there is no unit at all (both bounds unknown and unknown_dates 0). The count is kept even when no
// bound is known, so units of unknown dates are never dropped silently (review 02-08 WR-03).
export function dayWindow(w, tz) {
  if (w.start_ms === null && w.end_ms === null && w.unknown_dates === 0) return null;
  return {
    first_day: w.start_ms === null ? null : localDay(w.start_ms, tz),
    last_day: w.end_ms === null ? null : localDay(w.end_ms, tz),
    unknown_dates: w.unknown_dates,
  };
}

const valueOf = (u, name) => {
  const v = u?.values?.[name];
  return v === undefined ? null : v;
};

// A unit with a known value that is partial for the name (some of its calls unknown): counted per side as `partial`.
const partialOf = (u, name) => u?.partial?.[name] === true;
const partialCount = (units, name) => units.filter((u) => valueOf(u, name) !== null && partialOf(u, name)).length;

function categoricalEntry(name, sides) {
  const per = sides.map((s) => {
    const vals = s.units.map((u) => valueOf(u, name));
    const known = vals.filter((v) => v !== null);
    return {
      tier: s.tier, values: [...new Set(known)].sort(byteCompare), known: known.length, unknown: vals.length - known.length,
      partial: partialCount(s.units, name),
    };
  });
  const distinct = new Set(per.flatMap((p) => p.values));
  const unknownUnits = per.reduce((n, p) => n + p.unknown + p.partial, 0);
  let status;
  if (distinct.size === 0) status = 'unknown';
  else if (distinct.size >= 2) status = 'changed';
  else status = unknownUnits > 0 ? 'partly-unknown' : 'unchanged';
  return { status, sides: per, unknown_units: unknownUnits };
}

function numericEntry(name, sides) {
  const per = sides.map((s) => {
    const vals = s.units.map((u) => valueOf(u, name));
    const known = vals.filter((v) => v !== null).sort((a, b) => a - b);
    return {
      tier: s.tier, median: known.length === 0 ? null : nearestRank(known, 50), known: known.length, unknown: vals.length - known.length,
      partial: partialCount(s.units, name),
    };
  });
  const unknownUnits = per.reduce((n, p) => n + p.unknown + p.partial, 0);
  const medians = per.filter((p) => p.median !== null).map((p) => p.median);
  let status;
  if (medians.length === 0) status = 'unknown';
  else if (new Set(medians).size >= 2) status = 'changed';
  else status = unknownUnits > 0 ? 'partly-unknown' : 'unchanged';
  return { status, sides: per, unknown_units: unknownUnits };
}

// sides: [{ tier, units: [{ key, values, partial, start_ms, end_ms }] }] (the compared letter sides in A, B, C order); names: the
// confounder names to compare, in report order. -> one entry per name { name, display, kind, status, sides, unknown_units },
// or [] when fewer than two sides are given (there is nothing to compare).
export function diffConfounders(sides, { names = Object.keys(CONFOUNDER_KINDS) } = {}) {
  if (!Array.isArray(sides) || sides.length < 2) return [];
  return names.map((name) => {
    const kind = CONFOUNDER_KINDS[name] ?? 'categorical';
    const body = kind === 'numeric' ? numericEntry(name, sides) : categoricalEntry(name, sides);
    return {
      name, display: DISPLAY_NAMES[name] ?? name, kind, status: body.status, sides: body.sides, unknown_units: body.unknown_units,
    };
  });
}
