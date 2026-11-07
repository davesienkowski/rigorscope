// Violation fixture for test/prohibitions/holdout-isolation.test.mjs: a reader of the held-out golden label file by
// name, outside the one acceptance test. It must fail the scan. It is never imported or run.
import { readFileSync } from 'node:fs';

export function readLabels() {
  return readFileSync(new URL('../../golden/holdout.jsonl', import.meta.url), 'utf8');
}
