// Plan 02-05 (02-03 handoff): the risk-rule table is a stale reason of derived.db. ensureDerived records the table's
// file, version and sha and rebuilds with reason risk_rules when the table it is given has another sha (table to none
// and none to table included); with no usable table every unit's risk_class is NULL with risk_source no-rules, and the
// spawned `units` and `cost` still exit 0. In process on a units fixture HOME; every table copy lives in a temporary
// directory.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliEnv, ingestHome, makeHome, queryDb, runCli } from '../fixtures/build.mjs';
import { buildUnitsHome } from '../fixtures/units-home.mjs';
import { ensureDerived } from '../../src/derive/ensure.mjs';
import { derivedPath } from '../../src/db.mjs';
import { defaultRiskRulesDir, loadRiskRules } from '../../src/units/risk-rules.mjs';

const SHIPPED = 'risk-rules-2026-10-30.json';

describe('the risk_rules stale reason', () => {
  let ctx;
  let dir;
  before(async () => {
    ctx = makeHome();
    buildUnitsHome({ home: ctx.home, root: ctx.root });
    await ingestHome(ctx.home);
    dir = mkdtempSync(join(tmpdir(), 'rigorscope-risk-'));
    const obj = JSON.parse(readFileSync(join(defaultRiskRulesDir(), SHIPPED), 'utf8'));
    obj.version = '2026-10-31';
    obj.rules[0] = { ...obj.rules[0], match: `${obj.rules[0].match}|(^|\\/)watchdogs?\\/` };
    writeFileSync(join(dir, 'risk-rules-2026-10-31.json'), `${JSON.stringify(obj, null, 2)}\n`);
  });
  after(() => {
    ctx.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rebuilds once for a missing derived.db, then not at all, and records the shipped table', () => {
    assert.deepEqual(ensureDerived({ home: ctx.home }), { rebuilt: true, reason: 'missing' });
    assert.deepEqual(ensureDerived({ home: ctx.home }), { rebuilt: false, reason: null });
    const shipped = loadRiskRules();
    assert.deepEqual(queryDb(derivedPath(ctx.home), 'SELECT risk_rules_file, risk_rules_version, risk_rules_sha FROM derive_state'), [
      { risk_rules_file: SHIPPED, risk_rules_version: '2026-10-30', risk_rules_sha: shipped.sha },
    ]);
  });

  it('a later table with one changed pattern rebuilds with reason risk_rules and records its sha', () => {
    const later = loadRiskRules({ dir });
    assert.notEqual(later.sha, loadRiskRules().sha);
    assert.deepEqual(ensureDerived({ home: ctx.home, riskRules: later }), { rebuilt: true, reason: 'risk_rules' });
    assert.deepEqual(ensureDerived({ home: ctx.home, riskRules: later }), { rebuilt: false, reason: null });
    assert.equal(queryDb(derivedPath(ctx.home), 'SELECT risk_rules_sha FROM derive_state')[0].risk_rules_sha, later.sha);
  });

  it('no usable table rebuilds with risk_rules and every unit has risk_class NULL with source no-rules', () => {
    assert.deepEqual(ensureDerived({ home: ctx.home, riskRules: null }), { rebuilt: true, reason: 'risk_rules' });
    const units = queryDb(derivedPath(ctx.home), 'SELECT risk_class, risk_source FROM unit');
    assert.ok(units.length > 0);
    for (const u of units) assert.deepEqual(u, { risk_class: null, risk_source: 'no-rules' });
    assert.equal(queryDb(derivedPath(ctx.home), 'SELECT risk_rules_sha FROM derive_state')[0].risk_rules_sha, null);
    assert.deepEqual(ensureDerived({ home: ctx.home }), { rebuilt: true, reason: 'risk_rules' });
  });

  it('units and cost still exit 0', () => {
    const env = cliEnv(ctx.home);
    assert.equal(runCli(['units'], { home: ctx.home, env }).status, 0);
    assert.equal(runCli(['cost'], { home: ctx.home, env }).status, 0);
  });
});
