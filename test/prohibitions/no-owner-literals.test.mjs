// Prohibition (plan 01-11, owner constraint of 2026-10-29): no owner- or machine-specific literal in the code
// trees. rigorscope is meant to be packaged for other users, so locations resolve through HOME, the environment
// overrides and the state-directory helpers, never through a literal.
//   rule (a): the runtime OS user name (os.userInfo().username, case-insensitive) appears in no file under src/,
//             test/, bin/, data/ or scripts/ as a whole word or path segment: no letter or digit right before or
//             after it, so 'tim' matches tim, /tim/ and 'tim' but not timeout or optimum (review WR-04). Skipped,
//             visibly, when the name is shorter than 4 characters (as a whole word such a name is an ordinary
//             identifier: max, min, sum) or is one of GENERIC_USER_NAMES (ordinary words in code; the docs scan
//             keeps its own shorter list).
//   rule (b): no absolute-home-path literal (the docs.test.mjs pattern without its drive-letter alternative,
//             which matches ordinary code) in any file under src/, test/ or scripts/, except the ALLOWLIST files,
//             which hold home-shaped literals as normalizer data.
// A tree that does not exist is skipped; node_modules and test/prohibitions/fixtures are never scanned, and this
// file skips itself (its patterns are built from fragments so its own source holds no home-shaped literal).
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a file or directory, resolved against process.cwd(); both rules
// then apply to that subject only, with no allowlist, and the fixture cases are skipped. Failure messages name
// the file and the rule, never the matched text.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const FIXTURES = join(REPO, 'test', 'prohibitions', 'fixtures');

export const GENERIC_USER_NAMES = [
  'root', 'runner', 'ubuntu', 'user', 'test', 'node', 'dev', 'main', 'admin', 'build', 'builder', 'ci', 'github',
  'jenkins', 'docker', 'vagrant', 'nobody', 'default', 'www-data',
];

// Files that hold home-shaped literals as data for the home normalizer, its fixtures and its tests.
export const ALLOWLIST = [
  'src/sources/transcript/home.mjs',
  'test/canary/plants/transcript.mjs',
  'test/fixtures/cases/60-cwd-forms.mjs',
  'test/unit/home-norm.test.mjs',
  'test/unit/transcript-full.test.mjs',
];

// capabilities/ (plan 03-02, J6) holds text that is installed on other machines: the same two rules apply to it.
const USER_TREES = ['src', 'test', 'bin', 'data', 'scripts', 'capabilities'];
const PATH_TREES = ['src', 'test', 'scripts', 'capabilities'];

// Built from fragments: a slash-joined segment list, never a literal in this source.
const seg = (...parts) => ['', ...parts, ''].join('/');
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOME_PATH = new RegExp(
  `(?:^|[\\s\`'"(=:])(?:${[esc(seg('home')), esc(seg('Users')), `${esc(seg('mnt'))}[a-z]${esc(seg('Users'))}`].join('|')})`,
  'm',
);

const userName = userInfo().username;
export const USER_NAME_FLOOR = 4;
export const userExemptReason = (name) => (name.length < USER_NAME_FLOOR
  ? `the OS user name is shorter than ${USER_NAME_FLOOR} characters`
  : GENERIC_USER_NAMES.includes(name.toLowerCase()) ? 'the OS user name is a generic word (GENERIC_USER_NAMES)' : null);
const userExempt = userExemptReason(userName);

function filesUnder(root) {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [root];
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || p === FIXTURES) continue;
        walk(p);
      } else if (e.isFile() && p !== SELF) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

const shown = (p) => relative(REPO, p).split(sep).join('/') || p;
export const hasUserName = (text, name) => new RegExp(`(?<![A-Za-z0-9])${esc(name)}(?![A-Za-z0-9])`, 'i').test(text);

// Returns the list of "<file>: rule (x)" findings for the given files. `user` defaults to the runtime OS user name;
// a test passes an ordinary name instead, so no real name is ever written into a file.
function scan({ userFiles, pathFiles, allow = [], user = userName }) {
  const findings = [];
  if (!userExemptReason(user)) {
    for (const f of userFiles) if (hasUserName(readFileSync(f, 'utf8'), user)) findings.push(`${shown(f)}: rule (a) OS user name`);
  }
  for (const f of pathFiles) {
    if (allow.includes(shown(f))) continue;
    if (HOME_PATH.test(readFileSync(f, 'utf8'))) findings.push(`${shown(f)}: rule (b) absolute home path`);
  }
  return findings;
}

