# CLI reference

Twelve commands exist; `rigorscope --help` lists them. The examples use `rigorscope`; if you did not run
`npm link`, write `node bin/rigorscope.mjs`. Output shown here comes from the synthetic demo fixture or from the fixture
builders in `test/fixtures/`; run `npm run demo` to see the same numbers.

- [`ingest`](#ingest): read Claude Code transcripts and the OTel, usage and ledger sources into the local store.
- [`cost`](#cost): tokens and notional dollars by role, model, effort, day, session, repo, tier, unit, framework or runtime.
- [`evidence`](#evidence): the calls and files behind one report row, one unit (`u:`) or one link (`l:`).
- [`preserve-scrub`](#preserve-scrub): remove tool parameters, inputs and errors from the preserve copy of OTel files.
- [`doctor`](#doctor): check that the data is current and the daily ingest is healthy (advisory).
- [`schedule`](#schedule): install the daily ingest as systemd user units (dry run unless `--apply`).
- [`migrate`](#migrate): apply pending store migrations after a verified backup (dry run unless `--apply`).
- [`units`](#units): list units of work with repo, tier, dates, links and attributed cost.
- [`tier`](#tier): per-unit cost by rigor tier inside each risk stratum.
- [`calibrate`](#calibrate): compare the forward ledger with reconstruction, field by field.
- [`unit-start`](#unit-start) and [`unit-close`](#unit-close): append a unit's start or close to the forward ledger.

Operations (the lock, interrupting an ingest, backups, removal) are in [operations](operations.md). Two flags are shared by
`units`, `tier` and `cost`: `--population forward|reconstructed|all` selects the forward (ledger-recorded) or the
reconstructed stratum, and `--sheet` adds an opt-in decision sheet. They mean the same everywhere.

## Global

```
$ rigorscope --help
```

- `--help`, `-h`: print the command list and exit 0; `rigorscope COMMAND --help` prints one command's usage.
- A missing command, an unknown command or flag, or a bad value is a usage error: one line on stderr, exit 2.
- Exit codes: `0` success; `1` rigorscope's own failure (the state directory is a symlink, the store is newer than this
  rigorscope, or an existing store has a pending migration, see `migrate`); `2` usage error, or the runtime check failed
  (Node older than 24.15 or no built-in sqlite module: one line, nothing created on disk); `143` or `130` an `ingest`
  stopped by SIGTERM or SIGINT.
- rigorscope reports and never gates: a bad-looking number never changes an exit code. Errors print one line with a name and
  a code, never a stack, SQL text or file content.
- All state lives under `~/.rigorscope/` (directories 0700, files 0600). `HOME` decides which home that is.

## Commands

### ingest

```
$ rigorscope ingest
ingest: roots=3 sources=ledger,otel,transcript,usage
transcript: files=12 new=12 reread=0 unchanged=0 skipped=2 bytes=48210 lines=95 assistant=40 kept=38 unparseable=1 ...
transcript: skipped_types=user:30,attachment:12,system:4,other:0
...
ingest: files=12 lines=41 assistant=40 kept=38 unparseable=1 rejected=none
```

Reads into `store.db`. Transcripts are read-only input: nothing under any root is changed. With no flag every Claude
configuration directory is discovered (see [sources](sources.md)); the first run is a backfill, later runs read only appended
bytes. A second run with nothing new prints zero for `new`, `bytes` and `lines`.

- `--root DIR` (repeatable): read exactly these directories instead of discovering them. A missing or non-directory root is a
  usage error. Only `projects/` below a root is read: session files, sub-agent files and their meta files, no symlinks.

Output, in order:

1. `ingest: roots=N sources=...`.
2. One progress line per source (`ledger:`, `otel:`, `transcript:`, `usage:`): `files`, `new`, `reread`, `unchanged`,
   `skipped`, `bytes`, `lines`, `assistant` (candidate lines that parsed), `kept` (lines that produced a row),
   `unparseable`, `oversized`, `dropped=session_id:N,message_id:N,usage:N`, `unknown_token_bearing`, `deferred_token_bearing`
   and `pending_tail_bytes` (bytes after the last newline, waiting for it); then `NAME: skipped_types=...` with the eight most
   frequent skipped record types. For `otel:`, the stored `rows_upserted` counts rows newly inserted, so the duplicates a
   backed-up copy repeats are `kept` minus `rows_upserted`.
3. `locations:`, `classes:`, `env:` and `units:` lines (below).
4. The summary line `ingest: files=... rejected=...` (`rejected` lists fields whose value failed a shape check as
   `column:count`; the value is stored as NULL and never printed).
5. On stderr, one `WARNING:` line when the unknown token-bearing count is above 0. It never changes the exit code.

`env:` is the environment snapshot of the run: `gsd_version`, `base_sha` (12 characters, from the file named by
`RIGORSCOPE_INSTALLED_BASE_FILE`), `local_mods_head` (12 characters, from the repository named by `RIGORSCOPE_LOCAL_MODS_DIR`),
`hook_events`, `hooks` (counts only, no command is read), `model_default` and `advisor_model`. Every value is `?` when its
source is absent.

`locations:` counts what the unit step found in the stock planning locations and could not read. It starts with `repos=`, then
one counter per field, in this order: `units_archived`, `repeat_id`, `moved`, `move_ambiguous`, `not_read_workstream_dir`,
`not_read_workstream_plan_files`, `not_read_bare_plan`, `not_read_plan_id_1seg`, `not_read_plan_id_3seg`,
`not_read_plan_file_other`, `not_read_plan_file_coded`, `not_read_bracket_phase_dir`, `not_read_custom_phase_dir`,
`not_read_quick_dir_name`, `not_read_milestones_other_dir`. `moved` counts moves read for the first time in this run,
`move_ambiguous` units whose stored directory is gone and that have two or more same-name archive directories (nothing is read
for them). When no repository was scanned, `repos=0` and every counter prints `?`. Meanings and limits are in
[sources](sources.md#locations-and-counters).

`classes:` counts planning files by name against a roster of gsd-core artifacts: `repos=`, `recognized_f`, `recognized_e`,
`recognized_s`, `unclassified` (files in a scanned listing that no roster entry names) and `roster_ref=` (the roster version).
The stem counters `unclassified_stem` and `unclassified_stem_other` are stored, not printed here.

`units:` is the unit step: `git=ok|unavailable|not_needed`, `dirs`, `resolved`, `ancestor`, `none`, `repos`, `scanned`,
`quick`, `dup_ids`, `skipped`, `plan`, `artifacts`, `facts` and its counters. `git=unavailable` means git was not found; the
directories are resolved on a later run.

Exit codes: 0 on success (also with nothing found); 1 when the store is refused (see `migrate`); 2 on a usage error; 143 or
130 when interrupted (the lock is released and the next run resumes).

### cost

```
$ rigorscope cost --since 2026-10-01 --until 2026-10-07 --by unit
freshness: STALE as of ...
period: from 2026-10-01 (2026-10-01T00:00:00.000Z) to 2026-10-07 inclusive (before 2026-10-08T00:00:00.000Z), tz=UTC, calls_ts_unknown=0
population     unit                                         calls  input  output  cache_read  cache_write  notional_usd  window_5h  window_7d
(unlinked)     (unlinked)                                       1    500     100           0            0      0.004000          ?          ?
reconstructed  gsd-core:~/repos/demo/.git:quick:261001-d1a      1   1000     500       20000         2000      0.028000          ?          ?
reconstructed  gsd-core:~/repos/demo/.git:quick:261002-d2b      1   2000    1000       10000         1000      0.035000          ?          ?
=total         =                                                5   8500    3100       45000         5400      0.099500          ?          ?
totals check: main OK (rows sum to the total row in input, output, cache_read, cache_write, notional_usd, window_5h and window_7d)
```

(Synthetic demo data, shortened.) `cost` loads the price table, rebuilds `derived.db` from `store.db` when it is stale, and
prints the freshness block, the period, one table with a total row per section, and a footer.

- `--by NAMES`: leading columns, a comma-separated list of distinct names from `role`, `model`, `effort`, `day`, `session`,
  `repo`, `tier`, `unit`, `framework`, `runtime` (default `role,model`). `day` is the local day in the `--tz` zone; `session`
  the owner session id; `repo` the repository reconstructed from the call's working directory. `tier`, `unit` and `framework`
  are attributes of the unit the call's session is attributed to, in the strict mode (`link_confidence=medium`); a call whose
  session is not attributed shows `(unattributed_overlap)` or `(unlinked)`. A bad list is a usage error.
- `--since DATE`, `--until DATE` (calendar dates, inclusive) and `--tz ZONE` (an IANA name): the period. The default is the
  last 7 days; the day buckets use `--tz`, default the process zone (`TZ`).
- `--json`: one versioned document (`rigorscope.cost/1`) with the same numbers: every measured cell is
  `{ value, n, label, coverage, evidence }`, unknown is `null` with the label `unavailable`, money is integer nano-dollars.
- `--evidence` and `--limit N`: list the calls behind each row inline (see `evidence`).
- `--include-inferred`: with `--tier`, also select units whose tier was inferred from probe files.
- `--population` and `--sheet`: as above. `--sheet` adds the decision sheet after the report.

#### Filters

`--repo`, `--tier`, `--framework`, `--runtime`, `--model` and `--role` take a comma-separated list of at most 16 distinct
values, with `?` meaning unknown where it applies. A bad value is a usage error before any state is touched. `--repo` takes a
name (every repository of that name) or a quoted key such as `'~/a/proj/.git'`. `--tier` and `--framework` keep the calls
attributed to a unit with that tier or framework. `--model` selects calls by the call model (the model of the request), while
`--by model` splits by part model, because a call with advisor parts has a part on each model it used. The `scope:` line
names the filters in force. `--tier B` selects units whose tier is the letter B, not one inferred from probe files.

#### What a row counts

- A call is one message id. A message stored more than once is one call whose tokens are the largest value of each field over
  its copies. Advisor tokens land on the advisor model, never on the call's model.
- `role`: the attribution agent on the line, else the agent type in the sub-agent meta file, `main` for a main-thread line,
  else `unknown`.
- A cell is `?` when any part in the row lacks that value. `calls` counts distinct calls with a part in the row, so a call with
  advisor parts appears under each model it has a part for.

#### Notional dollars

`notional_usd` is what the row's tokens would cost at the shipped price table (`data/prices-YYYY-MM-DD.json`): label `derived`,
never billed or measured. A cell is six decimals of US dollars. `?` means unknown (an unpriced model, a missing token count, a
modifier the table does not cover, or no usable table). `>=` marks a floor (the cache-creation split did not resolve, or a
server tool was used). The newest price file in the directory is used; `RIGORSCOPE_PRICES_DIR` names another directory. With an
unusable table every token cell still prints, every dollar cell is `?`, one warning goes to stderr and the exit code is 0.

#### Window share

`window_5h` and `window_7d` are the estimated share of the subscription windows, spread from usage snapshots that `ingest`
records from the cache Claude Code keeps and from transcript usage reports. They show `?` until snapshots can support an
estimate (label `estimated`, never measured).

#### Footer

After the table: `labels:` (what each column's label is), `by-labels:`, `scope:`, `conservation:` (the sums by role, by model, by
part and in the store agree for each token class; `VIOLATED` otherwise), `counts:`, `totals:`, `pricing:`, `notional:`,
`window:`, `join:`, `roles:` and, when OTel or harness rows exist, `otel-only:`, `crosscheck:` and `error-band:`. OTel and
harness rows are separate labeled blocks: OTel tokens and measured cost are never mixed into transcript rows. `join:` counts
how OTel `api_request` events match transcript calls on `request_id`. `freshness:` marks a source STALE when its newest record
is older than 36 hours; `period:` states the range and zone.

Exit codes: 0; 1 when the store is refused (pending migration, newer store, symlinked state directory); 2 on a usage error.

### evidence

```
$ rigorscope evidence main/total --limit 20
```

`evidence ID` lists the calls behind one row so a number can be traced to its source. `ID` is a row key as printed in the `key`
field of `cost --json`, a unit id `u:UNIT` or a link id `l:LINK` (both printed by `units --evidence`). It prints the freshness block, the period line, then the calls behind the row ordered by record time and call id; transcript evidence
names the file and the message id (no line locator is stored), OTel evidence adds the stored byte offset. It never prints content.

- `--since`, `--until`, `--tz`: the period, as in `cost` (the default is the last 7 days for a row key and all time for a unit id). `--limit N`: at most N calls (default 50). `--json`: one document
  (`rigorscope.evidence/1`). `--link-confidence medium|low`: the attribution mode for unit ids (default `medium`).

A row key does not carry the `cost` filters, so `evidence` lists the whole row. Exit codes: 0, 1 (store refused), 2 (usage error
or an unknown id).

### preserve-scrub

```
$ rigorscope preserve-scrub
preserve-scrub: events-2026-10-25.jsonl lines=5 rewritten=1 dropped=1 unparseable_kept=1 removed=tool_input:1,tool_parameters:1
preserve-scrub: files=4 rewritten=2 unchanged=2 skipped=name:2,not_regular:1,symlink:1 mode=dry-run rules=default
preserve-scrub: dry run, nothing was written; re-run with --apply to rewrite 2 file(s)
```

Removes `tool_parameters`, `tool_input` and `error` from rigorscope's own preserve copy of the OTel files
(`~/.local/share/rigorscope/preserve/hook-telemetry/`). A dry run by default: it writes nothing, takes no lock and never opens
the store. It never touches the live receiver directory.

- `--apply`: take the ingest lock, then rewrite the files that need it (a temporary file in the same directory, renamed over the
  original; lines that lose nothing are copied byte for byte). While an `ingest` holds the lock it prints
  `preserve-scrub: skipped, an ingest holds the lock` and exits 0. A second `--apply` changes nothing.
- `--full`: also remove `prompt`, `prompt_text`, `response`, `vcs.ref.head.name`, `terminal.type` and every `user.*` and
  `organization.*` key. Use it on purpose; the default rule set is smaller.

A line that cannot be parsed is kept, unless it holds a quoted key of the active rule set; then it is dropped (`dropped`). Only
regular files named `events-YYYY-MM-DD.jsonl` or `metrics-YYYY-MM-DD.jsonl` are considered; the rest is counted in `skipped` by
reason. Output names files, counts and rule names, never a value. With no preserve directory it prints
`preserve-scrub: no preserve directory` and exits 0.

Exit codes: 0 on success and when the directory is absent; 1 when the preserve directory is a symlink or not a directory, or on
an I/O failure; 2 on a usage error.

### doctor

```
$ rigorscope doctor
doctor: UNHEALTHY as of 2026-11-07T04:22:16.438Z; problems=2 leads=0 unverified=0
  problem timer_missing: the ingest timer is not installed; run rigorscope schedule install
  problem unit_node_below_floor: the node on the unit PATH is below 24.15.0 or lacks node:sqlite, so the daily run would exit 2
freshness: OK as of ...
store: schema=v8 latest=v8 pending=0 runs=1 ok=1 failed=0 other=0 ...
```

Answers one question: can the reports be trusted, and is the daily ingest installed and healthy? It is advisory: it exits 0
whatever it finds. It reads `store.db` and `derived.db` read-only (after the lazy `derived.db` rebuild that `cost` runs), root
discovery, the two installed unit files, `systemctl --user show` for the timer and service, and the `node` on the unit's PATH.
It takes no lock and writes nothing outside `~/.rigorscope/`.

- `--json`: one document (`rigorscope.doctor/1`): verdict, counts, findings and one object per section; unknown is `null`.
- `--signals`: print the signal registry (see [operations](operations.md#signals-and-their-consumers)). With `--json` it is a usage error.

The first line is `doctor: VERDICT ...`: `UNHEALTHY` when any problem is found, else `UNVERIFIED` when a check could not run, else
`HEALTHY`. Finding classes: a problem (for example `no_store`, `migration_pending`, `source_stale`, `last_run_failed`,
`lock_old`, `timer_missing`, `timer_inactive`, `service_failed`, `unit_node_below_floor`), an unverified check (`timer_unverified`,
`unit_node_unverified`) or a lead (`unknown_token_bearing`, `unknown_attr`, `null_session_id`, `agent_name_disagreement`,
`usage_discontinuity`, `snapshot_old`, `root_not_seen`, `roster_drift`). Leads never change the verdict. Sections, in order:
`freshness`, `store`, `lock`, `roots`, `cursors`, `null-session-id`, `unknown-token-bearing`, `unknown-attr`, `ledger-lines`,
`unit-locations`, `roster`, `unclassified`, `join-miss`, `agent-names`, `usage`, `discontinuity`, `timer`, `service`, `unit-node`.

- `unit-locations`: the location counters of the unit step, summed over repositories; `unit-locations: unavailable (no unit scan recorded)`
  when none was recorded, never zeros.
- `roster:` compares the roster of gsd-core artifacts with an installed or named gsd-core copy. `RIGORSCOPE_GSD_CORE_CHECKOUT`
  names a gsd-core checkout to compare against (read through one `git diff` of the paths the roster cites; its value is never
  printed). With none, the installed version of the latest environment snapshot is used. An unknown drift is never reported as
  drift: the lead `roster_drift` is raised only when drift is seen, so a machine without gsd-core stays HEALTHY.
- `unclassified`: files in a scanned listing that no roster entry names, summed over repositories.
- `ledger-lines`: stored ledger lines, kept and dropped counts with reasons. A non-zero `dropped` means the ledger writer needs fixing.

### schedule

```
$ rigorscope schedule install
schedule install: dry run (nothing is written; add --apply to install)
checkout: ok
node: /usr/local/bin/node v24.22.1 floor=24.15.0 ok
unit directory: ~/.config/systemd/user
rigorscope-ingest.service: new
+ [Unit]
+ Description=rigorscope: daily ingest of Claude Code transcripts and OTel receiver files
+ ...
rigorscope-ingest.timer: new
+ [Timer]
+ OnCalendar=*-*-* 04:10:00
+ ...
would write 2 file(s), then run: systemctl --user daemon-reload; systemctl --user enable --now rigorscope-ingest.timer
```

Installs the two systemd user units in `units/` so that `ingest` runs daily. Systemd only; other schedulers are in
[operations](operations.md#scheduling-without-systemd). The only accepted positional is `install`. A dry run creates nothing.

- `--apply`: write the two files into `$XDG_CONFIG_HOME/systemd/user` (an absolute path) else `~/.config/systemd/user`, then run
  `systemctl --user daemon-reload` and `systemctl --user enable --now rigorscope-ingest.timer`. A differing existing file is
  first saved as `NAME.bak-YYYYMMDDTHHMMSSZ`. A second `--apply` changes nothing.
- `--no-systemctl`: skip the two `systemctl` calls and say so.

Refusals, printed as `REFUSED CODE: fix hint` with nothing written and exit 2: `node_missing`, `node_below_floor`,
`node_no_sqlite`, `node_unusable`, `checkout_mismatch` (the unit hard-codes the checkout location `~/repos/rigorscope`, so the
install works only from a checkout there), `destination_symlink` and `destination_not_file`. Exit codes: 0; 2 on a usage error or a
refusal; 1 when a `systemctl` step fails.

### migrate

```
$ rigorscope migrate --apply
migrate: store.db at schema v5, this rigorscope supports v6, pending 1: 006-server-tool-use-flag
backup: ok
verify: ok
migrate: applied 006-server-tool-use-flag; store.db at schema v6
```

The only command that applies a store migration. `store.db` is kept and migrated in place, so a migration is one-way and a copy
taken before it is the only revert. A fresh store gets every migration on its first open with no backup. An existing store with a
pending migration is refused by every command that opens it (`ingest`, and `cost` or `evidence` when they must rebuild
`derived.db`): one stderr line, exit 1, nothing written. The daily timer fails the same way until the migration is applied.
`doctor` reports the finding `migration_pending` and exits 0. A store newer than this rigorscope is refused, also by `migrate`.

Without a flag, `migrate` is a dry run: it prints the store version, the latest version and the pending migration names, and
writes nothing.

- `--apply`: take the ingest lock, back up `store.db` (and `derived.db` when present) into `<state dir>/backups/pre-migrate-<UTC
  stamp>/` with a manifest, verify that backup, and only then apply each migration in its own transaction. When an `ingest` holds
  the lock it prints a skip line and exits 0. A second `--apply` finds nothing pending and takes no second backup.

Exit codes: 0 (dry run, applied, nothing pending, no store, or a held lock); 1 when the backup or its verify fails (nothing
applied), a migration fails, the store is newer, or the state directory is a symlink; 2 on a usage error.

### units

```
$ rigorscope units
population: reconstructed n=4 costed=4 low_evidence=yes min_n=10 (units rebuilt from the planning directories of repos reached through transcript working directories)
repo  kind   id          tier  signal       timing             conflict  risk    novelty        start       end         dates         files  lines  links  tokens  usd
demo  quick  261001-d1a  A     frontmatter  declared-at-start  no        script  first-of-kind  2026-10-01  2026-10-01  quick-id/git  1      3      1/0/0  23500   0.028000
demo  quick  261003-d3c  C     frontmatter  ?                  no        none    incremental    2026-10-03  2026-10-03  quick-id/git  0      0      1/0/0  16000   0.022000
units: n=4 quick=4 plan=0 tiered=4 untiered=0 conflicts=0 repos=1 present=4 comparable=4 git_evidence=4 ...
```

(Synthetic demo data, two rows of four.) Lists the units of work that `ingest` reconstructed. A unit is a GSD quick task (a
directory `.planning/quick/<id>-<slug>/`) or a GSD phase plan (`.planning/phases/<dir>/<id>-PLAN.md`) in a working tree of a
repository that some session worked in, that a planning-file reference named, or that `RIGORSCOPE_REPO_ROOTS` lists, plus the
same units in the stock milestone archives. Its key is `gsd-core:<repo_key>:<kind>:<id>`, where `repo_key` is the home-normalized git
directory. The rules behind each column are in [units](units.md).

- `--json`: one document (`rigorscope.units/2`) with per-unit tier, risk, novelty, start, end, size, cost, links, attribution,
  confounders (models, effort, fast mode, Claude Code version, worker mode, environment snapshot) and the blocks `catch`,
  `escape` and `rework`, each `{ "label": "unavailable" }` for now.
- `--tz ZONE`: the zone of the `start` and `end` columns (default `TZ`).
- Filters `--repo`, `--tier`, `--framework`, `--runtime` select units; `--model` and `--role` select calls, and a unit is then
  listed only when it has a matching attributed call. Values are as for `cost`.
- `--link-confidence medium|low`: `medium` (default) counts high and medium links; `low` also attributes a scope whose only link
  is low. Any other value is a usage error.
- `--evidence`: print each unit's `u:` id and its links' `l:` ids for `rigorscope evidence`.
- `--population` and `--sheet`: as above.

Columns: `repo` (name, or the full key when two repositories share a name), `kind`, `id`, `tier` with its `signal`, `timing` and
`conflict`, `risk`, `novelty`, `start` and `end` with `dates` (their sources), `files` and `lines` (outside the planning
directory), `links` (scopes by best confidence, high/medium/low), `tokens` and `usd` (attributed cost). `?` is unknown, never
zero. The listing prints one block per population, forward first, each with its own `population:` line (n, costed count and a
low-evidence flag below 10 costed units), table and `units:` and `coverage:` lines. Beneath the blocks: `window:`, `links:`,
`attribution:` (attributed, unattributed overlap and unlinked buckets that sum to the main-section total), `incomplete:`,
`unrecorded:`, `overhead:`, `locations:`, `repeats:` and `labels:` (which says catch, escape and rework are `unavailable`).

Exit codes: 0 whatever the content (also with no units or no store); 1 on a pending migration, a newer store or a symlinked state
directory; 2 on a usage error.

### tier

```
$ rigorscope tier
stratum: gate-or-hook units=33 compared=A,B,C low_evidence=C ...
tier  n   costed  tokens_median  usd_median  low_evidence
A     11  11      2250           0.008953    no
```

Per-unit cost by rigor tier inside each risk stratum: one table per stratum with rows A, B, C and `?`, the nearest-rank median
and p75 of tokens, notional dollars and window shares over the costed units, a low-evidence flag per row below `--min-n` costed
units, the confounders that changed or are unknown in each comparison, and up to five ranked leads with evidence ids. It prints no
score, no figure across strata and no verdict. `catch` and `escape` print `unavailable`.

- `--min-n N` (default 10), `--since`, `--until`, `--tz`, `--json`, `--evidence`, `--population`, `--sheet`,
  `--link-confidence`: as for `units`. `--include-inferred` includes units whose tier came from probe files.
- `--repo`, `--tier`, `--framework`, `--runtime`, `--model` and `--role` narrow the report, with the values and meaning they have in `units`.

Exit codes: as `units`.

### calibrate

```
$ rigorscope calibrate
pairs: pairs=5 ledger_only=0 (units with both a ledger line and a reconstruction; ledger-only units are in no field)
tier: agree=1 disagree=1 unknown=3 n=5 ledger_unrecorded=0 low_evidence=yes
start: agree=4 disagree=1 unknown=0 n=5 ledger_unrecorded=0 low_evidence=no median_min=? max_min=? within=30 compared_by: instant=0 day=5
```

Compares what the forward ledger recorded with what reconstruction found for the same units. A unit is a pair when it has both;
a unit with a ledger line and no reconstruction is counted in `ledger_only` and in no field. Each of the four fields (`tier`,
`start`, `end`, `session`) prints `agree`, `disagree`, `unknown` and `n`. A time from a day-precision source is compared by day.
There is no total, rate or composite and no per-unit verdict.

- `--json`: one versioned document. `--tz ZONE`: the zone for day comparison. `--evidence`: add the `u:` ids of disagreeing units.

Exit codes: 0; 1 on a pending migration or a newer store; 2 on a usage error.

### unit-start

```
$ rigorscope unit-start --kind quick --id 261030-a1b --tier-source plan-at-start
ledger: start gsd-core:~/repos/alpha/.git:quick:261030-a1b
```

Appends one line to the forward ledger, `~/.rigorscope/ledger/units.jsonl`, and prints one line. The ledger is how a unit that runs
from now on gets an exact tier, time and session instead of a reconstructed one. It opens no database and creates no file other
than the ledger; it reads the current directory's git repository, the clock and the environment. `ingest` reads the ledger back,
and `units` shows a unit with ledger lines as `forward`. A default-off GSD capability can call both commands for you; see
[operations](operations.md#the-forward-ledger-capability).

- `--kind quick|plan` and `--id ID` (both required): a quick id is `YYMMDD-xxx`, a plan id `NN-MM`, `NNN-MM` or `NN.M-MM`.
- `--tier A|B|C`, `--tier-source declared-at-start|plan-at-start|declared-at-close|unknown`: the declared tier and where it came
  from. `plan-at-start` reads the tier letter from the unit's PLAN frontmatter; give no `--tier` with it. A tier and the source
  `unknown` exclude each other.
- `--command NAME`, `--runtime NAME`, `--session-id ID`: the command that ran the unit, the runtime, and the session id (unset,
  the value of `CLAUDE_CODE_SESSION_ID` when that is a lower-case uuid, else null).
- `--start ISO`: a UTC instant; on `unit-start` it defaults to the clock. Neither start nor end may be later than the time of the
  call.

The line holds exactly these fields, in order, each unknown one `null`: `v`, `record`, `line_id`, `ts`, `unit_key`, `framework`,
`repo_key`, `kind`, `native_id`, `tier`, `tier_source`, `command`, `runtime`, `session_id`, `model_hint`, `start`, `end`, `status`,
`gsd_version`. No branch name, path, prompt, response or command text is written. A line is one LF-terminated write of at most
2048 bytes and the file is never rewritten.

Exit codes: 0 appended; 1 the state directory or ledger is a symlink or could not be written; 2 a usage error, a rejected value, a
working directory that is not in a git repository, or git unavailable. A rejected call writes nothing and never echoes the value.
A caller should continue after any non-zero exit: the step must never break a pipeline.

### unit-close

```
$ rigorscope unit-close --kind plan --id 03-01 --status failed --end 2026-10-28T13:00:00Z
```

Appends the `close` line and prints `ledger: close <unit_key>`. It takes `--kind`, `--id`, `--tier`, `--tier-source`, `--command`,
`--runtime`, `--session-id` and `--start` with the meaning they have in `unit-start`, and adds
`--status complete|failed|abandoned` (unknown when omitted) and `--end ISO` (default the clock; an end before a given `--start` is
rejected). On a close line `--tier-source` may be `declared-at-close` (the default when `--tier` is given) or `unknown`. A close
with no start line is valid. Exit codes are those of `unit-start`.

## Environment

- `HOME` decides where the state lives (`~/.rigorscope/`).
- `RIGORSCOPE_PRICES_DIR`: an absolute directory of price files for `cost`.
- `RIGORSCOPE_NOW`: fixes the clock to a UTC instant (a test seam). Reports then say `(clock fixed by RIGORSCOPE_NOW)`. Any other
  value is a usage error.
- `TZ`: the default zone of `--tz`.
- `RIGORSCOPE_WINDOWS_USERS_DIR`: the directory whose subdirectories are searched for a Windows `.claude/projects` (transcript root
  discovery). Unset uses the WSL mount default; the empty string switches Windows discovery off. See [sources](sources.md).
- `CLAUDE_CONFIG_DIR`: when set, non-empty and absolute, that directory is read as a transcript root and is the configuration
  directory the environment snapshot reads (else `~/.claude`).
- `RIGORSCOPE_INSTALLED_BASE_FILE`: the absolute path of a JSON file whose top-level `sha` is the installed GSD base sha; read only
  by `ingest`. Unset, relative or unusable: `base_sha` is `?`, never an error.
- `RIGORSCOPE_LOCAL_MODS_DIR`: the absolute path of a git repository whose HEAD is recorded as `local_mods_head`; read only by `ingest`.
- `RIGORSCOPE_GSD_CORE_CHECKOUT`: the absolute path of a gsd-core checkout; read only by `doctor`, for the `roster:` drift check.
- `RIGORSCOPE_REPO_ROOTS`: absolute directories separated by `:`, each inside one git repository whose units `ingest` should
  reconstruct although no session worked in it. An entry is never walked; a bad or non-repository entry is skipped and counted in
  `root_skipped=` of the `units:` line. The scheduled ingest sees the variable only if its service environment sets it.
- `HOOK_TELEMETRY_DIR`: the directory your OpenTelemetry receiver writes; read by `ingest` as the live OTel source.
