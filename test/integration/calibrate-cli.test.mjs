// Plan 03-05 (LEDG-06, D-19): `rigorscope calibrate` through the CLI on temporary HOMEs. The real ~/.rigorscope is never touched.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, runCli } from '../fixtures/build.mjs';
import { buildCalibrateHome, calEnv } from '../fixtures/calibrate-home.mjs';

const cli = (ctx, args) => runCli(args, { home: ctx.home, env: calEnv(ctx.home) });
const json = (ctx, args = []) => {
  const r = cli(ctx, ['calibrate', '--json', ...args]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

describe('tracer: one pair whose ledger tier differs from reconstruction (03-05 Task 1)', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    await buildCalibrateHome({ home: ctx.home, root: ctx.root, pairs: [{ id: 'a1b', tier: 'B' }] });
  });
  after(() => ctx.cleanup());

  it('calibrate --json: fields[0] is tier with agree 0, disagree 1, unknown 0, n 1, low evidence, and pairs is 1', () => {
    const doc = json(ctx);
    assert.equal(doc.schema, 'rigorscope.calibrate/1');
    assert.equal(doc.pairs, 1);
    assert.equal(doc.ledger_only, 0);
    const t = doc.fields[0];
    assert.equal(t.field, 'tier');
    assert.deepEqual([t.agree, t.disagree, t.unknown, t.n, t.low_evidence], [0, 1, 0, 1, true]);
  });

  it('calibrate text prints a pairs: line and a tier: line, both with n', () => {
    const r = cli(ctx, ['calibrate']);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n');
    const pairs = lines.find((l) => l.startsWith('pairs: '));
    const tier = lines.find((l) => l.startsWith('tier: '));
    assert.match(pairs, /pairs=1/);
    assert.match(tier, /agree=0 disagree=1 unknown=0 n=1 ledger_unrecorded=0 low_evidence=yes/);
  });
});

// ---- all four fields (03-05 Task 2) -------------------------------------------------------------------------------------------
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { stateDirOf } from '../fixtures/build.mjs';
import { calKey } from '../fixtures/calibrate-home.mjs';

const PLANTED = { session: 'sess-planted-aaa', command: 'planted-cmd' };
const PAIRS = [
  { id: 'a1b', tier: 'B', startMin: 10, endMin: 0, session: 'sess-cal-a' }, // tier A vs B: disagree; end before start: clamped
  { id: 'c2d', tier: 'A', startMin: 45, endMin: null, session: null }, // recon tier NULL: unknown
  { id: 'e3f', tier: 'C', startMin: -300, endMin: 5, session: 'sess-cal-e' }, // tier conflict: unknown; start 5 hours before the reconstructed quick-id day start (04:00Z): the day before; end 5 minutes from the reconstructed end
  { id: 'p1a', tier: 'B', startMin: 0, endMin: 20, session: PLANTED.session }, // tier B vs B: agree
  { id: 'p1b', tier: 'A', startMin: 31, endMin: null, session: 'sess-cal-b' }, // recon tier NULL: unknown
];

