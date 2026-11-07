// The violation fixture of the no-coverage-percent prohibition must keep failing it, so it cannot rot (plan 03.1-04). Runs
// test/prohibitions/no-coverage-percent.test.mjs in a child `node --test` with GSD_PROHIB_SUBJECT naming the fixture and asserts
// a non-zero exit; the clean subject runs beside it and must exit 0 (so a failing child means the fixture, not the harness).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FORMS } from './fixtures/no-coverage-percent-forms.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TARGET = 'test/prohibitions/no-coverage-percent.test.mjs';

function runWith(subject, form = null) {
  const env = { ...process.env, GSD_PROHIB_SUBJECT: subject };
  delete env.GSD_PROHIB_FORM;
  if (form !== null) env.GSD_PROHIB_FORM = form;
  // A child started from inside a test run must not inherit the parent's runner context, or it would report to the parent.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', TARGET], { cwd: ROOT, env, encoding: 'utf8', timeout: 180_000 });
}

describe('the no-coverage-percent fixtures stay honest', () => {
  it('the clean subject passes the prohibition', () => {
    const r = runWith('test/prohibitions/fixtures/no-coverage-percent-clean.mjs');
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-1500));
  });

  it('the violation subject fails it (non-zero exit, at least one failing test)', () => {
    const r = runWith('test/prohibitions/fixtures/no-coverage-percent-violation.mjs');
    assert.notEqual(r.status, 0, 'the violation fixture must make the prohibition fail');
    assert.match(`${r.stdout}${r.stderr}`, /fail [1-9]/);
  });

  // Each generated form of FORMS planted in the real command output must make the prohibition fail (WR-03).
  for (const f of FORMS) {
    it(`the generated form ${f.id} fails it`, () => {
      const r = runWith('test/prohibitions/fixtures/no-coverage-percent-forms.mjs', f.id);
      assert.notEqual(r.status, 0, `${f.id} must make the prohibition fail`);
      // It must fail on the scan of the command output, not on the scanner self-test.
      assert.match(`${r.stdout}${r.stderr}`, /✖ no (?:scanned text line|JSON key or string)/, `${f.id}: the scan of the output must catch it`);
    });
  }
});
