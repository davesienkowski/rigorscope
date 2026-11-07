// Review fix M6 (plan 03-05): the sheet violation fixture must keep failing the sheet prohibition, so it cannot rot. Runs
// test/prohibitions/no-score.test.mjs in a child `node --test` with GSD_PROHIB_SHEET_SUBJECT naming the fixture and asserts a
// non-zero exit; the clean subject is run beside it and must exit 0 (so a failing child means the fixture, not the harness).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TARGET = 'test/prohibitions/no-score.test.mjs';

function runWith(subject) {
  const env = { ...process.env, GSD_PROHIB_SHEET_SUBJECT: subject };
  // A child started from inside a test run must not inherit the parent's runner context, or it would report to the parent.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', TARGET], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
}

describe('the sheet prohibition fixtures stay honest (review M6)', () => {
  it('the clean subject passes the sheet prohibition', () => {
    const r = runWith('test/prohibitions/fixtures/no-score-sheet-clean.mjs');
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-1500));
  });

  it('the violation subject fails it (non-zero exit)', () => {
    const r = runWith('test/prohibitions/fixtures/no-score-sheet-violation.mjs');
    assert.notEqual(r.status, 0, 'the violation fixture must make the sheet prohibition fail');
    assert.match(`${r.stdout}${r.stderr}`, /fail [1-9]/, 'at least one test failed in the child');
  });
});
