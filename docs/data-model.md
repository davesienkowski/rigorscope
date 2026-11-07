# Data model

rigorscope keeps two SQLite files under `~/.rigorscope/` (directory mode 0700, files mode 0600). All access goes through one
module, `src/db.mjs`. Every table is STRICT, and a missing value is NULL, never 0. This page names every table and column of both
files. Both are ordinary SQLite files that any SQLite tool can read; see the end of the page.

## store.db

The durable store and the source of truth, because sources age out. It is never rebuilt from sources. It uses WAL mode with a busy
timeout. The schema version is `PRAGMA user_version`, changed only by numbered, forward-only migrations in
`src/store/migrations/` (one file per version, contiguous from 1; each runs in its own transaction on an existing store, and a fresh
store gets all of them in one). A store whose version is newer than the running rigorscope is refused and nothing is written.

Pending migrations are opt-in on an existing store:

- A fresh store (no `store.db` yet) gets every migration on its first open.
- An existing store with a pending migration is refused before any write by every read-write open (`ingest`, and the `derived.db`
  rebuild that `cost`, `evidence` and `doctor` run when it is stale): one stderr line, exit 1. `doctor` still exits 0 and reports
  `migration_pending`. `rigorscope migrate --apply` takes the ingest lock, takes a backup with the same code as
  `scripts/backup-store.mjs`, verifies it against its manifest, and only then applies the migrations.
- A newer store stays refused, also by `migrate`.

### Run log

- `ingest_run`: one row per `ingest` run that took the lock. `run_id` (primary key), `started_utc`, `ended_utc` (NULL if the run died
  without recording), `trigger` (currently always `manual`), the run summary counts `files`, `lines_read`, `assistant_lines`,
  `rows_upserted` and `unparseable`, `status` (`running`, `ok`, or `failed`, which includes a stop by SIGTERM or SIGINT), `roots`,
  `unknown_token_bearing` (records with token keys and a type the reader does not know; reported, never fatal), `lock_wait_ms`
  (currently always 0: a held lock skips the run) and `error_code` (a short code, never a message).
- `ingest_source_run`: one row per (`run_id`, `source`): `files`, `files_new`, `files_reread`, `files_unchanged`, `files_skipped`,
  `bytes_read`, `lines_read`, `assistant_parsed`, `rows_upserted`, `unparseable`, `oversized`, `unknown_token_bearing`,
  `deferred_token_bearing`, `pending_tail_bytes` (bytes after the last newline, waiting for it) and `newest_record_utc`.
- `ingest_count`: name-keyed counters, primary key (`run_id`, `source`, `kind`, `name`), with `n` the count. `kind` is one of
  `skipped_type`, `dropped`, `rejected_field`, `unknown_token`, `deferred_token`, `walk_skip`, `meta_skip`, `reread`, `oversized`,
  `iterations_truncated` and `capture`. `name` is a record type, a drop reason, a column name or a skip reason, never file content.
- `unknown_attr`: names of keys the reader does not know, never their values: (`source`, `scope`, `name`) with `first_run_id`,
  `last_run_id` and `last_run_n`. `scope` is `line`, `message`, `usage` or `meta` for transcripts. A name that fails the shape check is
  recorded as `?`.

Natural-key tables (everything below, except the run log) are idempotent: a re-ingest of the same bytes adds no row. Only the run-log
tables grow on a re-ingest.

### Sources and files

- `source_root`: where a record came from, without any absolute path. `root_id`, `source`, `alias` (positional: `claude`,
  `claude-contrib`, `env`, `win`, `win-2`, `extra-1`), `kind`, `display` (a fixed token such as a tilde path), `first_seen_run`,
  `last_seen_run`. Unique on (`source`, `alias`).
- `source_file`: `file_id`, `root_id`, `rel_path` (the project directory segment home-normalized, then the path below it), `kind`
  (`session`, `subagent` or `meta`), and the cursor: `dev` and `ino` (text, kept exact), `size`, `mtime_ms`, `offset` (the end of the
  last complete line), `head_hash`, `tail_hash`, `state` (`reading` part-way, `ok` when done), `first_record_utc`, `last_record_utc`,
  `last_seen_run` and `last_read_run`. Unique on (`root_id`, `rel_path`).

### Transcript tables

