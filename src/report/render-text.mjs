// Plain-text renderer for the cost report. It formats Measures and imports nothing but the Measure
// module: no database, no derivation, no ingest (a test scans this file's imports).
//
// Layout: the freshness block (plan 01-08), the period line, then (when rows exist) the window usage line, the table
// with the --by dimensions as leading columns and one `=total` row at the end of each section, the totals check line,
// the labels line, and the footer lines by-labels, scope, conservation, counts, totals, pricing, notional and window in
// that fixed order. With no rows it prints "no rows" and no labels, footer or number.
//
// Window cells (plan 01-06) are estimated shares of the five-hour and weekly windows in percent: "?" when
// unknown, "<0.01%" a positive share below half a hundredth of a point, "0.00%" only a genuine zero.
//
// Dollar cells (plan 01-05) are notional: derived from the versioned price table, never billed or
// measured. A cell is "?" when unknown, ">=" marks a floor, "<0.000001" a positive cost below half a
// micro-dollar.
//
// OTel join (plan 01-07, D-07, D-12): after the main rows (transcript-sourced calls) come two headed blocks, the
// otel-only calls and the harness calls, each printed only when it has rows and laid out with the column widths
// of the whole table. After the labels: line comes `labels (otel rows):` when such rows exist, and after the
// window: line the footer lines join:, roles:, then (only when OTel requests are stored) otel-only:, crosscheck:
// with its disagree lines, error-band: with its outlier lines, and rules:. Every word printed here is a constant;
// the data strings are shape-checked roles, models, request ids and agent names.
import { freshnessLines } from '../measure/freshness.mjs';
import { cell, formatPct, formatUsd, pctCell, usdCell } from '../measure/measure.mjs';
import { allPeriod, formatPeriodLine, localDay } from '../measure/period.mjs';
import { formatPpmPercent, formatRate } from '../measure/stats.mjs';
import { TOTAL_COLUMNS } from '../measure/totals.mjs';
import { renderEvidenceLines } from './render-evidence.mjs';

const NUMERIC = ['calls', 'input', 'output', 'cache_read', 'cache_write', 'notional_usd', 'window_5h', 'window_7d'];
const DEFAULT_BY = ['role', 'model'];

// One label per column group, in a fixed order. A group's label is the label of its known cells;
// with no known cell it is unavailable, and with several sources they are joined with "+".
function groupLabel(measures) {
  const labels = new Set();
  for (const m of measures) if (m.value !== null) labels.add(m.label);
  if (labels.size === 0) return 'unavailable';
  return [...labels].sort().join('+');
}

// A dimension value is shown byte-exactly; a NULL (for example an advisor iteration with no model) is "?".
const dimCell = (v) => (v === null || v === undefined ? '?' : String(v));

export const HEADING_OTEL = 'otel-only calls (no transcript row; role from query_source; tokens executor-only; cost measured by OTel):';
export const HEADING_HARNESS = 'harness calls (query_source is a harness source, never a role; tokens and cost from OTel):';

// blocks: [{ heading (null for the main rows), rows, total }]; widths span every block. A block's total row has the
// first by-column `=total` and the others `=` (a data value cannot contain `=`).
function table(blocks, by) {
  const header = [...by, ...NUMERIC];
  const cellsOf = (r, isTotal) => [
    ...by.map((d, i) => (isTotal ? (i === 0 ? '=total' : '=') : dimCell(r[d]))), String(r.calls), cell(r.input), cell(r.output),
    cell(r.cacheRead), cell(r.cacheWrite), usdCell(r.notionalUsd, { floor: r.notionalFloor === true }), pctCell(r.window_5h), pctCell(r.window_7d),
  ];
  const bodies = blocks.map((b) => ({
    heading: b.heading, cells: [...b.rows.map((r) => cellsOf(r, false)), ...(b.total && b.rows.length > 0 ? [cellsOf(b.total, true)] : [])],
  }));
  const all = bodies.flatMap((b) => b.cells);
  const widths = header.map((h, i) => Math.max(h.length, ...all.map((b) => b[i].length)));
  const fmt = (cells) => cells
    .map((c, i) => (i < by.length ? c.padEnd(widths[i]) : c.padStart(widths[i])))
    .join('  ')
    .trimEnd();
  const out = [fmt(header)];
  for (const b of bodies) {
    if (b.cells.length === 0) continue;
    if (b.heading) out.push(b.heading);
    out.push(...b.cells.map(fmt));
  }
  return out;
}

const num = (v) => (v === null || v === undefined ? '?' : String(v));

function conservationLine(c) {
  if (c.ok) return 'conservation: OK (role sums = model sums = part total = store total for each of the 6 token classes)';
  const entries = c.violations.map((v) => (v.class
    ? `${v.class}(roles=${num(v.roles)} models=${num(v.models)} total=${num(v.total)} store=${num(v.store)}${v.sections === undefined ? '' : ` sections=${num(v.sections)}`})`
    : `${v.name}=${num(v.n)}`));
  return `conservation: VIOLATED ${entries.join(' ')}`;
}

function countsLine(k) {
  return `counts: calls=${num(k.calls)} parts=${num(k.parts)} duplicates_collapsed=${num(k.duplicates_collapsed)} ` +
    `synthetic_skipped=${num(k.synthetic_skipped)} top_level_only=${num(k.top_level_only)} ` +
    `iteration_mismatch=${num(k.iteration_mismatch)} unknown_iteration_type=${num(k.unknown_iteration_type)}`;
}

// A class total: "class=SUM" when every part is known; "class>=SUM(K unknown)" when some are unknown
// (the known sum is a floor, never the total); "class=?(K unknown)" when none is known.
function totalEntry(t) {
  if (t.unknown === 0 && t.sum !== null) return `${t.class}=${t.sum}`;
  if (t.sum === null) return `${t.class}=?(${t.unknown} unknown)`;
  return `${t.class}>=${t.sum}(${t.unknown} unknown)`;
}

const PRICING_FIELDS = [
  'priced_parts', 'unpriced_parts', 'unpriced_model', 'unknown_tokens', 'unknown_modifier', 'no_table',
  'floor_parts', 'server_tool_use_calls', 'server_tool_use_unknown_calls', 'top_level_only_calls',
];

