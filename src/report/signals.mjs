// The signal registry (plan 01-09, TRUST-09, D-15): every signal that `cost` and `doctor` print has a named consumer
// and the decision it informs, so a number cannot exist without someone who acts on it. SIGNALS is ordered: every
// signal that prints on cost first (in cost output order), then the doctor-only signals in section order. `keys` maps a
// surface to the printed section keys (column-0 `key:` lines) of that surface; an empty array is a signal with no key
// line of its own. A test runs both commands on rich fixtures and compares the printed keys with this table in both
// directions; docs/operations.md carries the human copy. Plan 02-02 adds the `units` surface (the `rigorscope units`
// listing): freshness and labels print there too, and unit-inventory (its population and units lines) prints on no cost
// line, so the ordering rule keeps it last. Plain ASCII. No imports.
export const CONSUMERS = Object.freeze({
  'owner-cost-decisions': 'The owner choosing model and effort overrides for agents and workflows from the cost and window figures.',
  'owner-report-trust': 'The owner deciding, before reading any report, whether the report can be trusted at all.',
  'phase-2-planner': 'The Phase 2 planner deciding whether role attribution is trustworthy enough to build units of work on.',
  'owner-ingest-ops': 'The owner deciding whether the daily ingest is installed, running and keeping up (D-15 does not list this consumer; added for the schedule signals).',
  'owner-rigor-decisions': 'The owner deciding to keep, kill or retune a hook, gate, rigor tier, or agent and model choice for a risk class from the tier report.',
});

const S = (id, keys, consumer, decision) => Object.freeze({ id, keys: Object.freeze(keys), consumer, decision });

