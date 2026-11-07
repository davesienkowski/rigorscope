// Git times of archived units (plan 03.1-03 Task 1, ADPT-05, D-07, D-19; 02-05 WR-06, CR-02, WR-01; todo case B1; review
// 03.1-01 and 03.1-02 regression rows). A unit whose dir sits under `.planning/milestones/<label>-phases/` takes its start,
// commit lower bound, artifact first-commit, tier-commit and last-change times from the history of its FORMER live path
// (a pure path rewrite, no rename detection); the archive commit is an upper bound of the last-change window only, never a
// start, an end or an artifact time; where the former path has no history the time is unknown (null).
// Every repo is a real git repository inside a temporary HOME from makeHome(), reached through RIGORSCOPE_REPO_ROOTS;
// commits carry fixed author dates (commitAt). Plan and tier commits carry no `(01-01)` scope in their subject on purpose:
// a scoped commit would give the unit a start through its commits and hide a wrong first-add lookup. Expected instants are
// written by hand below. The CLI is spawned; the stores are read with queryDb only.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  cliEnv, makeHome, queryDb, runCli, stateDirOf,
} from '../fixtures/build.mjs';
import {
  archiveDir, commitAt, git, makeRepo, planText, writeFileAt, writePlanningDir,
} from '../fixtures/git-repo.mjs';
import { openStore, storePath } from '../../src/db.mjs';
import { collectFacts } from '../../src/adapters/gsd-core/facts.mjs';
import * as layout from '../../src/adapters/gsd-core/layout.mjs';
import {
  artifactCommitIndex, collectUnitSignals, defaultGitRun, locateUnitDir,
} from '../../src/adapters/gsd-core/signals.mjs';

const T = {
  old: '2025-12-01T10:00:00Z',
  plan: '2026-01-01T10:00:00Z',
  edit: '2026-01-05T10:00:00Z',
  code: '2026-02-01T10:00:00Z',
  archive: '2026-09-01T10:00:00Z',
  between: '2026-09-05T10:00:00Z',
  reuse: '2026-09-10T10:00:00Z',
  later: '2026-11-03T10:00:00Z',
  archive2: '2026-12-01T10:00:00Z',
};
const ms = (k) => Date.parse(T[k]);
const utc = (k) => new Date(ms(k)).toISOString();
const LIVE = '.planning/phases/01-setup';
const ARCHIVE = '.planning/milestones/v1.0-phases/01-setup';
const ARCHIVE2 = '.planning/milestones/v1.1-phases/01-setup';
const PLAN_ARCHIVE = `${ARCHIVE}/01-01-PLAN.md`;
const SUMMARY_ARCHIVE = `${ARCHIVE}/01-01-SUMMARY.md`;

const made = [];
afterEach(() => { while (made.length > 0) made.pop().cleanup(); });

