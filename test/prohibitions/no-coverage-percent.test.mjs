// Prohibition (plan 03.1-04, ADPT-04, owner decision of 2026-11-04, T-03.1-13): no line or JSON key built by phase 03.1 may show an artifact
// coverage percentage, share, rate, score or ratio. The lines are the `locations:` and `classes:` ingest lines, the `locations:`
// and `repeats:` lines of `units`, the `unit-locations:`, `roster:` and `unclassified:` sections of `doctor` (with their
// indented detail lines) and the JSON fragments `locations`, `idRepeats`, `unit_locations`, `roster` and `unclassified`. A
// line states a count and a roster ref ("not in the roster at ref X"); it never contains a percent sign, one of the words
// coverage, score, share, rate, ratio, percent, percentage, pct, fraction, frac or proportion, the phrase "per cent", a
// digits-slash-digits pair (`6/10`) or a bare decimal number (counts are integers; a version has two dots). In the JSON
// fragments a number is a line of its own, so a `pct` key or a non-integer value fails the same scan. The existing `coverage:` tier lines of `units` are out of scope.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a module exporting transform(label, text) that is applied to every command
// output before it is scanned (resolved against process.cwd(); unset means the identity). test/prohibitions/fixtures/
// no-coverage-percent-violation.mjs plants a percent sign in a roster line and must make this test fail
// (test/prohibitions/no-coverage-percent-fixture-fails.test.mjs runs it).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cliEnv, makeHome, runCli,
} from '../fixtures/build.mjs';
import { makeRepo, planText, writePlanningDir } from '../fixtures/git-repo.mjs';
import { STOCK_LAYOUTS } from '../fixtures/stock-layouts.mjs';
import { buildUnitsHome } from '../fixtures/units-home.mjs';
import { FORMS } from './fixtures/no-coverage-percent-forms.mjs';

export const FORBIDDEN = Object.freeze([
  'coverage', 'score', 'share', 'rate', 'ratio', 'percent', 'percentage', 'pct', 'fraction', 'frac', 'proportion',
]);
const PREFIXES = Object.freeze({
  ingest: ['locations: ', 'classes: '],
  units: ['locations: ', 'repeats: '],
  doctor: ['unit-locations: ', 'roster: ', 'unclassified: '],
});

// text: the output of one command; prefixes: the line starts that open a scanned section. -> the scanned lines: each line that
// starts with one of the prefixes and the indented lines that follow it.
export function scannedLines(text, prefixes) {
  const out = [];
  let open = false;
  for (const line of text.split('\n')) {
    if (prefixes.some((p) => line.startsWith(p))) { open = true; out.push(line); } else if (open && line.startsWith('  ')) out.push(line);
    else open = false;
  }
  return out;
}

// A repeat line carries percent-encoded evidence ids; strip them before looking for a percent sign (they are ids, not figures).
const stripIds = (line) => line.replace(/\b[a-z-]+:[A-Za-z0-9_.~%:-]*%[0-9A-Fa-f]{2}[A-Za-z0-9_.~%:-]*/g, '');

// -> the violations of one line: a percent sign, a forbidden word, "per cent", a digits-slash-digits pair or a bare decimal.
export function violationsOf(line) {
  const out = [];
  const body = stripIds(line);
  if (body.includes('%')) out.push('percent sign');
  if (/\bper\s+cent\b/i.test(body)) out.push('phrase per cent');
  if (/\b\d+\s*\/\s*\d+\b/.test(body)) out.push('digits slash digits');
  if (/(?<![\w.])\d+\.\d+(?![\w.])/.test(body)) out.push('decimal number');
  for (const word of body.toLowerCase().match(/[a-z]+/g) ?? []) if (FORBIDDEN.includes(word)) out.push(`word ${word}`);
  return out;
}

// -> the keys, string values and numbers of a JSON fragment, flattened to lines so the same scanner applies (a number is
// written with its path, so a `pct` key or a non-integer value is a line the scan reads).
export function jsonLines(value, path = '') {
  if (Array.isArray(value)) return value.flatMap((v) => jsonLines(v, path));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [`${path}.${k}`, ...jsonLines(v, `${path}.${k}`)]);
  return typeof value === 'string' || typeof value === 'number' ? [`${path}=${value}`] : [];
}

const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : null;
const transform = async (label, text) => (subject === null ? text : (await import(pathToFileURL(subject).href)).transform(label, text));

