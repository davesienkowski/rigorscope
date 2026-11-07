# Fixture provenance

How each family of test data in this tree was made, so a reader can judge what a passing test proves. No fixture here holds
a real person, account, home path, session id, commit id or credential; the identity checks of the test suite assert that.

## test/fixtures builders (the `*.mjs` files and `cases/`)

Built by code. Each builder writes a temporary home, transcript tree, store or git repository from literals in the file, on
a fake clock. Names, paths and ids are placeholders (reserved user names such as `exampleuser`, reserved mail domains such
as `example.com` and `example.invalid`, session ids with a repeated short pattern). Where a test needs a shape that looks
like a secret or a drive path, the literal is joined from parts at run time so the shape never appears as text. Nothing is
derived from real data.

## test/canary (plants, scenarios, leaky normalizers)

Hand-written. A plant is a unique marker value placed in a field the tool must never store; a leaky normalizer is a
deliberately broken copy of a real one. The canary tests plant markers, run the real code and scan the stored bytes and the
captured output for them, and run a broken copy to show that the scan can fail, so a guard is shown to fail before it is trusted.

## test/prohibitions (and its fixtures)

Hand-written. Each rule has a known-bad subject and a clean twin. The test requires the rule to fail on the bad subject and
pass on the clean one. The subjects are small code or text samples written for the rule, with placeholder names.

## test/golden

Derived and scrubbed. The labels were written by hand by a labeler who read only primary sources (planning files and git
history of the source repositories), not the parsers. The inputs snapshot was taken from those repositories and then
scrubbed: repository names became placeholders, commit ids became synthetic ids that resolve in no repository, and names of
documents from other projects became neutral names. Scrub proof, by kind: a counts-only run of the pre-publication gate over
the directory, and a row-by-row comparison of the scorer's output before and after the scrub (21 rows compared, none
differing). The tests in this directory check the ids and the scorer join.

## Stock-run fixtures

Derived from a supervised run of the real planning workflow on a synthetic project, recorded as the files that run wrote.
They are kept only in the development tree; the two tests that read them skip, with a visible reason, where the fixtures are
absent.

## test/unit, test/integration, test/invariant

Tests, not data. Where a test needs data it builds it with the builders above, or inlines it as a literal with placeholder
values.

## test/fixtures/public-demo

Built by code, with known answers derived by hand. `build.mjs` writes a small git repository (fixed dates, the git identity
`fixture`) and a home with five transcript files, from constants in the file; nothing is copied from a real session.
`expected.json` holds every number the demo prints, each with a one-line derivation from the builder's constants and the
shipped price file, written before the first run of the tool over the fixture. `test/public-demo.test.mjs` compares the
real CLI output to it value by value, and shows that the comparator fails when one value is changed or removed.
