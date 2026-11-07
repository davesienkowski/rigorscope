// Per-unit confounders (plan 02-07, UNIT-04, D-16, D-17, DATA-07, TRUST-06) and the unit runtime (UNIT-01). Filled inside
// the one rebuild transaction after attribution and the repo fallback, from derived rows and the store (attached
// read-only as s). Fixed SQL text; the mode is bound; column names come only from the frozen TRANSCRIPT_COLUMNS map.
//
// Per unit and mode (medium and low), from the calls of the scopes attributed to the unit in that mode:
//   model, effort, speed  per role (api_call.role): the JSON text of the sorted distinct non-NULL values of
//                         api_call.model, effort and speed (speed is the fast-mode flag), unknown_calls the calls with
//                         NULL; source transcript
//   cc_version            unit-level: the Claude Code version of each attributed call's owner message (cc_message.version)
//   worker_mode, worker_count, subagents
//                         from the attributed scopes' link_scope rows through workerModeOf; source rule:worktree-cwd@1
//                         (a session in a linked worktree is a worker; a managed worker cannot be told from any other
//                         session in a linked worktree)
// A unit with no attributed call in the mode has one row per name above with value NULL, unknown_calls NULL and source
// no-attributed-call. Mode-independent (written for both modes):
//   repo                  the unit's display, source git-common-dir
//   unit_size             the JSON text of 02-05's size columns, NULL with source no-unit-commit when no commit is known
//   gsd_version, base_sha, local_mods_head, hooks_sha, hook_events, model_default, advisor_model
//                         from the latest env_snapshot taken at or before the unit start (ties by run id; envAt): source
//                         env-snapshot (label unavailable when the field is NULL there), before-first-snapshot when the
//                         unit started before every snapshot, no-start when its start is unknown. Nothing is inferred
//                         from release dates or from a later snapshot.
// Labels: transcript for a known transcript value, reconstructed for a known worker, repo, size or env value,
// unavailable for every NULL (unknown is never shown as unchanged or zero).
//
// Runtime: unit.runtime is 'claude-code' for a unit with at least one unit_link row of final confidence high or medium
// (a linked Claude Code transcript), else NULL (fillRuntime, called by fillConfounders).
import { LINK_CONFIDENCE_MODES } from './attribution.mjs';

export const CONFOUNDER_NAMES = Object.freeze(['model', 'effort', 'speed', 'cc_version', 'worker_mode', 'worker_count',
  'subagents', 'repo', 'unit_size', 'gsd_version', 'base_sha', 'local_mods_head', 'hooks_sha', 'hook_events',
  'model_default', 'advisor_model']);
export const ENV_NAMES = Object.freeze(['gsd_version', 'base_sha', 'local_mods_head', 'hooks_sha', 'hook_events',
  'model_default', 'advisor_model']);
export const WORKER_SOURCE = 'rule:worktree-cwd@1';
const TRANSCRIPT_COLUMNS = Object.freeze({ model: 'c.model', effort: 'c.effort', speed: 'c.speed' });
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// rows: [{ value, calls }] -> { value: JSON text of the sorted distinct non-null values or null, unknown_calls }.
export function valueSetOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return { value: null, unknown_calls: null };
  const known = [...new Set(list.filter((r) => r.value !== null && r.value !== undefined).map((r) => String(r.value)))].sort(byKey);
  const unknown = list.filter((r) => r.value === null || r.value === undefined).reduce((n, r) => n + (r.calls ?? 0), 0);
  return { value: known.length === 0 ? null : JSON.stringify(known), unknown_calls: unknown };
}

// scopes: [{ session_id, worktree (1, 0 or null), subagent (1 or 0) }] -> { mode, count, subagents }.
export function workerModeOf(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  if (list.length === 0) return { mode: null, count: null, subagents: null };
  const subagents = list.filter((s) => s.subagent === 1).length;
  let mode = null;
  if (list.some((s) => s.worktree === 1)) mode = 'worktree';
  else if (subagents > 0) mode = 'subagent';
  else if (list.every((s) => s.worktree === 0)) mode = 'inline';
  const sessions = new Set(list.filter((s) => s.worktree === 1).map((s) => s.session_id)).size;
  return { mode, count: mode === null ? null : sessions + subagents, subagents };
}

// snapshots: [{ run_id, taken_utc, ...fields }]; startMs: the unit start or null.
// -> { snapshot, source }: the latest snapshot taken at or before startMs (ties by the larger run id).
export function envAt(snapshots, startMs) {
  if (startMs === null || startMs === undefined || !Number.isFinite(startMs)) return { snapshot: null, source: 'no-start' };
  let best = null;
  let bestMs = null;
  for (const s of Array.isArray(snapshots) ? snapshots : []) {
    const ms = Date.parse(s.taken_utc);
    if (!Number.isFinite(ms) || ms > startMs) continue;
    if (best === null || ms > bestMs || (ms === bestMs && s.run_id > best.run_id)) { best = s; bestMs = ms; }
  }
  return best === null ? { snapshot: null, source: 'before-first-snapshot' } : { snapshot: best, source: 'env-snapshot' };
}

const ATTRIBUTED = `JOIN scope_attribution sa ON sa.session_id = c.owner_session_id AND sa.agent_id = c.owner_agent_id
                           AND sa.link_confidence = ? AND sa.bucket = 'attributed'`;
