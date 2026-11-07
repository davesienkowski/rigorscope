// rigorscope units [--json] [--tz ZONE] [--repo LIST] [--tier LIST] [--framework LIST] [--runtime LIST] [--model LIST]
//                  [--role LIST] [--link-confidence medium|low] [--evidence] (plans 02-02 and 02-07, D-19, RPT-01): lists
// the reconstructed units of work with their repo, tier, dates, links and attributed cost. Every flag is validated first
// (a bad zone, filter value or mode is a usage error, exit 2, before any state is touched; the filter values never
// appear in the message); derived.db is rebuilt only when stale (ensureDerived), which also refuses a store with a
// pending migration (exit 1, D-23: units never migrates); then the text table or the rigorscope.units/2 JSON document is
// printed. It exits 0 whatever the content.
//   --repo, --tier, --framework, --runtime  unit filters (select units)
//   --model, --role                         call filters (select calls: a unit is listed when it has an attributed call
//                                           matching them and its cost counts only those calls)
//   --link-confidence                       medium (strict, default) or low (widened) for cost, attribution, confounders
//   --population                            forward, reconstructed or all (default): the strata shown; never pooled (plan 03-04)
//   --sheet                                 add the decision sheet rows after the report (plan 03-05; off by default)
//   --evidence                              print each listed unit's u: id and its l: link ids after the summary lines
import { ensureDerived } from '../derive/ensure.mjs';
import { PriceTableError, loadPrices } from '../derive/price-table.mjs';
import { resolveTz } from '../measure/period.mjs';
import { renderUnitsJson } from '../report/render-json.mjs';
import { renderUnitsText } from '../report/render-text.mjs';
import { FILTER_OPTIONS, parseFilters, parseLinkConfidence } from '../report/filters.mjs';
import { populationFromArgs } from '../report/population.mjs';
import { loadCalibration } from '../report/calibrate.mjs';
import { buildSheet } from '../report/sheet.mjs';
import { LOW_EVIDENCE_N } from '../report/tier.mjs';
import { loadUnitsReport } from '../report/units.mjs';
import { usageOnRange } from './cost.mjs';

export const description = 'List reconstructed units of work with their repo, tier, dates, links and attributed cost; filters select units or calls; --json prints one versioned document';
export const options = {
  json: { type: 'boolean' }, tz: { type: 'string' }, ...FILTER_OPTIONS, evidence: { type: 'boolean' },
  population: { type: 'string', multiple: true }, sheet: { type: 'boolean' },
};

// The same price-table rule as `cost`, so a rebuild decision never differs between the two commands.
export function prices(ctx) {
  try {
    return loadPrices({ dir: (ctx.env ?? {}).RIGORSCOPE_PRICES_DIR });
  } catch (err) {
    if (!(err instanceof PriceTableError)) throw err;
    return null;
  }
}

export async function run(args, ctx) {
  const population = usageOnRange(() => populationFromArgs(args.population));
  const tz = usageOnRange(() => resolveTz(args.tz));
  const filters = usageOnRange(() => parseFilters(args, { home: ctx.home }));
  const mode = usageOnRange(() => parseLinkConfidence(args['link-confidence']));
  ensureDerived({ home: ctx.home, now: ctx.now, prices: prices(ctx) });
  const report = loadUnitsReport({
    home: ctx.home, now: ctx.now, tz, clockFixed: ctx.clockFixed === true, mode, filters, population,
  });
  // Plan 03-05 (RPT-06, D-20): the decision sheet is opt-in and built here, after the report loaded, so the loader and the default
  // output do not change. The calibrate rows read the forward pairs of the whole store (they ignore the filters of this report).
  let sheet;
  if (args.sheet === true) {
    const calibration = loadCalibration({ home: ctx.home, now: ctx.now, tz });
    sheet = buildSheet('units', {
      calibration, strata: report.strata, units: report.units, unrecorded: report.unrecorded, incomplete: report.incomplete, tz, minN: LOW_EVIDENCE_N,
    });
  }
  ctx.stdout.write(args.json ? renderUnitsJson(report, { sheet }) : renderUnitsText(report, { evidence: args.evidence === true, sheet }));
  return 0;
}
