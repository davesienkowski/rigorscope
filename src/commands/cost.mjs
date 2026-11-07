// rigorscope cost [--by DIMS] [--since DATE] [--until DATE] [--tz ZONE] [--json] [--evidence [--limit N]] [--include-inferred]
//
// Validates every flag first (a bad value is a usage error, exit 2, before any state is touched), resolves the period
// from ctx.now in the stated zone, loads the price table, rebuilds derived.db only when it is stale (ensureDerived,
// which also rebuilds when the table changed), then prints the cost table (or the JSON document) and its footer. It
// exits 0 whatever the numbers, the freshness, the conservation result or the price table are: a bad-looking value is
// reported, never turned into a failure (RR-01).
//
// --by names up to eleven dimensions (role, model, effort, day, session, repo, and since plan 02-08 tier, unit, framework and
// runtime; plan 03-04 adds population, which tier, unit and framework bring with them as their first column);
// --population forward|reconstructed|all (default all) keeps only calls attributed to units of that population; --repo, --tier, --framework, --runtime, --model and --role (plan 02-08, RPT-01) limit every figure the period limits
// and are validated with the other flags before any state is touched; --since/--until are calendar dates read
// in the --tz zone (default: the process zone); --include-inferred (review 02-08 WR-04) lets the --tier filter select units whose tier was
// inferred from probe files (by default it does not, as in `tier`; it changes nothing without --tier); with neither, the last 168 hours before ctx.now. --evidence lists the
// first --limit (default 3) calls behind every row after the footer.
//
// Price table (plan 01-05): the newest data/prices-YYYY-MM-DD.json shipped with rigorscope, or the newest
// such file in the absolute directory RIGORSCOPE_PRICES_DIR names. An unusable table (missing, invalid, a
// relative or empty directory) prints one stderr warning naming only its fixed code, and every dollar
// cell then prints "?"; token cells are unaffected.
import { UsageError } from '../cli.mjs';
import { ensureDerived } from '../derive/ensure.mjs';
import { PriceTableError, loadPrices } from '../derive/price-table.mjs';
import { allPeriod, resolvePeriod, resolveTz } from '../measure/period.mjs';
import { DEFAULT_BY, costFilterWhere, loadCostReport, parseBy } from '../report/cost.mjs';
import { MAX_LIMIT, loadEvidence } from '../report/evidence.mjs';
import { FILTER_ONLY_OPTIONS, parseFilters } from '../report/filters.mjs';
import { loadAdvisorTrial } from '../report/advisor-trial.mjs';
import { renderCostJson } from '../report/render-json.mjs';
import { buildSheet } from '../report/sheet.mjs';
import { LOW_EVIDENCE_N } from '../report/tier.mjs';
import { populationFromArgs } from '../report/population.mjs';
import { EVIDENCE_ROW_CAP, renderCostText } from '../report/render-text.mjs';

export const description = 'Print tokens and notional dollars by role, model, effort, day, session, repo, tier, unit, framework or runtime from the ingested records; filters limit the figures';
export const options = {
  by: { type: 'string' },
  since: { type: 'string' },
  until: { type: 'string' },
  tz: { type: 'string' },
  limit: { type: 'string' },
  json: { type: 'boolean' },
  evidence: { type: 'boolean' },
  'include-inferred': { type: 'boolean' },
  population: { type: 'string', multiple: true },
  sheet: { type: 'boolean' },
  ...FILTER_ONLY_OPTIONS,
};

const LIMIT_MESSAGE = 'the --limit value must be a whole number from 1 to 100000';
const DECIMAL = /^[1-9][0-9]{0,5}$/;

// Turns a RangeError of a parser into the exit-2 usage error; anything else is rethrown.
export function usageOnRange(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RangeError) throw new UsageError(err.message);
    throw err;
  }
}

export function parseLimit(text) {
  if (typeof text !== 'string' || !DECIMAL.test(text) || Number(text) > MAX_LIMIT) throw new UsageError(LIMIT_MESSAGE);
  return Number(text);
}

// Shared by cost and evidence: --since, --until and --tz in that order, then the period from the clock.
export function periodFromArgs(args, ctx) {
  if (args.since !== undefined) usageOnRange(() => resolvePeriod({ since: args.since, tz: 'UTC', nowMs: 0 }));
  if (args.until !== undefined) usageOnRange(() => resolvePeriod({ until: args.until, tz: 'UTC', nowMs: 0 }));
  const tz = usageOnRange(() => resolveTz(args.tz));
  const period = usageOnRange(() => resolvePeriod({ since: args.since, until: args.until, tz, nowMs: ctx.now().getTime() }));
  return { tz, period };
}

function pricesFor(ctx) {
  const env = ctx.env ?? {};
  const dir = env.RIGORSCOPE_PRICES_DIR;
  try {
    return loadPrices({ dir });
  } catch (err) {
    if (!(err instanceof PriceTableError)) throw err;
    ctx.stderr.write(`warning: price table unusable (${err.code}); notional dollars are unavailable\n`);
    return null;
  }
}

export async function run(args, ctx) {
  const population = usageOnRange(() => populationFromArgs(args.population));
  let by = DEFAULT_BY;
  if (args.by !== undefined) by = usageOnRange(() => parseBy(args.by));
  const { tz, period } = periodFromArgs(args, ctx);
  const filters = usageOnRange(() => parseFilters(args, { home: ctx.home }));
  let limit = 3;
  if (args.limit !== undefined) {
    if (!args.evidence) throw new UsageError('--limit needs --evidence');
    limit = parseLimit(args.limit);
  }
  const prices = pricesFor(ctx);
  ensureDerived({ home: ctx.home, now: ctx.now, prices });
  const includeInferred = args['include-inferred'] === true;
  const report = loadCostReport({
    home: ctx.home, by, now: ctx.now, period: period ?? allPeriod(), tz, clockFixed: ctx.clockFixed === true, filters, includeInferred, population,
    withPopulations: args.sheet === true,
  });
  // Plan 03-05 (RPT-06, D-20, D-25): the opt-in decision sheet, built after the report loaded. It follows the report it sits under
  // (call filters describe the filtered calls); the advisor row reads the environment snapshots and the advisor parts by model.
  const sheet = args.sheet === true ? buildSheet('cost', {
    populations: report.populations, samples: report.populationSamples, advisor: loadAdvisorTrial({ home: ctx.home, asOfMs: report.asOfMs }), minN: LOW_EVIDENCE_N,
  }) : undefined;
  let listings;
  let omitted = 0;
  if (args.evidence) {
    const keys = [];
    const sections = [[report.rows, report.totalRow], [report.otelRows, report.otelTotalRow], [report.harnessRows, report.harnessTotalRow]];
    for (const [rows, total] of sections) {
      for (const r of rows) keys.push(r.key);
      if (rows.length > 0 && total) keys.push(total.key);
    }
    omitted = Math.max(0, keys.length - EVIDENCE_ROW_CAP);
    listings = keys.slice(0, EVIDENCE_ROW_CAP).map((rowKey) => loadEvidence({
      home: ctx.home, rowKey, period, tz, limit, now: ctx.now, clockFixed: ctx.clockFixed === true, callWhere: costFilterWhere(filters, { includeInferred, population }),
    }));
  }
  if (args.json) {
    const evidence = listings ? Object.fromEntries(listings.map((e) => [e.rowKey, e])) : undefined;
    ctx.stdout.write(renderCostJson(report, { evidence, sheet }));
  } else {
    ctx.stdout.write(renderCostText(report, {
      evidence: listings, evidenceLimit: limit, evidenceOmitted: omitted, sheet,
    }));
  }
  return 0;
}
