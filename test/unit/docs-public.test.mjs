// Plan 09-05 (P9-09): the public docs set stays readable by a stranger. The checkers live in test/helpers/docs-checks.mjs and
// take text and file sets as arguments, so each is shown to fail on planted input before it judges the real pages.
// PUBLIC_PAGES is the rollout list: a page joins it in the commit that rewrites it; the last commit asserts it is the full set.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BIN, REPO } from '../fixtures/build.mjs';
import {
  anchorsOf, checkLinks, checkSelfReference, checkWording, commandsWithoutSection, holdsUserName, lineBoundProblems,
} from '../helpers/docs-checks.mjs';

const FULL_SET = [
  'README.md', 'docs/getting-started.md', 'docs/cli.md', 'docs/units.md', 'docs/data-model.md', 'docs/sources.md',
  'docs/privacy.md', 'docs/operations.md', 'docs/architecture.md', 'docs/known-limits.md',
];
const PUBLIC_PAGES = ['docs/architecture.md', 'docs/getting-started.md', 'README.md', 'docs/cli.md', 'docs/units.md', 'docs/data-model.md', 'docs/sources.md', 'docs/privacy.md', 'docs/operations.md', 'docs/known-limits.md'];

// Lines that describe a path in the reader's own repository (a quick task or phase plan directory): the self-reference forms
// do not apply to them. Text on the page, not a marker in the page source.
const OWN_REPO_LINES = [
  { page: 'docs/cli.md', includes: '.planning/phases/<dir>/<id>-PLAN.md' },
  { page: 'docs/units.md', includes: '.planning/phases/<dir>/<id>-PLAN.md' },
  { page: 'docs/sources.md', includes: '`.planning/phases/<dir>/`' },
];

// Page line targets (spec R9); a page outside +/- 40 percent needs a reason here.
const TARGETS = {
  'README.md': [120, null],
  'docs/getting-started.md': [80, null],
  'docs/cli.md': [500, null],
  'docs/units.md': [250, null],
  'docs/data-model.md': [350, null],
  'docs/sources.md': [200, 'tests pin every allowlisted source field, OTel key, location kind and class kind to appear in this page, and each gets a table row'],
  'docs/privacy.md': [120, null],
  'docs/operations.md': [150, 'the schedule notes cover systemd, Windows, WSL and macOS, and the page holds the backup, migration, preserve-copy and forward-ledger procedures'],
  'docs/architecture.md': [80, null],
  'docs/known-limits.md': [60, null],
};

const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const exists = (rel) => existsSync(join(REPO, rel));
const commandNames = () => readdirSync(join(REPO, 'src/commands')).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort();
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