// A home with one repo at <home>/src/<name>, built by build(repo, home), reached through the roots variable.
function setup(name, build) {
  const ctx = makeHome();
  made.push(ctx);
  const repo = join(ctx.home, 'src', name);
  makeRepo(repo, { home: ctx.home, files: { 'README.md': `${name}\n` } });
  build(repo, ctx.home);
  const env = cliEnv(ctx.home, { TZ: 'UTC', RIGORSCOPE_REPO_ROOTS: repo });
  return {
    ctx, repo, env, home: ctx.home, repoKey: `~/src/${name}/.git`, key: `gsd-core:~/src/${name}/.git:plan:01-01`,
  };
}
const ingest = (s) => {
  const r = runCli(['ingest'], { home: s.home, env: s.env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter((l) => l !== '');
};
const unitsDoc = (s) => {
  const r = runCli(['units', '--json'], { home: s.home, env: s.env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const unitOf = (s) => unitsDoc(s).units.find((u) => u.key === s.key);
const storeRows = (s, sql, params = []) => queryDb(storePath(s.home), sql, params);
const derivedRows = (s, sql, params = []) => queryDb(join(stateDirOf(s.home), 'derived.db'), sql, params);
const firstOf = (s, rel) => storeRows(s, 'SELECT first_commit_ms AS v FROM unit_artifact WHERE unit_key = ? AND rel_path = ?', [s.key, rel])[0]?.v;
const timeOf = (s, rel) => storeRows(s, 'SELECT tier_commit_ms AS tier, last_commit_ms AS last FROM unit_artifact_time WHERE unit_key = ? AND rel_path = ?', [s.key, rel])[0];

// The tracer fixture: plan and summary under the live phase dir, an earlier milestone's commit naming the same plan id,
// a code commit, then the archive move; the first ingest happens after the archive.
function archivedUnit(name) {
  return setup(name, (repo, home) => {
    writeFileAt(repo, 'src/old.mjs', 'export const old = 1;\n');
    commitAt(repo, { home, date: T.old, message: 'feat(01-01): an earlier milestone used this id' });
    writePlanningDir(repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'A' }) } });
    commitAt(repo, { home, date: T.plan, message: 'chore: add planning' });
    writeFileAt(repo, 'src/code.mjs', 'export const code = 1;\n');
    writeFileAt(repo, `${LIVE}/01-01-SUMMARY.md`, planText({ tier: 'A' }));
    commitAt(repo, { home, date: T.code, message: 'feat(01-01): the code' });
    archiveDir(repo, { home, name: '01-setup', label: 'v1.0' });
    commitAt(repo, { home, date: T.archive, message: 'chore: archive v1.0' });
  });
}

describe('tracer: an archived unit starts where its plan started', () => {
  it('archive date is never a start', () => {
    const s = archivedUnit('tracer');
    ingest(s);
    const u = unitOf(s);
    assert.ok(u, 'the unit is listed');
    assert.equal(u.dir, ARCHIVE, 'first seen archived: the stored dir is the archive dir');
    assert.equal(u.start.utc, utc('plan'));
    assert.equal(u.start.date_source, 'git');
    assert.equal(u.commits_bounded, true, 'the lower bound is the PLAN first add under the former live path');
    assert.deepEqual(u.confounders.unit_size.value.commits, 1, 'the commit before the plan is left out by the bound');
    assert.equal(u.end.utc, utc('code'));
    assert.equal(u.end.date_source, 'git');
    assert.equal(firstOf(s, PLAN_ARCHIVE), ms('plan'));
    assert.equal(firstOf(s, SUMMARY_ARCHIVE), ms('code'));
    assert.deepEqual(timeOf(s, PLAN_ARCHIVE), { tier: ms('plan'), last: ms('plan') });
    assert.equal(timeOf(s, SUMMARY_ARCHIVE).last, ms('code'));
    const archived = ms('archive');
    for (const row of storeRows(s, 'SELECT first_commit_ms AS v FROM unit_artifact UNION ALL SELECT tier_commit_ms FROM unit_artifact_time UNION ALL SELECT last_commit_ms FROM unit_artifact_time')) {
      assert.notEqual(row.v, archived, 'no stored artifact time is the archive commit time');
    }
    const row = derivedRows(s, 'SELECT start_ms, end_ms FROM unit WHERE unit_key = ?', [s.key])[0];
    assert.notEqual(row.start_ms, archived);
    assert.notEqual(row.end_ms, archived);
  });

  it('collectUnitSignals resolves the archive-class artifact through the former live path (R1 W2)', () => {
    const s = archivedUnit('tracer-signals');
    const row = collectUnitSignals({ top: s.repo, kind: 'plan', nativeId: '01-01', home: s.home });
    assert.equal(row.located, true);
    assert.equal(row.dir_rel, ARCHIVE);
    assert.equal(row.git, 'ok');
    const plan = row.artifacts.find((a) => a.role === 'plan');
    assert.equal(plan.rel_path, PLAN_ARCHIVE);
    assert.equal(plan.first_commit_ms, ms('plan'), 'not the archive commit time');
    assert.equal(plan.tier_commit_ms, ms('plan'));
    assert.equal(row.artifacts.find((a) => a.role === 'summary').first_commit_ms, ms('code'));
  });
});

describe('the former path decides every time of an archived artifact', () => {
  it('WR-06: a plan added directly in the archive has no history under the live path, so start is mtime and nothing is the archive date', () => {
    const mtime = Date.parse('2026-03-03T03:00:00Z');
    const s = setup('wr06', (repo, home) => {
      writeFileAt(repo, PLAN_ARCHIVE, planText({ tier: 'B' }), { mtimeMs: mtime });
      commitAt(repo, { home, date: T.archive, message: 'chore: add archive' });
    });
    // The archive path IS in the first-add index (the pathspec grew); the unit must still not read it.
    const index = artifactCommitIndex({ top: join(s.repo, '.git') });
    assert.equal(index.firstAddMs.get(PLAN_ARCHIVE), ms('archive'), 'the index sees the archive add');
    ingest(s);
    const u = unitOf(s);
    assert.equal(u.start.date_source, 'mtime');
    assert.equal(u.start.utc, new Date(mtime).toISOString());
    assert.equal(u.commits_bounded, false);
    assert.equal(firstOf(s, PLAN_ARCHIVE), null);
    assert.equal(timeOf(s, PLAN_ARCHIVE), undefined, 'no tier or last time row exists for it');
    assert.equal(derivedRows(s, 'SELECT count(*) AS n FROM unit WHERE start_ms = ? OR end_ms = ?', [ms('archive'), ms('archive')])[0].n, 0);
  });

  it('B1 same commit move and reuse never pairs: one commit archives 01-setup and adds 01-new', () => {
    const s = setup('b1', (repo, home) => {
      writePlanningDir(repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'A' }) } });
      commitAt(repo, { home, date: T.plan, message: 'chore: add planning' });
      writeFileAt(repo, 'src/code.mjs', 'export const code = 1;\n');
      commitAt(repo, { home, date: T.code, message: 'feat(01-01): the code' });
      archiveDir(repo, { home, name: '01-setup', label: 'v1.0' });
      writePlanningDir(repo, { under: 'phases', name: '01-new', files: { '01-01-PLAN.md': planText({ tier: 'C' }) } });
      commitAt(repo, { home, date: T.archive, message: 'chore: archive v1.0 and start v1.1' });
    });
    ingest(s);
    const u = unitOf(s);
    assert.equal(u.dir, ARCHIVE);
    assert.equal(u.start.utc, utc('plan'));
    assert.equal(u.end.utc, utc('code'));
    assert.equal(firstOf(s, PLAN_ARCHIVE), ms('plan'));
    assert.deepEqual(storeRows(s, "SELECT rel_path FROM unit_artifact WHERE rel_path LIKE '%01-new%'"), [], 'the new dir has no row under the old unit');
    assert.equal(derivedRows(s, 'SELECT id_repeats AS n FROM unit WHERE unit_key = ?', [s.key])[0].n, 1);
    // No rename option on the first-add index (D-07, the todo's stop rule).
    const calls = [];
    artifactCommitIndex({ top: join(s.repo, '.git'), run: (args) => { calls.push(args); return defaultGitRun(args); } });
    const added = calls.find((a) => a.includes('--diff-filter=A'));
    assert.ok(added, 'the first-add call');
    assert.ok(added.includes('--no-renames'));
    const logArgs = added.slice(added.indexOf('log'));
    for (const bad of ['--follow', '-M', '-C', '--find-renames', '--find-copies', '--find-copies-harder']) {
      assert.ok(!logArgs.some((a) => a === bad || a.startsWith(`${bad}=`)), `${bad} is not asked`);
    }
  });

  it('CR-02: the archive commit is never the unit git end, with a rename (high similarity)', () => {
    const s = archivedUnit('cr02-high');
    ingest(s);
    assert.equal(unitOf(s).end.utc, utc('code'));
    assert.notEqual(derivedRows(s, 'SELECT end_ms FROM unit WHERE unit_key = ?', [s.key])[0].end_ms, ms('archive'));
  });

  it('CR-02 twin: a move whose content changed (git reports delete plus add) still ends at the last real change', () => {
    const s = setup('cr02-low', (repo, home) => {
      writePlanningDir(repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'A', body: 'alpha beta gamma delta '.repeat(20) }) } });
      commitAt(repo, { home, date: T.plan, message: 'chore: add planning' });
      writeFileAt(repo, 'src/code.mjs', 'export const code = 1;\n');
      commitAt(repo, { home, date: T.code, message: 'feat(01-01): the code' });
      archiveDir(repo, { home, name: '01-setup', label: 'v1.0' });
      writeFileAt(repo, PLAN_ARCHIVE, planText({ tier: 'A', body: 'zzzz yyyy xxxx wwww '.repeat(25) }));
      commitAt(repo, { home, date: T.archive, message: 'chore: archive v1.0, rewritten' });
    });
    const rename = git(s.repo, ['log', '-1', '--find-renames', '--name-status', '--format='], { home: s.home });
    assert.match(rename, /^A\t.*milestones/m, `git reports delete plus add here, not a rename: ${rename}`);
    ingest(s);
    const u = unitOf(s);
    assert.equal(u.end.utc, utc('code'));
    assert.equal(u.end.date_source, 'git');
    assert.equal(timeOf(s, PLAN_ARCHIVE).last, ms('plan'));
  });

  it('WR-01: a later milestone that reuses the plan id attaches its commits to the old unit and id_repeats is above 0', () => {
    const s = setup('wr01', (repo, home) => {
      writePlanningDir(repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'A' }) } });
      commitAt(repo, { home, date: T.plan, message: 'chore: add planning' });
      archiveDir(repo, { home, name: '01-setup', label: 'v1.0' });
      commitAt(repo, { home, date: T.archive, message: 'chore: archive v1.0' });
      writePlanningDir(repo, { under: 'phases', name: '01-new', files: { '01-01-PLAN.md': planText({ tier: 'C' }) } });
      commitAt(repo, { home, date: T.reuse, message: 'chore: start v1.1' });
      writeFileAt(repo, 'src/later.mjs', 'export const later = 1;\n');
      commitAt(repo, { home, date: T.later, message: 'feat(01-01): the later milestone' });
    });
    ingest(s);
    const u = unitOf(s);
    assert.equal(u.dir, ARCHIVE);
    assert.equal(u.start.utc, utc('plan'));
    assert.equal(u.end.utc, utc('later'), 'the documented 02-05 WR-01 limit: the later commit attaches');
    assert.equal(derivedRows(s, 'SELECT id_repeats AS n FROM unit WHERE unit_key = ?', [s.key])[0].n, 1);
  });
});

