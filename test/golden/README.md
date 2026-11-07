# Golden set for rigorscope parsers

## Purpose
This directory holds 21 hand-labeled units of AI-assisted development work. They are the ground truth that
the future rigorscope parsers are tested against. The labels were written by an independent labeler who read only
the primary sources (planning files and git history of the source repositories) and did not read any rigorscope
plans, research or code. Because the labeler never saw the parsers, agreement between a parser and a label is
evidence about the parser, not a restatement of it.

Files: units.jsonl (one JSON object per line, schema_version 1) and this README.

## What a unit is
A unit is one GSD work item of one of two kinds. A quick task is a directory under .planning/quick/<id>-<slug>/.
A phase plan is one NN-MM-PLAN.md under .planning/phases/NN-<slug>/ together with its SUMMARY and the phase-level
VERIFICATION, REVIEW and fix files that cover it. Phase-level review and verification findings are attributed to a
plan only when they name files that plan created; the labeler notes say when attribution is partial.

## Fields and allowed values
- unit: repo (directory name), framework (always gsd-core), kind (quick | phase-plan), native_id, start, end (ISO
  with offset; usually minute precision; one end is date-only), age_days (days from unit end to the labeling reference date, floored),
  time_note (how start and end were read). Timestamps keep their UTC offsets: an offset is not an identity value and the
  scorer reads the times.
- repo: the seven source repositories appear as the placeholders repo-a to repo-g, and commit ids as synthetic ids that
  resolve in no repository; the scorer joins rows on the repo field and reads no commit id (test/golden/golden-ids.test.mjs checks the ids).
- tier: value (A | B | C | none | unknown), source (declared-at-start | declared-at-close | declared-mid-unit |
  inferred | unknown), evidence. NOTE: declared-mid-unit is an addition to the brief's four source values; this README is
  the authority on allowed values. none means the artifacts were searched and no tier is recorded (source is then
  unknown by convention). unknown would mean the artifacts could not be searched; no unit in this sample needed it.
  declared-mid-unit was added because one tier file landed between plan and implementation. inferred is supported
  by the schema but unused in this sample.
- risk_class: list of {tag, evidence}. Tags used: gate-or-hook, global-config, push, credentials, security, parser,
  script, docs, datastore, validation, business-logic.
- catches: list of findings raised during the unit. Each has source (plan-checker | code-review | verifier |
  refute-pass | probe-gate), disposition (raised | fixed | overridden | open), led_to_change (yes | no | unknown),
  evidence, note, and either finding_id (one entry per enumerated finding) or, only for round-level entries where
  ids were never enumerated, finding_ids (a descriptive label) with count (number of findings the entry stands for);
  a grouped count-only entry has no finding_id.
  catches_status is found | none-found; an empty list always carries catches_checked (what was looked at) and
  catches_checked_evidence.
- escapes: later commits that fix something the unit introduced. Each has fix_commit (12-char sha), fix_repo, link,
  confidence, days_after_unit_end (negative means the fix commit predates the unit end), evidence, note.
  escapes_status is found | none-found | unknown. none-found carries escapes_checked (what was searched); unknown
  carries escapes_unknown_reason.
  link values: explicit-introduced-by means a later artifact (context, summary or commit message) names this unit's
  finding or defect as the thing being fixed; blame-inferred means git blame of the lines the fix changed points at
  this unit's commits and no artifact says so; candidate means a plausible follow-up with no explicit or blame
  support; trailer and revert and debug-resolution are defined by the schema but no unit in this sample has them
  (the repos use no fix trailers, and no revert of a sampled unit was found).
  confidence: high (artifact names it and blame agrees), medium (one of the two), low (neither or weak).
- human_edits: {present (yes | no | unknown), method, evidence}.
- held_out (bool) and labeler_notes (short, factual).
- Extra keys beyond the brief: time_note, note, count, finding_id, finding_ids, *_checked, *_checked_evidence, escapes_unknown_reason.
  Parsers may ignore them.

Scoring rule for escapes: score recall and precision on entries with link explicit-introduced-by or blame-inferred
(confidence high or medium). Entries with confidence low (link candidate) are weak hints: a parser that omits them
is not wrong and a parser that emits them is not wrong; report them separately. Three units (odr, gyo, jox) have
escapes_status found on a single low candidate only.

Convention used to separate catches from escapes: a finding raised and fixed before the unit's closing artifact
(or, for a phase plan, before the phase completion or verification commit) is a catch only. A finding raised in the
unit's own review file but left open at unit close, with the fix landing in a separate later unit, is recorded as a
catch (disposition open) and also as an escape of that unit. Fixes inside the unit are never escapes.

