// loadEvidence (plan 01-08, TRUST-04, D-08): the calls and files behind one row of the cost report.
//
// The row key is parsed by the strict grammar of src/measure/rowkey.mjs against the BY_DIMENSIONS names before any
// query; each named dimension becomes a fixed SQL fragment taken from the whitelist object (part-level dimensions
// through EXISTS on api_call_part) compared by equality with a bound parameter, `IS ?` so NULL matches NULL. The
// section, the period bounds, the limit and every value are bound parameters; no key text reaches SQL text.
//
// Listing order is record time ascending (NULL last) then call id bytewise; files of a call are ordered by root alias
// then relative path bytewise. Transcript calls list every file the message id was read from (cc_message_file, no line
// locator exists); OTel calls list the file and stored byte offset of the owner api_request event. Only a root alias
// plus a home-normalized relative path leaves this module, never an absolute path. Both databases are opened
// read-only.
import { existsSync } from 'node:fs';
import { openDerivedReadOnly, openStoreReadOnly, storePath } from '../db.mjs';
import { allPeriod, resolveTz } from '../measure/period.mjs';
import { buildLinkEvidenceId, buildUnitEvidenceId, parseRowKey } from '../measure/rowkey.mjs';
import { BY_DIMENSIONS, SECTION_WHERE, rangeFragment, registerDayFunction } from './cost.mjs';
import { COMMAND_NAMES, buildInstants, scopeLinkParts } from '../derive/link-fill.mjs';
import { loadFreshness } from './freshness.mjs';

export const MAX_LIMIT = 100000;
const LIMIT_MESSAGE = 'the --limit value must be a whole number from 1 to 100000';

const DIM_NAMES = Object.keys(BY_DIMENSIONS);

function whereOf(pairs) {
  const parts = [];
  const params = [];
  for (const [name, value] of pairs) {
    const dim = BY_DIMENSIONS[name];
    parts.push(dim.level === 'part'
      ? ` AND EXISTS (SELECT 1 FROM api_call_part p WHERE p.call_key = c.call_key AND ${dim.column} IS ?)`
      : ` AND ${dim.column} IS ?`);
    params.push(value);
  }
  return { sql: parts.join(''), params };
}

const TRANSCRIPT_FILES_SQL = `
SELECT DISTINCT r.alias AS root, f.rel_path AS path FROM cc_message_file mf
  JOIN source_file f ON f.file_id = mf.file_id JOIN source_root r ON r.root_id = f.root_id
 WHERE mf.message_id = ? ORDER BY r.alias, f.rel_path`;
const OTEL_BY_REQUEST_SQL = `
SELECT r.alias AS root, f.rel_path AS path, e.src_end_offset AS offset FROM otel_event e
  JOIN source_file f ON f.file_id = e.file_id JOIN source_root r ON r.root_id = f.root_id
 WHERE e.kind = 'api_request' AND e.request_id = ?
 ORDER BY unixepoch(e.ts_utc, 'subsec') ASC NULLS LAST, e.session_id ASC, e.event_seq ASC, e.event_ts ASC LIMIT 1`;
const OTEL_BY_KEY_SQL = `
SELECT r.alias AS root, f.rel_path AS path, e.src_end_offset AS offset FROM otel_event e
  JOIN source_file f ON f.file_id = e.file_id JOIN source_root r ON r.root_id = f.root_id
 WHERE e.kind = 'api_request' AND e.session_id = ? AND e.event_seq = ? AND e.event_ts = ?
 LIMIT 1`;
const EVENT_KEY = /^e:([^:]+):(\d+):(.+)$/;

function filesOf(store, item) {
  if (store === null) return [];
  if (item.messageId !== null) {
    return store.prepare(TRANSCRIPT_FILES_SQL).all(item.messageId).map((f) => ({ root: f.root, path: f.path, offset: null }));
  }
  let row;
  if (item.requestId !== null) {
    row = store.prepare(OTEL_BY_REQUEST_SQL).get(item.requestId);
  } else {
    const m = EVENT_KEY.exec(item.callKey.slice(2));
    row = m ? store.prepare(OTEL_BY_KEY_SQL).get(m[1], Number(m[2]), m[3]) : undefined;
  }
  return row ? [{ root: row.root, path: row.path, offset: row.offset }] : [];
}

