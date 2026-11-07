// The versioned JSON documents of the cost report and of the evidence listing (plan 01-08, COST-04, COST-05, TRUST-01,
// TRUST-02, D-09). It imports only src/measure modules. Rules: every measured cell is { value, n, label, coverage,
// evidence }; unknown is null with the label unavailable, never 0, a blank or a string; money is integer nano-dollars,
// tokens are integers, window cells are percent points; a non-finite number anywhere throws instead of becoming null
// in JSON.stringify. Every key is an ASCII constant; the data strings are the shape-checked ones the text report prints.
import { DAY_SOURCES, allPeriod } from '../measure/period.mjs';

export const COST_SCHEMA = 'rigorscope.cost/1';
export const EVIDENCE_SCHEMA = 'rigorscope.evidence/1';
// Plan 02-02 (D-19, ADR-0004): the units listing. /2 (plan 03-04 review fix LOW-1): the top-level `counts` left `units` and `counts`,
// `strata`, `leads` and `leads_omitted` moved into `strata` (units) and `populations` (tier).
export const UNITS_SCHEMA = 'rigorscope.units/2';
export const CALIBRATE_SCHEMA = 'rigorscope.calibrate/1';
// Plan 02-07 (D-19): the evidence of a unit id and of a link id.
export const UNIT_EVIDENCE_SCHEMA = 'rigorscope.unit-evidence/1';
export const LINK_EVIDENCE_SCHEMA = 'rigorscope.link-evidence/1';

const UNITS = Object.freeze({
  input: 'tokens', output: 'tokens', cache_read: 'tokens', cache_write: 'tokens', notional_usd: 'nano_usd',
  window_5h: 'percent_of_window', window_7d: 'percent_of_window',
});
// JSON cell name -> report row field.
const CELLS = [['input', 'input'], ['output', 'output'], ['cache_read', 'cacheRead'], ['cache_write', 'cacheWrite'],
  ['notional_usd', 'notionalUsd'], ['window_5h', 'window_5h'], ['window_7d', 'window_7d']];

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

function checkFinite(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('the JSON document would hold a non-finite number');
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) checkFinite(v);
  }
}

function stringify(doc) {
  checkFinite(doc);
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function cellOf(measure, name, key) {
  const m = measure ?? { value: null, n: 0, label: 'unavailable', coverage: null };
  let value = m.value === undefined ? null : m.value;
  if (value !== null) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('the JSON document would hold a non-finite number');
    if (name === 'notional_usd') value = Math.round(value * 1e9);
  }
  return { value, n: m.n, label: value === null ? 'unavailable' : m.label, coverage: m.coverage ?? null, evidence: key };
}

function rowJson(r) {
  const dims = {};
  for (const d of r.dims) dims[d.name] = { value: d.value, label: d.label };
  const out = { key: r.key, dims, calls: r.calls };
  for (const [name, field] of CELLS) out[name] = cellOf(r[field], name, r.key);
  return out;
}

function sectionJson(rows, total, check) {
  return { rows: rows.map(rowJson), total: total ? rowJson(total) : null, total_check: rows.length > 0 && check ? { ok: check.ok, columns: [...check.columns] } : null };
}

function periodJson(p, tsUnknown) {
  const period = p ?? allPeriod();
  const out = {
    mode: period.mode, tz: period.tz, since_utc: iso(period.sinceMs), until_utc: iso(period.untilMs),
    since_date: period.sinceDate, until_date: period.untilDate,
  };
  if (tsUnknown !== undefined) out.calls_ts_unknown = tsUnknown;
  return out;
}

function freshnessJson(f) {
  return {
    verdict: f.verdict,
    sources: f.sources.map((s) => ({
      name: s.name, live: s.live, limit_hours: s.limitHours, newest_record_utc: s.newestRecordUtc, last_run_utc: s.lastRunUtc,
      record_age_s: s.recordAgeSec, run_age_s: s.runAgeSec, state: s.state,
    })),
  };
}

function windowUsageJson(u) {
  if (!u) return null;
  return {
    source: u.source, label: u.label, fetched_at_utc: iso(u.fetchedAtMs), age_hours: u.ageHours,
    windows: u.windows.map((w) => ({ name: w.name, percent: w.pct, resets_utc: iso(w.resetsMs) })),
  };
}

