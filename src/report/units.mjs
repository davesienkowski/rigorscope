// loadUnitsReport (plan 02-02, UNIT-01, D-19, RPT-01): the derived unit rows as plain data, with the counts the
// `units` command prints and the per-source freshness verdict. derived.db is opened read-only; the caller runs
// ensureDerived first. Rows are ordered bytewise by repo display, kind and native id (BINARY collation compares
// bytes); the unit key is unique, so the order is total. Fixed SQL text, nothing bound from outside. Plan 02-05 adds
// the end source, git evidence, tier comparability, the unit size, the risk tags (parsed from their JSON text) and the
// artifact count of each of the ten roles (0 included); its review adds commits_bounded and the plan_unbounded count
// (WR-01) and the end_clamped count (WR-03). Plan 02-07 adds, for the report's link-confidence mode (medium, the strict
// default, or low): each unit's attributed cost (src/report/unit-cost.mjs), its links grouped per (session, agent) scope
// with the scope's best final confidence and every method row, its unit_attribution row and its `u:` evidence id; and
// the attribution bucket totals with their check.
import { openDerivedReadOnly } from '../db.mjs';
import { buildLinkEvidenceId, buildUnitEvidenceId } from '../measure/rowkey.mjs';
import { loadFreshness } from './freshness.mjs';
import { callFilterSql, describeFilters, unitFilterSql } from './filters.mjs';
import { loadOverhead } from './overhead.mjs';
import { selectedPopulations } from './population.mjs';
import {
  countUnits, coverageShares, cutoffMs, incompleteList, stratumSummary, unrecordedShare, windowSplit,
} from './strata.mjs';
import {
  loadAttributionTotals, loadLinkCounts, loadPopulationDollars, loadUnitCosts, loadWindowBuckets,
} from './unit-cost.mjs';
import { locationsLine, shownKinds } from '../adapters/gsd-core/layout.mjs';

export { countUnits };

const UNITS_SELECT = `
SELECT u.unit_key, u.framework, u.repo_key, u.repo, u.repo_name, u.kind, u.native_id, u.dir_rel, u.present, u.population,
       u.recorded_at_utc, u.start_ms, u.end_ms, u.date_source, u.branch, u.runtime, u.tier_native, u.tier, u.tier_signal,
       u.tier_timing, u.tier_conflict, u.risk_class, u.risk_source, u.novelty, u.novelty_source, u.end_source, u.git_evidence,
       u.tier_comparable, u.size_commits, u.size_files, u.size_added, u.size_deleted, u.commits_bounded,
       u.status, u.tier_source, u.ledger_lines, u.ledger_command, u.ledger_runtime, u.ledger_session_id, u.has_recon, u.recon_start_ms,
       u.id_repeats
  FROM unit u`;
const UNITS_ORDER = ' ORDER BY u.repo, u.kind, u.native_id, u.unit_key';
// Review fix MEDIUM-3: the forward units before any unit filter (their count is the baseline, their earliest ledger line the cutoff).
const FORWARD_ALL_SQL = "SELECT recorded_at_utc FROM unit WHERE population = 'forward'";
const CONFOUNDERS_SQL = `
SELECT unit_key, name, role, value, unknown_calls, source, label FROM unit_confounder
 WHERE link_confidence = ? ORDER BY unit_key, name, role`;
const RUNTIME_SOURCE = 'rule:linked-transcript@1';
const ENV_NAMES = Object.freeze(['gsd_version', 'base_sha', 'local_mods_head', 'hooks_sha', 'hook_events', 'model_default',
  'advisor_model']);
const parseSet = (v) => {
  if (v === null || v === undefined) return null;
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
};
// Plan 03.1-03 (D-03, J5): the location counters of the latest scan of every repo that wrote the sentinel (derived
// repo_scan_count, summed over those repos) and the repeated-id marker (derived unit.id_repeats). Both come from derived.db,
// so `units` never opens the store. A repo with no sentinel has no row and no id_repeats: unknown, never zero.
export const LOCATIONS_SCOPE = 'per repo scan, summed over the repos scanned; not a stratum figure';
export const REPEAT_IDS_MAX = 5;
const SCAN_REPOS_SQL = 'SELECT count(DISTINCT repo_key) AS n FROM repo_scan_count';
const SCAN_SUMS_SQL = 'SELECT kind, sum(n) AS n FROM repo_scan_count GROUP BY kind';
const REPEAT_UNITS_SQL = 'SELECT unit_key, id_repeats FROM unit WHERE id_repeats IS NOT NULL ORDER BY unit_key';

