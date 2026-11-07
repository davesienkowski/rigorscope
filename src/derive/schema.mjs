// derived.db schema (plan 01-04). derived.db is disposable: it is rebuilt from store.db and never
// migrated, so changing a table here means raising PASS_VERSION, which makes ensureDerived rebuild every
// older file. Every table is STRICT; an unknown token value is NULL, never 0 (RR-04).
//
//   api_call       one row per deduplicated message id (call_key 'm:' + message_id); identity columns
//                  come from the owner occurrence (src/derive/owner.mjs), role columns from
//                  src/derive/role.mjs, flags from src/derive/parts.mjs
//   api_call_part  the tokens: part 0 is the executor part at the call model, parts 1.. are advisor
//                  parts at the advisor model; every token figure in a report is a sum over parts
//   derive_state   one row: when and from what the file was built, the counters of the pass, the
//                  store-side per-class totals the conservation check compares the parts with, and the
//                  price table the parts were priced with (plan 01-05)
//
// Prices (plan 01-05): every part carries its notional cost in integer nano-dollars (cost_nano, NULL when
// unknown, never 0 for unknown), its price status and floor; every call carries the NULL-propagating sum
// of its parts. CHECK constraints tie the columns: a part has a cost and a tier exactly when it is priced,
// a floor exactly when it has a floor reason, and a call is labeled derived exactly when its cost is known.
// A row inserted without the price columns (a raw tamper in a test) defaults to unpriced: status no_table,
// cost NULL, label unavailable, never 0. The derivation pass always binds every column.
//
// Window share (plan 01-06, D-11a): the estimator of src/derive/window.mjs spreads each window's percentage
// delta between consecutive usage snapshots over the parts of that interval.
//   window_interval       one row per consecutive snapshot pair of a window: its status (usable, reset,
//                         falling, flat, unknown_tokens, zero_weight), the delta in micro-points (usable only),
//                         the member part count and weight total. No snapshot id, so the content does not
//                         depend on ingest order.
//   api_call_part_window  one row per part and window for every part inside an interval; share_micro is the
//                         part's share in micro-points (1 point = 1,000,000), NULL unless the interval is usable
//   usage_latest          the one latest snapshot (by fetched_at_ms, then source), for the cost header line
//
// OTel join (plan 01-07, D-06, D-12): src/derive/otel-fill.mjs joins the OTel api_request events to the
// transcript calls on request_id.
//   api_call       gains section (main for transcript calls, otel or harness for otel_only calls), the
//                  re-validated OTel text (qs, qs_role, otel_agent_name), the agent-name cross-check state
//                  (xcheck), qs_conflict and effort_source. join_state is transcript_only, joined or otel_only;
//                  an otel_only call has no message id (call_key 'o:' + request key), token_label otel, price_basis
//                  otel_executor_only (OTel sees the executor only, never advisor tokens) and an OTel cost
//                  labeled otel; a joined call keeps its transcript tokens and derived cost untouched.
//   otel_call      one row per OTel request key (the owner event of src/derive/otel-owner.mjs): its fields,
//                  occurrence count, conflict flag, join state, the number of transcript calls it joined and
//                  their derived cost (the derived side of the error band; cost_nano is the measured side)
//   join_stat      the counted join figures by fixed name (otel_requests, joined, ...), read by the report and
//                  by the doctor of plan 01-09

// Report dimensions (plan 01-08, D-07): src/derive/dimensions-fill.mjs adds three columns to api_call.
//   ts_ms      the call instant as integer epoch milliseconds (unixepoch of ts_utc), NULL when ts_utc is NULL or
//              unparseable; the day buckets and the --since/--until bounds compare this integer, never a date string
//   repo       the display of the repository the owner message's cwd resolved to at ingest (repo_label.display, plan
//              02-02, D-09): the name when it is unique, else the repo_key; main section only; the cwd is never stored
//   repo_key   that repository's key (the home-normalized git common dir), NULL with repo
//   repo_rule  the resolver method: git, ancestor or none (none for no cwd, an unresolved cwd and every other section)
// The index api_call_section_ts_idx on (section, ts_ms) serves the period filter.

