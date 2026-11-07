# Operations

Everything rigorscope writes lives under `~/.rigorscope/`. Nothing else on the machine is created or changed: transcripts and every other
source are read-only input.

## The state directory

- `~/.rigorscope/` is created with mode 0700 (under umask 077); the files in it are mode 0600.
- `store.db` is the durable store (with `store.db-wal` and `store.db-shm` while a connection is open); `derived.db` is rebuilt by `cost`;
  `ingest.lock` exists only while an ingest (or a `preserve-scrub --apply`, which takes the same lock) runs; `backups/` exists once the
  backup helper has run; `ledger/units.jsonl` is the forward ledger, appended to by `unit-start` and `unit-close`, which open no database
  and create nothing else.
- The ledger is the only copy of the forward records: it is not rebuilt from any source, and `scripts/backup-store.mjs` does not cover it.
  Copy `ledger/units.jsonl` yourself before any risky operation.
- If `~/.rigorscope` is a symlink or not a directory, rigorscope refuses to use it, writes nothing through it and exits 1 with one line that
  holds no path. A `store.db` written by a newer rigorscope is refused (exit 1) rather than modified.

## The ingest lock

At most one `ingest` runs at a time. The lock is the file `~/.rigorscope/ingest.lock`, created exclusively (mode 0600) with one JSON line:
the process id, the start time and, on Linux, the process start token (so a reused process id is told from the holder). It holds no host
name or user name.

- A live holder: the second `ingest` prints `ingest: skipped, another ingest holds the lock (pid N since T)` and exits 0. It does not wait,
  open the store or write a run row.
- A dead holder, or a live process id whose start token differs: the lock is stale and the next `ingest` takes it over, under a guard file
  (`ingest.lock.takeover`) so two runs that judged the same stale lock never both get it. A guard left by a crashed takeover is removed once
  it is older than 10 seconds or its process is dead. An empty or unreadable lock file is treated as held for 60 seconds and stale after that.
- The lock is released when the run finishes, when it fails, and when it stops on SIGTERM or SIGINT. A symlink at the lock path is refused.

If a run was killed with SIGKILL the lock stays behind until its process is seen to be dead; the next `ingest` removes it. You never need to
delete it by hand; if you must, check first that no `ingest` is running.

## Exit codes

- `0`: success; also a skipped run because the lock is held, and a run that found unknown token-bearing records (it reports them and goes on).
- `1`: rigorscope's own failure: the state directory or lock path is a symlink, the store is newer than this rigorscope, an existing store
  has a pending migration (`ingest` refuses it with one stderr line and writes nothing, and so do `cost` and `evidence` whenever they must
  rebuild `derived.db`; `doctor` exits 0), or a chunk of an ingest failed (the run is recorded as `failed`, the chunks committed before it
  stay, and a re-run resumes).
- `2`: usage error or the runtime check failed. `143` / `130`: an `ingest` stopped by SIGTERM / SIGINT at a chunk boundary.

## Interrupting and resuming

A SIGTERM (for example `systemctl --user stop`) or SIGINT (Ctrl-C) sent to a running `ingest` is honored at the next chunk boundary. No
transaction is open at that point, so the open chunk is never partly written. The run records its `ingest_run` row as `failed` with
`error_code` `SIGTERM` (or `SIGINT`), releases the lock, prints one line to stderr and exits 143 (SIGINT: 130). The committed chunks and
their cursors stay; the next run resumes each file from its cursor, and the store ends equal to one uninterrupted run. A second signal
during the stop ends the process at once; its lock is recovered by the stale takeover. SIGKILL cannot be caught: the open chunk is rolled
back by SQLite, the lock stays until the next run takes it over, and the `ingest_run` row stays `running` until then. `doctor` reports a
latest run whose status is not `ok`.

## Backing up the store before an upgrade

The store is kept forever, and a newer rigorscope may migrate it in place (forward-only migrations, never a rebuild from sources, because
sources age out). The only way back from a migration is a copy taken before it, so a pending migration is applied only by
`rigorscope migrate --apply`, which takes and verifies that copy first with the same backup code as the helper. No other command applies one.

`scripts/backup-store.mjs` takes, verifies and reads such a copy with nothing but Node 24.15 or newer. It takes no lock and never writes,
migrates or checkpoints the live files: it opens them read-only. By default it uses the state directory under your home directory;
`--home DIR` selects `DIR/.rigorscope` instead. It prints no absolute path. Four modes (`--verify`, `--check` and `--sql` exclude one
another; with none the helper backs up):

