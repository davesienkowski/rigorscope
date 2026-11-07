// Session-to-unit links (plan 02-07, UNIT-06, D-10, D-12 with amendments Q4 and Q8, ADR-0009). Links are made at
// (session, agent) scope, the store's message key prefix, inside the one rebuild transaction from durable store rows:
// 02-04's cc_message_ref (structured tool_use refs only, never command text) and cc_command, phase 1's attribution_skill,
// 02-02's dir_repo and 02-05's derived unit rows. Fixed SQL text; every value is bound. D-12's quick-log method is not
// built: its input would need a store table (migration 008).
//
// Methods and base levels (strongest first):
//   tool-path      a ref of the scope resolves to a unit (refTarget): a quick-dir ref, or a phase file whose name starts
//                  with an existing plan unit's id and a dash, is a direct ref. High when at least one ref row of the scope
//                  to that unit, over all of its messages, has a tool name in WRITE_TOOLS, else medium. A phase-level ref
//                  (a phase directory, or a phase file no plan id of that directory prefixes: CONTEXT, RESEARCH,
//                  VERIFICATION, an outline) links medium to the one plan unit of that directory whose interval overlaps
//                  the scope's, and to none when zero or several overlap or the scope has no interval (phase_dropped); a
//                  write to such a file is still medium (Pitfall 7).
//   slash-command  an instant: a cc_command row of the scope (its time, the scope's repos) or a main-section call of the
//                  scope whose owner message's attribution_skill is in UNIT_COMMANDS (its time, its repo). An instant
//                  whose kind has exactly one unit in its repos with a closed interval containing it links that unit
//                  medium; inside several it links nothing (slash_ambiguous); a command or skill call with no time is no
//                  instant and is counted slash_ambiguous too. Every other name never links.
//   interval       low to every unit of a repo of the scope whose closed interval overlaps the scope's interval.
// Lowering: a link to a unit with git_evidence 0 is one level lower (D-10: high to medium, medium to low, low stays low;
// lowered_by records no-git-dates even on a low link that stays low). A ref whose directory has no repo (no dir_repo row
// or method none) falls back to the directory name: exactly one unit in any repo whose dir (its stored dir_rel read through
// linkDirOf, so an archived unit's former live path; plan 03.1-03) is that dir (plus the plan id for a direct phase file) gives that unit a low link (match dir-name, lowered_by dir-name); several are counted
// ambiguous and link nothing; none is unmatched. When a scope reaches a unit by repo and by dir-name, only the repo-matched
// refs count. Review 02-07 WR-03 (amends D-10's lowering and the Q2 fallback, decided by the coordinator under the owner's
// delegation, 2026-10-30): "exactly one" is only exact among the units this store scanned, so a dir-name-only match is
// capped at low (it never counts in the strict mode); lowered_by stays dir-name, and no-git-dates still lowers a low link
// no further. Intervals are closed; a unit whose start or end source is none, or a plan unit whose commits have no lower
// bound (commits_bounded 0) and whose dates rest on git, has no usable interval (intervalOf null): it takes part in no
// interval, slash-command or phase-level rule and is counted in link_units_no_interval (its direct refs still link).
//
// Interval trust (review 02-07 WR-01, amends D-12): a unit end is often inflated, by a bulk planning commit that touched
// many unit directories at once or by a clamped, frontmatter or mtime end. intervalTrust marks each usable interval
// trusted (1) only when its end is a git time that is not shared, shared = the same end_ms is the end of at least
// SHARED_END_MIN units (a heuristic, not measured on real data) of the same repo whose end source is git, the unit
// itself included; the flag is stored as unit.interval_trusted (NULL exactly when intervalOf is null). The two medium
// interval rules (slash-command, phase-level) count ambiguity over every usable interval but link only a unit whose
// interval is trusted; a trust drop bumps neither slash_ambiguous nor phase_dropped, and the number of shared-end units
// is link_shared_end_units. The low interval method still reads every usable interval (accepted: it never counts in the
// strict mode). Side effect: dropping an untrusted slash link can leave a scope with one counted unit, the tool-path one.
//
// Confidence is one of CONFIDENCES. cc_message_ref merges a message's tool names for one file by bytewise minimum
// (ADR-0009 A4): a message that writes and reads one file with Write and Read stores Read, so such a write is read-only
// evidence (medium); Edit, MultiEdit and NotebookEdit sort before Read and stay write evidence. That residual is
// accepted: it can only lower a link, never raise one.
//
// Plan 03.1-03 (D-19, R1 W4): a ref names a unit through linkDirOf(dir_rel), the unit's former live path, so a unit first
// seen in a milestone archive still links the refs that carry the live path; a live unit is its own former path. A phase
// file whose name carries a plan id held by a unit of the same repo in ANOTHER dir (a plan id reused after
// --reset-phase-numbers) is an ambiguous miss and never falls through to the phase-level rule, which would credit a
// sibling plan; an id held by no unit of the repo keeps the phase-level rule.
//
// Scope rows: link_scope holds one row per (owner_session_id, owner_agent_id) of the main-section calls (token_label
// transcript), with refs_known by the 02-04 capture-known rule (docs/data-model.md): 1 when a cc_message_file row of the
// scope points at a source_file with head_hash not NULL and state ok (a file whose last pass read it to the end), else
// 0, which means unknown, never "no refs"; such a scope is still decided by its known links (skill instants and
// intervals). A scope present only in cc_message_ref (no main-section call) gets no row and its refs count only in
// link_refs. The scope's repos are those of its calls before the unit-link repo fallback runs.
import { linkDirOf } from '../adapters/gsd-core/layout.mjs';

