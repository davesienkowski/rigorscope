// Prohibitions of plan 03.1-05 (ADPT-04, ADPT-05, D-12, D-20): (1) the committed stock-run fixtures and the two run records hold
// no identity; (2) the run result carries the label, the leak list and the ship line, and its usage gates and cost table obey
// the caps. Both are record checks by construction: they read what the run wrote, so a recorded overshoot turns them red.
//
// The helper and generated-negative cases always run, so the teeth check is live on main. The fixture scan and the result rules
// skip with a visible reason only while test/fixtures/stock-run/ and the result file are both absent; fixtures without a result
// fail. GSD_PROHIB_SUBJECT names a file or directory (resolved against the cwd) that the identity scan covers instead.
// Assertions compare rule-id arrays and name a file, a rule and a byte position, never matched text or a needle value.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPrivateTree, privateRef } from '../helpers/tree-kind.mjs';
import {
  LABEL, checkResult, describeHit, hitDigest, identityNeedles, identityWordNeedles, needlesFrom, parseResult, ruleIds, scanNames, scanText, scrubText,
} from '../helpers/stock-run-identity.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const FIX = join(REPO, 'test', 'fixtures', 'stock-run');
// The two run records are private files reached through the refs marker (null in a public tree, where only the fixtures are
// scanned and the record rules skip). In the private tree the pairing rule holds: fixtures need the result record.
const RESULT = privateRef('stock-run-result');
const RECORDS = [RESULT, privateRef('stock-run-state')].filter((f) => f !== null);
const SKIP_REASON = 'no stock-run fixtures and no result file yet';
const PRIVATE_SKIP = isPrivateTree() ? false : 'private tree only: stock-run-result';
const noneYet = !existsSync(FIX) && (RESULT === null || !existsSync(RESULT));

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

// Built from fragments: shapes the scan must catch, never stored as scannable literals in this source.
const NEEDLE = 'qzxneedle';
const SHAPES = [
  ['needle', `a ${NEEDLE} b`],
  ['needle', `a ${NEEDLE.toUpperCase()} b`],
  ['needle', `a ${NEEDLE[0].toUpperCase()}${NEEDLE.slice(1)} b`],
  ['email', ['person', 'example.org'].join('@')],
  ['uuid', ['12345678', '1234', '1234', '1234', '123456789abc'].join('-')],
  ['token', `${'aB3'.repeat(12)}`],
  ['sk', ['sk', 'abcdefgh12345678'].join('-')],
  ['claude-ai', ['claude', 'ai/code/x'].join('.')],
  ['home-path', ['', 'home', 'someone', 'work'].join('/')],
  ['home-path', ['C:', 'Users', 'someone', 'work'].join('\\')],
  ['home-path', ['C:', 'Users', 'someone', 'work'].join('\\\\')],
  ['home-path', ['', '', 'wsl.localhost', 'Ubuntu', 'home', 'someone'].join('\\')],
  ['home-path', ['', 'root', '.config'].join('/')],
  ['coauthor', [['Co', 'Authored', 'By'].join('-') + ':', 'Some Person'].join(' ')],
  ['git-identity', ['user.name', '= Somebody'].join(' ')],
  ['git-identity', ['Author:', 'Somebody Else'].join(' ')],
  ['git-identity', ['Committer:', 'Somebody Else'].join(' ')],
  ['git-identity', ['From:', 'Somebody Else'].join(' ')],
];

