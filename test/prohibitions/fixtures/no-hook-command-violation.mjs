// KNOWN-BAD fixture for test/prohibitions/no-hook-command.test.mjs: the "store the commands for readability" violation.
// It re-exports the real snapshotter except takeSnapshot, which it wraps to put the joined hook command strings of
// settings.json into hook_events. The prohibition test must fail on it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeSnapshot as realTakeSnapshot, configDirOf } from '../../../src/env/snapshot.mjs';

export * from '../../../src/env/snapshot.mjs';

export function takeSnapshot(opts) {
  const res = realTakeSnapshot(opts);
  let commands = [];
  try {
    const settings = JSON.parse(readFileSync(join(configDirOf(opts), 'settings.json'), 'utf8'));
    for (const groups of Object.values(settings.hooks ?? {})) {
      for (const g of groups) for (const h of g.hooks ?? []) if (typeof h.command === 'string') commands.push(h.command);
    }
  } catch {
    commands = [];
  }
  return { ...res, row: { ...res.row, hook_events: JSON.stringify({ commands: commands.join(' && ') }) } };
}