function pricingLine(p) {
  return `pricing: table=${p.table ?? 'none'} read=${p.read ?? 'none'} ` +
    `${PRICING_FIELDS.map((k) => `${k}=${num(p[k])}`).join(' ')} cost_conservation=${p.cost_conservation}`;
}

// "usd=SUM" when every part is priced and none is a floor; "usd>=SUM(U unknown, F floor)" when either
// count is non-zero (the known sum is a lower bound); "usd=?(U unknown)" when no part is priced.
function notionalLine(n) {
  if (!n.known_parts) return `notional: usd=?(${num(n.unknown_parts)} unknown) label=unavailable`;
  const sum = formatUsd(n.known_nano / 1e9);
  const notes = [];
  if (n.unknown_parts > 0) notes.push(`${n.unknown_parts} unknown`);
  if (n.floor_parts > 0) notes.push(`${n.floor_parts} floor`);
  return notes.length > 0 ? `notional: usd>=${sum}(${notes.join(', ')}) label=derived` : `notional: usd=${sum} label=derived`;
}

// UTC ISO instant to the second with a trailing Z.
const isoSecond = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// "window usage: latest recorded session P% (resets T), weekly P% (resets T)[, weekly_opus ...][, weekly_sonnet
// ...]; recorded T via SOURCE (LABEL), age Nh", or "window usage: none recorded". Percentages print as stored.
function windowUsageLine(u) {
  if (u === null) return 'window usage: none recorded';
  const parts = u.windows.map((w) => `${w.name} ${w.pct}% (resets ${isoSecond(w.resetsMs)})`);
  const age = u.ageHours < 1 ? '<1h' : `${u.ageHours}h`;
  return `window usage: latest recorded ${parts.length > 0 ? parts.join(', ') : 'no window'}; ` +
    `recorded ${isoSecond(u.fetchedAtMs)} via ${u.source} (${u.label}), age ${age}`;
}

// "window: weights=TEXT snapshots=N intervals_5h=LIST intervals_7d=LIST parts_5h=K/T parts_7d=K/T
// window_conservation=OK|VIOLATED"; LIST is status:count in the fixed status order, or none.
function windowLine(w) {
  const list = (xs) => (xs.length === 0 ? 'none' : xs.map((x) => `${x.status}:${x.n}`).join(','));
  return `window: weights=${w.weights} snapshots=${num(w.snapshots)} intervals_5h=${list(w.intervals.five_hour)} ` +
    `intervals_7d=${list(w.intervals.seven_day)} parts_5h=${w.parts.five_hour.known}/${w.parts.five_hour.total} ` +
    `parts_7d=${w.parts.seven_day.known}/${w.parts.seven_day.total} window_conservation=${w.conservation}`;
}

const JOIN_COUNTS = ['transcript_calls', 'joined_calls', 'transcript_only_calls', 'otel_sessions', 'sessions_no_transcript',
  'sessions_zero_joined', 'duplicates', 'conflicting_duplicates', 'no_request_id', 'multi_message_requests'];

// "join: otel_requests=N joined=N raw=n/d (P%) joinable=... excl_sdk=... <counts>", or the short form
// "join: otel_requests=0 transcript_calls=N" when no OTel request is stored.
function joinLine(j) {
  if (!j.otel_requests) return `join: otel_requests=${num(j.otel_requests)} transcript_calls=${num(j.transcript_calls)}`;
  const rate = (r) => formatRate(r.n, r.d);
  return `join: otel_requests=${j.otel_requests} joined=${j.joined} raw=${rate(j.rates.raw)} joinable=${rate(j.rates.joinable)} `
    + `excl_sdk=${rate(j.rates.excl_sdk)} ${JOIN_COUNTS.map((k) => `${k}=${num(j[k])}`).join(' ')}`;
}

function rolesLine(r) {
  return `roles: ${r.rules.map((x) => `${x.name}=${x.n}`).join(' ')} conflict_attr_meta=${r.conflict_attr_meta} `
    + `conflict_query_source=${r.conflict_query_source} harness_joined=${r.harness_joined}`;
}

const nanoUsd = (nano) => formatUsd(nano / 1e9);
// A known sum with an unknown count, in the notation of the totals line: name=SUM, name>=SUM(K unknown), name=?(K unknown).
function sumEntry(name, sum, unknown, fmt = String) {
  if (sum === null || sum === undefined) return `${name}=?(${unknown} unknown)`;
  if (unknown > 0) return `${name}>=${fmt(sum)}(${unknown} unknown)`;
  return `${name}=${fmt(sum)}`;
}

function otelOnlyLine(o) {
  return `otel-only: calls=${o.calls} harness_calls=${o.harness_calls} `
    + `${o.classes.map((c) => sumEntry(c.class, c.sum, c.unknown)).join(' ')} ${sumEntry('usd', o.cost.sum, o.cost.unknown, nanoUsd)} `
    + 'label=otel tokens=executor_only';
}

function crosscheckLines(x) {
  return [
    `crosscheck: compared=${x.compared} agree=${x.agree} disagree=${x.disagree} custom=${x.custom} no_name=${x.no_name} `
      + `no_transcript_role=${x.no_transcript_role} not_joined=${x.not_joined}`,
    ...x.pairs.map((p) => `  disagree: transcript=${dimCell(p.transcript)} otel=${dimCell(p.otel)} n=${p.n}`),
  ];
}

const usdOrUnknown = (nano) => (nano === null || nano === undefined ? '?' : nanoUsd(nano));
const signedUsd = (nano) => (nano === null || nano === undefined ? '?' : `${nano < 0 ? '-' : ''}${nanoUsd(Math.abs(nano))}`);

function errorBandLines(b) {
  const p = (v) => formatPpmPercent(v);
  const ex = b.excluded;
  return [
    `error-band: joined n=${b.n} median_abs_err=${p(b.medianPpm)} p99_abs_err=${p(b.p99Ppm)} max_abs_err=${p(b.maxPpm)} `
      + `sum_derived=${usdOrUnknown(b.sumDerivedNano)} sum_measured=${usdOrUnknown(b.sumMeasuredNano)} `
      + `diff=${signedUsd(b.diffNano)} (${formatPpmPercent(b.diffPpm, { signed: true })}) `
      + `excluded=derived_unknown:${ex.derived_unknown},measured_unknown:${ex.measured_unknown},zero_measured:${ex.zero_measured} `
      + `top_level_only=${b.topLevelOnly} floor=${b.floor} measured=otel derived=notional`,
    ...b.outliers.map((o) => `  outlier: request=${o.key} calls=${num(o.calls)} role=${dimCell(o.role)} model=${dimCell(o.model)} `
      + `derived=${usdOrUnknown(o.derivedNano)} measured=${usdOrUnknown(o.measuredNano)} err=${p(o.errPpm)}`),
  ];
}