// -> { locations: { repos, counters }, repeats: { known, units, ids, omitted } }. counters: kind -> n in the order of the
// ingest line (null when no repo wrote the sentinel); repeat_id is the sum of id_repeats over the units that have one.
function loadLocations(db) {
  const repos = db.prepare(SCAN_REPOS_SQL).get().n;
  const sums = new Map(db.prepare(SCAN_SUMS_SQL).all().map((r) => [r.kind, r.n]));
  const rows = db.prepare(REPEAT_UNITS_SQL).all();
  const repeated = rows.filter((r) => r.id_repeats > 0);
  const counters = repos === 0 ? null : Object.fromEntries(shownKinds().map((k) => [
    k, k === 'repeat_id' ? rows.reduce((a, r) => a + r.id_repeats, 0) : (sums.get(k) ?? 0),
  ]));
  return {
    locations: { scope: LOCATIONS_SCOPE, repos, counters },
    repeats: {
      known: repos > 0,
      units: repeated.length,
      ids: repeated.slice(0, REPEAT_IDS_MAX).map((r) => buildUnitEvidenceId(r.unit_key)),
      omitted: Math.max(0, repeated.length - REPEAT_IDS_MAX),
    },
  };
}
// The `locations:` and `repeats:` lines of `units` (plan 03.1-03; D-01, D-03; J3, J6), built here because a renderer imports only
// measure modules. locations has the field order of the ingest line, `?` for every counter when no repo wrote the sentinel;
// repeats is always printed (`units=?` when unknown, `units=0` when scanned with none) and only above 0 names up to
// REPEAT_IDS_MAX unit evidence ids and the sentence.
export const REPEATS_SCOPE = 'reconstructed units, counted per repo scan; not a stratum figure';
export const REPEATS_NOTE = "the unit's cost, commits and ledger lines may include another milestone's activity";
export const unitsLocationsLine = (l) => `${locationsLine(l.counters, l.repos)} (${LOCATIONS_SCOPE})`;
export function unitsRepeatsLine(r) {
  if (!r.known) return `repeats: units=? (${REPEATS_SCOPE})`;
  if (r.units === 0) return `repeats: units=0 (${REPEATS_SCOPE})`;
  const more = r.omitted > 0 ? ` omitted=${r.omitted}` : '';
  return `repeats: units=${r.units} ${r.ids.join(' ')}${more} (${REPEATS_SCOPE}); ${REPEATS_NOTE}`;
}
const intOrNull = (v) => (v === null || v === undefined ? null : Number(v));

// The plan 02-07 confounders of one unit in the report's mode, from its unit_confounder rows (see
// src/derive/confounders.mjs): model, effort and fast_mode (the speed rows) per role, cc_version, worker and env.
function confoundersOf(rows) {
  const at = (name, role = '') => rows.find((r) => r.name === name && r.role === role) ?? null;
  const perRole = (name) => {
    const list = rows.filter((r) => r.name === name && r.role !== '');
    const none = at(name);
    const by = {};
    for (const r of list) {
      by[r.role] = {
        value: parseSet(r.value), unknown_calls: r.unknown_calls, source: r.source, label: r.label,
      };
    }
    return {
      by_role: by,
      source: none ? none.source : 'transcript',
      label: list.some((r) => r.value !== null) ? 'transcript' : 'unavailable',
    };
  };
  const ver = at('cc_version');
  const mode = at('worker_mode');
  return {
    model: perRole('model'),
    effort: perRole('effort'),
    fast_mode: perRole('speed'),
    cc_version: ver ? {
      value: parseSet(ver.value), unknown_calls: ver.unknown_calls, source: ver.source, label: ver.label,
    } : null,
    worker: mode ? {
      mode: mode.value,
      count: intOrNull(at('worker_count')?.value),
      subagents: intOrNull(at('subagents')?.value),
      source: mode.source,
      label: mode.label,
    } : null,
    env: Object.fromEntries(ENV_NAMES.map((n) => {
      const r = at(n);
      return [n, r ? { value: r.value, source: r.source, label: r.label } : null];
    })),
  };
}
const ROLES_SQL = 'SELECT unit_key, role, n FROM unit_role ORDER BY unit_key, role';
const LINKS_SQL = `
SELECT unit_key, session_id, agent_id, method, confidence, base_confidence, lowered_by, match
  FROM unit_link ORDER BY unit_key, session_id, agent_id, method`;
const UNIT_ATTRIBUTION_SQL = `
SELECT unit_key, scopes, sessions, subagent_scopes, calls, refs_unknown_scopes
  FROM unit_attribution WHERE link_confidence = ? ORDER BY unit_key`;
const RANK = Object.freeze({ high: 0, medium: 1, low: 2 });

