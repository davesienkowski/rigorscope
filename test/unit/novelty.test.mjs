// Plan 02-03 (D-07): the pure novelty rules of src/units/novelty.mjs and the git-backed module-dir answers of the
// collector (noveltyInputs in src/adapters/gsd-core/signals.mjs), on the fixture repos of test/fixtures/golden-repo.mjs.
// Written before the code (RED): the modules are loaded inside the tests that use them. Novelty has no golden labels;
// these fixtures are its only test (a column only in phase 2).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome } from '../fixtures/build.mjs';
import { buildGoldenRepo } from '../fixtures/golden-repo.mjs';

const noveltyMod = () => import('../../src/units/novelty.mjs');
const signalsMod = () => import('../../src/adapters/gsd-core/signals.mjs');
const commit = (sha, ms, ...files) => ({ sha, author_ms: ms, files: files.map(([status, path]) => ({ path, status })) });

describe('module dirs and code paths', () => {
  it('moduleDirOf keeps the first three directory segments', async () => {
    const { moduleDirOf, NOVELTY_DIR_DEPTH, NOVELTY_RULES_VERSION } = await noveltyMod();
    assert.equal(NOVELTY_DIR_DEPTH, 3);
    assert.equal(NOVELTY_RULES_VERSION, 1);
    assert.equal(moduleDirOf('src/new/mod.mjs'), 'src/new');
    assert.equal(moduleDirOf('src/sources/otel/x/y.mjs'), 'src/sources/otel');
    assert.equal(moduleDirOf('scripts/a.mjs'), 'scripts');
    assert.equal(moduleDirOf('a.mjs'), '');
  });

  it('isNoveltyCodePath excludes planning, test and fixture dirs, test files, .md and .txt', async () => {
    const { isNoveltyCodePath } = await noveltyMod();
    for (const p of ['src/a.mjs', 'hooks/h.sh', 'pkg/a.py', 'data/x.json', 'bin/tool.mjs']) assert.equal(isNoveltyCodePath(p), true, p);
    for (const p of ['.planning/x/a.mjs', 'test/a.mjs', 'tests/a.mjs', 'src/test/a.mjs', 'test/fixtures/a.mjs', 'src/fixtures/a.mjs',
      'src/fixture/a.mjs', 'src/a.test.mjs', 'README.md', 'docs/x.MD', 'notes.txt', '', null]) {
      assert.equal(isNoveltyCodePath(p), false, String(p));
    }
  });
});

describe('noveltyOf (D-07)', () => {
  it('a new module dir is first-of-kind by the new-dir rule', async () => {
    const { noveltyOf } = await noveltyMod();
    const commits = [commit('a', 1, ['A', 'src/new/a.mjs'], ['A', 'src/old/b.mjs'])];
    assert.deepEqual(noveltyOf({ commits, newDirs: new Map([['src/new', false], ['src/old', true]]) }),
      { novelty: 'first-of-kind', novelty_source: 'rule:new-dir@1' });
  });

  it('an added file directly in a commands or bin dir is first-of-kind by the new-command rule', async () => {
    const { noveltyOf } = await noveltyMod();
    assert.deepEqual(noveltyOf({ commits: [commit('a', 1, ['A', 'src/commands/x.mjs'])], newDirs: new Map([['src/commands', true]]) }),
      { novelty: 'first-of-kind', novelty_source: 'rule:new-command@1' });
    assert.deepEqual(noveltyOf({ commits: [commit('a', 1, ['A', 'bin/tool.mjs'])], newDirs: new Map([['bin', true]]) }),
      { novelty: 'first-of-kind', novelty_source: 'rule:new-command@1' });
    assert.deepEqual(noveltyOf({ commits: [commit('a', 1, ['A', 'src/commands/sub/x.mjs'])], newDirs: new Map([['src/commands/sub', true]]) }),
      { novelty: 'incremental', novelty_source: 'rule:incremental@1' });
  });

  it('existing dirs, modified files and only excluded paths are incremental', async () => {
    const { noveltyOf } = await noveltyMod();
    const inc = { novelty: 'incremental', novelty_source: 'rule:incremental@1' };
    assert.deepEqual(noveltyOf({ commits: [commit('a', 1, ['A', 'src/a/b.mjs'])], newDirs: new Map([['src/a', true]]) }), inc);
    assert.deepEqual(noveltyOf({ commits: [commit('a', 1, ['M', 'src/new/b.mjs'])], newDirs: new Map() }), inc);
    assert.deepEqual(noveltyOf({ commits: [commit('a', 1, ['A', '.planning/q/x.md'], ['A', 'test/new/a.test.mjs'], ['A', 'docs/new.md'])], newDirs: null }), inc);
  });

  it('no commits, or an added code path whose dir was not checked, is unknown (no-evidence)', async () => {
    const { noveltyOf } = await noveltyMod();
    const unknown = { novelty: null, novelty_source: 'no-evidence' };
    assert.deepEqual(noveltyOf({ commits: null, newDirs: new Map() }), unknown);
    assert.deepEqual(noveltyOf({ commits: [], newDirs: new Map() }), unknown);
    assert.deepEqual(noveltyOf({ commits: [commit('a', 1, ['A', 'src/x/a.mjs'])], newDirs: new Map([['src/x', null]]) }), unknown);
    assert.deepEqual(noveltyOf({ commits: [commit('a', 1, ['A', 'src/x/a.mjs'])], newDirs: new Map() }), unknown);
    assert.deepEqual(noveltyOf({ commits: [commit('a', 1, ['A', 'src/x/a.mjs'])], newDirs: null }), unknown);
    assert.deepEqual(noveltyOf({ commits: [commit('a', 1, ['A', 'src/x/a.mjs'], ['A', 'src/y/b.mjs'])], newDirs: new Map([['src/x', false], ['src/y', null]]) }), unknown);
  });
});