## Sampling procedure
Pool: repositories with .planning/quick or .planning/phases directories that are tracked in git. The
first count was repo-c 111 quick dirs and 9 phases, repo-e 33 and 4, repo-d 13 and 5, repo-a 11,
repo-g 7 and 1, repo-b 1 and 5, repo-f 3 and 2, and many smaller repos. Several
other repos hold 100 to 140 quick dirs each but were not sampled. Filters: the unit has a SUMMARY (or equivalent),
and age of at least 7 days was preferred.

Selection within strata was purposive, not random, because the rare properties (declared tier, confirmed later fix,
zero catches, no git trail) needed targeted search. The labeler first built a table of every repo-c quick dir with
its commits, review, verification, refute and tier files, then chose units to cover: repos (repo-c, repo-g,
repo-e, repo-d, repo-a, repo-b, repo-f), kinds (15 quick, 6 phase plans), tiers (A, B,
C and none), zero-catch units, zero-escape units, and units with a later fix. Candidate fix pairs were found by
reading the next quick's context for a named earlier unit and by git blame of the lines each fix changed.

Held-out selection was seeded. Seed 20261027, generator mulberry32. One fixed pick (the repo-g quick, so the
oddest repo is hidden) and then four draws, one per group, each drawn uniformly from the group minus units already
held out. Draw log (group, pick): fixed: repo-g:261001-wza; escape-A-quick: repo-c:261022-wup; small-repo-quick: repo-e:261007-rni; phase-plan: repo-b:01-03; zero-catch: repo-d:29-01.
Groups: escape-A-quick (g5g, wup, 1ry, ku7 in repo-c); small-repo-quick (repo-a il0, jox, rni); phase-plan (the six
phase plans); zero-catch (93t, 2te, 0d4, il0, the repo-b plan, the repo-g plan, the repo-d plan).
To repeat the held-out step: apply mulberry32 with that seed to those groups in that order, calling the generator
once per group and indexing the filtered pool with floor(r * pool size).

Important bias: every unit with a declared tier (repo-c units from the day the tier convention began) is under 7 days old at the
reference date, because that convention was new when the labels were written. Their escape labels carry a short observation
window. The repo-b unit has only about 3 hours of repository history after it. Thirteen of 21 units are at least 18
days old.

## Strata counts
By repo:
| repo | units |
|---|---|
| repo-c | 12 |
| repo-e | 3 |
| repo-g | 2 |
| repo-d | 1 |
| repo-a | 1 |
| repo-b | 1 |
| repo-f | 1 |

By kind:
| kind | units |
|---|---|
| quick | 15 |
| phase-plan | 6 |

By tier (value / source):
| tier | units |
|---|---|
| none / unknown | 13 |
| A / declared-at-start | 3 |
| B / declared-mid-unit | 1 |
| C / declared-at-start | 1 |
| A / declared-at-close | 1 |
| B / declared-at-close | 1 |
| C / declared-at-close | 1 |

By catches_status:
| status | units |
|---|---|
| found | 15 |
| none-found | 6 |

By escapes_status:
| status | units |
|---|---|
| none-found | 10 |
| found | 8 |
| unknown | 3 |

Escape entries: 10 in 8 units; 5 units have at least one medium or high
confidence entry. Catch entries: 101 (grouped), 10 of them with led_to_change unknown.
human_edits.present is unknown for all 21 units.

## Held-out units (5)
- repo-c 261022-wup
- repo-e 261007-rni
- repo-g 261001-wza
- repo-d 29-01
- repo-b 01-03

Files: the 16 training units are in units.jsonl; the 5 held-out units' labels are in holdout.jsonl (split by the
orchestrator after labeling). Rule: anyone writing or tuning a parser (human or agent) reads only
units.jsonl and never opens holdout.jsonl; only test/golden/holdout-acceptance.test.mjs reads holdout.jsonl, and its failures are
reported as counts per field, not as the expected values. The ids above stay listed so the seeded draw can be
repeated; ids without labels do not leak the answers.

## How each label kind was determined
- Times: first and last commit naming the unit id or touching its directory, read with git log; for units whose code
  commits do not carry the id, the commits named in the SUMMARY. Two units have weaker times (file modification time,
  or a date-only end); see their time_note.
- Tier: tier files (RIGOR-TIER.md, PROBES-SKIPPED notes), SUMMARY or CONTEXT frontmatter and sections. Where a tier
  text exists, the source is judged by the commit order of the tier text against the plan and implementation commits.
- Risk class: from the changed files and the tier text, never from the title alone.
- Catches: review files with finding ids, review-fix files and dispositions tables, refute-pass verdicts,
  plan-checker notes in SUMMARY, probe-gate records, verification statuses, and the fix commits that name finding ids.