// -> plain data; throws RangeError for a malformed key or limit.
// callWhere (plan 02-08, RPT-01, D-19): an optional { sql, params } predicate over the call alias c from the `cost` filters
// (src/report/cost.mjs costFilterWhere), ANDed after the period, so an inline `cost --evidence` lists only the calls the filters
// keep. Absent, every query text is exactly the phase 1 text; standalone `evidence ROW_KEY` passes none.
export function loadEvidence({
  home, rowKey, period = allPeriod(), tz, limit = 50, now = () => new Date(), clockFixed = false, callWhere = null,
}) {
  const key = parseRowKey(rowKey, DIM_NAMES);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError(LIMIT_MESSAGE);
  const zone = tz ?? period?.tz ?? resolveTz();
  const range = rangeFragment(period);
  const where = whereOf(key.pairs);
  const extra = callWhere && callWhere.sql ? { sql: ` AND (${callWhere.sql})`, params: callWhere.params } : { sql: '', params: [] };
  const base = ` FROM api_call c WHERE ${SECTION_WHERE[key.section]}${where.sql}${range.sql}${extra.sql}`;
  const params = [...where.params, ...range.params, ...extra.params];
  const nowMs = now().getTime();
  const db = openDerivedReadOnly({ home });
  const store = existsSync(storePath(home)) ? openStoreReadOnly({ home }) : null;
  try {
    registerDayFunction(db, zone);
    const counts = db.prepare(`SELECT count(*) AS calls, count(DISTINCT c.owner_session_id) AS sessions${base}`).get(...params);
    const items = db.prepare(`
SELECT c.call_key, c.owner_session_id, c.owner_agent_id, c.message_id, c.request_id, c.ts_utc, c.occurrences${base}
 ORDER BY c.ts_ms ASC NULLS LAST, c.call_key ASC LIMIT ?`).all(...params, limit).map((r) => {
      const item = {
        callKey: r.call_key, sessionId: r.owner_session_id, agentId: r.owner_agent_id, messageId: r.message_id,
        requestId: r.request_id, tsUtc: r.ts_utc, occurrences: r.occurrences,
      };
      return { ...item, files: filesOf(store, item) };
    });
    const callsTsUnknown = range.bounded ? db.prepare('SELECT count(*) AS n FROM api_call WHERE ts_ms IS NULL').get().n : 0;
    return {
      rowKey,
      section: key.section,
      total: key.total,
      dims: key.pairs.map(([name, value]) => ({ name, value })),
      calls: counts.calls,
      sessions: counts.sessions,
      listed: items.length,
      items,
      period,
      callsTsUnknown,
      tz: zone,
      clockFixed,
      asOfMs: nowMs,
      freshnessCheck: loadFreshness({ home, nowMs }),
    };
  } finally {
    db.close();
    if (store) store.close();
  }
}

// Plan 02-07 (D-19, D-04, UNIT-06): the evidence of one unit. Derived and store databases are opened read-only. The unit
// row (tier, tier_signal and tier_conflict, D-04), its links per (session, agent) scope with every method row and both
// modes' bucket of each linked scope, and the main-section calls attributed to the unit in `mode` inside the period
// (default all time), ordered like the row listing, at most `limit`, each with its files. A key with no unit gives an
// empty listing, never an error.
const UNIT_ROW_SQL = `
SELECT unit_key, repo, kind, native_id, tier, tier_signal, tier_conflict, git_evidence FROM unit WHERE unit_key = ?`;
const UNIT_LINKS_SQL = `
SELECT session_id, agent_id, method, confidence, base_confidence, lowered_by, match, phase_level, refs, write_refs, instants,
       first_ms, last_ms
  FROM unit_link WHERE unit_key = ? ORDER BY session_id, agent_id, method`;
const SCOPE_BUCKETS_SQL = `
SELECT link_confidence, bucket, reason, unit_key FROM scope_attribution
 WHERE session_id = ? AND agent_id = ? ORDER BY link_confidence`;
const RANK = Object.freeze({ high: 0, medium: 1, low: 2 });

