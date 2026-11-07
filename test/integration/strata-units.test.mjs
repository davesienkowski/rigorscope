// Plan 03-04 (TRUST-03, D-15, LEDG-03, LEDG-05, LEDG-08): `units` prints the forward and the reconstructed population as two
// strata, never one pooled figure. Every HOME is a temporary one from makeHome(); the real ~/.rigorscope is never touched.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  cliEnv, ingestHome, makeHome, runCli,
} from '../fixtures/build.mjs';
import {
  A1, C2D, STRATA_NOW, buildStrataHome, declaredAtClose, lineText, planAtStart,
} from '../fixtures/strata-home.mjs';

const TS1 = '2026-10-28T12:00:00.000Z';
const env = (home) => cliEnv(home, { TZ: 'UTC', RIGORSCOPE_NOW: STRATA_NOW });
const cli = (ctx, args) => runCli(args, { home: ctx.home, env: env(ctx.home) });
const json = (ctx, args = []) => {
  const r = cli(ctx, ['units', '--json', ...args]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

describe('tracer: one forward and two reconstructed units are two strata (03-04 Task 1)', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    buildStrataHome({ home: ctx.home, root: ctx.root, texts: [planAtStart('261030-a1b', TS1)] });
    await ingestHome(ctx.home, env(ctx.home));
  });
  after(() => ctx.cleanup());

  it('units --json lists forward n 1 then reconstructed n 2, each with its own counts, and no top-level counts', () => {
    const doc = json(ctx);
    assert.equal(doc.population, 'all');
    assert.equal(Object.hasOwn(doc, 'counts'), false, 'no counts that add the strata');
    assert.deepEqual(doc.strata.map((s) => [s.population, s.n]), [['forward', 1], ['reconstructed', 2]]);
    for (const s of doc.strata) {
      assert.equal(s.counts.units, s.n);
      assert.equal(s.costed, 0);
      assert.equal(s.low_evidence, true);
      assert.equal(s.min_n, 10);
    }
    assert.equal(doc.units.length, 3, 'one list of units');
    const by = Object.fromEntries(doc.units.map((u) => [u.key, u.population]));
    assert.equal(by[A1], 'forward');
    assert.equal(Object.values(by).filter((p) => p === 'reconstructed').length, 2);
    assert.ok(!JSON.stringify(doc).includes('"mixed"'));
  });

  it('units text prints one population line, one table and one units line per stratum, forward first', () => {
    const r = cli(ctx, ['units']);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n');
    const pops = lines.filter((l) => l.startsWith('population:'));
    assert.equal(pops.length, 2);
    assert.match(pops[0], /^population: forward n=1 costed=0 low_evidence=yes/);
    assert.match(pops[1], /^population: reconstructed n=2 costed=0 low_evidence=yes/);
    const unitsLines = lines.filter((l) => l.startsWith('units: '));
    assert.equal(unitsLines.length, 2);
    assert.match(unitsLines[0], /^units: n=1 /);
    assert.match(unitsLines[1], /^units: n=2 /);
    assert.equal(lines.filter((l) => l.startsWith('repo ')).length, 2, 'one table header per stratum');
    assert.ok(lines.indexOf(pops[0]) < lines.indexOf(unitsLines[0]) && lines.indexOf(unitsLines[0]) < lines.indexOf(pops[1]));
    assert.ok(!r.stdout.includes('population: mixed'));
  });

  it('a forward unit recorded_at_utc is its earliest ledger line time (03-03 contract, consumed here)', () => {
    const u = json(ctx).units.find((x) => x.key === A1);
    assert.equal(u.recorded_at_utc, TS1);
  });
});

describe('--population (03-04 Task 1, D-15)', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    buildStrataHome({ home: ctx.home, root: ctx.root, texts: [planAtStart('261030-a1b', TS1)] });
    await ingestHome(ctx.home, env(ctx.home));
  });
  after(() => ctx.cleanup());

  it('forward shows only the forward stratum, reconstructed only that, all and no flag both', () => {
    const f = json(ctx, ['--population', 'forward']);
    assert.equal(f.population, 'forward');
    assert.deepEqual(f.strata.map((s) => s.population), ['forward']);
    assert.deepEqual(f.units.map((u) => u.population), ['forward']);
    const rc = json(ctx, ['--population', 'reconstructed']);
    assert.deepEqual(rc.strata.map((s) => s.population), ['reconstructed']);
    assert.equal(rc.units.length, 2);
    assert.deepEqual(json(ctx, ['--population', 'all']).strata.map((s) => s.population), ['forward', 'reconstructed']);
    const t = cli(ctx, ['units', '--population', 'forward']).stdout;
    assert.ok(t.includes('population: forward') && !t.includes('population: reconstructed'));
  });

  it('an invalid or repeated value exits 2 with the fixed message, never echoes the value and prints nothing to stdout', () => {
    for (const bad of ['ALL', 'forward,reconstructed', '', 'SECRETVALUE77']) {
      const r = cli(ctx, ['units', '--population', bad]);
      assert.equal(r.status, 2, `value ${JSON.stringify(bad)}`);
      assert.equal(r.stdout, '');
      assert.ok(!r.stderr.includes('SECRETVALUE77'));
      assert.match(r.stderr, /--population/);
    }
    const twice = cli(ctx, ['units', '--population', 'forward', '--population', 'reconstructed']);
    assert.equal(twice.status, 2);
    assert.equal(twice.stdout, '');
    for (const cmd of ['tier']) {
      const r = cli(ctx, [cmd, '--population', 'x']);
      assert.equal(r.status, 2, cmd);
    }
  });
});

