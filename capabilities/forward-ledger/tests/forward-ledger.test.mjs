// forward-ledger.test.mjs - node:test suite for the capability capabilities/forward-ledger (plan 03-02, LEDG-01, LEDG-04,
// LEDG-07; CONTEXT D-08, D-09 (revised), D-10, D-10a, D-11; RESEARCH Q1, Q2, Q5).
//
// The capability turns the forward ledger on for a project: two step skills (execute:wave:pre -> start,
// execute:wave:post -> close) and one plan:pre planner contribution that asks the quick planner to put the unit-start
// and unit-close commands in the PLAN's first and last task. There is no execute:post step (removed 2026-11-04 after
// review H1/M1: it fires once per phase and, for quick, only under --full). It is default off (activation key
// forward_ledger.enabled) and is switched on per project in .planning/config.json.
//
// SECTIONS (every test name starts with its case id and a space, so --test-name-pattern '^I' selects a section):
//   F  the manifest and the three texts (static, always run).
//   I  install, render, landing and a real CLI call through the installed gsd-tools in a mkdtemp world (HOME,
//      GSD_HOME and CLAUDE_CONFIG_DIR all inside it). The ledger file under the real GSD_HOME is asserted unchanged when
//      GSD_HOME is set. An I case is skipped, visibly and with its reason, when the installed gsd-tools is absent (rigorscope
//      has users who do not run GSD); the F cases, and so the token cap, run everywhere.
//
// gsd-tools: GSD_CORE_DIR, else CLAUDE_CONFIG_DIR joined with gsd-core, then bin/gsd-tools.cjs (resolved before any HOME
// override); with neither variable set the I cases skip and name both. The local-skills landing script is named only by
// RIGORSCOPE_LOCAL_SKILLS_SCRIPT; I3 and I4 run a COPY of it with the allow-list extended, in the world only, and skip,
// naming the variable, when it is unset or the file is absent.
//
// Run: node --test capabilities/forward-ledger/tests/forward-ledger.test.mjs
// Node built-ins plus the repo's own fixtures. Plain ASCII.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildUnitsHome, UNITS_EXPECTED } from '../../../test/fixtures/units-home.mjs';
import { runCli, cliEnv } from '../../../test/fixtures/build.mjs';
import { unitKeyOf } from '../../../src/units/unit-key.mjs';
import { options as startOptions } from '../../../src/commands/unit-start.mjs';
import { options as closeOptions } from '../../../src/commands/unit-close.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAP_SRC = path.resolve(HERE, '..');
const MANIFEST_REL = 'capability.json';
const FRAGMENT_REL = path.join('fragments', 'plan-pre-quick-unit.md');
const START_REL = path.join('skills', 'forward-ledger-start', 'SKILL.md');
const CLOSE_REL = path.join('skills', 'forward-ledger-close', 'SKILL.md');
const MANIFEST = path.join(CAP_SRC, MANIFEST_REL);
const FRAGMENT = path.join(CAP_SRC, FRAGMENT_REL);
const START = path.join(CAP_SRC, START_REL);
const CLOSE = path.join(CAP_SRC, CLOSE_REL);
const CAP_ID = 'forward-ledger';
const STEMS = ['forward-ledger-start', 'forward-ledger-close'];

const REAL_HOME = os.homedir();
function coreDir(env) {
  if (env.GSD_CORE_DIR) return env.GSD_CORE_DIR;
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'gsd-core') : null;
}
const CORE_DIR = coreDir(process.env);
const GSD_TOOLS = CORE_DIR ? path.join(CORE_DIR, 'bin', 'gsd-tools.cjs') : null;
// The real ledger is only known when the operator names the real GSD_HOME; otherwise the unchanged-ledger check compares 'unset'.
const REAL_LEDGER = process.env.GSD_HOME ? path.join(process.env.GSD_HOME, '.gsd-capabilities.json') : null;
const LOCAL_SKILLS_SCRIPT = process.env.RIGORSCOPE_LOCAL_SKILLS_SCRIPT || null;