- Back up: `node scripts/backup-store.mjs --label pre-upgrade` (`--label` is lowercase letters, digits and hyphens) writes
  `<state dir>/backups/<label>-<UTC stamp>` (directory 0700, files 0600), copying `store.db` and, when present, `derived.db` with the SQLite
  online backup, so rows still in the `-wal` file are in the copy. Each copy is verified (SHA-256 before and after, an immutable read-only
  open, `PRAGMA integrity_check` and `user_version`) before `MANIFEST.txt` is written. Nothing is ever overwritten or deleted; a failed copy
  prints `backup: FAILED` and exits 1 with no manifest.
- Verify: `node scripts/backup-store.mjs --verify --of latest --label pre-upgrade` re-checks a backup against its manifest.
- Check: `--check` runs the integrity check read-only on the live files (`--of live`, the default) or on a backup (`--of latest` or `--of <name>`).
- Query: `--sql "SELECT ..."` runs one statement on a read-only connection (`--db store`, the default, or `--db derived`); a statement that writes fails. Exit codes: 0 success, 1 a failed backup, verify, check or statement or nothing to act on, 2 a usage error.

To revert to a backup: stop any `ingest` and an installed timer, copy the verified `store.db` of the backup over the live `store.db`
with any file-copy tool, remove the live `store.db-wal` and `store.db-shm` files, run `node scripts/backup-store.mjs --check`, and go back
to the older rigorscope (a rigorscope refuses a store newer than itself). `derived.db` is rebuilt by the next `cost`. A backup holds the
whole store, all history, so keep it in its 0700 directory and delete a dated directory yourself when you no longer need it; see
[privacy](privacy.md).

## Applying a pending migration

