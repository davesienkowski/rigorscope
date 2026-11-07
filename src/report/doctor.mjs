// loadDoctor (plan 01-09, TRUST-05, DATA-04, DATA-01): the read-only facts of `rigorscope doctor` as one plain,
// JSON-safe object (integers, strings, null, arrays; an unknown is null, never 0; a section that cannot be read is
// { unavailable: reason } and is never omitted). store.db and derived.db are opened only through the read-only openers;
// every statement has fixed text with bound parameters; no lock is taken and nothing is written. Every data-derived
// string is shape-checked here and again by the renderer. The schedule facts come from the injected `run` (systemctl
// and node), so tests never touch the real user manager.
//
// Freshness reuses loadFreshness and evaluateFreshness of plan 01-08: the block equals the `cost` block.
import { lstatSync } from 'node:fs';
import {
  LATEST_STORE_VERSION, derivedPath, openDerivedReadOnly, openStoreReadOnly, storePath,
} from '../db.mjs';
import { loadSources } from '../ingest/sources.mjs';
import { lockPath } from '../ingest/lock.mjs';
import { discoverRoots } from '../sources/transcript/roots.mjs';
import { discoverOtelRoots } from '../sources/otel/dirs.mjs';
import { loadFreshness } from './freshness.mjs';
import { loadOtelReport } from './otel.mjs';
import { findWindowLeads } from './usage-lead.mjs';
import { formatPct } from '../measure/measure.mjs';
import {
  evaluateFindings, missRate, safeToken, safeTokenOrUnknown, verdictOf,
} from '../measure/doctor.mjs';
import { INGEST_TIMEOUT_HOURS, readRepoUnits } from '../schedule/units.mjs';
import { evaluateTimer, readTimerStatus } from '../schedule/status.mjs';
import { checkUnitNode } from '../schedule/node-check.mjs';
import { STEM_KIND, STEM_OTHER_KIND, STEM_MAX, rosterRef12 } from '../adapters/gsd-core/roster.mjs';
import { LOCATION_KINDS, SENTINEL_KIND, shownKinds } from '../adapters/gsd-core/layout.mjs';
import { defaultGitRun } from '../adapters/gsd-core/signals.mjs';
import { FRAMEWORK } from '../units/unit-key.mjs';
import { checkRoster } from './roster.mjs';

const REGISTRY = await loadSources();
const UNLISTED_CAP = 40;
const na = (reason) => ({ unavailable: reason });
const iso = (ms) => new Date(ms).toISOString();
const ageSec = (nowMs, ms) => (Number.isFinite(ms) ? Math.floor((nowMs - ms) / 1000) : null);
const hasTable = (db, name) => db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
const statOrNull = (p) => {
  try { return lstatSync(p, { throwIfNoEntry: false }) ?? null; } catch { return null; }
};
// Replaces undefined by null recursively so the JSON renderer never meets an undefined value.
const jsonSafe = (v) => {
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
};

// pending (plan 02-01): the migrations this rigorscope would apply to an existing store, latest - schema when
// 1 <= schema < latest, else 0 (a fresh store gets them with no ceremony; a newer store is refused elsewhere).
const pendingOf = (schema) => (Number.isInteger(schema) && schema >= 1 && schema < LATEST_STORE_VERSION ? LATEST_STORE_VERSION - schema : 0);

