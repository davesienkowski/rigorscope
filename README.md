# rigorscope

A local, advisory tool that reads your AI-assisted development history and shows what each unit of work cost: tokens,
notional dollars, the rigor tier it was done under, and the sessions and commits that belong to it. It reads Claude Code
transcripts and the planning files of [gsd-core](https://github.com/open-gsd/gsd-core) projects, keeps metadata only, and
runs entirely on your machine.

## What it does not do

- It does not say whether a gate, hook or tier pays for itself. Catch and escape (what a review found, what slipped through
  later) print `unavailable`. More in [docs/known-limits.md](docs/known-limits.md).
- It never blocks anything, sends anything over the network, or stores prompts or responses.
- Dollar figures are notional: tokens priced at a shipped price table, not a bill. Unknown values print `?`, never zero.

## Requirements

- Node 24.15 or newer with the built-in `node:sqlite` module (an official Node 24.15+ binary has it). With an older Node the
  command exits with status 2 and prints one line with the fix; it creates nothing on disk before that check passes.
- `git` on your PATH, to resolve the repository of each session. Without it `ingest` still runs and resolves those
  directories on a later run.
- No npm dependencies: apart from Node and git there is nothing to install.

## Install

Clone the repository with `git clone https://github.com/davesienkowski/rigorscope.git`, change into the checkout and run:

```
node bin/rigorscope.mjs --help
```

`npm link` once puts `rigorscope` on your PATH (usually no sudo and no registry; a root-owned global npm prefix needs elevated
rights, so prefer a user-owned prefix such as nvm gives); the link runs whichever branch the checkout has.
State is written only under `~/.rigorscope/` (mode 0700). More in [docs/getting-started.md](docs/getting-started.md).

## First run

```
npm run demo
```

The demo builds a small synthetic repository in a temporary directory, runs the real commands over it and checks the output
against known answers. It reads nothing from your machine. On your own machine:

```
$ rigorscope ingest
$ rigorscope doctor
$ rigorscope cost --by role,model
$ rigorscope units
```

On a machine with no Claude Code transcripts, `ingest` exits 0 and prints zero counts for each source it looked at
(`transcript: files=0 ...`). That is the whole "nothing found" message. `doctor` is advisory and exits 0; on a fresh machine
it reports `UNHEALTHY` with findings such as `no_store` (before the first `ingest`) and `timer_missing` (the daily timer is
not installed).

## Quick start

```
$ rigorscope ingest
$ rigorscope cost
$ rigorscope cost --by role,model
$ rigorscope cost --by unit --since 2026-10-01 --until 2026-10-07
$ rigorscope units
$ rigorscope evidence main/total --limit 20
```

`ingest` discovers every Claude configuration directory and reads the transcripts under each `projects/` directory,
keeping token counts and a few labels. A second run reads only what was appended. `cost` prints a freshness block, then
one row per group with tokens by class and notional dollars; `units` lists units of work with their tier, dates, size and
attributed cost.

## Commands

- `ingest`: read transcripts, the forward ledger, usage snapshots and OpenTelemetry (OTel) receiver files into the local store.
- `cost`: tokens and notional dollars by role, model, effort, day, session, repo, tier, unit, framework or runtime; filters, `--json`, `--sheet`.
- `evidence`: the calls and files behind one cost row, a unit (`u:` id) or a link (`l:` id).
- `units`: units of work found in your repositories (GSD quick tasks and phase plans, in live directories and milestone archives such as `.planning/milestones`), with tier, risk class, novelty, size, linked sessions and attributed cost.
- `tier`: per-unit cost by rigor tier inside each risk stratum, with low-evidence flags and no verdict.
- `calibrate`: compare what the forward ledger recorded with what reconstruction found, field by field.
- `unit-start`, `unit-close`: append a unit's start or close to the forward ledger.
- `doctor`: check that the data behind the reports is current and the daily ingest is installed; includes a `roster` check with the lead `roster_drift`.
- `migrate`: apply a pending store migration after a verified backup (a dry run unless `--apply`).
- `schedule`: install the daily ingest as systemd user units (a dry run unless `--apply`); it works only from a checkout at `~/repos/rigorscope`, otherwise run `ingest` by hand or from your own scheduler ([operations](docs/operations.md#scheduling-without-systemd)).
- `preserve-scrub`: remove sensitive keys from the preserve copy of OTel files (a dry run unless `--apply`).

Every command and option is in [docs/cli.md](docs/cli.md). Three helper scripts in `scripts/` run with plain Node and are
not commands: `backup-store.mjs`, `check-otel-provenance.mjs` and `golden-inputs.mjs`.

## Documentation

- [docs/getting-started.md](docs/getting-started.md): install, the state directory, the first ten minutes, your own data.
- [docs/cli.md](docs/cli.md): each command and option, with an example.
- [docs/units.md](docs/units.md): how units, tiers, links and attributed cost are worked out.
- [docs/data-model.md](docs/data-model.md): the two database files, tables, columns and source labels.
- [docs/sources.md](docs/sources.md): what is read from each source, field by field, and what is dropped.
- [docs/privacy.md](docs/privacy.md): the metadata-only rules and the canary test that checks them.
- [docs/operations.md](docs/operations.md): the state directory, backups, migrations, the daily timer, removal.
- [docs/architecture.md](docs/architecture.md): module map, data flow and the design decisions that matter.
- [docs/known-limits.md](docs/known-limits.md): what has not been tested and what is not claimed.

## Repository layout

- `bin/`: the `rigorscope` entry point (runs the Node and sqlite preflight first).
- `src/`: the CLI, ingest, the sources, the derived-data rebuild, unit reconstruction, the ledger and the report renderers.
- `data/`: versioned data files the code reads: the price table and the risk rules.
- `capabilities/`: an optional, default-off GSD capability that records each unit's start and close in the forward ledger.
- `units/`: the two systemd user unit files that `schedule` installs.
- `scripts/`: the demo and the helper scripts above.
- `test/`: unit, integration, canary, invariant, prohibition and golden-set tests and the synthetic fixture builders. `npm test`
  runs everything, `npm run test:fast` a quick subset, `npm run test:public` is the same as `npm test`.
- `docs/`: the pages above.

## License

MIT. See LICENSE.

### Third-party material

`src/adapters/gsd-core/roster.json` is derived from gsd-core, which is MIT licensed. Its copyright line and permission notice are in
[NOTICE](NOTICE).