describe('identity helper', () => {
  it('derives run-time needles of at least 3 characters, lower-case and deduplicated', () => {
    const n = identityNeedles();
    assert.ok(Array.isArray(n));
    assert.equal(new Set(n).size, n.length);
    for (const v of n) {
      assert.ok(v.length >= 3);
      assert.equal(v, v.toLowerCase());
    }
  });

  SHAPES.forEach(([rule, text], i) => {
    it(`scan rule ${rule} flags its generated negative case ${i}`, () => {
      assert.ok(ruleIds(scanText(text, [NEEDLE])).includes(rule), `rule ${rule} did not fire`);
    });
  });

  it('lets the exempt shapes through (7, 12, 40 and 64 hex characters, a fixture identity, a model co-author)', () => {
    const clean = [
      'abcdef1', 'abcdef123456', 'a'.repeat(40), '0123456789abcdef'.repeat(4),
      ['user.name', '= fixture'].join(' '), [['Co', 'Authored', 'By'].join('-') + ':', 'Claude Sonnet'].join(' '), ['Author:', 'fixture'].join(' '),
    ].join('\n');
    assert.deepEqual(ruleIds(scanText(clean, [NEEDLE])), []);
  });

  it('home paths: ordinary words around root are not a home path; a root path in text or brackets is', () => {
    assert.deepEqual(ruleIds(scanText(['src', 'root', 'x'].join('/'), [])), []);
    assert.deepEqual(ruleIds(scanText(['project', 'root', 'x'].join('/'), [])), []);
    assert.ok(ruleIds(scanText(`see (${['', 'root', 'x'].join('/')})`, [])).includes('home-path'));
  });

  it('planning-style relative file paths are not tokens; mixed-case, hex and slash-free long strings still are', () => {
    const paths = [
      'planning/phases/01-runnable-greeting-and-readme/01-01-SUMMARY',
      'planning/milestones/v1/RSX-02-greet-by-name/02-01-PLAN',
      'quick/261106-smc-add-one-line-to-the-readme-describing-ho/261106-smc-PLAN',
    ];
    for (const path of paths) {
      assert.deepEqual(ruleIds(scanText(path, [])), [], 'a path was flagged');
      assert.equal(scrubText(path, []), path, 'a path was rewritten');
    }
    const secrets = [
      `${'aB3'.repeat(4)}/${'aB3'.repeat(8)}`,
      `${'a1b2'.repeat(8)}/x`,
      `${'a1b2'.repeat(8)}/ab+cd=`,
      'add-one-line-to-the-readme-describing-how-it-works-2',
    ];
    for (const secret of secrets) {
      assert.ok(ruleIds(scanText(secret, [])).includes('token'), 'a secret shape was not flagged');
      assert.ok(scrubText(secret, []).includes('<token>'), 'a secret shape was not scrubbed');
    }
  });

  it('scrubText removes every generated shape so a re-scan is clean', () => {
    const all = SHAPES.map(([, t]) => t).join('\n');
    assert.deepEqual(ruleIds(scanText(scrubText(all, [NEEDLE]), [NEEDLE])).filter((r) => r !== 'coauthor' && r !== 'git-identity'), []);
  });

  it('a failure message holds the file, rule and byte position, never the matched text or the needle', () => {
    const [hit] = scanText(SHAPES[0][1], [NEEDLE]);
    const msg = describeHit('x/file.md', hit);
    assert.ok(msg.includes('needle') && msg.includes('byte 2'));
    assert.ok(!msg.toLowerCase().includes(NEEDLE));
  });
});

describe('needles from the email domain', () => {
  it('a custom domain gives the whole domain and each label of 5 or more characters as substring needles', () => {
    const n = needlesFrom({ name: 'Pat Qzxsurname', email: ['pat', 'qzxcorp.com'].join('@') });
    assert.ok(n.substring.includes('qzxcorp.com'));
    assert.ok(n.substring.includes('qzxcorp'));
    assert.ok(!n.substring.includes('com') && !n.word.includes('com'));
    assert.ok(n.substring.includes('qzxsurname') && n.substring.includes('pat'));
  });

  it('a label of 3 or 4 characters is a whole-token needle only, and a common word containing it does not hit', () => {
    const n = needlesFrom({ email: ['pat', 'abcd.com'].join('@') });
    assert.ok(n.word.includes('abcd'));
    assert.ok(!n.substring.includes('abcd'));
    assert.deepEqual(ruleIds(scanText('abcdef abcd1 xabcd', n.substring, n.word)), []);
    for (const text of ['x abcd y', 'x.abcd.y', '(Abcd)', 'abcd']) assert.deepEqual(ruleIds(scanText(text, n.substring, n.word)), ['needle'], 'a whole-token hit was missed');
  });

  it('top-level and common mail-provider labels are never needles, so ordinary words and URLs stay clean', () => {
    for (const email of [['pat', 'gmail.com'], ['12345+pat', 'users.noreply.github.com'], ['pat', 'example.org']].map((p) => p.join('@'))) {
      const n = needlesFrom({ email });
      for (const bad of ['com', 'org', 'uk', 'users', 'noreply', 'github', 'gmail', 'example', 'gmail.com', 'github.com']) {
        assert.ok(!n.substring.includes(bad) && !n.word.includes(bad), `a generic label became a needle (${bad.length} characters)`);
      }
    }
    const n = needlesFrom({ name: 'Pat Qzxsurname', email: ['pat', 'qzxcorp.com'].join('@') });
    assert.deepEqual(ruleIds(scanText('complete the community commit', n.substring, n.word)), []);
  });

  it('the run-time sets are arrays of lower-case strings of at least 3 characters', () => {
    for (const v of [...identityNeedles(), ...identityWordNeedles()]) {
      assert.ok(v.length >= 3);
      assert.equal(v, v.toLowerCase());
    }
  });
});

