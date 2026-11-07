// Prohibition (plan 09-06, P9-08 g; ADR-0005): rigorscope has zero npm dependencies. package.json holds no `dependencies`,
// `devDependencies`, `optionalDependencies` or `peerDependencies` block, and no file under src/, bin/, scripts/ or test/
// imports a bare package name (everything is a `node:` builtin or a relative or absolute path). The checkers take text and a
// directory as arguments so each is shown to fail on planted input before it judges the real tree. A text scan: an import
// built from fragments at run time is not seen (the same limit as the other prohibition scans).
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCANNED = ['src', 'bin', 'scripts', 'test'];
const SKIP_DIRS = new Set(['node_modules', 'fixtures']);
const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const SELF = fileURLToPath(import.meta.url);

// -> the dependency blocks a parsed package.json holds.
export const dependencyBlocks = (pkg) => DEP_KEYS.filter((k) => Object.hasOwn(pkg, k));

// -> the bare specifiers imported in a source text: static imports and re-exports and side-effect imports that start a line (so a
// string or a comment that quotes an import is not read as one), and import() and require() with a literal.
export function bareImports(text) {
  const specs = [];
  const inString = (index) => {
    const prefix = text.slice(text.lastIndexOf('\n', index - 1) + 1, index);
    return ['"', "'", '`'].some((q) => (prefix.split(q).length - 1) % 2 === 1);
  };
  const forms = [
    /^[ \t]*(?:import|export)\s[^;'"`]*?\sfrom\s*['"]([^'"]+)['"]/gm,
    /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  forms.forEach((re, i) => { for (const m of text.matchAll(re)) if (i < 2 || !inString(m.index)) specs.push(m[1]); });
  return specs.filter((s) => !/^(?:node:|\.{1,2}(?:\/|$)|\/|file:|data:)/.test(s));
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(?:mjs|cjs|js)$/.test(e.name) || e.name === 'rigorscope') out.push(p);
  }
  return out;
}

// -> ['<repo-relative path>', ...] of files that import a bare name.
export function filesWithBareImports(root, dirs = SCANNED, skip = new Set()) {
  return scanBareImports(root, dirs, skip).hits;
}

// -> { hits, scanned }: scanned counts the files actually read, so a scan that found nothing because it read nothing shows as 0.
export function scanBareImports(root, dirs = SCANNED, skip = new Set()) {
  const hits = [];
  let scanned = 0;
  for (const d of dirs) {
    let files = [];
    try { files = walk(join(root, d)); } catch { continue; }
    for (const f of files) {
      if (skip.has(f)) continue;
      scanned++;
      if (bareImports(readFileSync(f, 'utf8')).length > 0) hits.push(relative(root, f).split('\\').join('/'));
    }
  }
  return { hits, scanned };
}

it('a package.json with a dependency block fails, one without passes', () => {
  assert.deepEqual(dependencyBlocks({ name: 'x', dependencies: { a: '1' } }), ['dependencies']);
  assert.deepEqual(dependencyBlocks({ name: 'x', devDependencies: {} }), ['devDependencies']);
  assert.deepEqual(dependencyBlocks({ name: 'x', optionalDependencies: {}, peerDependencies: {} }), ['optionalDependencies', 'peerDependencies']);
  assert.deepEqual(dependencyBlocks({ name: 'x', scripts: { test: 'node --test' } }), []);
});

it('bareImports sees every import form of a bare name and passes node:, relative and absolute paths', () => {
  const bad = [
    "import x from 'left-pad';", "import { a, b } from \"lodash/fp\";", "import 'side-effect';", "export * from 'pkg';",
    "export { a } from '@scope/pkg';", "const m = await import('dyn-pkg');", "const r = require('old-pkg');", "import fs from 'fs';",
    "import {\n  a,\n  b,\n} from 'multi-line';", "  import y from 'indented';",
  ];
  for (const t of bad) assert.equal(bareImports(t).length, 1, t);
  const good = [
    "import fs from 'node:fs';", "import { a } from './a.mjs';", "import b from '../b.mjs';", "import c from '/abs/c.mjs';",
    "import d from 'file:///x/d.mjs';", "const m = await import('node:sqlite');", "const r = require('./r.cjs');", "// import x from 'left-pad'",
    "const s = `import a from '${spec}';`;", "  \"const c = await import('crypto');\",", "it('no sqlite import');\n// the same imports must stay",
  ];
  for (const t of good) assert.equal(bareImports(t).length, 0, t);
});

it('a temp tree with a source importing a bare name is reported, a clean one is not', () => {
  const root = mkdtempSync(join(tmpdir(), 'rigorscope-nodeps-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test', 'fixtures'), { recursive: true });
    writeFileSync(join(root, 'src', 'ok.mjs'), "import { a } from 'node:fs';\nimport b from './b.mjs';\n");
    assert.deepEqual(filesWithBareImports(root), []);
    writeFileSync(join(root, 'src', 'bad.mjs'), "import x from 'left-pad';\n");
    writeFileSync(join(root, 'test', 'fixtures', 'skipped.mjs'), "import x from 'left-pad';\n");
    assert.deepEqual(filesWithBareImports(root), ['src/bad.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('a root with missing directories reports zero files scanned, and a skipped file is not counted', () => {
  const root = mkdtempSync(join(tmpdir(), 'rigorscope-nodeps-'));
  try {
    assert.deepEqual(scanBareImports(root), { hits: [], scanned: 0 });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.mjs'), "import b from './b.mjs';\n");
    writeFileSync(join(root, 'src', 'self.mjs'), "import b from './b.mjs';\n");
    assert.equal(scanBareImports(root).scanned, 2);
    assert.equal(scanBareImports(root, SCANNED, new Set([join(root, 'src', 'self.mjs')])).scanned, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('the real package.json has no dependency block and no file of src, bin, scripts or test imports a bare name', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.deepEqual(dependencyBlocks(pkg), []);
  const real = scanBareImports(REPO, SCANNED, new Set([SELF]));
  assert.deepEqual(real.hits, []);
  assert.ok(real.scanned > 0, 'the real tree scan read at least one file');
  // SELF is excluded from the scan: it quotes bare imports as planted input. Scanning without the exclusion reads one more file.
  assert.equal(scanBareImports(REPO, SCANNED).scanned, real.scanned + 1, 'SELF is among the files excluded from the scan');
});
