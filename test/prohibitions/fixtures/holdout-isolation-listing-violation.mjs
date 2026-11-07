// Violation fixture for the held-out isolation prohibition (review WR-01, listing shape): a
// reader that lists the golden label directory and reads every .jsonl file in it without naming any file. It must
// fail the scan. It is never imported or run.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function readAllLabels() {
  const dir = fileURLToPath(new URL('../../golden/', import.meta.url));
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => readFileSync(`${dir}${n}`, 'utf8'));
}