describe('name scan', () => {
  it('flags a needle in a file or directory name by rule and position, without printing the path or the needle', () => {
    const found = scanNames([`dir-${NEEDLE}/file.md`, `ok/${NEEDLE}.md`, 'ok/fine.md'], [NEEDLE]);
    assert.equal(found.length, 2);
    for (const line of found) {
      assert.ok(line.includes('needle'));
      assert.ok(!line.toLowerCase().includes(NEEDLE) && !line.includes('file.md') && !line.includes('fine.md'));
    }
  });

  it('flags the shapes in names and lets planning-style and quick-dir names through', () => {
    assert.equal(scanNames([['person', 'example.org'].join('@') + '/x.md'], []).length, 1);
    assert.deepEqual(scanNames([
      'm2-executed/.planning/quick/261106-smc-add-one-line-to-the-readme-describing-ho/261106-smc-PLAN.md',
      'm2-complete/.planning/milestones/v1.1-phases/RSX-02-greet-by-name/02-01-PLAN.md',
    ], [NEEDLE]), []);
  });
});

const VALID = `# Run result

## Label

${LABEL}

## Leak list

| leak | source |
|------|--------|
| user settings | transcript line 3 |

## Usage gates

| group | five_hour_used | weekly_used | level | decision |
|-------|----------------|-------------|-------|----------|
| launch | 10 | 44 | green | start |
| A | 12 | 45 | green | start |
| B | 14 | 46 | reserve | start |

## Steps

| step | mode | result | evidence |
|------|------|--------|----------|
| A1 | print | ran | a.md |
| ship | none | not run: needs an origin remote | none |

/gsd-ship: not run: needs an origin remote and a gh login

## Cost

| group | steps | cumulative_before_usd | cumulative_after_usd | basis |
|-------|-------|-----------------------|----------------------|-------|
| A | 2 | 0 | 10 | floor |
| B | 2 | 10 | 22 | floor |

## Stop reason

none: completed
`;

const withRows = (text, heading, rows) => text.replace(new RegExp(`(## ${heading}\\n\\n[^]*?)\\n\\n(?=##|/gsd|$)`), `$1\n${rows}\n\n`);

describe('result-record rules with generated negative cases', () => {
  it('accepts the valid template', () => {
    assert.deepEqual(checkResult(VALID), []);
    const p = parseResult(VALID);
    assert.equal(p.gates.length, 3);
    assert.equal(p.costs.length, 2);
    assert.equal(p.steps.length, 2);
  });

  const cases = {
    'label-missing': VALID.replace(LABEL, 'stock'),
    'leak-list-missing': VALID.replace('## Leak list', '## Leaks'),
    'ship-not-marked-not-run': VALID.replace('/gsd-ship: not run:', '/gsd-ship: ran'),
    'clean-stock-claim': `${VALID}\nThis run was clean stock.\n`,
    'usage-gates-missing': VALID.replace('## Usage gates', '## Gates'),
    'stop-reason-missing': VALID.replace('## Stop reason', '## Ending'),
    'too-many-steps': withRows(VALID, 'Steps', Array.from({ length: 21 }, (_, i) => `| S${i} | print | ran | e.md |`).join('\n')),
    'start-against-gate': VALID.replace('| B | 14 | 46 | reserve | start |', '| B | 14 | 66 | reserve | start |'),
    'no-stop-at-weekly-limit': VALID.replace('| B | 14 | 46 | reserve | start |', '| B | 14 | 71 | reserve | ask |'),
    'cost-over-hard-cap': VALID.replace('| B | 2 | 10 | 22 | floor |', '| B | 2 | 10 | 281 | floor |'),
    'group-started-over-allowance': VALID.replace('| B | 2 | 10 | 22 | floor |', '| B | 2 | 245 | 250 | floor |'),
    'cost-goes-down': VALID.replace('| B | 2 | 10 | 22 | floor |', '| B | 2 | 4 | 22 | floor |'),
    'unknown-cost-with-numbers': `${VALID}\ncost: unknown (not ingested)\n`,
    'crossed-soft-checkpoint-without-ask': VALID.replace('| B | 2 | 10 | 22 | floor |', '| A2 | 2 | 10 | 160 | floor |').replace('| A | 2 | 0 | 10 | floor |', '| A | 2 | 0 | 160 | floor |'),
  };
  for (const [rule, text] of Object.entries(cases)) {
    it(`flags ${rule}`, () => {
      assert.ok(checkResult(text).includes(rule), `rule ${rule} did not fire`);
    });
  }

  it('a run that crossed 155 and ends none: completed fails; an ask row before the next start, or a named stop, passes', () => {
    const crossed = VALID.replace('| A | 2 | 0 | 10 | floor |', '| A | 2 | 0 | 160 | floor |');
    assert.ok(checkResult(crossed).includes('crossed-soft-checkpoint-without-ask'));
    const asked = crossed.replace('| B | 14 | 46 | reserve | start |', '| B | 14 | 46 | reserve | ask |\n| B | 14 | 46 | reserve | start |');
    assert.deepEqual(checkResult(asked).filter((r) => r.startsWith('crossed')), []);
    const stopped = crossed.replace(/\| B \| 14 \| 46 \| reserve \| start \|\n/, '').replace('none: completed', 'soft checkpoint of 155 reached');
    assert.deepEqual(checkResult(stopped).filter((r) => r.startsWith('crossed')), []);
  });
});

