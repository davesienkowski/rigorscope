# Sources

rigorscope reads four sources: Claude Code session transcripts from every Claude configuration directory on the machine, the
OpenTelemetry (OTel) files of a local receiver if you run one, the subscription-window usage cache, and the forward ledger. After the
sources, every `ingest` runs two post-steps inside the same lock: the repository and planning-artifact step that reconstructs units
(`src/adapters/gsd-core/`), and the environment snapshot. A source is a directory `src/sources/NAME/` whose `index.mjs` exports `name`,
`freshness`, `discover`, `read`, `normalize` and `createWriter` (and optionally `cursorless`); the runner in `src/ingest/run.mjs` knows
nothing about any one source. A new source needs a migration for its tables, fixture cases under `test/fixtures/cases/`, and canary
plants and scenarios under `test/canary/`; a test proves no shared file is edited.

## Claude Code transcripts

### Roots

`ingest` with no flags discovers the configuration directories (a directory counts only if it has a `projects` directory), in alias order:

| Alias | Where | Shown as |
| --- | --- | --- |
| `claude` | the `.claude` directory in your home | `~/.claude` |
| `claude-contrib` | the `.claude-contrib` directory in your home | `~/.claude-contrib` |
| `env` | `CLAUDE_CONFIG_DIR` when it is set, non-empty and absolute | `$CLAUDE_CONFIG_DIR` |
| `win`, `win-2`, ... | each entry of the Windows users directory that has `.claude/projects`, in bytewise name order | `~win/.claude`, `~win-2/.claude` |

The Windows users directory defaults to the WSL mount of the Windows Users folder. On a machine without that mount the default is
absent and this is silent. On a WSL host the default means `ingest` also reads the Windows profile's transcripts. Set
`RIGORSCOPE_WINDOWS_USERS_DIR` to another directory, or to the empty string to switch Windows discovery off; a directory you name that
does not exist is reported as `skipped ~win reason=absent`. A different location is reached with `CLAUDE_CONFIG_DIR` or `--root`.
Aliases are positional and never contain a user name. Two roots that resolve to the same real directory are read once. A `backups`
directory inside a root and the `.claude-backup` directory in your home are never read. `--root DIR` replaces discovery.

### The walk

Only `projects/` of a root is read, decided by `lstat`; a symlink is never followed. `projects/PROJECT/SESSION.jsonl` is a session file;
`projects/PROJECT/SESSION/subagents/**/agent-ID.jsonl` (up to 8 directory levels) a sub-agent file; `agent-ID.meta.json` its meta file.
Skipped and counted by reason (`walk_skip`): `journal`, `name` (wrong shape), `symlink`, `depth`, `vanished` and `not_regular` (a file
that went away or is not regular between the walk and the read) and `unreadable` (a permission error). A skipped file's unflushed lines
are dropped and the run continues; it is not marked failed. Directories and files are visited in bytewise order, so the order never
depends on how directories were created.

### Cursors and incremental reads

Each file has a cursor in `source_file`: device and inode, size, mtime in milliseconds, the offset of the end of the last complete line,
and hashes of the first and last 4096 bytes before the offset. A run reads from the offset; only complete lines are consumed, so a
trailing partial line waits for its newline. A size below the offset, a changed device or inode, or a changed hash rereads the file from
0 (`truncated`, `replaced`, `rewritten`); the natural keys make that safe. A file whose run stopped part-way (`state` `reading`)
resumes from its offset. Rows and the cursor are written in one transaction per chunk of 20000 lines.

### Line classification

A line is classified from its raw bytes before parsing. A line with the assistant marker is a candidate and must then really have `type`
`assistant`. Other lines get their type from the head of the line or, when the head has none and the line carries a token key string, from
one parse that reads only the type and version.

- A known non-token type (`user`, `attachment`, `system`, `bridge-session`, ...) is skipped and counted by type (`skipped_type`).
  `cost-state` records that carry token keys are counted as deferred (`deferred_token_bearing`) and not stored.
- Any other typed record that carries token keys is an unknown token-bearing record: counted with its type and version, reported as a
  `WARNING:` on stderr, and the run still exits 0.
- A line above the size cap (32 MiB by default) is counted as oversized and never parsed; a candidate that cannot be parsed is
  `unparseable` (the parser message is never printed).
- Dropped assistant lines, by reason: `usage` (no `message.usage`), `session_id`, `message_id`, `agent_id` (present but invalid).
- A line that holds both `"usageReport"` and `"subtype":"local_command"` is a usage report line (see the usage section below).

### Home-prefix normalization

The OS user name rides in `cwd` and in the project directory name. Both are rewritten before storing: your own home becomes `~`, a
discovered Windows profile `~win`, and the home of any other user `~other`. A `cwd` that is not a string, holds a control character or is
longer than 1024 characters is stored as NULL. Residual: the mangled project directory name of another user's home cannot be told from
an ordinary name and is stored as it is.

### What is kept

Only the fields below are read, each by an explicit path. A value that fails its shape rule is stored as NULL and counted by column
name; its text is never stored. Counts must be non-negative whole numbers (nothing is converted from text).