function groupLabel(measures) {
  const labels = new Set();
  for (const m of measures) if (m.value !== null) labels.add(m.label);
  return labels.size === 0 ? 'unavailable' : [...labels].sort().join('+');
}

export function renderEvidenceJson(e) {
  return stringify(evidenceDoc(e));
}

function evidenceDoc(e) {
  return {
    schema: EVIDENCE_SCHEMA,
    as_of_utc: iso(e.asOfMs),
    clock_fixed: e.clockFixed === true,
    freshness: freshnessJson(e.freshnessCheck),
    period: periodJson(e.period, e.callsTsUnknown),
    row_key: e.rowKey,
    section: e.section,
    dims: e.dims.map((d) => ({ name: d.name, value: d.value })),
    calls: e.calls,
    sessions: e.sessions,
    listed: e.listed,
    items: e.items.map((i) => ({
      call_key: i.callKey, session_id: i.sessionId, agent_id: i.agentId, message_id: i.messageId, request_id: i.requestId,
      ts_utc: i.tsUtc, occurrences: i.occurrences, files: i.files.map((f) => ({ root: f.root, path: f.path, offset: f.offset })),
    })),
  };
}

// evidence: an optional map of row key -> evidence object; the document then gains an `evidence` field.
export function renderCostJson(report, { evidence, sheet } = {}) {
  const sideRows = [...(report.otelRows ?? []), ...(report.harnessRows ?? [])];
  const empty = report.rows.length === 0 && sideRows.length === 0;
  const doc = {
    schema: COST_SCHEMA,
    as_of_utc: iso(report.asOfMs),
    clock_fixed: report.clockFixed === true,
    freshness: freshnessJson(report.freshnessCheck),
    period: periodJson(report.period, report.callsTsUnknown ?? 0),
    by: [...report.by],
    population: report.population ?? 'all',
    populations: report.populations ? report.populations.map((p) => ({ ...p })) : null,
    units: { ...UNITS },
    labels: empty ? null : {
      tokens: groupLabel(report.rows.flatMap((r) => [r.input, r.output, r.cacheRead, r.cacheWrite])),
      notional_usd: report.labels.notional_usd,
      window_share: report.labels.window_share,
      otel_rows: report.labels.otel_rows,
    },
    by_labels: empty ? null : { main: report.byLabels.main, otel_and_harness: report.byLabels.side },
    window_usage: empty ? null : windowUsageJson(report.windowUsage),
    sections: {
      main: sectionJson(report.rows, report.totalRow, report.totalsCheck?.main),
      otel: sectionJson(report.otelRows ?? [], report.otelTotalRow, report.totalsCheck?.otel),
      harness: sectionJson(report.harnessRows ?? [], report.harnessTotalRow, report.totalsCheck?.harness),
    },
    footer: empty ? {} : {
      conservation: report.conservation,
      counts: report.counts,
      totals: report.totals,
      pricing: report.pricing,
      notional: report.notional,
      window: report.window,
      join: report.join,
      roles: report.roleRules,
      otel_only: report.otelOnly,
      crosscheck: report.crosscheck,
      error_band: report.errorBand,
      rules: { harness_sources: report.harnessSources },
    },
  };
  doc.filters = filtersJson(report.filters);
  if (evidence) doc.evidence = Object.fromEntries(Object.entries(evidence).map(([key, e]) => [key, evidenceDoc(e)]));
  if (sheet) doc.sheet = sheetJson(sheet);
  return stringify(doc);
}

// The units document (plan 02-02, UNIT-01, ADR-0004; plan 02-05 fields): one record per unit with every field of the
// shared record shape. A field with no source in this build is null with the label unavailable; the catch, escape and
// rework blocks carry only that label, and confounders holds unit_size only (plan 02-07 adds the others). Plan 02-07
// fills the cost block (costJson) and appends links, attribution and evidence_id after the last 02-05 key; the document
// gains link_confidence and attribution after units.
// conflict, comparable, present and git_evidence are booleans; a date's precision is day for a quick-id or frontmatter
// date and instant otherwise (null for none), and a `clamped` end (review 02-05 WR-03: raised to the start) takes the
// start's precision; artifacts counts each of the ten roles, 0 included. commits_bounded
// (review 02-05 WR-01): true when a plan unit's commits were bounded below by its PLAN's first-add commit, false for a
// plan unit with no such commit (untracked `.planning/`: no bound), null for a quick unit or a unit with no git scan.
const UNAVAILABLE = () => ({ label: 'unavailable' });
// Plan 03-03: a field the forward ledger recorded (the CLI call's clock, an agent-supplied time or tier), never `reconstructed`.
const RECORDED = 'recorded';
const labeled = (value) => (value === null || value === undefined ? 'unavailable' : 'reconstructed');
const precisionOf = (source) => (source === 'none' || source === null || source === undefined ? null : DAY_SOURCES.has(source) ? 'day' : 'instant');

