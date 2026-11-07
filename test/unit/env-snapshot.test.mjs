// Plan 02-04 (DATA-07, D-16 with amendment Q3, D-24, UNIT-04 inputs): the environment snapshot of every ingest run.
// The snapshotter reads one config dir (CLAUDE_CONFIG_DIR when set, non-empty and absolute, else HOME/.claude): the
// GSD version from gsd-core/VERSION or gsd-file-manifest.json, the `hooks`, `model` and `advisorModel` keys of
// settings.json (hook event names with counts and one sha256 of the hooks block, never a command), the `sha` of the
// file named by RIGORSCOPE_INSTALLED_BASE_FILE and the HEAD of the repository named by RIGORSCOPE_LOCAL_MODS_DIR.
// Every source is optional; absent is NULL. Written before the code (RED): src/env/snapshot.mjs is imported inside
// each in-process test, and the spawned `env:` line test runs first. Every HOME is a temporary makeHome() HOME and the
// spawned runs use cliEnv, which never inherits CLAUDE_CONFIG_DIR or the two variables.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FIXTURE_NOW } from '../fixtures/clock.mjs';
import {
  REPO, cliEnv, makeHome, queryDb, runCli, stateDirOf,
} from '../fixtures/build.mjs';
import { git, makeRepo } from '../fixtures/git-repo.mjs';

const load = () => import('../../src/env/snapshot.mjs');
const STORE = (home) => join(stateDirOf(home), 'store.db');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const BASE_SHA = 'abc123abc123abc123abc123abc123abc123abc1';
const HOOKS = {
  PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'SNAP-hook-cmd one' }] },
    { hooks: [{ type: 'command', command: 'two' }] },
  ],
  Stop: [{ hooks: [{ type: 'command', command: 'three' }] }],
};
const CANONICAL_HOOKS = '{"PreToolUse":[{"hooks":[{"command":"SNAP-hook-cmd one","type":"command"}],"matcher":"Bash"},'
  + '{"hooks":[{"command":"two","type":"command"}]}],"Stop":[{"hooks":[{"command":"three","type":"command"}]}]}';
const EMPTY_LINE = 'env: gsd_version=? gsd_version_source=? base_sha=? local_mods_head=? hook_events=? hooks=? model_default=? advisor_model=?';
const linesOf = (text) => text.split('\n').filter((l) => l !== '');

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

// The configured HOME of the spawned test: settings, VERSION, a base file and a local-mods repository.
function configure(home) {
  writeJson(join(home, '.claude', 'settings.json'), {
    hooks: HOOKS,
    model: 'opus',
    advisorModel: 'haiku',
    env: { TOKEN: 'SNAP-env-token' },
    statusLine: { type: 'command', command: 'SNAP-status-cmd' },
  });
  writeJson(join(home, '.claude', 'gsd-core', 'VERSION'), '1.19.0\n');
  const baseFile = join(home, 'base', 'installed-base.json');
  writeJson(baseFile, { sha: BASE_SHA, source: 'SNAP-base-source', evidence: 'SNAP-base-evidence' });
  const mods = join(home, 'mods');
  makeRepo(mods, { home, files: { 'README.md': 'mods fixture\n' } });
  const head = git(mods, ['rev-parse', 'HEAD'], { home }).trim();
  return { baseFile, mods, head };
}

