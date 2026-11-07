// store.db schema version 7: reconstructed units of work (phase 2, ADR-0009, Proposed).
//
// Adds the durable facts phase 2 needs from sources that age out (session directories, untracked .planning/ dirs,
// transcripts), so they are recorded while they still exist. It deletes and rewrites no existing row; plan 02-02's
// sections need no transcript reread, and plan 02-04 adds the D-15 reread as its own section.
//
// Section contract: the migration is an ordered list of sections. A later phase 2 plan appends a section object at the
// end of SECTIONS and never edits or reorders an earlier one; plan 02-05 freezes the file and pins the sha256 of `sql`.
// Nothing in any section may depend on the environment, the date or the machine. Every CREATE carries IF NOT EXISTS,
// so the end-to-end tests of migrations 005 and 006, which rewind user_version on a store that already holds these
// tables and then migrate through the whole list again, run it harmlessly; a store at version 6 has none of them.
//
// Sections of plan 02-02:
//   repos  repo      one row per repo_key: the home-normalized realpath of a git common dir (amendment Q2), its
//                    display name (NULL when it fails the segment shape), the runs it was first and last seen in and
//                    the run that last scanned its main working tree
//          dir_repo  one row per stored session directory examined, written once: the method that resolved it
//                    (git, ancestor or none), its repo_key (NULL exactly for none) and whether it was a linked worktree
//   units  unit_obs       one row per unit: key framework:repo_key:kind:native_id, the unit dir relative to the repo's
//                         main working tree, the quick-id date read as a local date with its UTC offset in minutes
//                         (never a zone name, D-11), first and last run seen
//          unit_artifact  one row per planning file of a unit: its role (the ADPT-01 set), mtime (the latest seen) and
//                         first_mtime_ms (the earliest seen, review 02-05 WR-05), first commit time (filled by plan
//                         02-05) and a tier letter with the place it was read from, nothing else of the file
//
// Sections of plan 02-04 (they add tables and indexes only and delete no row):
//   transcript-refs  cc_message_ref  one row per (message, ref_dir, rel_path): the planning paths a message's
//                                    tool_use blocks name in the structured input fields file_path, path,
//                                    notebook_path and Glob's pattern (amendment Q4 and review WR-02; never a Bash
//                                    command string or a Grep pattern), split into the home-normalized directory before `.planning/` (ref_dir) and the
//                                    path from `.planning/` on (rel_path), the kind (quick or phase), the tool name and
//                                    n, the largest number of tool_use blocks of one line that named it. A child row of
//                                    the message (ADR-0009 A4 and its 2026-10-30 amendment, review CR-01): n merges by
//                                    the NULL-safe maximum and tool_name by the bytewise minimum, so a message spread
//                                    over several lines stores the same rows in any read order; ref_kind follows
//                                    rel_path.
//   transcript-commands  cc_command  one row per user line holding a slash-command name: the line's session, agent and
//                                    uuid, its time and the command NAME only (never its arguments), written once
//                                    (ON CONFLICT DO NOTHING).
//   transcript-reread    the D-15 one-time reread: head_hash is set to NULL on the transcript session and subagent
//                        files (the 006 statement), so the first ingest after the apply rereads each file still on
//                        disk from offset 0 and fills the two tables above; the writers' natural-key upserts make the
//                        reread idempotent. Files that aged out are not reread: their sessions keep no ref and no
//                        command row and their head_hash stays NULL, which plan 02-07 reads as unknown, never zero; a
//                        reread cut between chunks leaves state 'reading', also unknown until a run finishes the file
//                        (the capture-known rule in docs/data-model.md, review WR-03).
//   env-snapshot     env_snapshot  one row per ingest run (a run-log table, written once): the GSD version and where it
//                                  was read, the installed base sha and the local-mods HEAD when configured, the hook
//                                  event counts and a sha256 of the hooks block (never a command), the model and advisor
//                                  model names; NULL means unknown. Forward-only: nothing is inferred for earlier runs.
//
// Sections of plan 02-05 (they add tables only and delete no row; the last sections of 007). The git facts derive
// cannot compute itself (derive runs no git), stored at ingest by src/adapters/gsd-core/facts.mjs:
//   unit-facts      unit_path         one row per (unit, path) of the unit PLAN's files_modified list (repo-relative or
//                                     `~/...`), path_source fixed to files_modified, written once (a set)
//                   unit_commit       one row per (unit, commit) of 02-03's unitCommits: the sha, the author time, the
//                                     number of paths git listed (dropped ones included), summed numstat line counts
//                                     (NULL when a file has none or a path was dropped) and whether a file lies outside
//                                     `.planning/`; integers merge by NULL-safe maximum; last_seen_run is the last run
//                                     whose complete scan of the unit saw the commit (review WR-02: derive counts only
//                                     the rows whose last_seen_run equals the unit's unit_git_scan.scanned_run)
//                   unit_commit_file  one row per (unit, commit, path): the status A, M or D and numstat line counts
//                   unit_module_dir   one row per (unit, module dir of an added code path): whether git found the dir
//                                     at the parent of the unit's oldest commit (1, 0 or NULL for unknown)
//                   unit_git_scan     one row per scanned unit: the sha256 of the repo's `show-ref --head` output when
//                                     the unit was last scanned completely, its commit count and the run; a cursor
//                                     updated in place, written only after a complete scan, so a git failure leaves no
//                                     row and the next run retries
//   artifact-times  unit_artifact_time  one row per artifact that has a time or date: the oldest commit that set its
//                                     frontmatter tier letter, its last commit, and the SUMMARY's `completed:` date read
//                                     as a local day with that day's UTC offset in minutes. A sibling table of
//                                     unit_artifact, not added columns: ALTER TABLE ADD COLUMN cannot run twice, and the
//                                     005/006 rewind tests run 007 again on a store that has its tables.
// Plan 02-05 freezes this file: test/unit/migration-007.test.mjs pins the section ids and the sha256 of `sql`; plan
// 02-06 applies exactly this sql to the live store, and any later store change is a new migration. The review of plan
// 02-05 reopened it once, before any live apply, for unit_commit.last_seen_run (WR-02) and
// unit_artifact.first_mtime_ms (WR-05), and re-pinned it (ADR-0009, the amendment of that review).
// No column stores a branch name (amendment Q5), any planning-file text, a commit subject or body, or an author or
// committer name or email.
export const version = 7;

