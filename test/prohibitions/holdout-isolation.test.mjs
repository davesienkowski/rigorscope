// Prohibition (plan 02-03, TRUST-10; D-20, coordinator constraint 9): the held-out golden label file MUST NOT be read
// anywhere but its one acceptance test. No other file under src/, scripts/, bin/, data/ or test/ names it or lists the
// golden directory, so no parser, rule table, collector or training scorer can be tuned against it.
//
// Two rules, applied to every text file (any extension or none; a file holding a NUL byte is binary and skipped):
//   - name: the held-out word, case-insensitive, with an optional dash, underscore or space between its two halves;
//     it and every file name below are built from fragments, so this source holds no literal of it.
//   - listing (review WR-01, re-review WR-01): the file enumerates a directory (a call of readdir, opendir, glob,
//     scandir, listdir, iterdir or walk, with or without Sync; a shell `ls` or `find`, bare or with arguments, at a
//     line start or after `;`, `|`, `&`, `(` or a backtick; a wildcard under a golden path; or a `cd` into a folder
//     named golden with a wildcard word later in the file) and either sits under test/golden/ (where listing its own
//     directory needs no name) or holds `golden` as a path segment. A path segment is `golden` bounded by a slash,
//     backslash, quote, backtick or line start; or followed by a slash after whitespace (`cat golden/*.jsonl`); or
//     `.../golden` followed by whitespace (`cd test/golden && ...`); or the argument of a shell file verb (`ls
//     golden`). Prose such as "the golden snapshot" is not a path. JSON and JSONL files are data, never run, and get
//     the name rule only.
// Default mode scans src/, scripts/, bin/, data/ and test/, skipping node_modules, test/prohibitions/fixtures, this
// file, the label file itself, the one allowed reader (the acceptance test of test/golden) and test/golden/README.md
// (the documentation of the split, never run). A text scan cannot see a path computed from fragments elsewhere or a
// walk of a parent tree; the git-order gate of the plan and review cover those.
// Subject-injectable: GSD_PROHIB_SUBJECT names a file or directory, resolved against process.cwd(); only the subject
// is scanned, with no allowlist, and the fixture cases are skipped.
// test/prohibitions/fixtures/holdout-isolation-violation.mjs (reads the label file by name) and
// test/prohibitions/fixtures/holdout-isolation-listing-violation.mjs (lists the golden directory and reads its .jsonl
// files) must fail; the clean fixture (reads the training file) must pass. Failure messages name the file and the
// rule, never the matched text.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const FIXTURES = join(REPO, 'test', 'prohibitions', 'fixtures');
const WORD = ['ho', 'ld'];
const TAIL = ['o', 'ut'];
const NEEDLE = new RegExp(`${WORD.join('')}[-_ ]?${TAIL.join('')}`, 'i');
const STEM = `${WORD.join('')}${TAIL.join('')}`;
const LABEL_FILE = join(REPO, 'test', 'golden', `${STEM}.jsonl`);
const ALLOWED_READER = join(REPO, 'test', 'golden', `${STEM}-acceptance.test.mjs`);
const GOLDEN_README = join(REPO, 'test', 'golden', 'README.md');
const TREES = ['src', 'scripts', 'bin', 'data', 'test'];
const SKIP = new Set([SELF, LABEL_FILE, ALLOWED_READER, GOLDEN_README]);
const LIST_RE = /\b(?:readdir|opendir|glob|scandir|listdir|iterdir|walk)(?:Sync)?\s*\(|(?:^[ \t]*|[;|&(`][ \t]*)(?:ls|find)(?=[ \t;|&)`]|$)/m;
// A golden path segment: (1) the old bound, a line start or slash, backslash, quote or backtick on each side; (2)
// `golden` followed by a slash after whitespace (`cat golden/*.jsonl`); (3) `.../golden` followed by whitespace
// (`cd test/golden && ...`); (4) `golden` as the argument of a shell file verb (`ls golden`, `find golden -name x`).
// Plain prose such as "the golden snapshot" matches none of these.
const GOLDEN_PATH_RE = new RegExp([
  '(?:^|[/\\\\\'"`])golden(?:[/\\\\\'"`]|$)',
  '\\sgolden[/\\\\]',
  '[/\\\\]golden(?=\\s)',
  '(?:^|[\\s;|&(`])(?:ls|find|cd|cat|wc|head|tail|grep|rg|du|stat|tree|xargs)[ \\t]+(?:-\\S+[ \\t]+)*[\'"]?golden(?=[\\s\'"`;&|)]|$)',
].join('|'), 'm');
// `cd` into a golden folder, then (anywhere after it) a bare wildcard argument such as `cat *.jsonl`.
const CD_GOLDEN_RE = /\bcd[ \t]+['"]?(?:[^\s'";&|]*[/\\])?golden[/\\]?['"]?[ \t]*(?=$|[;&|])/gm;
const WILDCARD_RE = /(?:^|[\s'"=])[^\s'"]*[*?]/;
const cdIntoGoldenThenGlob = (text) => [...text.matchAll(CD_GOLDEN_RE)]
  .some((m) => WILDCARD_RE.test(text.slice(m.index + m[0].length)));
const GOLDEN_GLOB_RE = /golden[/\\]+[^\s'"`]*[*?[{]/;
const DATA_RE = /\.jsonl?$/i;

const isText = (p) => !readFileSync(p).includes(0);

function filesUnder(root, { skip = true } = {}) {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [root];
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || (skip && p === FIXTURES)) continue;
        walk(p);
      } else if (e.isFile() && !(skip && SKIP.has(p)) && isText(p)) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

const shown = (p) => relative(REPO, p).split(sep).join('/') || p;
// -> the rule messages for one file: rel is its repo-relative path ('/'-separated), text its content.
function ruleViolations(rel, text) {
  const out = [];
  if (NEEDLE.test(text)) out.push(`${rel}: names the held-out label file`);
  if (!DATA_RE.test(rel) && (LIST_RE.test(text) || GOLDEN_GLOB_RE.test(text) || cdIntoGoldenThenGlob(text))
    && (rel.startsWith('test/golden/') || GOLDEN_PATH_RE.test(text))) {
    out.push(`${rel}: lists the golden label directory`);
  }
  return out;
}
const scan = (files) => files.flatMap((f) => ruleViolations(shown(f), readFileSync(f, 'utf8')));

const SUBJECT = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : null;
const fixtureSkip = SUBJECT ? 'GSD_PROHIB_SUBJECT is set: only the subject is scanned' : false;

it(SUBJECT ? 'the subject does not name the held-out label file' : 'no code or data file but the acceptance test names the held-out label file', () => {
  let files;
  if (SUBJECT) {
    assert.ok(existsSync(SUBJECT), 'the subject exists');
    files = statSync(SUBJECT).isFile() ? [SUBJECT] : filesUnder(SUBJECT, { skip: false });
  } else {
    files = TREES.flatMap((d) => filesUnder(join(REPO, d)));
    assert.ok(files.length > 50, 'the default scan found the code trees');
  }
  assert.deepEqual(scan(files), []);
});

it('the scan detects the violation fixture', { skip: fixtureSkip }, () => {
  const f = join(FIXTURES, `${STEM}-isolation-violation.mjs`);
  assert.deepEqual(scan([f]), [`${shown(f)}: names the held-out label file`]);
});

it('the clean fixture passes, and the training file name and the held_out key do not match', { skip: fixtureSkip }, () => {
  assert.deepEqual(scan([join(FIXTURES, `${STEM}-isolation-clean.mjs`)]), []);
  assert.equal(NEEDLE.test('test/golden/units.jsonl {"held_out": false}'), false);
  for (const w of [STEM, `${WORD.join('')}-${TAIL.join('')}`, `${WORD.join('')}_${TAIL.join('')}`, `${WORD.join('')} ${TAIL.join('')}`, STEM.toUpperCase()]) {
    assert.equal(NEEDLE.test(w), true);
  }
});

// Review WR-01 (02-03 code review): a reader that lists the golden directory and reads its .jsonl files never names
// the label file, and a reader in a file of another extension was not scanned.
it('the scan detects the listing violation fixture (review WR-01)', { skip: fixtureSkip }, () => {
  const f = join(FIXTURES, `${STEM}-isolation-listing-violation.mjs`);
  assert.deepEqual(scan([f]), [`${shown(f)}: lists the golden label directory`]);
});

it('a file under test/golden that lists a directory fails without naming anything; elsewhere it needs a golden path (review WR-01)', { skip: fixtureSkip }, () => {
  const LISTS = (rel) => [`${rel}: lists the golden label directory`];
  const lister = [
    "import { readdirSync, readFileSync } from 'node:fs';",
    "const dir = new URL('./', import.meta.url);",
    "export const all = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => readFileSync(new URL(n, dir), 'utf8'));",
    '',
  ].join('\n');
  assert.deepEqual(ruleViolations('test/golden/zz-bypass.mjs', lister), LISTS('test/golden/zz-bypass.mjs'));
  assert.deepEqual(ruleViolations('test/golden/inputs/zz.py', 'import os\nrows = [open(n).read() for n in os.listdir(".")]\n'), LISTS('test/golden/inputs/zz.py'));
  assert.deepEqual(ruleViolations('test/unit/zz.mjs', lister), [], 'a listing outside test/golden with no golden path passes');
  const named = lister.replace("'./'", "'../golden/'");
  assert.deepEqual(ruleViolations('test/unit/zz.mjs', named), LISTS('test/unit/zz.mjs'));
  assert.deepEqual(ruleViolations('test/unit/zz.cts', "const d = join(REPO, 'test', 'golden');\nfor (const n of readdirSync(d)) use(n);\n"), LISTS('test/unit/zz.cts'));
  assert.deepEqual(ruleViolations('scripts/zz.sh', 'for f in test/golden/*.jsonl; do cat "$f"; done\n'), LISTS('scripts/zz.sh'));
  assert.deepEqual(ruleViolations('scripts/zz.py', "import glob\nrows = glob.glob('test/golden/*.jsonl')\n"), LISTS('scripts/zz.py'));
  assert.deepEqual(ruleViolations('src/zz.mjs', '// review of the real golden snapshot\nreaddirSync(dir);\n'), [], 'prose naming golden is not a path');
  assert.deepEqual(ruleViolations('test/golden/zz.mjs', "readFileSync(new URL('./units.jsonl', import.meta.url));\n"), [], 'reading the training file by name is not a listing');
});

// Re-review of the 02-03 review-fix round: plain shell shapes the first listing rule missed. Each body below reads
// the golden directory without a golden path after a slash or quote, or lists with a bare verb at a line end.
it('plain shell shapes that read or list the golden directory fail (re-review WR-01)', { skip: fixtureSkip }, () => {
  const LISTS = (rel) => [`${rel}: lists the golden label directory`];
  const shapes = {
    'scripts/zz-a.sh': 'cd "$(dirname "$0")/../test" || exit 1\nfor f in golden/*.jsonl; do wc -l "$f"; done\n',
    'scripts/zz-b.sh': 'cd test && ls golden\n',
    'scripts/zz-f.sh': 'cd test/golden && cat *.jsonl\n',
    'scripts/zz-g.sh': 'cd test/golden\nls\n',
    'scripts/zz-h.sh': 'cd test && cat golden/*.jsonl\n',
    'scripts/zz-j.sh': 'cd test/golden && ls\n',
    'scripts/zz-k.sh': "cd 'test/golden'; find\n",
    'scripts/zz-l.sh': 'cd test\nfind golden -name x\n',
  };
  const missed = Object.entries(shapes).filter(([rel, body]) => ruleViolations(rel, body).join() !== LISTS(rel).join()).map(([rel]) => rel);
  assert.deepEqual(missed, [], 'every plain shell shape is caught');
  // Still passing: a bare listing with no golden path, a cd into golden that lists nothing, prose naming golden.
  assert.deepEqual(ruleViolations('scripts/zz-m.sh', 'cd test\nls\n'), [], 'a bare ls with no golden path');
  assert.deepEqual(ruleViolations('scripts/zz-n.sh', 'cd test/golden && node run.mjs\n'), [], 'a cd into golden with no glob or listing');
  assert.deepEqual(ruleViolations('scripts/zz-o.sh', '# the golden set is read by one test\nls\n'), [], 'prose naming golden');
  assert.deepEqual(ruleViolations('scripts/zz-p.sh', 'cd test/unit && ls\n'), [], 'a cd into another directory');
});

it('the default scan reads every text file whatever its extension and skips binary files (review WR-01)', { skip: fixtureSkip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rigorscope-isolation-scan-'));
  try {
    const names = ['a.py', 'b.cts', 'c.mts', 'd.ts', 'e', 'f.sh', 'g.mjs', 'h.yaml'];
    for (const n of names) writeFileSync(join(dir, n), 'x\n');
    writeFileSync(join(dir, 'z.bin'), Buffer.from([0x78, 0x00, 0x79]));
    assert.deepEqual(filesUnder(dir, { skip: false }).map((p) => relative(dir, p)).sort(), names);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