describe('the env line and the env_snapshot row of a configured HOME (spawned)', () => {
  let ctx;
  let cfg;
  let env;
  let first;
  before(() => {
    ctx = makeHome();
    cfg = configure(ctx.home);
    env = cliEnv(ctx.home, { RIGORSCOPE_INSTALLED_BASE_FILE: cfg.baseFile, RIGORSCOPE_LOCAL_MODS_DIR: cfg.mods });
    first = runCli(['ingest'], { home: ctx.home, env });
  });
  after(() => ctx.cleanup());

  it('prints the env line before the units line', () => {
    assert.equal(first.status, 0, first.stderr);
    const lines = linesOf(first.stdout);
    const at = lines.findIndex((l) => l.startsWith('units: '));
    assert.ok(at > 0, 'a units line');
    assert.equal(lines[at - 1], `env: gsd_version=1.19.0 gsd_version_source=version-file base_sha=${BASE_SHA.slice(0, 12)} `
      + `local_mods_head=${cfg.head.slice(0, 12)} hook_events=2 hooks=3 model_default=opus advisor_model=haiku`);
  });

  it('stores one row for the run with the event counts and the sha256 of the canonical hooks block', () => {
    const rows = queryDb(STORE(ctx.home), 'SELECT * FROM env_snapshot ORDER BY run_id');
    assert.equal(rows.length, 1);
    const [run] = queryDb(STORE(ctx.home), 'SELECT max(run_id) AS id FROM ingest_run');
    assert.deepEqual(rows[0], {
      run_id: run.id,
      taken_utc: FIXTURE_NOW,
      gsd_version: '1.19.0',
      gsd_version_source: 'version-file',
      base_sha: BASE_SHA,
      local_mods_head: cfg.head,
      hooks_sha: sha256(CANONICAL_HOOKS),
      hook_events: '{"PreToolUse":2,"Stop":1}',
      model_default: 'opus',
      advisor_model: 'haiku',
    });
  });

  it('a second ingest adds a second row with the next run id and the same values', () => {
    const again = runCli(['ingest'], { home: ctx.home, env });
    assert.equal(again.status, 0, again.stderr);
    const rows = queryDb(STORE(ctx.home), 'SELECT * FROM env_snapshot ORDER BY run_id');
    assert.equal(rows.length, 2);
    assert.equal(rows[1].run_id, rows[0].run_id + 1);
    const { run_id: _a, ...a } = rows[0];
    const { run_id: _b, ...b } = rows[1];
    assert.deepEqual(b, a);
    for (const out of [first.stdout, first.stderr, again.stdout, again.stderr]) assert.ok(!out.includes('SNAP-'), 'a planted value was printed');
  });

  it('no byte of store.db, its WAL or shm file holds a settings, base-file or hook command value', async () => {
    const { checkpointStore } = await import('../../src/db.mjs');
    checkpointStore({ home: ctx.home });
    for (const name of ['store.db', 'store.db-wal', 'store.db-shm']) {
      const file = join(stateDirOf(ctx.home), name);
      if (existsSync(file)) assert.ok(!readFileSync(file).toString('latin1').includes('SNAP-'), `${name} holds a planted value`);
    }
  });
});