describe('checkers fail on planted defects', () => {
  const pages = ['README.md', 'docs/a.md', 'docs/b.md'];
  const files = { 'README.md': '# Top\n', 'docs/a.md': '# A\n\n## Part one\n', 'docs/b.md': '# B\n' };
  const base = {
    pages, exists: (rel) => rel in files || rel === 'src/x.mjs', readPage: (rel) => files[rel],
  };
  const links = (text, page = 'docs/b.md') => checkLinks({ ...base, page, text });

  it('a good link, anchor and source link pass', () => {
    assert.deepEqual(links('[a](a.md#part-one) [s](../src/x.mjs) [h](https://example.test/x) [self](#b)'), []);
  });
  it('a missing page, a broken anchor and a page outside the set each fail', () => {
    assert.equal(links('[x](missing.md)').length, 1);
    assert.equal(links('[x](a.md#nope)').length, 1);
    assert.equal(links(`[x](../docs/${['main', 'tainers'].join('')}.md)`).length, 1);
  });
  it('a file outside the shipped directories and a missing shipped file fail', () => {
    assert.equal(links('[x](../secret/file.md)').length, 1);
    assert.equal(links('[x](../src/gone.mjs)').length, 1);
  });
  it('links inside a code fence are not checked', () => {
    assert.deepEqual(links('```\n[x](missing.md)\n```\n'), []);
  });
  it('anchors follow the GitHub rule, with a repeat suffix', () => {
    assert.deepEqual([...anchorsOf('# A `b` c\n## Same\n## Same\n')], ['a-b-c', 'same', 'same-1']);
  });

  const planted = [
    ['planning phases path', ['.plan', 'ning/phases/x'].join('')],
    ['roadmap word', ['the road', 'map'].join('')],
    ['phase number', ['Ph', 'ase 4'].join('')],
    ['plan number', ['pl', 'an 02-07'].join('')],
  ];
  for (const [name, line] of planted) {
    it(`self-reference form "${name}" fails unless the page and line text are on the allowlist`, () => {
      assert.equal(checkSelfReference({ page: 'p.md', text: `ok\n${line}\n` }).length, 1);
      assert.deepEqual(checkSelfReference({ page: 'p.md', text: `ok\n${line}\n`, exempt: [{ page: 'p.md', includes: line }] }), []);
      assert.equal(checkSelfReference({ page: 'q.md', text: `ok\n${line}\n`, exempt: [{ page: 'p.md', includes: line }] }).length, 1);
    });
  }

  const wording = [
    ['ADR number', ['A', 'DR-0005 says'].join('')],
    ['decision id', ['see D', '-05'].join('')],
    ['phase id', ['the ph', 'ase-2-planner reads it'].join('')],
    ['owner role id', ['for ow', 'ner-cost-decisions'].join('')],
    ['build phrasing', ['exists in this ', 'build'].join('')],
    ['build phrasing', ['what this ', 'build reads'].join('')],
    ['pronoun', 'ask him for it'],
    ['pronoun', 'she can read it'],
    ['ISO date', 'released on 2026-12-01 for all'],
    ['month and year', 'planned for March 2027'],
  ];
  for (const [name, line] of wording) {
    it(`wording form "${name}" fails on "${line}"`, () => {
      assert.deepEqual(checkWording({ page: 'p.md', text: `ok\n${line}\n` }), [`p.md:2 ${name}`]);
    });
  }
  it('dates inside inline code and fences pass, pronouns and ids inside them do not', () => {
    assert.deepEqual(checkWording({ page: 'p.md', text: 'use `--since 2026-10-01`\n```\n$ x 2026-10-01\n```\n' }), []);
    assert.equal(checkWording({ page: 'p.md', text: '```\nhis value\n```\n' }).length, 1);
  });
  it('they and them pass', () => {
    assert.deepEqual(checkWording({ page: 'p.md', text: 'they read them; the theme and there are fine\n' }), []);
  });

  it('a command file without a section fails', () => {
    assert.deepEqual(commandsWithoutSection({ cliText: '### one\n\n### two\n', commands: ['one', 'two', 'three'] }), ['three']);
  });

  it('a page over its bound fails without a reason and passes with one', () => {
    const t = { 'a.md': [100, null], 'b.md': [100, 'long because the pinned names must all appear'] };
    assert.deepEqual(lineBoundProblems({ targets: t, counts: { 'a.md': 141, 'b.md': 141 } }), ['a.md: 141 lines against 100 with no recorded reason']);
    assert.deepEqual(lineBoundProblems({ targets: t, counts: { 'a.md': 140, 'b.md': 60 } }), []);
    assert.equal(lineBoundProblems({ targets: t, counts: { 'a.md': 59, 'b.md': 100 } }).length, 1);
  });
});

describe('user name check with the clone URL exemption', () => {
  const user = 'someaccount';
  const url = `git+https://github.com/${user}/rigorscope.git`;
  it('the exact clone URL passes, in either written form', () => {
    assert.equal(holdsUserName({ text: `git clone https://github.com/${user}/rigorscope`, user, cloneUrl: url }), false);
    assert.equal(holdsUserName({ text: `git clone https://github.com/${user}/rigorscope.git`, user, cloneUrl: url }), false);
  });
  it('the bare name elsewhere fails, also beside the URL', () => {
    assert.equal(holdsUserName({ text: `by ${user}`, user, cloneUrl: url }), true);
    assert.equal(holdsUserName({ text: `https://github.com/${user}/rigorscope and ${user}`, user, cloneUrl: url }), true);
  });
  it('another repository of the same account fails, and with no URL nothing is exempt', () => {
    assert.equal(holdsUserName({ text: `https://github.com/${user}/other`, user, cloneUrl: url }), true);
    assert.equal(holdsUserName({ text: `https://github.com/${user}/rigorscope`, user, cloneUrl: null }), true);
  });
});