function rulesLine(sources) {
  return 'rules: role=harness,attribution,meta,transcript_main,query_source,query_source_main,unknown (first match wins); '
    + `sdk=transcript role when joined, else unknown; harness_sources=${sources.join(',')}; effort=transcript else otel; `
    + 'tokens=transcript for transcript calls, otel executor-only for otel-only calls; '
    + 'cost=derived from the price table for transcript calls, otel cost_usd for otel-only calls';
}

const SECTION_ORDER = ['main', 'otel', 'harness'];
const NEW_DIMS = ['effort', 'day', 'session', 'repo', 'population', 'tier', 'unit', 'framework', 'runtime'];
const STRICT_DIMS = ['population', 'tier', 'unit', 'framework'];
export const EVIDENCE_ROW_CAP = 200;

// "totals check: main OK; otel VIOLATED(input, output) (rows sum to the total row in ...)", only sections with rows.
function totalsCheckLine(check) {
  const parts = SECTION_ORDER.filter((name) => check?.[name]).map((name) => (check[name].ok ? `${name} OK` : `${name} VIOLATED(${check[name].columns.join(', ')})`));
  const names = TOTAL_COLUMNS.slice(0, -1).join(', ');
  return `totals check: ${parts.join('; ')} (rows sum to the total row in ${names} and ${TOTAL_COLUMNS[TOTAL_COLUMNS.length - 1]})`;
}

const SCOPE_TAIL = 'rows, totals check, counts (except synthetic_skipped), totals, pricing, notional and otel-only; '
  + 'conservation, window, join, roles, crosscheck and error-band cover all ingested records';
const SCOPE_LINE = `scope: period limits ${SCOPE_TAIL}`;
const FILTER_NOTE = ' (tier and framework filters keep only attributed main-section calls at link_confidence=medium)';
// Review 02-08 WR-05: the model filter acts on the call (api_call.model) while --by model splits the parts, so a call filtered in by
// its model keeps its advisor parts and a part model that is not the call's model selects nothing.
const MODEL_NOTE = '; --model selects calls by the call model while --by model splits by part model, so an advisor part shows under its call\'s model';

// Plan 02-08: the scope line also names the filters that limit the same figures.
function scopeLine(period, filterText, { tierFilter = false, includeInferred = false, modelFilter = false } = {}) {
  const periodScoped = period.mode !== 'all' && (period.sinceMs !== null || period.untilMs !== null);
  const filtered = filterText && (filterText.unit !== 'none' || filterText.call !== 'none');
  if (!filtered) return periodScoped ? SCOPE_LINE : null;
  const limits = periodScoped ? 'period and filters limit' : 'filters limit';
  const inferred = tierFilter ? ` include_inferred=${includeInferred ? 'yes' : 'no'}` : '';
  return `scope: ${limits} ${SCOPE_TAIL}; unit_filters=${filterText.unit} call_filters=${filterText.call}${inferred}${FILTER_NOTE}${modelFilter ? MODEL_NOTE : ''}`;
}

function byLabelsLine(by, byLabels) {
  const part = (m) => by.map((d) => `${d}=${m[d]}`).join(' ');
  const note = by.some((d) => STRICT_DIMS.includes(d)) ? ' (population, tier, unit and framework follow link_confidence=medium)' : '';
  return `by-labels: ${part(byLabels.main)}${byLabels.side ? `; otel and harness rows: ${part(byLabels.side)}` : ''}${note}`;
}