export const LINK_METHODS = Object.freeze(['tool-path', 'slash-command', 'interval']);
export const CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
export const WRITE_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// D-12 slash-command table (read by the slash-command rule): command or skill name -> unit kind. gsd-fast keeps no
// quick directory and gsd-debug makes no unit, so neither links; the `gsd:` spellings are older names of the same
// commands (an assumption; an unseen name costs nothing).
export const UNIT_COMMANDS = Object.freeze(Object.assign(Object.create(null), {
  'gsd-quick': 'quick',
  'gsd-quick-batch': 'quick',
  'gsd-execute-phase': 'plan',
  'gsd-plan-phase': 'plan',
  'gsd-autonomous': 'plan',
  'gsd:quick': 'quick',
  'gsd:quick-batch': 'quick',
  'gsd:execute-phase': 'plan',
  'gsd:plan-phase': 'plan',
  'gsd:autonomous': 'plan',
}));
export const PLAN_ID_PREFIX_RE = /^(\d+(?:\.\d+)?-\d+)-/;

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// high -> medium, medium -> low, low stays low.
export function lowerConfidence(c) {
  if (c === 'high') return 'medium';
  if (c === 'medium') return 'low';
  if (c === 'low') return 'low';
  throw new RangeError('the confidence must be high, medium or low');
}

// Closed intervals { first, last } in ms; false when any bound is null.
export function overlaps(a, b) {
  const ok = (x) => x !== null && x !== undefined && Number.isFinite(x.first) && Number.isFinite(x.last);
  if (!ok(a) || !ok(b)) return false;
  return a.first <= b.last && b.first <= a.last;
}

// A unit's usable closed interval { first, last }, or null (see the header).
export function intervalOf(u) {
  if (u.start_ms === null || u.end_ms === null || u.date_source === 'none' || u.end_source === 'none') return null;
  if (u.kind === 'plan' && u.commits_bounded === 0 && u.git_evidence === 1) return null;
  return { first: u.start_ms, last: u.end_ms };
}

// The shared-end bound of WR-01: this many units of one repo ending at the same git instant make that end suspect.
export const SHARED_END_MIN = 5;

// units: unit rows with repo_key, end_ms, end_source and the intervalOf fields. -> { trusted: Map(unit_key -> 1 | 0 | null,
// in input order; null exactly when intervalOf is null), shared: the number of usable units whose end is shared }.
export function intervalTrust(units) {
  const ends = new Map();
  const keyOf = (u) => `${u.repo_key}\0${u.end_ms}`;
  for (const u of units) {
    if (u.end_source === 'git' && Number.isFinite(u.end_ms)) ends.set(keyOf(u), (ends.get(keyOf(u)) ?? 0) + 1);
  }
  const trusted = new Map();
  let shared = 0;
  for (const u of units) {
    if (intervalOf(u) === null) { trusted.set(u.unit_key, null); continue; }
    const git = u.end_source === 'git' && Number.isFinite(u.end_ms);
    const isShared = git && ends.get(keyOf(u)) >= SHARED_END_MIN;
    if (isShared) shared += 1;
    trusted.set(u.unit_key, git && !isShared ? 1 : 0);
  }
  return { trusted, shared };
}

