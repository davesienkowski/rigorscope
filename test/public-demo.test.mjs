// The public demo: a synthetic fixture built from code, the real CLI over it, and the known answers of
// test/fixtures/public-demo/expected.json (derived by hand before the first CLI run). Includes a mutation case (a changed or
// removed expected value must fail the comparator) and the inherited-environment case of scripts/demo.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BIN, REPO } from './fixtures/build.mjs';
import { buildPublicDemo } from './fixtures/public-demo/build.mjs';
import { check, collect } from './fixtures/public-demo/compare.mjs';

const EXPECTED = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/public-demo/expected.json', import.meta.url)), 'utf8'));
const DEMO = join(REPO, 'scripts', 'demo.mjs');
const SINCE = ['--since', '2026-10-01', '--until', '2026-10-07'];
const made = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'rigorscope-pd-test-'));
  made.push(d);
  return d;
};
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// The clean environment of the public checks: only these variables (the Windows users directory is set empty so a WSL
// host's own Windows transcripts are never discovered).
const cleanEnv = (home) => ({
  PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TZ: 'UTC', RIGORSCOPE_WINDOWS_USERS_DIR: '',
});

function runCli(args, env) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, `rigorscope ${args[0]} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

function runDemo(env) {
  const r = spawnSync(process.execPath, [DEMO], { env, encoding: 'utf8', cwd: REPO, timeout: 170_000 });
  return r;
}

describe('public demo known answers', () => {
  const built = buildPublicDemo({ dir: tempDir() });
  const env = cleanEnv(built.home);
  const ingestLine = (out, name) => out.split('\n').find((l) => l.startsWith(`${name}:`));
  const first = runCli(['ingest'], env);
  built.archive();
  runCli(['ingest'], env);
  const units = JSON.parse(runCli(['units', '--json'], env));
  const cost = JSON.parse(runCli(['cost', ...SINCE, '--by', 'role', '--json'], env));
  const actual = collect({ units, cost });

  it('reads only the fixture transcripts (clean environment)', () => {
    assert.match(ingestLine(first, 'transcript'), /^transcript: files=5 new=5 /);
  });

  it('matches expected.json value by value and covers every declared value', () => {
    const result = check(EXPECTED, actual);
    assert.deepEqual(result.mismatches, []);
    assert.equal(EXPECTED.declared_values, Object.keys(EXPECTED.values).length);
    assert.ok(result.compared >= EXPECTED.declared_values, `compared ${result.compared} of ${EXPECTED.declared_values}`);
    assert.equal(result.ok, true);
  });

  it('every derivation field is a non-empty string', () => {
    for (const [key, v] of Object.entries(EXPECTED.values)) {
      assert.ok(typeof v.derivation === 'string' && v.derivation.length >= 3, `derivation of ${key}`);
    }
  });

  it('mutation: one changed value fails the comparator', () => {
    const copy = structuredClone(EXPECTED);
    copy.values['cost.d1a.usd_nano'].value += 1;
    const result = check(copy, actual);
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, ['cost.d1a.usd_nano']);
  });

  it('mutation: one removed key fails the coverage check', () => {
    const copy = structuredClone(EXPECTED);
    delete copy.values['total.tokens'];
    const result = check(copy, actual);
    assert.equal(result.ok, false);
    assert.ok(result.compared < result.declared);
  });

  it('mutation: a changed string value fails the comparator', () => {
    const copy = structuredClone(EXPECTED);
    copy.values['tier.d3c'].value = 'A';
    assert.deepEqual(check(copy, actual).mismatches, ['tier.d3c']);
  });
});

describe('npm run demo (scripts/demo.mjs)', () => {
  it('exits 0 in a clean environment and prints the known answers', () => {
    const home = tempDir();
    const r = runDemo({ PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TZ: 'UTC' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /transcript: files=5 /);
    assert.match(r.stdout, /units: n=4 quick=4 /);
    assert.match(r.stdout, new RegExp(`Known answers .*: ${EXPECTED.declared_values} of ${EXPECTED.declared_values} match`));
    assert.match(r.stdout, /escape and rework print "unavailable"/);
  });

  it('ignores inherited configuration variables that point at planted data', () => {
    const planted = tempDir();
    const marker = 'plantedmarker';
    const dirs = {};
    for (const name of ['claude', 'repos', 'telemetry', 'xdg', 'gsd']) {
      dirs[name] = join(planted, name);
      mkdirSync(join(dirs[name], 'projects', `-${name}-${marker}`), { recursive: true });
      const line = {
        type: 'assistant', sessionId: `${marker}-${name}`, timestamp: '2026-10-03T10:00:00.000Z', cwd: dirs[name],
        message: {
          id: `msg_${marker}_${name}`, role: 'assistant', model: `claude-${marker}-model`, content: [{ type: 'text', text: marker }],
          usage: { input_tokens: 7777, output_tokens: 7777, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      };
      writeFileSync(join(dirs[name], 'projects', `-${name}-${marker}`, `${marker}.jsonl`), `${JSON.stringify(line)}\n`);
      writeFileSync(join(dirs[name], `events-${marker}.jsonl`), `${JSON.stringify(line)}\n`);
    }
    const r = runDemo({
      PATH: process.env.PATH,
      HOME: tempDir(),
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      CLAUDE_CONFIG_DIR: dirs.claude,
      RIGORSCOPE_REPO_ROOTS: dirs.repos,
      HOOK_TELEMETRY_DIR: dirs.telemetry,
      XDG_CONFIG_HOME: dirs.xdg,
      GSD_HOME: dirs.gsd,
      RIGORSCOPE_NOW: '2026-01-01T00:00:00Z',
      RIGORSCOPE_PRICES_DIR: dirs.gsd,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(marker), 'a planted marker reached the output');
    assert.ok(!r.stdout.includes('7777'), 'a planted token count reached the output');
    assert.match(r.stdout, /transcript: files=5 /);
    assert.match(r.stdout, new RegExp(`${EXPECTED.declared_values} of ${EXPECTED.declared_values} match`));
  });
});
