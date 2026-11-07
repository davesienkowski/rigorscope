# Known limits

This page states plainly what rigorscope has not been tested for and what it does not claim. It describes today's coverage only.

## What is not decided by the numbers

- Catch and escape print `unavailable`. rigorscope cannot say whether a gate, hook or tier pays for itself; it shows cost per unit and
  leaves that question open. See [units](units.md#known-limits).
- Tier evidence is thin. Most reconstructed units have no recorded tier, so every tier comparison is flagged low-evidence until enough
  units carry one. A tier report is a list of leads, not a verdict.
- Cost figures are token counts and notional dollars (tokens priced at a shipped table), not a bill. A value rigorscope cannot establish
  is `?`, in JSON `null` with the label `unavailable`, never zero. See [getting-started](getting-started.md#reading-unknown-values).
- Units with no code commit (a plan or a note only) show their cost, a size of zero files and zero lines, and no escape figure; escape is
  `unavailable` for every unit.
- A plan id reused across milestones is one unit, because the key is the repository plus the id. The unit is marked as repeated, and the
  cost, commits and ledger lines of the later milestone that name the id can attach to it. See [units](units.md#which-units-and-which-files).
- Attribution is per session and agent. A main session that touched two or more units goes wholly to an overlap bucket, even when every
  unit has a ledger line, so a forward ledger does not by itself raise the attributed share.

## What has been tested, and where

- Run on Linux under WSL with Node 24.22 and git 2.43. The suite also passed in a container (Alpine Linux, Node 24.15.0, git 2.52.0, no
  network), and under the `America/New_York` time zone on the WSL host. Node 24.15 is the floor; Node 24.13 and 22.22 were only checked to
  the point that they exit 2 with the preflight message. Day buckets and dates follow the process time zone; the demo and the first-run
  checks run under UTC.
- Not tested: macOS (case-insensitive file systems, Homebrew Node builds, `/Users` home paths on a real Mac), native Windows (drive-letter and
  `/mnt/` home forms are unit-tested in the home normalizer only), a file system without POSIX modes (the `~/.rigorscope` mode 0700), a
  `core.autocrlf` setting other than the default, CRLF in markdown inputs, Node 26 or a Node built without sqlite, and any scheduler but
  systemd. Windows Task Scheduler and macOS `launchd` are notes.
- The daily schedule installs only from a checkout at `~/repos/rigorscope` and only as systemd user units. Other schedulers are notes, not
  tested installers. See [operations](operations.md#scheduling-without-systemd).
- The forward-ledger capability steps are unproven when a workflow runs them unattended. Quick tasks are recorded only if the quick
  planner follows the contribution; the phase-plan steps have not been shown to be obeyed on their own. A plan's recorded end is the end
  of its wave. See [operations](operations.md#the-forward-ledger-capability).
- Claude Code transcripts have no published schema. The reader keeps only fields it knows, counts the ones it does not, and records the
  Claude Code version per row, but a new transcript shape can make a count read low; `doctor` lists such
  records as leads.

## What a first run looks like

- `ingest` on a machine with nothing to read exits 0 and prints zero counts for each source (`transcript: files=0 ...`). There is no
  separate "nothing found" message. See [getting-started](getting-started.md#the-first-ten-minutes).
- An inherited `CLAUDE_CONFIG_DIR` adds that directory as a transcript root. On a WSL host the default discovery also reads the Windows
  profile's transcripts; `RIGORSCOPE_WINDOWS_USERS_DIR` set to the empty string switches that off. A first run therefore reads more than
  the checkout it was started from.
- `doctor` on a fresh machine reports `UNHEALTHY`: `no_store` before the first `ingest`, `timer_missing` in a normal shell until the daily timer is
  installed (`timer_unverified` where `systemctl --user` cannot be reached), and `unit_node_below_floor` when the `node` on the unit's PATH is older than
  24.15. Where there is no systemd user manager at all (the container run above, and macOS by design) the timer finding is the lead `timer_not_configured`,
  which is not a problem. It is advisory and exits 0.

## How the first public snapshot was made

The public repository starts from one snapshot made by an export step that is not part of this repository. That step makes a first snapshot
only and has no mode for a second one, so updating the repository needs a separate decision and design. Limits of the step that remain:

- It keeps files out by an allowlist and does not itself exclude the ignore and config files of secret scanners (`.betterleaksignore`,
  `.gitleaksignore`, `.gitleaks.toml`); only the allowlist not naming them keeps them out. A scan of the final tree and history is a separate check.
- Its apply mode accepts any ref and writes the output before the operator compares the printed head with the reviewed one, so the full
  commit id must be passed and the head compared by hand. A check that binds the head (an expected-head option) is not built.
- Path names are not checked for control characters, so a path with a newline or an escape sequence could fake a line of the printed output.
- Only text inputs are refused when they are not UTF-8. Exported blobs are scanned as read, so private text in UTF-16, or a binary file, can
  pass the text scan unless non-UTF-8 and binary blobs are scanned separately.
- A hard kill of the export leaves a copy of its exceptions file in a temporary folder next to the output.
- The export and gate code run from the operator's checkout, not from the commit being exported.

## What is not promised

This page and the README promise no dates, version plans or measured results. The numbers in the demo are synthetic and exist to
show known answers, not to describe any real project.