- Escapes: (1) later artifacts naming the unit; (2) commit messages naming the unit; (3) git blame at the parent of
  each candidate fix commit, tallying the commits that last touched the removed or modified lines; (4) log of the
  files the unit created after the unit end. Pure-insertion fix hunks cannot be blamed and weaken attribution.
- human_edits: not determinable for any unit. There are no git notes in any sampled repo; every repo has a single
  author identity for the sampled commits (a second author name in one repo is a tool or machine identity
  difference, not evidence of a different person); and the agent trailer on commits follows the harness era (it is
  absent on every commit of some plainly agent-made units in some eras and present on only some commits of
  others, where a GSD CLI docs commit has none). Parsers should not infer human edits from a missing trailer.

## Known limits
- One labeler, no second pass; the spot check below is the intended second signal.
- Escape detection is incomplete by construction: a defect never fixed or fixed under an unrelated message is
  invisible. none-found means searched and not found.
- Units in repo-g are special: the planning directory is gitignored there and the quick unit's code lives on
  feature branches, so one quick has escapes unknown and one phase plan has no git trail at all. Parsers must not
  turn unknown into zero.
- A phase-level review attributed to one plan is a judgment call.
- The seeded held-out draw hid three units with no usable escape label (the repo-g quick has escapes unknown, the
  repo-d plan has escapes unknown, the repo-b plan has a 3-hour window). The held-out set therefore tests tier
  and catch parsing more than escape parsing. The draw was not redone.
- Time fields are minute precision.
- Ages are measured to the labeling reference date; escape windows differ widely per unit (from hours to months).
- Evidence line numbers are as of the labeling date; planning files are append-heavy and may change.
- No evidence entry quotes file content. Finding ids such as CR-01 are headings, not task content.

## For the owner's spot check
Five units, mixed strata, at least one with an escape. For each, open the pointers and confirm or refute the label.

### repo-c 261002-ku7
Why this one: explicit escape: a review finding in the unit, fixed by the next quick.
Tier label: none, unknown. Escapes label: found (000011110000 explicit-introduced-by/medium).
Pointers to open:
- repo-c: .planning/quick/261002-ku7-fix-audit-script-review-findings/261002-ku7-PLAN.md
- repo-c: .planning/quick/261002-ku7-fix-audit-script-review-findings/261002-ku7-CONTEXT.md
- repo-c: .planning/quick/261002-ku7-fix-audit-script-review-findings/261002-ku7-SUMMARY.md:86
- repo-c: .planning/quick/261002-ku7-fix-audit-script-review-findings/261002-ku7-REVIEW.md:61
- repo-c: .planning/quick/261002-ku7-fix-audit-script-review-findings/261002-ku7-REVIEW.md:91
- commit 000011110000
- commit 000011120000

### repo-c 261022-g5g
Why this one: tier A declared at start, three escape entries of mixed confidence.
Tier label: A, declared-at-start. Escapes label: found (000003310000 explicit-introduced-by/high; 000003410000 blame-inferred/medium; 000011200000 blame-inferred/medium).
Pointers to open:
- repo-c: .planning/quick/261022-g5g-c6-allowlist-write-gate-deny-agent-write/261022-g5g-CONTEXT.md:170
- repo-c: .planning/quick/261022-g5g-c6-allowlist-write-gate-deny-agent-write/261022-g5g-SUMMARY.md:65
- repo-c: .planning/quick/261022-g5g-c6-allowlist-write-gate-deny-agent-write/261022-g5g-REVIEW.md:99
- repo-c: .planning/quick/261022-g5g-c6-allowlist-write-gate-deny-agent-write/261022-g5g-REVIEW.md:135
- repo-c: .planning/quick/261022-g5g-c6-allowlist-write-gate-deny-agent-write/261022-g5g-REVIEW.md:99
- repo-c: .planning/quick/261022-g5g-c6-allowlist-write-gate-deny-agent-write/261022-g5g-REVIEW.md:135
- commit 000003310000
- repo-c: .planning/quick/261022-wup-g5g-hardening-parse-errors-deny-bash-sym/261022-wup-CONTEXT.md:7
- commit 000003410000
- repo-c: .planning/quick/261023-3qr-allowlist-write-gate-braceexpand-work-bu/261023-3qr-SUMMARY.md:20

### repo-c 261022-fws
Why this one: tier B declared mid-unit, zero escapes, rich catch history.
Tier label: B, declared-mid-unit. Escapes label: none-found.
Pointers to open:
- repo-c: .planning/quick/261022-fws-append-only-state-activity-and-clear-nud/RIGOR-TIER.md:3
- commit 000011140000
- commit 000001020000
- commit 000001030000
- repo-c: .planning/quick/261022-fws-append-only-state-activity-and-clear-nud/261022-fws-CHECK-DISPOSITION.md

