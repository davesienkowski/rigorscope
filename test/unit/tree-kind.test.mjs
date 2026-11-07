// Tree-kind helper (plan 09-03, decisions 1 and 2): a shipped test reaches a file that exists only in the maintainer's
// checkout through privateRef(id), which reads the marker file `.planning/private-refs.json` of a given repo root. No
// marker file means a public tree: privateRef returns null and the private-only assertions skip with a visible reason.
// A marker with a missing target or a malformed body throws, so a broken private tree fails instead of skipping.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPrivateTree, privateRef, skipUnlessPrivate } from '../helpers/tree-kind.mjs';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});
function root({ refs, files = [], planning = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tree-kind-'));
  dirs.push(dir);
  if (planning) mkdirSync(join(dir, '.planning'));
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), 'x\n');
  }
  if (refs !== undefined) writeFileSync(join(dir, '.planning', 'private-refs.json'), typeof refs === 'string' ? refs : JSON.stringify(refs));
  return dir;
}

describe('privateRef and isPrivateTree', () => {
  it('returns the absolute path when the marker names an existing target', () => {
    const r = root({ refs: { doc: 'notes/a.md' }, files: ['notes/a.md'] });
    assert.equal(isPrivateTree(r), true);
    assert.equal(privateRef('doc', r), join(r, 'notes', 'a.md'));
  });

  it('throws when the marker names a missing target (a private tree fails, never skips)', () => {
    const r = root({ refs: { doc: 'notes/a.md' } });
    assert.throws(() => privateRef('doc', r), /private ref target missing/);
  });

  it('throws for an id the marker does not name', () => {
    const r = root({ refs: { doc: 'notes/a.md' }, files: ['notes/a.md'] });
    assert.throws(() => privateRef('other', r), /private ref unknown/);
  });

  it('returns null and is not a private tree without the marker, even with a .planning directory', () => {
    const r = root({});
    assert.equal(isPrivateTree(r), false);
    assert.equal(privateRef('doc', r), null);
    const bare = root({ planning: false });
    assert.equal(isPrivateTree(bare), false);
    assert.equal(privateRef('doc', bare), null);
  });

  it('throws for a malformed marker: bad JSON, a non-object body, a non-string or unsafe path', () => {
    for (const refs of ['{', '[]', '"x"', { doc: 3 }, { doc: '/abs/path' }, { doc: '../up' }, { doc: 'a/../../up' }, { doc: '' }]) {
      const r = root({ refs });
      assert.throws(() => privateRef('doc', r), /private refs malformed/, JSON.stringify(refs));
    }
  });
});

describe('skipUnlessPrivate', () => {
  it('is false in a private tree and the visible reason in a public tree', () => {
    const priv = root({ refs: { doc: 'a.md' }, files: ['a.md'] });
    assert.equal(skipUnlessPrivate('doc', priv), false);
    assert.equal(skipUnlessPrivate('doc', root({})), 'private tree only: doc');
  });
});