When a newer rigorscope needs a migration, every command that would open the store read-write refuses it with one stderr line (exit 1),
and `doctor` reports `migration_pending`. The daily timer fails the same way until you apply it. Run `rigorscope migrate` (a dry run that
lists the pending migrations), then `rigorscope migrate --apply`, which takes the ingest lock, writes and verifies a `pre-migrate` backup,
and only then applies each migration in its own transaction. If `--apply` reports a failure, nothing newer than the verified backup is
lost; restore from the backup as above. See [cli](cli.md#migrate).

## Checking OTel provenance after an upgrade

`node scripts/check-otel-provenance.mjs` is a read-only comparison of the stored OTel provenance rows with the files. It exits 0 when every
file matches, 1 when a file differs or the store cannot be opened, and 2 on a usage error. A differing file means its provenance rows do
not describe its current lines; the check repairs nothing, and an `ingest` replaces a file's provenance rows only when it rereads that
file from its start.

## Removing all state

Delete the directory `~/.rigorscope/` (make sure no `ingest` is running). Nothing else is installed or changed by rigorscope, so that
removes everything; the next `ingest` rebuilds the store from the sources that still exist. Sources that have aged out are gone for good,
which is why the store is not rebuilt casually. This also deletes `ledger/units.jsonl`, which no source can rebuild: move it aside first
if you want to keep the forward records.

## Usage snapshots: how they accrue

The window share needs at least two usage snapshots inside one window. Each `ingest` reads the cache in `~/.claude.json` once and stores
one snapshot per distinct `fetchedAtMs`; transcript `usageReport` records add a snapshot each time the usage command was run. A second
`ingest` before Claude Code refreshed the cache stores nothing new (`unchanged=1`); that is the dedup, not an error. With one ingest a
day, two snapshots rarely fall inside one five-hour window, so `window_5h` stays `?` for most rows; the weekly column fills with fewer snapshots.
Running `ingest` more often gives the estimator more intervals. The cache holds only the latest values, so past snapshots cannot be read
again; snapshots are kept in `store.db` and removing all state removes them.

## Refresh the price table

The notional dollars of `cost` come from the newest `data/prices-YYYY-MM-DD.json` in the repository (see [sources](sources.md#price-table)).
Prices change; to refresh them:

1. Read the vendor's pricing page by hand. rigorscope never fetches it.
2. Copy the newest price file to a new file named with today's date, set `date_read` to that date and `reread` to `true`, and update the
   rates and `notes` from the page (dollars per million tokens; keep the `validated` status only on rows you have checked against a
   measured cost).
3. Run the tests; the conformance test in `test/unit/price-table.test.mjs` checks the validated rows and the write multipliers.
4. Commit the new file. The next `cost` sees a different table sha and rebuilds `derived.db`; the dollars then use the new rates for all
   history.

To go back, delete the new file. A table in another directory can be tried without committing it by pointing `RIGORSCOPE_PRICES_DIR` at an
absolute directory holding it. An unusable table never stops `cost`: it prints one warning line and `?` dollar cells, and exits 0.

## Preserve copy

Once the daily ingest runs, `store.db` is the long-term copy of the OTel data: the files under
`~/.local/share/rigorscope/preserve/hook-telemetry/` are only an extra ingest source and can stop growing. The live receiver directory is
read-only to rigorscope; nothing in it is ever written.

`preserve-scrub` is a rewrite of rigorscope's own preserve copy, and the one command that writes outside the state directory. `--apply`
takes the ingest lock first (and therefore creates the state directory, mode 0700, if it is absent); when an `ingest` holds the lock it
prints a skip line, rewrites nothing and exits 0, so run it again later. The dry run takes no lock. Before anything else, back up the
directory; then run it as a dry run; then run `--apply` once:

```
$ rigorscope preserve-scrub
$ rigorscope preserve-scrub --apply
```

The removal is irreversible, so the backup is the only way back. A changed file is written to a temporary file in the same directory
(mode 0600, named `.scrub-` plus a process id, random text and the file name) and renamed over the original; the temporary file is
removed on any error, and a leftover `.scrub-*` file after a killed process is safe to delete. A second `--apply` changes nothing.
Whether to widen the rule set with `--full` is your decision.

## Freshness

Every `cost` and `evidence` report starts with a freshness block ([cli](cli.md#cost)). It answers one question: is the report behind the
machine? It reads `store.db` and never the source files.

- Each source line gives the newest record time, the last ok ingest run, the limit in hours and a state. The limit is 36 hours for the live
  sources (`transcript`, `otel`). A source is STALE when the age of its newest record, or the age of its last ok run, is strictly greater
  than the limit.
- The two clocks tell different stories. An old record with a recent run means ingest is current and the source looks idle (an idle period, a stopped receiver). An old run means ingest itself has not run: run `rigorscope ingest` or schedule it. A source that never ran
  reads `STALE: no ingest run recorded for this source`.
- For `otel` only the files under the live directory count, so a preserve copy never hides a stale live source. `usage` is not live and
  reads `not rated`. STALE never changes an exit status and never withholds a number.

## The daily schedule

The 30 day window of OTel receiver files ages data out, so `ingest` should run every day. `rigorscope schedule install` installs two
systemd user units from `units/rigorscope-ingest.service` and `units/rigorscope-ingest.timer`; those files are the only source of what is
installed and of the PATH that the node check walks.

- Service: `Type=oneshot`; `Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin` (the PATH trap: a default systemd user PATH can
  find an older Node first, and an older Node makes the daily run exit 2 at the runtime check, silently, so the unit sets its own PATH);
  `ExecStart=/usr/bin/env node %h/repos/rigorscope/bin/rigorscope.mjs ingest` with a `ConditionPathExists` on that script; `UMask=0077`,
  `NoNewPrivileges=yes`, `Nice=10`, and `TimeoutStartSec=6h` (a oneshot unit has no timeout by default, so a hung ingest would hold the lock
  forever; `doctor` reports a lock older than that as `lock_old`).
- Timer: `OnCalendar=*-*-* 04:10:00` local time, `Persistent=true` (a day missed while the machine was off runs at the next start),
  `RandomizedDelaySec=15min` with `FixedRandomDelay=true`, and `Unit=rigorscope-ingest.service`.

Installing and reverting. Read the dry run (`$ rigorscope schedule install`), apply it (`$ rigorscope schedule install --apply` writes the
two files and runs `systemctl --user daemon-reload` and `systemctl --user enable --now rigorscope-ingest.timer`; a differing existing file
is saved first as `NAME.bak-STAMP`), and check `rigorscope doctor` the next day. The install refuses (exit 2, nothing written) when the node
on the unit PATH is missing, below 24.15.0 or without the built-in sqlite module, when this checkout is not `~/repos/rigorscope` (the unit
hard-codes `%h/repos/rigorscope`), or when a destination path is a symlink or not a regular file. To revert: `systemctl --user disable --now
rigorscope-ingest.timer`, remove the two unit files from `~/.config/systemd/user` (or `$XDG_CONFIG_HOME/systemd/user`), then
`systemctl --user daemon-reload`.

## Scheduling without systemd

`schedule install` is systemd only (Linux and WSL with a user bus). Elsewhere `ingest` is an ordinary command, so any scheduler that runs
`rigorscope ingest` once a day does the job. These are notes, not installers, and are not tested on native Windows or macOS. When systemd
is not available `doctor` prints the lead `timer_not_configured` and the `timer:` line reads `not_configured`; judge freshness from the
`freshness:` line. If systemd is running but `systemctl --user` cannot reach your user bus (a `su`, `sudo -u`, cron or ssh shell without
`XDG_RUNTIME_DIR`), `doctor` prints `timer_unverified`; run it from a normal login shell.

Whatever you use: run it once a day or more often, use a node at v24.15.0 or newer (give the full path to node and to
`bin/rigorscope.mjs`; a scheduler's PATH is usually shorter than your shell's), and never run two at once (the lock makes the second exit 0).

- Windows Task Scheduler (PowerShell): `New-ScheduledTaskAction -Execute '<full path to node.exe>' -Argument '"<full path to
  rigorscope>\bin\rigorscope.mjs" ingest'`, `New-ScheduledTaskTrigger -Daily -At 4:10am`, settings `-StartWhenAvailable
  -AllowStartIfOnBatteries`, then `Register-ScheduledTask -TaskName 'rigorscope-ingest'`. Inside WSL a systemd user timer fires only while
  the distro is running, so on a machine that mostly stays in Windows use a Windows task with `wsl.exe -d <distro> -- <full path to node>
  <full path to rigorscope>/bin/rigorscope.mjs ingest` as the program. `doctor` inside WSL then still prints `timer_missing` or
  `timer_not_configured`; judge by `freshness:`.
- macOS launchd: a plist in `~/Library/LaunchAgents/` with `ProgramArguments` (full paths to node, `bin/rigorscope.mjs` and `ingest`) and a
  `StartCalendarInterval` of 04:10, loaded with `launchctl bootstrap gui/$(id -u) <plist>`; remove with `launchctl bootout`.
- cron, anywhere cron exists: `10 4 * * * /full/path/to/node /full/path/to/rigorscope/bin/rigorscope.mjs ingest`.

## Putting rigorscope on PATH

Nothing here is automatic: rigorscope never installs itself, and every step that changes the machine outside `~/.rigorscope/` is yours.

1. Check the runtime: `node -e "console.log(process.version)"` must print v24.15.0 or newer. With an older node (or one built without
   sqlite) every command exits 2 with one stderr line naming the fix and creates nothing.
2. From a checkout run `npm link` (usually no sudo with a user-owned npm prefix; no install scripts and no dependencies, so nothing is fetched from a registry). In a fresh
   shell `command -v rigorscope` must resolve. If npm's global bin directory is not on PATH, link `<checkout>/bin/rigorscope.mjs` to a
   directory that is. Undo with `npm unlink -g rigorscope`.
3. A linked checkout runs whatever branch is checked out in it, and so does a daily timer that points at it.
4. First backfill: `ingest` with no flags reads every discovered root, which can be gigabytes of transcripts and takes minutes; run it
   niced where `nice` exists. Ctrl-C stops it at the next chunk boundary and the next run resumes.
5. Schedule the daily run, then check `rigorscope doctor` the next day.

## The forward-ledger capability

The forward ledger is filled by an optional GSD capability that ships in this repository as `capabilities/forward-ledger/`. It is advisory
and off by default: it records when a unit of work starts and ends, and a missing line is shown later as an unrecorded unit, never as a
failure. It is turned on per project (the `forward_ledger.enabled` key in that project's planning config; no global switch). What it adds:

- Two small skills, `gsd-forward-ledger-start` and `gsd-forward-ledger-close`, each telling the agent to run one of the two commands and to
  continue when `rigorscope` is not callable or exits non-zero.
- Steps that run the skills before and after each wave of a phase plan (close only for a plan of the wave that finished and has a SUMMARY).
- A contribution to the quick planner, which asks it to make `unit-start` part of the first task and `unit-close` part of the last.
- Cost: the text rendered for one unit is estimated (characters divided by 4) at about 266 tokens for a phase plan and about 181 for a quick
  task; a test fails above 300. The skill descriptions also sit in every session's skill list; that cost is separate.

Reading the lines `units` prints beneath the strata: `incomplete:` lists forward units with a start and no close, oldest first;
`unrecorded:` is the share of units seen since the first ledger line that have no line; `coverage:` prints the tiered share beside a 90%
target (a target is a line, not a verdict); `window:` splits the calls since the first ledger line into four buckets that add up to the
total; `overhead:` prints the estimated text the ledger steps add per unit. Attribution is per session and agent, so a main session that
touched two or more units goes wholly to overlap even when every unit has a ledger line: no improvement is claimed for main sessions.

Install, enable, disable (run from a checkout; `gsd-tools` belongs to the installed GSD):

1. Install the capability: `node ~/.claude/gsd-core/bin/gsd-tools.cjs capability install <checkout>/capabilities/forward-ledger --scope
   global --yes`. The installer discloses that instruction surfaces are installed verbatim and not content-scanned; read the skill and
   fragment text in the checkout first. Re-install after every edit of the source.
2. Land the skills: `capability install` does not place skills in the agent's skills directory; the GSD installer (or a local script) does.
3. Enable it for one project from that project's root: `node ~/.claude/gsd-core/bin/gsd-tools.cjs config-set forward_ledger.enabled true`.
4. Check: `gsd-tools loop render-hooks execute:wave:pre --raw` in that project lists a `forward-ledger` entry once the key is true. Start a
   new agent session: a running session keeps the skills it loaded at its start.
5. Disable: set the key to false the same way. The capability stays installed and does nothing.

Where a repository's planning directory is gitignored, every work tree has its own config, and the key must be set in each. To revert: set
the key to false everywhere, move the two skill directories aside (a move, not a delete), run `capability remove forward-ledger --yes`, and
delete the key. The ledger file is the only copy of the forward records; copy it before any step that could remove it.

## Doctor

`rigorscope doctor` is the health check ([cli](cli.md#doctor)). It is advisory: it exits 0 whatever it finds. It reads both databases
read-only after the same lazy `derived.db` rebuild that `cost` runs, takes no lock and writes nothing outside `~/.rigorscope/`; on a home
with no `.rigorscope` it creates nothing.

- Thresholds are strict and exact, on whole seconds: a lock older than 21600 s (6 hours) is `lock_old`; a usage snapshot older than
  604800 s (168 hours) is `snapshot_old`; a source is STALE after 36 hours. A future-dated lock or snapshot raises nothing.
- `UNVERIFIED` means a check could not run (for example `systemctl --user` has no bus), not that it passed.
- Honest limits: the `cursors` offsets are as of each file's last visit; a different signed-in account cannot be told apart from a reset,
  so `usage_discontinuity` is a lead and not a verdict; `doctor` cannot know whether the timer will fire tomorrow.
- The `roster` section compares the gsd-core artifact roster that ships with rigorscope, a snapshot at a recorded ref, with a gsd-core copy that is
  available, and raises the lead `roster_drift` only when it saw a difference. The checkout is the absolute path in
  `RIGORSCOPE_GSD_CORE_CHECKOUT` (read through `git diff --name-only`; nothing is executed from it and the value is never printed); when
  the variable is unset the installed version from the latest environment snapshot is used. With neither, the drift is unknown with its
  reason, no lead is raised and the verdict is unchanged. The `unit-locations` and `unclassified` lines show what the unit scan could not read and
  the files in no roster entry, as counts per repository; a repository whose latest scan predates the counters shows `?`, never 0.

## Signals and their consumers

Every figure that `cost`, `doctor`, `units`, `tier` and `calibrate` print belongs to a registered signal. The registry
(`src/report/signals.mjs`) gives each signal an id, the report sections that print it, the kind of reader who acts on it (for
example cost and model choices, whether a report can be read, whether ingest needs attention, keep, kill or retune questions about
tiers) and the decision it informs: a number should not exist without someone who acts on it.

`rigorscope doctor --signals` prints the registry, one line per signal, in registry order. It is the source of truth; this page does
not copy it. With `--json` it is a usage error.