// ref: { ref_dir, rel_path, ref_kind }; ctx: { repoOfDir: Map(ref_dir -> repo_key | null), units: [unit rows] }.
// -> { unitKey, direct: true, match } | { phaseDir: { repoKey, dirRel }, match } | { miss: 'unmatched' | 'ambiguous' };
// match is 'repo' or 'dir-name'.
export function refTarget(ref, ctx) {
  const segs = String(ref.rel_path).split('/');
  const dirRel = segs.slice(0, 3).join('/');
  const file = segs.length > 3 ? segs[3] : null;
  const repoKey = ctx.repoOfDir.get(ref.ref_dir) ?? null;
  const match = repoKey === null ? 'dir-name' : 'repo';
  // Plan 03.1-03: a unit's dir is its former live path (linkDirOf), so a unit first seen archived still links the refs that
  // carry the live path; a live dir is its own former path.
  const inDir = ctx.units.filter((u) => linkDirOf(u.dir_rel) === dirRel && (repoKey === null || u.repo_key === repoKey));
  const one = (list) => {
    if (list.length === 1) return { unitKey: list[0].unit_key, direct: true, match };
    return { miss: list.length === 0 ? 'unmatched' : 'ambiguous' };
  };
  if (ref.ref_kind === 'quick') return one(inDir.filter((u) => u.kind === 'quick'));
  const plans = inDir.filter((u) => u.kind === 'plan');
  const m = file === null ? null : PLAN_ID_PREFIX_RE.exec(file);
  const own = m ? plans.filter((u) => u.native_id === m[1]) : [];
  if (own.length > 0) return one(own);
  const repos = [...new Set(plans.map((u) => u.repo_key))].sort(byKey);
  if (repos.length === 0) return { miss: 'unmatched' };
  if (repos.length > 1) return { miss: 'ambiguous' };
  // R1 W4 (reset numbering): a file name that carries a plan id held by a unit of the same repo in ANOTHER dir is a reused id,
  // not a phase-level file of this dir; it must not fall through to the sibling plan (a dir that holds no plan unit stays
  // unmatched, above). An id held by no unit of the repo keeps the phase-level rule. The repo is repos[0], the one repo whose
  // plans the dir holds (above), so the dir-name fallback (no repo for the ref's directory) is covered too (review WR-02).
  if (m && ctx.units.some((u) => u.kind === 'plan' && u.repo_key === repos[0] && u.native_id === m[1])) {
    return { miss: 'ambiguous' };
  }
  return { phaseDir: { repoKey: repos[0], dirRel }, match };
}

const lowered = (base, { dirName = false, noGit = false }) => {
  let c = base;
  if (dirName) c = 'low'; // review 02-07 WR-03: a dir-name-only match is capped at low, never strong
  if (noGit) c = lowerConfidence(c);
  const by = [dirName ? 'dir-name' : null, noGit ? 'no-git-dates' : null].filter(Boolean).join('+');
  return { confidence: c, lowered_by: by === '' ? null : by };
};
const minOf = (xs) => (xs.length === 0 ? null : Math.min(...xs));
const maxOf = (xs) => (xs.length === 0 ? null : Math.max(...xs));
const isMs = (v) => typeof v === 'number' && Number.isFinite(v);