describe('a reused dir name does not extend an archived unit (R1 W1)', () => {
  // v1.0 01-setup: plan added at plan, edited at edit, archived at archive. v1.1 reuses 01-setup (reset numbering): re-added
  // at reuse, edited at later, archived at archive2. No commit subject carries the plan id scope.
  function reused(name) {
    return setup(name, (repo, home) => {
      writePlanningDir(repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'A', body: 'v1.0 plan' }) } });
      commitAt(repo, { home, date: T.plan, message: 'chore: add planning' });
      writeFileAt(repo, `${LIVE}/01-01-PLAN.md`, planText({ tier: 'A', body: 'v1.0 plan, edited' }));
      commitAt(repo, { home, date: T.edit, message: 'chore: edit planning' });
      archiveDir(repo, { home, name: '01-setup', label: 'v1.0' });
      commitAt(repo, { home, date: T.archive, message: 'chore: archive v1.0' });
      writePlanningDir(repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'A', body: 'v1.1 plan' }) } });
      commitAt(repo, { home, date: T.reuse, message: 'chore: start v1.1' });
      writeFileAt(repo, `${LIVE}/01-01-PLAN.md`, planText({ tier: 'A', body: 'v1.1 plan, edited later' }));
      commitAt(repo, { home, date: T.later, message: 'chore: reset numbering edit' });
      archiveDir(repo, { home, name: '01-setup', label: 'v1.1' });
      commitAt(repo, { home, date: T.archive2, message: 'chore: archive v1.1' });
    });
  }

  it('a reused dir name does not extend an archived unit: the v1.0 copy ends at its own last real change', () => {
    const s = reused('reuse');
    ingest(s);
    const u = unitOf(s);
    assert.equal(u.dir, ARCHIVE, 'oldest archive first: the v1.0 copy is the unit');
    assert.equal(u.start.utc, utc('plan'));
    assert.equal(u.end.utc, utc('edit'), 'not the v1.1 edit');
    assert.equal(u.end.date_source, 'git');
    assert.equal(timeOf(s, PLAN_ARCHIVE).last, ms('edit'));
    assert.deepEqual(storeRows(s, "SELECT rel_path FROM unit_artifact WHERE rel_path LIKE '%v1.1-phases%'"), [], 'the later copy is not read into the unit');
    assert.equal(derivedRows(s, 'SELECT id_repeats AS n FROM unit WHERE unit_key = ?', [s.key])[0].n, 1);
    assert.ok(ARCHIVE2.includes('v1.1'));
  });

  it('the fast path makes no extra git call; a reused name costs one bounded log of that one path', async () => {
    const fast = archivedUnit('fast');
    ingest(fast);
    const slow = reused('slow');
    ingest(slow);
    const targeted = async (s) => {
      const db = openStore({ home: s.home });
      try {
        db.exec(`UPDATE unit_git_scan SET refs_sha = '${'0'.repeat(64)}'`);
        const runId = db.prepare('SELECT max(run_id) AS r FROM ingest_run').get().r;
        const calls = [];
        const out = await collectFacts({
          db, home: s.home, runId, run: (args) => { calls.push(args); return defaultGitRun(args); },
        });
        assert.equal(out.facts, 'ok');
        assert.ok(out.units > 0, 'the stale cursor makes the unit rescan');
        // A single-path log: the pathspec after `--` is exactly one planning file.
        return calls.filter((a) => a.includes('log') && a.indexOf('--') === a.length - 2 && a[a.length - 1].startsWith('.planning/')).length;
      } finally {
        db.close();
      }
    };
    assert.equal(await targeted(fast), 0, 'no reuse: the newest-per-path answer is used');
    assert.equal(await targeted(slow), 1, 'a reused dir name: exactly one targeted log for the one affected artifact');
    assert.equal(unitOf(slow).end.utc, utc('edit'), 'still the v1.0 end after the rescan');
  });
});

