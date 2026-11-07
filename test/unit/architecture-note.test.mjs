// Machine check of docs/architecture.md: it states design decisions in neutral wording, so it carries no decision-record
// number or path, no planning path, only ASCII, and stays near its target size of 80 lines.
// The forbidden strings are joined from parts so this file does not hold them as text. Private names are not listed here;
// the export gate scans for them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../docs/architecture.md', import.meta.url), 'utf8');
const TARGET = 80;
const SLACK = 0.4;

const FORBIDDEN = [
  ['an ADR number', ['ADR', '-'].join('')],
  ['an ADR path', ['adr', '/'].join('')],
  ['a planning path', ['.plan', 'ning/'].join('')],
];

// -> the list of problems of one page text (empty when it passes).
export function problems(text) {
  const out = [];
  for (const [label, needle] of FORBIDDEN) if (text.includes(needle)) out.push(label);
  if (/[^\x00-\x7f]/.test(text)) out.push('a non-ASCII character');
  if (text.includes('—')) out.push('an em dash');
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (lines > TARGET * (1 + SLACK)) out.push('more than 140 percent of the target size');
  if (lines < TARGET * (1 - SLACK)) out.push('less than 60 percent of the target size');
  return out;
}

describe('docs/architecture.md', () => {
  it('passes every check', () => {
    assert.deepEqual(problems(PAGE), []);
  });

  it('is within 40 percent of 80 lines', () => {
    const lines = PAGE.split('\n').length - 1;
    assert.ok(lines >= 48 && lines <= 112, `${lines} lines`);
  });

  for (const [label, needle] of FORBIDDEN) {
    it(`the check fails on a page with ${label}`, () => {
      const base = PAGE.trimEnd().split('\n');
      assert.deepEqual(problems(PAGE), []);
      assert.ok(problems(`${base.join('\n')}\nsee ${needle}x\n`).includes(label));
    });
  }

  it('the check fails on a non-ASCII character, an em dash, a page of 140 lines and a page of 20 lines', () => {
    const base = PAGE.trimEnd();
    assert.ok(problems(`${base}\ncafé\n`).includes('a non-ASCII character'));
    assert.ok(problems(`${base}\nx — y\n`).includes('an em dash'));
    assert.ok(problems(`${'line\n'.repeat(140)}`).some((p) => p.startsWith('more than')));
    assert.ok(problems(`${'line\n'.repeat(20)}`).some((p) => p.startsWith('less than')));
  });
});