describe('the public pages', () => {
  it('the rollout list is the full set of ten pages', () => {
    assert.deepEqual([...PUBLIC_PAGES].sort(), [...FULL_SET].sort());
    assert.equal(FULL_SET.length, 10);
  });
  it('every rollout page is part of the full set and exists', () => {
    for (const p of PUBLIC_PAGES) assert.ok(FULL_SET.includes(p) && exists(p), p);
  });
  it('links and anchors resolve', () => {
    const problems = PUBLIC_PAGES.flatMap((page) => checkLinks({
      page, text: read(page), pages: FULL_SET, exists, readPage: read,
    }));
    assert.deepEqual(problems, []);
  });
  it('no self-reference form outside the allowlisted own-repository lines', () => {
    assert.deepEqual(PUBLIC_PAGES.flatMap((page) => checkSelfReference({ page, text: read(page), exempt: OWN_REPO_LINES })), []);
  });
  it('no planning id, build phrasing, prose date or third-person pronoun', () => {
    assert.deepEqual(PUBLIC_PAGES.flatMap((page) => checkWording({ page, text: read(page) })), []);
  });
  it('the install block holds no angle-bracket placeholder in a code block', () => {
    const blocks = ['README.md', 'docs/getting-started.md'].flatMap((p) => [...read(p).matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => [p, m[1]]));
    const hits = blocks.filter(([, body]) => /^\s*git clone\b.*<[^>]+>/m.test(body)).map(([p]) => p);
    assert.deepEqual(hits, []);
  });
  it('the first-run doctor claim names the findings the code reports', () => {
    for (const p of ['README.md', 'docs/getting-started.md', 'docs/known-limits.md']) {
      const t = read(p);
      for (const id of ['no_store', 'timer_missing']) assert.ok(t.includes(`\`${id}\``), `${p} names ${id}`);
    }
  });
  it('the daily-run step says schedule install works from a checkout at the documented location', () => {
    for (const p of ['README.md', 'docs/getting-started.md']) {
      const t = read(p).replace(/\s+/g, ' ');
      assert.match(t, /works only from a checkout at `~\/repos\/rigorscope`/, p);
      assert.match(t, /run `ingest` by hand/, p);
    }
  });
  it('line counts are within 40 percent of the targets or carry a reason', () => {
    const counts = Object.fromEntries(PUBLIC_PAGES.map((p) => [p, read(p).replace(/\n$/, '').split('\n').length]));
    const targets = Object.fromEntries(PUBLIC_PAGES.map((p) => [p, TARGETS[p]]));
    assert.deepEqual(lineBoundProblems({ targets, counts }), []);
  });
  it('every command file has a section in docs/cli.md (once cli.md is in the rollout)', { skip: !PUBLIC_PAGES.includes('docs/cli.md') && 'docs/cli.md joins the rollout later' }, () => {
    assert.deepEqual(commandsWithoutSection({ cliText: read('docs/cli.md'), commands: commandNames() }), []);
  });
});

describe('first-run commands in a clean environment', () => {
  const home = mkdtempSync(join(tmpdir(), 'rigorscope-firstrun-'));
  made.push(home);
  // Only these variables. The Windows users directory is set empty: on a WSL host the default discovery reads the host's own
  // Windows transcripts, which is intended for a user and wrong for a test.
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TZ: 'UTC', RIGORSCOPE_WINDOWS_USERS_DIR: '' };
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', cwd: REPO });

  it('ingest on an empty HOME exits 0 and reads no transcript file', () => {
    const r = run(['ingest']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^transcript: files=0 /m);
  });
  it('doctor exits 0 and, after the ingest, reports a timer finding the docs describe', () => {
    const r = run(['doctor']);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /problem no_store/);
    // systemctl --user is not reachable without a runtime directory, so the timer is unverified here; a normal shell reports
    // timer_missing. Where there is no systemd user manager at all (macOS, most containers) the timer finding is the lead
    // timer_not_configured and the verdict stays HEALTHY (docs/operations.md, Scheduling without systemd).
    // unit_node_below_floor depends on the node found on the unit PATH and is not asserted.
    if (/^ {2}lead timer_not_configured\b/m.test(r.stdout)) assert.match(r.stdout, /^doctor: HEALTHY /m);
    else {
      assert.match(r.stdout, /^doctor: UNHEALTHY /m);
      assert.match(r.stdout, /^ {2}(?:problem timer_missing|unverified timer_unverified)\b/m);
    }
  });
  it('doctor before the first ingest, clean environment and normal shell, reports no_store and a timer finding', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'rigorscope-firstrun-doctor-'));
    made.push(fresh);
    const normal = { ...process.env, HOME: fresh, RIGORSCOPE_WINDOWS_USERS_DIR: '' };
    delete normal.CLAUDE_CONFIG_DIR;
    for (const e of [{ ...env, HOME: fresh }, normal]) {
      const r = spawnSync(process.execPath, [BIN, 'doctor'], { env: e, encoding: 'utf8', cwd: REPO });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^doctor: UNHEALTHY /m);
      assert.match(r.stdout, /^ {2}problem no_store\b/m);
      assert.match(r.stdout, /^ {2}(?:problem timer_missing|unverified timer_unverified|lead timer_not_configured)\b/m);
    }
  });
  it('the demo exits 0', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'demo.mjs')], { env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TZ: 'UTC' }, encoding: 'utf8', cwd: REPO, timeout: 170_000 });
    assert.equal(r.status, 0, r.stderr);
  });
});
