// No golden commit id resolves in any repository (plan 09-03, decision 6). The golden files carry synthetic ids: hex runs
// of 40 or more characters built from a repeated short counter, so they hold at most 6 distinct hex characters, where a real
// SHA-1 holds about 16. The scorer reads files, artifacts and commit times, never an id; this test guards the data.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOLDEN = fileURLToPath(new URL('./', import.meta.url));
const MAX_DISTINCT = 6;

// Named files only: the isolation prohibition (test/prohibitions) forbids listing this directory
// and naming the held-out label file. The 40-character ids live in the snapshot; the held-out labels carry short ids only,
// and the public-cut gate (hex40, private-commit-id) reads every file of the directory.
const FILES = [['inputs', 'inputs.jsonl'], ['inputs', 'manifest.json'], ['units.jsonl'], ['README.md']].map((p) => join(GOLDEN, ...p));

// -> the number of hex runs of 40+ characters with more than MAX_DISTINCT distinct characters (case-insensitive).
export function realShapedIds(text) {
  let n = 0;
  for (const m of text.matchAll(/[0-9a-fA-F]{40,}/g)) if (new Set(m[0].toLowerCase()).size > MAX_DISTINCT) n += 1;
  return n;
}

// Standalone 12-hex tokens (short commit ids) must be synthetic: four zeros, four digits, four zeros. A real short id that happens to be
// all digits slips past the 40-character check above. -> the 1-based line numbers of the offending tokens.
const SHORT_ID = /(?<![0-9a-f])[0-9a-f]{12}(?![0-9a-f])/g;
export function nonSyntheticShortIdLines(text) {
  const lines = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(SHORT_ID)) if (!/^0000[0-9]{4}0000$/.test(m[0])) lines.push(i + 1);
  });
  return lines;
}

// Named files only (isolation prohibition: no directory listing, no naming of the held-out label file; the held-out
// file gets the same check inside its one allowed reader).
const SHORT_ID_FILES = [...FILES, ...['score.mjs', 'golden.test.mjs', 'golden-ids.test.mjs'].map((n) => join(GOLDEN, n))];

it('every standalone 12-hex token in the golden data, README and scorer is a synthetic id of the zeros-digits-zeros form', () => {
  const offenders = SHORT_ID_FILES.flatMap((f) => nonSyntheticShortIdLines(readFileSync(f, 'utf8')).map((n) => `${f.slice(GOLDEN.length)}:${n}`));
  assert.deepEqual(offenders, [], 'non-synthetic 12-hex tokens (file:line)');
});

it('the short-id check flags a real-shaped all-digit or mixed token and passes the synthetic form', () => {
  assert.deepEqual(nonSyntheticShortIdLines(`a\n"${['1234', '5678', '9012'].join('')}"`), [2]);
  assert.deepEqual(nonSyntheticShortIdLines(`"${['9fce', 'b02d', '0ae5'].join('')}"`), [1]);
  assert.deepEqual(nonSyntheticShortIdLines('"000011550000" "0000111100001" x'), []);
});

it('no golden data file or the README holds a real-shaped hex run of 40 or more characters', () => {
  const offenders = FILES.filter((f) => realShapedIds(readFileSync(f, 'utf8')) > 0).length;
  assert.equal(offenders, 0, 'files with a real-shaped id');
});

it('the check counts a real-shaped lower-case or upper-case id in a copy of the snapshot and passes the shipped file', () => {
  const text = readFileSync(join(GOLDEN, 'inputs', 'inputs.jsonl'), 'utf8');
  assert.equal(realShapedIds(text), 0);
  // Built from fragments so this source holds no real-shaped run itself.
  const real = ['9fceb02d', '0ae598e9', '5dc970b7', '4767f193', '72d61af8'].join('');
  assert.equal(realShapedIds(`${text}"${real}"`), 1);
  assert.equal(realShapedIds(`${text}"${real.toUpperCase()}"`), 1);
  assert.equal(realShapedIds(`${text}"${'0123450123'.repeat(4)}"`), 0, 'a synthetic id passes');
});