// evidence: an optional array of evidence objects in table order (at most 200 rows, the rest counted in
// evidenceOmitted); evidenceLimit is the K of the heading.
export function renderCostText(report, {
  evidence, evidenceLimit, evidenceOmitted = 0, sheet,
} = {}) {
  const { freshness, rows } = report;
  const by = report.by ?? DEFAULT_BY;
  const lines = [];
  if (report.freshnessCheck) {
    lines.push(...freshnessLines(report.freshnessCheck, { clockFixed: report.clockFixed === true }));
  } else {
    lines.push(
      freshness.lastRunEndUtc
        ? `freshness: transcript newest record ${freshness.newestRecordUtc ?? '?'}; last ingest run ${freshness.lastRunEndUtc} (staleness check not applied in this build)`
        : 'freshness: no ingest recorded',
    );
  }
  const period = report.period ?? allPeriod();
  lines.push(formatPeriodLine(period, { tsUnknown: report.callsTsUnknown ?? 0 }));
  const otelRows = report.otelRows ?? [];
  const harnessRows = report.harnessRows ?? [];
  if (rows.length === 0 && otelRows.length === 0 && harnessRows.length === 0) {
    lines.push('no rows');
    if (sheet) lines.push(...sheetLines(sheet));
    return `${lines.join('\n')}\n`;
  }
  if (report.windowUsage !== undefined) lines.push(windowUsageLine(report.windowUsage));
  lines.push(...table([
    { heading: null, rows, total: report.totalRow }, { heading: HEADING_OTEL, rows: otelRows, total: report.otelTotalRow },
    { heading: HEADING_HARNESS, rows: harnessRows, total: report.harnessTotalRow },
  ], by));
  if (report.totalsCheck) lines.push(totalsCheckLine(report.totalsCheck));
  const tokens = groupLabel(rows.flatMap((r) => [r.input, r.output, r.cacheRead, r.cacheWrite]));
  const notional = report.labels?.notional_usd ?? groupLabel(rows.map((r) => r.notionalUsd));
  const window = report.labels?.window_share ?? groupLabel(rows.flatMap((r) => [r.window_5h, r.window_7d]));
  lines.push(
    `labels: tokens=${tokens} notional_usd=${notional} window_share=${window}; ? means unknown (label unavailable), never zero`,
  );
  const side = report.labels?.otel_rows;
  if (side && (otelRows.length > 0 || harnessRows.length > 0)) {
    lines.push(`labels (otel rows): tokens=${side.tokens} notional_usd=${side.notional_usd} window_share=${side.window_share}`);
  }
  if (report.byLabels && by.some((d) => NEW_DIMS.includes(d))) lines.push(byLabelsLine(by, report.byLabels));
  // Plan 03-04: one line per population, never a line that adds them (the total row stays the call-level conservation total).
  for (const p of report.populations ?? []) {
    lines.push(`population: ${p.population} units=${p.units} costed=${p.costed} low_evidence=${yesNo(p.low_evidence)} (costed: an attributed call and known tokens; units: all units of the population)`);
  }
  const scope = scopeLine(period, report.filterText, { tierFilter: Array.isArray(report.filters?.unit?.tier), includeInferred: report.includeInferred === true,
  modelFilter: Array.isArray(report.filters?.call?.model) });
  if (scope !== null) lines.push(scope);
  if (report.conservation) lines.push(conservationLine(report.conservation));
  if (report.counts) lines.push(countsLine(report.counts));
  if (report.totals) lines.push(`totals: ${report.totals.map(totalEntry).join(' ')}`);
  if (report.pricing) lines.push(pricingLine(report.pricing));
  if (report.notional) lines.push(notionalLine(report.notional));
  if (report.window) lines.push(windowLine(report.window));
  if (report.join) lines.push(joinLine(report.join));
  if (report.roleRules) lines.push(rolesLine(report.roleRules));
  if (report.join?.otel_requests > 0) {
    if (report.otelOnly) lines.push(otelOnlyLine(report.otelOnly));
    if (report.crosscheck) lines.push(...crosscheckLines(report.crosscheck));
    if (report.errorBand) lines.push(...errorBandLines(report.errorBand));
    lines.push(rulesLine(report.harnessSources ?? []));
  }
  if (evidence) {
    lines.push(`evidence (first ${evidenceLimit} calls per row; run rigorscope evidence ROW_KEY for the full listing):`);
    for (const e of evidence) lines.push(...renderEvidenceLines(e, { header: false }));
    if (evidenceOmitted > 0) lines.push(`evidence_rows_omitted=${evidenceOmitted}`);
  }
  if (sheet) lines.push(...sheetLines(sheet));
  return `${lines.join('\n')}\n`;
}

// The units listing (plan 02-02, D-19, D-02; plan 02-05 columns): the freshness block, the population line, the table
// (or "no units"), the units count line and the labels line. NULL prints "?"; start and end are local days in the
// report zone; dates is `<start source>/<end source>`; risk is the tags joined by commas, `none` for a known empty
// set; files and lines are the unit size (files outside `.planning/`, added plus deleted lines).
// Plan 02-07: links is the unit's linked scopes by best final confidence as high/medium/low, tokens and usd its
// attributed cost in the report's link-confidence mode (`?` when unknown or no call is attributed, never 0).
export const UNITS_HEADER = Object.freeze(['repo', 'kind', 'id', 'tier', 'signal', 'timing', 'conflict', 'risk', 'novelty',
  'start', 'end', 'dates', 'files', 'lines', 'links', 'tokens', 'usd']);
// Plan 03-04 (TRUST-03, D-15): one `population:` line per stratum, forward first; the two populations are never one figure.
export const POPULATION_DESCRIPTIONS = Object.freeze({
  forward: 'units a ledger line was recorded for; tier, start and end are recorded where the ledger gave them',
  reconstructed: 'units rebuilt from the .planning directories of repos reached through transcript working directories',
});
export const COVERAGE_ATTRIBUTION_NONE = 'none set';
const yesNo = (v) => (v ? 'yes' : 'no');
export const unitsPopulationLine = (s) => `population: ${s.population} n=${s.n} costed=${s.costed} low_evidence=${yesNo(s.low_evidence)} `
  + `min_n=${s.min_n} (${POPULATION_DESCRIPTIONS[s.population]})`;
// Plan 03-03 (kept): the ledger-sourced tier, start and end are `recorded` (units --json carries the per-field label).
export const UNITS_LABELS_RECORDED_NOTE = '; forward units: tier, start and end=recorded where the ledger gave them (agent-reported, not git-corroborated), reconstructed otherwise';
export const UNITS_LABELS_LINE = 'labels: repo=reconstructed tier=reconstructed start=reconstructed end=reconstructed '
  + 'risk_class=reconstructed novelty=reconstructed unit_size=reconstructed cost=derived links=derived '
  + 'runtime=reconstructed confounders=transcript+reconstructed (units --json); branch, catch, escape and '
  + 'rework=unavailable; ? means unknown, never zero';
// Plan 02-07 (RPT-01, D-13): the scope line, after the population line.
export const WIDENED_NOTE = ' (widened: a scope with no high or medium link counts its one low-confidence unit)';
export const CALL_FILTER_NOTE = ' (cost columns count matching calls only)';
export function unitsScopeLine(report) {
  const f = report.filterText ?? { unit: 'none', call: 'none' };
  return `scope: link_confidence=${report.linkConfidence ?? 'medium'} unit_filters=${f.unit} call_filters=${f.call}`
    + `${f.call === 'none' ? '' : CALL_FILTER_NOTE}${report.linkConfidence === 'low' ? WIDENED_NOTE : ''}`;
}
export const UNITS_EVIDENCE_HEADING = 'evidence (links per unit; run rigorscope evidence ID for the calls):';

// "k/n (P%)" with a "?" percent for a zero denominator, or "?" alone when a side is unknown (ADR-0004).
const shareText = (x) => (x.n === null || x.n === undefined || x.d === null || x.d === undefined ? '?' : formatRate(x.n, x.d));
const usdShareText = (x) => {
  if (x.n === null || x.d === null) return '?';
  return `${formatUsd(x.n / 1e9)}/${formatUsd(x.d / 1e9)} ${formatRate(x.n, x.d).replace(/^\d+\/\d+ /, '')}`;
};

