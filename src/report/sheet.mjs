// The decision sheet (plan 03-05, RPT-06, D-20, TRUST-03, TRUST-09): a short block of questions the present numbers can or cannot
// support. Pure: buildSheet(surface, input) takes the plain data a report already computed and returns rows; it opens no database,
// formats nothing for a terminal and recomputes none of the figures it reads (strata, coverage, tier populations, calibration).
//
// A row has exactly ROW_KEYS. `status` is one of two values. A row never holds a score, a rank, a grade or a recommendation: its
// question and reason are sentences built here from the row's own figures in a closed vocabulary (no word of the forbidden or
// recommendation lists). Rows come in the fixed ROW_IDS order whatever their status, and no row, count or line adds rows up: the
// sheet does not say how many questions can be decided. Every row names a SIGNALS id (`signal`) and the consumer is looked up from
// that entry, so a sheet row cannot exist without someone who acts on it. Evidence ids are `u:` unit ids (or cost row keys for the
// advisor row) in bytewise order, at most MAX_EVIDENCE_IDS, the rest counted in evidence_omitted.
//
// A `can decide today` row has at least one evidence id and low_evidence no, with one stated exception: `units-unclosed` lists
// facts (the started units still open), not an estimate, so its low_evidence mirrors the forward unit count only.
import { formatUsd } from '../measure/measure.mjs';
import { buildRowKey, buildUnitEvidenceId } from '../measure/rowkey.mjs';
import { localDay } from '../measure/period.mjs';
import { LOW_EVIDENCE_PAIRS } from './calibrate.mjs';
import { SIGNALS } from './signals.mjs';
import { costedUnit } from './strata.mjs';
import { ADVISOR_WINDOW_DAYS } from './advisor-trial.mjs';

export const ROW_KEYS = Object.freeze(['id', 'signal', 'consumer', 'population', 'question', 'status', 'reason', 'n', 'low_evidence',
  'evidence_ids', 'evidence_omitted']);
