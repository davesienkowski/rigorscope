# Units: tier, risk class, links and attributed cost

A unit of work is a GSD quick task or phase plan that rigorscope rebuilt from a repository's planning files, or that the forward
ledger recorded. Each unit carries a rigor tier, when that tier was declared, a risk class, a novelty flag, dates, a size, the
sessions linked to it and their attributed cost. This page says how each is worked out and what is never used. Unknown is always
shown as unknown (`?` or NULL), never as zero, an empty set or a default. See [cli](cli.md#units) for the listing and columns.

## Populations: reconstructed and forward

A unit is `reconstructed` when it was rebuilt from planning directories, and `forward` when the forward ledger (`unit-start` and
`unit-close`, read by `ingest`) holds at least one line for its key. It is one row either way: the ledger is a per-field source
merged into the unit, never a second row. For a forward unit each field takes the ledger value first and falls back to
reconstruction where the ledger gave none:

- tier: the earliest start line's tier, else the latest close line's tier; signal `ledger`, timing `declared-at-start` or
  `declared-at-close`. Only a tier declared at the start takes part in a tier comparison. An `unknown` ledger tier is not used.
- start and end: the earliest start and the latest end any line gave, labeled `ledger` and shown as `recorded`. An end before the
  start is raised to the start and labeled `clamped`. A ledger time is the clock of the CLI call, not a git time: it is not
  corroborated, so a unit whose end comes from the ledger makes no medium interval link.
- status: the latest close line's status (`complete`, `failed`, `abandoned`); a start with no close is `incomplete` and stays in
  every count; a reconstructed unit with no ledger line has no status.
- A ledger-only unit (a key the planning scan never saw) is a forward unit with no directory and every reconstruction-derived
  field unknown.

Reports never add the two populations. `units` and `tier` print a forward stratum and a reconstructed stratum side by side, each
with its own n, costed count and low-evidence flag (fewer than 10 costed units), and `cost` carries a `population` dimension on its
unit-level splits. `--population` selects one.

## Which units, and which files

- A quick task is a directory `.planning/quick/<id>-<slug>/`; a phase plan is `.planning/phases/<dir>/<id>-PLAN.md`, the directory
  starting with the plan's phase part and a dash, or `<CODE>-<phase>-<slug>` with a project code.
  Units are read in every live working tree of every repository a session worked in, a planning-file reference named, or
  `RIGORSCOPE_REPO_ROOTS` lists. The stock archived locations are read too: `.planning/milestones/<label>-phases/<dir>/` and
  `.planning/milestones/<label>-quick/<dir>/`, where `<label>` is up to 64 letters, digits, `.`, `_` or `-` starting with a letter
  or digit. A unit's key does not depend on where its directory is.
- The first directory read wins for an id seen for the first time: archive roots oldest label first (labels compare by their digit
  runs, so `v1.2` comes before `v1.10`), the live root last. For an id that already has a unit, the stored directory is read while
  it is present. A second directory for the id in the same root is a duplicate (`dup_ids=`); in another location it is a
  `repeat_id`: it may be an id reused by a numbering reset or a renamed directory later archived, and the two are not told apart. Neither
  is opened or merged into the unit, with one exception, the move rule.
- A unit that moves into a milestone archive keeps its key, its stored directory, its tier, its artifacts and its cost, and stays
  present. After every working tree is scanned, per known id: if the stored directory still exists anywhere, it is read and the
  archive copy is a `repeat_id`; if it is gone from every tree and exactly one archive directory has it as its former live path
  and holds the unit's PLAN, that is a move (`moved` counts it the first run that reads it, then 0); if two or more archive
  directories have that former path, the one that already has stored artifact rows is read, else the id is `move_ambiguous` and
  nothing is read; if none has it, the unit is not present. A unit first seen in an archive is stored with the archive directory
  and is not a move. Nothing here is rename detection.
- What `units --json` `dir` shows: the stored first dir. A unit stored live and then moved shows its old live path; a unit first
  seen in an archive shows the archive path. The `locations:` counters (`units_archived`, `moved`) are the other source.
- A row belongs to a unit when its path, with an archive prefix rewritten back to its former live path, lies under the unit's stored
  directory written the same way. Rows of one file name merge into one record, so a moved file counts once.
- `unit.id_repeats` is the number of second directories for the unit's id in another location in its latest scan: 0 when scanned
  with none, unknown when the repository has no scan record. A repeated id is one unit, never split; `units` prints `repeats:`
  with the `u:` ids and says the unit's cost, commits and ledger lines may include another milestone's activity.
- Counted by name and never read (the `locations:` line of `ingest`, [sources](sources.md#locations-and-counters)): workstream trees,
  a bare `PLAN.md`, `NN-PLAN.md`, `NN-MM-KK-PLAN.md`, a plan file name that carries a project code, any other name ending `PLAN.md`,
  bracket-form and custom phase directories, quick directories with no quick id, and directories under `.planning/milestones/` that
  are no archive root.
- Only four files are opened: the unit's PLAN (tier letter, `files_modified`), its SUMMARY (tier letter, `completed:` date), and for
  a quick task the first rigor-tier file and the first probes-skipped file (tier letter). Each other file maps to one of ten
  artifact roles by name only.

Known limits: `moved` is a first-run count, so for a settled repository it reads 0 and is not a total. `repeat_id` also counts plain
tree divergence (a stale linked worktree holding a live directory the main tree has archived), so with many worktrees it is an
upper bound. A project-code directory needs a two-digit phase part after the code. A plan file inside a directory skipped for its
name or a symlink is covered only by that directory's `skipped=` entry. A new live directory that reuses a stored directory's name
reads as an in-place edit of it.

## Dates

- Start: a quick task's id date (a local day, `quick-id`); else the earliest git time of the unit (its artifacts' first commits and
  its commits' author times, `git`); else the earliest own-artifact modification time ever seen (`mtime`); else unknown.
- End: the latest git time; else the SUMMARY's `completed:` date as a local day (`frontmatter`); else the latest modification time;
  else unknown. An end before the start is raised to the start, labeled `clamped` and counted in `end_clamped`.
- `git_evidence` is true exactly when a git time exists. An untracked planning directory gives no git time, so its units are dated by
  the id, the SUMMARY or file times, with the source shown, and every link to such a unit is lowered one level.
- An archived unit takes its git times from the history of its former live path (a path rewrite, no rename detection). The end is
  the last real change of that path; the move itself is not a change. Where the former path has no history before the archive
  path's first-add time, the date falls back to `mtime` or is unknown.

## Tier

A tier is read from four places only, in this order:

| Order | File | Where in the file | `tier_signal` |
|-------|------|-------------------|---------------|
| 1 | `<id>-PLAN.md` | a top-level `tier:` key in the leading frontmatter | `frontmatter` |
| 2 | `<id>-SUMMARY.md` | a top-level `tier:` key in the leading frontmatter | `frontmatter` |
| 3 | `RIGOR-TIER.md` or `RIGOR-TIERS.txt` in a quick directory | a line starting `Tier:` followed by A, B or C | `tier-file` |
| 4 | `*-PROBES-SKIPPED.md` in a quick directory | its first non-empty line, when it starts `Tier B` or `Tier C` | `probes-skipped` |

The highest place that carries a letter wins; within one place the bytewise-first file name wins. A unit with no letter anywhere has
tier `?` and signal `none`: it is listed and counted and never folded into A, B or C. `tier_conflict` is true when places disagree;
the higher place still wins. Never a tier signal: a mention of a validate or full flag in plan text, a tier written in a context
file, a tier line in a SUMMARY body, a letter outside A, B and C, and any other file of the unit directory.

`tier_timing` says when the winning signal was declared, from commit order. The signal time is the oldest commit that changed a
column-0 `tier:` line of the winning file while its leading frontmatter carries a tier letter, else the commit that added the file.
`declared-at-start`: strictly before the first implementation commit (a commit changing a path outside `.planning/`).
`declared-at-close`: otherwise, when the SUMMARY exists and the signal is at or after its first commit. `declared-mid-unit`:
otherwise, when implementation commits exist. NULL when unknown (an untracked planning directory, git unavailable). A tier read from
a probes-skipped line is left out of tier comparisons unless asked for.

## Unit commits

A commit belongs to a unit only when the conventional-commit scope of its subject names it: `type(<id>):` or `type(quick-<id>):` for a
quick task (the scope may be a comma- or space-separated list containing the id), `type(<plan id>):` for a phase plan, with an
optional breaking-change mark. Merge commits are skipped. A commit that names the id only in its body is not the unit's. The subject
is read only to test the scope and is never stored.

Known limits: commits without that scope are missed by timing, the risk fallback and novelty. Commits of another unit that uses the
same id as its scope (an id reused across milestones) are included, with one bound: when the planning directory is tracked and the
plan's PLAN file has a first-add commit, only commits authored at or after it count. Without a tracked PLAN there is no bound; such
units are flagged `commits_bounded` false and counted in `plan_unbounded`. Stored facts are never deleted, but derive reads only the
commits the latest complete git scan saw. A phase folder renamed before its first ingest makes the plan's first-add time the rename's.

## Risk class

`risk_class` is a set of tags from a fixed vocabulary: `gate-or-hook`, `security` (publishing, credentials, deletes), `parser`,
`global-config`, `script`, `docs`. `risk_source` records per tag which rule matched. Touched paths are the PLAN's `files_modified:`
list when it has an item, else the files changed by the unit's commits; paths under `.planning/` are not considered. The rule table
is a data file, `data/risk-rules-YYYY-MM-DD.json`, loaded like the price table (the bytewise-greatest dated file; a symlink, an
oversized file, a non-ASCII byte, bad JSON, an unknown key or a bad pattern is refused with a fixed error code).

| Rule id | Tag | Matches |
|---------|-----|---------|
| `gate-hook-dir` | `gate-or-hook` | a `hooks/`, `gate/` or `gates/` directory |
| `gate-hook-name` | `gate-or-hook` | gate, guard or hook as a name part (with one exception) |
| `sec-push-cred` | `security` | push, credential, secret, token, auth, redact, scrub, vetting, provenance, allowlist, isolation, permission |
| `parser-name` | `parser` | parse, lexer, tokeniz, normaliz, classif, frontmatter, discriminator, dedup |
| `global-config` | `global-config` | `~/.claude/`, `$HOME/.claude/`, `$HOME/.gsd/`, a `settings.json` or `settings.local.json`, managed-settings, `.wslconfig` |
| `script-ext` | `script` | a `.sh`, `.mjs`, `.cjs`, `.js`, `.py` or `.ts` file outside test and fixture paths |
| `docs-only` | `docs` | every considered path ends in `.md` or `.txt` |
| `script-unless-specific` | `script` | dropped when a more specific tag is present |

A set that matches no rule is `[]` with source `none` (a known empty set). A unit with no touched path at all has `risk_class` NULL
with source `no-evidence`, shown as unknown. `~/` and `$HOME/` are one prefix. To change the rules, add a new dated file and never edit
a shipped one.

## Novelty

`novelty` is `first-of-kind` or `incremental`, from the files the unit's commits added: unknown when the unit has no commits or git
could not answer; `first-of-kind` when an added code path lies in a module directory (its first three directory segments) that did
not exist at the parent of the unit's oldest commit, or when an added code file sits directly in a `commands` or `bin` directory;
otherwise `incremental`. Code is any path outside `.planning/` and test or fixture directories that is not a `.test.` file or
markdown or text. It is a column only, never a stratum.

## The golden set

The rules above are scored against a hand-labeled golden set in `test/golden/`, written before the parsers: tier value and timing are
scored separately, risk by exact match and Jaccard. The floors in `test/golden/golden.test.mjs` are regression guards measured when
they were set, not targets. A held-out label file is read by one test only, which prints counts and never fails on the score.
`node scripts/golden-inputs.mjs` regenerates the committed collector snapshot from clones of the labeled repositories.

## Links and attribution

A unit's cost is the cost of the sessions that worked on it. Links are made at (session, agent) scope: the main thread of a session
and each of its subagents are separate scopes.

| Method | Level | Meaning |
|--------|-------|---------|
| `tool-path` | `high` if the scope wrote the path (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`), else `medium` | a structured tool path of the scope names a unit's quick directory or a phase file starting with a plan id; matched through the repository of the path's directory, so a linked worktree reaches the main repository's unit |
| phase-level ref | `medium` | a ref to a phase directory or a file no plan id prefixes links to the one plan of that directory whose interval overlaps the scope; zero or several overlapping drops it (`phase_dropped`) |
| `slash-command` | `medium` | a slash command or skill call of the scope (quick and phase-plan workflow names only) falls inside exactly one trusted unit interval of that kind |
| `interval` | `low` | the scope's first-to-last call overlaps a unit's interval in a repository its calls resolved to |

A unit with no start or end source, or a plan unit whose commits have no lower bound, has no interval (`no_interval_units`); direct refs
still link. A slash-command or phase-level link is made only when exactly one interval contains the instant and that unit is *trusted*:
its end source is `git` and its end is not shared by five or more units of the repository. Lowering: every link to a unit with no git
dates is one level lower (`lowered_by` `no-git-dates`). A ref whose directory resolved to no repository matches by directory name: one
unit gives a `low` link (`dir-name`), several are `ambiguous`, none `unmatched`; it never counts in the strict mode. `base_confidence`
keeps the level before lowering.

Every main-section call lands in exactly one bucket per mode, decided per scope; a scope's calls are never split. Mode `medium` (the
default) counts `high` and `medium` links: exactly one counted unit takes the scope (`attributed`); two or more send the calls whole to
`unattributed_overlap` (`multi-unit`); only `low` links send them there too (`low-only`); no link at all is `unlinked`. Cost is never
spread over units. Mode `low` (`--link-confidence low`) decides a scope with a high or medium link as `medium` does and counts `low`
links only for a scope with none, so it never reverses a medium decision. The buckets sum to the main-section total by every token class
and by notional cost (`check=ok` on the `attribution:` line). A scope whose transcript refs are unknown (files aged out or a reread
stopped mid-file) is still decided by its known links, and every bucket shows its `refs_unknown` count. OTel-only and harness calls are
outside attribution.

Known limits: a message that writes and reads one file with `Write` and `Read` stores `Read`, so that write counts as read-only
evidence. Attribution is per scope: a scope linked to two units with disjoint intervals is overlap. An interval link only says the
session ran while the unit was open in that repository.

## Confounders

Per unit and link-confidence mode, `units --json` shows what else differed between units, so a tier comparison can be read against it.
Each value comes from the calls attributed to the unit or from stored facts and carries a source and a label; an unknown is null,
labeled `unavailable`, with a source that says why.

| Name | Value |
| --- | --- |
| `model`, `effort`, `fast_mode` | per role of the attributed calls: the sorted distinct values and the count of calls whose value is unknown |
| `cc_version` | the sorted distinct Claude Code versions of the attributed calls |
| `worker` | `worktree`, `subagent` or `inline`, with counts; it cannot tell a managed worker from another session in a linked worktree |
| `repo` | the unit's repository display |
| `unit_size` | commits, files and lines outside the planning directory |
| `env` | the fields of the latest environment snapshot at or before the unit's start (`gsd_version`, `base_sha`, `local_mods_head`, `hooks_sha`, `hook_events`, `model_default`, `advisor_model`); units that started before the first snapshot show `before-first-snapshot` |

A unit with no attributed call in the mode has its transcript and worker values null with source `no-attributed-call`. The runtime is
`claude-code` for a unit with at least one high or medium link, else unknown.

## The tier report

`rigorscope tier` shows what a unit cost at each rigor tier inside each risk stratum. Nothing it prints is stored; it is computed at
report time from `derived.db`, and every flag is a parameter of that one run.

- Strata: a stratum is a risk class, in vocabulary order, then `none` (a known empty set) and `unknown`; these are never merged. A
  unit with several risk tags counts once in each of its strata, and no figure is added across strata. `script` is never a stratum for
  a unit that also carries a more specific tag. A stratum with no unit prints no table and is named in the `empty=` list.
- The statistic: a row holds the units of one tier in one stratum. `n` counts every unit; a unit is *costed* when it has an attributed
  call and known tokens, and every cost figure rests on the costed units. The median and p75 are elements of the ascending per-unit
  values at nearest rank `ceil(p x n / 100)` (the median of an even count is the lower middle value), never an average. A unit with
  unknown dollars is left out of that measure and counted in `usd_unknown`. The low-evidence flag is `yes` when a side has fewer costed
  units than `--min-n` (default 10). The `?` row is never compared.
- Unknown and inferred tiers: an unknown tier is in the `?` row. A unit whose tier came only from a probes-skipped line is in no row by
  default and is counted as `inferred_excluded`; `--include-inferred` puts it in its letter row. Such a tier is circular with catch.
- Confounders: for each stratum with two or more compared letters, one `confounders:` line covers the costed units. A categorical
  confounder is `changed` when two or more distinct known values occur; a numeric one when the per-side medians differ. `unknown` or
  `partly unknown` is never counted as unchanged.
- Leads: up to five sentences point at the tier differences with the most evidence behind them, ordered by the smaller side's costed
  count, then the median token gap. Each carries `u:` ids for `rigorscope evidence`. There is no score, no headline figure and no
  verdict: a lead is a place to look.

Read the stratum's table, then its `confounders:` line, then the matching lead. A difference between tiers can be read as the tier's
effect only as far as the changed and unknown confounders allow. On a store where few units carry a tier, a first report is
low-evidence in every stratum and the `?` rows hold most units; that is the honest result, not a defect. Whether a tier is worth keeping
is the reader's decision, and this report decides none. A dollar figure that includes a floor-priced call is printed with `>=`.

## The decision sheet

`units --sheet`, `tier --sheet` and `cost --sheet` add a block after the report. Each row is one question the present numbers can or
cannot support, never an instruction. A row says `can decide today` or `cannot`; `cannot` is information, and the reason says what is
missing. Every row carries `n`, the population, the low-evidence state and up to five evidence ids. Rows come in a fixed order, are never
reordered, ranked or added up, and the sheet prints no count of decidable rows. The floor for unit counts is 10; the floor for
calibrate pairs is 5 compared pairs. Rows: `units-forward-sample`, `units-ledger-use`, `units-unclosed`, `calibrate-tier`,
`calibrate-start`, `calibrate-end`, `calibrate-session` (units); `tier-cost-forward`, `tier-cost-reconstructed`,
`tier-source-comparable` (tier); `cost-forward-sample`, `cost-reconstructed-sample`, `advisor-trial` (cost). The `calibrate-*` rows read
the whole store. The `advisor-trial` row compares advisor-part dollars in the 7 days after the advisor model changed with the 7 days
before, and says `cannot` until the trial window has elapsed and both windows hold advisor parts.

## Known limits

- Catch and escape are `unavailable`; rigorscope cannot say whether a tier pays for itself.
- Most reconstructed units have no recorded tier; the forward ledger exists to change that going forward.
- A plan id reused across milestones is one unit, marked by `id_repeats`; commits that name it attach to it.
- Attribution is per (session, agent) scope: a main session that touched two or more units goes wholly to overlap, even when every
  unit has a ledger line.
- `risk_class` rules come from a small hand-written table; the exception in `gate-hook-name` was derived from one repository's file
  name.
- Novelty has no golden labels and is tested on fixtures only.