// Review 03.1-03 CR-01 and WR-01: the archive path's own first-add time bounds EVERY time taken from the former live path
// (first add, tier commit, commit lower bound `since`, last change), not only the last change. A plan committed straight into
// the archive dir has no former-path history before its archive; a later milestone that reuses the dir name adds the former
// path AFTER that, and none of that history is this unit's. One test per time, so each bound has its own named failure.
describe('CR-01: an archived unit whose former path has no history before its archive takes nothing from a later milestone', () => {
  const MTIME = Date.parse('2026-03-03T03:00:00Z');
  // v1.0: the plan is committed directly in the archive dir (T.archive, tier B). v1.1 re-adds the live path (T.reuse, tier A),
  // edits it (T.later) and archives it into v1.1-phases (T.archive2). No commit subject carries the plan id scope.
  function direct(name, { scoped = false } = {}) {
    return setup(name, (repo, home) => {
      writeFileAt(repo, PLAN_ARCHIVE, planText({ tier: 'B', body: 'v1.0 plan' }), { mtimeMs: MTIME });
      commitAt(repo, { home, date: T.archive, message: 'chore: add the v1.0 archive' });
      if (scoped) {
        writeFileAt(repo, 'src/v10.mjs', 'export const v10 = 1;\n');
        commitAt(repo, { home, date: T.between, message: 'feat(01-01): v1.0 code after the archive' });
      }
      writePlanningDir(repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'A', body: 'v1.1 plan' }) } });
      commitAt(repo, { home, date: T.reuse, message: 'chore: start v1.1' });
      writeFileAt(repo, `${LIVE}/01-01-PLAN.md`, planText({ tier: 'A', body: 'v1.1 plan, edited later' }));
      commitAt(repo, { home, date: T.later, message: 'chore: edit v1.1' });
      archiveDir(repo, { home, name: '01-setup', label: 'v1.1' });
      commitAt(repo, { home, date: T.archive2, message: 'chore: archive v1.1' });
    });
  }

  it('CR-01 start: the start is the file modification time, not the next milestone', () => {
    const s = direct('cr01-start');
    ingest(s);
    const u = unitOf(s);
    assert.equal(u.dir, ARCHIVE, 'oldest archive first: the v1.0 copy is the unit');
    assert.equal(u.start.date_source, 'mtime');
    assert.equal(u.start.utc, new Date(MTIME).toISOString());
    assert.equal(derivedRows(s, 'SELECT count(*) AS n FROM unit WHERE start_ms = ? OR end_ms = ?', [ms('reuse'), ms('reuse')])[0].n, 0);
  });

  it('CR-01 first add: the archived plan has no first-commit time', () => {
    const s = direct('cr01-first');
    ingest(s);
    assert.equal(firstOf(s, PLAN_ARCHIVE), null);
  });

  it('CR-01 tier: the archived plan has no tier-commit time', () => {
    const s = direct('cr01-tier');
    ingest(s);
    assert.equal(timeOf(s, PLAN_ARCHIVE)?.tier ?? null, null);
  });

  it('CR-01 commits_bounded: the lower bound is unknown, so the unit is not marked bounded', () => {
    const s = direct('cr01-bounded');
    ingest(s);
    assert.equal(unitOf(s).commits_bounded, false);
  });

  it('CR-01 since: a commit of the unit made before the next milestone is kept (no lower bound is taken from the next milestone)', () => {
    const s = direct('cr01-since', { scoped: true });
    ingest(s);
    assert.equal(storeRows(s, 'SELECT count(*) AS n FROM unit_commit WHERE unit_key = ?', [s.key])[0].n, 1);
    assert.equal(unitOf(s).confounders.unit_size.value.commits, 1);
  });

  it('CR-01 last change: the archived plan has no last-change time', () => {
    const s = direct('cr01-last');
    ingest(s);
    assert.equal(timeOf(s, PLAN_ARCHIVE)?.last ?? null, null);
  });

  it('CR-01 collectUnitSignals first add: the archive-class artifact has no first-commit time', () => {
    const s = direct('cr01-sig-first');
    const row = collectUnitSignals({ top: s.repo, kind: 'plan', nativeId: '01-01', home: s.home });
    assert.equal(row.dir_rel, ARCHIVE);
    assert.equal(row.git, 'ok');
    assert.equal(row.artifacts.find((a) => a.role === 'plan').first_commit_ms, null);
  });

  it('CR-01 collectUnitSignals tier: the archive-class artifact has no tier-commit time', () => {
    const s = direct('cr01-sig-tier');
    const row = collectUnitSignals({ top: s.repo, kind: 'plan', nativeId: '01-01', home: s.home });
    const plan = row.artifacts.find((a) => a.role === 'plan');
    assert.equal(plan.tier_letter, 'B', 'the v1.0 archive copy is the one read');
    assert.equal(plan.tier_commit_ms, null);
  });

  // The mirrored case: the v1.0 copy HAS its own live history, v1.1 reuses the name and is archived second. The bound is a
  // strict upper bound on the former path's times, so nothing the v1.0 unit owns is dropped.
  describe('mirrored: v1.0 has its own live history and v1.1 is archived second', () => {
    function mirrored(name) {
      return setup(name, (repo, home) => {
        writePlanningDir(repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'B', body: 'v1.0 plan' }) } });
        commitAt(repo, { home, date: T.plan, message: 'chore: add planning' });
        writeFileAt(repo, `${LIVE}/01-01-PLAN.md`, planText({ tier: 'A', body: 'v1.0 plan, tier set' }));
        commitAt(repo, { home, date: T.edit, message: 'chore: set the tier' });
        archiveDir(repo, { home, name: '01-setup', label: 'v1.0' });
        commitAt(repo, { home, date: T.archive, message: 'chore: archive v1.0' });
        writePlanningDir(repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'C', body: 'v1.1 plan' }) } });
        commitAt(repo, { home, date: T.reuse, message: 'chore: start v1.1' });
        writeFileAt(repo, `${LIVE}/01-01-PLAN.md`, planText({ tier: 'C', body: 'v1.1 plan, edited later' }));
        commitAt(repo, { home, date: T.later, message: 'chore: edit v1.1' });
        archiveDir(repo, { home, name: '01-setup', label: 'v1.1' });
        commitAt(repo, { home, date: T.archive2, message: 'chore: archive v1.1' });
      });
    }

    it('the v1.0 unit keeps its own first add, tier time, lower bound and last change', () => {
      const s = mirrored('mirror');
      ingest(s);
      const u = unitOf(s);
      assert.equal(u.dir, ARCHIVE);
      assert.equal(u.start.utc, utc('plan'));
      assert.equal(u.start.date_source, 'git');
      assert.equal(u.commits_bounded, true);
      assert.equal(u.end.utc, utc('edit'));
      assert.equal(firstOf(s, PLAN_ARCHIVE), ms('plan'));
      assert.deepEqual(timeOf(s, PLAN_ARCHIVE), { tier: ms('plan'), last: ms('edit') }, 'the first commit whose blob carries a tier letter');
    });

    it('collectUnitSignals keeps the v1.0 first add and tier time', () => {
      const s = mirrored('mirror-sig');
      const plan = collectUnitSignals({ top: s.repo, kind: 'plan', nativeId: '01-01', home: s.home }).artifacts.find((a) => a.role === 'plan');
      assert.equal(plan.rel_path, PLAN_ARCHIVE);
      assert.equal(plan.first_commit_ms, ms('plan'));
      assert.equal(plan.tier_commit_ms, ms('plan'));
    });
  });
});