// Plan 03-04 (D-17): one coverage line per stratum. The 90% tiered target and the pending attribution baseline are facts printed
// beside n and the comparable-source share, never a verdict word.
export const IGNORES_UNIT_FILTERS = '(ignores unit filters)';
export function coverageLine(c) {
  const parts = [`coverage: ${c.population} tiered=${shareText(c.tiered)} target ${c.tiered_target_percent}%`];
  if (c.comparable_source !== null) parts.push(`comparable_source=${shareText(c.comparable_source)}`);
  const since = c.attributed_usd_since_ms === null || c.attributed_usd_since_ms === undefined ? '' : ` since ${new Date(c.attributed_usd_since_ms).toISOString()}`;
  parts.push(`attributed_usd=${usdShareText(c.attributed_usd)} link_confidence=${c.link_confidence}${since}`);
  if (c.dollars_ignore_unit_filters === true) parts.push(IGNORES_UNIT_FILTERS);
  if (c.attribution_baseline !== null) {
    const b = c.attribution_baseline;
    const ignore = c.dollars_ignore_unit_filters === true ? `; ${IGNORES_UNIT_FILTERS.slice(1, -1)}` : '';
    parts.push(b.pending ? `attribution target baseline pending (forward units ${b.forward_units} of ${b.needed}${ignore})` : `attribution target ${COVERAGE_ATTRIBUTION_NONE}`);
  }
  return parts.join(' ');
}

// Review fix HIGH-1 / MEDIUM-1 (D-24): the window line (calls and dollars since the first ledger line instant, by bucket, the
// forward-attributed and the reconstructed-attributed buckets apart) and the one sentence naming the attribution unit.
export const WINDOW_LABEL = 'by bucket, not a stratum figure';
export const ATTRIBUTION_UNIT_SENTENCE = 'attribution unit is session + agent: a main session that touched 2 or more units goes to overlap; no improvement is claimed for main sessions';
const windowCell = (b) => (b === null || b === undefined ? '?' : `${b.calls}/${b.usd_nano === null ? '?' : formatUsd(b.usd_nano / 1e9)}`);
export function windowLines(w) {
  const note = w.ignores_unit_filters === true ? ` ${IGNORES_UNIT_FILTERS}` : '';
  const sentence = `  ${ATTRIBUTION_UNIT_SENTENCE}`;
  if (w.since_ms === null || w.since_ms === undefined || w.buckets === null) {
    return [`window: since none (no ledger line yet) link_confidence=medium section=main ${WINDOW_LABEL}: attributed_forward=? attributed_reconstructed=? unattributed_overlap=? unlinked=? total=?${note}`, sentence];
  }
  const b = w.buckets;
  const c = w.check;
  const check = c.calls === 'ok' && c.usd === 'ok' ? 'ok' : (c.calls === 'mismatch' || c.usd === 'mismatch' ? 'MISMATCH' : 'calls_ok_usd_unknown');
  return [`window: since ${new Date(w.since_ms).toISOString()} (first ledger line) link_confidence=medium section=main ${WINDOW_LABEL}: `
    + `attributed_forward=${windowCell(b.attributed_forward)} attributed_reconstructed=${windowCell(b.attributed_reconstructed)} `
    + `unattributed_overlap=${windowCell(b.unattributed_overlap)} unlinked=${windowCell(b.unlinked)} total=${windowCell(w.total)} check=${check}${note}`, sentence];
}

// Age in whole milliseconds as <d>d<h>h, <1h under an hour, ? when unknown.
export function ageText(ms) {
  if (ms === null || ms === undefined) return '?';
  if (ms < 3600000) return '<1h';
  return `${Math.floor(ms / 86400000)}d${Math.floor((ms % 86400000) / 3600000)}h`;
}

export function incompleteLines(inc) {
  const out = [`incomplete: n=${inc.n} listed=${inc.listed.length} oldest=${ageText(inc.oldest_age_ms)}`];
  for (const r of inc.listed) out.push(`  ${dimCell(r.repo)} ${dimCell(r.kind)} ${dimCell(r.id)} ${ageText(r.age_ms)}`);
  if (inc.omitted > 0) out.push(`  incomplete_omitted=${inc.omitted}`);
  return out;
}

// Plan 03-04 (LEDG-07, D-18): the static estimate per unit kind, the ledger calls per forward unit and the finding. `?` for a kind
// whose capability files are absent (never 0). The label is printed before every estimated figure.
export function overheadLine(o) {
  const tok = (k) => (o.kinds[k] === null ? '?' : String(o.kinds[k].tokens));
  const finding = o.finding === null ? '?' : (o.finding.length === 0 ? 'none' : o.finding.join(','));
  const c = o.ledger_calls;
  const calls = c.n === 0 ? 'median=? max=? (no forward unit)' : `median=${c.median} max=${c.max} (forward units ${c.n})`;
  return `overhead: ${o.label} tokens per unit kind: plan=${tok('plan')} quick=${tok('quick')} cap=${o.cap_tokens}; ledger calls per forward unit (ledger lines) ${calls}; `
    + `finding=${finding} (plan renders the start and close skills, quick the planner fragment; file sizes, not rendered prompt cost; `
    + 'calls that wrote no line are not counted; the per-session skill description cost is separate)';
}

export function unrecordedLine(u) {
  const share = u.cutoff_day === null ? '?' : formatRate(u.k, u.n);
  return `unrecorded: ${share} cutoff_day=${u.cutoff_day ?? 'none'} n=${u.n} first_seen_unknown=${u.first_seen_unknown} `
    + '(units reconstruction saw first on or after the cutoff day with no ledger line)';
}

function unitsCountLine(c, closeApart) {
  return `units: n=${c.units} quick=${c.quick} plan=${c.plan} tiered=${c.tiered} untiered=${c.untiered} `
    + `conflicts=${c.conflicts} repos=${c.repos} present=${c.present} comparable=${c.comparable} `
    + `git_evidence=${c.git_evidence} risk_known=${c.risk_known} plan_unbounded=${c.plan_unbounded} end_clamped=${c.end_clamped} `
    + `declared_at_close=${closeApart.n}`;
}

// Plan 02-07: the linked scopes of a unit by best final confidence, high/medium/low.
function linksCell(links) {
  const n = { high: 0, medium: 0, low: 0 };
  for (const l of links ?? []) n[l.confidence] += 1;
  return `${n.high}/${n.medium}/${n.low}`;
}