const SHAPE_SLUG = (col) => `length(${col}) BETWEEN 1 AND 32 AND ${col} NOT GLOB '*[^a-z0-9-]*'`;
const PLANNING_REL = (col) => `${col} GLOB '.planning/*' AND length(${col}) <= 512 AND instr(${col}, '..') = 0`;

const REPOS = `
CREATE TABLE IF NOT EXISTS repo (
  repo_key         TEXT NOT NULL PRIMARY KEY CHECK (length(repo_key) BETWEEN 1 AND 1024),
  repo_name        TEXT CHECK (repo_name IS NULL OR length(repo_name) BETWEEN 1 AND 64),
  first_seen_run   INTEGER NOT NULL,
  last_seen_run    INTEGER NOT NULL,
  last_scanned_run INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS dir_repo (
  dir          TEXT NOT NULL PRIMARY KEY CHECK (length(dir) BETWEEN 1 AND 1024),
  repo_key     TEXT REFERENCES repo (repo_key),
  method       TEXT NOT NULL CHECK (method IN ('git', 'ancestor', 'none')),
  is_worktree  INTEGER CHECK (is_worktree IS NULL OR is_worktree IN (0, 1)),
  resolved_run INTEGER NOT NULL,
  CHECK ((repo_key IS NULL) = (method = 'none')),
  CHECK ((is_worktree IS NULL) = (method = 'none'))
) STRICT;

CREATE INDEX IF NOT EXISTS dir_repo_repo_idx ON dir_repo (repo_key);
`;

