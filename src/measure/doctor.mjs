// Doctor evaluation (plan 01-09, TRUST-05, RR-04): shape checks for every data-derived string, the finding catalog,
// the verdict and the integer rates. Pure: built-ins and src/measure modules only; integer arithmetic only, no Date,
// no float comparison.
//
// The report fragment evaluateFindings reads is the doctor model that src/report/doctor.mjs loads; only these fields
// are read, each defensively (a section that is { unavailable } or lacks a field raises nothing: an unknown is never
// a finding and never a pass):
//   store                 { present, ok (count of ok runs), last_run: { status } | null, schema, latest, pending }
//                         (pending: migrations this rigorscope would apply to an existing store, plan 02-01)
//   lock                  { age_sec | null, limit_sec }
//   freshness             { verdict, sources: [{ name, state }] }
//   roots.not_seen        [{ source, alias, last_seen_run }]
//   null_session_id       { transcript: { total }, otel: { total } }   (total is null when unknown)
//   unknown_token_bearing { records }     unknown_attr { names }     agent_names { disagree }
//   usage                 { age_sec | null, limit_sec }
//   discontinuity         { five_hour, seven_day }
//   timer                 { state, drift }      service { ok: true | false | null }
//   unit_node             { status }            derived { ok }
//   roster                { ref (12 hex), version, drift: { state, changed: [path] | null, installed_version } } (plan 03.1-04):
//                         only a seen drift is a finding; state 'unknown' and a section that is { unavailable } raise nothing
import { formatRate, rateBp } from './stats.mjs';

export const DOCTOR_KEYS = Object.freeze([
  'freshness', 'store', 'lock', 'roots', 'cursors', 'null-session-id', 'unknown-token-bearing', 'unknown-attr',
  'ledger-lines', 'unit-locations', 'roster', 'unclassified', 'join-miss', 'agent-names', 'usage', 'discontinuity', 'timer', 'service', 'unit-node',
]);

const SHAPES = {
  source: /^[a-z][a-z0-9-]{0,31}$/,
  scope: /^[A-Za-z0-9_.:-]{1,64}$/,
  attr: /^[A-Za-z0-9_.:-]{1,64}$/,
  token: /^[A-Za-z0-9_.-]{1,64}\|[A-Za-z0-9_.+-]{1,32}$/,
  error: /^[A-Za-z0-9_]{1,40}$/,
  status: /^[a-z][a-z-]{0,23}$/,
  display: /^(?!\/)[A-Za-z0-9_.~$/-]{1,120}$/,
};

// -> the text when it matches the fixed shape of its kind, else null. '?' passes for scope and attr (the bucket).
export function safeToken(kind, textValue) {
  if (!Object.hasOwn(SHAPES, kind)) throw new RangeError('unknown token kind');
  if (typeof textValue !== 'string') return null;
  if ((kind === 'scope' || kind === 'attr') && textValue === '?') return '?';
  return SHAPES[kind].test(textValue) ? textValue : null;
}
export function safeTokenOrUnknown(kind, textValue) {
  return safeToken(kind, textValue) ?? '?';
}

// -> { misses, denominator, bp, text }; bp is half-up integer basis points, null for an empty denominator.
export function missRate(misses, denominator) {
  return { misses, denominator, bp: rateBp(misses, denominator), text: formatRate(misses, denominator) };
}

const ROSTER_PATHS_SHOWN = 10;
const stale = (state) => state === 'stale' || state === 'never_run';
const num = (v) => typeof v === 'number' && Number.isInteger(v);