function loadStore(db, nowMs, schema) {
  const versions = { latest: LATEST_STORE_VERSION, pending: pendingOf(schema) };
  if (!hasTable(db, 'ingest_run')) return { present: true, schema, ...versions, ...na(`schema v${schema}`), ok: 0 };
  const c = db.prepare("SELECT count(*) AS runs, count(CASE WHEN status = 'ok' THEN 1 END) AS ok, count(CASE WHEN status = 'failed' THEN 1 END) AS failed FROM ingest_run").get();
  const last = db.prepare("SELECT run_id, status, ended_utc FROM ingest_run WHERE ended_utc IS NOT NULL ORDER BY unixepoch(ended_utc, 'subsec') DESC, run_id DESC LIMIT 1").get();
  const endedMs = last ? Date.parse(last.ended_utc) : Number.NaN;
  return {
    present: true,
    schema,
    ...versions,
    runs: c.runs,
    ok: c.ok,
    failed: c.failed,
    other: c.runs - c.ok - c.failed,
    last_run: last ? {
      id: last.run_id, status: safeTokenOrUnknown('status', last.status), ended_utc: Number.isFinite(endedMs) ? iso(endedMs) : null, age_sec: ageSec(nowMs, endedMs),
    } : null,
  };
}

function loadLock(home, nowMs) {
  const limit = INGEST_TIMEOUT_HOURS * 3600;
  const st = statOrNull(lockPath(home));
  if (!st) return { present: false, age_sec: null, limit_sec: limit };
  return { present: true, age_sec: ageSec(nowMs, Math.trunc(st.mtimeMs)), limit_sec: limit };
}

async function loadRoots(db, { home, env, windowsUsersDir }) {
  const stored = new Map();
  let notSeen = [];
  if (db && hasTable(db, 'source_root')) {
    for (const r of db.prepare('SELECT r.source AS source, r.alias AS alias, count(f.file_id) AS files FROM source_root r LEFT JOIN source_file f ON f.root_id = r.root_id GROUP BY r.root_id').all()) {
      stored.set(`${r.source}|${r.alias}`, r.files);
    }
    notSeen = db.prepare(`
      SELECT source, alias, last_seen_run FROM source_root
       WHERE last_seen_run < (SELECT max(run_id) FROM ingest_run WHERE status = 'ok')
       ORDER BY source COLLATE BINARY, alias COLLATE BINARY`).all()
      .map((r) => ({ source: safeTokenOrUnknown('source', r.source), alias: safeTokenOrUnknown('source', r.alias), last_seen_run: r.last_seen_run }));
  }
  const disc = await discoverRoots({ home, env, windowsUsersDir });
  const otel = discoverOtelRoots({ home, env });
  const entry = (source) => (r) => ({
    alias: safeTokenOrUnknown('source', r.alias), kind: safeTokenOrUnknown('source', r.kind), display: safeTokenOrUnknown('display', r.display),
    files: stored.get(`${source}|${r.alias}`) ?? null,
  });
  const skipped = [...disc.skipped, ...otel.skipped].map((s) => ({
    name: safeTokenOrUnknown('display', s.alias ?? s.display), reason: safeTokenOrUnknown('error', s.reason),
  }));
  return {
    transcript: disc.roots.map(entry('transcript')),
    otel: otel.roots.map(entry('otel')),
    skipped,
    ignored: disc.ignored.map((i) => safeTokenOrUnknown('display', i.display)),
    not_seen: notSeen,
  };
}

function loadCursors(db) {
  const rows = db.prepare(`
    SELECT r.source AS source, r.alias AS alias, count(f.file_id) AS files, sum(f."offset") AS offset_bytes, sum(f.size) AS size_bytes,
           count(CASE WHEN f."offset" < f.size THEN 1 END) AS behind_files,
           coalesce(sum(CASE WHEN f."offset" < f.size THEN f.size - f."offset" END), 0) AS behind_bytes,
           max(f.last_read_run) AS last_read_run
      FROM source_root r JOIN source_file f ON f.root_id = r.root_id
     WHERE f.kind <> 'meta'
     GROUP BY r.root_id
     ORDER BY r.source COLLATE BINARY, r.alias COLLATE BINARY`).all();
  const tailOf = db.prepare('SELECT pending_tail_bytes AS bytes FROM ingest_source_run WHERE source = ? ORDER BY run_id DESC LIMIT 1');
  const pending = [];
  for (const d of REGISTRY) {
    if (d.cursorless === true) continue;
    const row = tailOf.get(d.name);
    if (row) pending.push({ source: d.name, bytes: row.bytes });
  }
  return {
    sources: rows.map((r) => ({
      source: safeTokenOrUnknown('source', r.source), alias: safeTokenOrUnknown('source', r.alias), files: r.files, offset_bytes: r.offset_bytes,
      size_bytes: r.size_bytes, behind_files: r.behind_files, behind_bytes: r.behind_bytes, last_read_run: r.last_read_run,
    })),
    pending_tail: pending,
    cursorless: REGISTRY.filter((d) => d.cursorless === true).map((d) => d.name),
  };
}