const UNITS = `
CREATE TABLE IF NOT EXISTS unit_obs (
  unit_key       TEXT NOT NULL PRIMARY KEY,
  framework      TEXT NOT NULL CHECK (${SHAPE_SLUG('framework')}),
  repo_key       TEXT NOT NULL REFERENCES repo (repo_key),
  kind           TEXT NOT NULL CHECK (${SHAPE_SLUG('kind')}),
  native_id      TEXT NOT NULL CHECK (length(native_id) BETWEEN 1 AND 64 AND native_id NOT GLOB '*[^A-Za-z0-9._-]*'),
  dir_rel        TEXT NOT NULL CHECK (${PLANNING_REL('dir_rel')}),
  id_date        TEXT CHECK (id_date IS NULL OR id_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  id_offset_min  INTEGER CHECK (id_offset_min IS NULL OR id_offset_min BETWEEN -900 AND 900),
  first_seen_run INTEGER NOT NULL,
  last_seen_run  INTEGER NOT NULL,
  CHECK ((id_date IS NULL) = (id_offset_min IS NULL)),
  CHECK (unit_key = framework || ':' || repo_key || ':' || kind || ':' || native_id)
) STRICT;

CREATE INDEX IF NOT EXISTS unit_obs_repo_idx ON unit_obs (repo_key);

CREATE TABLE IF NOT EXISTS unit_artifact (
  unit_key        TEXT NOT NULL REFERENCES unit_obs (unit_key),
  rel_path        TEXT NOT NULL CHECK (${PLANNING_REL('rel_path')}),
  role            TEXT NOT NULL CHECK (role IN ('plan', 'summary', 'context', 'verification', 'review', 'windows',
                                                'rigor-tier', 'probes-skipped', 'probe', 'refute-pass')),
  mtime_ms        INTEGER,
  first_mtime_ms  INTEGER,
  first_commit_ms INTEGER,
  tier_letter     TEXT CHECK (tier_letter IS NULL OR tier_letter IN ('A', 'B', 'C')),
  tier_place      TEXT CHECK (tier_place IS NULL OR tier_place IN ('frontmatter', 'tier-line', 'probes-line')),
  first_seen_run  INTEGER NOT NULL,
  last_seen_run   INTEGER NOT NULL,
  PRIMARY KEY (unit_key, rel_path),
  CHECK ((tier_letter IS NULL) = (tier_place IS NULL))
) STRICT;
`;

// Plan 02-04. ref_dir: `~`, `~win` or `~other` with optional segments, or an absolute posix path, made of letters,
// digits, `.`, `_`, `/`, `~` and `-`, with no `..` and no empty segment. rel_path: `.planning/quick/...` or
// `.planning/phases/...`, at most 512 characters of letters, digits, `.`, `_`, `/` and `-`, with no `..` and no empty
// segment; ref_kind follows its prefix.
const TRANSCRIPT_REFS = `
CREATE TABLE IF NOT EXISTS cc_message_ref (
  session_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  message_id TEXT NOT NULL,
  ref_dir    TEXT NOT NULL CHECK (length(ref_dir) BETWEEN 1 AND 1024
               AND (ref_dir IN ('~', '~win', '~other') OR ref_dir GLOB '~/?*' OR ref_dir GLOB '~win/?*'
                    OR ref_dir GLOB '~other/?*' OR ref_dir GLOB '/?*')
               AND ref_dir NOT GLOB '*[^A-Za-z0-9._/~-]*'
               AND instr(ref_dir, '..') = 0 AND instr(ref_dir, '//') = 0 AND ref_dir NOT GLOB '*/'),
  rel_path   TEXT NOT NULL CHECK ((rel_path GLOB '.planning/quick/?*' OR rel_path GLOB '.planning/phases/?*')
               AND length(rel_path) <= 512
               AND rel_path NOT GLOB '*[^A-Za-z0-9._/-]*'
               AND instr(rel_path, '..') = 0 AND instr(rel_path, '//') = 0 AND rel_path NOT GLOB '*/'),
  ref_kind   TEXT NOT NULL CHECK (ref_kind IN ('quick', 'phase')),
  tool_name  TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128 AND tool_name NOT GLOB '*[^A-Za-z0-9._:-]*'),
  n          INTEGER NOT NULL CHECK (n >= 1),
  PRIMARY KEY (session_id, agent_id, message_id, ref_dir, rel_path),
  FOREIGN KEY (session_id, agent_id, message_id) REFERENCES cc_message (session_id, agent_id, message_id),
  CHECK ((ref_kind = 'quick' AND rel_path GLOB '.planning/quick/*')
      OR (ref_kind = 'phase' AND rel_path GLOB '.planning/phases/*'))
) STRICT;

CREATE INDEX IF NOT EXISTS cc_message_ref_dir_idx ON cc_message_ref (ref_dir);
`;