// id, class, text(slots) in catalog order. A source_stale entry repeats once per stale source.
export const FINDING_CATALOG = Object.freeze([
  { id: 'no_store', cls: 'problem', text: () => 'no ingest has been recorded; run rigorscope ingest' },
  {
    id: 'migration_pending',
    cls: 'problem',
    text: (s) => `store.db is at schema v${num(s.schema) ? s.schema : '?'} and this rigorscope needs v${num(s.latest) ? s.latest : '?'}: `
      + 'migration pending, back up first; rigorscope migrate --apply takes and verifies a backup, then applies it',
  },
  { id: 'source_stale', cls: 'problem', text: (s) => `source ${safeTokenOrUnknown('source', s.name)} is stale (see freshness)` },
  { id: 'last_run_failed', cls: 'problem', text: (s) => `the latest ingest run ended with status ${safeTokenOrUnknown('status', s.status)}` },
  { id: 'lock_old', cls: 'problem', text: (s) => `the ingest lock is ${s.age} s old, above the ${s.limit} s unit timeout, so it cannot belong to a live run` },
  { id: 'timer_missing', cls: 'problem', text: () => 'the ingest timer is not installed; run rigorscope schedule install' },
  { id: 'timer_inactive', cls: 'problem', text: () => 'the ingest timer is installed but not active' },
  { id: 'timer_not_enabled', cls: 'problem', text: () => 'the ingest timer is installed but not enabled' },
  { id: 'service_failed', cls: 'problem', text: () => 'the last ingest service run failed' },
  { id: 'unit_node_missing', cls: 'problem', text: () => 'no node was found on the unit PATH, so the daily run cannot start' },
  { id: 'unit_node_below_floor', cls: 'problem', text: () => 'the node on the unit PATH is below 24.15.0 or lacks node:sqlite, so the daily run would exit 2' },
  { id: 'derived_unavailable', cls: 'problem', text: () => 'derived.db could not be built or opened; join and attribution figures are unavailable' },
  { id: 'timer_unverified', cls: 'unverified', text: () => 'the timer state could not be checked (systemctl was not reachable)' },
  { id: 'unit_node_unverified', cls: 'unverified', text: () => 'the node on the unit PATH could not be run or its version was unreadable' },
  { id: 'unknown_token_bearing', cls: 'lead', text: (s) => `${s.n} records carry token counts that rigorscope does not read` },
  { id: 'unknown_attr', cls: 'lead', text: (s) => `${s.n} attribute names were seen that rigorscope does not know` },
  { id: 'null_session_id', cls: 'lead', text: (s) => `${s.n} records were dropped for a missing session id` },
  { id: 'agent_name_disagreement', cls: 'lead', text: (s) => `${s.n} calls have a transcript role that disagrees with the OTel agent name` },
  { id: 'usage_discontinuity', cls: 'lead', text: (s) => `${s.n} window percentage falls without a reset; a different signed-in account or another machine can cause this` },
  { id: 'snapshot_old', cls: 'lead', text: (s) => `the newest usage snapshot is older than ${s.hours} hours` },
  { id: 'root_not_seen', cls: 'lead', text: (s) => `${s.n} stored roots were not seen by the latest run` },
  { id: 'unit_drift', cls: 'lead', text: () => 'the installed unit files differ from the repo files' },
  {
    id: 'roster_drift',
    cls: 'lead',
    text: (s) => (Array.isArray(s.paths)
      ? `${s.paths.length} gsd-core paths cited by the roster changed since its ref ${safeTokenOrUnknown('display', s.ref)}: `
        + `${s.paths.slice(0, ROSTER_PATHS_SHOWN).map((p) => safeTokenOrUnknown('display', p)).join(', ')}`
        + `${s.paths.length > ROSTER_PATHS_SHOWN ? `, and ${s.paths.length - ROSTER_PATHS_SHOWN} more` : ''}; the roster may no longer match gsd-core`
      : `the installed gsd-core is ${safeTokenOrUnknown('display', s.installed)} and the roster was taken at ${safeTokenOrUnknown('display', s.version)} `
        + `(ref ${safeTokenOrUnknown('display', s.ref)}); artifact names may have changed`),
  },
  { id: 'timer_not_configured', cls: 'lead', text: () => 'no systemd user manager is available, so no ingest timer is configured; schedule ingest with your platform scheduler (docs/operations.md, Scheduling without systemd)' },
]);
const BY_ID = new Map(FINDING_CATALOG.map((f) => [f.id, f]));