// scope: { first_ms, last_ms, repos: [repo_key], refs: [{ ref_dir, rel_path, ref_kind, tool_name, ts_ms }],
// instants: [{ name, repos: [repo_key], ts_ms }] }; ctx: refTarget's ctx. Extra fields on a ref or instant ride along
// untouched (the link evidence reads them back from `parts`).
// -> { links: rows in (unit_key, method) bytewise order, counts: { unmatched, ambiguous, dir_name, phase_dropped,
// slash_ambiguous }, parts: Map(`${unit_key}\0${method}` -> { refs: [the ref objects that made the tool-path link],
// instants: [the instant objects that made the slash-command link] }) } (review 02-07 WR-02: the one place the rules live,
// read by fillLinks through scopeLinks and by the link evidence). An interval link has no part.
export function scopeLinkParts(scope, ctx) {
  const counts = {
    unmatched: 0, ambiguous: 0, dir_name: 0, phase_dropped: 0, slash_ambiguous: 0,
  };
  const byUnit = new Map(ctx.units.map((u) => [u.unit_key, u]));
  const span = isMs(scope.first_ms) && isMs(scope.last_ms) ? { first: scope.first_ms, last: scope.last_ms } : null;
  const repos = new Set(scope.repos ?? []);
  const rows = [];
  const parts = new Map();

  // tool-path
  const acc = new Map();
  for (const ref of scope.refs ?? []) {
    const t = refTarget(ref, ctx);
    if (t.miss) { counts[t.miss] += 1; continue; }
    let unitKey = t.unitKey;
    if (t.phaseDir) {
      const picks = ctx.units.filter((u) => u.kind === 'plan' && u.repo_key === t.phaseDir.repoKey && linkDirOf(u.dir_rel) === t.phaseDir.dirRel
        && span !== null && overlaps(intervalOf(u), span));
      if (picks.length !== 1) { counts.phase_dropped += 1; continue; }
      if (picks[0].interval_trusted !== 1) continue; // WR-01: an untrusted interval never makes a medium link, and is no drop
      unitKey = picks[0].unit_key;
    }
    if (t.match === 'dir-name') counts.dir_name += 1;
    if (!acc.has(unitKey)) acc.set(unitKey, []);
    acc.get(unitKey).push({
      direct: t.direct === true, write: t.direct === true && WRITE_TOOLS.includes(ref.tool_name), match: t.match, ts: isMs(ref.ts_ms) ? ref.ts_ms : null, ref,
    });
  }
  for (const [unitKey, all] of acc) {
    const byRepo = all.filter((r) => r.match === 'repo');
    const use = byRepo.length > 0 ? byRepo : all;
    const match = byRepo.length > 0 ? 'repo' : 'dir-name';
    const base = use.some((r) => r.write) ? 'high' : 'medium';
    const u = byUnit.get(unitKey);
    const l = lowered(base, { dirName: match === 'dir-name', noGit: u.git_evidence === 0 });
    const ts = use.map((r) => r.ts).filter((v) => v !== null);
    parts.set(`${unitKey}\0tool-path`, { refs: use.map((r) => r.ref), instants: [] });
    rows.push({
      unit_key: unitKey, method: 'tool-path', confidence: l.confidence, base_confidence: base, lowered_by: l.lowered_by, match,
      phase_level: use.every((r) => !r.direct) ? 1 : 0, refs: use.length, write_refs: use.filter((r) => r.write).length,
      instants: null, first_ms: minOf(ts), last_ms: maxOf(ts),
    });
  }

  // slash-command
  const slash = new Map();
  for (const inst of scope.instants ?? []) {
    const kind = UNIT_COMMANDS[inst.name];
    if (kind === undefined) continue;
    if (!isMs(inst.ts_ms)) { counts.slash_ambiguous += 1; continue; }
    const at = { first: inst.ts_ms, last: inst.ts_ms };
    const instRepos = new Set(inst.repos ?? []);
    const hits = ctx.units.filter((u) => u.kind === kind && instRepos.has(u.repo_key) && overlaps(intervalOf(u), at));
    if (hits.length > 1) { counts.slash_ambiguous += 1; continue; }
    if (hits.length === 0) continue;
    if (hits[0].interval_trusted !== 1) continue; // WR-01: ambiguity is counted over every usable interval, a link needs a trusted one
    if (!slash.has(hits[0].unit_key)) slash.set(hits[0].unit_key, []);
    slash.get(hits[0].unit_key).push(inst);
  }
  for (const [unitKey, list] of slash) {
    const ts = list.map((i) => i.ts_ms);
    parts.set(`${unitKey}\0slash-command`, { refs: [], instants: list });
    const l = lowered('medium', { noGit: byUnit.get(unitKey).git_evidence === 0 });
    rows.push({
      unit_key: unitKey, method: 'slash-command', confidence: l.confidence, base_confidence: 'medium', lowered_by: l.lowered_by,
      match: null, phase_level: 0, refs: null, write_refs: null, instants: ts.length, first_ms: minOf(ts), last_ms: maxOf(ts),
    });
  }

  // interval
  if (span !== null) {
    for (const u of ctx.units) {
      const iv = intervalOf(u);
      if (!repos.has(u.repo_key) || !overlaps(iv, span)) continue;
      const l = lowered('low', { noGit: u.git_evidence === 0 });
      rows.push({
        unit_key: u.unit_key, method: 'interval', confidence: l.confidence, base_confidence: 'low', lowered_by: l.lowered_by,
        match: null, phase_level: 0, refs: null, write_refs: null, instants: null,
        first_ms: Math.max(iv.first, span.first), last_ms: Math.min(iv.last, span.last),
      });
    }
  }
  rows.sort((a, b) => byKey(a.unit_key, b.unit_key) || byKey(a.method, b.method));
  return { links: rows, counts, parts };
}