function scopeBuckets(db, sessionId, agentId) {
  const out = { medium: null, low: null };
  for (const r of db.prepare(SCOPE_BUCKETS_SQL).all(sessionId, agentId)) {
    out[r.link_confidence] = { bucket: r.bucket, reason: r.reason, unit_key: r.unit_key };
  }
  return out;
}

export function linksOfUnit(db, unitKey) {
  const out = [];
  for (const r of db.prepare(UNIT_LINKS_SQL).all(unitKey)) {
    let e = out[out.length - 1];
    if (!e || e.session_id !== r.session_id || e.agent_id !== r.agent_id) {
      e = {
        evidence_id: buildLinkEvidenceId(unitKey, r.session_id, r.agent_id),
        session_id: r.session_id,
        agent_id: r.agent_id,
        confidence: r.confidence,
        methods: [],
        attribution: scopeBuckets(db, r.session_id, r.agent_id),
      };
      out.push(e);
    }
    if (RANK[r.confidence] < RANK[e.confidence]) e.confidence = r.confidence;
    e.methods.push({
      method: r.method,
      confidence: r.confidence,
      base_confidence: r.base_confidence,
      lowered_by: r.lowered_by,
      match: r.match,
      phase_level: r.phase_level,
      refs: r.refs,
      write_refs: r.write_refs,
      instants: r.instants,
      first_ms: r.first_ms,
      last_ms: r.last_ms,
    });
  }
  return out;
}

export function loadUnitEvidence({
  home, unitKey, mode = 'medium', period = allPeriod(), tz, limit = 50, now = () => new Date(), clockFixed = false,
}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError(LIMIT_MESSAGE);
  const zone = tz ?? period?.tz ?? resolveTz();
  const range = rangeFragment(period);
  const nowMs = now().getTime();
  const db = openDerivedReadOnly({ home });
  const store = existsSync(storePath(home)) ? openStoreReadOnly({ home }) : null;
  try {
    const unit = db.prepare(UNIT_ROW_SQL).get(unitKey) ?? null;
    const links = linksOfUnit(db, unitKey);
    const base = ` FROM api_call c JOIN scope_attribution sa ON sa.session_id = c.owner_session_id
 AND sa.agent_id = c.owner_agent_id AND sa.link_confidence = ? AND sa.bucket = 'attributed' AND sa.unit_key = ?
 WHERE ${SECTION_WHERE.main}${range.sql}`;
    const params = [mode, unitKey, ...range.params];
    const counts = db.prepare(`SELECT count(*) AS calls, count(DISTINCT c.owner_session_id || char(0) || c.owner_agent_id) AS scopes${base}`).get(...params);
    const items = db.prepare(`
SELECT c.call_key, c.owner_session_id, c.owner_agent_id, c.message_id, c.request_id, c.ts_utc, c.occurrences${base}
 ORDER BY c.ts_ms ASC NULLS LAST, c.call_key ASC LIMIT ?`).all(...params, limit).map((r) => {
      const item = {
        callKey: r.call_key, sessionId: r.owner_session_id, agentId: r.owner_agent_id, messageId: r.message_id,
        requestId: r.request_id, tsUtc: r.ts_utc, occurrences: r.occurrences,
      };
      return { ...item, files: filesOf(store, item) };
    });
    const callsTsUnknown = range.bounded ? db.prepare('SELECT count(*) AS n FROM api_call WHERE ts_ms IS NULL').get().n : 0;
    return {
      kind: 'unit',
      evidenceId: buildUnitEvidenceId(unitKey),
      unitKey,
      unit: unit === null ? null : { ...unit },
      mode,
      links,
      scopes: counts.scopes,
      calls: counts.calls,
      listed: items.length,
      items,
      period,
      callsTsUnknown,
      tz: zone,
      clockFixed,
      asOfMs: nowMs,
      freshnessCheck: loadFreshness({ home, nowMs }),
    };
  } finally {
    db.close();
    if (store) store.close();
  }
}