// -> [{ cls, id, text }]: problems, then unverified, then leads, each in catalog order.
export function evaluateFindings(report) {
  const hits = new Map();
  const add = (id, slots = {}) => {
    const list = hits.get(id) ?? [];
    list.push(slots);
    hits.set(id, list);
  };
  const store = report.store ?? {};
  if (store.present !== true || !(store.ok > 0)) add('no_store');
  // Plan 02-01: only a known count above 0; an unknown is never a finding.
  if (num(store.pending) && store.pending > 0) add('migration_pending', { schema: store.schema, latest: store.latest });
  // With no ingest recorded at all (verdict none) no_store already says so; per-source lines would only repeat it.
  if (report.freshness?.verdict !== 'none') for (const s of report.freshness?.sources ?? []) if (stale(s.state)) add('source_stale', { name: s.name });
  const lastStatus = store.last_run?.status;
  if (typeof lastStatus === 'string' && lastStatus !== 'ok') add('last_run_failed', { status: lastStatus });
  const lock = report.lock ?? {};
  if (num(lock.age_sec) && num(lock.limit_sec) && lock.age_sec > lock.limit_sec) add('lock_old', { age: lock.age_sec, limit: lock.limit_sec });
  const timer = report.timer ?? {};
  if (timer.state === 'missing') add('timer_missing');
  if (timer.state === 'inactive') add('timer_inactive');
  if (timer.state === 'not_enabled') add('timer_not_enabled');
  if (report.service?.ok === false) add('service_failed');
  // The unit PATH node only matters to systemd units; without systemd it is not a problem.
  const node = timer.state === 'not_configured' ? null : report.unit_node?.status;
  if (node === 'not_found') add('unit_node_missing');
  if (node === 'below_floor' || node === 'no_sqlite') add('unit_node_below_floor');
  if (report.derived?.ok === false) add('derived_unavailable');
  if (timer.state === 'unavailable') add('timer_unverified');
  if (node === 'unusable') add('unit_node_unverified');
  if (num(report.unknown_token_bearing?.records) && report.unknown_token_bearing.records > 0) add('unknown_token_bearing', { n: report.unknown_token_bearing.records });
  if (num(report.unknown_attr?.names) && report.unknown_attr.names > 0) add('unknown_attr', { n: report.unknown_attr.names });
  const dropped = ['transcript', 'otel'].reduce((acc, k) => acc + (num(report.null_session_id?.[k]?.total) ? report.null_session_id[k].total : 0), 0);
  if (dropped > 0) add('null_session_id', { n: dropped });
  if (num(report.agent_names?.disagree) && report.agent_names.disagree > 0) add('agent_name_disagreement', { n: report.agent_names.disagree });
  const falls = (num(report.discontinuity?.five_hour) ? report.discontinuity.five_hour : 0) + (num(report.discontinuity?.seven_day) ? report.discontinuity.seven_day : 0);
  if (falls > 0) add('usage_discontinuity', { n: falls });
  const usage = report.usage ?? {};
  if (num(usage.age_sec) && num(usage.limit_sec) && usage.age_sec > usage.limit_sec) add('snapshot_old', { hours: Math.floor(usage.limit_sec / 3600) });
  const notSeen = report.roots?.not_seen;
  if (Array.isArray(notSeen) && notSeen.length > 0) add('root_not_seen', { n: notSeen.length });
  if (timer.drift === true) add('unit_drift');
  // Plan 03.1-04 (D-09, J3): only a seen drift. A checkout with changed cited paths, or an installed version that differs.
  const drift = report.roster?.drift;
  if (drift?.state === 'changed' && Array.isArray(drift.changed) && drift.changed.length > 0) {
    add('roster_drift', { paths: [...drift.changed].sort(), ref: report.roster.ref });
  } else if (drift?.state === 'version_differs') {
    add('roster_drift', { installed: drift.installed_version, version: report.roster.version, ref: report.roster.ref });
  }
  if (timer.state === 'not_configured') add('timer_not_configured');
  const out = [];
  for (const entry of FINDING_CATALOG) for (const slots of hits.get(entry.id) ?? []) out.push({ cls: entry.cls, id: entry.id, text: BY_ID.get(entry.id).text(slots) });
  return out;
}

export function verdictOf(findings) {
  if (findings.some((f) => f.cls === 'problem')) return 'UNHEALTHY';
  if (findings.some((f) => f.cls === 'unverified')) return 'UNVERIFIED';
  return 'HEALTHY';
}