// Plan 02-07 (D-12): the link counts: per method the (scope, unit) pairs by final confidence, then the pass counters.
const levels = (m) => `${m.high}/${m.medium}/${m.low}`;
export const WHOLE_STORE_LABEL = 'whole store, both populations (not a stratum figure)';
export function linksLine(k) {
  return `links: ${WHOLE_STORE_LABEL} scopes=${k.scopes} refs_unknown=${k.refs_unknown} tool-path=${levels(k.methods['tool-path'])} `
    + `slash-command=${levels(k.methods['slash-command'])} interval=${levels(k.methods.interval)} lowered=${k.lowered} `
    + `dir_name=${k.dir_name} unmatched=${k.unmatched} ambiguous=${k.ambiguous} phase_dropped=${k.phase_dropped} `
    + `slash_ambiguous=${k.slash_ambiguous} no_interval_units=${k.no_interval_units} shared_end_units=${k.shared_end_units}`;
}

// Plan 02-07 (D-13): the attribution buckets of the main section in the report's mode, each calls/tokens/usd.
const bucketCell = (b) => `${b.calls}/${b.tokens === null ? '?' : b.tokens}/${b.usd_nano === null ? '?' : formatUsd(b.usd_nano / 1e9)}`;
export function attributionLine(a) {
  return `attribution: ${WHOLE_STORE_LABEL} link_confidence=${a.mode} section=main attributed=${bucketCell(a.attributed)} `
    + `unattributed_overlap=${bucketCell(a.unattributed_overlap)} (multi-unit=${a.unattributed_overlap.multi_unit_calls} `
    + `low-only=${a.unattributed_overlap.low_only_calls}) unlinked=${bucketCell(a.unlinked)} total=${bucketCell(a.total)} `
    + `refs_unknown=${a.refs_unknown_calls} widened=${a.attributed.widened_calls} check=${a.check === 'ok' ? 'ok' : 'MISMATCH'} `
    + '(otel and harness calls are outside attribution)';
}

const riskCell = (v) => (v === null ? '?' : (v.length === 0 ? 'none' : v.join(',')));
const linesCell = (s) => (s === null || s.added === null || s.deleted === null ? null : String(s.added + s.deleted));

// evidence (plan 02-07): print the unit and link evidence ids of the listed units after the summary lines, at most
// EVIDENCE_ROW_CAP units (the rest counted in evidence_units_omitted).
export function renderUnitsText(report, { evidence = false, sheet } = {}) {
  const lines = [...freshnessLines(report.freshnessCheck, { clockFixed: report.clockFixed === true }), unitsScopeLine(report)];
  const day = (ms) => dimCell(ms === null ? null : localDay(ms, report.tz));
  const rowOf = (u) => [
    dimCell(u.repo.display), dimCell(u.kind), dimCell(u.nativeId), dimCell(u.tier.value), dimCell(u.tier.signal),
    dimCell(u.tier.timing), u.tier.conflict ? 'yes' : 'no', riskCell(u.risk.value), dimCell(u.novelty.value),
    day(u.startMs), day(u.endMs), `${u.dateSource}/${u.endSource}`, dimCell(u.size === null || u.size.files === null ? null : String(u.size.files)),
    dimCell(linesCell(u.size)), linksCell(u.links), dimCell(u.cost.calls > 0 && u.cost.tokens !== null ? String(u.cost.tokens) : null),
    u.cost.calls > 0 && u.cost.usd_nano !== null ? `${u.cost.usd_floor === true ? '>=' : ''}${formatUsd(u.cost.usd_nano / 1e9)}` : '?',
  ];
  for (const stratum of report.strata) {
    const mine = report.units.filter((u) => u.population === stratum.population);
    const rows = mine.map(rowOf);
    const widths = UNITS_HEADER.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
    lines.push(unitsPopulationLine(stratum), fmt(UNITS_HEADER));
    if (rows.length === 0) lines.push('no units');
    else lines.push(...rows.map(fmt));
    lines.push(unitsCountLine(stratum.counts, stratum.declared_at_close));
    if (stratum.coverage) lines.push(coverageLine(stratum.coverage));
  }
  if (report.window) lines.push(...windowLines(report.window));
  if (report.linkCounts) lines.push(linksLine(report.linkCounts));
  if (report.attribution) lines.push(attributionLine(report.attribution));
  if (report.incomplete) lines.push(...incompleteLines(report.incomplete));
  if (report.unrecorded) lines.push(unrecordedLine(report.unrecorded));
  if (report.overhead) lines.push(overheadLine(report.overhead));
  // Plan 03.1-03: both lines are built by src/report/units.mjs (renderers import only measure modules).
  if (report.locationsText) lines.push(report.locationsText);
  if (report.repeatsText) lines.push(report.repeatsText);
  lines.push(`${UNITS_LABELS_LINE}${UNITS_LABELS_RECORDED_NOTE}`);
  if (evidence) {
    lines.push(UNITS_EVIDENCE_HEADING);
    for (const u of report.units.slice(0, EVIDENCE_ROW_CAP)) {
      lines.push(`  unit ${u.evidenceId}`);
      for (const l of u.links ?? []) {
        lines.push(`    link ${l.evidence_id} ${l.methods.map((m) => `${m.method}/${m.confidence}`).join(' ')}`);
      }
    }
    if (report.units.length > EVIDENCE_ROW_CAP) lines.push(`evidence_units_omitted=${report.units.length - EVIDENCE_ROW_CAP}`);
  }
  if (sheet) lines.push(...sheetLines(sheet));
  return `${lines.join('\n')}\n`;
}

// ---- the tier report (plan 02-08, D-18, D-02, TRUST-07) ----------------------------------------------------------------
// The freshness block, period, scope, population, statistic and attribution lines, then per risk stratum one `stratum:`
// line and one table with rows A, B, C and `?` (`?` also stands for every unknown cell), or `no units`. Every sentence and
// number is built by src/report/tier.mjs; this function lays them out.
export const TIER_HEADER = Object.freeze(['tier', 'n', 'costed', 'tokens_median', 'tokens_p75', 'usd_median', 'usd_p75', 'usd_n',
  'window_5h_median', 'window_5h_p75', 'window_7d_median', 'window_7d_p75', 'low_evidence', 'catch', 'escape']);
