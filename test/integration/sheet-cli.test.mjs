// Plan 03-05 (RPT-06, D-20): `--sheet` on units, tier and cost through the CLI on temporary HOMEs. Off by default.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, runCli } from '../fixtures/build.mjs';
import { buildCalibrateHome, calEnv } from '../fixtures/calibrate-home.mjs';
import { ROW_KEYS } from '../../src/report/sheet.mjs';

describe('tracer: units --sheet carries the calibrate-tier row (03-05 Task 1)', () => {
  let ctx;
  const cli = (args) => runCli(args, { home: ctx.home, env: calEnv(ctx.home) });
  before(async () => {
    ctx = makeHome();
    await buildCalibrateHome({ home: ctx.home, root: ctx.root, pairs: [{ id: 'a1b', tier: 'B' }] });
  });
  after(() => ctx.cleanup());

  it('units --sheet prints a sheet: block whose calibrate-tier row says cannot with n 1 below 5, forward, a consumer and an evidence id', () => {
    const r = cli(['units', '--sheet']);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n');
    const at = lines.findIndex((l) => l.startsWith('sheet: '));
    assert.ok(at >= 0, 'a sheet: header line');
    const rowAt = lines.findIndex((l, i) => i > at && l.startsWith('  calibrate-tier: '));
    assert.ok(rowAt > at, 'the calibrate-tier row is indented under the header');
    const block = lines.slice(rowAt, rowAt + 5).join('\n');
    assert.match(block, /^  calibrate-tier: cannot; n=1; population=forward; low_evidence=yes; consumer=owner-report-trust/);
    assert.match(block, /compared pairs 1 of 5 needed/);
    assert.match(block, /evidence: u:/);
  });

  it('units --sheet --json has a sheet array whose row keys equal ROW_KEYS', () => {
    const r = cli(['units', '--sheet', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.ok(Array.isArray(doc.sheet));
    for (const row of doc.sheet) assert.deepEqual(Object.keys(row), [...ROW_KEYS]);
    assert.equal(doc.sheet.find((x) => x.id === 'calibrate-tier').status, 'cannot');
  });

  it('without --sheet the units text has no sheet line and the JSON has no sheet key', () => {
    const text = cli(['units']);
    assert.ok(!text.stdout.split('\n').some((l) => l.startsWith('sheet:') || l.startsWith('  calibrate-')));
    assert.equal(Object.hasOwn(JSON.parse(cli(['units', '--json']).stdout), 'sheet'), false);
  });
});

// ---- Task 3: tier and cost, the advisor row, default output ----------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ingestHome } from '../fixtures/build.mjs';
import { ROW_IDS } from '../../src/report/sheet.mjs';
import { LOW_EVIDENCE_N } from '../../src/report/tier.mjs';
import { buildStrataHome, planAtStart } from '../fixtures/strata-home.mjs';
import { TIER_TIMES } from '../fixtures/tier-home.mjs';

const rowsOf = (stdout) => JSON.parse(stdout).sheet;

describe('tier --sheet and cost --sheet on a rich tier home (03-05 Task 3)', () => {
  let ctx;
  const env = () => calEnv(ctx.home, { RIGORSCOPE_NOW: TIER_TIMES.now });
  const cli = (args) => runCli(args, { home: ctx.home, env: env() });
  before(async () => {
    ctx = makeHome();
    buildStrataHome({ home: ctx.home, root: ctx.root, base: 'tier', texts: [planAtStart('261030-a1b', '2026-10-28T12:00:00.000Z')] });
    await ingestHome(ctx.home, env());
  });
  after(() => ctx.cleanup());

  it('default output has no sheet: the text and JSON of units, tier and cost carry no sheet line and no sheet key', () => {
    for (const args of [['units'], ['tier'], ['cost', '--by', 'tier']]) {
      const text = cli(args);
      assert.equal(text.status, 0, text.stderr);
      assert.ok(!text.stdout.split('\n').some((l) => l.startsWith('sheet:') || /^ {2}[a-z-]+: (cannot|can decide today);/.test(l)), args.join(' '));
      assert.equal(Object.hasOwn(JSON.parse(cli([...args, '--json']).stdout), 'sheet'), false, `${args.join(' ')} json`);
    }
  });

  it('tier --sheet --json: three rows in order, and the tier-cost n equals the pair read from the report own strata', () => {
    const doc = JSON.parse(cli(['tier', '--sheet', '--json']).stdout);
    assert.deepEqual(doc.sheet.map((r) => r.id), ['tier-cost-forward', 'tier-cost-reconstructed', 'tier-source-comparable']);
    for (const pop of doc.populations) {
      let best = 0;
      for (const st of pop.strata) {
        const c = st.rows.filter((r) => ['A', 'B', 'C'].includes(r.tier) && r.costed > 0).map((r) => r.costed).sort((a, b) => b - a);
        if (c.length >= 2) best = Math.max(best, c[1]);
      }
      const r = doc.sheet.find((x) => x.id === `tier-cost-${pop.population}`);
      assert.equal(r.n, best, pop.population);
      assert.equal(r.population, pop.population);
      if (best < LOW_EVIDENCE_N) assert.equal(r.status, 'cannot');
    }
    const text = cli(['tier', '--sheet']).stdout;
    assert.match(text, /^sheet: /m);
    assert.match(text, /^ {2}tier-source-comparable: (cannot|can decide today); n=\d+; population=forward;/m);
  });

  it('tier --sheet --population reconstructed keeps all three rows; the forward rows say the population is not in the report', () => {
    const rows = rowsOf(cli(['tier', '--sheet', '--json', '--population', 'reconstructed']).stdout);
    assert.equal(rows.length, 3);
    assert.match(rows[0].reason, /the forward population is not in this report/);
  });

  it('cost --sheet builds the per-population counts without --population; JSON and text carry the rows ending with advisor-trial', () => {
    const doc = JSON.parse(cli(['cost', '--sheet', '--json']).stdout);
    assert.deepEqual(doc.sheet.map((r) => r.id), ['cost-forward-sample', 'cost-reconstructed-sample', 'advisor-trial']);
    assert.ok(Array.isArray(doc.populations), 'the sheet makes the report build populations (J7)');
    assert.equal(JSON.parse(cli(['cost', '--json']).stdout).populations, null, 'without --sheet the cost document keeps its default');
    const fwd = doc.sheet[0];
    assert.match(fwd.reason, /^\d+ of \d+ forward units have a costed call/);
    const text = cli(['cost', '--sheet']).stdout;
    assert.match(text, /^sheet: /m);
    assert.match(text, /^ {2}advisor-trial: cannot; n=\d+; population=not-unit-level;/m);
  });

  it('cost --sheet on a period with no rows still prints the sheet', () => {
    const r = cli(['cost', '--sheet', '--since', '2020-01-01', '--until', '2020-01-02']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^no rows$/m);
    assert.match(r.stdout, /^sheet: /m);
  });

  it('no sheet document sums rows or counts the rows that can be decided', () => {
    for (const args of [['units'], ['tier'], ['cost']]) {
      const out = cli([...args, '--sheet']).stdout;
      assert.ok(!/(\d+|all|every) (rows?|questions?) (can|cannot)/i.test(out), args[0]);
      const doc = JSON.parse(cli([...args, '--sheet', '--json']).stdout);
      for (const k of Object.keys(doc)) assert.ok(!/sheet_(count|total)|can_decide/.test(k), k);
      assert.ok(doc.sheet.every((r) => ROW_IDS.includes(r.id)));
    }
  });
});

describe('the advisor-trial row reads the environment snapshots (03-05 Task 3, D-25)', () => {
  const setting = (ctx, model) => writeFileSync(join(ctx.root, 'settings.json'), JSON.stringify({ advisorModel: model }));
  const advisorRow = (ctx, now) => rowsOf(runCli(['cost', '--sheet', '--json'], { home: ctx.home, env: calEnv(ctx.home, { RIGORSCOPE_NOW: now }) }).stdout)
    .find((r) => r.id === 'advisor-trial');

  it('two advisor_model values: cannot before a full 7-day window, with the window rule and confounder stated, and no recommendation', async () => {
    const ctx = makeHome();
    try {
      await buildCalibrateHome({ home: ctx.home, root: ctx.root });
      setting(ctx, 'claude-opus-4-5');
      await ingestHome(ctx.home, calEnv(ctx.home, { RIGORSCOPE_NOW: '2026-10-30T00:00:00Z' }));
      setting(ctx, 'claude-sonnet-4-5');
      await ingestHome(ctx.home, calEnv(ctx.home, { RIGORSCOPE_NOW: '2026-10-31T00:00:00Z' }));
      const early = advisorRow(ctx, '2026-11-02T00:00:00Z');
      assert.equal(early.status, 'cannot');
      assert.match(early.reason, /the first snapshot with a different advisor_model \(claude-sonnet-4-5\) was taken 2026-10-31T00:00:00\.000Z/);
      assert.match(early.reason, /ends 2026-11-07T00:00:00\.000Z and is not full yet/);
      assert.match(early.reason, /window = 7 days from the first snapshot whose advisor_model differs/);
      assert.match(early.reason, /role-share figures carry that confounder/);
      assert.equal(early.consumer, 'owner-rigor-decisions');
      assert.equal(early.population, 'not-unit-level');
      const late = advisorRow(ctx, '2026-11-08T00:00:00Z');
      assert.equal(late.status, 'cannot', 'a full window with no advisor part in it still cannot be decided');
      assert.match(late.reason, /neither the baseline window nor the trial window has an advisor part/);
      assert.doesNotMatch(early.reason + late.reason, /\b(should|recommend|prefer|better|worse|best)\b/i);
    } finally {
      ctx.cleanup();
    }
  });

  it('one advisor_model value in every snapshot: cannot, no window has started', async () => {
    const ctx = makeHome();
    try {
      await buildCalibrateHome({ home: ctx.home, root: ctx.root });
      setting(ctx, 'claude-opus-4-5');
      await ingestHome(ctx.home, calEnv(ctx.home, { RIGORSCOPE_NOW: '2026-10-30T00:00:00Z' }));
      await ingestHome(ctx.home, calEnv(ctx.home, { RIGORSCOPE_NOW: '2026-10-31T00:00:00Z' }));
      const r = advisorRow(ctx, '2026-12-30T00:00:00Z');
      assert.equal(r.status, 'cannot');
      assert.match(r.reason, /advisor_model is claude-opus-4-5 in every snapshot that records one; no snapshot with a different value exists, so no window has started/);
    } finally {
      ctx.cleanup();
    }
  });
});
