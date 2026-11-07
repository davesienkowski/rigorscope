# Getting started

This page takes you from a fresh clone to your first cost report and shows how to point rigorscope at your own repositories.
Everything it describes runs locally and writes only under `~/.rigorscope/`.

## Install

You need Node 24.15 or newer (the built-in `node:sqlite` module comes with it) and `git` on your PATH.

Run `git clone` on the repository (its URL is in the `repository` field of `package.json` once published), change into the checkout and run:

```
node bin/rigorscope.mjs --help
```

`npm link` once puts `rigorscope` on your PATH; without it, run `node bin/rigorscope.mjs` from the checkout. There is nothing
else to install: rigorscope has no npm dependencies. With an older Node the command exits with status 2 and prints one line
that says how to fix it; it creates nothing on disk before that check passes.

## See known answers first

```
npm run demo
```

The demo builds a small synthetic repository and five synthetic transcript calls in a temporary directory, runs the real
commands over them, prints the output and checks the numbers against `test/fixtures/public-demo/expected.json`. It reads
nothing from your machine and removes what it made.

## The state directory

`~/.rigorscope/` (mode 0700) holds the store (`store.db`), the derived data (`derived.db`), a lock file, backups and the
forward ledger. The store is kept and migrated in place; see [operations](operations.md) for backups and removal. The
`HOME` environment variable decides where it lives.

## The first ten minutes

```
$ rigorscope ingest
$ rigorscope doctor
$ rigorscope cost --by role,model
$ rigorscope units
```

1. `ingest` finds every Claude Code configuration directory on the machine and reads the session transcripts under each
   `projects/` directory. It keeps token counts and a few labels, never prompts or responses. A second run reads only what
   was appended.
2. On a machine with no transcripts the output is a set of lines with zero counts per source (`transcript: files=0 ...`).
   That is the whole message: nothing was found, and the lines name the sources that were looked at. It is not an error and
   the exit status is 0.
3. `doctor` is advisory and exits 0 whatever it finds. On a fresh machine it reports `UNHEALTHY`: before the first `ingest` it
   lists `no_store`, and in a normal shell it lists `timer_missing` until the daily timer is installed (in a shell where
   `systemctl --user` cannot be reached it lists `timer_unverified` instead). If the `node` found on the unit's PATH is older
   than 24.15 it also lists `unit_node_below_floor`. These are findings, not failures.
4. `cost` prints a freshness block, one row per role and model, and a `=total` row; `units` lists the units of work found in
   the repositories your sessions worked in.

## Pointing it at your own data

- Claude configuration directories: `ingest` discovers them itself. To read exactly one, run
  `rigorscope ingest --root <directory>`. If `CLAUDE_CONFIG_DIR` is set in your environment, that directory is read as a
  transcript root too.
- Repositories: units are found in the repositories your sessions worked in. To add a repository no session reached, list a
  directory inside it in `RIGORSCOPE_REPO_ROOTS` (absolute paths, separated by `:`).
- An OpenTelemetry receiver: if you run one, `ingest` also reads its files from the directory your receiver writes. Set
  `HOOK_TELEMETRY_DIR` to that directory; with none, the source is reported as not configured. See [sources](sources.md).
- A daily run: `rigorscope schedule install` shows what it would write and `--apply` installs a systemd user timer. It works
  only from a checkout at `~/repos/rigorscope`; from anywhere else it refuses and writes nothing, so run `ingest` by hand or
  write your own timer. See [operations](operations.md).

## Reading unknown values

A figure rigorscope cannot establish is printed as `?`, and in `--json` as `null` with the label `unavailable`. It is never
shown as zero. Dollars are notional (what the tokens would cost at the shipped price table), not a bill. `>=` before a dollar
figure marks a lower bound. Catch and escape print `unavailable`; see [known limits](known-limits.md).

## Next

[cli](cli.md) describes every command and option, [units](units.md) how units, tiers and links are worked out, and
[privacy](privacy.md) what is stored and what never is.