function unitJson(u) {
  return {
    key: u.key,
    framework: u.framework,
    kind: u.kind,
    native_id: u.nativeId,
    dir: u.dir,
    repo: { key: u.repo.key, name: u.repo.name, display: u.repo.display, label: 'reconstructed' },
    branch: { value: u.branch, label: labeled(u.branch) },
    runtime: { value: u.runtime, source: u.runtimeSource ?? null, label: labeled(u.runtime) },
    tier: {
      value: u.tier.value,
      native: u.tier.native,
      signal: u.tier.signal,
      timing: u.tier.timing,
      conflict: u.tier.conflict === true,
      comparable: u.tier.comparable === true,
      label: u.tier.signal === 'ledger' ? RECORDED : labeled(u.tier.value),
    },
    risk_class: { value: u.risk.value, source: u.risk.source, label: labeled(u.risk.value) },
    novelty: { value: u.novelty.value, source: u.novelty.source, label: labeled(u.novelty.value) },
    start: {
      utc: iso(u.startMs), date_source: u.dateSource, precision: precisionOf(u.dateSource),
      label: u.dateSource === 'ledger' ? RECORDED : labeled(u.startMs),
    },
    end: {
      utc: iso(u.endMs),
      date_source: u.endSource,
      precision: precisionOf(u.endSource === 'clamped' ? u.dateSource : u.endSource),
      label: u.endSource === 'ledger' ? RECORDED : labeled(u.endMs),
    },
    git_evidence: u.gitEvidence === true,
    commits_bounded: u.commitsBounded === undefined ? null : u.commitsBounded,
    recorded_at_utc: u.recordedAtUtc,
    population: u.population,
    present: u.present === true,
    idRepeats: u.idRepeats === undefined ? null : u.idRepeats,
    ledger: u.ledger === null || u.ledger === undefined ? null : { ...u.ledger },
    artifacts: { ...u.artifacts },
    cost: costJson(u.cost),
    catch: UNAVAILABLE(),
    escape: UNAVAILABLE(),
    rework: UNAVAILABLE(),
    confounders: {
      unit_size: { value: u.size === null ? null : { ...u.size }, source: u.size === null ? null : 'git', label: labeled(u.size) },
      ...(u.confounders ? {
        model: u.confounders.model,
        effort: u.confounders.effort,
        fast_mode: u.confounders.fast_mode,
        cc_version: u.confounders.cc_version,
        worker: u.confounders.worker,
        env: u.confounders.env,
      } : {}),
    },
    links: (u.links ?? []).map((l) => ({
      evidence_id: l.evidence_id,
      session_id: l.session_id,
      agent_id: l.agent_id,
      confidence: l.confidence,
      methods: l.methods.map((m) => ({
        method: m.method, confidence: m.confidence, base_confidence: m.base_confidence, lowered_by: m.lowered_by, match: m.match,
      })),
    })),
    attribution: u.attribution ? { ...u.attribution } : null,
    evidence_id: u.evidenceId,
  };
}

// Plan 02-07 (UNIT-01, D-13): a unit's attributed cost in the report's link-confidence mode. Tokens are integers, money
// integer nano-dollars (usd_nano), window shares percent points; a unit with no attributed call has calls 0, scopes 0,
// every value null and the label unavailable, never 0.
function costJson(c) {
  if (!c) return UNAVAILABLE();
  const has = c.calls > 0;
  return {
    link_confidence: c.linkConfidence,
    calls: c.calls,
    scopes: c.scopes,
    input: has ? c.input : null,
    output: has ? c.output : null,
    cache_read: has ? c.cache_read : null,
    cache_write: has ? c.cache_write : null,
    tokens: has ? c.tokens : null,
    usd_nano: has ? c.usd_nano : null,
    usd_floor: has ? c.usd_floor === true : null,
    window_5h: has ? c.window_5h : null,
    window_7d: has ? c.window_7d : null,
    label: has ? 'derived' : 'unavailable',
  };
}