// Plan 02-04. command_name: 1 to 64 letters, digits, `:`, `_`, `.` and `-` (the COMMAND_NAME_RE group); ts_utc NULL
// or the UTC timestamp shape of cc_message.ts_utc.
const TRANSCRIPT_COMMANDS = `
CREATE TABLE IF NOT EXISTS cc_command (
  session_id   TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
  agent_id     TEXT NOT NULL CHECK (length(agent_id) <= 128),
  uuid         TEXT NOT NULL CHECK (length(uuid) BETWEEN 1 AND 128),
  ts_utc       TEXT CHECK (ts_utc IS NULL OR ts_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  command_name TEXT NOT NULL CHECK (length(command_name) BETWEEN 1 AND 64 AND command_name NOT GLOB '*[^A-Za-z0-9:_.-]*'),
  PRIMARY KEY (session_id, agent_id, uuid)
) STRICT;

CREATE INDEX IF NOT EXISTS cc_command_name_idx ON cc_command (command_name);
`;

// Plan 02-04, D-15: the one-time reread of every transcript session and subagent file still on disk (the 006 head_hash
// statement). Re-running it (the 005 and 006 rewind tests migrate through the whole list again) only sets NULL again.
const TRANSCRIPT_REREAD = `
UPDATE source_file SET head_hash = NULL
WHERE kind IN ('session', 'subagent')
  AND root_id IN (SELECT root_id FROM source_root WHERE source = 'transcript');
`;

// Plan 02-04 (D-16 with amendment Q3). The sha columns hold 40 or 64 lower-case hex characters; hook_events is a JSON
// object; a version and its source, and the hooks hash and the event counts, are both NULL or both set. The model
// bound, 118, is the longest value the setting shape admits (1 + 99 + a bracket suffix of up to 18).
const HEX_SHA = (col) => `${col} IS NULL OR (length(${col}) IN (40, 64) AND ${col} NOT GLOB '*[^0-9a-f]*')`;
const ENV_SNAPSHOT = `
CREATE TABLE IF NOT EXISTS env_snapshot (
  run_id             INTEGER PRIMARY KEY REFERENCES ingest_run (run_id),
  taken_utc          TEXT NOT NULL CHECK (taken_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  gsd_version        TEXT CHECK (gsd_version IS NULL OR length(gsd_version) BETWEEN 1 AND 32),
  gsd_version_source TEXT CHECK (gsd_version_source IS NULL OR gsd_version_source IN ('version-file', 'manifest')),
  base_sha           TEXT CHECK (${HEX_SHA('base_sha')}),
  local_mods_head    TEXT CHECK (${HEX_SHA('local_mods_head')}),
  hooks_sha          TEXT CHECK (hooks_sha IS NULL OR (length(hooks_sha) = 64 AND hooks_sha NOT GLOB '*[^0-9a-f]*')),
  hook_events        TEXT CHECK (hook_events IS NULL
                       OR CASE WHEN json_valid(hook_events) THEN json_type(hook_events) = 'object' ELSE 0 END),
  model_default      TEXT CHECK (model_default IS NULL OR length(model_default) BETWEEN 1 AND 118),
  advisor_model      TEXT CHECK (advisor_model IS NULL OR length(advisor_model) BETWEEN 1 AND 118),
  CHECK ((gsd_version IS NULL) = (gsd_version_source IS NULL)),
  CHECK ((hooks_sha IS NULL) = (hook_events IS NULL))
) STRICT;
`;

// Plan 02-05. A fact path: 1 to 512 characters, no leading `/`, no `..` segment (the whole value, or `../`, `/../` and
// `/..` at either end), no control character. A sha: 40 or 64 lower-case hex characters. A module dir is the same shape
// but may be empty (a root file's dir).
const FACT_PATH = (col, min) => `length(${col}) BETWEEN ${min} AND 512 AND ${col} NOT GLOB '/*' AND ${col} <> '..'
               AND ${col} NOT GLOB '../*' AND ${col} NOT GLOB '*/../*' AND ${col} NOT GLOB '*/..'
               AND ${col} NOT GLOB '*[\x01-\x1f]*'`;
