# Architecture

This page states the design decisions that shape rigorscope, in the order a reader meets them. Where a rule is
checked by a test, the test enforces it; the rest are conventions. A change that breaks one is a change of design.

## What it is for

rigorscope reads the traces an AI-assisted development pipeline leaves behind and shows, per unit of work, what it cost and
what it caught or missed. It is a measuring tool for one developer machine. It is not a gate, a dashboard service or a
telemetry client.

## Local, advisory and metadata only

- Nothing leaves the machine. There is no network egress and no telemetry vendor.
- rigorscope never blocks, denies or gates anything. It reports. It installs no hooks.
- The store holds ids, timestamps, names, counts, token counts, verdicts, durations and file paths. It holds no prompt text,
  response text, command text or file contents.
- Reports give ranked leads with evidence, never one score and never pass or fail. They are designed to show a sample size,
  a source label and the confounders that changed in a window next to a figure. A low sample is flagged, not hidden.

## One unit record, with honest gaps

- Adapters emit units in one shared shape: identity, tier, start and end, cost and confounders. Catch, escape and rework
  figures are reported where a source exists and shown as unavailable otherwise. Adapters never write reports.
- Every value that can be missing is nullable and carries a source label (for example measured, otel, transcript,
  derived, estimated, reconstructed, ledger or unavailable). A missing value is shown as unknown, never as zero.
- A unit is forward (it has a ledger line) or reconstructed (rebuilt from git and planning artifacts). Both populations are
  labeled, and a report says which it used.
- Cost is shown as tokens by class, with an API-equivalent amount labeled notional and, where known, a share of the
  subscription window.

## The forward ledger

- The forward ledger is optional. A default-off capability adds prompt steps to the planning workflow that append lines per unit. rigorscope does
  not depend on it for correctness: without it, units are reconstructed and labeled so.
- The ledger is one user-level, append-only file with a closed line format. Two CLI commands are its only writers, one
  bounded line per write, and lines are never rewritten or deleted.
- A ledger line is validated by one function that the writer and ingest both use. The unit key comes from one function that the
  reconstruction also uses, so a ledger key and a reconstructed key cannot drift apart.
- The overhead of those steps is estimated from the size of their prompt text and reported. It is an estimate, not a measurement.

## Stack

- Node.js 24.15 or later, plain ESM, built-in `node:sqlite`, `node:test` and `util.parseArgs`. There are no runtime
  dependencies; one is added only when a named trigger fires.
- All database access goes through one module, so a change of binding touches one file.
- Git is read through the `git` command with an argument array, never a shell string.
- The dashboard design is static HTML with inline SVG, with no network or build step.

## Store

- The store is kept forever and migrated in place. Its sources age out, so it cannot be rebuilt from them.
- Keys are chosen so that ingest is re-runnable and resumable. Integer columns merge by field-wise maximum, so streaming
  lines never sum, a later smaller value never lowers a stored one, and the numbers converge whatever the file and line order.
- Redaction happens at ingest and denies by default: a field is read only through an explicit allowlist entry and a shape
  check. A failing value becomes unknown, and only its column name is counted. Home prefixes are normalized to a placeholder form
  before they are stored.
- Ingest is the normal writer, and the migrate command writes only to apply a migration. Hooks and the ledger step never
  open the database.
- A pending migration is opt-in on an existing store. Only the migrate command applies one, and only after it takes a backup
  and verifies that backup against its manifest. Every other open of an unmigrated store fails safe and changes nothing.
- A released migration is not edited. For the recent ones a test pins the digest of the SQL text.
- Derived tables live in a separate database that can be rebuilt from the store at any time.

## Window usage

- The five-hour and weekly subscription windows are read from the one usage cache that Claude Code keeps in its main config
  file, read-only, through an explicit allowlist of key paths. Nothing else in that file is read, stored, hashed or echoed.
- The per-row window share is derived in the rebuildable database and labeled estimated.

## Fixtures and tests

- Test data is built by code, hand-written, or derived from real sources and then scrubbed; test/PROVENANCE.md says which. Tests run against temporary
  homes and stores.
- Known-bad subjects and canary plants prove that a guard fails when it should, before the guard is trusted.