const I_SKIP = GSD_TOOLS && fs.existsSync(GSD_TOOLS) ? false : 'installed gsd-tools not found; set GSD_CORE_DIR or CLAUDE_CONFIG_DIR';
const SCRIPT_SKIP = LOCAL_SKILLS_SCRIPT && fs.existsSync(LOCAL_SKILLS_SCRIPT) ? false : 'local-skills script not found; set RIGORSCOPE_LOCAL_SKILLS_SCRIPT';
const I3_SKIP = I_SKIP && SCRIPT_SKIP ? `${I_SKIP}; ${SCRIPT_SKIP}` : I_SKIP || SCRIPT_SKIP;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ledgerSha = () => (REAL_LEDGER === null ? 'unset' : fs.existsSync(REAL_LEDGER) ? sha(fs.readFileSync(REAL_LEDGER)) : 'absent');

const tempDirs = [];
function mkTemp(tag) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-' + tag + '-')));
  tempDirs.push(d);
  return d;
}
after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function readText(p) {
  assert.ok(fs.existsSync(p), `missing file: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

// ---------- the texts the agent receives ----------

// The closed set of command lines: a backtick span that starts with `rigorscope unit-start` or `rigorscope unit-close`.
const UNIT_SPAN_RE = /`(rigorscope unit-(?:start|close)[^`\n]*)`/g;
export function unitCommands(text) {
  return [...text.matchAll(UNIT_SPAN_RE)].map((m) => m[1]);
}
const OPTIONS = { 'unit-start': startOptions, 'unit-close': closeOptions };

// Parse one command line through the real option table of the command it names (strict: an unknown flag throws).
function parseUnitCommand(line, replacements = {}) {
  let text = line;
  for (const [k, v] of Object.entries(replacements)) text = text.split(k).join(v);
  const tokens = text.split(' ');
  assert.equal(tokens[0], 'rigorscope', `command line does not start with rigorscope: ${line}`);
  const name = tokens[1];
  assert.ok(OPTIONS[name], `not a unit command: ${line}`);
  const parsed = parseArgs({ args: tokens.slice(2), options: OPTIONS[name], strict: true, allowPositionals: false });
  return { name, tokens: tokens.slice(1), values: parsed.values };
}

// ---------- the spike verdict (D-09 b, plan 03-02 task 4) ----------

const SPIKE = path.resolve(CAP_SRC, '..', '..', '.planning', 'phases', '03-forward-ledger-and-populations', '03-02-SPIKE.md');
// 'PASS' or 'FAIL' from a line `Verdict: PASS|FAIL` (optionally bold) of the SPIKE file; null when the file or the line is absent.
export function spikeVerdict() {
  if (!fs.existsSync(SPIKE)) return null;
  const m = /^\*{0,2}Verdict:?\*{0,2}\s*(PASS|FAIL)\b/m.exec(fs.readFileSync(SPIKE, 'utf8'));
  return m ? m[1] : null;
}

// ---------- F: manifest ----------

test('F1 capability.json is ASCII, default off, hooks empty, two steps at the right points (none at execute:post) and one planner contribution', () => {
  const buf = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST) : null;
  assert.ok(buf, `missing manifest: ${MANIFEST}`);
  assert.equal(buf.findIndex((b) => b > 0x7f), -1, 'manifest has a non-ASCII byte');
  const m = JSON.parse(buf.toString('utf8'));
  assert.equal(m.id, CAP_ID);
  assert.equal(m.role, 'feature');
  assert.equal(m.version, '0.1.0');
  assert.equal(m.tier, 'full');
  assert.deepEqual(m.engines, { gsd: '>=1.15.0' });
  assert.deepEqual(m.runtimeCompat, { supported: ['*'], unsupported: [] });
  assert.deepEqual(m.skills, STEMS);
  assert.deepEqual(m.hooks, [], 'LEDG-01: the capability installs no hook');
  assert.deepEqual(m.agents, []);
  assert.deepEqual(m.gates, []);
  assert.equal(m.activationKey, 'forward_ledger.enabled');
  assert.deepEqual(Object.keys(m.config), ['forward_ledger.enabled']);
  assert.equal(m.config['forward_ledger.enabled'].type, 'boolean');
  assert.equal(m.config['forward_ledger.enabled'].default, false, 'D-11: default off, no global switch');
  // D-09 (revised): exactly two steps, none at execute:pre (gsd-core#5848) and none at execute:post (review H1/M1),
  // skill refs without the gsd- prefix (RESEARCH Q1).
  const points = m.steps.map((s) => `${s.point}=${s.ref.skill}`).sort();
  assert.deepEqual(points, [
    'execute:wave:post=forward-ledger-close',
    'execute:wave:pre=forward-ledger-start',
  ]);
  for (const s of m.steps) {
    assert.notEqual(s.point, 'execute:pre');
    assert.notEqual(s.point, 'execute:post');
    assert.ok(!s.ref.skill.startsWith('gsd-'), `step ref ${s.ref.skill} starts with gsd-`);
    assert.deepEqual(Object.keys(s.ref), ['skill']);
    assert.deepEqual(s.produces, []);
    assert.deepEqual(s.consumes, []);
    assert.equal(s.onError, 'skip');
  }
  // One contribution, at plan:pre into planner; none at an execute point (the validator rejects it, RESEARCH Q1.1).
  // When the quick spike recorded FAIL (D-09 b, F5) the contribution is removed and there are none.
  assert.ok(!m.contributions.some((x) => x.point.startsWith('execute:')), 'a contribution at an execute point');
  if (spikeVerdict() === 'FAIL') {
    assert.deepEqual(m.contributions, []);
    return;
  }
  assert.equal(m.contributions.length, 1);
  const c = m.contributions[0];
  assert.equal(c.point, 'plan:pre');
  assert.equal(c.into, 'planner');
  assert.deepEqual(c.fragment, { path: 'fragments/plan-pre-quick-unit.md' });
  assert.equal(c.onError, 'skip');
});

// ---------- I: install, render, landing, real CLI ----------

function newWorld(config = {}) {
  const w = mkTemp('world');
  fs.mkdirSync(path.join(w, 'fake-home', '.claude'), { recursive: true });
  fs.mkdirSync(path.join(w, 'proj', '.planning'), { recursive: true });
  fs.writeFileSync(path.join(w, 'proj', '.planning', 'config.json'), JSON.stringify(config) + '\n');
  return w;
}
function setConfig(w, config) {
  fs.writeFileSync(path.join(w, 'proj', '.planning', 'config.json'), JSON.stringify(config) + '\n');
}
function worldEnv(w) {
  return {
    ...process.env,
    HOME: path.join(w, 'fake-home'),
    GSD_HOME: path.join(w, 'fake-home'),
    CLAUDE_CONFIG_DIR: path.join(w, 'fake-home', '.claude'),
    GSD_CORE_DIR: CORE_DIR,
  };
}
// Pre-flight: every directory a child could write to is inside the world, never the real home.
function assertIsolated(w, env) {
  for (const k of ['HOME', 'GSD_HOME', 'CLAUDE_CONFIG_DIR']) {
    assert.ok(env[k] === w || env[k].startsWith(w + path.sep), `${k} is not inside the world`);
    assert.notEqual(env[k], REAL_HOME, `${k} is the real home`);
  }
}
const show = (res) => `exit=${res.status} stdout=${JSON.stringify((res.stdout || '').slice(0, 800))} stderr=${JSON.stringify((res.stderr || '').slice(0, 400))}`;
function gsd(w, args) {
  const env = worldEnv(w);
  assertIsolated(w, env);
  return spawnSync(process.execPath, [GSD_TOOLS, ...args], {
    cwd: path.join(w, 'proj'), env, encoding: 'utf8', timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
}
function install(w) {
  const res = gsd(w, ['capability', 'install', CAP_SRC, '--scope', 'global', '--yes']);
  assert.equal(res.status, 0, `capability install failed: ${show(res)}`);
  assert.equal(JSON.parse(res.stdout).status, 'installed', show(res));
  return path.join(w, 'fake-home', '.gsd', 'capabilities', CAP_ID);
}
function entries(w, point) {
  const res = gsd(w, ['loop', 'render-hooks', point, '--raw']);
  assert.equal(res.status, 0, `render-hooks ${point} failed: ${show(res)}`);
  const parsed = JSON.parse(res.stdout);
  assert.ok(Array.isArray(parsed.activeHooks), `no activeHooks: ${show(res)}`);
  return parsed.activeHooks.filter((h) => h && h.capId === CAP_ID);
}
const POINTS = ['execute:wave:pre', 'execute:wave:post', 'execute:post', 'plan:pre'];

test('I1 install into a throwaway world exits 0, leaves the real ledger alone, and renders nothing with the key unset or false', { skip: I_SKIP }, () => {
  const ledgerBefore = ledgerSha();
  const w = newWorld();
  const dest = install(w);
  for (const f of [MANIFEST_REL, FRAGMENT_REL, START_REL, CLOSE_REL]) {
    assert.ok(fs.existsSync(path.join(dest, f)), `installed bundle lacks ${f}`);
  }
  for (const p of POINTS) assert.deepEqual(entries(w, p), [], `${p}: an entry with the key unset`);
  setConfig(w, { forward_ledger: { enabled: false } });
  for (const p of POINTS) assert.deepEqual(entries(w, p), [], `${p}: an entry with the key false`);
  assert.equal(ledgerSha(), ledgerBefore, 'the real ~/.gsd-capabilities.json changed');
});

test('I2 with the key true the wave points and plan:pre list the capability once and execute:post lists it not at all', { skip: I_SKIP }, () => {
  const w = newWorld();
  install(w);
  setConfig(w, { forward_ledger: { enabled: true } });
  const got = Object.fromEntries(POINTS.map((p) => [p, entries(w, p)]));
  assert.deepEqual(POINTS.map((p) => got[p].length), [1, 1, 0, 1], JSON.stringify(got));
  assert.equal(got['execute:wave:pre'][0].kind, 'step');
  assert.deepEqual(got['execute:wave:pre'][0].ref, { skill: 'forward-ledger-start' });
  assert.equal(got['execute:wave:post'][0].kind, 'step');
  assert.deepEqual(got['execute:wave:post'][0].ref, { skill: 'forward-ledger-close' });
  assert.equal(got['plan:pre'][0].kind, 'contribution');
  assert.equal(got['plan:pre'][0].into, 'planner');
  assert.equal(got['plan:pre'][0].fragment && got['plan:pre'][0].fragment.inline, readText(FRAGMENT));
});

// Land the skills in the world with a COPY of the real local landing script whose ALLOW line also names forward-ledger.
const ALLOW_BASE = "const ALLOW = ['refute-pass'];";
const ALLOW_EXT = "const ALLOW = ['refute-pass', 'forward-ledger'];";
function patchedScript(w) {
  const src = readText(LOCAL_SKILLS_SCRIPT);
  let out;
  // The installed script may name more capabilities than this test knows (the list grows); any ALLOW line that already
  // names forward-ledger is used as is.
  if (src.includes(ALLOW_EXT) || /const ALLOW = \[[^\]]*'forward-ledger'[^\]]*\];/.test(src)) out = src;
  else {
    assert.ok(src.includes(ALLOW_BASE), 'the local landing script has an ALLOW line this test does not know');
    out = src.replace(ALLOW_BASE, ALLOW_EXT);
  }
  const copy = path.join(w, 'landing-copy.sh');
  fs.writeFileSync(copy, out, { mode: 0o755 });
  return copy;
}
function runLanding(w, script, mode) {
  const env = worldEnv(w);
  assertIsolated(w, env);
  return spawnSync('bash', [script, mode], { env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
const skillsDir = (w) => path.join(w, 'fake-home', '.claude', 'skills');

test('I3 a copy of the local landing script with the allow-list extended lands both skills byte-equal, idempotently, and reverts by archiving', { skip: I3_SKIP }, () => {
  const w = newWorld();
  install(w);
  const script = patchedScript(w);
  const applied = runLanding(w, script, '--apply');
  assert.equal(applied.status, 0, show(applied));
  for (const stem of STEMS) {
    assert.match(applied.stdout, new RegExp(`landed gsd-${stem}`), show(applied));
    const dir = path.join(skillsDir(w), `gsd-${stem}`);
    assert.equal(sha(fs.readFileSync(path.join(dir, 'SKILL.md'))), sha(fs.readFileSync(path.join(CAP_SRC, 'skills', stem, 'SKILL.md'))), `${stem}: landed sha differs from the repo source`);
    assert.equal(fs.readFileSync(path.join(dir, '.gsd-capability-skill'), 'utf8'), CAP_ID + '\n');
  }
  const before = fs.readdirSync(skillsDir(w)).sort();
  const again = runLanding(w, script, '--apply');
  assert.equal(again.status, 0, show(again));
  assert.doesNotMatch(again.stdout, /landed/, 'a second apply changed something');
  assert.deepEqual(fs.readdirSync(skillsDir(w)).sort(), before);
  const check = runLanding(w, script, '--check');
  assert.equal(check.stdout.trimEnd().split('\n').pop().replace(/^[^:]*: /, ''), 'in sync', show(check));
  // --revert is proven in the world only: it would also archive the refute-pass skill on a real machine (plan 03-02 J11).
  const reverted = runLanding(w, script, '--revert');
  assert.equal(reverted.status, 0, show(reverted));
  assert.deepEqual(fs.readdirSync(skillsDir(w)).filter((n) => n.startsWith('gsd-forward-ledger')), [], 'revert left a skill dir');
  const archive = path.join(w, 'fake-home', '.claude', 'backups');
  const archived = fs.readdirSync(archive).flatMap((d) => fs.readdirSync(path.join(archive, d)));
  assert.deepEqual(archived.filter((n) => n.startsWith('gsd-forward-ledger')).sort(), STEMS.map((s) => `gsd-${s}`).sort());
});

test('I4 every command line in the landed skills and fragment parses through the real options and runs from a linked work tree', { skip: I3_SKIP }, () => {
  const w = newWorld();
  const dest = install(w);
  runLanding(w, patchedScript(w), '--apply');
  const texts = {
    start: readText(path.join(skillsDir(w), 'gsd-forward-ledger-start', 'SKILL.md')),
    close: readText(path.join(skillsDir(w), 'gsd-forward-ledger-close', 'SKILL.md')),
    fragment: readText(path.join(dest, FRAGMENT_REL)),
  };
  const home = mkTemp('home');
  const fx = buildUnitsHome({ home });
  const ids = { '<plan id>': '03-01', '<quick id>': '261030-a1b' };
  const lines = [...unitCommands(texts.start), ...unitCommands(texts.close), ...unitCommands(texts.fragment)];
  assert.ok(lines.length >= 4, `expected at least 4 command lines, got ${lines.length}`);
  const expectKeys = [];
  for (const line of lines) {
    const { name, tokens, values } = parseUnitCommand(line, ids);
    const res = runCli(tokens, { home, cwd: fx.worktree, env: cliEnv(home) });
    assert.equal(res.status, 0, `${line}: ${show(res)}`);
    const key = unitKeyOf(UNITS_EXPECTED.keys.alpha, values.kind, values.id);
    assert.equal(res.stdout.trim(), `ledger: ${name === 'unit-start' ? 'start' : 'close'} ${key}`);
    if (name === 'unit-close') assert.equal(values.status, 'complete', `${line}: a close line must say --status complete`);
    expectKeys.push(key);
  }
  const ledger = fs.readFileSync(path.join(home, '.rigorscope', 'ledger', 'units.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ledger.map((l) => l.unit_key), expectKeys);
  const quickStart = ledger.find((l) => l.record === 'start' && l.kind === 'quick');
  assert.equal(quickStart.tier, 'A', 'the tier is read from the quick PLAN frontmatter');
  assert.equal(quickStart.tier_source, 'plan-at-start');
  assert.equal(quickStart.command, 'quick');
});

// ---------- F: the three texts (static, LEDG-04, LEDG-07, D-10, T-03-07) ----------

const FALLBACK = 'rigorscope not installed: unit not recorded';
const TEXTS = () => ({ start: readText(START), close: readText(CLOSE), fragment: readText(FRAGMENT) });
const bytesOf = (...ts) => ts.reduce((n, t) => n + Buffer.byteLength(t, 'utf8'), 0);

// D-10 / LEDG-07: the estimate is characters / 4, the estimator gsd-core's own prompt-budget uses; the cap is about 300,
// asserted at 300 exactly. Whole files, frontmatter included (plan 03-02 J4). The engine's own dispatch line per step is not counted.
export const TOKEN_CAP = 300;
export const estimateTokens = (chars) => chars / 4;
export const overCap = (chars) => estimateTokens(chars) > TOKEN_CAP;
// The two rendered kinds (J4): a plan unit renders the start and the close skill; a quick unit renders the planner
// fragment alone (there is no execute:post step, so the close skill is never rendered for a quick task).
export function kinds({ start, close, fragment }) {
  return {
    plan: bytesOf(start, close),
    'quick-planner': bytesOf(fragment),
  };
}

test('F2 the text rendered per unit is at most 300 estimated tokens for each of the two kinds, and the helper enforces the cap', () => {
  assert.equal(overCap(1204), true, 'a 1204-character string must report over the cap');
  assert.equal(overCap(1200), false, 'a 1200-character string is at the cap');
  const sizes = kinds(TEXTS());
  for (const [kind, chars] of Object.entries(sizes)) {
    assert.ok(!overCap(chars), `${kind}: ${chars} chars = ${estimateTokens(chars)} estimated tokens (chars / 4), cap ${TOKEN_CAP}`);
  }
});

function frontmatterOf(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'no frontmatter');
  return Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
}

test('F3 each text carries the fallback sentence verbatim and tells the agent to continue; skill descriptions are at most 120 characters', () => {
  const t = TEXTS();
  for (const [name, text] of Object.entries(t)) {
    assert.ok(text.includes(FALLBACK), `${name}: lacks the fallback sentence`);
    assert.ok(text.includes('Non-zero exit: continue, never retry'), `${name}: lacks the phrase "Non-zero exit: continue, never retry"`);
  }
  for (const [name, stem] of [['start', STEMS[0]], ['close', STEMS[1]]]) {
    const fm = frontmatterOf(t[name]);
    assert.equal(fm.name, `gsd-${stem}`);
    assert.ok(fm.description.length > 0 && fm.description.length <= 120, `${name}: description has ${fm.description.length} characters`);
  }
});

// Spans that are not commands but may appear in backticks: the planner Mode literals and the frontmatter key.
const PLAIN_SPANS = new Set(['**Mode:** quick', '**Mode:** quick-full', ' (revision)', 'tier:']);
const PLACEHOLDERS = new Set(['<plan id>', '<quick id>']);
// T-03-07: patterns that must never reach the agent. They live here only, never in a skill text.
const FORBIDDEN = [
  ['command substitution', /\$\(/], ['backtick pipe or pipe', /\|/], ['semicolon', /;/], ['and-chain', /&&/], ['curl', /\bcurl\b/i],
  ['sudo', /\bsudo\b/i], ['rm', /\brm\s/], ['url', /https?:|\bwww\./i], ['variable expansion', /\$[A-Za-z_{]/], ['redirect', /[<>]\s*\/|\s>\s/],
];

test('F4 the closed surface: ASCII, only unit-start/unit-close lines through the real options, no other command, pipe, substitution, URL or placeholder', () => {
  for (const [name, text] of Object.entries(TEXTS())) {
    const buf = Buffer.from(text, 'utf8');
    assert.equal(buf.findIndex((b) => b > 0x7f), -1, `${name}: non-ASCII byte`);
    for (const [what, re] of FORBIDDEN) assert.doesNotMatch(text, re, `${name}: ${what}`);
    // Every line that starts with rigorscope (bare, not in a span) is a unit command or the fallback sentence.
    for (const l of text.split('\n')) {
      const trimmed = l.replace(/^[-*\s]+/, '');
      if (trimmed.startsWith('rigorscope ') && trimmed !== FALLBACK) parseUnitCommand(trimmed.replace(/\.$/, ''), { '<plan id>': '03-01', '<quick id>': '261030-a1b' });
    }
    // Every backtick span is a unit command (parsed strict), the fallback sentence, or a plain span from the closed list.
    const spans = [...text.matchAll(/`([^`\n]*)`/g)].map((m) => m[1]);
    assert.equal((text.match(/`/g) || []).length % 2, 0, `${name}: unbalanced backticks`);
    for (const s of spans) {
      if (s === FALLBACK || PLAIN_SPANS.has(s)) continue;
      assert.ok(/^rigorscope unit-(start|close) /.test(s), `${name}: backtick span is not a unit command: ${s}`);
      parseUnitCommand(s, { '<plan id>': '03-01', '<quick id>': '261030-a1b' });
    }
    // Placeholders: only the closed set.
    for (const ph of text.match(/<[^>\n]*>/g) || []) assert.ok(PLACEHOLDERS.has(ph), `${name}: placeholder ${ph} is outside the closed set`);
  }
  // Each text holds the commands it is for (guards the extractor against matching nothing).
  const t = TEXTS();
  assert.deepEqual(unitCommands(t.start).map((l) => l.split(' ')[1]), ['unit-start']);
  assert.deepEqual(unitCommands(t.close).map((l) => l.split(' ')[1]), ['unit-close']);
  assert.deepEqual(unitCommands(t.fragment).map((l) => l.split(' ')[1]), ['unit-start', 'unit-close']);
  // The start skill uses plan-at-start and no --tier (the CLI rejects the pair); the quick start does the same.
  for (const line of [...unitCommands(t.start), ...unitCommands(t.fragment).slice(0, 1)]) {
    const { values } = parseUnitCommand(line, { '<plan id>': '03-01', '<quick id>': '261030-a1b' });
    assert.equal(values['tier-source'], 'plan-at-start', line);
    assert.equal(values.tier, undefined, line);
  }
});

// Review M3: the load-bearing prose guards. Each assertion fails when its phrase is deleted or changed.
test('F6 the guard phrases of the three texts are present (status, SUMMARY.md, wave that just finished, earlier-wave no-op, Mode guard, copy clause, id shape)', () => {
  const t = TEXTS();
  // close skill
  const close = t.close;
  assert.ok(unitCommands(close).every((l) => /(^| )--status complete( |$)/.test(l)), 'close: the close command must carry --status complete');
  assert.ok(close.includes('has a SUMMARY.md'), 'close: lacks the SUMMARY.md condition (J10)');
  assert.ok(close.includes('wave that just finished'), 'close: lacks "wave that just finished"');
  assert.ok(close.includes('For a plan of an earlier wave, run nothing'), 'close: lacks the earlier-wave no-op clause');
  assert.ok(!close.includes('quick'), 'close: still mentions a quick task (there is no execute:post step)');
  // id shape clause (L1), start and close
  for (const name of ['start', 'close']) assert.ok(t[name].includes('(digits, hyphen, dot only'), `${name}: lacks the id-shape clause (L1)`);
  // start skill
  assert.ok(t.start.includes('of this wave'), 'start: lacks "of this wave"');
  // fragment
  const frag = t.fragment;
  assert.ok(frag.startsWith('Only if the Mode line is exactly `**Mode:** quick` or `**Mode:** quick-full`'), 'fragment: lacks the Mode guard on its first line');
  assert.ok(frag.includes(', else ignore.'), 'fragment: the Mode guard lacks "else ignore"');
  assert.ok(frag.includes("Quick id = first 10 chars of the Directory line's last path part"), 'fragment: lacks the quick id rule');
  assert.ok(/Copy each command line and the sentence below verbatim into the action, the sentence right after each of the two commands/.test(frag), 'fragment: lacks the copy clause (M2)');
  assert.ok(/(^| )--status complete( |$)/.test(unitCommands(frag)[1]), 'fragment: the quick close command must carry --status complete');
});

test('F5 the manifest matches the spike verdict recorded in 03-02-SPIKE.md', (t) => {
  const verdict = spikeVerdict();
  const m = JSON.parse(readText(MANIFEST));
  const planPre = m.contributions.filter((c) => c.point === 'plan:pre');
  if (verdict === null) {
    t.diagnostic(`no spike verdict recorded yet (${fs.existsSync(SPIKE) ? 'SPIKE file has no Verdict line' : 'SPIKE file absent'}): the contribution is shipped as designed`);
    return;
  }
  if (verdict === 'FAIL') {
    assert.deepEqual(planPre, [], 'spike FAIL: the plan:pre contribution must be removed from the manifest');
    assert.ok(!fs.existsSync(FRAGMENT), 'spike FAIL: the fragment file must be removed');
  } else {
    assert.equal(planPre.length, 1, 'spike PASS: the plan:pre contribution must exist');
    assert.ok(fs.existsSync(FRAGMENT), 'spike PASS: the fragment file must exist');
  }
});