describe('the env line of an unconfigured HOME (spawned)', () => {
  it('prints every field as ? and stores a row with every column NULL but run_id and taken_utc', () => {
    const ctx = makeHome();
    try {
      const r = runCli(['ingest'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      const lines = linesOf(r.stdout);
      const at = lines.findIndex((l) => l.startsWith('units: '));
      assert.equal(lines[at - 1], EMPTY_LINE);
      const rows = queryDb(STORE(ctx.home), 'SELECT * FROM env_snapshot');
      assert.equal(rows.length, 1);
      const { run_id: runId, taken_utc: taken, ...rest } = rows[0];
      assert.ok(Number.isInteger(runId));
      assert.equal(taken, FIXTURE_NOW);
      for (const [k, v] of Object.entries(rest)) assert.equal(v, null, `${k} is NULL`);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('the snapshotter in process', () => {
  const homes = [];
  after(() => homes.forEach((c) => c.cleanup()));
  const fresh = () => { const c = makeHome(); homes.push(c); return c.home; };
  const cfgDir = (home) => join(home, '.claude');

  it('configDirOf takes CLAUDE_CONFIG_DIR only when it is set, non-empty and absolute', async () => {
    const { configDirOf } = await load();
    assert.equal(configDirOf({ home: '/h/u', env: {} }), join('/h/u', '.claude'));
    assert.equal(configDirOf({ home: '/h/u', env: { CLAUDE_CONFIG_DIR: '' } }), join('/h/u', '.claude'));
    assert.equal(configDirOf({ home: '/h/u', env: { CLAUDE_CONFIG_DIR: 'rel/dir' } }), join('/h/u', '.claude'));
    assert.equal(configDirOf({ home: '/h/u', env: { CLAUDE_CONFIG_DIR: '/c/d' } }), '/c/d');
  });

  it('reads the GSD version from VERSION, else from the manifest, else NULL', async () => {
    const { readGsdVersion, SNAPSHOT_LIMITS } = await load();
    const h = fresh();
    const dir = cfgDir(h);
    assert.deepEqual(readGsdVersion(dir), { value: null, source: null });
    writeJson(join(dir, 'gsd-file-manifest.json'), { version: '1.18.2', mode: 'x', files: { a: 'b' } });
    assert.deepEqual(readGsdVersion(dir), { value: '1.18.2', source: 'manifest' });
    writeJson(join(dir, 'gsd-core', 'VERSION'), 'not a version text\n');
    assert.deepEqual(readGsdVersion(dir), { value: '1.18.2', source: 'manifest' }, 'a shape-failing VERSION falls through');
    writeJson(join(dir, 'gsd-core', 'VERSION'), ' 1.19.0 \n');
    assert.deepEqual(readGsdVersion(dir), { value: '1.19.0', source: 'version-file' });
    writeJson(join(dir, 'gsd-core', 'VERSION'), `1.${'0'.repeat(SNAPSHOT_LIMITS.versionMaxBytes)}`);
    assert.equal(readGsdVersion(dir).source, 'manifest', 'a VERSION above its cap is not read');
    const h2 = fresh();
    mkdirSync(join(cfgDir(h2), 'gsd-core', 'VERSION'), { recursive: true });
    writeJson(join(cfgDir(h2), 'gsd-file-manifest.json'), '{ not json');
    assert.deepEqual(readGsdVersion(cfgDir(h2)), { value: null, source: null }, 'a directory VERSION and a broken manifest');
    const h3 = fresh();
    writeJson(join(cfgDir(h3), 'gsd-core', 'VERSION'), '1.0.0.0.0\n');
    writeJson(join(cfgDir(h3), 'gsd-file-manifest.json'), { version: `${'9'.repeat(40)}` });
    assert.deepEqual(readGsdVersion(cfgDir(h3)), { value: null, source: null }, 'shape and the 32-character bound');
  });

  it('reads hook counts, the hooks hash and the two model names from settings.json only', async () => {
    const { readSettingsFacts, canonicalJson } = await load();
    const h = fresh();
    const dir = cfgDir(h);
    assert.deepEqual(readSettingsFacts(dir), {
      hookEvents: null, hooksSha: null, hookEventCount: null, hookCount: null, model: null, advisorModel: null,
    }, 'no settings file');
    writeJson(join(dir, 'settings.json'), { model: 'opus[1m]', permissions: { allow: ['x'] } });
    assert.deepEqual(readSettingsFacts(dir), {
      hookEvents: '{}', hooksSha: sha256('{}'), hookEventCount: 0, hookCount: 0, model: 'opus[1m]', advisorModel: null,
    }, 'no hooks key counts as {}');
    writeJson(join(dir, 'settings.json'), { hooks: HOOKS, model: 'bad model', advisorModel: 'x@y' });
    const a = readSettingsFacts(dir);
    assert.deepEqual([a.hookEvents, a.hooksSha, a.hookEventCount, a.hookCount, a.model, a.advisorModel],
      ['{"PreToolUse":2,"Stop":1}', sha256(CANONICAL_HOOKS), 2, 3, null, null]);
    assert.equal(canonicalJson(HOOKS), CANONICAL_HOOKS);
    const reordered = { Stop: [{ hooks: [{ command: 'three', type: 'command' }] }], PreToolUse: [{ hooks: [{ command: 'SNAP-hook-cmd one', type: 'command' }], matcher: 'Bash' }, { hooks: [{ type: 'command', command: 'two' }] }] };
    writeJson(join(dir, 'settings.json'), { hooks: reordered });
    assert.equal(readSettingsFacts(dir).hooksSha, a.hooksSha, 'key order at any level does not change the hash');
    writeJson(join(dir, 'settings.json'), { hooks: { ...HOOKS, Stop: [{ hooks: [{ type: 'command', command: 'changed' }] }] } });
    const changed = readSettingsFacts(dir);
    assert.notEqual(changed.hooksSha, a.hooksSha);
    assert.equal(changed.hookEvents, a.hookEvents);
    writeJson(join(dir, 'settings.json'), { hooks: { 'bad name': [{ hooks: [{}, {}] }], Stop: [{ hooks: [{}] }] } });
    assert.equal(readSettingsFacts(dir).hookEvents, '{"?":2,"Stop":1}');
    for (const bad of ['{ not json', JSON.stringify({ hooks: ['x'] }), JSON.stringify({ hooks: 'x' })]) {
      writeJson(join(dir, 'settings.json'), bad);
      const r = readSettingsFacts(dir);
      assert.deepEqual([r.hookEvents, r.hooksSha], [null, null], 'unusable hooks give NULL');
    }
    let deep = {};
    for (let i = 0; i < 40; i += 1) deep = { d: deep };
    writeJson(join(dir, 'settings.json'), { hooks: { Stop: [{ hooks: [deep] }] }, model: 'opus' });
    const d = readSettingsFacts(dir);
    assert.deepEqual([d.hookEvents, d.hooksSha, d.model], [null, null, 'opus'], 'nesting past the depth cap');
    assert.throws(() => canonicalJson(deep));
  });

  it('event names that name Object.prototype members count as integers (review WR-01)', async () => {
    const { readSettingsFacts } = await load();
    const dir = cfgDir(fresh());
    // A raw JSON string: an object literal with __proto__ would set the prototype instead of an own key.
    writeJson(join(dir, 'settings.json'), '{"hooks":{"constructor":[{"hooks":[{}]}],"toString":[{"hooks":[1,2]}],'
      + '"hasOwnProperty":[{"hooks":[{}]}],"__proto__":[{"hooks":[{}]}],"Stop":[{"hooks":[{}]}]}}');
    const r = readSettingsFacts(dir);
    assert.equal(r.hookEvents, '{"?":1,"Stop":1,"constructor":1,"hasOwnProperty":1,"toString":2}');
    const parsed = JSON.parse(r.hookEvents);
    for (const [k, v] of Object.entries(parsed)) assert.ok(Number.isInteger(v), `${k} counts as an integer`);
    assert.deepEqual([r.hookEventCount, r.hookCount], [5, 6]);
  });

  it('a settings file above its size cap is not read', async () => {
    const { readSettingsFacts, SNAPSHOT_LIMITS } = await load();
    const dir = cfgDir(fresh());
    writeJson(join(dir, 'settings.json'), JSON.stringify({ model: 'opus', pad: 'x'.repeat(SNAPSHOT_LIMITS.settingsMaxBytes) }));
    assert.equal(readSettingsFacts(dir).model, null);
  });

  it('reads the base sha only from an absolute, regular, small file with a lower-case 40 or 64 hex sha', async () => {
    const { readBaseSha, INSTALLED_BASE_ENV } = await load();
    const h = fresh();
    const file = join(h, 'base.json');
    const env = { [INSTALLED_BASE_ENV]: file };
    assert.equal(readBaseSha(env), null, 'missing');
    writeJson(file, { sha: BASE_SHA });
    assert.equal(readBaseSha(env), BASE_SHA);
    assert.equal(readBaseSha({ [INSTALLED_BASE_ENV]: 'base.json' }), null, 'relative');
    assert.equal(readBaseSha({}), null, 'unset');
    writeJson(file, { sha: BASE_SHA.toUpperCase() });
    assert.equal(readBaseSha(env), null, 'upper case');
    writeJson(file, { sha: BASE_SHA.slice(1) });
    assert.equal(readBaseSha(env), null, '39 characters');
    assert.equal(readBaseSha({ [INSTALLED_BASE_ENV]: h }), null, 'a directory');
  });

  it('reads the local-mods HEAD only for an absolute repository directory, through the runner', async () => {
    const { readLocalModsHead, LOCAL_MODS_ENV } = await load();
    const h = fresh();
    const repo = makeRepo(join(h, 'outer'), { home: h, files: { 'a.txt': 'a\n' } });
    const head = git(repo, ['rev-parse', 'HEAD'], { home: h }).trim();
    assert.equal(readLocalModsHead({ [LOCAL_MODS_ENV]: repo }), head);
    const inner = join(repo, 'plain', 'dir');
    mkdirSync(inner, { recursive: true });
    assert.equal(readLocalModsHead({ [LOCAL_MODS_ENV]: inner }), null, 'a plain directory inside another repository (the ceiling)');
    assert.equal(readLocalModsHead({ [LOCAL_MODS_ENV]: 'outer' }), null, 'relative');
    assert.equal(readLocalModsHead({ [LOCAL_MODS_ENV]: join(h, 'missing') }), null, 'missing');
    const spawnFail = () => ({ status: null, stdout: '', errorCode: 'ENOENT' });
    const timeout = () => ({ status: null, stdout: '', errorCode: 'ETIMEDOUT' });
    const calls = [];
    const record = (args, opts) => { calls.push({ args, opts }); return { status: 0, stdout: `${head}\n`, errorCode: null }; };
    assert.equal(readLocalModsHead({ [LOCAL_MODS_ENV]: repo }, { run: spawnFail }), null);
    assert.equal(readLocalModsHead({ [LOCAL_MODS_ENV]: repo }, { run: timeout }), null);
    assert.equal(readLocalModsHead({ [LOCAL_MODS_ENV]: repo }, { run: record }), head);
    const real = realpathSync(repo);
    assert.deepEqual(calls[0].args, ['-C', real, '-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD']);
    assert.equal(calls[0].opts.env.GIT_CEILING_DIRECTORIES, dirname(real));
    assert.equal(calls[0].opts.env.GIT_OPTIONAL_LOCKS, '0');
    assert.ok(!('GIT_DIR' in calls[0].opts.env));
  });

  it('takeSnapshot returns the row columns and the eight printed values, and no other settings value', async () => {
    const { takeSnapshot } = await load();
    const h = fresh();
    writeJson(join(cfgDir(h), 'settings.json'), {
      hooks: HOOKS, model: 'opus', env: { TOKEN: 'SNAP-env-token' }, statusLine: { command: 'SNAP-status-cmd' }, permissions: { allow: ['SNAP-perm'] },
    });
    const r = takeSnapshot({ home: h, env: {}, now: () => new Date(FIXTURE_NOW) });
    assert.deepEqual(Object.keys(r.row).sort(), ['advisor_model', 'base_sha', 'gsd_version', 'gsd_version_source', 'hook_events',
      'hooks_sha', 'local_mods_head', 'model_default', 'taken_utc']);
    assert.deepEqual(Object.keys(r.line), ['gsd_version', 'gsd_version_source', 'base_sha', 'local_mods_head', 'hook_events',
      'hooks', 'model_default', 'advisor_model']);
    assert.deepEqual([r.line.hook_events, r.line.hooks, r.line.model_default], [2, 3, 'opus']);
    assert.ok(!JSON.stringify(r).includes('SNAP-'));
  });
});

describe('the snapshot docs', () => {
  it('docs/sources.md names every source and docs/cli.md names both variables under Environment', () => {
    const sources = readFileSync(join(REPO, 'docs/sources.md'), 'utf8');
    for (const n of ['hooks', 'model', 'advisorModel', 'VERSION', 'gsd-file-manifest.json', 'RIGORSCOPE_LOCAL_MODS_DIR', 'RIGORSCOPE_INSTALLED_BASE_FILE']) {
      assert.ok(sources.includes(`\`${n}\``), `sources.md names ${n}`);
    }
    const cli = readFileSync(join(REPO, 'docs/cli.md'), 'utf8');
    const envSection = cli.slice(cli.indexOf('## Environment'));
    for (const n of ['RIGORSCOPE_LOCAL_MODS_DIR', 'RIGORSCOPE_INSTALLED_BASE_FILE']) assert.ok(envSection.includes(`\`${n}\``), `cli.md Environment names ${n}`);
  });
});