// Per unit: one entry per (session, agent) scope in key order, with its best final confidence and its method rows.
function linksOf(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.unit_key)) out.set(r.unit_key, []);
    const list = out.get(r.unit_key);
    let e = list[list.length - 1];
    if (!e || e.session_id !== r.session_id || e.agent_id !== r.agent_id) {
      e = {
        evidence_id: buildLinkEvidenceId(r.unit_key, r.session_id, r.agent_id),
        session_id: r.session_id,
        agent_id: r.agent_id,
        confidence: r.confidence,
        methods: [],
      };
      list.push(e);
    }
    if (RANK[r.confidence] < RANK[e.confidence]) e.confidence = r.confidence;
    e.methods.push({
      method: r.method, confidence: r.confidence, base_confidence: r.base_confidence, lowered_by: r.lowered_by, match: r.match,
    });
  }
  return out;
}

const NO_COST = Object.freeze({
  calls: 0, scopes: 0, input: null, output: null, cache_read: null, cache_write: null, tokens: null, usd_nano: null,
  usd_floor: null, window_5h: null, window_7d: null,
});

export const ARTIFACT_ROLE_ORDER = Object.freeze([
  'plan', 'summary', 'context', 'verification', 'review', 'windows', 'rigor-tier', 'probes-skipped', 'probe', 'refute-pass',
]);

function riskTags(text) {
  if (text === null || text === undefined) return null;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) && v.every((t) => typeof t === 'string') ? v : null;
  } catch {
    return null;
  }
}

function toUnit(r, roles) {
  const artifacts = Object.fromEntries(ARTIFACT_ROLE_ORDER.map((role) => [role, roles.get(`${r.unit_key}\0${role}`) ?? 0]));
  const sized = r.size_commits !== null;
  return {
    key: r.unit_key,
    framework: r.framework,
    kind: r.kind,
    nativeId: r.native_id,
    dir: r.dir_rel,
    repo: { key: r.repo_key, name: r.repo_name, display: r.repo },
    branch: r.branch,
    runtime: r.runtime,
    tier: {
      value: r.tier,
      native: r.tier_native,
      signal: r.tier_signal,
      timing: r.tier_timing,
      conflict: r.tier_conflict === 1,
      comparable: r.tier_comparable === 1,
    },
    risk: { value: riskTags(r.risk_class), source: r.risk_source },
    novelty: { value: r.novelty, source: r.novelty_source },
    startMs: r.start_ms,
    dateSource: r.date_source,
    endMs: r.end_ms,
    endSource: r.end_source,
    gitEvidence: r.git_evidence === 1,
    size: sized ? {
      commits: r.size_commits, files: r.size_files, added: r.size_added, deleted: r.size_deleted,
    } : null,
    commitsBounded: r.commits_bounded === null ? null : r.commits_bounded === 1,
    artifacts,
    recordedAtUtc: r.recorded_at_utc,
    population: r.population,
    hasRecon: r.has_recon === 1,
    reconStartMs: r.recon_start_ms,
    present: r.present === 1,
    // Plan 03.1-03 (D-03): the second dirs of this unit's id in another location in the latest scan; null is unknown.
    idRepeats: r.id_repeats === null || r.id_repeats === undefined ? null : r.id_repeats,
    // Plan 03-03 (J9): what the forward ledger recorded for the unit, or null for a unit with no ledger line.
    ledger: r.ledger_lines > 0 ? {
      lines: r.ledger_lines,
      status: r.status,
      command: r.ledger_command,
      runtime: r.ledger_runtime,
      session_id: r.ledger_session_id,
      tier_source: r.tier_source,
    } : null,
  };
}