const roleSql = (col) => `
SELECT sa.unit_key, c.role, ${col} AS value, count(*) AS calls
  FROM api_call c ${ATTRIBUTED}
 WHERE c.token_label = 'transcript'
 GROUP BY sa.unit_key, c.role, ${col}
 ORDER BY sa.unit_key, c.role, ${col}`;
const VERSION_SQL = `
SELECT sa.unit_key, m.version AS value, count(*) AS calls
  FROM api_call c ${ATTRIBUTED}
  LEFT JOIN s.cc_message m ON m.session_id = c.owner_session_id AND m.agent_id = c.owner_agent_id AND m.message_id = c.message_id
 WHERE c.token_label = 'transcript'
 GROUP BY sa.unit_key, m.version
 ORDER BY sa.unit_key, m.version`;
const SCOPES_SQL = `
SELECT sa.unit_key, ls.session_id, ls.agent_id, ls.worktree, ls.subagent
  FROM scope_attribution sa JOIN link_scope ls ON ls.session_id = sa.session_id AND ls.agent_id = sa.agent_id
 WHERE sa.link_confidence = ? AND sa.bucket = 'attributed'
 ORDER BY sa.unit_key, ls.session_id, ls.agent_id`;
const UNITS_SQL = `
SELECT unit_key, repo, start_ms, size_commits, size_files, size_added, size_deleted FROM unit ORDER BY unit_key`;
const SNAPSHOTS_SQL = `
SELECT run_id, taken_utc, ${ENV_NAMES.join(', ')} FROM s.env_snapshot ORDER BY taken_utc, run_id`;
const INSERT_SQL = `
INSERT INTO unit_confounder (unit_key, link_confidence, name, role, value, unknown_calls, source, label)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const RUNTIME_SQL = `
UPDATE unit SET runtime = CASE WHEN EXISTS (SELECT 1 FROM unit_link l WHERE l.unit_key = unit.unit_key
                                              AND l.confidence IN ('high', 'medium')) THEN 'claude-code' END`;

const groupBy = (rows, key = 'unit_key') => {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r[key])) out.set(r[key], []);
    out.get(r[key]).push(r);
  }
  return out;
};

export function fillRuntime({ db }) {
  db.exec(RUNTIME_SQL);
}

export function fillConfounders({ db }) {
  fillRuntime({ db });
  const ins = db.prepare(INSERT_SQL);
  const units = db.prepare(UNITS_SQL).all();
  const snapshots = db.prepare(SNAPSHOTS_SQL).all();
  for (const mode of LINK_CONFIDENCE_MODES) {
    const byName = Object.fromEntries(Object.entries(TRANSCRIPT_COLUMNS).map(([name, col]) => [name, groupBy(db.prepare(roleSql(col)).all(mode))]));
    const versions = groupBy(db.prepare(VERSION_SQL).all(mode));
    const scopes = groupBy(db.prepare(SCOPES_SQL).all(mode));
    for (const u of units) {
      const rows = [];
      const add = (name, role, value, unknown, source, label) => rows.push([name, role, value, unknown, source, label]);
      const attributed = scopes.get(u.unit_key) ?? [];
      if (attributed.length === 0) {
        for (const name of ['model', 'effort', 'speed', 'cc_version', 'worker_mode', 'worker_count', 'subagents']) {
          add(name, '', null, null, 'no-attributed-call', 'unavailable');
        }
      } else {
        for (const name of Object.keys(TRANSCRIPT_COLUMNS)) {
          const byRole = groupBy(byName[name].get(u.unit_key) ?? [], 'role');
          for (const role of [...byRole.keys()].sort(byKey)) {
            const v = valueSetOf(byRole.get(role));
            add(name, role, v.value, v.unknown_calls, 'transcript', v.value === null ? 'unavailable' : 'transcript');
          }
        }
        const ver = valueSetOf(versions.get(u.unit_key) ?? []);
        add('cc_version', '', ver.value, ver.unknown_calls, 'transcript', ver.value === null ? 'unavailable' : 'transcript');
        const w = workerModeOf(attributed);
        const scalar = (v) => (v === null ? null : String(v));
        const lab = (v) => (v === null ? 'unavailable' : 'reconstructed');
        add('worker_mode', '', w.mode, null, WORKER_SOURCE, lab(w.mode));
        add('worker_count', '', scalar(w.count), null, WORKER_SOURCE, lab(w.count));
        add('subagents', '', scalar(w.subagents), null, WORKER_SOURCE, lab(w.subagents));
      }
      add('repo', '', u.repo, null, 'git-common-dir', 'reconstructed');
      const size = u.size_commits === null ? null : JSON.stringify({
        commits: u.size_commits, files: u.size_files, added: u.size_added, deleted: u.size_deleted,
      });
      add('unit_size', '', size, null, size === null ? 'no-unit-commit' : 'git', size === null ? 'unavailable' : 'reconstructed');
      const env = envAt(snapshots, u.start_ms);
      for (const name of ENV_NAMES) {
        const v = env.snapshot === null ? null : env.snapshot[name];
        add(name, '', v ?? null, null, env.source, v === null || v === undefined ? 'unavailable' : 'reconstructed');
      }
      rows.sort((a, b) => byKey(a[0], b[0]) || byKey(a[1], b[1]));
      for (const r of rows) ins.run(u.unit_key, mode, ...r);
    }
  }
}