// Plan 02-07 (RPT-01): the filters of the listing, each an array of values (null for ?) or null when absent.
function filtersJson(f) {
  const list = (v) => (v === null || v === undefined ? null : [...v]);
  return {
    unit: {
      repo: list(f?.unit?.repo), tier: list(f?.unit?.tier), framework: list(f?.unit?.framework), runtime: list(f?.unit?.runtime),
    },
    call: { model: list(f?.call?.model), role: list(f?.call?.role) },
  };
}

// Review 02-07 WR-05 (RR-05): each bucket labels its two measures. A value is derived when known (a known zero of an empty
// bucket included) and unavailable only when it is null; the values themselves are unchanged, so the buckets still sum to
// the total.
const labelOf = (v) => (v === null || v === undefined ? 'unavailable' : 'derived');
const bucketJson = (b) => ({
  calls: b.calls,
  tokens: b.tokens,
  usd_nano: b.usd_nano,
  refs_unknown_calls: b.refs_unknown_calls,
  labels: { tokens: labelOf(b.tokens), usd_nano: labelOf(b.usd_nano) },
});
// Review fix HIGH-1: the attribution and links figures are over the whole store, both populations, and say so (`scope`).
export const WHOLE_STORE_SCOPE = 'whole store, both populations (not a stratum figure)';
export function attributionJson(a) {
  if (!a) return null;
  return {
    scope: WHOLE_STORE_SCOPE,
    link_confidence: a.mode,
    section: 'main',
    attributed: { ...bucketJson(a.attributed), widened_calls: a.attributed.widened_calls },
    unattributed_overlap: {
      ...bucketJson(a.unattributed_overlap),
      multi_unit_calls: a.unattributed_overlap.multi_unit_calls,
      low_only_calls: a.unattributed_overlap.low_only_calls,
    },
    unlinked: bucketJson(a.unlinked),
    total: bucketJson(a.total),
    refs_unknown_calls: a.refs_unknown_calls,
    check: a.check,
    outside: 'otel and harness calls are outside attribution',
  };
}

// Plan 03-04 (J1): one stratum per selected population, forward first; no figure adds the strata.
const shareJson = (x) => (x === null || x === undefined ? null : { n: x.n, d: x.d });
const coverageJson = (c) => ({
  tiered: shareJson(c.tiered),
  tiered_target_percent: c.tiered_target_percent,
  comparable_source: shareJson(c.comparable_source),
  attributed_usd_nano: shareJson(c.attributed_usd),
  attributed_usd_since_utc: iso(c.attributed_usd_since_ms),
  link_confidence: c.link_confidence,
  dollars_ignore_unit_filters: c.dollars_ignore_unit_filters === true,
  attribution_baseline: c.attribution_baseline === null ? null : { ...c.attribution_baseline },
});
// Review fix HIGH-1 / MEDIUM-1 (D-24): the window split by bucket since the first ledger line instant, and the attribution-unit note.
export const ATTRIBUTION_UNIT_NOTE = 'attribution unit is session + agent: a main session that touched 2 or more units goes to overlap; no improvement is claimed for main sessions';
const windowBucketJson = (b) => ({ calls: b.calls, usd_nano: b.usd_nano, labels: { usd_nano: labelOf(b.usd_nano) } });
const ledgerWindowJson = (w) => ({
  since_utc: iso(w.since_ms),
  link_confidence: 'medium',
  section: 'main',
  scope: 'calls at or after the first ledger line instant, by bucket; not a stratum figure',
  buckets: w.buckets === null ? null : Object.fromEntries(Object.entries(w.buckets).map(([k, b]) => [k, windowBucketJson(b)])),
  total: w.total === null ? null : windowBucketJson(w.total),
  check: w.check === null ? null : { ...w.check },
  ignores_unit_filters: w.ignores_unit_filters === true,
  attribution_unit_note: ATTRIBUTION_UNIT_NOTE,
});
const closeJson = (d) => ({ n: d.n, A: d.A, B: d.B, C: d.C, '?': d['?'] });
const stratumJson = (s) => ({
  population: s.population,
  n: s.n,
  counts: { ...s.counts },
  declared_at_close: closeJson(s.declared_at_close),
  costed: s.costed,
  low_evidence: s.low_evidence,
  min_n: s.min_n,
  coverage: s.coverage ? coverageJson(s.coverage) : null,
});