// -> { links, counts } of scopeLinkParts.
export function scopeLinks(scope, ctx) {
  const { links, counts } = scopeLinkParts(scope, ctx);
  return { links, counts };
}

// The slash instants of a scope from its command rows and skill calls (shared by fillLinks and the link evidence).
// commands: [{ name, ts_ms, ... }]; skills: [{ name, repo_key | null, ts_ms, ... }]; repos: the scope's repo keys.
// -> [{ ...row, repos, source: 'command' | 'skill' }] commands first, in input order.
export function buildInstants({ commands = [], skills = [], repos = [] }) {
  return [
    ...commands.map((c) => ({ ...c, repos, source: 'command' })),
    ...skills.map((c) => ({ ...c, repos: c.repo_key === null || c.repo_key === undefined ? [] : [c.repo_key], source: 'skill' })),
  ];
}

const MAIN = "token_label = 'transcript'";
const SCOPE_SQL = `
INSERT INTO link_scope (session_id, agent_id, calls, first_ms, last_ms, refs_known, worktree, subagent, repos)
SELECT c.owner_session_id, c.owner_agent_id, count(*), min(c.ts_ms), max(c.ts_ms),
       CASE WHEN EXISTS (SELECT 1 FROM s.cc_message_file mf JOIN s.source_file f ON f.file_id = mf.file_id
                          WHERE mf.session_id = c.owner_session_id AND mf.agent_id = c.owner_agent_id
                            AND f.head_hash IS NOT NULL AND f.state = 'ok') THEN 1 ELSE 0 END,
       NULL, CASE WHEN c.owner_agent_id <> '' THEN 1 ELSE 0 END, count(DISTINCT c.repo_key)
  FROM api_call c
 WHERE c.${MAIN}
 GROUP BY c.owner_session_id, c.owner_agent_id
 ORDER BY c.owner_session_id, c.owner_agent_id`;
const SCOPES_SQL = 'SELECT session_id, agent_id, first_ms, last_ms FROM link_scope ORDER BY session_id, agent_id';
const SCOPE_REPOS_SQL = `
SELECT DISTINCT owner_session_id AS session_id, owner_agent_id AS agent_id, repo_key FROM api_call
 WHERE ${MAIN} AND repo_key IS NOT NULL
 ORDER BY owner_session_id, owner_agent_id, repo_key`;
const REFS_SQL = `
SELECT r.session_id, r.agent_id, r.message_id, r.ref_dir, r.rel_path, r.ref_kind, r.tool_name, r.n,
       (SELECT c.ts_ms FROM api_call c WHERE c.message_id = r.message_id) AS ts_ms
  FROM s.cc_message_ref r
 ORDER BY r.session_id, r.agent_id, r.message_id, r.ref_dir, r.rel_path`;
const DIRS_SQL = `
SELECT d.dir, d.repo_key FROM s.dir_repo d
 WHERE d.dir IN (SELECT DISTINCT ref_dir FROM s.cc_message_ref)
 ORDER BY d.dir`;
const UNITS_SQL = `
SELECT unit_key, repo_key, kind, native_id, dir_rel, start_ms, end_ms, date_source, end_source, git_evidence,
       commits_bounded, interval_trusted
  FROM unit ORDER BY unit_key`;
const NAMES = Object.keys(UNIT_COMMANDS).sort(byKey);
export const COMMAND_NAMES = Object.freeze([...NAMES]);
const NAME_LIST = NAMES.map(() => '?').join(', ');
const SKILLS_SQL = `
SELECT DISTINCT c.owner_session_id AS session_id, c.owner_agent_id AS agent_id, m.attribution_skill AS name, c.repo_key,
       c.ts_ms
  FROM api_call c
  JOIN s.cc_message m ON m.session_id = c.owner_session_id AND m.agent_id = c.owner_agent_id AND m.message_id = c.message_id
 WHERE c.${MAIN} AND m.attribution_skill IN (${NAME_LIST})
 ORDER BY 1, 2, 3, 4, 5`;
const COMMANDS_SQL = `
SELECT session_id, agent_id, uuid, command_name AS name,
       CASE WHEN ts_utc IS NULL THEN NULL ELSE CAST(round(unixepoch(ts_utc, 'subsec') * 1000) AS INTEGER) END AS ts_ms
  FROM s.cc_command
 WHERE command_name IN (${NAME_LIST})
 ORDER BY session_id, agent_id, uuid`;