function loadNullSession(db) {
  const out = {};
  for (const source of ['transcript', 'otel']) {
    const runs = db.prepare('SELECT count(*) AS n, max(run_id) AS last FROM ingest_source_run WHERE source = ?').get(source);
    if (runs.n === 0) { out[source] = { total: null, last_run: null }; continue; }
    const total = db.prepare("SELECT coalesce(sum(n), 0) AS n FROM ingest_count WHERE source = ? AND kind = 'dropped' AND name = 'session_id'").get(source).n;
    const last = db.prepare("SELECT coalesce(sum(n), 0) AS n FROM ingest_count WHERE source = ? AND run_id = ? AND kind = 'dropped' AND name = 'session_id'").get(source, runs.last).n;
    out[source] = { total, last_run: last };
  }
  return out;
}

// Plan 03-03 (D-12, J12): the forward ledger's ingest figures. rows is the stored ledger_line count; kept, dropped (by reason),
// bad_json (the unparseable column), oversized, key_conflict and unknown keys are sums over every run of the ledger source
// (a reread of a replaced file counts its lines again); the dropped and unknown key totals are summed in SQL over every name, only
// the by-name lists are capped at UNLISTED_CAP. last_run_dropped is the dropped, bad_json and oversized counts of the
// latest ledger run alone. Names are shape-checked here and again by the renderer; a line's text is never in the store.
function loadLedgerLines(db) {
  const sum = (kind, name) => db.prepare("SELECT coalesce(sum(n), 0) AS n FROM ingest_count WHERE source = 'ledger' AND kind = ? AND name = ?").get(kind, name).n;
  const byName = (kind) => db.prepare(`
    SELECT name, sum(n) AS n FROM ingest_count WHERE source = 'ledger' AND kind = ?
     GROUP BY name ORDER BY n DESC, name COLLATE BINARY LIMIT ${UNLISTED_CAP}`).all(kind)
    .map((r) => ({ name: safeTokenOrUnknown('attr', r.name), n: r.n }));
  const total = (kind) => db.prepare("SELECT coalesce(sum(n), 0) AS n FROM ingest_count WHERE source = 'ledger' AND kind = ?").get(kind).n;
  const dropped = byName('dropped');
  const unknown = byName('rejected_field');
  const totals = db.prepare("SELECT coalesce(sum(unparseable), 0) AS bad_json, coalesce(sum(oversized), 0) AS oversized FROM ingest_source_run WHERE source = 'ledger'").get();
  const last = db.prepare("SELECT run_id, unparseable, oversized FROM ingest_source_run WHERE source = 'ledger' ORDER BY run_id DESC LIMIT 1").get();
  const lastDropped = last === undefined ? null
    : db.prepare("SELECT coalesce(sum(n), 0) AS n FROM ingest_count WHERE source = 'ledger' AND run_id = ? AND kind = 'dropped'").get(last.run_id).n + last.unparseable + last.oversized;
  return {
    rows: db.prepare('SELECT count(*) AS n FROM ledger_line').get().n,
    kept: sum('lines', 'kept'),
    dropped: total('dropped'),
    bad_json: totals.bad_json,
    oversized: totals.oversized,
    key_conflict: sum('conflict', 'key_conflict'),
    unknown_keys: total('rejected_field'),
    last_run_dropped: lastDropped,
    dropped_by_reason: dropped,
    unknown_key_names: unknown,
  };
}