export function renderUnitsJson(report, { sheet } = {}) {
  return stringify({
    schema: UNITS_SCHEMA,
    as_of_utc: iso(report.asOfMs),
    clock_fixed: report.clockFixed === true,
    freshness: freshnessJson(report.freshnessCheck),
    tz: report.tz,
    population: report.population,
    strata: report.strata.map(stratumJson),
    window: report.window ? ledgerWindowJson(report.window) : null,
    incomplete: report.incomplete ? { ...report.incomplete, listed: report.incomplete.listed.map((r) => ({ ...r })) } : null,
    unrecorded: report.unrecorded ? { ...report.unrecorded } : null,
    overhead: report.overhead ? {
      label: report.overhead.label,
      cap_tokens: report.overhead.cap_tokens,
      kinds: Object.fromEntries(Object.entries(report.overhead.kinds).map(([k, v]) => [k, v === null ? null : { ...v }])),
      finding: report.overhead.finding === null ? null : [...report.overhead.finding],
      ledger_calls: { ...report.overhead.ledger_calls },
    } : null,
    units: report.units.map(unitJson),
    link_confidence: report.linkConfidence ?? 'medium',
    filters: filtersJson(report.filters),
    attribution: attributionJson(report.attribution),
    links: report.linkCounts ? { scope: WHOLE_STORE_SCOPE, ...report.linkCounts, methods: { ...report.linkCounts.methods } } : null,
    locations: report.locations ? { scope: report.locations.scope, repos: report.locations.repos, counters: report.locations.counters === null ? null : { ...report.locations.counters } } : null,
    ...(sheet ? { sheet: sheetJson(sheet) } : {}),
  });
}

const itemJson = (i) => ({
  call_key: i.callKey, session_id: i.sessionId, agent_id: i.agentId, message_id: i.messageId, request_id: i.requestId,
  ts_utc: i.tsUtc, occurrences: i.occurrences, files: i.files.map((f) => ({ root: f.root, path: f.path, offset: f.offset })),
});
const linkMethodJson = (m) => ({
  method: m.method,
  confidence: m.confidence,
  base_confidence: m.base_confidence,
  lowered_by: m.lowered_by,
  match: m.match,
  phase_level: m.phase_level === 1,
  refs: m.refs,
  write_refs: m.write_refs,
  instants: m.instants,
  first_utc: iso(m.first_ms),
  last_utc: iso(m.last_ms),
});

// Plan 02-07: the unit evidence document (rigorscope.unit-evidence/1).
export function renderUnitEvidenceJson(e) {
  const u = e.unit;
  return stringify({
    schema: UNIT_EVIDENCE_SCHEMA,
    as_of_utc: iso(e.asOfMs),
    clock_fixed: e.clockFixed === true,
    freshness: freshnessJson(e.freshnessCheck),
    period: periodJson(e.period, e.callsTsUnknown),
    evidence_id: e.evidenceId,
    link_confidence: e.mode,
    unit: u === null ? null : {
      key: u.unit_key,
      repo: u.repo,
      kind: u.kind,
      native_id: u.native_id,
      tier: u.tier,
      tier_signal: u.tier_signal,
      tier_conflict: u.tier_conflict === 1,
      git_evidence: u.git_evidence === 1,
    },
    links: e.links.map((l) => ({
      evidence_id: l.evidence_id,
      session_id: l.session_id,
      agent_id: l.agent_id,
      confidence: l.confidence,
      methods: l.methods.map(linkMethodJson),
      attribution: { medium: l.attribution.medium, low: l.attribution.low },
    })),
    scopes: e.scopes,
    calls: e.calls,
    listed: e.listed,
    items: e.items.map(itemJson),
  });
}