describe('the tier-commit time is read from the blob of the former path', () => {
  it('a column-0 tier: line in a body (02-03 CR-01) does not set the signal time of an archived plan', () => {
    const s = setup('tiercr01', (repo, home) => {
      writePlanningDir(repo, {
        under: 'phases',
        name: '01-setup',
        files: { '01-01-PLAN.md': '---\nphase: 01-setup\n---\n\n```\ntier: C\n```\n' },
      });
      commitAt(repo, { home, date: T.plan, message: 'chore: add planning' });
      writeFileAt(repo, `${LIVE}/01-01-PLAN.md`, '---\nphase: 01-setup\ntier: B\n---\n\n```\ntier: C\n```\n');
      commitAt(repo, { home, date: T.edit, message: 'chore: set the tier' });
      archiveDir(repo, { home, name: '01-setup', label: 'v1.0' });
      commitAt(repo, { home, date: T.archive, message: 'chore: archive v1.0' });
    });
    ingest(s);
    assert.equal(timeOf(s, PLAN_ARCHIVE).tier, ms('edit'));
  });
});

describe('locateUnitDir: live first, archive on request, the default stays live-only', () => {
  const build = (setupFn) => {
    const ctx = makeHome();
    made.push(ctx);
    setupFn(ctx.home);
    return ctx.home;
  };
  const plan = (home, under, name, id = '01-01') => writePlanningDir(home, { under, name, files: { [`${id}-PLAN.md`]: planText({ tier: 'A' }) } });

  it('finds an archive dir only with includeArchive, and the live dir wins over an archive copy', () => {
    const top = build((h) => { plan(h, 'milestones/v1.0-phases', '01-setup'); });
    assert.equal(locateUnitDir({ top, kind: 'plan', nativeId: '01-01' }), null);
    assert.equal(locateUnitDir({ top, kind: 'plan', nativeId: '01-01', includeArchive: true }), ARCHIVE);
    plan(top, 'phases', '01-setup');
    assert.equal(locateUnitDir({ top, kind: 'plan', nativeId: '01-01', includeArchive: true }), LIVE);
    assert.equal(locateUnitDir({ top, kind: 'plan', nativeId: '01-01' }), LIVE);
  });

  it('walks archive roots in natural label order, oldest first', () => {
    const top = build((h) => {
      plan(h, 'milestones/v1.10-phases', '01-setup');
      plan(h, 'milestones/v1.2-phases', '01-setup');
    });
    assert.equal(locateUnitDir({ top, kind: 'plan', nativeId: '01-01', includeArchive: true }), '.planning/milestones/v1.2-phases/01-setup');
  });

  it('accepts a project_code prefixed dir through dirAcceptsPlan, and a quick dir in a -quick root', () => {
    const top = build((h) => {
      plan(h, 'milestones/v1.0-phases', 'GSD-01-setup');
      writePlanningDir(h, { under: 'milestones/v1.0-quick', name: '260101-abc-task', files: { '260101-abc-PLAN.md': planText({ tier: 'C' }) } });
    });
    assert.equal(locateUnitDir({ top, kind: 'plan', nativeId: '01-01', includeArchive: true }), '.planning/milestones/v1.0-phases/GSD-01-setup');
    assert.equal(locateUnitDir({ top, kind: 'quick', nativeId: '260101-abc', includeArchive: true }), '.planning/milestones/v1.0-quick/260101-abc-task');
    assert.equal(locateUnitDir({ top, kind: 'quick', nativeId: '260101-abc' }), null);
  });

  it('ignores a sibling that is not an archive root', () => {
    const top = build((h) => { plan(h, 'milestones-v1-03-alpha', '01-setup'); plan(h, 'milestones/notes', '01-setup'); });
    assert.equal(locateUnitDir({ top, kind: 'plan', nativeId: '01-01', includeArchive: true }), null);
  });
});