// Units (plan 02-02, UNIT-01, ADR-0004, ADR-0009): src/derive/unit-fill.mjs fills two tables from the store's repo
// and unit tables of migration 007.
//   repo_label  one row per store repo: its key, its name and the display used everywhere a repo is printed: the name
//               when exactly one repo carries it, else the full repo_key (so two repos named alike stay apart)
//   unit        one row per reconstructed unit with the whole UNIT-01 record shape. Filled now: identity (key,
//               framework, repo, kind, native id, dir), present, population, recorded_at_utc, the quick-id start
//               (start_ms, date_source) and the frontmatter tier (tier, tier_native, tier_signal, tier_conflict).
//               Plan 02-05 fills the rest from the stored git facts with 02-03's pure rules (unit-fill.mjs):
//               tier from all signal places with tier_timing, tier_conflict and tier_comparable (TIER-02, D-03);
//               risk_class (the JSON text of the sorted tag array, NULL for unknown) with risk_source; novelty with
//               novelty_source; start_ms with date_source and end_ms with end_source (D-10); git_evidence; and the
//               unit size size_commits, size_files, size_added, size_deleted (D-17, NULL when no unit commit is
//               known). branch (never: amendment Q5) and runtime stay NULL. NULL means unknown, never 0.
//               Review 02-05 WR-01: commits_bounded is 1 for a scanned plan unit whose own PLAN has a first-add commit
//               (its commits were bounded below by that time at ingest), 0 for a scanned plan unit without one (an
//               untracked or uncommitted PLAN: no bound), NULL for a quick unit or a unit with no scan.
//               Review 02-07 WR-01: interval_trusted is 1 when the unit's interval ends at a git time that fewer than
//               SHARED_END_MIN units of its repo share, 0 for any other usable interval, NULL when the unit has no usable
//               interval (src/derive/link-fill.mjs intervalTrust; derived like every unit column, so no migration).
//   unit_role   one row per (unit, artifact role) with the number of the unit's artifacts of that role (n >= 1).
// Links and attribution (plan 02-07, UNIT-06, D-12, D-13, D-17; every table rebuilt from store rows):
//   link_scope         one row per (session, agent) scope with a main-section call: its call count, first and last call
//                      time, refs_known (the 02-04 capture-known rule: a cc_message_file row of the scope points at a
//                      source_file with head_hash not NULL and state ok), worktree (Task 3), subagent and its repo count
//   unit_link          one row per (scope, unit, method): the D-12 link with its final and base confidence, the lowering
//                      rules applied (D-10 no-git-dates, the dir-name fallback), how a tool-path ref matched, whether it
//                      rests on phase-level refs only, its ref, write-ref and instant counts and its first and last time
//                      (src/derive/link-fill.mjs)
//   scope_attribution  one row per scope and mode (medium, the strict default, and low): the D-13 bucket, its reason, the
//                      unit of an attributed scope, the number of counted units and refs_known (src/derive/attribution.mjs)
//   unit_attribution   one row per unit and mode: the attributed scopes, sessions, subagent scopes, calls and the attributed
//                      scopes whose refs are unknown
//   unit_confounder    one row per unit, mode, confounder name and role ('' for a unit-level name): the value (JSON text
//                      of a sorted value set, or a scalar), the calls with an unknown value, its source and label (Task 3,
//                      src/derive/confounders.mjs)
// derive_state gains the link counters (link_scopes, link_scopes_refs_unknown, link_refs, link_refs_unmatched,
// link_refs_ambiguous, link_dir_name, link_phase_dropped, link_slash_ambiguous, link_lowered, link_units_no_interval, link_shared_end_units) and
// repo_fallback_calls, NULL until a fill sets them.
// derive_state also records the risk-rule table the pass used (risk_rules_file, risk_rules_version, risk_rules_sha;
// NULL for no usable table), the number of units and the number of ends raised to their start (units_end_clamped).