describe('result-record evidence cannot be removed to disable a rule', () => {
  const GATE_ROWS = /(\| group \| five_hour_used[^\n]*\n\|[-|]+\|\n)(?:\|[^\n]*\n)+/;
  const COST_ROWS = /(\| group \| steps \| cumulative_before_usd[^\n]*\n\|[-|]+\|\n)(?:\|[^\n]*\n)+/;
  const rules = (text) => checkResult(text);

  it('deleting every gate row fails', () => {
    assert.ok(rules(VALID.replace(GATE_ROWS, '$1')).includes('gates-empty'));
  });

  for (const cell of ['group', 'weekly_used', 'level', 'decision']) {
    it(`renaming the gates header cell ${cell} fails`, () => {
      const text = VALID.replace(/(\| group \| five_hour_used[^\n]*)/, (line) => line.replace(new RegExp(`\\b${cell}\\b`), `${cell}_x`));
      assert.ok(rules(text).includes('gates-malformed'));
    });
  }

  it('deleting every cost row, or the Cost section, fails; a stated unknown cost needs neither', () => {
    assert.ok(rules(VALID.replace(COST_ROWS, '$1')).includes('cost-empty'));
    assert.ok(rules(VALID.replace('## Cost', '## Spend')).includes('cost-empty'));
    const unknown = VALID.replace(/## Cost[^]*?(?=## Stop reason)/, 'cost: unknown (not ingested)\n\n');
    assert.deepEqual(rules(unknown), []);
  });

  for (const cell of ['group', 'cumulative_before_usd', 'cumulative_after_usd']) {
    it(`renaming the Cost header cell ${cell} fails`, () => {
      const text = VALID.replace(/(\| group \| steps \| cumulative_before_usd[^\n]*)/, (line) => line.replace(new RegExp(`\\b${cell}\\b`), `${cell}_x`));
      assert.ok(rules(text).includes('cost-malformed'));
    });
  }

  it('a renamed Cost column no longer hides a cap overshoot: the record still fails', () => {
    const text = VALID.replace('cumulative_after_usd', 'after_usd').replace('| B | 2 | 10 | 22 | floor |', '| B | 2 | 10 | 281 | floor |');
    assert.ok(rules(text).includes('cost-malformed'));
  });
});

describe('result-record rules at their boundaries', () => {
  const gateB = (weekly, level, decision) => VALID.replace('| B | 14 | 46 | reserve | start |', `| B | 14 | ${weekly} | ${level} | ${decision} |`);
  const costA = (before, after) => VALID.replace('| A | 2 | 0 | 10 | floor |', `| A | 2 | ${before} | ${after} | floor |`);
  const costB = (before, after) => VALID.replace('| B | 2 | 10 | 22 | floor |', `| B | 2 | ${before} | ${after} | floor |`);
  const steps = (n) => VALID.replace(/(\| step \| mode \| result \| evidence \|\n\|[-|]+\|\n)[^]*?(\n\n\/gsd-ship)/, `$1${Array.from({ length: n }, (_, i) => `| S${i} | print | ran | e.md |`).join('\n')}$2`);
  const has = (text, rule) => checkResult(text).includes(rule);

  it('the start gate: weekly 64 starts, 65 does not; level amber, red and a missing weekly do not start', () => {
    assert.ok(!has(gateB(64, 'reserve', 'start'), 'start-against-gate'));
    assert.ok(has(gateB(65, 'reserve', 'start'), 'start-against-gate'));
    assert.ok(!has(gateB(46, 'green', 'start'), 'start-against-gate'));
    assert.ok(has(gateB(46, 'amber', 'start'), 'start-against-gate'));
    assert.ok(has(gateB(46, 'red', 'start'), 'start-against-gate'));
    assert.ok(has(gateB('n/a', 'reserve', 'start'), 'start-against-gate'));
  });

  it('the stop gate: weekly 69 may ask, 70 must stop; a stop row at 70 passes', () => {
    assert.ok(!has(gateB(69, 'reserve', 'ask'), 'no-stop-at-weekly-limit'));
    assert.ok(has(gateB(70, 'reserve', 'ask'), 'no-stop-at-weekly-limit'));
    assert.ok(has(gateB(70, 'reserve', 'start'), 'no-stop-at-weekly-limit'));
    assert.ok(!has(gateB(70, 'reserve', 'stop'), 'no-stop-at-weekly-limit'));
  });

  it('the step cap: 21 step rows pass, 22 fail', () => {
    assert.ok(!has(steps(21), 'too-many-steps'));
    assert.ok(has(steps(22), 'too-many-steps'));
  });

  it('the soft checkpoint: 154.99 passes, exactly 155 needs a brake before the next start', () => {
    assert.deepEqual(checkResult(costA(0, 154.99)).filter((r) => r.startsWith('crossed')), []);
    assert.ok(has(costA(0, 155), 'crossed-soft-checkpoint-without-ask'));
  });

  it('a stop gate row (not only ask) is a brake after a crossing', () => {
    const crossed = costA(0, 160);
    const stopped = crossed.replace('| B | 14 | 46 | reserve | start |', '| B | 14 | 46 | reserve | stop |\n| B | 14 | 46 | reserve | start |');
    assert.deepEqual(checkResult(stopped).filter((r) => r.startsWith('crossed')), []);
    assert.ok(has(crossed, 'crossed-soft-checkpoint-without-ask'));
  });

  it('a crossing in the last cost group with no later start needs a named stop reason', () => {
    const last = costB(10, 160);
    assert.ok(has(last, 'crossed-soft-checkpoint-without-ask'));
    assert.deepEqual(checkResult(last.replace('none: completed', 'hard cap reached')).filter((r) => r.startsWith('crossed')), []);
  });

  it('one row whose after is below its before fails with no row before it', () => {
    assert.ok(has(costA(10, 4), 'cost-goes-down'));
    assert.ok(!has(costA(4, 10), 'cost-goes-down'));
  });
});

describe('committed fixtures and run records hold no identity', { skip: noneYet ? SKIP_REASON : false }, () => {
  it('fixtures do not exist without the result file', { skip: PRIVATE_SKIP }, () => {
    if (existsSync(FIX)) assert.ok(existsSync(RESULT), 'test/fixtures/stock-run/ exists but the result file does not');
  });

  const subject = process.env.GSD_PROHIB_SUBJECT;
  const subjectPath = subject ? resolve(process.cwd(), subject) : null;
  const targets = subject
    ? (existsSync(subjectPath) ? (statSync(subjectPath).isDirectory() ? walk(subjectPath) : [subjectPath]) : [])
    : [...(existsSync(FIX) ? walk(FIX) : []), ...RECORDS.filter((f) => existsSync(f))];
  // File and directory names are scanned relative to the fixture root (or the subject directory).
  const nameBase = subject ? (existsSync(subjectPath) && statSync(subjectPath).isDirectory() ? subjectPath : null) : FIX;

  it('the identity scan finds nothing in any file', () => {
    const needles = identityNeedles();
    const words = identityWordNeedles();
    const found = [];
    for (const file of targets) {
      const rel = relative(REPO, file);
      const shown = scanNames([rel], needles, words).length ? `name ${hitDigest(rel)}` : rel;
      for (const hit of scanText(readFileSync(file, 'utf8'), needles, words)) found.push(describeHit(shown, hit));
    }
    assert.deepEqual(found, []);
  });

  it('the identity scan finds nothing in any file or directory name', () => {
    if (!nameBase || !existsSync(nameBase)) return;
    const names = targets.filter((f) => f.startsWith(nameBase + sep)).map((f) => relative(nameBase, f));
    assert.deepEqual(scanNames(names, identityNeedles(), identityWordNeedles()), []);
  });

  it('the result record obeys the label, leak list, ship line, gates and cost rules', { skip: PRIVATE_SKIP || (existsSync(RESULT) || !noneYet ? false : SKIP_REASON) }, () => {
    assert.ok(existsSync(RESULT), 'the result file is missing');
    assert.deepEqual(checkResult(readFileSync(RESULT, 'utf8')), []);
  });
});