export const TIER_PERIOD_ALL_PREFIX = "period: all time (units by start; a unit's cost counts all its attributed calls";
export const TIER_STATISTIC_LINE = 'statistic: per-unit values over the costed units of a row (a costed unit has an attributed call and known tokens); '
  + 'median and p75 are elements of the ascending values at nearest rank ceil(p x n / 100), the lower middle for an even n, never an average or an '
  + 'interpolation; tokens are input plus output plus cache read plus cache write; usd is notional and printed with >= when a unit in the set has a floor-priced call (a lower bound); window is the estimated share of the 5-hour '
  + 'and 7-day windows; labels tokens=derived usd=derived window=derived catch=unavailable escape=unavailable; ? means unknown, never zero';
export const TIER_NO_UNITS = 'no units';

// start_unknown is per population (plan 03-04): forward:a,reconstructed:b, never a sum.
const startUnknownText = (report) => report.populations.map((p) => `${p.population}:${p.counts.start_unknown}`).join(',');
export function tierPeriodLine(report) {
  const p = report.period;
  if (!p || p.mode === 'all') return `${TIER_PERIOD_ALL_PREFIX}; start_unknown=${startUnknownText(report)} units have no start and are counted in the rows)`;
  const from = p.sinceMs === null ? 'the first unit' : p.sinceDate;
  const to = p.untilMs === null ? 'the last unit' : `${p.untilDate} inclusive`;
  return `period: from ${from} to ${to}, tz=${p.tz} (units by start; a unit's cost counts all its attributed calls; start_unknown=${startUnknownText(report)} units are outside a bounded period)`;
}

export const INFERRED_NOTE = ' (tiers inferred from probe files are compared; such tiers are circular with catch, TIER-02)';
export const TIER_CALL_FILTER_NOTE = ' (cost columns count matching calls only; confounders describe all attributed calls)';
export function tierScopeLine(report) {
  const f = report.filterText ?? { unit: 'none', call: 'none' };
  return `scope: link_confidence=${report.linkConfidence} include_inferred=${report.includeInferred ? 'yes' : 'no'} min_n=${report.minN} `
    + `unit_filters=${f.unit} call_filters=${f.call}${f.call === 'none' ? '' : TIER_CALL_FILTER_NOTE}`
    + `${report.includeInferred ? INFERRED_NOTE : ''}${report.linkConfidence === 'low' ? WIDENED_NOTE : ''}`;
}

export function tierPopulationLine(pop) {
  const c = pop.counts;
  const d = pop.declared_at_close;
  return `population: ${pop.population} units=${c.units} tiered=${c.tiered} comparable=${c.comparable} inferred_excluded=${c.inferred_excluded} `
    + `declared_at_close=${d.n} untiered=${c.untiered} risk_unknown=${c.risk_unknown} strata=${c.strata_shown} `
    + `empty=${pop.emptyStrata.length === 0 ? 'none' : pop.emptyStrata.join(',')} costed=${pop.costed} low_evidence=${yesNo(pop.low_evidence)} `
    + '(a unit with several risk tags counts once in each of its strata)';
}

const sidesText = (sides) => (sides.length === 0 ? 'none' : sides.join(','));
// window=<first>..<last> unknown_dates=<n>: the days of the known bounds (? where none is known) and the compared units of unknown dates.
const tierWindowText = (w) => {
  const days = w === null || w === undefined || (w.first_day === null && w.last_day === null)
    ? '?' : `${w.first_day ?? '?'}..${w.last_day ?? '?'}`;
  return `${days} unknown_dates=${w?.unknown_dates ?? 0}`;
};
const unknownNum = (v) => (v === null || v === undefined ? '?' : String(v));
const flagCell = (v) => (v === null ? '-' : (v ? 'yes' : 'no'));

export function tierStratumLine(st) {
  return `stratum: ${st.stratum} units=${st.units} compared=${sidesText(st.compared)} low_evidence=${sidesText(st.low_evidence)} `
    + `inferred_excluded=${st.inferred_excluded} declared_at_close=${st.declared_at_close.n} window=${tierWindowText(st.window)} tokens_unknown=${st.tokens_unknown} `
    + `usd_unknown=${st.usd_unknown} window_share_unknown=${st.window_share_unknown}`;
}

function tierRowCells(r) {
  const usd = (v) => (v === null ? '?' : `${r.usd.usd_floor ? '>=' : ''}${formatUsd(v / 1e9)}`);
  const pct = (v) => (v === null ? '?' : formatPct(v));
  return [r.tier, String(r.n), String(r.costed), unknownNum(r.tokens.median), unknownNum(r.tokens.p75), usd(r.usd.median),
    usd(r.usd.p75), String(r.usd.known), pct(r.window_5h.median), pct(r.window_5h.p75), pct(r.window_7d.median), pct(r.window_7d.p75),
    flagCell(r.low_evidence), r.catch.label, r.escape.label];
}

function tierTable(rows) {
  const cells = rows.map(tierRowCells);
  const widths = TIER_HEADER.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const fmt = (c) => c.map((x, i) => x.padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(TIER_HEADER), ...cells.map(fmt)];
}

// Plan 02-08 (TRUST-06): one value of a categorical side as text (the JSON array of strings joined with +), at most three per
// side then `+N more`; a numeric side as its median.
const valueText = (v) => {
  try {
    const list = JSON.parse(v);
    return Array.isArray(list) ? list.join('+') : String(v);
  } catch {
    return String(v);
  }
};
const MAX_SIDE_VALUES = 3;
function sideValuesText(values) {
  const shown = values.slice(0, MAX_SIDE_VALUES).map(valueText);
  return values.length > MAX_SIDE_VALUES ? [...shown, `+${values.length - MAX_SIDE_VALUES} more`].join(', ') : shown.join(', ');
}
function confounderEntryText(e) {
  if (e.status === 'changed') {
    if (e.kind === 'numeric') {
      const label = e.name === 'unit_size' ? 'median lines ' : 'median ';
      return `${e.display} (${label}${e.sides.map((s) => `${s.tier}: ${s.median === null ? '?' : s.median}`).join('; ')})`;
    }
    return `${e.display} (${e.sides.map((s) => `${s.tier}: ${sideValuesText(s.values)}`).join('; ')})`;
  }
  const total = e.sides.reduce((n, s) => n + s.known + s.unknown, 0);
  return `${e.display} (${e.unknown_units} of ${total} units)`;
}
const entriesText = (entries, status) => {
  const list = entries.filter((e) => e.status === status).map(confounderEntryText);
  return list.length === 0 ? 'none' : list.join(', ');
};