describe('no ledger line at all (03-04 Task 1)', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    buildStrataHome({ home: ctx.home, root: ctx.root });
    await ingestHome(ctx.home, env(ctx.home));
  });
  after(() => ctx.cleanup());

  it('the forward stratum prints n=0 costed=0 low_evidence=yes and no units; the reconstructed stratum holds every unit', () => {
    const doc = json(ctx);
    assert.deepEqual(doc.strata.map((s) => [s.population, s.n, s.costed, s.low_evidence]), [['forward', 0, 0, true], ['reconstructed', 3, 0, true]]);
    const lines = cli(ctx, ['units']).stdout.split('\n');
    const i = lines.findIndex((l) => l.startsWith('population: forward n=0 costed=0 low_evidence=yes'));
    assert.ok(i >= 0);
    assert.ok(lines.slice(i, i + 4).includes('no units'));
  });
});

describe('declared at close is shown apart in units (03-04 Task 1, D-04)', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    buildStrataHome({
      home: ctx.home,
      root: ctx.root,
      texts: [planAtStart('261030-a1b', TS1), ...declaredAtClose('261029-c2d', '2026-10-28T13:00:00.000Z', '2026-10-28T14:00:00.000Z')],
    });
    await ingestHome(ctx.home, env(ctx.home));
  });
  after(() => ctx.cleanup());

  it('declared-at-close is shown apart: the forward unit with a close-declared tier stays in the stratum n and is counted in declared_at_close', () => {
    const doc = json(ctx);
    const fwd = doc.strata[0];
    assert.equal(fwd.n, 2);
    assert.deepEqual(fwd.declared_at_close, { n: 1, A: 0, B: 1, C: 0, '?': 0 });
    assert.deepEqual(doc.strata[1].declared_at_close, { n: 0, A: 0, B: 0, C: 0, '?': 0 });
    const line = cli(ctx, ['units']).stdout.split('\n').find((l) => l.startsWith('units: n=2 '));
    assert.ok(line && line.includes('declared_at_close=1'), line);
  });
});

describe('retired literals (03-04 Task 1, TRUST-03)', () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  it('the interim mixed labels and the old population literals are gone from src/', () => {
    const src = walk(new URL('../../src', import.meta.url).pathname).filter((p) => p.endsWith('.mjs'));
    for (const f of src) {
      const text = readFileSync(f, 'utf8');
      assert.ok(!text.includes("population: 'reconstructed'"), f);
      assert.ok(!text.includes('no forward ledger in this build'), f);
      assert.ok(!text.includes("'mixed'"), f);
    }
  });
});

