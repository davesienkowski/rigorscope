// Plan 02-02 (UNIT-02, D-08, amendment Q2): the repo resolver in process, on fixture repositories only. Written before
// the code (RED). Every repository is created by test/fixtures/git-repo.mjs inside a temporary HOME from makeHome();
// the resolver is never pointed at a developer's own repository. git is reached through an injected runner (the `run`
// seam) that records each call, so a test can prove a dir form makes no git call at all, and can simulate a missing
// git, a timeout or an old git version without touching PATH.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openStore } from '../../src/db.mjs';
import {
  GIT_MIN_VERSION, REPO_METHODS, gitProbe, repoKeyOf, repoNameOf, resolveDir, resolveRepos,
} from '../../src/units/repo-resolve.mjs';
import {
  FRONTMATTER_MAX_BYTES, frontmatterLines, readHead, tierLetter,
} from '../../src/adapters/gsd-core/frontmatter.mjs';
import { PLANTS, makeHome, queryDb } from '../fixtures/build.mjs';
import {
  addWorktree, assertOutsideWorkTree, git, makeRepo,
} from '../fixtures/git-repo.mjs';

// A git runner with the contract of the seam: never throws, returns { status, stdout, errorCode }.
function realRun(args, { env } = {}) {
  try {
    return { status: 0, stdout: execFileSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }), errorCode: null };
  } catch (err) {
    if (typeof err.status === 'number') return { status: err.status, stdout: '', errorCode: null };
    return { status: null, stdout: '', errorCode: err.code ?? 'EUNKNOWN' };
  }
}
function recorder(inner = realRun) {
  const calls = [];
  const run = (args, opts = {}) => {
    calls.push({ args: [...args], env: { ...(opts.env ?? {}) } });
    return inner(args, opts);
  };
  return { run, calls, gitCalls: () => calls.filter((c) => c.args[0] !== '--version') };
}