- `cc_message`: one row per assistant message occurrence, primary key (`session_id`, `agent_id`, `message_id`); `agent_id` is the empty
  string for a main-thread line. A message that appears on several lines or in several files is one row: each integer column keeps the
  largest value seen (field-wise maximum, never a sum) and each text column keeps the first non-NULL value; `ts_utc` keeps the
  earliest line time. Columns: `request_id`, `ts_utc`, `model`, `attribution_agent`, `effort`, `version` (the Claude Code version),
  `uuid`; tokens `input_tokens`, `output_tokens`, `cache_read`, `cache_creation`, `cache_5m`, `cache_1h` (NULL or a non-negative
  integer); labels `speed`, `service_tier`, `inference_geo`; and `is_sidechain`, `attribution_skill`, `per_turn_effort`,
  `advisor_model`, `requested_model`, `entrypoint`, `cwd` (home-normalized), `has_iterations` (0 or 1) and `has_server_tool_use`, a
  tri-state: 1 when a readable member of `usage.server_tool_use` is above 0, 0 when the key is absent or every member is readable and 0,
  NULL otherwise. NULL means unknown, never 0. There is deliberately no absolute path, content or identity column; every column has an
  entry in the allowlist in [sources](sources.md), and a test asserts the two sets are equal.
- `cc_message_file`: which files a message was seen in: `session_id`, `agent_id`, `message_id`, `file_id`.
- `cc_message_iter`: `usage.iterations` entries, one row per index: the message key plus `iter_seq`, `iter_type` (`message`,
  `advisor_message`, ...), `model`, `input_tokens`, `output_tokens`, `cache_read`, `cache_creation`, `cache_5m`, `cache_1h`. At most
  16 entries are kept per message; the overflow is counted in `ingest_count`.
- `cc_agent_meta`: one row per sub-agent, from its meta file: `session_id`, `agent_id`, `agent_type`, `spawn_depth`, `model`,
  `tool_use_id`, `parent_agent_id`, `is_fork`, `workflow_phase`, `finished`, `spawned_with_worktree`, `stopped_by_user`,
  `launched_with_defaults`, `request_non_interactive` (flags are 0 or 1) and `file_id`. The task description and the worktree path and
  branch are never stored.
- `cc_message_ref`: planning-file references of a message: the message key plus `ref_dir` (a home-normalized directory), `rel_path`,
  `ref_kind` (`quick` or `phase`), `tool_name` (when several entries of the message named the same path, the bytewise-smallest name) and `n`
  (the largest number of tool_use fields in one line that named the path). Structured tool paths only; never a shell
  command or a search pattern.
- `cc_command`: slash-command lines: `session_id`, `agent_id`, `uuid`, `ts_utc` and `command_name`. Arguments are never stored.

#### Known and unknown refs and commands

The refs and commands of a (session, agent) scope are known when at least one `cc_message_file` row of the scope's messages points at a
`source_file` row with `head_hash IS NOT NULL AND state = 'ok'`, that is, a file whose last pass read it to the end; otherwise they
are unknown, never zero. A scope whose files aged out before the reread has no ref rows because it was never reread, not because it
named no planning file. `head_hash` alone is not enough: the ingest commits a file in chunks and each chunk writes a non-NULL
`head_hash` with `state` `reading`; only the last chunk sets `ok`. A reread interrupted after its first chunk leaves the scope
unknown until a run finishes the file.

### Environment and usage

- `env_snapshot`: one row per ingest run: `run_id`, `taken_utc`, `gsd_version`, `gsd_version_source`, `base_sha`, `local_mods_head`,
  `hooks_sha`, `hook_events`, `model_default`, `advisor_model`. A value is NULL when its source is absent. No hook command is stored.
- `usage_snapshot`: one row per distinct (`source`, `fetched_at_ms`): `snapshot_id` (surrogate key), `source` (`claude-json-cache` or
  `transcript`), `label` (`measured` for the cache, `transcript` for a report line), `fetched_at_ms`, `fetched_utc`, `first_run_id`
  and, for each window, a utilization and a reset instant: `five_hour_pct`, `five_hour_resets_ms`, `seven_day_pct`,
  `seven_day_resets_ms`, `seven_day_opus_pct`, `seven_day_opus_resets_ms`, `seven_day_sonnet_pct`, `seven_day_sonnet_resets_ms`. A
  percentage is NULL exactly when its instant is NULL. No account, token, session or path column.
- `usage_limit`: limit entries of a snapshot, keyed by (`snapshot_id`, `seq`): `kind`, `grp`, `percent`, `resets_ms`, `severity`
  (transcript reports only) and `is_active`.

### Units and the ledger