describe('novelty on the fixture repos', () => {
  let ctx;
  let fx;
  before(() => {
    ctx = makeHome();
    fx = buildGoldenRepo({ home: ctx.home });
  });
  after(() => ctx?.cleanup());

  const novelty = async (top, kind, nativeId, run) => {
    const { unitCommits, noveltyInputs } = await signalsMod();
    const { noveltyOf } = await noveltyMod();
    const uc = unitCommits({ top, kind, nativeId });
    const commits = uc === null ? null : uc.commits;
    const newDirs = noveltyInputs({ top, commits, ...(run ? { run } : {}) });
    return noveltyOf({ commits, newDirs });
  };

  it('gives incremental, new-dir, new-command, unknown and a root-commit new dir', async () => {
    assert.deepEqual(await novelty(fx.gamma, 'quick', '261020-aaa'), { novelty: 'incremental', novelty_source: 'rule:incremental@1' });
    assert.deepEqual(await novelty(fx.gamma, 'quick', '261021-bbb'), { novelty: 'first-of-kind', novelty_source: 'rule:new-dir@1' });
    assert.deepEqual(await novelty(fx.gamma, 'plan', '03-01'), { novelty: 'first-of-kind', novelty_source: 'rule:new-command@1' });
    assert.deepEqual(await novelty(fx.delta, 'quick', '261022-ccc'), { novelty: null, novelty_source: 'no-evidence' });
    assert.deepEqual(await novelty(fx.zeta, 'quick', '261025-rrr'), { novelty: 'first-of-kind', novelty_source: 'rule:new-dir@1' });
  });

  it('a runner that times out gives unknown, never incremental', async () => {
    const timeout = () => ({ status: null, stdout: '', errorCode: 'ETIMEDOUT' });
    assert.deepEqual(await novelty(fx.gamma, 'quick', '261020-aaa', timeout), { novelty: null, novelty_source: 'no-evidence' });
  });

  it('asks git once per module dir through the safe argument prefix, at most 32 dirs', async () => {
    const { noveltyInputs, NOVELTY_MAX_DIRS } = await signalsMod();
    assert.equal(NOVELTY_MAX_DIRS, 32);
    const sha = 'a'.repeat(40);
    const files = Array.from({ length: 33 }, (_, i) => ['A', `m${String(i).padStart(2, '0')}/x.mjs`]);
    const calls = [];
    const run = (args) => { calls.push(args); return { status: 1, stdout: '', errorCode: null }; };
    const map = noveltyInputs({ top: '/work/repo', commits: [commit(sha, 5, ...files), commit('b'.repeat(40), 9, ['A', 'm00/y.mjs'])], run });
    assert.equal(calls.length, 32);
    assert.deepEqual(calls[0].slice(0, 6), ['-C', '/work/repo', '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false']);
    assert.deepEqual(calls[0].slice(-3), ['cat-file', '-e', `${sha}^:m00`]);
    assert.equal(map.get('m00'), false);
    assert.equal(map.get('m31'), false);
    assert.equal(map.get('m32'), null);
    assert.equal(noveltyInputs({ top: '/work/repo', commits: null, run }), null);
    assert.equal(noveltyInputs({ top: '/work/repo', commits: [], run }), null);
  });
});