| Source path | Column | Shape rule |
| --- | --- | --- |
| `sessionId` | `session_id` | id: 1 to 128 of letters, digits, `.`, `_`, `:`, `-`; required |
| `agentId` | `agent_id` | id; absent means the empty string (main thread); present but invalid drops the line |
| `message.id` | `message_id` | id; required |
| `requestId` | `request_id` | id |
| `timestamp` | `ts_utc` | ISO-8601 UTC, like 2026-10-27T12:00:01.000Z |
| `message.model` | `model` | model name, up to 100 characters, or the literal `<synthetic>` |
| `attributionAgent` | `attribution_agent` | name: starts with a letter or digit, up to 64 of letters, digits, `.`, `_`, `:`, `/`, `-` |
| `effort` | `effort` | label: starts with a letter or digit, up to 64 of letters, digits, `.`, `_`, `:`, `-` |
| `version` | `version` | label |
| `message.usage.input_tokens` | `input_tokens` | count |
| `message.usage.output_tokens` | `output_tokens` | count |
| `message.usage.cache_read_input_tokens` | `cache_read` | count |
| `message.usage.cache_creation_input_tokens` | `cache_creation` | count |
| `message.usage.cache_creation.ephemeral_5m_input_tokens` | `cache_5m` | count |
| `message.usage.cache_creation.ephemeral_1h_input_tokens` | `cache_1h` | count |
| `message.usage.speed` | `speed` | label |
| `message.usage.service_tier` | `service_tier` | label |
| `message.usage.inference_geo` | `inference_geo` | label |
| `uuid` | `uuid` | id |
| `isSidechain` | `is_sidechain` | boolean, stored as 1 or 0 |
| `attributionSkill` | `attribution_skill` | name |
| `perTurnEffort` | `per_turn_effort` | label |
| `advisorModel` | `advisor_model` | model name |
| `requestedModel` | `requested_model` | model name |
| `entrypoint` | `entrypoint` | label |
| `cwd` | `cwd` | text, home-normalized as above |
| `message.usage.iterations` | `has_iterations` | presence flag: 1 when a non-empty array, else 0 |
| `message.usage.server_tool_use` | `has_server_tool_use` | count flag: 1 when any readable member is above 0; 0 when the key is absent or every member is readable and 0; NULL otherwise: a non-object value, an empty object, or an unreadable member with no readable count above 0 (a readable member is a non-negative safe integer; an unreadable one may hide a real count, so it never yields 0) |

The same list is `ALLOWLIST` in `src/sources/transcript/normalize.mjs`, and a test checks that the stored columns of `cc_message` are
exactly these columns. Entries of `message.usage.iterations` are stored per index in `cc_message_iter` (at most 16 per message) from the
paths `type` (`iter_type`), `model`, `input_tokens`, `output_tokens`, `cache_read_input_tokens` (`cache_read`),
`cache_creation_input_tokens` (`cache_creation`) and the two `cache_creation.ephemeral_*` counts (`cache_5m`, `cache_1h`). A sub-agent
meta file is read with a 64 KiB cap, and only these keys are kept: `agentType` (`agent_type`), `spawnDepth`, `model`, `toolUseId`,
`parentAgentId`, `isFork`, `workflowPhase`, `finished`, `spawnedWithWorktree`, `stoppedByUser`, `launchedWithDefaults` and
`requestNonInteractive`. An empty, array-valued, non-JSON or over-cap meta file is skipped and counted (`meta_skip`).

### What is dropped

Everything else: message content (text, thinking, tool inputs and results), file paths, branch names, user and account fields,
attachments and every key not in the tables. The names, never the values, of keys the reader does not know are recorded in
`unknown_attr` with a scope; a name that fails the shape check, or beyond 200 distinct names per scope, is recorded as `?`.

## Repos and planning artifacts