// ---- Task 2: incomplete list, unrecorded share and coverage on a real HOME ----------------------------------------------------
describe('incomplete, unrecorded and coverage lines (03-04 Task 2)', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    buildStrataHome({
      home: ctx.home,
      root: ctx.root,
      texts: [lineText({
        record: 'start', ts: '2026-10-29T12:00:00.000Z', native_id: '261030-a1b', tier: 'C', tier_source: 'plan-at-start',
        command: 'planted-cmd', session_id: 'sess-secret-77', runtime: 'planted-rt',
      })],
    });
    await ingestHome(ctx.home, env(ctx.home));
  });
  after(() => ctx.cleanup());

  it('incomplete is listed and counted: the start-only forward unit is listed with its age and is in the forward n', () => {
    const text = cli(ctx, ['units']).stdout.split('\n');
    const i = text.findIndex((l) => l.startsWith('incomplete: '));
    assert.equal(text[i], 'incomplete: n=1 listed=1 oldest=2d12h');
    assert.equal(text[i + 1], '  alpha quick 261030-a1b 2d12h');
    const doc = json(ctx);
    assert.equal(doc.strata[0].n, 1);
    assert.deepEqual([doc.incomplete.n, doc.incomplete.omitted, doc.incomplete.listed.length], [1, 0, 1]);
    assert.equal(doc.strata[0].coverage.tiered.d, 1, 'the incomplete unit is in the coverage denominator');
  });

  it('incomplete list shows no ledger text: no session id, command, runtime or path in the text or the JSON document', () => {
    const out = cli(ctx, ['units']).stdout + cli(ctx, ['units', '--json']).stdout.replace(/"ledger": \{[^}]*\}/g, '');
    for (const planted of ['sess-secret-77', 'planted-cmd', 'planted-rt']) assert.ok(!out.includes(planted), planted);
    const row = json(ctx).incomplete.listed[0];
    assert.deepEqual(Object.keys(row), ['repo', 'kind', 'id', 'age_ms']);
  });

  it('unrecorded prints k/n, the cutoff day and n: the fixture units first seen on or after 2026-10-29 are 2 and one has no line', () => {
    const line = cli(ctx, ['units']).stdout.split('\n').find((l) => l.startsWith('unrecorded: '));
    assert.match(line, /^unrecorded: 1\/2 \(50\.00%\) cutoff_day=2026-10-29 n=2 first_seen_unknown=0 /);
    const doc = json(ctx);
    assert.deepEqual(doc.unrecorded, { cutoff_day: '2026-10-29', n: 2, k: 1, first_seen_unknown: 0 });
    const onlyRecon = json(ctx, ['--population', 'reconstructed']);
    assert.deepEqual(onlyRecon.unrecorded, doc.unrecorded, 'the base rows ignore --population');
  });

  it('coverage prints a line per stratum with the 90% target as a line and the forward baseline pending', () => {
    const lines = cli(ctx, ['units']).stdout.split('\n').filter((l) => l.startsWith('coverage: '));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^coverage: forward tiered=1\/1 \(100\.00%\) target 90% comparable_source=1\/1 \(100\.00%\) attributed_usd=\S+ link_confidence=medium since 2026-10-29T12:00:00\.000Z attribution target baseline pending \(forward units 1 of 10\)$/);
    assert.match(lines[1], /^coverage: reconstructed tiered=1\/2 \(50\.00%\) target 90% attributed_usd=0\.000000\/0\.000420 \(0\.00%\) link_confidence=medium$/);
    assert.ok(!lines[1].includes('comparable_source'));
  });
});

describe('no ledger line: unrecorded and incomplete are quiet (03-04 Task 2)', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    buildStrataHome({ home: ctx.home, root: ctx.root });
    await ingestHome(ctx.home, env(ctx.home));
  });
  after(() => ctx.cleanup());

  it('prints incomplete n=0, unrecorded ? with cutoff none, and the empty forward coverage with ?', () => {
    const text = cli(ctx, ['units']).stdout.split('\n');
    assert.ok(text.includes('incomplete: n=0 listed=0 oldest=?'));
    assert.ok(text.some((l) => l.startsWith('unrecorded: ? cutoff_day=none n=0 ')));
    const fwd = text.find((l) => l.startsWith('coverage: forward '));
    assert.match(fwd, /tiered=0\/0 \(\?\) target 90% comparable_source=0\/0 \(\?\) attributed_usd=\? link_confidence=medium attribution target baseline pending \(forward units 0 of 10\)$/);
  });
});

describe('overhead line (03-04 Task 3)', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    buildStrataHome({
      home: ctx.home,
      root: ctx.root,
      texts: [planAtStart('261030-a1b', TS1), ...declaredAtClose('261029-c2d', '2026-10-28T13:00:00.000Z', '2026-10-28T14:00:00.000Z')],
    });
    await ingestHome(ctx.home, env(ctx.home));
  });
  after(() => ctx.cleanup());

  it('estimate is labeled and the calls per forward unit equal the fixture line counts (a start-only unit 1, a start+close unit 2)', () => {
    const line = cli(ctx, ['units']).stdout.split('\n').find((l) => l.startsWith('overhead: '));
    assert.match(line, /^overhead: estimate \(chars\/4\) tokens per unit kind: plan=\d+(\.\d+)? quick=\d+(\.\d+)? cap=300; ledger calls per forward unit \(ledger lines\) median=1 max=2 \(forward units 2\); finding=none /);
    const o = json(ctx).overhead;
    assert.equal(o.label, 'estimate (chars/4)');
    assert.deepEqual(o.ledger_calls, { n: 2, median: 1, max: 2 });
    assert.deepEqual(o.finding, []);
  });
});
