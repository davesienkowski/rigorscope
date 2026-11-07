// Recognition test on the real stock-run samples (plan 03.1-05, ADPT-04, ADPT-05, D-10, D-13, D-20). The stages under
// test/fixtures/stock-run/<stage>/.planning/ are applied in order to a temporary repo (wholesale replace of .planning/, commit at
// a fixed date as `fixture`), the CLI ingests after each stage on a temporary HOME, and the numbers it prints and stores are
// checked against an independent census (test/helpers/stock-run-census.mjs): the walker lists files with readdirSync and applies
// its own regexes; it does not import the adapter's layout or classifier. The roster is imported only to name the two list files.
//
// Skip rule: skipped visibly only when test/fixtures/stock-run/ and the result file are both absent; fails when the result exists
// and the fixtures do not.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliEnv, makeHome, runCli } from '../fixtures/build.mjs';
import { commitAt, makeRepo } from '../fixtures/git-repo.mjs';
import { census, rosterLists } from '../helpers/stock-run-census.mjs';
import { privateRef, skipUnlessPrivate } from '../helpers/tree-kind.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const FIX = join(REPO, 'test', 'fixtures', 'stock-run');
// The result record is private (null in a public tree): the recognition tests run on the fixtures in both trees, and the
// pairing rule with the record holds in the private tree only.
const RESULT = privateRef('stock-run-result');
const STAGES = ['m1-complete', 'm2-executed', 'm2-complete'];
const SKIP_REASON = 'no stock-run fixtures and no result file yet';
const noneYet = !existsSync(FIX) && (RESULT === null || !existsSync(RESULT));

const lineOf = (lines, prefix) => lines.find((l) => l.startsWith(prefix));
const counters = (line, prefix) => Object.fromEntries(line.slice(prefix.length).split(' ').map((t) => t.split('=')));

describe('stock-run fixtures are recognized by an independent census', { skip: noneYet ? SKIP_REASON : false }, () => {
  it('the result file and the fixtures exist together', { skip: skipUnlessPrivate('stock-run-result') }, () => {
    if (existsSync(RESULT)) assert.ok(existsSync(FIX), 'the result file exists but test/fixtures/stock-run/ does not');
    if (existsSync(FIX)) assert.ok(existsSync(RESULT), 'test/fixtures/stock-run/ exists but the result file does not');
  });

  const present = STAGES.filter((s) => existsSync(join(FIX, s, '.planning')));
  let ctx;
  let repo;
  const runs = {};
  before(() => {
    if (!existsSync(FIX)) return;
    ctx = makeHome();
    repo = join(ctx.home, 'src', 'stock');
    makeRepo(repo, { home: ctx.home, files: { 'README.md': 'stock\n' } });
    const env = cliEnv(ctx.home, { TZ: 'UTC', RIGORSCOPE_REPO_ROOTS: repo });
    present.forEach((stage, i) => {
      rmSync(join(repo, '.planning'), { recursive: true, force: true });
      cpSync(join(FIX, stage, '.planning'), join(repo, '.planning'), { recursive: true });
      commitAt(repo, { home: ctx.home, date: `2026-11-0${i + 1}T12:00:00Z`, message: `stage ${i + 1}` });
      const r = runCli(['ingest'], { home: ctx.home, env });
      assert.equal(r.status, 0, r.stderr);
      const lines = r.stdout.split('\n').filter((l) => l !== '');
      const units = runCli(['units', '--json'], { home: ctx.home, env });
      assert.equal(units.status, 0, units.stderr);
      runs[stage] = { lines, units: JSON.parse(units.stdout).units, census: census(join(repo, '.planning')) };
    });
  });
  after(() => ctx?.cleanup());

  it('every stage is present', () => {
    assert.deepEqual(present, STAGES, 'all three stages are committed');
  });

  for (const stage of STAGES) {
    describe(stage, () => {
      it('conservation: every PLAN file of a phase root is a unit, a counted form or a skipped path', () => {
        const run = runs[stage];
        assert.ok(run, 'the stage ran');
        const loc = counters(lineOf(run.lines, 'locations: '), 'locations: ');
        const unread = Object.entries(loc).filter(([k]) => /^not_read_(?:bare_plan|plan_)/.test(k)).reduce((n, [, v]) => n + Number(v), 0);
        const planUnits = run.units.filter((u) => u.kind === 'plan').length;
        assert.ok(planUnits + unread <= run.census.plans.length, `units ${planUnits} + counted forms ${unread} exceed the ${run.census.plans.length} plan files`);
        assert.ok(planUnits + unread >= 1, 'at least one plan file is accounted for');
        assert.equal(planUnits + unread, run.census.plans.length, 'every plan file is a unit or a counted form (skipped paths are zero in the samples)');
      });

      it('classification: recognized_f + recognized_e + recognized_s + unclassified equals the walker file count', () => {
        const run = runs[stage];
        const c = counters(lineOf(run.lines, 'classes: '), 'classes: ');
        const total = Number(c.recognized_f) + Number(c.recognized_e) + Number(c.recognized_s) + Number(c.unclassified);
        assert.equal(total, run.census.files);
      });

      it('no repeated id and no percent sign on the locations, classes and doctor lines', () => {
        const run = runs[stage];
        assert.equal(run.census.repeated, 0, 'the walker finds a repeated plan id in the stage');
        assert.equal(counters(lineOf(run.lines, 'locations: '), 'locations: ').repeat_id, '0');
        const doctor = runCli(['doctor'], { home: ctx.home, env: cliEnv(ctx.home, { TZ: 'UTC', RIGORSCOPE_REPO_ROOTS: repo }) });
        for (const text of [lineOf(run.lines, 'locations: '), lineOf(run.lines, 'classes: '), doctor.stdout]) assert.ok(!text.includes('%'));
      });
    });
  }

  it('an archived unit keeps its key from m2-executed to m2-complete and the last ingest shows a move', () => {
    const before = runs['m2-executed'];
    const last = runs['m2-complete'];
    assert.ok(before && last, 'both stages ran');
    const keysAfter = new Set(last.units.map((u) => u.key));
    const moved = before.units.filter((u) => /v1\.1|^\.planning\/phases/.test(u.dir ?? '')).filter((u) => keysAfter.has(u.key));
    assert.ok(moved.length >= 1, 'a unit of the live v1.1 dir is still listed after the archive');
    const loc = counters(lineOf(last.lines, 'locations: '), 'locations: ');
    assert.ok(Number(loc.moved) >= 1, 'the locations line shows moved at least 1');
    const archived = last.units.filter((u) => keysAfter.has(u.key) && /^\.planning\/milestones\/.+-phases\//.test(u.dir ?? ''));
    assert.ok(archived.length >= 1 && archived.every((u) => u.present === true), 'the moved unit is present at its archive dir');
  });

  it('ROSTER-GAPS.txt and ROSTER-NOT-SCANNED.txt are not stale', () => {
    const lists = rosterLists(STAGES.map((st) => runs[st].census));
    const read = (f) => readFileSync(join(FIX, f), 'utf8').split('\n').filter((l) => l !== '');
    assert.deepEqual(read('ROSTER-GAPS.txt'), lists.gaps);
    assert.deepEqual(read('ROSTER-NOT-SCANNED.txt'), lists.notScanned);
  });
});