// Plan 03.1-04 (ADPT-04, D-21): the artifact files the gsd-core roster does not know, from the units counters of the store.
// A repo counts through its latest scan (the run that wrote its trees_scanned sentinel); a repo whose latest scan wrote no
// `unclassified` row predates classification and is unknown (unknown_repos), never zero. The totals are summed in SQL, only
// the stem list is capped. The stems are the run-level rows of the latest scan run over all repos (written with the run's
// per-repo rows, so listed plus other equals the run's unclassified total); a run without the remainder row recorded none.
// Stems were shape-checked when stored and are checked again here.
function loadUnclassified(db) {
  const latest = db.prepare(`
    SELECT count(*) AS scanned, count(u.n) AS known, coalesce(sum(u.n), 0) AS files
      FROM (SELECT name, max(run_id) AS run_id FROM ingest_count
             WHERE source = 'units' AND kind = 'trees_scanned' GROUP BY name) l
      LEFT JOIN ingest_count u ON u.run_id = l.run_id AND u.source = 'units' AND u.kind = 'unclassified' AND u.name = l.name`).get();
  if (latest.scanned === 0) return na('no unit scan recorded');
  const out = {
    files: latest.known > 0 ? latest.files : null,
    repos: latest.known,
    unknown_repos: latest.scanned - latest.known,
    roster_ref: rosterRef12(),
    stems_run: null, stems_repos: null, stems_files: null, stems: null, other: null,
  };
  const run = db.prepare("SELECT max(run_id) AS run_id FROM ingest_count WHERE source = 'units' AND kind = 'trees_scanned'").get().run_id;
  const other = db.prepare("SELECT n FROM ingest_count WHERE source = 'units' AND run_id = ? AND kind = ? AND name = '*'").get(run, STEM_OTHER_KIND);
  if (other !== undefined) {
    const t = db.prepare("SELECT count(*) AS repos, coalesce(sum(n), 0) AS files FROM ingest_count WHERE source = 'units' AND run_id = ? AND kind = 'unclassified'").get(run);
    out.stems_run = run;
    out.stems_repos = t.repos;
    out.stems_files = t.files;
    out.other = other.n;
    out.stems = db.prepare(`
      SELECT name, n FROM ingest_count WHERE source = 'units' AND run_id = ? AND kind = ?
       ORDER BY n DESC, name COLLATE BINARY LIMIT ${STEM_MAX}`).all(run, STEM_KIND)
      .map((r) => ({ stem: safeTokenOrUnknown('attr', r.name), n: r.n }));
  }
  return out;
}