// Plan 02-07: the link evidence document (rigorscope.link-evidence/1).
export function renderLinkEvidenceJson(e) {
  const u = e.unit;
  const sc = e.scope;
  return stringify({
    schema: LINK_EVIDENCE_SCHEMA,
    as_of_utc: iso(e.asOfMs),
    clock_fixed: e.clockFixed === true,
    freshness: freshnessJson(e.freshnessCheck),
    evidence_id: e.evidenceId,
    unit_key: e.unitKey,
    session_id: e.sessionId,
    agent_id: e.agentId,
    best: e.best,
    scope: sc === null ? null : {
      calls: sc.calls, first_utc: iso(sc.first_ms), last_utc: iso(sc.last_ms), refs_known: sc.refs_known === 1,
    },
    attribution: { medium: e.attribution.medium, low: e.attribution.low },
    unit: u === null ? null : {
      start_utc: iso(u.start_ms), date_source: u.date_source, end_utc: iso(u.end_ms), end_source: u.end_source,
      git_evidence: u.git_evidence === 1,
    },
    methods: e.methods.map(linkMethodJson),
    evidence: {
      refs: e.evidence.refs.map((r) => ({ ...r })),
      commands: e.evidence.commands.map((c) => ({ ...c })),
      skills: e.evidence.skills.map((k) => ({ name: k.name, message_id: k.message_id, ts_utc: iso(k.ts_ms) })),
    },
    totals: { ...e.totals },
  });
}

// ---- the tier report (plan 02-08, D-18, TRUST-07, RPT-01) ----------------------------------------------------------------
// rigorscope.tier/2. Keys are fixed constants in the order of TIER_KEYS (src/report/tier.mjs; a test compares the two).
// Dollars are integer nano-dollars, tokens integers, window shares percent points; catch and escape are
// { value: null, label: 'unavailable' }; an unknown statistic is null, never 0.
export const TIER_SCHEMA = 'rigorscope.tier/2';
// usd_floor: true when a unit in the statistic's set has floor-priced dollars (a lower bound); false for tokens and windows.
const statJson = (s) => ({ median: s.median, p75: s.p75, known: s.known, usd_floor: s.usd_floor === true });
const tierRowJson = (r) => ({
  tier: r.tier,
  n: r.n,
  costed: r.costed,
  compared: r.compared,
  low_evidence: r.low_evidence,
  tokens: statJson(r.tokens),
  usd: statJson(r.usd),
  window_5h: statJson(r.window_5h),
  window_7d: statJson(r.window_7d),
  catch: { value: null, label: 'unavailable' },
  escape: { value: null, label: 'unavailable' },
  evidence_ids: [...r.evidence_ids],
});
// Review 02-08 WR-03: a comparison window with the count of compared units of unknown dates (null days when no bound is known).
const windowJson = (w) => (w === null || w === undefined ? null : { first_day: w.first_day, last_day: w.last_day, unknown_dates: w.unknown_dates });
// Plan 02-08 (TRUST-06): the confounder comparison of a stratum with every entry in full.
const tierConfounderEntryJson = (e) => ({
  name: e.name,
  display: e.display,
  kind: e.kind,
  status: e.status,
  sides: e.sides.map((s) => (e.kind === 'numeric'
    ? { tier: s.tier, median: s.median, known: s.known, unknown: s.unknown, partial: s.partial }
    : { tier: s.tier, values: [...s.values], known: s.known, unknown: s.unknown, partial: s.partial })),
  unknown_units: e.unknown_units,
});
const tierConfoundersJson = (c) => ({
  status: c.status,
  sides: [...c.sides],
  window: windowJson(c.window),
  entries: c.entries.map(tierConfounderEntryJson),
  unchanged: c.unchanged,
});
const tierLeadJson = (l) => ({
  rank: l.rank,
  stratum: l.stratum,
  tiers: [...l.tiers],
  sentence: l.sentence,
  costed: [...l.costed],
  low_evidence: [...l.low_evidence],
  median_tokens: [...l.median_tokens],
  median_usd: [...l.median_usd],
  notional_floor: [...l.notional_floor],
  gap_tokens: l.gap_tokens,
  direction: l.direction,
  confounders_changed: [...l.confounders_changed],
  confounders_unknown: [...l.confounders_unknown],
  window: windowJson(l.window),
  evidence_ids: [...l.evidence_ids],
});
const tierStratumJson = (st) => ({
  stratum: st.stratum,
  units: st.units,
  compared: [...st.compared],
  low_evidence: [...st.low_evidence],
  inferred_excluded: st.inferred_excluded,
  declared_at_close: closeJson(st.declared_at_close),
  window: windowJson(st.window),
  tokens_unknown: st.tokens_unknown,
  usd_unknown: st.usd_unknown,
  window_share_unknown: st.window_share_unknown,
  rows: st.rows.map(tierRowJson),
  confounders: tierConfoundersJson(st.confounders),
});