- `unit_obs`: one row per unit key as observed: `unit_key`, `framework`, `repo_key`, `kind`, `native_id`, `dir_rel` (the first
  directory seen), `id_date`, `id_offset_min`, `first_seen_run`, `last_seen_run`.
- `repo`: `repo_key` (the home-normalized git directory), `repo_name`, `first_seen_run`, `last_seen_run`, `last_scanned_run`.
- `dir_repo`: working directory to repository: `dir`, `repo_key`, `method` (`git` or `none`), `is_worktree`, `resolved_run`.
- `unit_artifact`: the planning files of a unit by role: `unit_key`, `rel_path`, `role`, `mtime_ms`, `first_mtime_ms`,
  `first_commit_ms`, `tier_letter`, `tier_place`, `first_seen_run`, `last_seen_run`. `unit_artifact_time`: `unit_key`, `rel_path`,
  `tier_commit_ms`, `last_commit_ms`, `fm_date`, `fm_offset_min`.
- `unit_path`: a unit's touched paths (`unit_key`, `rel_path`, `path_source`, `first_seen_run`). `unit_commit`: commits that name the
  unit in their scope (`unit_key`, `sha`, `author_ms`, `files`, `added`, `deleted`, `touches_code`, `first_seen_run`, `last_seen_run`);
  `unit_commit_file`: per-file status of a commit (`unit_key`, `sha`, `rel_path`, `status`, `added`, `deleted`). No subject, author name
  or email is stored.
- `unit_git_scan`: the latest complete git scan of a unit: `unit_key`, `refs_sha`, `commits`, `scanned_run`. `unit_module_dir`: whether
  a module directory existed before the unit's oldest commit (`unit_key`, `module_dir`, `existed`, `first_seen_run`).
- `ledger_line`: one row per forward-ledger line, keyed by `line_id`: `line_sha`, `v`, `record`, `ts_utc`, `unit_key`, `framework`,
  `repo_key`, `kind`, `native_id`, `tier`, `tier_source`, `command_name`, `runtime`, `session_id`, `model_hint`, `start_utc`, `end_utc`,
  `status`, `gsd_version`, `first_seen_run`.

## derived.db

Disposable: it is rebuilt on demand from `store.db` and never migrated. Deleting it loses nothing; the next `cost` builds it again. Its
tables are defined in `src/derive/schema.mjs`, and the constant `PASS_VERSION` there is raised whenever a table or a derivation rule
changes, which makes every older file stale. `cost` rebuilds, for a named reason, only when `derived.db` is missing, unreadable, built
by other rules or another owner rule, or when the store version, the store fingerprint or the sha of the price table or the risk-rule
table differs. Otherwise both files are opened read-only and a second `cost` leaves `derived.db` byte-identical. The rebuild writes a
temporary file in one transaction (with `store.db` attached read-only) and renames it into place, so a reader never sees a partial file.

### Calls and parts

- `api_call`: one row per deduplicated call, one message id of `cc_message` whichever session and agent ids it was stored under.
  `call_key` (`m:` plus the message id, primary key), `message_id`, `owner_session_id` and `owner_agent_id` (the copy chosen by the
  owner rule), `occurrences`, `request_id`, `ts_utc`, `model`, `effort`, `effort_source`, `ts_ms`, `role` with `role_rule` (`attribution`,
  `meta`, `main` or `none`), `role_source`, `role_meta` and `role_conflict`, `join_state` (`transcript_only`, `joined` or `otel_only`),
  `price_basis` (`iterations` or `top_level_only`), `iter_mismatch`, `iter_unknown_type`, `token_label`, `speed`, `service_tier`,
  `inference_geo`, `server_tool_use`, `cost_nano` (integer nano-dollars; NULL when any part is NULL), `cost_floor`, `cost_label`,
  `section` (`main`, `otel` or `harness`), `qs`, `qs_role`, `qs_conflict`, `otel_agent_name`, `xcheck`, and the repository columns
  `repo`, `repo_key` and `repo_rule`.
- `api_call_part`: the tokens; every token figure of a report is a sum over parts. `call_key` and `part_seq` (part 0 is the executor
  part; advisor parts are numbered from 1), `kind` (`message` or `advisor`), `model`, the six token columns, `price_model`,
  `price_status` (`priced`, `unpriced_model`, `unknown_tokens`, `unknown_modifier` or `no_table`), `price_tier` (`standard`,
  `long_prompt` or `fast`), `geo_us`, `cost_nano`, `cost_floor`, `floor_reason` and `price_version`. CHECK constraints tie the price
  columns: a part has a cost and a tier exactly when it is `priced`.