const SUBJECT = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : null;
const fixtureSkip = SUBJECT ? 'GSD_PROHIB_SUBJECT is set: only the subject is scanned' : false;

it(SUBJECT ? 'the subject holds no owner- or machine-specific literal' : 'the default scan of the code trees is clean', (t) => {
  if (userExempt) t.diagnostic(`rule (a) skipped: ${userExempt}`);
  let findings;
  if (SUBJECT) {
    assert.ok(existsSync(SUBJECT), 'the subject exists');
    const files = filesUnder(SUBJECT);
    findings = scan({ userFiles: files, pathFiles: files });
  } else {
    findings = scan({
      userFiles: USER_TREES.flatMap((d) => filesUnder(join(REPO, d))),
      pathFiles: PATH_TREES.flatMap((d) => filesUnder(join(REPO, d))),
      allow: ALLOWLIST,
    });
  }
  assert.deepEqual(findings, []);
});

it('rule (a) detects the runtime OS user name in a file', { skip: fixtureSkip || (userExempt ? `rule (a) skipped: ${userExempt}` : false) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rigorscope-owner-scan-'));
  try {
    const f = join(dir, 'planted.txt');
    writeFileSync(f, `const who = '${userName}';\n`);
    assert.equal(scan({ userFiles: [f], pathFiles: [] }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rule (b) detects the violation fixture', { skip: fixtureSkip }, () => {
  const f = join(FIXTURES, 'owner-literal-violation.txt');
  assert.deepEqual(scan({ userFiles: [], pathFiles: [f] }), [`${shown(f)}: rule (b) absolute home path`]);
});

it('the clean fixture passes both rules', { skip: fixtureSkip }, () => {
  const f = join(FIXTURES, 'owner-literal-clean.txt');
  assert.deepEqual(scan({ userFiles: [f], pathFiles: [f] }), []);
});

// Review WR-04: rule (a) matches the user name as a whole word or a path segment, never inside another word, so a
// developer whose user name is an ordinary short word does not get a red suite for innocent code. The names below
// are injected; none is the runtime OS user name.
it('rule (a) matches the name as a whole word or path segment, not inside another word', () => {
  for (const text of ["const who = 'tim';", 'x/tim/y', ['C:', 'Users', 'tim', 'x'].join('\\'), 'Tim wrote this', 'tim_dev']) {
    assert.equal(hasUserName(text, 'tim'), true, `whole word or segment: ${text}`);
  }
  for (const text of ['const timeout = 1;', 'optimum', 'sentiment', 'timTimer']) {
    assert.equal(hasUserName(text, 'tim'), false, `inside a word: ${text}`);
  }
  assert.equal(hasUserName('numeric and generic', 'eric'), false);
});

it('a short ordinary word that contains the name is not a finding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rigorscope-owner-scan-'));
  try {
    const f = join(dir, 'ordinary.txt');
    writeFileSync(f, 'const numeric = isGeneric(x);\n');
    assert.deepEqual(scan({ userFiles: [f], pathFiles: [], user: 'eric' }), []);
    writeFileSync(f, "const who = 'eric';\n");
    assert.equal(scan({ userFiles: [f], pathFiles: [], user: 'eric' }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('a name of three letters or fewer is exempt: as a whole word it is an ordinary identifier (max, min, sum)', () => {
  for (const name of ['max', 'tim', 'sum']) assert.ok(userExemptReason(name), `${name} is exempt`);
  assert.equal(userExemptReason('anna'), null);
});

it('the code trees give no rule (a) finding for an ordinary name that is part of common words', { skip: fixtureSkip }, () => {
  const userFiles = USER_TREES.flatMap((d) => filesUnder(join(REPO, d)));
  for (const user of ['eric', 'max', 'tim']) assert.deepEqual(scan({ userFiles, pathFiles: [], user }), [], user);
});

it('rule (a) with an injected name detects it as a path segment in the violation fixture, not in the clean one', { skip: fixtureSkip }, () => {
  const bad = join(FIXTURES, 'owner-literal-violation.txt');
  const good = join(FIXTURES, 'owner-literal-clean.txt');
  assert.deepEqual(scan({ userFiles: [bad], pathFiles: [], user: 'exampleuser' }), [`${shown(bad)}: rule (a) OS user name`]);
  assert.deepEqual(scan({ userFiles: [good], pathFiles: [], user: 'exampleuser' }), []);
});