// Plan 02-07 (D-19, UNIT-06, T-02-67): the evidence of one link id, (unit, session, agent). Both databases are opened
// read-only. Every unit_link row of that pair, the scope's link_scope row and both modes' scope_attribution rows, the
// unit's interval with its sources, and the method evidence read from the store: the refs, commands and skill calls that
// the link rules used for that unit. Review 02-07 WR-02: the scope is rebuilt from the store (refs, commands, skill calls,
// its repos without the unit-link fallback) and handed to scopeLinkParts, the function scopeLinks is made of, so the
// evidence cannot disagree with unit_link (the phase-level overlap pick, the repo-over-dir-name preference, the repo and
// single-hit conditions of a slash instant and the trust rule are not copied here); at most `limit` per method, with counts. ref_dir is printed as stored (home-normalized)
// and rel_path is repo-relative: never an absolute path. The listing covers all time.
const LINK_SCOPE_SQL = 'SELECT calls, first_ms, last_ms, refs_known, worktree, subagent, repos FROM link_scope WHERE session_id = ? AND agent_id = ?';
const LINK_ROWS_SQL = `
SELECT method, confidence, base_confidence, lowered_by, match, phase_level, refs, write_refs, instants, first_ms, last_ms
  FROM unit_link WHERE unit_key = ? AND session_id = ? AND agent_id = ? ORDER BY method`;
const LINK_UNIT_SQL = `
SELECT unit_key, repo_key, kind, native_id, dir_rel, start_ms, end_ms, date_source, end_source, git_evidence, commits_bounded
  FROM unit WHERE unit_key = ?`;
const ALL_UNITS_SQL = `
SELECT unit_key, repo_key, kind, native_id, dir_rel, start_ms, end_ms, date_source, end_source, git_evidence, commits_bounded,
       interval_trusted
  FROM unit ORDER BY unit_key`;
const SCOPE_REFS_SQL = `
SELECT message_id, ref_dir, rel_path, ref_kind, tool_name, n FROM cc_message_ref
 WHERE session_id = ? AND agent_id = ? ORDER BY message_id, ref_dir, rel_path`;
const DIR_SQL = 'SELECT repo_key FROM dir_repo WHERE dir = ?';
const NAME_LIST = COMMAND_NAMES.map(() => '?').join(', ');
// Same text and time rule as link-fill.mjs COMMANDS_SQL (ts_ms from ts_utc, NULL when absent or unparsable).
const SCOPE_COMMANDS_SQL = `
SELECT uuid, command_name AS name, ts_utc,
       CASE WHEN ts_utc IS NULL THEN NULL ELSE CAST(round(unixepoch(ts_utc, 'subsec') * 1000) AS INTEGER) END AS ts_ms
  FROM cc_command WHERE session_id = ? AND agent_id = ? AND command_name IN (${NAME_LIST}) ORDER BY uuid`;
const SCOPE_SKILL_MESSAGE_SQL = 'SELECT attribution_skill FROM cc_message WHERE session_id = ? AND agent_id = ? AND message_id = ?';
// The main-section calls of the scope: the repo a call had before the unit-link fallback gave it one (repo_rule unit-link).
const SCOPE_CALLS_SQL = `
SELECT message_id, ts_ms, CASE WHEN repo_rule = 'unit-link' THEN NULL ELSE repo_key END AS repo_key
  FROM api_call WHERE token_label = 'transcript' AND owner_session_id = ? AND owner_agent_id = ?
 ORDER BY message_id`;