describe('PLANNING_PATHSPECS is one frozen list shared by facts and signals (D-07)', () => {
  it('holds the quick, phases and milestones roots, frozen', () => {
    assert.deepEqual([...layout.PLANNING_PATHSPECS], ['.planning/quick', '.planning/phases', '.planning/milestones']);
    assert.ok(Object.isFrozen(layout.PLANNING_PATHSPECS));
  });

  it('the first-add, tier-line and last-change logs all pass it as their pathspec', async () => {
    const seen = [];
    const run = (args) => { seen.push(args); return { status: 0, stdout: '', errorCode: null }; };
    const { artifactLastChange } = await import('../../src/adapters/gsd-core/facts.mjs');
    artifactCommitIndex({ top: '/nowhere', run });
    artifactLastChange({ top: '/nowhere', run });
    assert.equal(seen.length, 3);
    for (const args of seen) {
      assert.deepEqual(args.slice(args.indexOf('--') + 1), [...layout.PLANNING_PATHSPECS]);
    }
  });
});

// R1 W3 (orchestrator decision 2b): the facts cursor is the sha256 of the repo's refs, so a unit scanned by earlier code (an
// archived unit with null git times and no bound) would keep its stale facts while the refs do not move. For a repo that
// holds archive-class artifacts the digest is salted with a rules tag, so the first ingest after the rules changed rescans
// it once; a live-only repo's cursor is untouched. "Earlier code" is simulated by writing the unsalted digest back.
describe('the facts cursor is salted for repos with archive-class artifacts', () => {
  const HEX64 = /^[0-9a-f]{64}$/;
  const plainDigest = (s) => createHash('sha256').update(git(s.repo, ['show-ref', '--head'], { home: s.home })).digest('hex');
  const scanSha = (s) => storeRows(s, 'SELECT refs_sha FROM unit_git_scan WHERE unit_key = ?', [s.key])[0].refs_sha;
  const factsUnits = (lines) => Number(/facts_units=(\d+)/.exec(lines.find((l) => l.includes('facts_units=')))[1]);
  const writeStore = (s, sql) => {
    const db = openStore({ home: s.home });
    try { db.exec(sql); } finally { db.close(); }
  };
  const liveUnit = (name) => setup(name, (repo, home) => {
    writePlanningDir(repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'A' }) } });
    commitAt(repo, { home, date: T.plan, message: 'chore: add planning' });
    writeFileAt(repo, 'src/code.mjs', 'export const code = 1;\n');
    commitAt(repo, { home, date: T.code, message: 'feat(01-01): the code' });
  });

  it('stale facts cursor is rescanned once: a unit carrying the unsalted digest gets its former-path times, then nothing rescans', () => {
    const s = archivedUnit('stale');
    assert.equal(factsUnits(ingest(s)), 1);
    const salted = scanSha(s);
    assert.match(salted, HEX64);
    assert.notEqual(salted, plainDigest(s), 'an archive-tagged repo is salted');
    // The state earlier code left behind: the unsalted digest and no former-path times.
    writeStore(s, `UPDATE unit_git_scan SET refs_sha = '${plainDigest(s)}'; UPDATE unit_artifact SET first_commit_ms = NULL; DELETE FROM unit_artifact_time;`);
    assert.equal(firstOf(s, PLAN_ARCHIVE), null);
    assert.equal(factsUnits(ingest(s)), 1, 'the refs did not move, the salted digest differs: rescanned');
    assert.equal(firstOf(s, PLAN_ARCHIVE), ms('plan'));
    assert.equal(timeOf(s, PLAN_ARCHIVE).tier, ms('plan'));
    assert.equal(scanSha(s), salted);
    assert.equal(factsUnits(ingest(s)), 0, 'a second ingest rescans nothing');
    assert.equal(scanSha(s), salted);
  });

  it('a live-only repo is not salted and is not rescanned', () => {
    const s = liveUnit('liveonly');
    assert.equal(factsUnits(ingest(s)), 1);
    assert.equal(scanSha(s), plainDigest(s), 'no archive-class artifact, no salt');
    assert.equal(factsUnits(ingest(s)), 0);
    assert.equal(scanSha(s), plainDigest(s));
  });

  it('a repo that gains its first archive row (a moved unit: live dir_rel, archive-path artifact rows) is rescanned once more', () => {
    const s = liveUnit('gains');
    assert.equal(factsUnits(ingest(s)), 1);
    assert.equal(scanSha(s), plainDigest(s));
    archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.0' }); // a staged move, no commit: the refs do not move
    assert.equal(factsUnits(ingest(s)), 1, 'archive-path artifact rows appeared: salted, rescanned');
    assert.equal(storeRows(s, 'SELECT dir_rel FROM unit_obs WHERE unit_key = ?', [s.key])[0].dir_rel, LIVE, 'the stored dir stays live');
    assert.notEqual(scanSha(s), plainDigest(s));
    assert.equal(firstOf(s, PLAN_ARCHIVE), ms('plan'), 'the archive-path row has its former-path time');
    assert.equal(factsUnits(ingest(s)), 0);
  });
});