Run by `ingest` after every source, inside the same lock (the `units:` line of [cli](cli.md#ingest)). The rules behind the derived values
are in [units](units.md).

The repository resolver reads the stored working directories (`cc_message.cwd`, home-normalized) that have no `dir_repo` row yet. For
each, one call of `git -C <dir> rev-parse --git-dir --git-common-dir` (with `GIT_OPTIONAL_LOCKS=0`, the repository-location variables
removed, a ceiling at the parent of HOME and a timeout), made on the directory or, when it is gone, on its nearest existing ancestor below
HOME. Nothing else is read from git here: no log, no branch, no commit, no config value. Kept: the realpath of the common directory,
home-normalized (the repository key), its name, and whether the directory was a linked worktree. A clean "not a repository" answer is
kept as `none`; a missing or old git, a failed start or a timeout keeps nothing and the directory is tried again on the next run.
`~win/...` and `~other/...` directories are never resolved.

The adapter then scans every known repository whose key ends in `/.git` (a session or a planning-file reference reached it, or
`RIGORSCOPE_REPO_ROOTS` names it): every live working tree reported by `git worktree list --porcelain`, the main tree first and at most 64.
A bare or prunable block, a path that is missing, a symlink or not a directory is skipped and counted in `trees_dropped=`. It reads
directory names only, and these files by role, from the file name alone:

| Role | Names |
| --- | --- |
| `plan` | `<id>-PLAN.md` |
| `summary` | `<id>-SUMMARY.md` |
| `context` | `<id>-CONTEXT.md`; for a phase plan also the phase-level `<phase>-CONTEXT.md` |
| `verification` | `<id>-VERIFICATION.md`; phase-level `<phase>-VERIFICATION.md` |
| `review` | `<id>-REVIEW.md`, `<id>-REVIEW-<n>.md`, `<id>-REVIEW-R<n>.md`; phase-level the same names after `<phase>-` |
| `windows` | `<id>-WINDOWS.md`; phase-level `<phase>-WINDOWS.md` |
| `rigor-tier` | `RIGOR-TIER.md`, `RIGOR-TIERS.txt` (quick tasks only) |
| `probes-skipped` | `<name>-PROBES-SKIPPED.md` (quick tasks only) |
| `probe` | `<id>-EDGE-REQS.json`, `<id>-EDGE-RESOLUTIONS.json`, `<id>-EDGES.json`, `<id>-PROHIBITIONS.json`, `<id>-UI-CONSIDERATIONS.json`, `<id>-PROBE-GATE.json` |
| `refute-pass` | `<id>-REFUTE.md`, `<id>-REFUTE-<n>.md`, `<id>-REFUTE-GATE.json`, `<id>-CLAIMS.json` |

`<id>` is the quick id or the plan id (`03-01`, `02.1-01`); `<phase>` is a plan id's phase part. A quick task owns the files of its quick
directory. A phase plan is a regular file `<id>-PLAN.md` in a phase directory whose name starts with the id's phase part and a dash; it
owns the files starting with its own id and a dash plus the phase-level files of its directory, which every plan of the directory
shares. Only four roles are ever opened, each through a bounded 65536-byte head read: the PLAN (the `tier:` letter and `files_modified:`
list of its frontmatter), the SUMMARY (the `tier:` letter and the top-level `completed:` date), and for a quick task the first rigor-tier
file (its `Tier:` line) and the first probes-skipped file (its first non-empty line). Every other artifact is `lstat`-ed for its
modification time only. A symlink in a unit directory is skipped and counted. No body text and no other frontmatter key is kept.

Git facts are stored at ingest, because the derive step runs no git. Every call runs through an args array with no shell, `-C <common dir>
-c core.quotepath=off -c core.fsmonitor=false`, `GIT_OPTIONAL_LOCKS=0`, a timeout and an output cap. `show-ref --head` gives the
repository's refs digest: a unit is scanned again only when the digest differs from the stored one, so a second ingest on unchanged refs
prints `facts=not_needed`. Logs over the planning directories give each file's oldest add commit, the commits changing a `tier:` line and
each file's last change time (a deletion or rename is not a change). An archived file is looked up through its former live path. Per unit,
one log finds the commits whose subject names the unit in its conventional-commit scope (tested in memory; the subject is never returned
or stored), then one `--numstat` log gives line counts. No commit subject, body, author or committer name or email is requested or
stored. A unit whose scan cannot finish (git missing or older than 2.31, a timeout, an output cap) gets no new row, is counted in
`facts_deferred=` and is retried next run.

Known limits: commit facts come only from commits whose scope names the unit id, so code commits that do not name it are missed by
timing, the risk fallback, novelty and unit size. Rows are never deleted, so a commit later rewritten or squashed stays next to its
replacement but stops counting. The refs digest comes from the common directory, so a new commit on a detached HEAD of another worktree is
seen only after some ref moves. A worktree removed before any ingest saw it, repositories no session, reference or configured root
reached, and parent directories of repositories are not scanned. Planning trees of a named project (`.planning/<project>/...`) are not
looked for, and workstream trees are only counted. The scheduled ingest sees `RIGORSCOPE_REPO_ROOTS` only if its service environment sets
it.

### Locations and counters

The roots read for units, in read order for one kind: the archive roots, oldest label first (digit runs compare by value, so `v1.2` before
`v1.10`), then the live root.

| Kind of unit | Archive root | Live root |
|--------------|--------------|-----------|
| phase plan | `.planning/milestones/<label>-phases/<dir>/` | `.planning/phases/<dir>/` |
| quick task | `.planning/milestones/<label>-quick/<dir>/` | `.planning/quick/<dir>/` |

`<label>` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. A phase directory is `<phase>-<slug>`, or `<CODE>-<phase>-<slug>` with a project code,
holding a numeric `<phase>-<plan>-PLAN.md`; the unit id is `<phase>-<plan>` and carries no code. Nothing is stored for the location of a
unit: its class (live, archive-phases, archive-quick) is computed from its stored directory.

What is not read is counted by name, never dropped silently. Per scanned repository and run the adapter writes `ingest_count` rows with
source `units`: `kind` is a counter name below, `name` the repository key (for `repeat_id`: the unit key) and `n` the distinct count; a
counter with no row is zero. Every scanned repository also gets a sentinel row, `trees_scanned`. A repository without the sentinel for its
latest run is unknown, never zero: the `locations:` line prints each counter summed over the repositories scanned in that run, and `?` for
every counter when none was.

| Counter | Counts |
|---------|--------|
| `units_archived` | units read from an archive root in this run: a unit first seen archived, and a moved unit (its stored `dir_rel` stays the first dir) |
| `repeat_id` | a second dir for an id in another location than the unit's chosen dir; never read or merged. It may be an id reused by `--reset-phase-numbers` or a dir renamed and archived later: not distinguishable |
| `moved` | units whose stored dir is gone from every working tree and whose single same-name archive dir was read in this run for the first time (a move already recorded by an earlier run counts 0; full rule in [units](units.md)(units.md)) |
| `move_ambiguous` | units whose stored dir is gone and that have two or more archive dirs of the stored dir's name: nothing is read for them, all those dirs stay `repeat_id` |
| `not_read_workstream_dir` | `.planning/workstreams/<ws>` dirs (they number independently of the main tree) |
| `not_read_workstream_plan_files` | PLAN-named files in `workstreams/<ws>/phases/<dir>/` |
| `not_read_bare_plan` | a bare `PLAN.md` (no `NN-MM` id) |
| `not_read_plan_id_1seg` | `NN-PLAN.md` or `N.N-PLAN.md` (one number) |
| `not_read_plan_id_3seg` | `NN-MM-KK-PLAN.md` (three numbers) |
| `not_read_plan_file_other` | any other file name ending `PLAN.md` |
| `not_read_plan_file_coded` | a plan file name that carries a project_code (`ABC-04-01-PLAN.md`); gsd-core is read as stripping the code, so a count above 0 means that reading is wrong |
| `not_read_bracket_phase_dir` | a phase dir whose prefix ends in `.` plus digits (`GSD.02-05-name`) |
| `not_read_custom_phase_dir` | a phases-root dir whose name starts with no phase part (`auth-setup`) |
| `not_read_quick_dir_name` | a quick-root dir whose name has no quick id, whether or not the name fits the shape below (`notes here`) |
| `not_read_milestones_other_dir` | a dir under `.planning/milestones/` that is no `<label>-phases` or `<label>-quick` root (including a label past 64 characters) |
| `trees_scanned` | the sentinel row only; not printed on the line |

Never followed: a symlinked `.planning/milestones`, archive root, workstream directory or phase directory, and a name outside
`[A-Za-z0-9._-]{1,128}` or holding `..`; each is counted in `skipped=`. Workstream listing is bounded: at most 256 workstream directories
per tree and 4096 names read, and at most 4096 paths kept per counter and tree.

### The gsd-core roster and artifact classes

The adapter recognizes the planning artifacts of stock gsd-core by file name and counts every file it does not know. The data is one file,
`src/adapters/gsd-core/roster.json`, read by the adapter and by the `doctor` drift check, so they cannot see different rosters. It
records the gsd-core `ref` (a full commit) it was taken from, the package `version` at that ref, the date it was `taken`, the roster
document it transcribes (`source`) and the `entries`; an entry has a name pattern, a `class`, closed-list `scopes`, a `cite` and a
`cite_path`.

Classes: `F` finding-bearing (holds findings, verdicts or their dispositions), `E` step evidence (its presence shows a pipeline step ran),
`S` state or scratch (recognized, not attributed to a unit as evidence), `O` outside the scanned planning locations (recorded so the gap
is explicit). Classification is by name only (no file is opened), once per file per repository, independent of the ten stored artifact
roles. A name is normalized by stripping, in this order and each only when its full shape matches: a leading quick id, then a leading
project code only when a phase or plan id follows, then a leading phase or plan id. The listings classified are the loose files in the
phases, quick and archive roots, the files directly in `.planning/milestones`, and the files of each read quick or phase directory
(not those of a bracket, custom or workstream directory, nor of a second directory counted `repeat_id` or `dup_ids`). A regular file that
passes the name checks and matches no entry is `unclassified`.

| Kind | Name | Counts |
|------|------|--------|
| `recognized_f` | repository key | files recognized as class `F` |
| `recognized_e` | repository key | files recognized as class `E` |
| `recognized_s` | repository key | files recognized as class `S` |
| `unclassified` | repository key | files in a classified listing that are in no roster entry |
| `unclassified_stem` | a stem | per run, the files of one stem (digit runs folded to `N`); at most 50 stems per run, most files first |
| `unclassified_stem_other` | `*` | per run, the files of every other stem, so the listed stems plus this row equal `unclassified` |

A stem is kept only when it matches `^[A-Za-z0-9._-]{1,64}$`, holds no `..` and neither the file name nor the stem holds the OS user name as
a word; only the stem is kept, never the full name, a path or file content. The count is worded "not in the roster at ref X", never as a
share, rate or score: the roster is a snapshot, and a machine with locally named artifacts shows them as unclassified, which is the
intended signal.

Drift: `doctor` compares the roster with an available gsd-core copy. With `RIGORSCOPE_GSD_CORE_CHECKOUT` set to an absolute directory it
runs `git diff --no-renames --name-only <roster ref> HEAD` over the cited paths there (read only, an args array, a timeout). Otherwise it
compares the installed version recorded by the latest environment snapshot with the roster version. Otherwise the drift is unknown, with
the reason. An unknown drift is a value of the section, never a finding; a seen drift is the lead `roster_drift` ([cli](cli.md#doctor)).

### Planning-file references

For every kept assistant line, the extractor reads the first 64 entries of `message.content`; for each `tool_use` entry it reads the
`name` and the own string properties `file_path`, `path`, `notebook_path` and, for `Glob` only, `pattern`. Nothing else is read: not a
shell command, not written content, not a search pattern of another tool, not any text, thinking or result block. A planning path inside a
shell command string is never a ref. A value becomes a ref only when it names the quick or phases planning directory at a split point (the
start of the value or right after a `/`), is at most 4096 characters with no control character, has an absolute prefix that
home-normalizes (or is relative and joined to its anchor: the Glob's own `path`, else the line's normalized cwd), and every directory
segment matches `[A-Za-z0-9._-]{1,128}`. Refs of one line with the same directory and path merge; at most 16 are kept per line. Rejections
are counted by reason (`ref_shape`, `ref_unanchored`, `ref_short`, `ref_tool_name`, `refs_truncated`) in `ingest_count` kind `capture`,
never with a value. The rows go to `cc_message_ref`; each ref directory feeds the repository resolver, so a repository reached only
through a ref is resolved and its units are found.

### Slash-command names

A user line holding the bytes `<command-name>` goes to the command name picker, which reads `message.content` (a string or only `text`
blocks), the `<command-name>` tag at the start of that text (after optional whitespace and at most one `<command-message>` element), the
`sessionId`, `uuid`, `agentId` and `timestamp`. The name is kept without its slash. A well-formed tag after prose is counted
`command_unanchored`, a missing one `command_no_name`, a line holding a result block is never a command. Never read or kept: the
`<command-args>` text, the `<command-message>` text, any other text of the line, and the branch. The rows go to `cc_command`.

## Environment snapshot

Every `ingest` run that holds the lock takes one snapshot after the sources and before the unit step and stores it in `env_snapshot`
(the `env:` line of [cli](cli.md#ingest)). Every input is optional: an absent file, a file that is not regular or is above its size cap,
unparseable JSON, a value failing its shape or a git failure gives NULL for that one field and the run goes on.

- The configuration directory: `CLAUDE_CONFIG_DIR` when set, non-empty and absolute, else `~/.claude`. Only this one directory is read.
- `VERSION` (`gsd-core/VERSION` in it, at most 64 bytes) is kept as `gsd_version` when it has the version shape; else the top-level
  `version` of `gsd-file-manifest.json`. No other manifest key is read.
- `settings.json`: only the keys `hooks`, `model` and `advisorModel`, picked by literal name. For `hooks` the count per event is the sum of
  each group's `hooks` array length, and `hooks_sha` is the sha256 of the canonical JSON of the whole value, computed in memory and never
  stored as text. `model` and `advisorModel` are kept when they have the model-name shape.
- `RIGORSCOPE_INSTALLED_BASE_FILE`: an absolute path to a JSON file (at most 64 KiB); only its top-level `sha` is kept, when 40 or 64
  lower-case hex characters.
- `RIGORSCOPE_LOCAL_MODS_DIR`: an absolute path to a directory; one `git rev-parse --verify HEAD` there (no shell, a ceiling at the
  directory's parent, a 10 second timeout); the answer is kept when it is 40 or 64 lower-case hex characters.

Never read: hook command text (beyond the in-memory hash), `env` values, permissions, `statusLine` and every other settings key. No value
read is ever printed, logged or put in an error message. The scheduled ingest reads the two `RIGORSCOPE_` variables from its service
environment, so it records NULL for both unless that environment sets them.

## Forward ledger

The `ledger` source reads one file, `~/.rigorscope/ledger/units.jsonl`, written by `unit-start` and `unit-close`, into the `ledger_line`
table. It is read through the cursor framework: one root alias `state` (kind `ledger`), one file. A symlinked `ledger` directory or file,
or a file that is not regular, is skipped and counted; an absent directory is not an error. The source is not live, so a quiet ledger is
never STALE.

- A line is stored only after the writer's rule set accepted it. Keys outside the allowlist are removed first and counted by name; any
  other bad line is dropped and counted under a closed reason; no dropped text and no rejected value is stored. The reader accepts lines
  up to 8192 bytes, the writer writes at most 2048.
- One row per `line_id` (a content hash made by the writer). A stored row is never updated or deleted: a second line with the same
  `line_id` and different content is counted `key_conflict` and the stored row stays. Deleting lines from the file by hand does not
  remove their rows.
- Times are stored as UTC ISO text with milliseconds. The line key `command` is stored in the column `command_name`.

## Usage cache and usageReport lines

The subscription windows (five-hour and weekly) are account-level percentages. Claude Code caches the latest values in its main config
file, `~/.claude.json` in your home, which also holds account data, project paths and money figures. The usage source reads that one file
and nothing else of it. Only `HOME/.claude.json` is opened, read-only, with the no-follow flag; a symlink or a directory at that path is
refused (`not_regular`). The size is checked on the open file: over 16 MiB is `oversized` and nothing is read. The pick reads by literal
key path from `cachedUsageUtilization` only; it never lists, copies or serializes an object. It is the constant `CACHE_PICK` in
`src/sources/usage/cache.mjs`:

| Key path (under `cachedUsageUtilization`) | Column | Shape rule |
| --- | --- | --- |
| `fetchedAtMs` | `fetched_at_ms` | an integer between `2000-01-01` and `2100-01-01` (UTC), else nothing is stored (`rejected`) |
| `utilization.five_hour.utilization` | `five_hour_pct` | a number from 0 to 100 |
| `utilization.five_hour.resets_at` | `five_hour_resets_ms` | `YYYY-MM-DDTHH:MM:SS[.fraction]` with `Z` or a `+HH:MM`/`-HH:MM` offset, stored as UTC epoch ms |
| `utilization.seven_day.utilization` | `seven_day_pct` | as five_hour |
| `utilization.seven_day.resets_at` | `seven_day_resets_ms` | as five_hour |
| `utilization.seven_day_opus.utilization` | `seven_day_opus_pct` | as five_hour, when the window is not null |
| `utilization.seven_day_opus.resets_at` | `seven_day_opus_resets_ms` | as five_hour |
| `utilization.seven_day_sonnet.utilization` | `seven_day_sonnet_pct` | as five_hour, when the window is not null |
| `utilization.seven_day_sonnet.resets_at` | `seven_day_sonnet_resets_ms` | as five_hour |
| `utilization.limits[].kind` | `kind` | `^[a-z][a-z0-9_]{0,47}$`, required (else the entry is dropped) |
| `utilization.limits[].group` | `grp` | the same pattern, else NULL |
| `utilization.limits[].percent` | `percent` | 0 to 100, required |
| `utilization.limits[].resets_at` | `resets_ms` | an instant as above, required |
| `utilization.limits[].is_active` | `is_active` | a boolean stored 1 or 0, else NULL |

A window with one bad field is stored as absent and its path is counted; a JSON `null` window is absent and not counted. At most 16 limit
entries are considered. Never read, stored, logged, hashed or echoed: the account id key and every other key of the file, including the
account block, email and organization data, project paths, the money fields, `scope` objects, `severity` and the other usage keys. The
usage source is cursorless: it writes no `source_root` or `source_file` row, and a snapshot is deduplicated on its `fetchedAtMs`.
Statuses printed on the `usage:` line (`dropped=`, `skipped=1`): `absent`, `not_regular`, `oversized`, `unreadable`, `unparseable`,
`no_cache` and `rejected`.

Transcript `usageReport` lines (type `system`, subtype `local_command`) carry the same limit entries next to rendered usage text and
credit figures. A separate pick, `REPORT_PICK` in `src/sources/usage/report.mjs`, reads only these paths:

| Key path (of the line) | Column | Shape rule |
| --- | --- | --- |
| `timestamp` | `fetched_at_ms` | an instant as above, else nothing is stored |
| `usageReport.rate_limits.limits[].kind` | `kind` | as for the cache |
| `usageReport.rate_limits.limits[].group` | `grp` | as for the cache |
| `usageReport.rate_limits.limits[].percent` | `percent` | as for the cache |
| `usageReport.rate_limits.limits[].resets_at` | `resets_ms` | as for the cache |
| `usageReport.rate_limits.limits[].severity` | `severity` | `^[a-z][a-z0-9_]{0,31}$`, else NULL |
| `usageReport.rate_limits.limits[].is_active` | `is_active` | as for the cache |

The limit kind `session` gives the five-hour window and `weekly_all` the weekly window of the snapshot. A report seen in several
transcript files is stored once. Known limits: snapshots are only as frequent as ingest runs and cache refreshes; the percentages are
account-level, so they include activity on other machines; and without the account id, snapshots from another signed-in account cannot be
told apart (a percentage that falls without a reset is kept as interval status `falling`, a lead for `doctor`).

## Price table

The notional dollars of `cost` come from a data file shipped in the repository, `data/prices-YYYY-MM-DD.json`, not from anything on the
machine and never from the network: rigorscope does not fetch a pricing page at run time. The rows were read from the vendor's pricing
page on the day in the file name (`date_read`). The page lists display names; the file uses the ids seen in transcripts
(`claude-opus-5-5`). A model with no transcript id seen is left out rather than guessed, and a call on it is unpriced (`?`). A
`validated` row matched Claude Code's own OTel `cost_usd` in a comparison; every other row is `cited`, taken from the page only. The
long-prompt tier, fast mode and the residency multiplier are cited and were not observed in data. The format and the loader's refusals are
in [data-model](data-model.md#pricing); refreshing the table is in [operations](operations.md#refresh-the-price-table). `RIGORSCOPE_PRICES_DIR`
names another directory.

## What is not read

Any key of `~/.claude.json` outside the usage pick, the same file in any other configuration directory, the Windows profile copy, a price
page or any network resource.

## OTel receiver files

The `otel` source (`src/sources/otel/`) reads the OpenTelemetry files that a local receiver writes: one line per event or metric. This is
an optional integration: rigorscope does not ship or start a receiver, and without one the source is simply not configured. Set
`HOOK_TELEMETRY_DIR` to the directory your receiver writes if it is not at the default location. `ingest` with no flags reads both
directories below; `--root` only replaces the transcript roots and does not affect OTel discovery.

| Alias and kind | Where | Shown as |
| --- | --- | --- |
| `live` | `~/.local/share/hook-telemetry`, or the directory in `HOOK_TELEMETRY_DIR` when that is an absolute path (a relative value is ignored) | `~/.local/share/hook-telemetry` |
| `preserve` | `~/.local/share/rigorscope/preserve/hook-telemetry`, rigorscope's own backed-up copy | `~/.local/share/rigorscope/preserve/hook-telemetry` |

A directory that does not exist is skipped, never an error: reason `not_configured` for the default live directory, `absent` for the
preserve copy and for a `HOOK_TELEMETRY_DIR` you set that is missing. `doctor` lists these under `skipped`. A symlinked directory is
resolved once. Inside a directory only regular, non-symlink files named `events-YYYY-MM-DD.jsonl` or `metrics-YYYY-MM-DD.jsonl` are
read; every other entry is skipped and counted as `walk_skip` by reason `name`, `symlink` or `not_regular`. The live directory is
read-only to rigorscope. The preserve copy is read the same way; because its files are often a byte prefix of the live file, or identical
to it, records dedupe on their keys and a backed-up copy never double counts.

### Lines and records

Every line is a JSON object `{ts, event|metric, [value,] attrs, resource}`. A line with a string `event` is an event; with a string
`metric` it is a metric; any other JSON value is dropped as `record_type`. A blank line is skipped; text that is not JSON is `unparseable`.
A line without its newline is not consumed until the newline arrives, and a line above 1 MiB is `oversized`. A line that cannot be keyed
is dropped and counted by one reason, checked in this order: `ts`, `session_id`, `event_sequence`, `event_timestamp`, `event_name` for
events, and `metric_name`, `ts`, `value` for metrics.

### Event key

An event is keyed on four fields: `session.id`, `event.sequence`, `event.timestamp` and the event name (the top-level `event`). A
two-field key (session and sequence) is not enough: on real files a small share of lines share a session and sequence with another line
that differs only in name or timestamp, and a two-field key would silently lose them. A key that already exists with different attributes
is not overwritten: the stored row stays and the collision is counted as `dropped` `key_conflict`. An `event.name` attribute that
disagrees with the top-level event is counted as `rejected_field` `header.event.name`; the top-level value keys the row.

### Metric key and ordinal

Metrics carry no sequence, so a metric is keyed on its timestamp, its name, the sha256 of its canonical kept attributes and an ordinal.
The ordinal tells byte-identical lines of one file apart: the number of earlier lines of the same file with the same timestamp, name and
attribute hash, taken from the provenance table `otel_metric_line`, so a reread, a copy in another file and an appended line all give the
same ordinal to the same line. When a file is reread from offset 0 its provenance rows are deleted in the first transaction of the reread.
Residual: a file that has vanished keeps the provenance of its last pass. `SELECT count(*) FROM otel_metric WHERE ordinal > 0` is an
acceptance number (expected 0 on typical data), and `scripts/check-otel-provenance.mjs` compares the provenance with the files.

### What is kept

Deny by default: an attribute is stored only if the table below names it for its event kind, and only if its value passes the shape kind.
The header keys `session.id`, `event.sequence`, `event.timestamp` and `event.name` are read to key the row and never stored in `attrs`.
`prompt.id` (shape `id`) is kept for every kind that stores attributes. Stored attributes are canonical JSON (keys sorted) with the
allowlist's JSON type for each key: a count given as the number 3 or the string "3" is stored as the number 3.

| Kind | Kept keys by shape kind |
| --- | --- |
| `api_request` | name: `model`, `speed`, `query_source`, `effort`, `agent.name`, `skill.name`, `mcp_server.name`, `mcp_tool.name`; count: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cache_creation_5m_tokens`, `cache_creation_1h_tokens`, `cost_usd_micros`; money: `cost_usd`; ms: `duration_ms`, `ttft_ms`; id: `request_id`, `client_request_id` |
| `api_error` | name: `model`, `speed`, `query_source`, `effort`, `agent.name`, `skill.name`; count: `status_code`, `attempt`; ms: `duration_ms`; id: `request_id`, `client_request_id` |
| `api_retries_exhausted` | name: `model`, `speed`, `query_source`, `effort`; count: `status_code`, `total_attempts`, `total_retry_duration_ms` |
| `api_refusal` | name: `model`, `speed`, `query_source`, `effort`, `agent.name`, `skill.name`; id: `request_id`; count: `attempt`; bool: `server_fallback_hop`, `has_category`, `has_explanation` |
| `tool_decision` | name: `decision`, `source`, `tool_name`, `tool_source`, `classifier_verdict`, `permission_mode`; id: `tool_use_id` |
| `tool_result` | name: `tool_name`, `error_type`, `decision_source`, `decision_type`, `mcp_server_scope`, `vcs.ref.head.type`; id: `tool_use_id`; bool: `success`; ms: `duration_ms`; count: `tool_input_size_bytes`, `tool_result_size_bytes`; hex: `vcs.ref.head.revision` |
| `hook_execution_start` and `hook_execution_complete` | name: `hook_event`, `hook_name`, `hook_source`; count: `num_hooks`, `num_success`, `num_blocking`, `num_non_blocking_error`, `num_cancelled`, `stdout_chars`, `additional_context_chars`, `system_message_chars`, `initial_user_message_chars`, `num_outputs_persisted`; ms: `total_duration_ms`; bool: `managed_only`, `safe_mode` |
| `hook_registered` | name: `hook_event`, `hook_type`, `hook_source`, `plugin.name`; bool: `safe_mode`; pattern: `hook_matcher`; id: `plugin_id_hash` |
| `safety_event` | name: `category`, `decision`, `decision_source`, `reason_type`, `reason_code`, `hook_event`, `tool_class`, `tool_name`, `tool_source`, `permission_mode`, `rule_source`, `circuit_breaker`, `grant_scope`; id: `tool_use_id`; count: `sandbox_violation_count`; bool: `sandbox_enabled` |
| `subagent_completed` | name: `agent_type`, `agent.source`, `model`, `final_model`; bool: `is_built_in`, `is_async`, `model_swapped`; count: `total_tokens`, `total_tool_uses`; ms: `duration_ms` |
| `skill_activated` | name: `skill.name`, `invocation_trigger`, `skill.source` |
| `user_prompt` | count: `prompt_length`; id: `message.uuid`; name: `command_name`, `command_source` |
| `assistant_response` | count: `response_length`; id: `request_id`, `message.uuid`; name: `model`, `query_source` |
| `plugin_loaded` | name: `plugin.name`, `marketplace.name`, `plugin.version`, `plugin.scope`, `enabled_via`; id: `plugin_id_hash`; bool: `has_hooks`, `has_mcp`, `host_owned_mcp`, `safe_mode`; count: `skill_path_count`, `command_path_count`, `agent_path_count` |
| `mcp_server_connection` | name: `status`, `transport_type`, `server_scope`, `error_code`; ms: `duration_ms`; bool: `is_plugin`; label: `server_name` |

`subagent_completed.total_tokens` is stored only inside `attrs` as a reconciliation hint. No column, view or aggregate sums it, and it is
never used as a run total. Header-only kinds store the row key, the kind and `attrs` `{}`: `managed_settings_resolved`, `retention_sweep`,
`at_mention`, `feedback_survey`, `internal_error` and `auth`.

Metrics keep these attributes only: `session.id` (shape `id`), `language` (shape `label`) and, as shape `name`, `model`, `query_source`,
`effort`, `type`, `agent.name`, `skill.name`, `mcp_server.name`, `mcp_tool.name`, `decision`, `source`, `tool_name` and `start_type`. The
eight known metric names are `claude_code.session.count`, `claude_code.cost.usage`, `claude_code.token.usage`,
`claude_code.active_time.total`, `claude_code.lines_of_code.count`, `claude_code.code_edit_tool.decision`, `claude_code.commit.count` and
`claude_code.pull_request.count`. Names such as `agent.name` and `skill.name` are metadata and are kept when shape-valid.

### Shape kinds

Every stored string passes an ASCII shape check, so free text, email shapes and decoded non-ASCII text cannot be stored. A value that fails
is omitted and counted as `rejected_field` under `<kind>.<key>` (`metric.<key>` for metrics), never with the value.

| Shape kind | Accepts |
| --- | --- |
| `iso` | a UTC time `YYYY-MM-DDTHH:MM:SS` with 0 to 9 fraction digits and `Z` |
| `id` | 1 to 128 characters of letters, digits and `.` `_` `:` `-` |
| `name` | a leading letter or digit, then letters, digits and `.` `_` `:` `/` `-`, up to 64 characters |
| `label` | up to four short words (letters, digits, `.` `_` `:` `,` `-`), 64 characters at most |
| `pattern` | a tool-name regex: 1 to 120 characters of letters, digits and `_ . * + ? ^ $ ( ) \| [ ] -` |
| `hex` | 7 to 64 lowercase hex digits |
| `version` | dotted numbers such as `2.1.309`, with an optional short suffix |
| `count` | a non-negative integer or a string of digits; stored as a number |
| `ms` | a finite number up to 1e12 in magnitude or a numeric string; negative values allowed |
| `money` | a finite number from 0 to 1e6; strings are rejected |
| `bool` | a boolean, or the exact strings `true` and `false` |

A `label` value admits up to four short words, so a server name or language that contains spaces is accepted as metadata, and one with
more than four words is rejected and counted.

### What is always dropped

Checked before the allowlist, so no allowlist edit can bring them back: identity keys (any key starting with `user.` or `organization.`,
shown as `user.*` and `organization.*`), `terminal.type`, the content keys `prompt`, `prompt_text`, `response`, `tool_parameters`,
`tool_input` and `error` on every event kind, and the branch name `vcs.ref.head.name` (the commit id `vcs.ref.head.revision` and the type
`vcs.ref.head.type` are kept). From the resource only `service.version` is kept (as the Claude Code version, a confounder); `host.arch`,
`os.type`, `os.version`, `wsl.version` and `service.name` are noise and are ignored silently.

### Unknown names and the unknown token-bearing rule

- An unknown attribute of a known kind (and an unknown resource key) is recorded in `unknown_attr` by shape-checked name only, under the
  scope of the kind (or `resource`); at most 200 distinct names are kept per scope. No value is ever stored for an unknown key.
- A new event kind is stored header-only, its name is recorded under scope `event_kind` and its attribute names under the scope of the
  kind. An unknown kind that carries a token or cost key, or an unknown metric name containing `token` or `cost`, is an unknown
  token-bearing record: it is counted by `name|version`, printed as a `WARNING:` on stderr, and the run still exits 0. An unknown metric
  name is stored and recorded under scope `metric_name`.

### What the cost derivation reads

The derivation reads only stored `otel_event` rows of kind `api_request`, and from each only: `request_id` (the join key to the
transcript calls), `session.id` and the event time, `model`, the six token counts, `cost_usd` (else `cost_usd_micros`, the measured cost),
`query_source`, `effort`, and `agent.name` (the cross-check only, never a role). No other event kind is read, and no run-level sub-agent
token total is read: `subagent_completed` events are never selected. Every text value is re-checked against a narrower shape before it is
stored in `derived.db`.
