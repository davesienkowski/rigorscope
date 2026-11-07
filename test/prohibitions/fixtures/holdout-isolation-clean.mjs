// Clean fixture for the held-out isolation prohibition (its violation fixture's twin): the same reader on the training
// label file. It must pass the scan. It is never imported or run.
import { readFileSync } from 'node:fs';

export function readLabels() {
  return readFileSync(new URL('../../golden/units.jsonl', import.meta.url), 'utf8');
}