### repo-g 01-03
Why this one: phase plan with no git trail at all (unknown escapes).
Tier label: none, unknown. Escapes label: unknown.
Pointers to open:
- repo-g: .planning/phases/01-pilot-s2-capability-audit-fork-queue-round-trip/01-03-PLAN.md
- repo-g: .planning/phases/01-pilot-s2-capability-audit-fork-queue-round-trip/01-03-SUMMARY.md
- repo-g: .planning/phases/01-pilot-s2-capability-audit-fork-queue-round-trip/01-03-SUMMARY.md:72

### repo-a 260701-il0
Why this one: zero catches, zero escapes, code commits not matched by the unit id.
Tier label: none, unknown. Escapes label: none-found.
Pointers to open:
- repo-a: .planning/quick/260701-il0-apply-phase-2-code-review-follow-ups-1-w/260701-il0-PLAN.md
- repo-a: .planning/quick/260701-il0-apply-phase-2-code-review-follow-ups-1-w/260701-il0-SUMMARY.md
- commit 000011420000
- repo-a: .planning/quick/260701-il0-apply-phase-2-code-review-follow-ups-1-w/260701-il0-SUMMARY.md:3

## Scoring (rigorscope)

rigorscope scores its unit rules against these labels in its test suite (plan 02-03). Golden risk tags come from a
wider vocabulary than rigorscope's fixed risk vocabulary (D-05: gate-or-hook, security, parser, global-config,
script, docs), so each golden tag is mapped through this table before scoring:

| golden tag | D-05 tag | reason |
|---|---|---|
| gate-or-hook | gate-or-hook | same tag |
| global-config | global-config | same tag |
| parser | parser | same tag |
| script | script | same tag |
| docs | docs | same tag |
| security | security | same tag |
| push | security | D-05 security includes push |
| credentials | security | D-05 security includes credentials |
| datastore | (none) | no D-05 tag; one training unit |
| validation | (none) | no D-05 tag; one training unit |
| business-logic | (none) | no D-05 tag; unused in training |

The scorer uses exactly this table (test/golden/score.mjs `GOLDEN_TAG_MAP`; a golden test checks that the two agree).
A golden tag that maps to (none) is counted in `unmapped_gold_tags` and is not scored as a miss; two golden tags that
map to one D-05 tag count once. The table was fixed from the label vocabulary above and the research measurement on
the training file, never from the held-out labels.

Files of the scoring (rigorscope):

- `inputs/manifest.json`: the 21 units (16 training, 5 held out) as `{ repo, kind, native_id }`, kind `quick` or
  `plan`; a golden kind `phase-plan` is read as `plan`. The held-out ids were copied from the list above, never from
  the held-out label file.
- `inputs/inputs.jsonl`: a metadata-only snapshot of what rigorscope's collector reads for each unit (tier letters
  and where they were read, paths, commit shas, author times, per-file statuses), one row per manifest entry.
- `score.mjs`: the scorer shared by the two tests below (the mapping table above is its `GOLDEN_TAG_MAP`).
- `golden.test.mjs`: scores the 16 training units in the suite and prints the training diagnostics.
- `holdout-acceptance.test.mjs`: the only reader of holdout.jsonl; prints one line of counts and never fails on the
  score.

Training values measured with `risk-rules-2026-10-30` (plan 02-03):

```
golden training: units=16 located=16 tier_value=15/16 tier_timing=4/7 risk_exact=5/16 risk_jaccard=0.536 risk_unknown=0 unmapped_gold_tags=2 rules=2026-10-30
golden training risk tags: docs tp=0 fp=0 fn=2; gate-or-hook tp=8 fp=0 fn=0; global-config tp=2 fp=1 fn=0; parser tp=0 fp=0 fn=5; script tp=3 fp=2 fn=2; security tp=3 fp=2 fn=1
```

The one tier value miss is repo-c 261022-g5g, whose tier is written only in a CONTEXT section and a SUMMARY body
line, which are not tier signals. The training floors in `golden.test.mjs` (tier value 15, risk Jaccard 0.53, risk
exact 5) are regression guards, not targets.

To regenerate the snapshot, run from a rigorscope checkout, with the main clone of each of the seven repositories
above as an argument:

```
node scripts/golden-inputs.mjs --manifest test/golden/inputs/manifest.json --out test/golden/inputs/inputs.jsonl <path to a clone> ...
```

then review the diff (paths, ids and numbers only), run `node --test test/prohibitions/no-owner-literals.test.mjs`
and commit; never edit the snapshot by hand.
