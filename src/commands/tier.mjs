// rigorscope tier [--json] [--tz ZONE] [--since DATE] [--until DATE] [--min-n N] [--include-inferred] [--link-confidence medium|low]
// (plan 02-08, D-18, D-02, TRUST-07, TIER-02, D-13):
// per-unit cost by rigor tier inside each risk stratum for the reconstructed units: one table per stratum with rows A, B, C
// and ?, the nearest-rank median and p75 of tokens, notional dollars and window shares over the costed units, a low-evidence
// flag per side below --min-n costed units (default 10), catch and escape unavailable. Every flag is validated first (a bad
// zone, date or --min-n is a usage error, exit 2, before any state is touched, and the value never appears in the message);
// derived.db is rebuilt only when stale (ensureDerived), which also refuses a store with a pending migration (exit 1; tier
// never migrates). It exits 0 whatever the content. The period defaults to all time; --since and --until select units by
// their start (units of unknown start leave a bounded period and are counted). Flags are report-time parameters only: they
// never reach derive and are never stored.
//   --json     print the rigorscope.tier/2 document instead of the text
//   --tz       the zone of the printed days
//   --since, --until  calendar dates in --tz selecting units by start
//   --min-n    the costed count below which a side is flagged low-evidence (1 to 1000, default 10)
//   --include-inferred  put a tier inferred from probe files (tier_signal probes-skipped) in its letter row; by default such
//              a unit is in no row and is counted (D-03, TIER-02)
//   --link-confidence  medium (strict, default) or low (widened) for cost, attribution and confounders (D-13)
//   --repo, --tier, --framework, --runtime  unit filters (select units; --tier also limits the printed rows to the named tiers)
//   --model, --role  call filters (select calls: a unit stays only with an attributed call that matches, and its cost counts
//              those calls only; the confounders describe every attributed call of the unit)
//   --population forward, reconstructed or all (default): each population is built apart; no row or lead crosses them (plan 03-04)
//   --sheet    add the decision sheet rows after the report (plan 03-05; off by default)
//   --evidence print each row's unit u: ids after the leads (at most 200 lines; --json always carries them)
import { ensureDerived } from '../derive/ensure.mjs';
import { allPeriod, resolveTz } from '../measure/period.mjs';
import { FILTER_OPTIONS, parseFilters, parseLinkConfidence } from '../report/filters.mjs';
import { populationFromArgs } from '../report/population.mjs';
import { renderTierJson } from '../report/render-json.mjs';
import { renderTierText } from '../report/render-text.mjs';
import { buildSheet } from '../report/sheet.mjs';
import { LOW_EVIDENCE_N, loadTierReport, parseMinN } from '../report/tier.mjs';
import { periodFromArgs, usageOnRange } from './cost.mjs';
import { prices } from './units.mjs';

export const description = 'Print per-unit cost by rigor tier inside each risk stratum, with the low-evidence flag, the changed confounders and ranked leads; --json prints one versioned document';
export const options = {
  json: { type: 'boolean' },
  tz: { type: 'string' },
  since: { type: 'string' },
  until: { type: 'string' },
  'min-n': { type: 'string' },
  'include-inferred': { type: 'boolean' },
  evidence: { type: 'boolean' },
  population: { type: 'string', multiple: true },
  sheet: { type: 'boolean' },
  ...FILTER_OPTIONS,
};

export async function run(args, ctx) {
  const population = usageOnRange(() => populationFromArgs(args.population));
  const bounded = args.since !== undefined || args.until !== undefined;
  const { tz, period } = bounded
    ? periodFromArgs(args, ctx)
    : { tz: usageOnRange(() => resolveTz(args.tz)), period: allPeriod() };
  const minN = args['min-n'] === undefined ? LOW_EVIDENCE_N : usageOnRange(() => parseMinN(args['min-n']));
  const filters = usageOnRange(() => parseFilters(args, { home: ctx.home }));
  const mode = usageOnRange(() => parseLinkConfidence(args['link-confidence']));
  ensureDerived({ home: ctx.home, now: ctx.now, prices: prices(ctx) });
  const report = loadTierReport({
    home: ctx.home, now: ctx.now, tz, clockFixed: ctx.clockFixed === true, mode, includeInferred: args['include-inferred'] === true,
    minN, period: period ?? allPeriod(), filters, population,
  });
  // Plan 03-05 (RPT-06, D-20): opt-in decision sheet, built after the report loaded from the report's own populations.
  const sheet = args.sheet === true ? buildSheet('tier', { populations: report.populations, minN }) : undefined;
  ctx.stdout.write(args.json ? renderTierJson(report, { sheet }) : renderTierText(report, { evidence: args.evidence === true, sheet }));
  return 0;
}
