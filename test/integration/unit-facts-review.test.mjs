// Regression tests of the plan 02-05 review findings (02-05-REVIEW.md), written before each fix (RED). Every repo is
// a temporary git repository inside a temporary HOME from makeHome(), reached through RIGORSCOPE_REPO_ROOTS; the CLI
// is spawned, and store.db and derived.db are read with queryDb only; the CR-02 move row also calls facts.mjs's
// artifactLastChange directly, and the WR-04 cap row calls the adapter's collectUnits with an injected git runner.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cliEnv, makeHome, queryDb, runCli,
} from '../fixtures/build.mjs';
import {
  addWorktree, commitAt, git, makeRepo, writeFileAt, writeQuickDir,
} from '../fixtures/git-repo.mjs';
import { openStore, storePath } from '../../src/db.mjs';
import { MAX_TREES_PER_REPO, artifactLastChange } from '../../src/adapters/gsd-core/facts.mjs';
import { collectUnits } from '../../src/adapters/gsd-core/index.mjs';

const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const tokens = (line) => line.trim().split(/\s+/);

// A home with one repo at <home>/src/<name> (`.planning/` tracked unless untracked is set), built by build(repo,
// home), reached through the roots variable.
function setup(name, build, { untracked = false } = {}) {
  const ctx = makeHome();
  const repo = join(ctx.home, 'src', name);
  makeRepo(repo, { home: ctx.home, files: { 'README.md': `${name}\n` }, untrackedPlanning: untracked });
  const extra = build(repo, ctx.home) ?? {};
  const env = cliEnv(ctx.home, { TZ: 'UTC', RIGORSCOPE_REPO_ROOTS: repo });
  const key = (kind, id) => `gsd-core:~/src/${name}/.git:${kind}:${id}`;
  return {
    ctx, repo, env, key, ...extra,
  };
}
const ingest = (s) => {
  const r = runCli(['ingest'], { home: s.ctx.home, env: s.env });
  assert.equal(r.status, 0, r.stderr);
  const lines = linesOf(r.stdout);
  return lines[lines.length - 2];
};
const unitsDoc = (s) => {
  const r = runCli(['units', '--json'], { home: s.ctx.home, env: s.env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const unitsText = (s) => {
  const r = runCli(['units'], { home: s.ctx.home, env: s.env });
  assert.equal(r.status, 0, r.stderr);
  return linesOf(r.stdout);
};
const q = (s, sql) => queryDb(storePath(s.ctx.home), sql);
const fieldOf = (line, name) => {
  const t = tokens(line).find((x) => x.startsWith(`${name}=`));
  return t === undefined ? undefined : t.slice(name.length + 1);
};

// Review CR-01 (RR-04): a commit total is known only when every file of the commit has a numstat count and no path of
// the commit was dropped; derive's unit size is unknown when any counted commit lost a path.
describe('review CR-01: commit line totals never drop an unknown count or a dropped path', () => {
  const ID = '261030-c1r';
  let s;
  const sha = {};
  before(() => {
    s = setup('cr01', (repo, home) => {
      writeQuickDir(repo, { id: ID, slug: 'counts', plan: { tier: 'B', body: 'Plan.' } });
      commitAt(repo, { home, date: '2026-10-30T09:00:00Z', message: `docs(${ID}): plan` });
      writeFileAt(repo, 'src/a.mjs', 'export const a = 1;\nexport const b = 2;\n');
      sha.text = commitAt(repo, { home, date: '2026-10-30T10:00:00Z', message: `feat(${ID}): text` });
      writeFileAt(repo, 'src/c.mjs', 'export const c = 3;\n');
      writeFileSync(join(repo, 'src', 'logo.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
      sha.binary = commitAt(repo, { home, date: '2026-10-30T11:00:00Z', message: `feat(${ID}): binary` });
      writeFileAt(repo, 'src/d.mjs', 'export const d = 4;\n');
      writeFileAt(repo, 'docs/my notes.txt', 'a note\n');
      sha.dropped = commitAt(repo, { home, date: '2026-10-30T12:00:00Z', message: `feat(${ID}): dropped path` });
    });
    s.line = ingest(s);
  });
  after(() => s.ctx.cleanup());

  const commitRow = (which) => q(s, `SELECT files, added, deleted FROM unit_commit WHERE sha = '${sha[which]}'`)[0];
  const fileRows = (which) => q(s, `SELECT count(*) AS n FROM unit_commit_file WHERE sha = '${sha[which]}'`)[0].n;

  it('a commit whose files all have counts keeps its summed totals', () => {
    assert.deepEqual(commitRow('text'), { files: 1, added: 2, deleted: 0 });
  });

  it('a commit with a binary file (no numstat count) has NULL totals, not the sum of the other files', () => {
    assert.deepEqual(commitRow('binary'), { files: 2, added: null, deleted: null });
  });

  it('a commit that lost a path has NULL totals and files counts every path git reported', () => {
    assert.deepEqual(commitRow('dropped'), { files: 2, added: null, deleted: null });
    assert.equal(fileRows('dropped'), 1);
  });

  it('the ingest units: line counts the dropped path', () => {
    assert.equal(fieldOf(s.line, 'facts_dropped'), '1', s.line);
  });

  it('the unit size keeps its commit count but its files and lines are unknown (? in text)', () => {
    const u = unitsDoc(s).units.find((x) => x.key === s.key('quick', ID));
    assert.ok(u);
    assert.deepEqual(u.confounders.unit_size.value, {
      commits: 4, files: null, added: null, deleted: null,
    });
    const row = unitsText(s).find((l) => tokens(l)[2] === ID);
    assert.ok(row, 'the unit row');
    assert.deepEqual(tokens(row).slice(-2), ['?', '?'], row);
  });
});

// Review CR-02: an archive commit (a `git mv` of a phase dir out of `.planning/phases/`) deletes every old path, and a
// move inside the planning dirs re-adds the file under its new path; neither changes the artifact, so neither is its
// last change or the unit's git end.
describe('review CR-02: a deletion or a move is never an artifact\'s last change', () => {
  const PHASE = '.planning/phases/03-alpha';
  const PLAN_REL = `${PHASE}/03-01-PLAN.md`;
  const T = {
    plan: '2026-01-01T10:00:00Z', code: '2026-01-02T10:00:00Z', move: '2026-03-01T10:00:00Z', archive: '2026-09-01T10:00:00Z',
  };
  const ms = (k) => Date.parse(T[k]);
  let s;
  const seen = {};
  before(() => {
    s = setup('cr02', (repo, home) => {
      writeFileAt(repo, PLAN_REL, '---\ntier: B\n---\n\nPlan.\n');
      writeFileAt(repo, '.planning/phases/09-misc/notes-a.md', 'notes\n');
      commitAt(repo, { home, date: T.plan, message: 'docs(03-01): plan' });
      writeFileAt(repo, 'src/zap.mjs', 'export const zap = 1;\n');
      commitAt(repo, { home, date: T.code, message: 'feat(03-01): zap' });
    });
    ingest(s);
    seen.before = unitsDoc(s).units.find((u) => u.key === s.key('plan', '03-01'));
    const { home } = s.ctx;
    git(s.repo, ['mv', '.planning/phases/09-misc/notes-a.md', '.planning/phases/09-misc/notes-b.md'], { home });
    commitAt(s.repo, { home, date: T.move, message: 'chore: rename notes' });
    git(s.repo, ['mv', PHASE, '.planning/milestones-v1-03-alpha'], { home });
    commitAt(s.repo, { home, date: T.archive, message: 'chore: archive v1 milestone' });
    seen.line = ingest(s);
    seen.after = unitsDoc(s).units.find((u) => u.key === s.key('plan', '03-01'));
    seen.last = artifactLastChange({ top: join(s.repo, '.git') });
  });
  after(() => s.ctx.cleanup());

  it('before the archive the git end is the code commit', () => {
    assert.equal(seen.before?.end.utc, T.code.replace('Z', '.000Z'));
    assert.equal(seen.before?.end.date_source, 'git');
  });

  it('after the archive commit the unit was rescanned and its git end is still the code commit', () => {
    assert.equal(fieldOf(seen.line, 'facts_units'), '1', seen.line);
    assert.equal(seen.after?.end.utc, T.code.replace('Z', '.000Z'));
    assert.equal(seen.after?.end.date_source, 'git');
  });

  it('the PLAN\'s stored last change is its own commit, not the archive', () => {
    const row = q(s, `SELECT last_commit_ms FROM unit_artifact_time WHERE rel_path = '${PLAN_REL}'`);
    assert.deepEqual(row, [{ last_commit_ms: ms('plan') }]);
  });

  it('artifactLastChange gives a deleted path its last real change and a moved-to path no move time', () => {
    assert.ok(seen.last instanceof Map);
    assert.equal(seen.last.get(PLAN_REL), ms('plan'));
    assert.equal(seen.last.get('.planning/phases/09-misc/notes-a.md'), ms('plan'));
    assert.equal(seen.last.get('.planning/phases/09-misc/notes-b.md'), undefined);
  });
});

// Review WR-02 (self-healing commit facts): unit_commit rows are never deleted, so a rewritten commit (an amend, a
// rebase) leaves its old sha stored next to the new one. Derive counts only the rows the unit's last successful git
// scan saw (unit_commit.last_seen_run equal to unit_git_scan.scanned_run).
describe('review WR-02: a rewritten commit is counted once', () => {
  const ID = '261030-w2r';
  let s;
  const seen = {};
  before(() => {
    s = setup('wr02', (repo, home) => {
      writeQuickDir(repo, { id: ID, slug: 'rewrite', plan: { tier: 'B', body: 'Plan.' } });
      writeFileAt(repo, 'src/w.mjs', 'export const w = 1;\n');
      seen.first = commitAt(repo, { home, date: '2026-10-30T10:00:00Z', message: `feat(${ID}): w` });
    });
    ingest(s);
    seen.before = unitsDoc(s).units.find((u) => u.key === s.key('quick', ID));
    const { home } = s.ctx;
    writeFileAt(s.repo, 'src/w.mjs', 'export const w = 1;\nexport const v = 2;\n');
    git(s.repo, ['add', '-A'], { home });
    git(s.repo, ['commit', '--amend', '--quiet', '--no-edit'], { home });
    seen.second = git(s.repo, ['rev-parse', 'HEAD'], { home }).trim();
    seen.line = ingest(s);
    seen.after = unitsDoc(s).units.find((u) => u.key === s.key('quick', ID));
    seen.line3 = ingest(s);
    seen.again = unitsDoc(s).units.find((u) => u.key === s.key('quick', ID));
  });
  after(() => s.ctx.cleanup());

  it('the amend made a second sha and both rows stay stored (rows are never deleted)', () => {
    assert.notEqual(seen.first, seen.second);
    const rows = q(s, `SELECT sha FROM unit_commit WHERE unit_key = '${s.key('quick', ID)}' ORDER BY sha`).map((r) => r.sha);
    assert.deepEqual(rows, [seen.first, seen.second].sort());
  });

  it('before the rewrite the unit has one commit', () => {
    assert.deepEqual(seen.before?.confounders.unit_size.value, {
      commits: 1, files: 1, added: 1, deleted: 0,
    });
  });

  it('after the rewrite the unit still has one commit, and its size is the new commit\'s', () => {
    assert.equal(fieldOf(seen.line, 'facts_units'), '1', seen.line);
    assert.deepEqual(seen.after?.confounders.unit_size.value, {
      commits: 1, files: 1, added: 2, deleted: 0,
    });
  });

  it('only the new sha carries the last scan run, and an ingest on unchanged refs keeps the count', () => {
    const rows = q(s, `SELECT c.sha, c.last_seen_run = g.scanned_run AS live FROM unit_commit c
                        JOIN unit_git_scan g ON g.unit_key = c.unit_key WHERE c.unit_key = '${s.key('quick', ID)}' ORDER BY c.sha`);
    assert.deepEqual(rows.filter((r) => r.live === 1).map((r) => r.sha), [seen.second]);
    assert.equal(fieldOf(seen.line3, 'facts'), 'not_needed', seen.line3);
    assert.deepEqual(seen.again?.confounders.unit_size.value, seen.after?.confounders.unit_size.value);
  });
});

// Re-review WR-07 (02-05-REREVIEW.md): no test had a commit survive two complete scans, so "an unchanged commit keeps
// counting after a ref change" was unpinned. A new branch ref makes the repo's refs digest differ, the unit is scanned
// again (scanned_run advances) and the unchanged commit must keep last_seen_run equal to the new scanned_run, else the
// derive filter (unit_commit.last_seen_run = unit_git_scan.scanned_run) drops it. Named mutant: facts.mjs COMMIT_SQL
// `last_seen_run = unit_commit.last_seen_run` (no update) makes the unit lose the commit, and this test fails.
describe('re-review WR-07: an unchanged commit keeps counting across a second complete scan', () => {
  const ID = '261030-w7r';
  let s;
  const seen = {};
  const scanRun = () => q(s, `SELECT scanned_run AS run FROM unit_git_scan WHERE unit_key = '${s.key('quick', ID)}'`)[0].run;
  const commitRows = () => q(s, `SELECT sha, last_seen_run AS seen FROM unit_commit WHERE unit_key = '${s.key('quick', ID)}' ORDER BY sha`);
  before(() => {
    s = setup('wr07', (repo, home) => {
      writeQuickDir(repo, { id: ID, slug: 'survive', plan: { tier: 'B', body: 'Plan.' } });
      writeFileAt(repo, 'src/w7.mjs', 'export const w7 = 1;\n');
      seen.a = commitAt(repo, { home, date: '2026-10-30T10:00:00Z', message: `feat(${ID}): w7` });
    });
    seen.line1 = ingest(s);
    seen.run1 = scanRun();
    seen.rows1 = commitRows();
    seen.unit1 = unitsDoc(s).units.find((u) => u.key === s.key('quick', ID));
    git(s.repo, ['branch', 'topic-w7'], { home: s.ctx.home });
    seen.line2 = ingest(s);
    seen.run2 = scanRun();
    seen.rows2 = commitRows();
    seen.unit2 = unitsDoc(s).units.find((u) => u.key === s.key('quick', ID));
  });
  after(() => s.ctx.cleanup());

  it('the first scan counted commit A once', () => {
    assert.equal(fieldOf(seen.line1, 'facts_units'), '1', seen.line1);
    assert.deepEqual(seen.rows1, [{ sha: seen.a, seen: seen.run1 }]);
    assert.deepEqual(seen.unit1?.confounders.unit_size.value, {
      commits: 1, files: 1, added: 1, deleted: 0,
    });
  });

  it('the second scan happened: facts_units is 1 and the unit scanned_run advanced', () => {
    assert.equal(fieldOf(seen.line2, 'facts_units'), '1', seen.line2);
    assert.ok(seen.run2 > seen.run1, `scanned_run ${seen.run1} -> ${seen.run2}`);
  });

  it('commit A is seen by the second scan: its last_seen_run is the new scanned_run', () => {
    assert.deepEqual(seen.rows2, [{ sha: seen.a, seen: seen.run2 }]);
  });

  it('commit A is still counted by derive and the unit size is unchanged', () => {
    assert.deepEqual(seen.unit2?.confounders.unit_size.value, seen.unit1?.confounders.unit_size.value);
  });
});

// Review WR-05: unit_artifact.mtime_ms keeps the latest mtime ever seen, so a start read from it drifts later on every
// edit. The start fallback uses the earliest mtime ever seen (unit_artifact.first_mtime_ms, merged by the NULL-safe
// minimum); the end fallback keeps the latest.
describe('review WR-05: an mtime start is the earliest mtime ever seen', () => {
  const PLAN_REL = '.planning/phases/04-delta/04-01-PLAN.md';
  const M = { first: '2026-08-06T09:00:00.000Z', edit: '2026-09-10T09:00:00.000Z' };
  let s;
  const seen = {};
  before(() => {
    s = setup('wr05', (repo) => {
      writeFileAt(repo, PLAN_REL, '---\ntier: B\n---\n\nPlan.\n', { mtimeMs: Date.parse(M.first) });
    }, { untracked: true });
    ingest(s);
    seen.before = unitsDoc(s).units.find((u) => u.key === s.key('plan', '04-01'));
    writeFileAt(s.repo, PLAN_REL, '---\ntier: B\n---\n\nPlan, checked.\n', { mtimeMs: Date.parse(M.edit) });
    ingest(s);
    seen.after = unitsDoc(s).units.find((u) => u.key === s.key('plan', '04-01'));
  });
  after(() => s.ctx.cleanup());

  it('the first ingest dates the untracked plan by its mtime', () => {
    assert.deepEqual([seen.before?.start.utc, seen.before?.start.date_source], [M.first, 'mtime']);
    assert.deepEqual([seen.before?.end.utc, seen.before?.end.date_source], [M.first, 'mtime']);
  });

  it('after an edit the start stays at the first mtime and the end moves to the edit', () => {
    assert.deepEqual([seen.after?.start.utc, seen.after?.start.date_source], [M.first, 'mtime']);
    assert.deepEqual([seen.after?.end.utc, seen.after?.end.date_source], [M.edit, 'mtime']);
  });
});

// Review WR-01: plan ids such as 01-01 repeat across milestones, so `feat(01-01):` commits of an earlier milestone
// match a later plan. With `.planning/` tracked, a plan unit's commits are bounded below by its PLAN file's first-add
// commit time (02-03's artifact index); with `.planning/` untracked there is no bound, and such units are counted.
describe('review WR-01: a tracked plan unit keeps no commit authored before its PLAN was first added', () => {
  const PLAN_REL = '.planning/phases/01-pilot/01-01-PLAN.md';
  const T = { old: '2025-12-16T10:00:00Z', plan: '2026-08-06T10:00:00Z', code: '2026-08-07T10:00:00Z' };
  let s;
  const seen = {};
  before(() => {
    s = setup('wr01', (repo, home) => {
      writeFileAt(repo, 'src/old.mjs', 'export const old = 1;\n');
      seen.old = commitAt(repo, { home, date: T.old, message: 'feat(01-01): earlier milestone work' });
      writeFileAt(repo, PLAN_REL, '---\ntier: B\n---\n\nPlan.\n');
      seen.plan = commitAt(repo, { home, date: T.plan, message: 'docs(01-01): plan' });
      writeFileAt(repo, 'src/new.mjs', 'export const n = 1;\n');
      seen.code = commitAt(repo, { home, date: T.code, message: 'feat(01-01): new work' });
    });
    ingest(s);
    seen.doc = unitsDoc(s);
    seen.unit = seen.doc.units.find((u) => u.key === s.key('plan', '01-01'));
  });
  after(() => s.ctx.cleanup());

  it('the commit authored before the PLAN\'s first add is not stored for the unit', () => {
    const rows = q(s, `SELECT sha FROM unit_commit WHERE unit_key = '${s.key('plan', '01-01')}' ORDER BY author_ms`).map((r) => r.sha);
    assert.deepEqual(rows, [seen.plan, seen.code]);
  });

  it('the unit starts at its PLAN commit, its size counts its own commits, and it is bounded', () => {
    assert.deepEqual([seen.unit?.start.utc, seen.unit?.start.date_source], [T.plan.replace('Z', '.000Z'), 'git']);
    assert.deepEqual(seen.unit?.confounders.unit_size.value, {
      commits: 2, files: 1, added: 1, deleted: 0,
    });
    assert.equal(seen.unit?.commits_bounded, true);
    assert.equal(seen.doc.strata[1].counts.plan_unbounded, 0);
  });
});

describe('review WR-01: an untracked plan unit has no bound and is counted', () => {
  const PLAN_REL = '.planning/phases/01-pilot/01-01-PLAN.md';
  let s;
  const seen = {};
  before(() => {
    s = setup('wr01u', (repo, home) => {
      writeFileAt(repo, 'src/old.mjs', 'export const old = 1;\n');
      commitAt(repo, { home, date: '2025-12-16T10:00:00Z', message: 'feat(01-01): earlier milestone work' });
      writeFileAt(repo, PLAN_REL, '---\ntier: B\n---\n\nPlan.\n', { mtimeMs: Date.parse('2026-08-06T10:00:00Z') });
    }, { untracked: true });
    ingest(s);
    seen.doc = unitsDoc(s);
    seen.unit = seen.doc.units.find((u) => u.key === s.key('plan', '01-01'));
    seen.text = unitsText(s);
  });
  after(() => s.ctx.cleanup());

  it('the commit is kept (no bound), the unit is flagged unbounded and counted in json and text', () => {
    assert.equal(seen.unit?.confounders.unit_size.value?.commits, 1);
    assert.equal(seen.unit?.commits_bounded, false);
    assert.equal(seen.doc.strata[1].counts.plan_unbounded, 1);
    const line = seen.text.filter((l) => l.startsWith('units: n=')).pop();
    assert.equal(fieldOf(line, 'plan_unbounded'), '1', line);
  });
});

// Review WR-03 (RR-05): an end before the start is raised to the start; the raised end carries its own source label
// `clamped`, never the source of the value it replaced, and `units` prints the number of clamped ends.
describe('review WR-03: a clamped end is labeled clamped and counted', () => {
  const ID = '261030-w3c';
  let s;
  const seen = {};
  before(() => {
    s = setup('wr03', (repo, home) => {
      writeQuickDir(repo, { id: ID, slug: 'clamp', plan: { tier: 'B', body: 'Plan.' } });
      // Authored the evening before the quick id's day (UTC): its git end lies before the quick-id start.
      commitAt(repo, { home, date: '2026-10-29T22:00:00Z', message: `docs(${ID}): plan` });
    });
    ingest(s);
    seen.doc = unitsDoc(s);
    seen.unit = seen.doc.units.find((u) => u.key === s.key('quick', ID));
    seen.text = unitsText(s);
  });
  after(() => s.ctx.cleanup());

  it('the end equals the start and is labeled clamped with the start\'s precision', () => {
    assert.deepEqual(seen.unit?.start, {
      utc: '2026-10-30T00:00:00.000Z', date_source: 'quick-id', precision: 'day', label: 'reconstructed',
    });
    assert.deepEqual(seen.unit?.end, {
      utc: '2026-10-30T00:00:00.000Z', date_source: 'clamped', precision: 'day', label: 'reconstructed',
    });
  });

  it('units --json and the text count line print end_clamped, and the dates column shows clamped', () => {
    assert.equal(seen.doc.strata[1].counts.end_clamped, 1);
    const line = seen.text.filter((l) => l.startsWith('units: n=')).pop();
    assert.equal(fieldOf(line, 'end_clamped'), '1', line);
    const row = seen.text.find((l) => tokens(l)[2] === ID);
    assert.ok(row && tokens(row).includes('quick-id/clamped'), row);
  });
});

// Review WR-04 (RR-04): a working tree that is not scanned (past MAX_TREES_PER_REPO, prunable, bare or missing) is
// counted and printed as trees_dropped, so a unit that exists only there is not silently absent.
describe('review WR-04: dropped working trees are counted and printed', () => {
  it('a removed linked worktree (prunable) is counted in trees_dropped on the ingest units: line', () => {
    const s = setup('wr04', (repo, home) => {
      const wt = join(home, 'wt', 'wr04-gone');
      addWorktree(repo, wt, 'gone', { home });
      rmSync(wt, { recursive: true, force: true });
    });
    try {
      const line = ingest(s);
      assert.equal(fieldOf(line, 'trees'), '1', line);
      assert.equal(fieldOf(line, 'trees_dropped'), '1', line);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('trees past MAX_TREES_PER_REPO are counted in collectUnits\' treesDropped', async () => {
    const ctx = makeHome();
    try {
      const common = join(ctx.home, 'src', 'many', '.git');
      mkdirSync(common, { recursive: true });
      const trees = Array.from({ length: MAX_TREES_PER_REPO + 2 }, (_, i) => join(ctx.home, 'trees', `t${String(i).padStart(3, '0')}`));
      for (const t of trees) mkdirSync(t, { recursive: true });
      const porcelain = trees.map((t) => `worktree ${t}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/b\n`).join('\n');
      const run = (args) => (args.includes('worktree')
        ? { status: 0, stdout: porcelain, errorCode: null }
        : { status: 128, stdout: '', errorCode: null });
      const db = openStore({ home: ctx.home });
      try {
        db.exec("INSERT INTO ingest_run (run_id, started_utc, trigger, status) VALUES (1, '2026-01-01T00:00:00.000Z', 'test', 'running')");
        db.prepare('INSERT INTO repo (repo_key, repo_name, first_seen_run, last_seen_run) VALUES (?, ?, 1, 1)').run('~/src/many/.git', 'many');
        const res = await collectUnits({ db, home: ctx.home, runId: 1, run });
        assert.equal(res.trees, MAX_TREES_PER_REPO);
        assert.equal(res.treesDropped, 2);
      } finally {
        db.close();
      }
    } finally {
      ctx.cleanup();
    }
  });
});