const INSERT_LINK_SQL = `
INSERT INTO unit_link (session_id, agent_id, unit_key, method, confidence, base_confidence, lowered_by, match, phase_level,
                       refs, write_refs, instants, first_ms, last_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const STATE_SQL = `
UPDATE derive_state
   SET link_scopes = (SELECT count(*) FROM link_scope),
       link_scopes_refs_unknown = (SELECT count(*) FROM link_scope WHERE refs_known = 0),
       link_refs = ?, link_refs_unmatched = ?, link_refs_ambiguous = ?, link_dir_name = ?, link_phase_dropped = ?,
       link_slash_ambiguous = ?, link_lowered = (SELECT count(*) FROM unit_link WHERE lowered_by IS NOT NULL),
       link_units_no_interval = ?, link_shared_end_units = ?
 WHERE id = 1`;

const groupByScope = (rows) => {
  const out = new Map();
  for (const r of rows) {
    const k = `${r.session_id}\0${r.agent_id}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
};

// link_scope.worktree (D-17): 1 when a subagent of the scope was spawned with a worktree (cc_agent_meta) or a call's
// owner message has a cwd whose dir_repo row is a linked worktree; 0 when every call's cwd has a dir_repo row outside
// one; NULL otherwise (an unresolved or missing cwd and no worktree seen). The cwd is read inside the statement and never
// reaches a derived column.
const WORKTREE_SQL = `
UPDATE link_scope SET worktree = CASE
  WHEN EXISTS (SELECT 1 FROM s.cc_agent_meta a WHERE a.session_id = link_scope.session_id AND a.agent_id = link_scope.agent_id
                  AND a.spawned_with_worktree = 1) THEN 1
  ELSE (SELECT CASE WHEN max(d.is_worktree) = 1 THEN 1 WHEN count(*) > 0 AND count(d.is_worktree) = count(*) THEN 0 END
          FROM api_call c
          JOIN s.cc_message m ON m.session_id = c.owner_session_id AND m.agent_id = c.owner_agent_id AND m.message_id = c.message_id
          LEFT JOIN s.dir_repo d ON d.dir = m.cwd
         WHERE c.${MAIN} AND c.owner_session_id = link_scope.session_id AND c.owner_agent_id = link_scope.agent_id)
END`;

export function fillLinks({ db }) {
  db.exec(SCOPE_SQL);
  db.exec(WORKTREE_SQL);
  const refs = db.prepare(REFS_SQL).all();
  const refsBy = groupByScope(refs);
  const reposBy = groupByScope(db.prepare(SCOPE_REPOS_SQL).all());
  const skillsBy = groupByScope(db.prepare(SKILLS_SQL).all(...NAMES));
  const commandsBy = groupByScope(db.prepare(COMMANDS_SQL).all(...NAMES));
  const units = db.prepare(UNITS_SQL).all();
  const ctx = { repoOfDir: new Map(db.prepare(DIRS_SQL).all().map((d) => [d.dir, d.repo_key])), units };
  const ins = db.prepare(INSERT_LINK_SQL);
  const total = {
    unmatched: 0, ambiguous: 0, dir_name: 0, phase_dropped: 0, slash_ambiguous: 0,
  };
  for (const scope of db.prepare(SCOPES_SQL).all()) {
    const k = `${scope.session_id}\0${scope.agent_id}`;
    const repos = (reposBy.get(k) ?? []).map((r) => r.repo_key);
    const instants = buildInstants({ commands: commandsBy.get(k) ?? [], skills: skillsBy.get(k) ?? [], repos });
    const { links, counts } = scopeLinks({
      first_ms: scope.first_ms, last_ms: scope.last_ms, repos, refs: refsBy.get(k) ?? [], instants,
    }, ctx);
    for (const name of Object.keys(total)) total[name] += counts[name];
    for (const l of links) {
      ins.run(scope.session_id, scope.agent_id, l.unit_key, l.method, l.confidence, l.base_confidence, l.lowered_by, l.match,
        l.phase_level, l.refs, l.write_refs, l.instants, l.first_ms, l.last_ms);
    }
  }
  db.prepare(STATE_SQL).run(refs.length, total.unmatched, total.ambiguous, total.dir_name, total.phase_dropped,
    total.slash_ambiguous, units.filter((u) => intervalOf(u) === null).length, intervalTrust(units).shared);
}