describe('resolveDir on fixture repositories', () => {
  let ctx;
  let alpha;
  let beta;
  before(() => {
    ctx = makeHome();
    alpha = makeRepo(join(ctx.home, 'repos', 'alpha'), { home: ctx.home, files: { 'src/a.txt': 'a\n' } });
    beta = makeRepo(join(ctx.home, 'work', 'beta'), { home: ctx.home, files: { 'README.md': 'b\n' } });
    addWorktree(alpha, join(ctx.home, 'wt', 'alpha-fix'), 'fix', { home: ctx.home });
    mkdirSync(join(ctx.home, 'plain', 'dir'), { recursive: true });
  });
  after(() => ctx.cleanup());

  it('exports the method names and the git floor', () => {
    assert.deepEqual([...REPO_METHODS], ['git', 'ancestor', 'none']);
    assert.deepEqual([...GIT_MIN_VERSION], [2, 31]);
  });

  it('gives method git and one repo_key for a main checkout, its subdirectory and a linked worktree', () => {
    const { run } = recorder();
    const res = ['~/repos/alpha', '~/repos/alpha/src', '~/wt/alpha-fix'].map((d) => resolveDir(d, { home: ctx.home, run }));
    assert.deepEqual(res, [
      { repoKey: '~/repos/alpha/.git', repoName: 'alpha', method: 'git', isWorktree: 0 },
      { repoKey: '~/repos/alpha/.git', repoName: 'alpha', method: 'git', isWorktree: 0 },
      { repoKey: '~/repos/alpha/.git', repoName: 'alpha', method: 'git', isWorktree: 1 },
    ]);
  });

  it('gives method ancestor for a deleted subdirectory whose nearest existing ancestor is in the repo', () => {
    const { run } = recorder();
    assert.deepEqual(resolveDir('~/repos/alpha/deleted/sub', { home: ctx.home, run }),
      { repoKey: '~/repos/alpha/.git', repoName: 'alpha', method: 'ancestor', isWorktree: 0 });
  });

  it('gives method none with no git call for a gone dir whose nearest existing ancestor is HOME', () => {
    const rec = recorder();
    assert.deepEqual(resolveDir('~/gone/place', { home: ctx.home, run: rec.run }),
      { repoKey: null, repoName: null, method: 'none', isWorktree: null });
    assert.equal(rec.calls.length, 0);
  });

  it('gives method none with no git call for ~win, ~other and relative stored dirs', () => {
    for (const d of ['~win/x', '~other/x', 'relative/x', '~/../x', '']) {
      const rec = recorder();
      assert.equal(resolveDir(d, { home: ctx.home, run: rec.run }).method, 'none', JSON.stringify(d));
      assert.equal(rec.calls.length, 0, `no git call for ${JSON.stringify(d)}`);
    }
  });

  it('gives method none for an existing directory that is not inside a repository', () => {
    const rec = recorder();
    assert.deepEqual(resolveDir('~/plain/dir', { home: ctx.home, run: rec.run }),
      { repoKey: null, repoName: null, method: 'none', isWorktree: null });
    assert.equal(rec.gitCalls().length, 1);
  });

  it('runs git with an args array, fsmonitor off, optional locks off, a ceiling at the parent of HOME and no repository-location variables', () => {
    const rec = recorder();
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(beta, '.git');
    process.env.GIT_WORK_TREE = beta;
    try {
      assert.equal(resolveDir('~/repos/alpha', { home: ctx.home, run: rec.run }).repoKey, '~/repos/alpha/.git');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
    const [call] = rec.gitCalls();
    assert.deepEqual(call.args.slice(0, 1), ['-C']);
    assert.deepEqual(call.args.slice(2), ['-c', 'core.fsmonitor=false', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
    assert.equal(call.env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(call.env.GIT_CEILING_DIRECTORIES, dirname(realpathSync(ctx.home)));
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE']) {
      assert.ok(!Object.hasOwn(call.env, k), `${k} removed`);
    }
  });

  it('still yields ~/... keys when HOME is reached through a symlink', () => {
    const outer = mkdtempSync(join(tmpdir(), 'rigorscope-link-'));
    try {
      const link = join(outer, 'home link #1');
      symlinkSync(ctx.home, link);
      const { run } = recorder();
      assert.equal(resolveDir('~/wt/alpha-fix', { home: link, run }).repoKey, '~/repos/alpha/.git');
      assert.equal(repoKeyOf(join(realpathSync(ctx.home), 'repos', 'alpha', '.git'), link), '~/repos/alpha/.git');
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('defers (no answer) on a spawn error or a timeout', () => {
    const enoent = () => ({ status: null, stdout: '', errorCode: 'ENOENT' });
    const timeout = () => ({ status: null, stdout: '', errorCode: 'ETIMEDOUT' });
    assert.deepEqual(resolveDir('~/repos/alpha', { home: ctx.home, run: enoent }), { deferred: true });
    assert.deepEqual(resolveDir('~/repos/alpha', { home: ctx.home, run: timeout }), { deferred: true });
  });

  it('treats output that is not exactly two non-empty lines as not a repository', () => {
    const odd = () => ({ status: 0, stdout: 'one line only\n', errorCode: null });
    assert.equal(resolveDir('~/repos/alpha', { home: ctx.home, run: odd }).method, 'none');
  });
});

describe('gitProbe', () => {
  it('reports ok, missing, old and unparseable', () => {
    const v = (text) => () => ({ status: 0, stdout: text, errorCode: null });
    assert.deepEqual(gitProbe({ run: v('git version 2.43.0\n') }), { ok: true, reason: null });
    assert.deepEqual(gitProbe({ run: v('git version 2.31.0\n') }), { ok: true, reason: null });
    assert.deepEqual(gitProbe({ run: v('git version 2.30.9\n') }), { ok: false, reason: 'old' });
    assert.deepEqual(gitProbe({ run: v('something else\n') }), { ok: false, reason: 'unparseable' });
    assert.deepEqual(gitProbe({ run: () => ({ status: null, stdout: '', errorCode: 'ENOENT' }) }), { ok: false, reason: 'missing' });
  });
});

describe('resolveRepos on a store', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    makeRepo(join(ctx.home, 'repos', 'alpha'), { home: ctx.home, files: { 'README.md': 'a\n' } });
  });
  after(() => ctx.cleanup());

  const freshStore = (cwds) => {
    rmSync(join(ctx.home, '.rigorscope'), { recursive: true, force: true });
    const db = openStore({ home: ctx.home });
    db.prepare("INSERT INTO ingest_run (started_utc, trigger) VALUES ('2026-10-28T12:00:00.000Z', 'test')").run();
    const ins = db.prepare("INSERT INTO cc_message (session_id, agent_id, message_id, cwd) VALUES ('s', '', ?, ?)");
    cwds.forEach((c, i) => ins.run(`m${i}`, c));
    return db;
  };
  const rows = () => queryDb(join(ctx.home, '.rigorscope', 'store.db'), 'SELECT dir, method FROM dir_repo ORDER BY dir');

  it('writes no row and says unavailable when git is missing or older than the floor; a form-only none is still written', () => {
    for (const [run, label] of [
      [() => ({ status: null, stdout: '', errorCode: 'ENOENT' }), 'missing'],
      [() => ({ status: 0, stdout: 'git version 2.30.9\n', errorCode: null }), 'old'],
    ]) {
      const db = freshStore(['~/repos/alpha', '~win/x']);
      try {
        const res = resolveRepos({ db, home: ctx.home, runId: 1, run });
        assert.equal(res.git, 'unavailable', label);
        assert.equal(res.deferred, 1, label);
        assert.equal(res.none, 1, label);
      } finally {
        db.close();
      }
      assert.deepEqual(rows(), [{ dir: '~win/x', method: 'none' }], label);
    }
  });

  it('counts a timeout as deferred, writes no row for it, and resolves it on the next call', () => {
    const db = freshStore(['~/repos/alpha']);
    try {
      const timeout = (args) => (args[0] === '--version' ? realRun(args) : { status: null, stdout: '', errorCode: 'ETIMEDOUT' });
      const first = resolveRepos({ db, home: ctx.home, runId: 1, run: timeout });
      assert.deepEqual(first, { git: 'ok', dirs: 1, resolved: 0, ancestor: 0, none: 0, deferred: 1 });
      const second = resolveRepos({ db, home: ctx.home, runId: 1, run: realRun });
      assert.deepEqual(second, { git: 'ok', dirs: 1, resolved: 1, ancestor: 0, none: 0, deferred: 0 });
      const third = resolveRepos({ db, home: ctx.home, runId: 1, run: realRun });
      assert.deepEqual(third, { git: 'not_needed', dirs: 0, resolved: 0, ancestor: 0, none: 0, deferred: 0 });
    } finally {
      db.close();
    }
    assert.deepEqual(rows(), [{ dir: '~/repos/alpha', method: 'git' }]);
  });
});

describe('repoNameOf', () => {
  it('names the parent of a .git dir, a bare dir without .git, and null for a failing segment', () => {
    assert.equal(repoNameOf('/x/y/alpha/.git'), 'alpha');
    assert.equal(repoNameOf('/x/y/tools.git'), 'tools');
    assert.equal(repoNameOf('/x/y/plain'), 'plain');
    assert.equal(repoNameOf('/x/y/bad name/.git'), null);
    assert.equal(repoNameOf('/x/y/.hidden/.git'), null);
    assert.equal(repoNameOf(`/x/${'a'.repeat(65)}/.git`), null);
  });
});

// Review 02-02 CR-01: a HOME that is itself a git work tree (`git init ~`, a common dotfiles setup) has the common dir
// `<home>/.git`, whose parent's basename is the OS user name. makeHome() cannot show it: its basename holds a space and
// a hash character, which fail the name shape. This HOME is `<tmp>/<PLANTS.osUser>`, a plain valid name.
describe('a HOME that is itself a git repository (review CR-01)', () => {
  let outer;
  let home;
  before(() => {
    outer = mkdtempSync(join(tmpdir(), 'rigorscope-homerepo-'));
    assertOutsideWorkTree(outer);
    home = join(outer, PLANTS.osUser);
    mkdirSync(join(home, 'scratch'), { recursive: true });
    git(home, ['init', '--quiet'], { home });
    git(home, ['commit', '--quiet', '--allow-empty', '-m', 'fixture commit'], { home });
  });
  after(() => rmSync(outer, { recursive: true, force: true }));

  it('the HOME basename passes the name shape, so only the resolver can keep it out', () => {
    assert.equal(repoNameOf(join(home, '.git')), PLANTS.osUser);
  });

  it('gives no repo_name for `~` and an existing non-repo dir under HOME; the key is ~/.git', () => {
    const { run } = recorder();
    for (const d of ['~', '~/scratch']) {
      assert.deepEqual(resolveDir(d, { home, run }),
        { repoKey: '~/.git', repoName: null, method: 'git', isWorktree: 0 }, d);
    }
  });

  it('gives no repo_name for a key rooted at HOME or at another user\'s or a Windows profile\'s home', () => {
    for (const key of ['~/.git', '~', '~other/.git', '~other', '~win/.git', '~win']) {
      assert.equal(repoNameOf(key), null, key);
    }
    assert.equal(repoNameOf('~/repos/alpha/.git'), 'alpha');
    assert.equal(repoNameOf('~other/x/tools.git'), 'tools');
  });
});

// Review 02-02 WR-01: the ancestor fallback may only answer with a repository found strictly below HOME. When HOME is
// a git work tree, git would otherwise walk up from the existing ancestor to HOME and attribute a vanished dir (a removed
// managed worktree, a deleted repo) to the HOME repo with method ancestor.
describe('the ancestor fallback when HOME is a git repository (review WR-01)', () => {
  let outer;
  let home;
  before(() => {
    outer = mkdtempSync(join(tmpdir(), 'rigorscope-homeanc-'));
    assertOutsideWorkTree(outer);
    home = join(outer, 'homeuser');
    mkdirSync(join(home, 'scratch'), { recursive: true });
    mkdirSync(join(home, 'wsroot', 'workspaces', 'alpha'), { recursive: true });
    git(home, ['init', '--quiet'], { home });
    git(home, ['commit', '--quiet', '--allow-empty', '-m', 'fixture commit'], { home });
    makeRepo(join(home, 'repos', 'alpha'), { home, files: { 'README.md': 'a\n' } });
  });
  after(() => rmSync(outer, { recursive: true, force: true }));

  it('gives method none for a vanished dir whose only enclosing repo is the HOME repo', () => {
    for (const d of ['~/wsroot/workspaces/alpha/fix-x', '~/repos/deleted-repo/sub']) {
      const { run } = recorder();
      assert.deepEqual(resolveDir(d, { home, run }), { repoKey: null, repoName: null, method: 'none', isWorktree: null }, d);
    }
  });

  it('still gives method ancestor for a vanished dir inside a repo strictly below HOME', () => {
    const { run } = recorder();
    assert.deepEqual(resolveDir('~/repos/alpha/deleted/sub', { home, run }),
      { repoKey: '~/repos/alpha/.git', repoName: 'alpha', method: 'ancestor', isWorktree: 0 });
  });

  it('sets the ceiling to HOME\'s realpath for an ancestor call and to its parent for an existing dir', () => {
    const anc = recorder();
    resolveDir('~/wsroot/workspaces/alpha/fix-x', { home, run: anc.run });
    assert.equal(anc.gitCalls()[0].env.GIT_CEILING_DIRECTORIES, realpathSync(home));
    const existing = recorder();
    assert.deepEqual(resolveDir('~/scratch', { home, run: existing.run }),
      { repoKey: '~/.git', repoName: null, method: 'git', isWorktree: 0 });
    assert.equal(existing.gitCalls()[0].env.GIT_CEILING_DIRECTORIES, dirname(realpathSync(home)));
  });
});

// Review 02-02 re-review WR-01: the same bound must hold for a dir stored as an absolute path under HOME's realpath
// (ingest normalizes a cwd against HOME only, so when HOME is a symlink a cwd recorded in its physical form stays
// absolute). The ceiling and the strictly-below-HOME bound follow the expanded path, not the `~` prefix.
describe('the ancestor fallback when HOME is a symlink to a git repository (re-review WR-01)', () => {
  let outer;
  let real;
  let home;
  before(() => {
    outer = realpathSync(mkdtempSync(join(tmpdir(), 'rigorscope-homelink-')));
    assertOutsideWorkTree(outer);
    real = join(outer, 'realhome');
    home = join(outer, 'linkhome');
    mkdirSync(join(real, 'scratch'), { recursive: true });
    mkdirSync(join(real, 'wsroot', 'workspaces', 'alpha'), { recursive: true });
    git(real, ['init', '--quiet'], { home: real });
    git(real, ['commit', '--quiet', '--allow-empty', '-m', 'fixture commit'], { home: real });
    makeRepo(join(real, 'repos', 'alpha'), { home: real, files: { 'README.md': 'a\n' } });
    symlinkSync(real, home);
  });
  after(() => rmSync(outer, { recursive: true, force: true }));

  it('gives method none for a vanished dir stored under the realpath of HOME, as it does for the ~ form', () => {
    const none = { repoKey: null, repoName: null, method: 'none', isWorktree: null };
    for (const d of [join(real, 'wsroot', 'workspaces', 'alpha', 'fix-x'), join(home, 'wsroot', 'workspaces', 'alpha', 'fix-x'),
      join(real, 'repos', 'deleted-repo', 'sub')]) {
      const { run } = recorder();
      assert.deepEqual(resolveDir(d, { home, run }), none, d);
    }
    const { run } = recorder();
    assert.deepEqual(resolveDir('~/wsroot/workspaces/alpha/fix-x', { home, run }), none);
  });

  it('still gives method ancestor for a vanished dir stored under the realpath inside a repo strictly below HOME', () => {
    const { run } = recorder();
    assert.deepEqual(resolveDir(join(real, 'repos', 'alpha', 'deleted', 'sub'), { home, run }),
      { repoKey: '~/repos/alpha/.git', repoName: 'alpha', method: 'ancestor', isWorktree: 0 });
  });

  it('sets the ceiling for an absolute dir under the realpath of HOME as it does for the ~ form', () => {
    const anc = recorder();
    resolveDir(join(real, 'wsroot', 'workspaces', 'alpha', 'fix-x'), { home, run: anc.run });
    assert.equal(anc.gitCalls()[0].env.GIT_CEILING_DIRECTORIES, real);
    const existing = recorder();
    assert.deepEqual(resolveDir(join(real, 'scratch'), { home, run: existing.run }),
      { repoKey: '~/.git', repoName: null, method: 'git', isWorktree: 0 });
    assert.equal(existing.gitCalls()[0].env.GIT_CEILING_DIRECTORIES, outer);
  });

  it('keeps no ceiling and the filesystem-root bound for an absolute dir outside HOME', () => {
    const other = join(outer, 'elsewhere');
    mkdirSync(other, { recursive: true });
    const rec = recorder();
    resolveDir(join(other, 'gone'), { home, run: rec.run });
    assert.ok(!Object.hasOwn(rec.gitCalls()[0].env, 'GIT_CEILING_DIRECTORIES'));
  });
});

describe('frontmatter reader', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'rigorscope-fm-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('tierLetter reads the first top-level tier letter only', () => {
    assert.equal(tierLetter(['status: x', 'tier: A (guard work)']), 'A');
    assert.equal(tierLetter(['tier: "B"']), 'B');
    assert.equal(tierLetter(["tier: 'C'"]), 'C');
    assert.equal(tierLetter(['  tier: A']), null);
    assert.equal(tierLetter(['tier: AB']), null);
    assert.equal(tierLetter(['tier: D']), null);
    assert.equal(tierLetter(['title: tier: A']), null);
  });

  it('frontmatterLines needs a leading --- block and its closing line', () => {
    assert.deepEqual(frontmatterLines('---\ntier: A\n---\nbody tier: B\n'), ['tier: A']);
    assert.deepEqual(frontmatterLines('﻿---\r\ntier: B\r\n---\r\n'), ['tier: B']);
    assert.equal(frontmatterLines('# title\n---\ntier: A\n---\n'), null);
    assert.equal(frontmatterLines('---\ntier: A\n'), null);
    assert.equal(frontmatterLines(`---\n${'k: v\n'.repeat(401)}---\n`), null);
  });

  it('readHead reads a regular file up to the byte cap and refuses a symlink', () => {
    const big = join(dir, 'big.md');
    writeFileSync(big, `---\ntier: A\n---\n${'x'.repeat(FRONTMATTER_MAX_BYTES * 2)}`);
    assert.equal(Buffer.byteLength(readHead(big), 'utf8'), FRONTMATTER_MAX_BYTES);
    const link = join(dir, 'link.md');
    symlinkSync(big, link);
    assert.equal(readHead(link), null);
    assert.equal(readHead(join(dir, 'missing.md')), null);
  });
});
