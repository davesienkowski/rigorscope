// Plan 02-02 (D-09, D-24, UNIT-02): the phase 1 directory-layout repo rule is retired. The cost report's `repo` comes
// from the git common dir resolved at ingest (src/units/repo-resolve.mjs), the same key the units use. This file was
// plan 01-08's test of the layout module src/derive/repo.mjs; it now proves that module is gone, that no layout
// literal is left in the modules that decide or print a repo, and covers the two pure helpers of the resolver.
// Written before the code (RED).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandStoredDir, repoNameOf } from '../../src/units/repo-resolve.mjs';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const SCANNED = ['derive', 'units', 'adapters', 'report'];
// The two phase 1 prefixes, built from fragments so this file holds neither literal.
const LAYOUT = [new RegExp(['~', 'repos', ''].join('\\/')), new RegExp(['wsroot', 'workspaces'].join('\\/'))];

function mjsFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return mjsFiles(p);
    return e.name.endsWith('.mjs') ? [p] : [];
  });
}

// Non-comment lines: drops // line comments and lines inside /* */ blocks (a coarse strip is enough for this scan).
function codeLines(text) {
  const out = [];
  let inBlock = false;
  for (const raw of text.split('\n')) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }
    const start = line.indexOf('/*');
    if (start >= 0 && line.indexOf('*/', start) < 0) { inBlock = true; line = line.slice(0, start); }
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*')) continue;
    out.push(line);
  }
  return out;
}

describe('the layout rule is retired', () => {
  it('src/derive/repo.mjs does not exist', () => {
    assert.equal(existsSync(join(SRC, 'derive', 'repo.mjs')), false);
  });

  it('no non-comment line under src/derive, src/units, src/adapters or src/report holds a home-layout prefix', () => {
    const files = SCANNED.flatMap((d) => mjsFiles(join(SRC, d)));
    assert.ok(files.length > 10);
    const hits = [];
    for (const f of files) {
      for (const line of codeLines(readFileSync(f, 'utf8'))) {
        if (LAYOUT.some((re) => re.test(line))) hits.push(f.slice(SRC.length));
      }
    }
    assert.deepEqual(hits, []);
  });
});

describe('expandStoredDir', () => {
  const H = ['', 'h', 'u s#er'].join('/');
  const cases = [
    ['~', H],
    ['~/a/b', `${H}/a/b`],
    ['~/a/b/', `${H}/a/b`],
    [['', 'srv', 'x'].join('/'), ['', 'srv', 'x'].join('/')],
    ['~win/x', null],
    ['~other/x', null],
    ['relative/x', null],
    ['~/../x', null],
    ['~/a/./b', null],
    ['', null],
    [null, null],
    [42, null],
  ];
  for (const [stored, want] of cases) {
    it(`${JSON.stringify(stored)} expands to ${want === null ? 'null' : 'a path'}`, () => {
      assert.equal(expandStoredDir(stored, H), want);
    });
  }
});

describe('repoNameOf', () => {
  const cases = [
    ['/x/alpha/.git', 'alpha'],
    ['/x/alpha/.git/', 'alpha'],
    ['/x/tools.git', 'tools'],
    ['/x/plain', 'plain'],
    ['/x/My.Repo_1-x/.git', 'My.Repo_1-x'],
    [`/x/${'a'.repeat(64)}/.git`, 'a'.repeat(64)],
    [`/x/${'a'.repeat(65)}/.git`, null],
    ['/x/my repo/.git', null],
    ['/x/.hidden/.git', null],
    ['', null],
    [null, null],
  ];
  for (const [dir, want] of cases) {
    it(`${JSON.stringify(dir).slice(0, 40)} names ${want === null ? 'nothing' : want.slice(0, 12)}`, () => {
      assert.equal(repoNameOf(dir), want);
    });
  }
});