// Plan 03.1-04 (D-03): the location counters of the units post-step, from the store's ingest_count rows of each repo's latest
// scan (the run that wrote its trees_scanned sentinel). A scanned repo with no row for a counter has 0 there; a repo without
// the sentinel is not counted at all (unknown). repeat_id rows are keyed by the unit key, so they join to their repo by the key
// prefix. Totals are summed in SQL; only the per-repo detail list is capped. The detail lists the repos with a repeat, an
// ambiguous move or a not-read count, with the non-zero ones of those counters.
const DETAIL_KINDS = shownKinds().filter((k) => k === 'repeat_id' || k === 'move_ambiguous' || k.startsWith('not_read_'));
function loadUnitLocations(db) {
  const latest = db.prepare(`
    SELECT name AS repo, max(run_id) AS run_id FROM ingest_count
     WHERE source = 'units' AND kind = ? GROUP BY name ORDER BY name COLLATE BINARY`).all(SENTINEL_KIND);
  if (latest.length === 0) return na('no unit scan recorded');
  const kinds = shownKinds();
  const marks = kinds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT l.repo AS repo, c.kind AS kind, sum(c.n) AS n
      FROM (SELECT name AS repo, max(run_id) AS run_id FROM ingest_count
             WHERE source = 'units' AND kind = '${SENTINEL_KIND}' GROUP BY name) l
      JOIN ingest_count c ON c.run_id = l.run_id AND c.source = 'units' AND c.kind IN (${marks})
       AND (c.name = l.repo OR (c.kind = 'repeat_id' AND substr(c.name, 1, length(? || l.repo || ':')) = ? || l.repo || ':'))
     GROUP BY l.repo, c.kind ORDER BY l.repo COLLATE BINARY, c.kind`).all(...kinds, `${FRAMEWORK}:`, `${FRAMEWORK}:`);
  const totals = Object.fromEntries(kinds.map((k) => [k, 0]));
  const perRepo = new Map();
  for (const r of rows) {
    totals[r.kind] += r.n;
    if (DETAIL_KINDS.includes(r.kind) && r.n > 0) {
      if (!perRepo.has(r.repo)) perRepo.set(r.repo, {});
      perRepo.get(r.repo)[r.kind] = r.n;
    }
  }
  const detail = [...perRepo].map(([repo, counts]) => ({
    repo: safeTokenOrUnknown('display', repo),
    counts: Object.fromEntries(DETAIL_KINDS.filter((k) => counts[k] !== undefined).map((k) => [k, counts[k]])),
  }));
  return {
    repos: latest.length,
    totals,
    per_repo: detail.slice(0, UNLISTED_CAP),
    more: Math.max(0, detail.length - UNLISTED_CAP),
  };
}

function loadUnknownToken(db) {
  const records = db.prepare('SELECT coalesce(sum(unknown_token_bearing), 0) AS n FROM ingest_run').get().n;
  const latest = db.prepare("SELECT unknown_token_bearing AS n FROM ingest_run WHERE ended_utc IS NOT NULL ORDER BY unixepoch(ended_utc, 'subsec') DESC, run_id DESC LIMIT 1").get();
  const entries = db.prepare(`
    SELECT source, name, sum(n) AS n FROM ingest_count WHERE kind = 'unknown_token'
     GROUP BY source, name ORDER BY n DESC, source COLLATE BINARY, name COLLATE BINARY`).all();
  return {
    records,
    names: entries.length,
    last_run: latest?.n ?? 0,
    entries: entries.map((e) => ({ source: safeTokenOrUnknown('source', e.source), name: safeTokenOrUnknown('token', e.name), n: e.n })),
  };
}

function loadUnknownAttr(db) {
  const names = db.prepare('SELECT count(*) AS n FROM unknown_attr').get().n;
  const rows = db.prepare(`
    SELECT source, scope, name, last_run_n FROM unknown_attr
     ORDER BY source COLLATE BINARY, scope COLLATE BINARY, name COLLATE BINARY LIMIT ${UNLISTED_CAP}`).all();
  return {
    names,
    entries: rows.map((r) => ({
      source: safeTokenOrUnknown('source', r.source), scope: safeTokenOrUnknown('scope', r.scope), name: safeTokenOrUnknown('attr', r.name), last_run_n: r.last_run_n,
    })),
    more: Math.max(0, names - UNLISTED_CAP),
  };
}

function loadJoin(derived) {
  const rep = loadOtelReport(derived);
  const j = rep.join;
  const rate = (r) => missRate(r.d - r.n, r.d);
  const c = rep.crosscheck;
  return {
    join_miss: {
      otel_requests: j.otel_requests,
      joined: j.joined,
      sessions_no_transcript: j.sessions_no_transcript,
      sessions_zero_joined: j.sessions_zero_joined,
      rates: j.otel_requests === 0 ? null : { raw: rate(j.rates.raw), joinable: rate(j.rates.joinable), excl_sdk: rate(j.rates.excl_sdk) },
    },
    agent_names: {
      agree: c.agree, disagree: c.disagree, custom: c.custom, no_name: c.no_name, no_transcript_role: c.no_transcript_role, not_joined: c.not_joined, compared: c.compared,
      pairs: c.pairs.map((p) => ({ transcript_role: safeTokenOrUnknown('attr', p.transcript), otel_name: safeTokenOrUnknown('attr', p.otel), n: p.n })),
    },
  };
}

function loadUsage(db, nowMs, schema) {
  if (!hasTable(db, 'usage_snapshot')) return { usage: na(`schema v${schema}`), discontinuity: na(`schema v${schema}`) };
  const c = db.prepare(`
    SELECT count(*) AS n, count(CASE WHEN source = 'claude-json-cache' THEN 1 END) AS cache,
           count(CASE WHEN source = 'transcript' THEN 1 END) AS transcript, max(fetched_at_ms) AS latest FROM usage_snapshot`).get();
  const src = REGISTRY.find((d) => d.name === 'usage');
  const usage = {
    snapshots: c.n, cache: c.cache, transcript: c.transcript, latest_utc: c.latest === null ? null : iso(c.latest),
    age_sec: c.latest === null ? null : ageSec(nowMs, c.latest), limit_sec: Math.round((src?.freshness.staleAfterHours ?? 168) * 3600),
  };
  const rows = db.prepare(`
    SELECT source, fetched_at_ms, five_hour_pct, five_hour_resets_ms, seven_day_pct, seven_day_resets_ms
      FROM usage_snapshot ORDER BY fetched_at_ms, source COLLATE BINARY`).all().map((r) => ({ ...r }));
  const leads = findWindowLeads({ snapshots: rows });
  const lines = [];
  for (const win of ['five_hour', 'seven_day']) {
    for (const f of leads[win].latest) lines.push({ window: win, at_utc: iso(f.atMs), from_pct: formatPct(f.fromPct), to_pct: formatPct(f.toPct) });
  }
  return {
    usage,
    discontinuity: {
      checkable: leads.five_hour.intervals + leads.seven_day.intervals > 0, five_hour: leads.five_hour.falling, seven_day: leads.seven_day.falling, lines,
    },
  };
}

function loadSchedule({ home, env, run, fsOps, systemdRunning }) {
  const repo = readRepoUnits();
  let raw;
  try {
    raw = readTimerStatus({ home, env, run, repoUnits: repo, ...(systemdRunning ? { systemdRunning } : {}) });
  } catch {
    raw = { files: { service: 'same', timer: 'same' }, reachable: false, timer: null, service: null };
  }
  const ev = evaluateTimer(raw);
  let node;
  try {
    node = checkUnitNode({ home, serviceText: repo.service, run, fsOps });
  } catch {
    node = { status: 'unusable', display: null, version: null, floor: '24.15.0' };
  }
  return {
    timer: {
      state: ev.state, units: { service: raw.files.service, timer: raw.files.timer }, persistent: ev.timerFacts.persistent, active: ev.timerFacts.active,
      enabled: ev.timerFacts.enabled, next: ev.timerFacts.next, last: ev.timerFacts.last, drift: ev.drift,
    },
    service: { result: ev.serviceFacts.result, exit_status: ev.serviceFacts.exitStatus, ok: ev.serviceOk, last_exit: ev.serviceFacts.lastExit },
    unit_node: {
      status: node.status, display: node.display === null ? null : safeTokenOrUnknown('display', node.display),
      version: node.version === null ? null : (safeToken('display', node.version) ?? '?'), floor: node.floor,
    },
  };
}

// derivedError: a short code the caller recorded when ensureDerived failed (the loader never rebuilds anything).
// gitRun: the git runner of the roster drift check (a test seam; default the adapter's defaultGitRun).
export async function loadDoctor({
  home, env = {}, nowMs, windowsUsersDir = '', run, clockFixed = false, fsOps, derivedError = null, systemdRunning, gitRun = defaultGitRun,
}) {
  const present = statOrNull(storePath(home)) !== null;
  const freshnessCheck = loadFreshness({ home, nowMs });
  const model = {
    as_of_utc: iso(nowMs), clock_fixed: clockFixed === true,
    lock: loadLock(home, nowMs), freshnessCheck,
    freshness: {
      verdict: freshnessCheck.verdict,
      sources: freshnessCheck.sources.map((s) => ({
        name: s.name, live: s.live, limit_hours: s.limitHours, newest_record_utc: s.newestRecordUtc, last_run_utc: s.lastRunUtc,
        record_age_sec: s.recordAgeSec, run_age_sec: s.runAgeSec, state: s.state,
      })),
    },
  };
  let db = null;
  let derived = null;
  try {
    if (present) db = openStoreReadOnly({ home });
    const schema = db ? db.prepare('PRAGMA user_version').get().user_version : null;
    model.store = db ? loadStore(db, nowMs, schema) : { present: false, ok: 0 };
    model.roots = await loadRoots(db, { home, env, windowsUsersDir });
    const ready = db !== null && model.store.unavailable === undefined;
    const q = (fn, reason = 'no store') => (ready ? fn() : na(db ? model.store.unavailable : reason));
    model.cursors = q(() => loadCursors(db));
    model.null_session_id = q(() => loadNullSession(db));
    model.unknown_token_bearing = q(() => loadUnknownToken(db));
    model.ledger_lines = q(() => (hasTable(db, 'ledger_line') ? loadLedgerLines(db) : na(`schema v${model.store.schema}`)));
    model.unit_locations = q(() => (hasTable(db, 'ingest_count') ? loadUnitLocations(db) : na(`schema v${model.store.schema}`)));
    // The roster section is never unavailable: with no store the drift check can still answer from a named checkout.
    model.roster = checkRoster({ env, db: ready ? db : null, run: gitRun });
    model.unclassified = q(() => (hasTable(db, 'ingest_count') ? loadUnclassified(db) : na(`schema v${model.store.schema}`)));
    model.unknown_attr = q(() => (hasTable(db, 'unknown_attr') ? loadUnknownAttr(db) : na(`schema v${model.store.schema}`)));
    const usage = ready ? loadUsage(db, nowMs, model.store.schema) : { usage: na(db ? model.store.unavailable : 'no store'), discontinuity: na(db ? model.store.unavailable : 'no store') };
    model.usage = usage.usage;
    model.discontinuity = usage.discontinuity;
    // derived.db: join and agent-name figures. Not needed (and not an error) when there is no store.
    if (!ready) {
      model.derived = { ok: null, reason: 'no store' };
      model.join_miss = na('no store');
      model.agent_names = na('no store');
    } else if (derivedError !== null) {
      model.derived = { ok: false, reason: safeTokenOrUnknown('error', derivedError) };
    } else if (statOrNull(derivedPath(home)) === null) {
      model.derived = { ok: false, reason: 'missing' };
    } else {
      try {
        derived = openDerivedReadOnly({ home });
        Object.assign(model, loadJoin(derived));
        model.derived = { ok: true, reason: null };
      } catch (err) {
        model.derived = { ok: false, reason: safeTokenOrUnknown('error', err?.name) };
      }
    }
    if (model.derived.ok !== true) {
      const reason = model.derived.ok === false ? `derived.db unavailable (${model.derived.reason})` : 'no store';
      model.join_miss ??= na(reason);
      model.agent_names ??= na(reason);
    }
  } finally {
    if (derived) derived.close();
    if (db) db.close();
  }
  Object.assign(model, loadSchedule({ home, env, run, fsOps, systemdRunning }));
  const findings = evaluateFindings(model);
  model.findings = findings;
  model.counts = {
    problems: findings.filter((f) => f.cls === 'problem').length,
    leads: findings.filter((f) => f.cls === 'lead').length,
    unverified: findings.filter((f) => f.cls === 'unverified').length,
  };
  model.verdict = verdictOf(findings);
  return jsonSafe(model);
}
