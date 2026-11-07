// rigorscope calibrate [--json] [--tz ZONE] [--evidence] (plan 03-05, LEDG-06, D-19): compares what the forward ledger recorded
// with what reconstruction found for the same units, field by field (tier, start, end and the session link). Every flag is
// validated first (a bad zone is a usage error, exit 2, before any state is touched); derived.db is rebuilt only when stale
// (ensureDerived), which also refuses a store with a pending migration (exit 1: calibrate never migrates). It exits 0 whatever the
// content. There is no total, rate or composite across fields and no per-unit verdict; a field with no pair prints n 0 and `?`.
//   --json      print the rigorscope.calibrate/1 document instead of the text
//   --tz        the zone of the report (the calibrate figures are zone-free; the zone is carried for the document)
//   --evidence  list, per field, the `u:` ids of up to five disagreeing units (no session id, command, path or branch is printed)
import { ensureDerived } from '../derive/ensure.mjs';
import { resolveTz } from '../measure/period.mjs';
import { loadCalibration } from '../report/calibrate.mjs';
import { renderCalibrateJson } from '../report/render-json.mjs';
import { renderCalibrateText } from '../report/render-text.mjs';
import { usageOnRange } from './cost.mjs';
import { prices } from './units.mjs';

export const description = 'Compare the forward ledger with reconstruction for the same units, field by field (tier, start, end, session link); no total score; --json prints one versioned document';
export const options = { json: { type: 'boolean' }, tz: { type: 'string' }, evidence: { type: 'boolean' } };

export async function run(args, ctx) {
  const tz = usageOnRange(() => resolveTz(args.tz));
  ensureDerived({ home: ctx.home, now: ctx.now, prices: prices(ctx) });
  const report = loadCalibration({ home: ctx.home, now: ctx.now, tz, clockFixed: ctx.clockFixed === true });
  const evidence = args.evidence === true;
  ctx.stdout.write(args.json ? renderCalibrateJson(report, { evidence }) : renderCalibrateText(report, { evidence }));
  return 0;
}