describe('five pairs through the CLI (03-05 Task 2)', () => {
  let ctx;
  let built;
  before(async () => {
    ctx = makeHome();
    built = await buildCalibrateHome({ home: ctx.home, root: ctx.root, pairs: PAIRS });
    // Reconstruction finds no session links in this fixture; plant link rows in the temporary derived.db so the session field has
    // an agree (a1b), a disagree (p1a links another session) and an unknown (e3f, p1b have no link row).
    // The second ingest made derived.db stale; build it first so the planted rows are not wiped by a rebuild on the first report.
    assert.equal(cli(ctx, ['units', '--json']).status, 0);
    const db = new DatabaseSync(join(stateDirOf(ctx.home), 'derived.db'));
    const ins = db.prepare(`INSERT INTO unit_link (session_id, agent_id, unit_key, method, confidence, base_confidence, phase_level)
                            VALUES (?, '', ?, 'interval', 'low', 'low', 0)`);
    ins.run('sess-cal-a', calKey('a1b'));
    ins.run('sess-cal-other', calKey('p1a'));
    db.close();
  });
  after(() => ctx.cleanup());

  it('tier: exact counts (agree 1, disagree 1, unknown 3, n 5), low evidence because only 2 pairs were compared (review M2)', () => {
    const t = json(ctx).fields.find((f) => f.field === 'tier');
    assert.deepEqual([t.agree, t.disagree, t.unknown, t.n, t.compared, t.ledger_unrecorded, t.low_evidence], [1, 1, 3, 5, 2, 0, true]);
  });

  it('start: every reconstructed start is a quick-id day, so the five pairs are compared by local day (review H1)', () => {
    // The reconstructed start is 04:00Z of the quick id day; ledger starts sit 10, 45, -300, 0 and 31 minutes from it: only the -300 falls on the day before.
    const s = json(ctx).fields.find((f) => f.field === 'start');
    assert.deepEqual([s.agree, s.disagree, s.unknown, s.n, s.median_min, s.max_min, s.within_min], [4, 1, 0, 5, null, null, 30]);
    assert.deepEqual(s.compared_by, { instant: 0, day: 5 });
  });

  it('end: only three pairs have a close line; the clamped end (a1b closes before it starts) is unknown, not disagree', () => {
    const e = json(ctx).fields.find((f) => f.field === 'end');
    assert.ok(built.recon.e3f.recon_end_ms !== null && built.recon.p1a.recon_end_ms !== null, 'the fixture reconstructs those two ends');
    assert.deepEqual([e.agree, e.disagree, e.unknown, e.n, e.ledger_unrecorded], [2, 0, 1, 3, 2]);
    assert.deepEqual([e.median_min, e.max_min], [5, 20]);
    assert.deepEqual(e.compared_by, { instant: 2, day: 0 });
  });

  it('session: agree 1, disagree 1, unknown 2, one pair without a ledger session left out', () => {
    const s = json(ctx).fields.find((f) => f.field === 'session');
    assert.deepEqual([s.agree, s.disagree, s.unknown, s.n, s.ledger_unrecorded], [1, 1, 2, 4, 1]);
  });

  it('the text prints four field lines, `?` is not printed where a median exists and no line carries a total', () => {
    const r = cli(ctx, ['calibrate']);
    const keys = r.stdout.split('\n').filter((l) => /^(tier|start|end|session): /.test(l)).map((l) => l.split(':')[0]);
    assert.deepEqual(keys, ['tier', 'start', 'end', 'session']);
    assert.match(r.stdout, /^start: .*median_min=\? max_min=\? within=30 compared_by: instant=0 day=5$/m);
    assert.match(r.stdout, /^end: .*median_min=5 max_min=20 within=30 compared_by: instant=2 day=0$/m);
    assert.ok(!/\btotal\b|\brate\b|accuracy/.test(r.stdout));
  });

  it('--evidence lists at most 5 disagreeing u: ids per field and shows no ledger text (calibrate shows no ledger text)', () => {
    const text = cli(ctx, ['calibrate', '--evidence']).stdout;
    const doc = JSON.stringify(json(ctx, ['--evidence']));
    assert.match(text, /^evidence \(disagreeing units per field/m);
    assert.match(text, /^ {2}tier: u[:]/m);
    for (const planted of [PLANTED.session, 'sess-cal-a', 'sess-cal-other', 'planted-cmd']) {
      assert.ok(!text.includes(planted) && !doc.includes(planted), `no ledger text ${planted}`);
    }
    assert.ok(!text.includes(ctx.home) && !doc.includes(ctx.home), 'no path');
  });
});

describe('an empty store and flag validation (03-05 Task 2)', () => {
  let ctx;
  before(() => { ctx = makeHome(); });
  after(() => ctx.cleanup());

  it('with no forward unit every field prints n 0, low evidence and `?` medians', () => {
    const r = cli(ctx, ['calibrate']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^pairs: pairs=0 ledger_only=0 /m);
    assert.match(r.stdout, /^start: agree=0 disagree=0 unknown=0 n=0 ledger_unrecorded=0 low_evidence=yes median_min=\? max_min=\? within=30 compared_by: instant=0 day=0$/m);
  });

  it('a bad zone is a usage error (exit 2) before any state is touched', () => {
    const r = cli(ctx, ['calibrate', '--tz', 'Nowhere/Land']);
    assert.equal(r.status, 2);
    assert.ok(!r.stderr.includes('Nowhere'), 'the value is not echoed');
  });
});