- `derive_state`: exactly one row (`id` is 1): `built_utc`, `pass_version`, `store_user_version`, `store_fingerprint`, `owner_rule`,
  `newest_record_utc`, `last_run_end_utc`, the counters `api_call_rows`, `api_call_part_rows`, `duplicate_occurrences`,
  `synthetic_skipped`, `top_level_only_calls`, `iter_mismatch_calls`, `iter_unknown_type_calls`, `role_conflict_calls`,
  `cache_split_mismatch_parts`; the store totals (known sum and known count of each token class) `store_input_tokens_sum`,
  `store_input_tokens_known`, `store_output_tokens_sum`, `store_output_tokens_known`, `store_cache_read_sum`, `store_cache_read_known`,
  `store_cache_creation_sum`, `store_cache_creation_known`, `store_cache_5m_sum`, `store_cache_5m_known`, `store_cache_1h_sum`,
  `store_cache_1h_known`; the price table `price_file`, `price_date_read` and `price_sha`; `window_weights`, `usage_snapshots`; the
  risk table `risk_rules_file`, `risk_rules_version`, `risk_rules_sha`; and the unit and link counters `units_n`, `units_end_clamped`,
  `link_scopes`, `link_scopes_refs_unknown`, `link_refs`, `link_refs_unmatched`, `link_refs_ambiguous`, `link_dir_name`,
  `link_phase_dropped`, `link_slash_ambiguous`, `link_lowered`, `link_units_no_interval`, `link_shared_end_units` and
  `repo_fallback_calls`.

### The derivation pass

- Dedup and the owner rule: a message id can be stored under several (session, agent) keys. The pass keeps one call per message id; its
  token columns are the field-wise maximum over all copies, so the choice of owner never changes a total. Copies whose model is
  `<synthetic>` are skipped and counted. The owner is the first copy by earliest `ts_utc`, then the earliest file record, the root
  alias, the file path, the session id and the agent id.
- Parts: part 0 always carries the call's top-level token fields at the call's model. When the call recorded iterations, each distinct
  `advisor_message` model adds one advisor part. An iteration of another type adds no part and sets `iter_unknown_type`.
- Role precedence: the line's attribution agent (rule `attribution`); else the agent type of the owner's sub-agent meta file (rule
  `meta`); else `main` for a main-thread line; else `unknown` (rule `none`). Names are compared byte-exactly.
- Conservation: for each token class, the sum over role groups, over model groups, over `api_call_part` and the store total in
  `derive_state` must agree by known sum and known count. The `cost` footer prints the result. Cost conservation does the same for
  `cost_nano`. No NULL is turned into 0.

### Pricing

The price file is `data/prices-YYYY-MM-DD.json` (the newest in the directory, or `RIGORSCOPE_PRICES_DIR`). It holds the unit
(`usd_per_million_tokens`), the label `notional`, a modifier table and, per model id, rates for `input`, `output`, `cache_read`,
`cache_write_5m`, `cache_write_1h`, a `status` and an optional `fast` set. A model id is looked up after stripping one trailing
`-YYYYMMDD`. A cost is computed in integer nano-dollars. The cache-creation split decides the write rate:
tokens the split does not resolve are priced at the cheaper 5-minute rate and make the cost a floor. A call with a server tool, or an
unknown server-tool flag, is a floor. A model that is not a table row, a missing token count, or a modifier the table does not cover
makes the part unpriced and its dollars `?`. The file is refused with a fixed code when it is a symlink, oversized, not ASCII, bad
JSON or fails its schema.

### Window tables

- `window_interval`: one row per consecutive snapshot pair of a window, keyed (`win`, `seq`): `win` (`five_hour` or `seven_day`),
  `start_ms`, `end_ms`, `start_pct`, `end_pct`, `resets_ms`, `status` (`usable`, `reset`, `falling`, `flat`, `unknown_tokens`,
  `zero_weight`), `delta_micro`, `parts` and `weight_total`.
- `api_call_part_window`: `call_key`, `part_seq`, `win`, `interval_seq` and `share_micro`, a part's share in micro-points, set only in a
  usable interval. `usage_latest`: one row with the latest snapshot: `id`, `source`, `label`, `fetched_at_ms` and the four window
  percentage and reset columns.
- The estimator spreads a window's percentage change between two snapshots over the parts in between, weighting input, output,
  cache_read and cache_creation equally. It is an estimate (label `estimated`), not a claim about how the provider counts usage.