// mode: the link-confidence mode of the cost, attribution and confounder figures ('medium' or 'low'). filters: the
// result of parseFilters (src/report/filters.mjs) or null. Unit filters restrict the units; call filters restrict the
// cost and the attribution totals to matching calls and list only units with at least one matching attributed call.
export function loadUnitsReport({
  home, now = () => new Date(), tz, clockFixed = false, mode = 'medium', filters = null, population = 'all',
}) {
  const unitWhere = unitFilterSql(filters);
  const callWhere = callFilterSql(filters);
  const nowMs = now().getTime();
  const db = openDerivedReadOnly({ home });
  let units;
  let unrecordedBase;
  let dollars;
  let attribution;
  let linkCounts;
  let forwardAll;
  let window;
  let located;
  try {
    const roles = new Map(db.prepare(ROLES_SQL).all().map((x) => [`${x.unit_key}\0${x.role}`, x.n]));
    const costs = loadUnitCosts(db, { mode, callWhere });
    const confounders = new Map();
    for (const r of db.prepare(CONFOUNDERS_SQL).all(mode)) {
      if (!confounders.has(r.unit_key)) confounders.set(r.unit_key, []);
      confounders.get(r.unit_key).push(r);
    }
    const links = linksOf(db.prepare(LINKS_SQL).all());
    const unitAttr = new Map(db.prepare(UNIT_ATTRIBUTION_SQL).all(mode).map((r) => [r.unit_key, r]));
    const rows = db.prepare(`${UNITS_SELECT}${unitWhere ? ` WHERE ${unitWhere.sql}` : ''}${UNITS_ORDER}`)
      .all(...(unitWhere ? unitWhere.params : []));
    unrecordedBase = rows.map((r) => toUnit(r, roles));
    units = rows.filter((r) => callWhere === null || (costs.get(r.unit_key)?.calls ?? 0) > 0).map((r) => {
      const u = toUnit(r, roles);
      const cost = costs.get(r.unit_key);
      const a = unitAttr.get(r.unit_key);
      return {
        ...u,
        cost: { ...(cost && cost.calls > 0 ? cost : NO_COST), linkConfidence: mode },
        links: links.get(r.unit_key) ?? [],
        attribution: a ? {
          scopes: a.scopes, sessions: a.sessions, subagent_scopes: a.subagent_scopes, calls: a.calls,
          refs_unknown_scopes: a.refs_unknown_scopes,
        } : null,
        evidenceId: buildUnitEvidenceId(r.unit_key),
        runtimeSource: r.runtime === null ? null : RUNTIME_SOURCE,
        confounders: confoundersOf(confounders.get(r.unit_key) ?? []),
      };
    });
    located = loadLocations(db);
    attribution = loadAttributionTotals(db, { mode, callWhere });
    linkCounts = loadLinkCounts(db);
    // Plan 03-04 (J4): the dollar shares are over main-section calls at link confidence medium, the forward share from the first
    // ledger line instant on (numerator and denominator alike). Review fix MEDIUM-3: the cutoff, the dollars, the window and the
    // baseline count are over all units, whatever the unit filters say; the call filters still apply.
    forwardAll = db.prepare(FORWARD_ALL_SQL).all().map((r) => r.recorded_at_utc);
    const cutoff = cutoffMs(forwardAll.map((v) => ({ population: 'forward', recordedAtUtc: v })));
    const recon = loadPopulationDollars(db, { callWhere });
    const fwd = cutoff === null ? null : loadPopulationDollars(db, { callWhere, sinceMs: cutoff });
    const pair = (set, pop, since) => {
      if (set === null || set.total_nano === null) return { attributed_nano: null, total_nano: null, since_ms: since };
      const a = set.attributed.has(pop) ? set.attributed.get(pop) : 0;
      return { attributed_nano: a, total_nano: set.total_nano, since_ms: since };
    };
    dollars = { forward: pair(fwd, 'forward', cutoff), reconstructed: pair(recon, 'reconstructed', null) };
    const win = cutoff === null ? null : loadWindowBuckets(db, { callWhere, sinceMs: cutoff });
    window = cutoff === null ? windowSplit(null, [], null) : windowSplit(cutoff, win.rows, win.total);
  } finally {
    db.close();
  }
  // Plan 03-04 (J1): one stratum per selected population, forward first; the unit list stays one list of the selected units.
  const selected = selectedPopulations(population);
  const unitFiltersIgnored = unitWhere !== null;
  const strata = selected.map((pop) => {
    const mine = units.filter((u) => u.population === pop);
    return {
      population: pop,
      ...stratumSummary(mine),
      coverage: coverageShares(pop, mine, dollars[pop], { baselineForward: forwardAll.length, dollarsIgnoreUnitFilters: unitFiltersIgnored }),
    };
  });
  return {
    asOfMs: nowMs, clockFixed, tz, population, units: units.filter((u) => selected.includes(u.population)), strata,
    window: { ...window, ignores_unit_filters: unitFiltersIgnored },
    // Review fix LOW-2: the incomplete list follows the unit filters only, so a call filter never hides a started unit.
    incomplete: incompleteList(unrecordedBase, nowMs), overhead: loadOverhead(units), unrecorded: unrecordedShare(unrecordedBase, { tz }),
    freshnessCheck: loadFreshness({ home, nowMs }), linkConfidence: mode, attribution, linkCounts, filters,
    locations: located.locations,
    repeats: located.repeats,
    locationsText: unitsLocationsLine(located.locations),
    repeatsText: unitsRepeatsLine(located.repeats),
    filterText: describeFilters(filters),
  };
}