// 01-01 built pass version 1 (api_call only); 01-04 version 2 (parts); 01-05 version 3 (prices); 01-06
// version 4 (window share); 01-07 version 5 (OTel join); 01-08 version 6 (time and repo dimensions); 01-12
// version 7 (the tri-state server_tool_use flag and the server_tool_use_unknown floor reasons); review CR-01
// version 8 (an unknown server_tool_use copy is no longer erased by a 0 from another copy of the call); 02-02
// version 9 (repos and units: repo_label and unit); review 02-02 CR-02 version 10 (a unit's tier is read only from
// artifacts under its stored dir_rel); 02-05 version 11 (unit attributes from the stored git facts: tier, timing,
// comparability, risk, novelty, end date, git evidence, unit size and role counts); review 02-05 version 12 (only the
// commits of a unit's last complete scan count, a unit size is unknown when a commit lost a path, the mtime start reads
// the earliest mtime ever seen, a raised end is labeled clamped, and commits_bounded); 02-07 version 13 (session-to-unit
// links, attribution buckets, the unit-link repo fallback, per-unit confounders and runtime); review 02-07 version 14
// (unit.interval_trusted and link_shared_end_units: a shared or non-git unit end makes no medium link; a dir-name-only match
// is low; link evidence reads the link rules; the attribution JSON labels its values); 03-03 version 15 (forward units:
// a unit_key with ledger lines is one row with population forward, its tier, start and end merged per field from the
// ledger with the source label `ledger`, status, tier_source and the ledger_* columns, recon_* what reconstruction alone
// computed, has_recon, ledger_start_ms and ledger_end_ms; dir_rel is NULL only for a ledger-only unit); review 03-05 H1 and M1
// version 16 (recon_date_source and recon_end_source: the reconstruction's own date sources, so calibrate can tell a day from an
// instant; recon_end_ms is now the end before the clamp, and recon_end_source `clamped` marks a reconstruction end raised to its
// start); plan 03.1-02 version 17 (a unit's artifacts are the rows under its stored dir or under the archive dir it moved to, merged
// by file name, so a moved unit keeps its tier and counts each file once; no DDL change); plan 03.1-02 version 18 (unit.id_repeats and
// the table repo_scan_count: the repeated-id marker and the per-repo location counts of the latest scan); review CR-03 version 19 (repo_scan_count
// holds a row of 0 for every counter of a repo whose latest scan wrote the sentinel, so a missing row means unknown; output only, no DDL
// change); plan 03.1-03 version 20 (link-fill names a unit through its former live path and a reused plan id never falls through to
// a sibling plan; output only, no DDL change); review WR-02 version 21 (the reused-id rule also holds for a ref found only by dir name; output
// only, no DDL change). Rebuild reason: pass_version; a derived
// schema change, not a store migration.
export const PASS_VERSION = 21;

// otel_measured and otel_no_cost (plan 01-07) are the parts of otel_only calls: their cost is OTel's measured
// cost_usd, never a price-table cost, and otel_no_cost means OTel gave none (cost NULL).
export const PRICE_STATUS_SQL = "'priced', 'unpriced_model', 'unknown_tokens', 'unknown_modifier', 'no_table', 'otel_measured', 'otel_no_cost'";
export const XCHECK_SQL = "'agree', 'disagree', 'custom', 'no_name', 'no_transcript_role', 'not_joined'";
export const FLOOR_REASON_SQL = "'ttl_unresolved', 'server_tool_use', 'ttl_unresolved+server_tool_use', "
  + "'server_tool_use_unknown', 'ttl_unresolved+server_tool_use_unknown'";
export const WINDOW_SQL = "'five_hour', 'seven_day'";
export const INTERVAL_STATUS_SQL = "'usable', 'reset', 'falling', 'flat', 'unknown_tokens', 'zero_weight'";
// Plan 02-02 (D-01 Q1, ADR-0004): the unit record's closed value sets.
export const TIER_SIGNAL_SQL = "'frontmatter', 'tier-file', 'probes-skipped', 'ledger', 'none'";
export const TIER_TIMING_SQL = "'declared-at-start', 'declared-at-close', 'declared-mid-unit', 'inferred'";
export const DATE_SOURCE_SQL = "'quick-id', 'git', 'frontmatter', 'mtime', 'ledger', 'none'";
// Plan 03-03 (D-04, D-14): the ledger's tier sources and the closed unit statuses (`incomplete` is derived: a start line
// and no close line).
export const LEDGER_TIER_SOURCE_SQL = "'declared-at-start', 'plan-at-start', 'declared-at-close', 'unknown'";
export const UNIT_STATUS_SQL = "'complete', 'failed', 'abandoned', 'incomplete'";
// Review 02-05 WR-03: an end raised to the start carries its own label, never the source it replaced.
export const END_SOURCE_SQL = `${DATE_SOURCE_SQL}, 'clamped'`;
export const POPULATION_SQL = "'reconstructed', 'forward'";
// Plan 02-02 (D-09): the repo rule of a call is the resolver method of its owner message's cwd.
// Plan 02-07 (D-09, Q2): `unit-link` is the repo of the unit a call's scope is attributed to in mode medium, set only
// for a call whose cwd resolved to no repo (src/derive/dimensions-fill.mjs fillRepoFallback).
export const REPO_RULE_SQL = "'git', 'ancestor', 'none', 'unit-link'";
// Plan 02-07 (D-12, D-13, D-17): the closed value sets of links, attribution and confounders.
export const LINK_METHOD_SQL = "'tool-path', 'slash-command', 'interval'";
export const CONFIDENCE_SQL = "'high', 'medium', 'low'";
export const LINK_MODE_SQL = "'medium', 'low'";
export const BUCKET_SQL = "'attributed', 'unattributed_overlap', 'unlinked'";
export const REASON_SQL = "'one-unit', 'one-low-unit', 'multi-unit', 'low-only', 'no-link'";
export const LOWERED_BY_SQL = "'no-git-dates', 'dir-name', 'dir-name+no-git-dates'";
export const CONFOUNDER_NAME_SQL = "'model', 'effort', 'speed', 'cc_version', 'worker_mode', 'worker_count', 'subagents', "
  + "'repo', 'unit_size', 'gsd_version', 'base_sha', 'local_mods_head', 'hooks_sha', 'hook_events', 'model_default', "
  + "'advisor_model'";