const tierCountsJson = (c) => ({
  units: c.units,
  tiered: c.tiered,
  comparable: c.comparable,
  inferred_excluded: c.inferred_excluded,
  untiered: c.untiered,
  risk_unknown: c.risk_unknown,
  start_unknown: c.start_unknown,
  strata_shown: c.strata_shown,
  strata_empty: c.strata_empty,
});
// Plan 03-04 (J1): each population is its own block; the top level holds no counts, strata or leads.
const tierPopulationJson = (p) => ({
  population: p.population,
  counts: tierCountsJson(p.counts),
  declared_at_close: closeJson(p.declared_at_close),
  costed: p.costed,
  low_evidence: p.low_evidence,
  strata: p.strata.map(tierStratumJson),
  empty_strata: [...p.emptyStrata],
  leads: (p.leads ?? []).map(tierLeadJson),
  leads_omitted: p.leadsOmitted ?? 0,
});

export function renderTierJson(report, { sheet } = {}) {
  return stringify({
    schema: TIER_SCHEMA,
    as_of_utc: iso(report.asOfMs),
    clock_fixed: report.clockFixed === true,
    freshness: freshnessJson(report.freshnessCheck),
    tz: report.tz,
    period: periodJson(report.period),
    population: report.population,
    link_confidence: report.linkConfidence,
    include_inferred: report.includeInferred === true,
    min_n: report.minN,
    filters: filtersJson(report.filters),
    statistic: {
      rank: 'nearest rank ceil(p x n / 100) over the ascending per-unit values of the costed units; elements, never an average',
      tokens: 'input plus output plus cache_read plus cache_write',
      usd: 'integer nano-dollars, notional',
      window: 'percent points of the 5-hour and 7-day windows',
    },
    attribution: attributionJson(report.attribution),
    populations: report.populations.map(tierPopulationJson),
    ...(sheet ? { sheet: sheetJson(sheet) } : {}),
  });
}

// Plan 03-05 (RPT-06, D-20): the decision sheet rows as the top-level `sheet` array of units, tier and cost with --sheet. Each row
// is copied key by key from the finished rows of src/report/sheet.mjs; nothing is added across rows.
export const sheetJson = (rows) => rows.map((r) => ({ ...r, evidence_ids: [...r.evidence_ids] }));

// Plan 03-05 (LEDG-06, D-19): the calibrate document. One entry per field in the fixed order; no key holds a total across fields.
export function renderCalibrateJson(report, { evidence = false } = {}) {
  const fields = report.fields.map((f) => {
    const out = {
      field: f.field, agree: f.agree, disagree: f.disagree, unknown: f.unknown, n: f.n, ledger_unrecorded: f.ledger_unrecorded,
      compared: f.compared, low_evidence: f.low_evidence,
    };
    if (f.median_min !== undefined) {
      Object.assign(out, {
        median_min: f.median_min, max_min: f.max_min, within_min: f.within_min, compared_by: { instant: f.compared_by.instant, day: f.compared_by.day },
      });
    }
    return out;
  });
  const doc = {
    schema: CALIBRATE_SCHEMA,
    as_of_utc: iso(report.asOfMs),
    clock_fixed: report.clockFixed === true,
    freshness: freshnessJson(report.freshnessCheck),
    tz: report.tz,
    pairs: report.pairs,
    ledger_only: report.ledger_only,
    fields,
  };
  if (evidence) {
    doc.evidence = report.fields.map((f) => ({ field: f.field, disagree_ids: [...f.disagree_ids], disagree_omitted: f.disagree_omitted }));
  }
  return stringify(doc);
}
