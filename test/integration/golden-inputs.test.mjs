// Plan 02-03 tracer (TRUST-10, D-01..D-04, D-24, amendments Q1 and Q6, Pitfall 8): the fixture repos of
// test/fixtures/golden-repo.mjs go through the spawned snapshot script scripts/golden-inputs.mjs, and the file it
// writes is scored by test/golden/score.mjs with the pure tier and timing rules. Written before the code (RED): the
// script and the scorer are loaded only inside the tests that use them.
//
// The script runs on a temporary HOME from makeHome() (its name holds a planted OS user name, a space and a hash
// character) with only PATH, TMPDIR, LANG and HOME in its environment.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLANTS, makeHome } from '../fixtures/build.mjs';
import {
  GOLDEN_PLANTS, buildGoldenRepo, buildNameLeakRepo, goldenMs,
} from '../fixtures/golden-repo.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'golden-inputs.mjs');
const scoreModule = () => import(pathToFileURL(join(REPO, 'test', 'golden', 'score.mjs')).href);

const ROW_KEYS = ['schema', 'repo', 'kind', 'native_id', 'located', 'dir_rel', 'git', 'artifacts', 'files_modified', 'commits', 'dropped_paths'];
const MISSING_KEYS = ['schema', 'repo', 'kind', 'native_id', 'located', 'reason'];
const ARTIFACT_KEYS = ['role', 'rel_path', 'tier_letter', 'tier_place', 'first_commit_ms', 'tier_commit_ms'];
const COMMIT_KEYS = ['sha', 'author_ms', 'files'];
const FILE_KEYS = ['path', 'status'];

function envFor(home) {
  const env = { HOME: home };
  for (const k of ['PATH', 'TMPDIR', 'LANG']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

function runScript(args, home) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, env: envFor(home), encoding: 'utf8', timeout: 120000 });
}

const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const keyOf = (r) => `${r.repo}/${r.kind}/${r.native_id}`;

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