### OTel join tables

- `otel_call`: one row per OTel `api_request`: `request_key`, `request_id`, `session_id`, `ts_utc`, `model`, `query_source`, `effort`,
  `agent_name`, the token columns, `cost_nano` (the measured cost), `occurrences`, `conflicting`, `state`, `transcript_calls`,
  `derived_nano` and `derived_flag`.
- `join_stat`: named counters of the join (`name`, `n`). The join matches OTel requests to transcript calls on `request_id`; OTel never
  changes a transcript row, and OTel-only calls stay in their own section.

### Units, links and attribution

- `unit`: one row per unit, the merge of the observed unit and the ledger: `unit_key`, `framework`, `repo_key`, `repo`, `repo_name`,
  `kind`, `native_id`, `dir_rel`, `present`, `population`, `recorded_at_utc`, `start_ms`, `end_ms`, `date_source`, `end_source`,
  `branch`, `runtime`, the tier columns `tier_native`, `tier`, `tier_signal`, `tier_timing`, `tier_conflict`, `tier_comparable` and
  `tier_source`, `risk_class` with `risk_source`, `novelty` with `novelty_source`, `git_evidence`, the size columns `size_commits`,
  `size_files`, `size_added` and `size_deleted`, `commits_bounded`, `interval_trusted`, `status`, the ledger columns `ledger_lines`,
  `ledger_command`, `ledger_runtime`, `ledger_session_id`, `ledger_start_ms` and `ledger_end_ms`, the reconstruction columns
  `recon_tier`, `recon_start_ms`, `recon_end_ms`, `recon_date_source`, `recon_end_source` and `has_recon`, and `id_repeats` (the number
  of second directories for the unit's id in another location; NULL is unknown and 0 is scanned with none).
- `unit_role`: the artifact roles of a unit (`unit_key`, `role`, `n`). `repo_label`: `repo_key`, `repo_name`, `display`.
  `repo_scan_count`: the location counters of a repository's latest scan (`repo_key`, `kind`, `n`, `run_id`); a repository whose latest
  scan wrote the sentinel has one row per counter, a repository without it has no row and reads unknown.
- `link_scope`: one row per (session, agent) scope: `session_id`, `agent_id`, `calls`, `first_ms`, `last_ms`, `refs_known`, `worktree`,
  `subagent`, `repos`. `unit_link`: `session_id`, `agent_id`, `unit_key`, `method`, `confidence`, `base_confidence`, `lowered_by`, `match`,
  `phase_level`, `refs`, `write_refs`, `instants`, `first_ms`, `last_ms`.
- `scope_attribution`: the bucket of each scope per mode: `session_id`, `agent_id`, `link_confidence`, `bucket`, `reason`, `unit_key`,
  `counted_units`, `refs_known`. `unit_attribution`: `unit_key`, `link_confidence`, `scopes`, `sessions`, `subagent_scopes`, `calls`,
  `refs_unknown_scopes`. `unit_confounder`: `unit_key`, `link_confidence`, `name`, `role`, `value`, `unknown_calls`, `source`, `label`.

## Source labels

Every number a report shows carries one of seven labels, which say where the number came from:

- `measured`: read directly from a measuring source (the usage cache header).
- `otel`: read from an OpenTelemetry file.
- `transcript`: read from a Claude Code transcript (tokens).
- `derived`: computed from other stored values by a stated rule (notional dollars).
- `estimated`: an estimate, not a measurement (the window shares).
- `reconstructed`: rebuilt after the fact from several records (units, tiers, repositories).
- `unavailable`: not known. The value is NULL.

## Measure

A report number is a Measure (`src/measure/measure.mjs`): `value` (a finite number, or NULL for unknown), `n` (how many members the
value covers), `label` (one of the seven labels), `coverage` (known members over `n` for a partial aggregate) and `evidence` (the row
key). A NULL value forces the label `unavailable`; a known value cannot carry `unavailable`; an aggregate with any unknown member is
unknown with a coverage fraction; an aggregate over no members is unknown with `n` 0, never 0. Labels are constants and are never taken
from file content.

## OTel tables (migration 003)

Three STRICT tables in `store.db` hold the OTel source (see [sources](sources.md)). They hold no identity, content or path column.
`source_root` rows of source `otel` have the alias `live` or `preserve` and the same value in `kind`.

- `otel_event`: one row per event, keyed on `session_id`, `event_seq` (an integer, never negative), `event_ts` (the `event.timestamp`
  header) and `kind` (the top-level event name). Other columns: `ts_utc` (the line timestamp), `prompt_id`, `request_id`,
  `tool_use_id` (copied from kept attributes when present), `cc_version` (from the resource `service.version`), `attrs` (the allowlisted,
  shape-checked attributes as canonical JSON text with sorted keys, `{}` for header-only and unknown kinds), `attrs_sha` (its sha256),
  and the first-seen provenance `file_id` and `src_end_offset`, which are not part of the key.
- `otel_metric`: one row per metric line, keyed on `ts_utc`, `metric`, `attrs_sha` and `ordinal` (the number of earlier lines of the
  same file with the same three, so byte-identical lines stay separate rows), with `value` (a number, never NULL), `session_id`,
  `cc_version`, `attrs`, `file_id` and `src_end_offset`.
- `otel_metric_line`: provenance, one row per metric line of a file's last full pass, keyed by `file_id` and `src_end_offset`, with
  `ts_utc`, `metric` and `attrs_sha`. When a file is reread from offset 0 (for example after `preserve-scrub --apply` moved line
  offsets) its provenance rows are deleted in the first transaction of the reread.
- Names in the run log: `ingest_count` kind `dropped` uses `session_id`, `event_sequence`, `event_timestamp`, `event_name`, `ts`,
  `record_type`, `metric_name`, `value` and `key_conflict` (a key that exists with different content); `rejected_field` uses
  `<kind>.<key>`, `metric.<key>` and `header.event.name`; `unknown_token` uses `name|version`; `walk_skip` uses `name`, `symlink`,
  `not_regular`, `vanished` and `unreadable`. `unknown_attr` scopes for source `otel` are the event kind, `event_kind` (an unknown
  kind), `metric` (unknown metric attributes), `metric_name` (a name outside the known metrics) and `resource` (unknown resource keys).
- Attributes are JSON text, so `json_extract(attrs, '$."agent.name"')` reads them with the `sqlite3` command line. A sub-agent's total
  tokens live inside `attrs` only; no column or view sums them.

## Store migrations

1. `001-init`: the run log, the cursors and the source tables.
2. `002-transcript`: `cc_message`, `cc_message_file`, `cc_message_iter`, `cc_agent_meta`, `unknown_attr` and the extra message columns.
3. `003-otel`: the OTel tables above.
4. `004-usage`: `usage_snapshot` and `usage_limit`.
5. `005-otel-provenance-reread`: the OTel provenance columns and the reread rule.
6. `006-server-tool-use-flag`: the tri-state `has_server_tool_use`.
7. `007-reconstructed-units`: the unit, artifact, commit, path, repository, reference, command and environment tables.
8. `008-ledger-line`: `ledger_line`.

## Reading the databases with any SQLite tool

Open the files read-only so that nothing can change: `sqlite3 -readonly ~/.rigorscope/derived.db`. A second rigorscope process, the
`sqlite3` command line and a rebuild can run side by side: `store.db` is in WAL mode, so a reader sees the last committed state while an
ingest runs, and `derived.db` is replaced by rename. Tables use only features of SQLite 3.45. The blocks below are run by the test suite
against a synthetic home; the first line of each names the file it reads.

The last ingest run of each source:

```sql
-- db: store
SELECT sr.source, count(*) AS runs, max(r.ended_utc) AS last_end
  FROM ingest_source_run sr JOIN ingest_run r ON r.run_id = sr.run_id
 GROUP BY sr.source ORDER BY sr.source;
```

Tokens by role and model for the transcript calls (a call with advisor parts appears under each of its models):

```sql
-- db: derived
SELECT c.role, p.model, count(DISTINCT c.call_key) AS calls, sum(p.input_tokens) AS input, sum(p.output_tokens) AS output
  FROM api_call c JOIN api_call_part p ON p.call_key = c.call_key
 WHERE c.section = 'main'
 GROUP BY c.role, p.model ORDER BY c.role, p.model;
```

Calls per UTC day (the local-zone day of a report needs `--tz`):

```sql
-- db: derived
SELECT strftime('%Y-%m-%d', ts_ms / 1000, 'unixepoch') AS utc_day, count(*) AS calls
  FROM api_call WHERE ts_ms IS NOT NULL
 GROUP BY utc_day ORDER BY utc_day;
```

What the derived file was built from:

```sql
-- db: derived
SELECT pass_version, built_utc, api_call_rows, api_call_part_rows FROM derive_state;
```
