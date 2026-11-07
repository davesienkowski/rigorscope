// rigorscope unit-start --kind quick|plan --id ID [--tier A|B|C] [--tier-source declared-at-start|plan-at-start|unknown]
//   [--command NAME] [--runtime NAME] [--session-id ID] [--start ISO]
// (plan 03-01, LEDG-02, D-05, D-07): appends one `start` line for a unit to <HOME>/.rigorscope/ledger/units.jsonl and prints
// `ledger: start <unit_key>`. The repository key comes from the current directory's git repository, the time from the clock.
// It opens no database. Exit 0, 1 (state directory or ledger file problem), 2 (usage or a rejected line, with one fixed
// message that never echoes a value). The step must never break the pipeline: callers continue after a non-zero exit.
import { recordUnit } from '../ledger/record.mjs';

export const description = 'Append one start line for a unit to the forward ledger (opens no database)';
export const options = {
  kind: { type: 'string' },
  id: { type: 'string' },
  tier: { type: 'string' },
  'tier-source': { type: 'string' },
  command: { type: 'string' },
  runtime: { type: 'string' },
  'session-id': { type: 'string' },
  start: { type: 'string' },
};

export async function run(args, ctx) {
  return recordUnit('start', args, ctx);
}