export function tierConfoundersLine(st) {
  const c = st.confounders;
  if (c.status !== 'compared') {
    return `confounders: ${st.stratum} no comparison (fewer than two tier sides with attributed cost)`;
  }
  return `confounders: ${st.stratum} ${c.sides.join(',')} window=${tierWindowText(c.window)} changed: ${entriesText(c.entries, 'changed')}; `
    + `unknown: ${entriesText(c.entries, 'unknown')}; partly unknown: ${entriesText(c.entries, 'partly-unknown')}; unchanged=${c.unchanged}`;
}

export const TIER_LEADS_ORDER = "(ordered by the smaller side's costed n, then the median token gap, then stratum and tier order)";
export const TIER_NO_LEADS = 'leads: none (no stratum has two tier sides with attributed cost)';
export function tierLeadsLines(report) {
  const leads = report.leads ?? [];
  if (leads.length === 0) return [TIER_NO_LEADS];
  const omitted = report.leadsOmitted ?? 0;
  const out = [`leads: ${leads.length} of ${leads.length + omitted} ${TIER_LEADS_ORDER}`, ...leads.map((l) => `  ${l.rank}. ${l.sentence}`)];
  if (omitted > 0) out.push(`  leads_omitted=${omitted}`);
  return out;
}

export const TIER_EVIDENCE_HEADING = "evidence (units per row; run rigorscope evidence ID for a unit's calls):";
// --evidence: one `<population> <stratum> <tier> <u: id>` line per unit of each row, at most EVIDENCE_ROW_CAP lines.
export function tierEvidenceLines(report) {
  const all = report.populations.flatMap((p) => p.strata.flatMap((st) => st.rows.flatMap((r) => r.evidence_ids.map((id) => `  ${p.population} ${st.stratum} ${r.tier} ${id}`))));
  const out = [TIER_EVIDENCE_HEADING, ...all.slice(0, EVIDENCE_ROW_CAP)];
  if (all.length > EVIDENCE_ROW_CAP) out.push(`  evidence_units_omitted=${all.length - EVIDENCE_ROW_CAP}`);
  return out;
}

export function renderTierText(report, { evidence = false, sheet } = {}) {
  const lines = [...freshnessLines(report.freshnessCheck, { clockFixed: report.clockFixed === true }), tierPeriodLine(report),
    tierScopeLine(report), TIER_STATISTIC_LINE];
  if (report.attribution) lines.push(attributionLine(report.attribution));
  for (const pop of report.populations) {
    lines.push(tierPopulationLine(pop));
    if (pop.strata.length === 0) {
      lines.push(TIER_NO_UNITS);
      continue;
    }
    for (const st of pop.strata) {
      lines.push(tierStratumLine(st), ...tierTable(st.rows), tierConfoundersLine(st));
    }
    lines.push(...tierLeadsLines(pop));
  }
  if (evidence) lines.push(...tierEvidenceLines(report));
  if (sheet) lines.push(...sheetLines(sheet));
  return `${lines.join('\n')}\n`;
}

// ---- the decision sheet (plan 03-05, RPT-06, D-20) --------------------------------------------------------------------------
// One `sheet:` header line, then per row an indented line with status, n, population, low-evidence state and consumer, and three
// indented detail lines (question, reason, evidence). Rows are printed in the order given, which is the fixed ROW_IDS order; no
// line adds rows up. Every sentence is built by src/report/sheet.mjs; this function lays them out.
export const SHEET_HEADER = 'sheet: one row per question in a fixed order; status, n, population, consumer, reason and evidence ids per row';
export function sheetLines(rows) {
  const lines = [SHEET_HEADER];
  for (const r of rows) {
    lines.push(`  ${r.id}: ${r.status}; n=${r.n}; population=${r.population}; low_evidence=${yesNo(r.low_evidence)}; consumer=${r.consumer}`);
    lines.push(`    question: ${r.question}`);
    lines.push(`    reason: ${r.reason}`);
    const more = r.evidence_omitted > 0 ? ` (omitted=${r.evidence_omitted})` : '';
    lines.push(`    evidence: ${r.evidence_ids.length === 0 ? 'none' : r.evidence_ids.join(' ')}${more}`);
  }
  return lines;
}

// ---- the calibrate report (plan 03-05, LEDG-06, D-19) -----------------------------------------------------------------------
// The freshness block, a `pairs:` line and one line per field (tier, start, end, session), each with its counts and n. A figure
// that does not exist prints `?`, never 0. No line adds fields up.
export const CALIBRATE_PAIRS_NOTE = '(units with both a ledger line and a reconstruction; ledger-only units are in no field)';
export const CALIBRATE_EVIDENCE_HEADING = 'evidence (disagreeing units per field, at most 5 each; run rigorscope evidence ID):';
export function calibrateFieldLine(f) {
  const base = `${f.field}: agree=${f.agree} disagree=${f.disagree} unknown=${f.unknown} n=${f.n} ledger_unrecorded=${f.ledger_unrecorded} `
    + `low_evidence=${yesNo(f.low_evidence)}`;
  if (f.median_min === undefined) return base;
  return `${base} median_min=${unknownNum(f.median_min)} max_min=${unknownNum(f.max_min)} within=${f.within_min} `
    + `compared_by: instant=${f.compared_by.instant} day=${f.compared_by.day}`;
}
export function renderCalibrateText(report, { evidence = false } = {}) {
  const lines = [...freshnessLines(report.freshnessCheck, { clockFixed: report.clockFixed === true }),
    `pairs: pairs=${report.pairs} ledger_only=${report.ledger_only} ${CALIBRATE_PAIRS_NOTE}`];
  for (const f of report.fields) lines.push(calibrateFieldLine(f));
  if (evidence) {
    lines.push(CALIBRATE_EVIDENCE_HEADING);
    for (const f of report.fields) {
      lines.push(`  ${f.field}: ${f.disagree_ids.length === 0 ? 'none' : f.disagree_ids.join(' ')}${f.disagree_omitted > 0 ? ` (omitted=${f.disagree_omitted})` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
