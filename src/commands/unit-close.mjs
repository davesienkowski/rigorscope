// rigorscope unit-close --kind quick|plan --id ID [--status complete|failed|abandoned] [--end ISO] [--tier A|B|C]
//   [--tier-source declared-at-close|unknown] [--command NAME] [--runtime NAME] [--session-id ID] [--start ISO]
// (plan 03-01, LEDG-02, D-05, D-06, D-07): the twin of unit-start for the `close` line. A close with no start line is valid
// (its start is null unless --start is given). Prints `ledger: close <unit_key>`; opens no database; same exit codes.
import { recordUnit } from '../ledger/record.mjs';

export const description = 'Append one close line for a unit to the forward ledger (opens no database)';
export const options = {
  kind: { type: 'string' },
  id: { type: 'string' },
  status: { type: 'string' },
  end: { type: 'string' },
  tier: { type: 'string' },
  'tier-source': { type: 'string' },
  command: { type: 'string' },
  runtime: { type: 'string' },
  'session-id': { type: 'string' },
  start: { type: 'string' },
};

export async function run(args, ctx) {
  return recordUnit('close', args, ctx);
}