const REF_TS_SQL = 'SELECT ts_ms FROM api_call WHERE message_id = ?';
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function loadLinkEvidence({
  home, unitKey, sessionId, agentId = '', tz, limit = 50, now = () => new Date(), clockFixed = false,
}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError(LIMIT_MESSAGE);
  const zone = tz ?? resolveTz();
  const nowMs = now().getTime();
  const db = openDerivedReadOnly({ home });
  const store = existsSync(storePath(home)) ? openStoreReadOnly({ home }) : null;
  try {
    const unit = db.prepare(LINK_UNIT_SQL).get(unitKey) ?? null;
    const scope = db.prepare(LINK_SCOPE_SQL).get(sessionId, agentId) ?? null;
    const methods = db.prepare(LINK_ROWS_SQL).all(unitKey, sessionId, agentId).map((r) => ({ ...r }));
    const buckets = scopeBuckets(db, sessionId, agentId);
    const evidence = { refs: [], commands: [], skills: [] };
    const totals = { refs: 0, commands: 0, skills: 0 };
    if (unit !== null && scope !== null && store !== null) {
      const units = db.prepare(ALL_UNITS_SQL).all();
      const dirs = new Map();
      const dirOf = store.prepare(DIR_SQL);
      const repoOf = (dir) => {
        if (!dirs.has(dir)) dirs.set(dir, dirOf.get(dir)?.repo_key ?? null);
        return dirs.get(dir);
      };
      const calls = db.prepare(SCOPE_CALLS_SQL).all(sessionId, agentId);
      const refTs = db.prepare(REF_TS_SQL);
      const refs = store.prepare(SCOPE_REFS_SQL).all(sessionId, agentId).map((r) => ({
        ...r, ts_ms: refTs.get(r.message_id)?.ts_ms ?? null,
      }));
      const skillOf = store.prepare(SCOPE_SKILL_MESSAGE_SQL);
      const skills = [];
      const seen = new Set();
      for (const c of calls) {
        const name = skillOf.get(sessionId, agentId, c.message_id)?.attribution_skill ?? null;
        if (name === null || !COMMAND_NAMES.includes(name)) continue;
        const k = `${name}\0${c.repo_key}\0${c.ts_ms}`;
        if (seen.has(k)) continue;
        seen.add(k);
        skills.push({ name, message_id: c.message_id, repo_key: c.repo_key, ts_ms: c.ts_ms });
      }
      skills.sort((a, b) => byKey(a.name, b.name) || byKey(String(a.repo_key), String(b.repo_key)) || (a.ts_ms ?? -Infinity) - (b.ts_ms ?? -Infinity));
      const repos = [...new Set(calls.map((c) => c.repo_key).filter((v) => v !== null))].sort(byKey);
      const commands = store.prepare(SCOPE_COMMANDS_SQL).all(sessionId, agentId, ...COMMAND_NAMES);
      const ctx = { repoOfDir: new Map(refs.map((r) => [r.ref_dir, repoOf(r.ref_dir)])), units };
      const { parts } = scopeLinkParts({
        first_ms: scope.first_ms, last_ms: scope.last_ms, repos, refs, instants: buildInstants({ commands, skills, repos }),
      }, ctx);
      const has = (m) => methods.some((r) => r.method === m);
      if (has('tool-path')) {
        const used = parts.get(`${unitKey}\0tool-path`)?.refs ?? [];
        totals.refs = used.length;
        evidence.refs = used.slice(0, limit).map((r) => ({
          message_id: r.message_id, ref_dir: r.ref_dir, rel_path: r.rel_path, ref_kind: r.ref_kind, tool_name: r.tool_name, n: r.n,
        }));
      }
      if (has('slash-command')) {
        const used = parts.get(`${unitKey}\0slash-command`)?.instants ?? [];
        const cmds = used.filter((i) => i.source === 'command');
        const sks = used.filter((i) => i.source === 'skill');
        totals.commands = cmds.length;
        totals.skills = sks.length;
        evidence.commands = cmds.slice(0, limit).map((i) => ({ uuid: i.uuid, name: i.name, ts_utc: i.ts_utc }));
        evidence.skills = sks.slice(0, limit).map((i) => ({ name: i.name, message_id: i.message_id, ts_ms: i.ts_ms }));
      }
    }
    let best = null;
    for (const m of methods) if (best === null || RANK[m.confidence] < RANK[best]) best = m.confidence;
    return {
      kind: 'link',
      evidenceId: buildLinkEvidenceId(unitKey, sessionId, agentId),
      unitKey,
      sessionId,
      agentId,
      unit: unit === null ? null : { ...unit },
      scope: scope === null ? null : { ...scope },
      attribution: buckets,
      best,
      methods,
      evidence,
      totals,
      period: allPeriod(),
      callsTsUnknown: 0,
      tz: zone,
      clockFixed,
      asOfMs: nowMs,
      freshnessCheck: loadFreshness({ home, nowMs }),
    };
  } finally {
    db.close();
    if (store) store.close();
  }
}