describe('the scanner has teeth', () => {
  it('flags a percent sign and each forbidden word, and passes a plain count line', () => {
    assert.deepEqual(violationsOf('roster: ref=abc entries=3 drift=unknown'), []);
    assert.ok(violationsOf('unclassified: files=4 (12%)').includes('percent sign'));
    assert.ok(violationsOf('unclassified: files=4 (40 per cent)').includes('phrase per cent'));
    assert.ok(violationsOf('roster: ref=abc known=6/10').includes('digits slash digits'));
    assert.ok(violationsOf('roster: ref=abc known=0.6').includes('decimal number'));
    for (const w of FORBIDDEN) assert.ok(violationsOf(`classes: repos=1 ${w}=3`).includes(`word ${w}`), w);
    assert.deepEqual(violationsOf('classes: repos=1 generate=3 shared=2'), [], 'only whole words');
  });

  it('flags every generated form of a ratio that is not a percent sign (pct=, frac=, 6/10, per cent, a bare decimal, a json key or number)', () => {
    for (const f of FORMS) {
      const lines = f.kind === 'text' ? [`${f.sample}${f.suffix}`] : jsonLines({ files: 4, [f.key]: f.value }, f.fragment);
      assert.ok(lines.some((l) => violationsOf(l).length > 0), `${f.id}: ${lines.join(' | ')}`);
    }
  });

  it('passes plain count lines and integer json: ids, versions, refs, dates and counts are not ratios', () => {
    const clean = [
      'roster: ref=49ea1a9b0c1e version=1.19.0 entries=154 drift=changed:6',
      'roster: ref=49ea1a9b0c1e version=1.19.0 entries=154 drift=version_differs installed=9.9.9',
      'unclassified: files=4 repos=1 not_in_roster_at_ref=49ea1a9b0c1e',
      'classes: repos=2 recognized_f=3 recognized_e=4 recognized_s=1 unclassified=5 roster_ref=49ea1a9b0c1e',
      '  stem README.md n=2',
      'repeats: unit u:gsd-core:~%2Frepos%2Fx%2F.git:quick:261004-ga5 dirs=2',
    ];
    for (const l of clean) assert.deepEqual(violationsOf(l), [], l);
    assert.deepEqual(jsonLines({ files: 4, repos: 1, roster_ref: '49ea1a9b0c1e', stems: [{ stem: 'x.md', n: 2 }] }, 'unclassified').flatMap(violationsOf), []);
  });

  it('keeps the indented lines of a section and stops at the next key', () => {
    const text = 'a: 1\nunclassified: files=1\n  stem x n=1\nother: 2\n  more\n';
    assert.deepEqual(scannedLines(text, ['unclassified: ']), ['unclassified: files=1', '  stem x n=1']);
  });
});

describe('phase 03.1 output states counts and a ref, never a percentage, share or score', () => {
  let ctx;
  let env;
  const outputs = [];
  before(async () => {
    ctx = makeHome();
    // One repo per stock layout, plus a repo with unclassified names, plus the units fixture of the adapter.
    const repos = [];
    for (const [name, layout] of Object.entries(STOCK_LAYOUTS)) {
      const repo = join(ctx.home, 'src', `lay-${name}`);
      makeRepo(repo, { home: ctx.home, files: { 'README.md': `${name}\n` } });
      layout.build(repo, { home: ctx.home });
      repos.push(repo);
    }
    const rich = join(ctx.home, 'src', 'rich');
    makeRepo(rich, { home: ctx.home, files: { 'README.md': 'rich\n' } });
    writePlanningDir(rich, {
      under: 'phases', name: '01-a', files: { '01-01-PLAN.md': planText({ tier: 'B' }), '01-01-SUMMARY.md': planText({ tier: 'B' }), 'odd-note.md': '# n\n' },
    });
    repos.push(rich);
    buildUnitsHome({ home: ctx.home, root: ctx.root });
    env = cliEnv(ctx.home, { TZ: 'UTC', RIGORSCOPE_REPO_ROOTS: repos.join(':') });
    for (const [label, args] of [['ingest', ['ingest']], ['doctor', ['doctor']], ['units', ['units']], ['doctor-json', ['doctor', '--json']], ['units-json', ['units', '--json']]]) {
      const r = runCli(args, { home: ctx.home, env });
      assert.equal(r.status, 0, r.stderr);
      outputs.push([label, await transform(label, r.stdout)]);
    }
  });
  after(() => ctx.cleanup());

  const textOf = (label) => outputs.find(([l]) => l === label)[1];

  it('the scanned lines exist (the rich fixture reaches every section)', () => {
    assert.ok(scannedLines(textOf('ingest'), PREFIXES.ingest).some((l) => l.startsWith('classes: ')));
    assert.ok(scannedLines(textOf('ingest'), PREFIXES.ingest).some((l) => l.startsWith('locations: ')));
    assert.ok(scannedLines(textOf('units'), PREFIXES.units).some((l) => l.startsWith('repeats: ')));
    assert.ok(scannedLines(textOf('doctor'), PREFIXES.doctor).some((l) => l.startsWith('unclassified: ')));
  });

  it('no scanned text line holds a percent sign or a forbidden word', () => {
    const bad = [];
    for (const [label, key] of [['ingest', 'ingest'], ['units', 'units'], ['doctor', 'doctor']]) {
      for (const line of scannedLines(textOf(label), PREFIXES[key])) for (const v of violationsOf(line)) bad.push(`${label}: ${v}`);
    }
    assert.deepEqual(bad, []);
  });

  it('no JSON key or string of the fragments holds a percent sign or a forbidden word', () => {
    const doctor = JSON.parse(textOf('doctor-json'));
    const units = JSON.parse(textOf('units-json'));
    const fragments = [
      ['unclassified', doctor.unclassified], ['roster', doctor.roster], ['unit_locations', doctor.unit_locations],
      ['locations', units.locations], ['idRepeats', units.units.map((u) => u.idRepeats)],
    ].filter(([, v]) => v !== undefined);
    assert.ok(fragments.some(([k]) => k === 'unclassified') && fragments.some(([k]) => k === 'locations'));
    const bad = [];
    for (const [name, value] of fragments) for (const line of jsonLines(value, name)) for (const v of violationsOf(line)) bad.push(`${name}: ${v}`);
    assert.deepEqual(bad, []);
  });
});