const pctCol = (w) => `  ${w}_pct        REAL CHECK (${w}_pct IS NULL OR (${w}_pct >= 0 AND ${w}_pct <= 100)),\n  ${w}_resets_ms  INTEGER`;

// The six token classes, in report order. cache_creation is its own class and is never derived from
// cache_5m + cache_1h (a disagreement is counted in derive_state.cache_split_mismatch_parts).
export const CLASS_COLUMNS = Object.freeze(['input_tokens', 'output_tokens', 'cache_read', 'cache_creation', 'cache_5m', 'cache_1h']);

const tokenCols = CLASS_COLUMNS.map((c) => `  ${c.padEnd(14)} INTEGER CHECK (${c} IS NULL OR ${c} >= 0)`).join(',\n');
const storeTotals = CLASS_COLUMNS.map((c) => `  store_${c}_sum   INTEGER,\n  store_${c}_known INTEGER NOT NULL CHECK (store_${c}_known >= 0)`).join(',\n');
const flag = (c) => `${c} INTEGER CHECK (${c} IS NULL OR ${c} IN (0, 1))`;

export const DERIVED_SQL = `
CREATE TABLE api_call (
  call_key          TEXT PRIMARY KEY,
  message_id        TEXT UNIQUE,
  owner_session_id  TEXT NOT NULL,
  owner_agent_id    TEXT NOT NULL,
  occurrences       INTEGER NOT NULL CHECK (occurrences >= 1),
  request_id        TEXT,
  ts_utc            TEXT,
  model             TEXT,
  role              TEXT NOT NULL,
  role_rule         TEXT NOT NULL CHECK (role_rule IN ('harness', 'attribution', 'meta', 'main', 'query_source', 'query_source_main', 'none')),
  role_source       TEXT NOT NULL CHECK (role_source IN ('transcript', 'derived', 'otel', 'unavailable')),
  role_meta         TEXT,
  ${flag('role_conflict')},
  effort            TEXT,
  join_state        TEXT NOT NULL CHECK (join_state IN ('transcript_only', 'joined', 'otel_only')),
  price_basis       TEXT NOT NULL CHECK (price_basis IN ('iterations', 'top_level_only', 'otel_executor_only')),
  iter_mismatch     INTEGER NOT NULL CHECK (iter_mismatch IN (0, 1)),
  iter_unknown_type INTEGER NOT NULL CHECK (iter_unknown_type IN (0, 1)),
  token_label       TEXT NOT NULL CHECK (token_label IN ('transcript', 'otel')),
  speed             TEXT,
  service_tier      TEXT,
  inference_geo     TEXT,
  ${flag('server_tool_use')},
  cost_nano         INTEGER CHECK (cost_nano IS NULL OR cost_nano >= 0),
  cost_floor        INTEGER NOT NULL DEFAULT 0 CHECK (cost_floor IN (0, 1)),
  cost_label        TEXT NOT NULL DEFAULT 'unavailable' CHECK (cost_label IN ('derived', 'otel', 'unavailable')),
  section           TEXT NOT NULL DEFAULT 'main' CHECK (section IN ('main', 'otel', 'harness')),
  qs                TEXT,
  qs_role           TEXT,
  ${flag('qs_conflict')},
  otel_agent_name   TEXT,
  xcheck            TEXT CHECK (xcheck IS NULL OR xcheck IN (${XCHECK_SQL})),
  effort_source     TEXT CHECK (effort_source IS NULL OR effort_source IN ('transcript', 'otel')),
  ts_ms             INTEGER,
  repo              TEXT,
  repo_key          TEXT,
  repo_rule         TEXT NOT NULL DEFAULT 'none' CHECK (repo_rule IN (${REPO_RULE_SQL})),
  CHECK ((cost_label IN ('derived', 'otel')) = (cost_nano IS NOT NULL)),
  CHECK ((message_id IS NULL) = (join_state = 'otel_only'))
) STRICT;

CREATE INDEX api_call_request_idx ON api_call (request_id);
CREATE INDEX api_call_section_ts_idx ON api_call (section, ts_ms);

CREATE TABLE api_call_part (
  call_key       TEXT NOT NULL REFERENCES api_call (call_key),
  part_seq       INTEGER NOT NULL CHECK (part_seq >= 0),
  kind           TEXT NOT NULL CHECK (kind IN ('message', 'advisor')),
  model          TEXT,
${tokenCols},
  price_model    TEXT,
  price_status   TEXT NOT NULL DEFAULT 'no_table' CHECK (price_status IN (${PRICE_STATUS_SQL})),
  price_tier     TEXT CHECK (price_tier IS NULL OR price_tier IN ('standard', 'long_prompt', 'fast')),
  geo_us         INTEGER NOT NULL DEFAULT 0 CHECK (geo_us IN (0, 1)),
  cost_nano      INTEGER CHECK (cost_nano IS NULL OR cost_nano >= 0),
  cost_floor     INTEGER NOT NULL DEFAULT 0 CHECK (cost_floor IN (0, 1)),
  floor_reason   TEXT CHECK (floor_reason IS NULL OR floor_reason IN (${FLOOR_REASON_SQL})),
  price_version  TEXT,
  PRIMARY KEY (call_key, part_seq),
  CHECK ((price_status IN ('priced', 'otel_measured')) = (cost_nano IS NOT NULL)),
  CHECK ((price_status = 'priced') = (price_tier IS NOT NULL)),
  CHECK ((cost_floor = 1) = (floor_reason IS NOT NULL))
) STRICT;

CREATE INDEX api_call_part_model ON api_call_part (model);

CREATE TABLE derive_state (
  id                         INTEGER PRIMARY KEY CHECK (id = 1),
  built_utc                  TEXT NOT NULL,
  pass_version               INTEGER NOT NULL,
  store_user_version         INTEGER NOT NULL,
  store_fingerprint          TEXT NOT NULL,
  owner_rule                 TEXT NOT NULL,
  newest_record_utc          TEXT,
  last_run_end_utc           TEXT,
  api_call_rows              INTEGER NOT NULL,
  api_call_part_rows         INTEGER NOT NULL,
  duplicate_occurrences      INTEGER NOT NULL,
  synthetic_skipped          INTEGER NOT NULL,
  top_level_only_calls       INTEGER NOT NULL,
  iter_mismatch_calls        INTEGER NOT NULL,
  iter_unknown_type_calls    INTEGER NOT NULL,
  role_conflict_calls        INTEGER NOT NULL,
  cache_split_mismatch_parts INTEGER NOT NULL,
${storeTotals},
  price_file                 TEXT,
  price_date_read            TEXT,
  price_sha                  TEXT,
  window_weights             TEXT,
  usage_snapshots            INTEGER CHECK (usage_snapshots IS NULL OR usage_snapshots >= 0),
  risk_rules_file            TEXT,
  risk_rules_version         TEXT,
  risk_rules_sha             TEXT,
  units_n                    INTEGER CHECK (units_n IS NULL OR units_n >= 0),
  units_end_clamped          INTEGER CHECK (units_end_clamped IS NULL OR units_end_clamped >= 0),
${['link_scopes', 'link_scopes_refs_unknown', 'link_refs', 'link_refs_unmatched', 'link_refs_ambiguous', 'link_dir_name',
    'link_phase_dropped', 'link_slash_ambiguous', 'link_lowered', 'link_units_no_interval', 'link_shared_end_units',
    'repo_fallback_calls']
    .map((c) => `  ${c.padEnd(26)} INTEGER CHECK (${c} IS NULL OR ${c} >= 0)`).join(',\n')}
) STRICT;

CREATE TABLE window_interval (
  win           TEXT NOT NULL CHECK (win IN (${WINDOW_SQL})),
  seq           INTEGER NOT NULL CHECK (seq >= 0),
  start_ms      INTEGER NOT NULL,
  end_ms        INTEGER NOT NULL CHECK (end_ms > start_ms),
  start_pct     REAL NOT NULL CHECK (start_pct >= 0 AND start_pct <= 100),
  end_pct       REAL NOT NULL CHECK (end_pct >= 0 AND end_pct <= 100),
  resets_ms     INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN (${INTERVAL_STATUS_SQL})),
  delta_micro   INTEGER CHECK (delta_micro IS NULL OR delta_micro > 0),
  parts         INTEGER NOT NULL CHECK (parts >= 0),
  weight_total  INTEGER CHECK (weight_total IS NULL OR weight_total >= 0),
  PRIMARY KEY (win, seq),
  CHECK ((status = 'usable') = (delta_micro IS NOT NULL))
) STRICT;

CREATE TABLE api_call_part_window (
  call_key      TEXT NOT NULL,
  part_seq      INTEGER NOT NULL,
  win           TEXT NOT NULL CHECK (win IN (${WINDOW_SQL})),
  interval_seq  INTEGER NOT NULL CHECK (interval_seq >= 0),
  share_micro   INTEGER CHECK (share_micro IS NULL OR share_micro >= 0),
  PRIMARY KEY (call_key, part_seq, win),
  FOREIGN KEY (call_key, part_seq) REFERENCES api_call_part (call_key, part_seq),
  FOREIGN KEY (win, interval_seq) REFERENCES window_interval (win, seq)
) STRICT;

CREATE TABLE otel_call (
  request_key       TEXT PRIMARY KEY,
  request_id        TEXT,
  session_id        TEXT NOT NULL,
  ts_utc            TEXT,
  model             TEXT,
  query_source      TEXT,
  effort            TEXT,
  agent_name        TEXT,
${tokenCols},
  cost_nano         INTEGER CHECK (cost_nano IS NULL OR cost_nano >= 0),
  occurrences       INTEGER NOT NULL CHECK (occurrences >= 1),
  conflicting       INTEGER NOT NULL CHECK (conflicting IN (0, 1)),
  state             TEXT NOT NULL CHECK (state IN ('joined', 'otel_only')),
  transcript_calls  INTEGER NOT NULL CHECK (transcript_calls >= 0),
  derived_nano      INTEGER CHECK (derived_nano IS NULL OR derived_nano >= 0),
  ${flag('derived_flag')},
  CHECK ((state = 'joined') = (transcript_calls > 0))
) STRICT;

CREATE INDEX otel_call_request_idx ON otel_call (request_id);

CREATE TABLE join_stat (
  name  TEXT PRIMARY KEY,
  n     INTEGER NOT NULL CHECK (n >= 0)
) STRICT;

CREATE TABLE repo_label (
  repo_key   TEXT NOT NULL PRIMARY KEY,
  repo_name  TEXT,
  display    TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE unit (
  unit_key        TEXT NOT NULL PRIMARY KEY,
  framework       TEXT NOT NULL,
  repo_key        TEXT NOT NULL,
  repo            TEXT NOT NULL,
  repo_name       TEXT,
  kind            TEXT NOT NULL,
  native_id       TEXT NOT NULL,
  dir_rel         TEXT,
  present         INTEGER NOT NULL CHECK (present IN (0, 1)),
  population      TEXT NOT NULL CHECK (population IN (${POPULATION_SQL})),
  recorded_at_utc TEXT,
  start_ms        INTEGER,
  end_ms          INTEGER,
  date_source     TEXT NOT NULL CHECK (date_source IN (${DATE_SOURCE_SQL})),
  branch          TEXT,
  runtime         TEXT,
  tier_native     TEXT,
  tier            TEXT CHECK (tier IS NULL OR tier IN ('A', 'B', 'C')),
  tier_signal     TEXT NOT NULL CHECK (tier_signal IN (${TIER_SIGNAL_SQL})),
  tier_timing     TEXT CHECK (tier_timing IS NULL OR tier_timing IN (${TIER_TIMING_SQL})),
  tier_conflict   INTEGER NOT NULL CHECK (tier_conflict IN (0, 1)),
  risk_class      TEXT,
  risk_source     TEXT,
  novelty         TEXT CHECK (novelty IS NULL OR novelty IN ('first-of-kind', 'incremental')),
  novelty_source  TEXT,
  end_source      TEXT NOT NULL CHECK (end_source IN (${END_SOURCE_SQL})),
  git_evidence    INTEGER NOT NULL CHECK (git_evidence IN (0, 1)),
  tier_comparable INTEGER NOT NULL CHECK (tier_comparable IN (0, 1)),
  size_commits    INTEGER CHECK (size_commits IS NULL OR size_commits >= 0),
  size_files      INTEGER CHECK (size_files IS NULL OR size_files >= 0),
  size_added      INTEGER CHECK (size_added IS NULL OR size_added >= 0),
  size_deleted    INTEGER CHECK (size_deleted IS NULL OR size_deleted >= 0),
  commits_bounded INTEGER CHECK (commits_bounded IS NULL OR commits_bounded IN (0, 1)),
  interval_trusted INTEGER CHECK (interval_trusted IS NULL OR interval_trusted IN (0, 1)),
  status          TEXT CHECK (status IS NULL OR status IN (${UNIT_STATUS_SQL})),
  tier_source     TEXT CHECK (tier_source IS NULL OR tier_source IN (${LEDGER_TIER_SOURCE_SQL})),
  ledger_lines    INTEGER NOT NULL DEFAULT 0 CHECK (ledger_lines >= 0),
  ledger_command  TEXT,
  ledger_runtime  TEXT,
  ledger_session_id TEXT,
  recon_tier      TEXT CHECK (recon_tier IS NULL OR recon_tier IN ('A', 'B', 'C')),
  recon_start_ms  INTEGER,
  recon_end_ms    INTEGER,
  recon_date_source TEXT CHECK (recon_date_source IS NULL OR recon_date_source IN (${DATE_SOURCE_SQL})),
  recon_end_source  TEXT CHECK (recon_end_source IS NULL OR recon_end_source IN (${END_SOURCE_SQL})),
  has_recon       INTEGER NOT NULL DEFAULT 1 CHECK (has_recon IN (0, 1)),
  ledger_start_ms INTEGER,
  ledger_end_ms   INTEGER,
  id_repeats      INTEGER CHECK (id_repeats IS NULL OR id_repeats >= 0),
  CHECK ((population = 'forward') = (ledger_lines > 0)),
  CHECK (population <> 'reconstructed' OR has_recon = 1),
  CHECK (dir_rel IS NOT NULL OR population = 'forward'),
  CHECK ((tier IS NULL) = (tier_signal = 'none')),
  CHECK ((start_ms IS NULL) = (date_source = 'none')),
  CHECK ((end_ms IS NULL) = (end_source = 'none')),
  CHECK (tier_comparable = 0 OR tier IS NOT NULL)
) STRICT;

CREATE INDEX unit_order_idx ON unit (repo, kind, native_id);

CREATE TABLE repo_scan_count (
  repo_key  TEXT NOT NULL,
  kind      TEXT NOT NULL,
  n         INTEGER NOT NULL CHECK (n >= 0),
  run_id    INTEGER NOT NULL,
  PRIMARY KEY (repo_key, kind)
) STRICT;

CREATE TABLE unit_role (
  unit_key  TEXT NOT NULL,
  role      TEXT NOT NULL,
  n         INTEGER NOT NULL CHECK (n >= 1),
  PRIMARY KEY (unit_key, role)
) STRICT;

CREATE TABLE link_scope (
  session_id  TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  calls       INTEGER NOT NULL CHECK (calls >= 1),
  first_ms    INTEGER,
  last_ms     INTEGER,
  refs_known  INTEGER NOT NULL CHECK (refs_known IN (0, 1)),
  worktree    INTEGER CHECK (worktree IS NULL OR worktree IN (0, 1)),
  subagent    INTEGER NOT NULL CHECK (subagent IN (0, 1)),
  repos       INTEGER NOT NULL CHECK (repos >= 0),
  PRIMARY KEY (session_id, agent_id),
  CHECK ((first_ms IS NULL) = (last_ms IS NULL)),
  CHECK (first_ms IS NULL OR first_ms <= last_ms)
) STRICT;

CREATE TABLE unit_link (
  session_id       TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  unit_key         TEXT NOT NULL,
  method           TEXT NOT NULL CHECK (method IN (${LINK_METHOD_SQL})),
  confidence       TEXT NOT NULL CHECK (confidence IN (${CONFIDENCE_SQL})),
  base_confidence  TEXT NOT NULL CHECK (base_confidence IN (${CONFIDENCE_SQL})),
  lowered_by       TEXT CHECK (lowered_by IS NULL OR lowered_by IN (${LOWERED_BY_SQL})),
  match            TEXT CHECK (match IS NULL OR match IN ('repo', 'dir-name')),
  phase_level      INTEGER NOT NULL CHECK (phase_level IN (0, 1)),
  refs             INTEGER CHECK (refs IS NULL OR refs >= 0),
  write_refs       INTEGER CHECK (write_refs IS NULL OR write_refs >= 0),
  instants         INTEGER CHECK (instants IS NULL OR instants >= 0),
  first_ms         INTEGER,
  last_ms          INTEGER,
  PRIMARY KEY (session_id, agent_id, unit_key, method),
  CHECK ((match IS NOT NULL) = (method = 'tool-path'))
) STRICT;

CREATE INDEX unit_link_unit_idx ON unit_link (unit_key);

CREATE TABLE scope_attribution (
  session_id       TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  link_confidence  TEXT NOT NULL CHECK (link_confidence IN (${LINK_MODE_SQL})),
  bucket           TEXT NOT NULL CHECK (bucket IN (${BUCKET_SQL})),
  reason           TEXT NOT NULL CHECK (reason IN (${REASON_SQL})),
  unit_key         TEXT,
  counted_units    INTEGER NOT NULL CHECK (counted_units >= 0),
  refs_known       INTEGER NOT NULL CHECK (refs_known IN (0, 1)),
  PRIMARY KEY (session_id, agent_id, link_confidence),
  CHECK ((unit_key IS NOT NULL) = (bucket = 'attributed')),
  CHECK ((reason IN ('one-unit', 'one-low-unit')) = (bucket = 'attributed')),
  CHECK ((reason IN ('multi-unit', 'low-only')) = (bucket = 'unattributed_overlap')),
  CHECK ((reason = 'no-link') = (bucket = 'unlinked'))
) STRICT;

CREATE INDEX scope_attribution_unit_idx ON scope_attribution (link_confidence, unit_key);

CREATE TABLE unit_attribution (
  unit_key             TEXT NOT NULL,
  link_confidence      TEXT NOT NULL CHECK (link_confidence IN (${LINK_MODE_SQL})),
  scopes               INTEGER NOT NULL CHECK (scopes >= 0),
  sessions             INTEGER NOT NULL CHECK (sessions >= 0),
  subagent_scopes      INTEGER NOT NULL CHECK (subagent_scopes >= 0),
  calls                INTEGER NOT NULL CHECK (calls >= 0),
  refs_unknown_scopes  INTEGER NOT NULL CHECK (refs_unknown_scopes >= 0),
  PRIMARY KEY (unit_key, link_confidence)
) STRICT;

CREATE TABLE unit_confounder (
  unit_key         TEXT NOT NULL,
  link_confidence  TEXT NOT NULL CHECK (link_confidence IN (${LINK_MODE_SQL})),
  name             TEXT NOT NULL CHECK (name IN (${CONFOUNDER_NAME_SQL})),
  role             TEXT NOT NULL,
  value            TEXT,
  unknown_calls    INTEGER CHECK (unknown_calls IS NULL OR unknown_calls >= 0),
  source           TEXT NOT NULL,
  label            TEXT NOT NULL CHECK (label IN ('transcript', 'reconstructed', 'unavailable')),
  PRIMARY KEY (unit_key, link_confidence, name, role),
  CHECK ((label = 'unavailable') = (value IS NULL))
) STRICT;

CREATE TABLE usage_latest (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  source         TEXT NOT NULL,
  label          TEXT NOT NULL CHECK (label IN ('measured', 'transcript')),
  fetched_at_ms  INTEGER NOT NULL,
${['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'].map(pctCol).join(',\n')}
) STRICT;
`;

// The store fingerprint: run count, last run id, ended runs, last end time, joined with a pipe (NULL is
// the empty string). A run that is still open changes it again when it ends, and two runs inside one
// millisecond still differ by run id and count. `schema` is 'main' (store opened directly) or 's'
// (store attached to the derived connection); nothing else is accepted.
export function fingerprintSql(schema) {
  if (schema !== 'main' && schema !== 's') throw new RangeError('fingerprint schema must be main or s');
  return `SELECT count(*) AS runs, max(run_id) AS last_run, count(ended_utc) AS ended, max(ended_utc) AS last_end FROM ${schema}.ingest_run`;
}

export function fingerprintOf(row) {
  return [row.runs, row.last_run, row.ended, row.last_end].map((v) => (v === null || v === undefined ? '' : String(v))).join('|');
}