export const MAX_EVIDENCE_IDS = 5;
export const STATUS_CAN = 'can decide today';
export const STATUS_CANNOT = 'cannot';
export const ROW_SURFACE = Object.freeze({
  'units-forward-sample': 'units',
  'units-ledger-use': 'units',
  'units-unclosed': 'units',
  'calibrate-tier': 'units',
  'calibrate-start': 'units',
  'calibrate-end': 'units',
  'calibrate-session': 'units',
  'tier-cost-forward': 'tier',
  'tier-cost-reconstructed': 'tier',
  'tier-source-comparable': 'tier',
  'cost-forward-sample': 'cost',
  'cost-reconstructed-sample': 'cost',
  'advisor-trial': 'cost',
});
export const ROW_IDS = Object.freeze(Object.keys(ROW_SURFACE));
const FACT_ROWS = new Set(['units-unclosed']);
const byteCompare = (a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
const consumerOf = (signal) => {
  const s = SIGNALS.find((x) => x.id === signal);
  if (!s) throw new Error(`sheet: no SIGNALS entry ${signal}`);
  return s.consumer;
};

// parts: { signal, population, question, can, reason, n, floor, lowN, ids }. can is what the figures say; the guard below makes the
// row `cannot` when it would have no evidence id or sits under the low-evidence floor.
export function makeRow(id, parts) {
  const ids = [...new Set(parts.ids ?? [])].sort(byteCompare);
  const lowN = parts.lowN ?? parts.n;
  const low = lowN < parts.floor;
  let status = parts.can === true ? STATUS_CAN : STATUS_CANNOT;
  let reason = parts.reason;
  if (status === STATUS_CAN && ids.length === 0) {
    status = STATUS_CANNOT;
    reason = `${reason}; no evidence id exists to point at`;
  }
  if (status === STATUS_CAN && low && !FACT_ROWS.has(id)) {
    status = STATUS_CANNOT;
    reason = `${reason}; n ${lowN} is below the floor ${parts.floor}`;
  }
  return {
    id,
    signal: parts.signal,
    consumer: consumerOf(parts.signal),
    population: parts.population,
    question: parts.question,
    status,
    reason,
    n: parts.n,
    low_evidence: low,
    evidence_ids: ids.slice(0, MAX_EVIDENCE_IDS),
    evidence_omitted: Math.max(0, ids.length - MAX_EVIDENCE_IDS),
  };
}

// ---- the units rows (J6) ----------------------------------------------------------------------------------------------------

const unitIds = (units, pred) => units.filter(pred).sort((a, b) => byteCompare(a.key, b.key)).map((u) => u.evidenceId ?? buildUnitEvidenceId(u.key));

function forwardSampleRow(input) {
  const st = (input.strata ?? []).find((s) => s.population === 'forward');
  const floor = st?.min_n ?? input.minN;
  const costed = st?.costed ?? 0;
  const can = st !== undefined && costed >= floor;
  let reason = `forward stratum has ${costed} costed units, ${can ? 'at or above' : 'below'} the floor ${floor}`;
  if (st === undefined) reason = 'the forward stratum is not in this report (--population); n 0';
  return makeRow('units-forward-sample', {
    signal: 'unit-inventory',
    population: 'forward',
    question: 'Are there enough costed forward units to read a figure from the forward stratum?',
    can, reason, n: costed, floor, ids: unitIds(input.units ?? [], (u) => u.population === 'forward' && costedUnit(u)),
  });
}

function ledgerUseRow(input) {
  const u = input.unrecorded;
  const floor = input.minN;
  const question = 'Is the ledger used often enough for the forward stratum to stand for the work?';
  if (u.cutoff_day === null) {
    return makeRow('units-ledger-use', {
      signal: 'unrecorded-share', population: 'forward', question, can: false, reason: 'no ledger line exists yet (cutoff none); n 0', n: 0, floor, ids: [],
    });
  }
  const unrecorded = unitIds(input.units ?? [], (x) => x.hasRecon === true && x.ledger === null && typeof x.reconStartMs === 'number'
    && localDay(x.reconStartMs, input.tz) >= u.cutoff_day);
  // With every unit since the cutoff recorded (k 0) the answer is fully determined; the ids then list the forward units.
  const ids = unrecorded.length > 0 ? unrecorded : unitIds(input.units ?? [], (x) => x.population === 'forward');
  const can = u.n >= floor;
  const reason = `${u.k} of ${u.n} units seen since cutoff day ${u.cutoff_day} have no ledger line${can ? '' : `; n ${u.n} is below ${floor}`}`;
  return makeRow('units-ledger-use', {
    signal: 'unrecorded-share', population: 'forward', question, can, reason, n: u.n, floor, ids,
  });
}

function unclosedRow(input) {
  const floor = input.minN;
  const forward = (input.strata ?? []).find((s) => s.population === 'forward');
  const open = unitIds(input.units ?? [], (u) => u.population === 'forward' && u.ledger !== null && u.ledger?.status === 'incomplete');
  const known = input.unrecorded.cutoff_day !== null;
  const ids = open.length > 0 ? open : unitIds(input.units ?? [], (u) => u.population === 'forward');
  const n = input.incomplete?.n ?? 0;
  const reason = known
    ? `${n} started forward units have no close line${open.length === 0 ? '; the evidence ids are forward units checked' : ''}`
    : 'no ledger line exists yet, so no unit can be open; n 0';
  return makeRow('units-unclosed', {
    signal: 'unit-incomplete',
    population: 'forward',
    question: 'Which started units never closed?',
    can: known, reason, n, floor, lowN: forward?.n ?? 0, ids,
  });
}

const FIELD_QUESTION = Object.freeze({
  tier: 'Can reconstructed tiers be trusted for units that have no ledger line?',
  start: 'Can reconstructed start dates be trusted for units that have no ledger line?',
  end: 'Can reconstructed end dates be trusted for units that have no ledger line?',
  session: 'Can reconstructed session links be trusted for units that have no ledger line?',
});

function calibrateRow(f) {
  const can = f.compared >= LOW_EVIDENCE_PAIRS;
  const counts = `agree ${f.agree}, disagree ${f.disagree}, unknown ${f.unknown}`;
  const time = f.median_min === undefined ? '' : `; median ${f.median_min === null ? '?' : f.median_min} min, max ${f.max_min === null ? '?' : f.max_min} min`
    + `; compared by instant ${f.compared_by.instant}, by day ${f.compared_by.day}`;
  const reason = can
    ? `n ${f.n} pairs, compared ${f.compared}: ${counts}${time}`
    : `compared pairs ${f.compared} of ${LOW_EVIDENCE_PAIRS} needed (n ${f.n} pairs with a ledger ${f.field}); ${counts}${time}`;
  return makeRow(`calibrate-${f.field}`, {
    signal: 'calibration-fields',
    population: 'forward',
    question: FIELD_QUESTION[f.field],
    can, reason, n: f.n, lowN: f.compared, floor: LOW_EVIDENCE_PAIRS, ids: f.disagree_ids.length > 0 ? f.disagree_ids : f.pair_ids,
  });
}

function unitsRows(input) {
  return [
    forwardSampleRow(input), ledgerUseRow(input), unclosedRow(input),
    ...input.calibration.fields.map(calibrateRow),
  ];
}

// ---- the tier rows (J6) -----------------------------------------------------------------------------------------------------
// input: { populations: the tier report populations, minN }. The values are the tier report's own strata, counts and leads.

const LETTERS = Object.freeze(['A', 'B', 'C']);
// The best pair of a population: for each stratum the second-largest costed count among the letter rows (the smaller side of the
// best pair of tiers there); the largest of those, with its stratum. 0 when no stratum has two tiers with a costed unit.
function bestPair(pop) {
  let best = { n: 0, stratum: null };
  for (const st of pop.strata) {
    const costed = LETTERS.map((t) => st.rows.find((r) => r.tier === t)?.costed ?? 0).filter((c) => c > 0).sort((a, b) => b - a);
    if (costed.length >= 2 && costed[1] > best.n) best = { n: costed[1], stratum: st.stratum };
  }
  return best;
}
const popOf = (input, name) => (input.populations ?? []).find((p) => p.population === name);
const absent = (id, signal, population, question, floor) => makeRow(id, {
  signal, population, question, can: false, reason: `the ${population} population is not in this report (--population); n 0`, n: 0, floor, ids: [],
});

function tierCostRow(input, name) {
  const id = `tier-cost-${name}`;
  const question = `Can a tier be compared on cost inside one risk stratum for ${name} units?`;
  const floor = input.minN;
  const pop = popOf(input, name);
  if (!pop) return absent(id, 'tier-strata', name, question, floor);
  const best = bestPair(pop);
  const leadIds = pop.leads.flatMap((l) => l.evidence_ids);
  let can = best.n >= floor;
  let reason;
  if (best.stratum === null) reason = 'no stratum has two tiers with a costed unit; n 0';
  else if (!can) reason = `the largest pair of tiers in a stratum has costed n ${best.n}, below the floor ${floor}`;
  else reason = `risk stratum ${best.stratum} has two tiers each with costed n at or above ${floor} (pair n ${best.n})`;
  if (name === 'forward' && pop.counts.comparable < floor) {
    can = false;
    reason = `${reason}; only ${pop.counts.comparable} of ${pop.counts.units} forward units have a comparable tier source, below the floor ${floor}`;
  }
  return makeRow(id, {
    signal: 'tier-strata', population: name, question, can, reason, n: best.n, floor, ids: leadIds,
  });
}

function tierSourceRow(input) {
  const question = 'Are enough forward units tiered at the start (a comparable tier source) to compare tiers?';
  const floor = input.minN;
  const pop = popOf(input, 'forward');
  if (!pop) return absent('tier-source-comparable', 'coverage-shares', 'forward', question, floor);
  const k = pop.counts.comparable;
  const can = k >= floor;
  const ids = pop.strata.flatMap((st) => st.rows.filter((r) => LETTERS.includes(r.tier)).flatMap((r) => r.evidence_ids));
  return makeRow('tier-source-comparable', {
    signal: 'coverage-shares',
    population: 'forward',
    question,
    can,
    reason: `${k} of ${pop.counts.units} forward units have a comparable tier source${can ? '' : `, below the floor ${floor}`}`,
    n: k, floor, ids,
  });
}

function tierRows(input) {
  return [tierCostRow(input, 'forward'), tierCostRow(input, 'reconstructed'), tierSourceRow(input)];
}

// ---- the cost rows (J6) and the advisor trial row (D-25) --------------------------------------------------------------------
// input: { populations: the cost report populations, samples: { forward: [unit key], reconstructed: [unit key] }, advisor, minN }.

function costSampleRow(input, name) {
  const id = `cost-${name}-sample`;
  const question = `Are there enough costed ${name} units to read a cost figure from the ${name} population?`;
  const floor = input.minN;
  const p = (input.populations ?? []).find((x) => x.population === name);
  if (!p) return absent(id, 'cost-population', name, question, floor);
  const can = p.costed >= floor;
  return makeRow(id, {
    signal: 'cost-population',
    population: name,
    question,
    can,
    reason: `${p.costed} of ${p.units} ${name} units have a costed call, ${can ? 'at or above' : 'below'} the floor ${floor}`,
    n: p.costed, floor, ids: (input.samples?.[name] ?? []).map(buildUnitEvidenceId),
  });
}

const modelText = (m) => `${m.model} parts ${m.parts} notional usd ${m.usd_nano === null ? '?' : formatUsd(m.usd_nano / 1e9)}`;
const partsTotal = (models) => models.reduce((sum, m) => sum + m.parts, 0);
const byModels = (models) => (models.length === 0 ? 'no advisor part' : models.slice(0, MAX_EVIDENCE_IDS).map(modelText).join('; '));

// D-25, review 03-05 M4: the baseline window (the 7 days before the first snapshot whose advisor_model differs) and the trial window
// (the 7 days from it), each with its n and the advisor parts by model. `can decide today` only when the trial window has fully
// elapsed (as-of instant) and both windows hold advisor parts; n is the smaller of the two window totals. The row ignores --period and
// the call filters of the report it sits under.
function advisorRow(input) {
  const {
    state, scope, models, baseline = [], trial = [],
  } = input.advisor;
  const floor = input.minN;
  const rule = `window = ${ADVISOR_WINDOW_DAYS} days from the first snapshot whose advisor_model differs from the earliest recorded value`;
  const confounder = 'advisor parts sit inside the role rows, so role-share figures carry that confounder';
  const iso = (ms) => new Date(ms).toISOString();
  const bn = partsTotal(baseline);
  const tn = partsTotal(trial);
  const n = scope === 'window' ? Math.min(bn, tn) : partsTotal(models);
  let can = false;
  let head;
  let where;
  if (state.models_seen.length === 0) {
    head = `no environment snapshot records an advisor_model (${state.snapshots} snapshots, ${state.snapshots_null} without one)`;
  } else if (!state.changed) {
    head = `advisor_model is ${state.baseline} in every snapshot that records one; no snapshot with a different value exists, so no window has started`;
  } else if (!state.full) {
    head = `the first snapshot with a different advisor_model (${state.change_model}) was taken ${iso(state.window_start_ms)}; the trial window ends ${iso(state.window_end_ms)} and is not full yet`;
  } else if (bn === 0 && tn === 0) {
    head = `the trial window is full but neither the baseline window nor the trial window has an advisor part`;
  } else if (bn === 0) {
    head = 'the trial window is full but the baseline window has no advisor part';
  } else if (tn === 0) {
    head = 'the trial window is full but the trial window has no advisor part';
  } else {
    head = 'the trial window is full and both windows have advisor parts';
    can = true;
  }
  if (scope === 'window') {
    where = `baseline window ${iso(state.baseline_start_ms)} to ${iso(state.window_start_ms)}: ${bn} parts (${byModels(baseline)}); `
      + `trial window ${iso(state.window_start_ms)} to ${iso(state.window_end_ms)}: ${tn} parts (${byModels(trial)})`;
  } else {
    where = `advisor parts over all time: ${byModels(models)}`;
  }
  const ids = [...baseline, ...trial, ...(models ?? [])].map((m) => buildRowKey('main', [['model', m.model]]));
  return makeRow('advisor-trial', {
    signal: 'advisor-trial',
    population: 'not-unit-level',
    question: 'Does a full trial window of advisor-model data exist next to a baseline window, so the advisor parts by model can be read side by side?',
    can,
    reason: `${head}; ${where}; ${rule}; ${confounder}`,
    n,
    floor,
    ids,
  });
}

function costRows(input) {
  return [costSampleRow(input, 'forward'), costSampleRow(input, 'reconstructed'), advisorRow(input)];
}

const BUILDERS = { units: unitsRows, tier: tierRows, cost: costRows };

// surface: 'units' | 'tier' | 'cost'. -> the rows of that surface in ROW_IDS order.
export function buildSheet(surface, input) {
  const build = BUILDERS[surface];
  if (!build) throw new RangeError('sheet: unknown surface');
  const rows = build(input);
  return ROW_IDS.filter((id) => ROW_SURFACE[id] === surface).map((id) => rows.find((r) => r.id === id)).filter((r) => r !== undefined);
}
