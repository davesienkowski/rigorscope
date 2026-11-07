// rigorscope evidence ID [--since DATE] [--until DATE] [--tz ZONE] [--json] [--limit N] [--link-confidence MODE]
//
// ID is one of (plan 02-07 adds the unit id, D-19):
//   ROW_KEY  a row of the cost report (D-08): SECTION/total or SECTION/DIM=VALUE/... as printed by `cost --json` (the
//            `key` of a row), with percent-encoded values and ? for an unknown. Lists the calls behind the row: for each
//            call its id, owner session, agent, message id, request id, record time, occurrence count and the root alias
//            plus relative file it was read from (transcripts), or the OTel file and stored byte offset. The same period
//            rules as cost apply (default: the last 168 hours; --tz must match the one the key's day was computed in).
//   u:UNIT   a unit (the `evidence_id` of a `units --json` record): its tier, tier signal and conflict, its links with
//            method and confidence, both modes' bucket of each linked scope, and the main-section calls attributed to
//            it with their files. The default period is all time.
//   l:UNIT/SESSION[/AGENT]  one link (a `links[].evidence_id` of a unit record): every method row of that (unit, scope)
//            pair with the refs, commands or skill calls behind it, the scope's buckets in both modes and the two
//            intervals. It covers all time.
// --link-confidence medium|low (plan 02-07) is accepted with a unit id only: the calls attributed in that mode.
// The listing is read-only. A grammar problem exits 2 before any state is touched with one fixed message that never
// echoes the id; a valid id with nothing behind it prints zero counts and exits 0.
import { UsageError } from '../cli.mjs';
import { ensureDerived } from '../derive/ensure.mjs';
import { PriceTableError, loadPrices } from '../derive/price-table.mjs';
import { BY_DIMENSIONS } from '../report/cost.mjs';
import { allPeriod } from '../measure/period.mjs';
import { parseEvidenceId } from '../measure/rowkey.mjs';
import { loadEvidence, loadLinkEvidence, loadUnitEvidence } from '../report/evidence.mjs';
import { parseLinkConfidence } from '../report/filters.mjs';
import { renderEvidenceJson, renderLinkEvidenceJson, renderUnitEvidenceJson } from '../report/render-json.mjs';
import { renderEvidenceText, renderLinkEvidenceText, renderUnitEvidenceText } from '../report/render-evidence.mjs';
import { parseLimit, periodFromArgs, usageOnRange } from './cost.mjs';

export const description = 'List the calls and files behind one row of the cost report (a row key), one unit (a u: id) or one link (an l: id)';
export const options = {
  since: { type: 'string' },
  until: { type: 'string' },
  tz: { type: 'string' },
  limit: { type: 'string' },
  json: { type: 'boolean' },
  'link-confidence': { type: 'string' },
};
export const positionals = { min: 1, max: 1, names: ['ROW_KEY'] };

function prices(ctx) {
  try {
    return loadPrices({ dir: (ctx.env ?? {}).RIGORSCOPE_PRICES_DIR });
  } catch (err) {
    if (!(err instanceof PriceTableError)) throw err;
    return null;
  }
}

export async function run(args, ctx) {
  const [id] = args.positionals;
  const parsed = usageOnRange(() => parseEvidenceId(id, Object.keys(BY_DIMENSIONS)));
  // --link-confidence (plan 02-07) selects the attributed calls of a unit id; it means nothing for a row key or a link.
  const mode = usageOnRange(() => parseLinkConfidence(args['link-confidence']));
  if (args['link-confidence'] !== undefined && parsed.kind !== 'unit') {
    throw new UsageError('--link-confidence applies to a unit id (u:...) only');
  }
  const { tz, period } = periodFromArgs(args, ctx);
  const limit = args.limit === undefined ? 50 : parseLimit(args.limit);
  ensureDerived({ home: ctx.home, now: ctx.now, prices: prices(ctx) });
  const common = {
    home: ctx.home, tz, limit, now: ctx.now, clockFixed: ctx.clockFixed === true,
  };
  if (parsed.kind === 'unit') {
    // A unit id defaults to all time; --since or --until bound it like a row key.
    const unitPeriod = args.since === undefined && args.until === undefined ? allPeriod() : period;
    const evidence = loadUnitEvidence({
      ...common, unitKey: parsed.unitKey, period: unitPeriod, mode,
    });
    ctx.stdout.write(args.json ? renderUnitEvidenceJson(evidence) : renderUnitEvidenceText(evidence));
    return 0;
  }
  if (parsed.kind === 'link') {
    const evidence = loadLinkEvidence({
      ...common, unitKey: parsed.unitKey, sessionId: parsed.sessionId, agentId: parsed.agentId,
    });
    ctx.stdout.write(args.json ? renderLinkEvidenceJson(evidence) : renderLinkEvidenceText(evidence));
    return 0;
  }
  const evidence = loadEvidence({ ...common, rowKey: id, period });
  ctx.stdout.write(args.json ? renderEvidenceJson(evidence) : renderEvidenceText(evidence));
  return 0;
}
