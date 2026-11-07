// Prohibition (plan 02-04, DATA-07, D-16 with amendment Q3, T-02-32): MUST NOT capture hook command text or any
// settings.json value other than hook event names with counts, one sha256 of the hooks block and the model and advisor
// model names.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a module exporting takeSnapshot, resolved against process.cwd(); unset
// means src/env/snapshot.mjs. test/prohibitions/fixtures/no-hook-command-violation.mjs (it puts the joined hook command
// strings into hook_events, "for readability") must fail this test; test/prohibitions/fixtures/no-hook-command-clean.mjs
// (re-exports the real module) must pass it.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeHome } from '../fixtures/build.mjs';

const DEFAULT_SUBJECT = fileURLToPath(new URL('../../src/env/snapshot.mjs', import.meta.url));
const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : DEFAULT_SUBJECT;

it('the snapshot holds hook event counts and a hash, never a hook command or another settings value', async () => {
  const { takeSnapshot } = await import(pathToFileURL(subject).href);
  const ctx = makeHome();
  try {
    const dir = join(ctx.home, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'PROHIB-hook-cmd-a' }, { type: 'command', command: 'PROHIB-hook-cmd-b' }] }] },
      env: { [['SEC', 'RET'].join('')]: 'PROHIB-env-value' },
      permissions: { allow: ['PROHIB-permission'] },
      statusLine: { type: 'command', command: 'PROHIB-status' },
    }));
    const result = takeSnapshot({ home: ctx.home, env: { HOME: ctx.home }, now: () => new Date(0) });
    assert.ok(!JSON.stringify(result).includes('PROHIB-'), 'a hook command or another settings value was captured');
    assert.equal(result.row.hook_events, '{"Stop":2}');
    assert.match(result.row.hooks_sha, /^[0-9a-f]{64}$/);
  } finally {
    ctx.cleanup();
  }
});