const FACT_SHA = (col) => `length(${col}) IN (40, 64) AND ${col} NOT GLOB '*[^0-9a-f]*'`;
const COUNT = (col) => `${col} IS NULL OR ${col} >= 0`;
const UNIT_FACTS = `
CREATE TABLE IF NOT EXISTS unit_path (
  unit_key       TEXT NOT NULL REFERENCES unit_obs (unit_key),
  rel_path       TEXT NOT NULL CHECK (${FACT_PATH('rel_path', 1)}),
  path_source    TEXT NOT NULL CHECK (path_source = 'files_modified'),
  first_seen_run INTEGER NOT NULL,
  PRIMARY KEY (unit_key, rel_path)
) STRICT;

CREATE TABLE IF NOT EXISTS unit_commit (
  unit_key       TEXT NOT NULL REFERENCES unit_obs (unit_key),
  sha            TEXT NOT NULL CHECK (${FACT_SHA('sha')}),
  author_ms      INTEGER NOT NULL,
  files          INTEGER NOT NULL CHECK (files >= 0),
  added          INTEGER CHECK (${COUNT('added')}),
  deleted        INTEGER CHECK (${COUNT('deleted')}),
  touches_code   INTEGER NOT NULL CHECK (touches_code IN (0, 1)),
  first_seen_run INTEGER NOT NULL,
  last_seen_run  INTEGER NOT NULL,
  PRIMARY KEY (unit_key, sha)
) STRICT;

CREATE TABLE IF NOT EXISTS unit_commit_file (
  unit_key TEXT NOT NULL,
  sha      TEXT NOT NULL,
  rel_path TEXT NOT NULL CHECK (${FACT_PATH('rel_path', 1)}),
  status   TEXT NOT NULL CHECK (status IN ('A', 'M', 'D')),
  added    INTEGER CHECK (${COUNT('added')}),
  deleted  INTEGER CHECK (${COUNT('deleted')}),
  PRIMARY KEY (unit_key, sha, rel_path),
  FOREIGN KEY (unit_key, sha) REFERENCES unit_commit (unit_key, sha)
) STRICT;

CREATE TABLE IF NOT EXISTS unit_module_dir (
  unit_key       TEXT NOT NULL REFERENCES unit_obs (unit_key),
  module_dir     TEXT NOT NULL CHECK (${FACT_PATH('module_dir', 0)}),
  existed        INTEGER CHECK (existed IS NULL OR existed IN (0, 1)),
  first_seen_run INTEGER NOT NULL,
  PRIMARY KEY (unit_key, module_dir)
) STRICT;

CREATE TABLE IF NOT EXISTS unit_git_scan (
  unit_key    TEXT NOT NULL PRIMARY KEY REFERENCES unit_obs (unit_key),
  refs_sha    TEXT NOT NULL CHECK (length(refs_sha) = 64 AND refs_sha NOT GLOB '*[^0-9a-f]*'),
  commits     INTEGER NOT NULL CHECK (commits >= 0),
  scanned_run INTEGER NOT NULL
) STRICT;
`;

// Plan 02-05. fm_date is NULL or YYYY-MM-DD; fm_offset_min is NULL exactly when fm_date is (the 02-02 id_offset_min
// bound).
const ARTIFACT_TIMES = `
CREATE TABLE IF NOT EXISTS unit_artifact_time (
  unit_key       TEXT NOT NULL,
  rel_path       TEXT NOT NULL,
  tier_commit_ms INTEGER,
  last_commit_ms INTEGER,
  fm_date        TEXT CHECK (fm_date IS NULL OR fm_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  fm_offset_min  INTEGER CHECK (fm_offset_min IS NULL OR fm_offset_min BETWEEN -900 AND 900),
  PRIMARY KEY (unit_key, rel_path),
  FOREIGN KEY (unit_key, rel_path) REFERENCES unit_artifact (unit_key, rel_path),
  CHECK ((fm_date IS NULL) = (fm_offset_min IS NULL))
) STRICT;
`;

export const SECTIONS = Object.freeze([
  Object.freeze({ id: 'repos', plan: '02-02', sql: REPOS }),
  Object.freeze({ id: 'units', plan: '02-02', sql: UNITS }),
  Object.freeze({ id: 'transcript-refs', plan: '02-04', sql: TRANSCRIPT_REFS }),
  Object.freeze({ id: 'transcript-commands', plan: '02-04', sql: TRANSCRIPT_COMMANDS }),
  Object.freeze({ id: 'transcript-reread', plan: '02-04', sql: TRANSCRIPT_REREAD }),
  Object.freeze({ id: 'env-snapshot', plan: '02-04', sql: ENV_SNAPSHOT }),
  Object.freeze({ id: 'unit-facts', plan: '02-05', sql: UNIT_FACTS }),
  Object.freeze({ id: 'artifact-times', plan: '02-05', sql: ARTIFACT_TIMES }),
]);

export const sql = SECTIONS.map((s) => s.sql).join('\n');