describe('the golden inputs script on the fixture repos (tracer)', () => {
  let ctx;
  let fx;
  let out;
  let first;
  let text = '';
  let rows = [];
  before(() => {
    ctx = makeHome();
    fx = buildGoldenRepo({ home: ctx.home });
    mkdirSync(join(ctx.home, 'out'), { recursive: true });
    out = join(ctx.home, 'out', 'inputs.jsonl');
    first = runScript(['--manifest', fx.manifest, '--out', out, fx.gamma, fx.delta], ctx.home);
    if (existsSync(out)) {
      text = readFileSync(out, 'utf8');
      rows = linesOf(text).map((l) => JSON.parse(l));
    }
  });
  after(() => ctx?.cleanup());

  it('exits 0 and prints the counts line and the repos-not-given line', () => {
    assert.equal(first.status, 0, 'the snapshot script exits 0');
    assert.deepEqual(linesOf(first.stdout), fx.expected.stdout);
    assert.equal(first.stderr, '');
  });

  it('writes one row per manifest unit, sorted by repo, kind and native_id', () => {
    assert.deepEqual(rows.map(keyOf), fx.expected.order);
    assert.ok(text.endsWith('\n'));
    for (const r of rows) {
      assert.equal(r.schema, 'rigorscope.golden-inputs/1');
      assert.deepEqual(Object.keys(r), r.located ? ROW_KEYS : MISSING_KEYS, keyOf(r));
      for (const a of r.artifacts ?? []) assert.deepEqual(Object.keys(a), ARTIFACT_KEYS);
      for (const c of r.commits ?? []) {
        assert.deepEqual(Object.keys(c), COMMIT_KEYS);
        for (const f of c.files) {
          assert.deepEqual(Object.keys(f), FILE_KEYS);
          assert.ok(['A', 'M', 'D'].includes(f.status));
        }
      }
    }
    const byKey = Object.fromEntries(rows.map((r) => [keyOf(r), r]));
    assert.deepEqual(byKey['epsilon/quick/261024-yyy'], {
      schema: 'rigorscope.golden-inputs/1', repo: 'epsilon', kind: 'quick', native_id: '261024-yyy', located: false, reason: 'repo_not_given',
    });
    assert.equal(byKey['gamma/quick/261023-zzz'].located, false);
    assert.equal(byKey['gamma/quick/261023-zzz'].reason, 'unit_not_found');
  });

  it('reads the D-01 places of a quick unit and its files_modified, commit facts and dropped paths', () => {
    const aaa = rows.find((r) => keyOf(r) === 'gamma/quick/261020-aaa');
    assert.equal(aaa.dir_rel, '.planning/quick/261020-aaa-tier-file');
    assert.equal(aaa.git, 'ok');
    const d = aaa.dir_rel;
    assert.deepEqual(aaa.artifacts, [
      { role: 'plan', rel_path: `${d}/261020-aaa-PLAN.md`, tier_letter: null, tier_place: null, first_commit_ms: goldenMs('T0'), tier_commit_ms: null },
      { role: 'summary', rel_path: `${d}/261020-aaa-SUMMARY.md`, tier_letter: null, tier_place: null, first_commit_ms: goldenMs('T3'), tier_commit_ms: null },
      { role: 'rigor-tier', rel_path: `${d}/RIGOR-TIER.md`, tier_letter: 'B', tier_place: 'tier-line', first_commit_ms: goldenMs('T1'), tier_commit_ms: null },
    ]);
    assert.deepEqual(aaa.files_modified, ['hooks/gate.mjs', 'scripts/tool.sh', '~/.claude/settings.json']);
    assert.equal(aaa.dropped_paths, 1);
    assert.deepEqual(aaa.commits.map((c) => c.author_ms), ['T0', 'T1', 'T2', 'T3'].map(goldenMs));
    assert.deepEqual(aaa.commits[2].files, [{ path: 'hooks/gate.mjs', status: 'A' }, { path: 'scripts/tool.sh', status: 'M' }]);
    assert.deepEqual(aaa.commits[0].files.map((f) => f.status), ['A', 'A']);
    for (const c of aaa.commits) assert.match(c.sha, /^[0-9a-f]{40}$/);
  });

  it('reads PLAN, SUMMARY and PROBES-SKIPPED letters of one closing commit, and a frontmatter tier commit time', () => {
    const bbb = rows.find((r) => keyOf(r) === 'gamma/quick/261021-bbb');
    const d = bbb.dir_rel;
    const t4 = goldenMs('T4');
    assert.deepEqual(bbb.artifacts, [
      { role: 'plan', rel_path: `${d}/261021-bbb-PLAN.md`, tier_letter: 'A', tier_place: 'frontmatter', first_commit_ms: t4, tier_commit_ms: t4 },
      { role: 'probes-skipped', rel_path: `${d}/261021-bbb-PROBES-SKIPPED.md`, tier_letter: 'C', tier_place: 'probes-line', first_commit_ms: t4, tier_commit_ms: null },
      { role: 'summary', rel_path: `${d}/261021-bbb-SUMMARY.md`, tier_letter: 'C', tier_place: 'frontmatter', first_commit_ms: t4, tier_commit_ms: t4 },
    ]);
    assert.equal(bbb.files_modified, null);
  });

  it('a phase plan is matched by its id in parentheses only, and only plan and summary roles are looked for', () => {
    const p = rows.find((r) => keyOf(r) === 'gamma/plan/03-01');
    assert.equal(p.dir_rel, '.planning/phases/03-alpha');
    assert.deepEqual(p.artifacts.map((a) => a.role), ['plan']);
    assert.equal(p.artifacts[0].tier_letter, 'A');
    assert.equal(p.artifacts[0].tier_commit_ms, goldenMs('P0'));
    assert.deepEqual(p.commits.map((c) => c.author_ms), [goldenMs('P0'), goldenMs('P1')]);
  });

  it('an untracked .planning gives null commit times and an empty commit list with git ok', () => {
    const c = rows.find((r) => keyOf(r) === 'delta/quick/261022-ccc');
    assert.equal(c.git, 'ok');
    assert.deepEqual(c.commits, []);
    assert.deepEqual(c.artifacts, [{
      role: 'plan', rel_path: `${c.dir_rel}/261022-ccc-PLAN.md`, tier_letter: 'B', tier_place: 'frontmatter', first_commit_ms: null, tier_commit_ms: null,
    }]);
  });

  it('holds no file text, commit subject, identity or absolute path (D-24)', () => {
    assert.ok(text.length > 0, 'the snapshot was written');
    const realHome = realpathSync(ctx.home);
    for (const needle of [ctx.home, realHome, GOLDEN_PLANTS.body, GOLDEN_PLANTS.reason, GOLDEN_PLANTS.subject,
      GOLDEN_PLANTS.contextLine, GOLDEN_PLANTS.summaryBody, 'fixture', 'Rigor', '/srv/shared']) {
      assert.ok(!text.includes(needle), 'a planted or forbidden string reached the snapshot');
    }
    const paths = [];
    for (const r of rows) {
      if (!r.located) continue;
      paths.push(r.dir_rel, ...r.artifacts.map((a) => a.rel_path), ...(r.files_modified ?? []));
      for (const c of r.commits ?? []) paths.push(...c.files.map((f) => f.path));
    }
    for (const p of paths) {
      assert.ok(!p.startsWith('/') && !p.startsWith('./') && !p.split('/').includes('..'), 'a path is absolute or not normalized');
    }
    for (const s of strings(rows)) assert.ok(!s.includes(ctx.home), 'the HOME path leaked');
  });

  it('scores the written file against the fixture labels with the pure tier and timing rules', async () => {
    const { predict, scoreGolden, unitKeyOf } = await scoreModule();
    const score = scoreGolden({ labels: fx.labels, inputs: rows });
    assert.equal(score.units, fx.expected.score.units);
    assert.equal(score.located, fx.expected.score.located);
    assert.deepEqual([score.tierValue.hit, score.tierValue.n], fx.expected.score.tierValue);
    assert.deepEqual([score.tierTiming.hit, score.tierTiming.n], fx.expected.score.tierTiming);
    for (const r of rows.filter((x) => x.located)) {
      const p = predict(r, {});
      const want = fx.expected.predictions[unitKeyOf(r)];
      assert.deepEqual(
        { tier: p.tier, tier_signal: p.tier_signal, tier_timing: p.tier_timing, tier_conflict: p.tier_conflict },
        want,
        unitKeyOf(r),
      );
      assert.equal(p.tier_native, want.tier);
    }
  });

  it('a second run on unchanged repos writes a byte-identical file', () => {
    const again = join(ctx.home, 'out', 'again.jsonl');
    const r = runScript(['--manifest', fx.manifest, '--out', again, fx.gamma, fx.delta], ctx.home);
    assert.equal(r.status, 0);
    assert.ok(existsSync(again));
    assert.equal(readFileSync(again, 'utf8'), text);
  });

  it('usage errors exit 2 with one stderr line holding no path, and write nothing', () => {
    const plain = join(ctx.home, 'plain');
    mkdirSync(plain, { recursive: true });
    const badManifest = join(ctx.home, 'golden', 'bad-manifest.json');
    writeFileSync(badManifest, JSON.stringify({ schema: 'rigorscope.golden-manifest/1', units: [{ repo: 'gamma', kind: 'quick', native_id: '../x' }] }));
    let n = 0;
    const cases = [
      (o) => ['--bogus', '--manifest', fx.manifest, '--out', o, fx.gamma],
      () => ['--manifest', fx.manifest, fx.gamma],
      (o) => ['--manifest', fx.manifest, '--out', o],
      (o) => ['--manifest', fx.manifest, '--out', o, fx.gamma, fx.gamma],
      (o) => ['--manifest', fx.manifest, '--out', o, plain],
      (o) => ['--manifest', badManifest, '--out', o, fx.gamma],
    ];
    for (const make of cases) {
      n += 1;
      const o = join(ctx.home, 'out', `usage-${n}.jsonl`);
      const r = runScript(make(o), ctx.home);
      assert.equal(r.status, 2, `case ${n} exits 2`);
      assert.equal(linesOf(r.stderr).length, 1, `case ${n} prints one stderr line`);
      assert.ok(!r.stderr.includes(ctx.home) && !r.stderr.includes('/'), `case ${n} stderr holds no path`);
      assert.ok(!existsSync(o), `case ${n} wrote no file`);
    }
  });

  it('a touched path holding the HOME user name as a word, or free text, is dropped and counted (D-24)', () => {
    const nx = buildNameLeakRepo({ parent: join(ctx.home, 'nest'), userName: PLANTS.osUser });
    const o = join(ctx.home, 'out', 'names.jsonl');
    const r = runScript(['--manifest', nx.manifest, '--out', o, nx.theta], nx.home);
    assert.equal(r.status, 0);
    assert.deepEqual(linesOf(r.stdout), ['golden-inputs: units=1 located=1 repos=1 not_found=0 repo_not_given=0 dropped_paths=3']);
    const written = readFileSync(o, 'utf8');
    assert.ok(!written.toLowerCase().includes(PLANTS.osUser.toLowerCase()), 'the user name reached the snapshot');
    assert.ok(!written.includes('hand-edited') && !written.includes('  '), 'free text reached the snapshot');
    const row = JSON.parse(written);
    assert.deepEqual(row.files_modified, ['docs/notes.md']);
    assert.deepEqual(row.commits[0].files.map((f) => f.path), ['.planning/quick/261026-uuu-names/261026-uuu-PLAN.md', 'docs/notes.md']);
    assert.equal(row.dropped_paths, 3);
  });
});