export const SIGNALS = Object.freeze([
  S('cost-table', { cost: [] }, 'owner-cost-decisions', 'Which role and model combinations cost the most tokens and notional dollars, and so which override to try.'),
  S('freshness', { cost: ['freshness'], doctor: ['freshness'], units: ['freshness'], tier: ['freshness'], calibrate: ['freshness'] }, 'owner-report-trust', 'Whether every live source is current enough to read the report at all.'),
  S('period', { cost: ['period'], tier: ['period'] }, 'owner-report-trust', 'Which calendar window the figures cover and whether calls with an unknown timestamp fall outside it.'),
  S('window-usage', { cost: ['window usage'] }, 'owner-cost-decisions', 'How much of the subscription windows is already used, before choosing a heavier model or effort.'),
  S('labels', { cost: ['labels', 'labels (otel rows)', 'by-labels', 'scope'], units: ['labels', 'scope'], tier: ['scope', 'statistic'] }, 'owner-report-trust', 'Which figures are measured, derived or estimated, and which rows each label covers.'),
  S('conservation', { cost: ['conservation', 'totals check', 'counts'], units: ['attribution'], tier: ['attribution'] }, 'owner-report-trust', 'Whether the rows add up to the totals, so no call was lost or counted twice.'),
  S('notional-cost', { cost: ['totals', 'pricing', 'notional'] }, 'owner-cost-decisions', 'What the tokens would cost at list prices and which tokens or models are unpriced.'),
  S('window-share', { cost: ['window'] }, 'owner-cost-decisions', 'How much of a subscription window each role or model used, where that can be estimated.'),
  S('join-rate', { cost: ['join'], doctor: ['join-miss'] }, 'phase-2-planner', 'Whether enough OTel requests join to transcript calls to trust role attribution.'),
  S('role-rules', { cost: ['roles', 'rules'] }, 'phase-2-planner', 'Which rule assigned each role, and so how much of the attribution is a guess.'),
  S('agent-name-disagreements', { cost: ['crosscheck'], doctor: ['agent-names'] }, 'phase-2-planner', 'Where the transcript role and the OTel agent name disagree, which marks attribution to doubt.'),
  S('otel-only', { cost: ['otel-only'] }, 'owner-cost-decisions', 'How much OTel-measured usage has no transcript call and is missing from the transcript rows.'),
  S('error-band', { cost: ['error-band'] }, 'owner-cost-decisions', 'How far derived dollars sit from OTel-measured dollars, so how much to trust a derived figure.'),
  S('cost-population', { cost: ['population'] }, 'owner-report-trust', 'Whether a unit-level cost row (tier, unit, framework) is forward or reconstructed, and how many units of each population carry costed calls, so a forward figure is never read as a reconstructed one.'),
  S('decision-sheet', { cost: ['sheet'], units: ['sheet'], tier: ['sheet'] }, 'owner-rigor-decisions', 'Which keep, kill or retune questions the present numbers can support and which need more units first, one row per question with its status, reason, n, population and evidence ids, and never a score, a rank or a recommendation.'),
  S('advisor-trial', { cost: [] }, 'owner-rigor-decisions', 'Whether a full window of advisor-model data exists after the advisor model changed, so the owner can read the advisor parts by model side by side for the keep, kill or retune decision on the advisor model; role-share figures carry the advisor parts as a confounder.'),
  S('verdict', { doctor: ['doctor'] }, 'owner-ingest-ops', 'Whether anything needs doing before the next report: the single line verdict and its counts.'),
  S('ingest-health', { doctor: ['store', 'lock'] }, 'owner-ingest-ops', 'Whether ingest has run, how recently, whether a stuck run holds the lock, and whether a store migration waits for rigorscope migrate --apply.'),
  S('sources-roots', { doctor: ['roots'] }, 'owner-report-trust', 'Which transcript and OTel roots are read, which are ignored as backups and which vanished.'),
  S('cursor-position', { doctor: ['cursors'] }, 'owner-ingest-ops', 'How far ingest has read into each file and whether bytes are waiting behind the cursor.'),
  S('null-session-id', { doctor: ['null-session-id'] }, 'phase-2-planner', 'How many records were dropped for a missing session id and so cannot be attributed.'),
  S('unknown-token-bearing', { doctor: ['unknown-token-bearing'] }, 'owner-report-trust', 'Whether records carry token counts that rigorscope does not read, so the totals are low.'),
  S('unknown-attr', { doctor: ['unknown-attr'] }, 'owner-ingest-ops', 'Which new attribute names appeared in the sources and may need an allowlist decision.'),
  S('ledger-drops', { doctor: ['ledger-lines'] }, 'owner-report-trust', 'Whether forward-ledger lines are being dropped or conflicting, so recording or the ledger writer needs fixing before forward units are trusted.'),
  S('usage-snapshots', { doctor: ['usage', 'discontinuity'] }, 'owner-cost-decisions', 'How fresh the window percentages are and whether they fell without a reset.'),
  S('schedule-health', { doctor: ['timer', 'service', 'unit-node'] }, 'owner-ingest-ops', 'Whether the daily timer is installed and active, its last run succeeded and its node meets the floor.'),
  S('unit-inventory', { units: ['population', 'units', 'links'], tier: ['population'] }, 'owner-report-trust', 'Which units of work were reconstructed, of which kind and repo, and how many carry a tier, so whether a tier comparison has anything to compare.'),
  S('unit-incomplete', { units: ['incomplete'] }, 'owner-report-trust', 'Which started units never closed, oldest first, so the close step or the unit itself needs a look before forward figures are trusted.'),
  S('unit-locations', { doctor: ['unit-locations'], units: ['locations', 'repeats'] }, 'owner-report-trust', 'Which stock gsd-core locations and forms were read or counted as not read, and which units share a plan id with another milestone, so whether a unit total can be trusted or may include another milestone activity.'),
  S('roster', { doctor: ['roster', 'unclassified'] }, 'owner-report-trust', 'Whether the artifact files found in the scanned planning locations are known to the gsd-core roster at its recorded ref, as counts of files not in the roster and the file name stems they look like, so a local layout or a newer gsd-core is not mistaken for a complete read.'),
  S('unrecorded-share', { units: ['unrecorded'] }, 'owner-report-trust', 'Whether the ledger is used often enough for the forward stratum to represent the work, as the share of units seen since the first ledger line that have no line.'),
  S('coverage-shares', { units: ['coverage'] }, 'owner-report-trust', 'Whether tier and attribution coverage are enough to read a stratum figures, with the target beside n and the comparable-source share and never a verdict.'),
  S('window-split', { units: ['window'] }, 'owner-report-trust', 'Whether the calls since the first ledger line are attributed to forward units, attributed to reconstructed units, left in overlap or unlinked, so whether forward units move main-session cost at all before the next ledger decision.'),
  S('ledger-overhead', { units: ['overhead'] }, 'owner-rigor-decisions', 'Whether the ledger per-unit cost is acceptable or the step texts need trimming, from the estimated text per unit kind and the ledger calls per forward unit.'),
  S('calibration-pairs', { calibrate: ['pairs'] }, 'owner-report-trust', 'How many units have both a ledger line and a reconstruction (the pairs every calibration field is counted over) and how many ledger-only units have none.'),
  S('calibration-fields', { calibrate: ['tier', 'start', 'end', 'session'] }, 'owner-report-trust', 'Whether reconstructed tier, dates and session links can be trusted for units that have no ledger line, one line per field with agree, disagree and unknown counts, n and the low-evidence flag, and no total.'),
  S('tier-strata', { tier: ['stratum'] }, 'owner-rigor-decisions', 'What a unit costs at each rigor tier inside one risk stratum, with n and the low-evidence flag per side, and so whether a tier choice for that risk class is worth its cost.'),
  S('confounder-changes', { tier: ['confounders'] }, 'owner-rigor-decisions', 'Which confounders changed inside a comparison window or are unknown, and so how far a tier difference can be read as the tier effect.'),
  S('tier-leads', { tier: ['leads'] }, 'owner-rigor-decisions', 'Which tier differences inside a stratum have the most evidence behind them, with the unit evidence ids to check, and so which keep, kill or retune decision to look at first.'),
]);
