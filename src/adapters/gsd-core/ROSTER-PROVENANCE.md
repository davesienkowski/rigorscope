# Roster provenance

`roster.json` is a snapshot of the artifact names the upstream gsd-core project writes. It is a record of what was read,
not a claim of completeness: a name that matches no entry is counted as unclassified.

- Upstream ref: 49ea1a9b0c1e (12-character prefix of the commit recorded in `roster.json`, field `ref`)
- Upstream version: 1.19.0
- Date taken: 2026-11-04
- Method: read from the upstream agent, workflow and template files; name patterns only. No artifact content was read and
  no file of a user project was opened.

Each entry's `cite` field names the upstream file and line range that writes the artifact. Where it reads "derived from
gsd-core workflows and templates at the pinned ref; no upstream file cited", the entry was read from the upstream workflows and
templates but is not tied to one upstream file or line range, so a reader cannot open a single upstream line to confirm it. An
entry whose upstream writer was not found says so in `cite_note`.

To refresh the roster, read the same upstream files at a newer ref, update `ref`, `version` and `taken` in `roster.json` and
the three lines above, and run the drift check.
