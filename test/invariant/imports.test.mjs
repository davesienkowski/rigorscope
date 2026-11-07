// Static import-boundary and no-network invariant over src/. The scanner is a pure function of
// (repo-relative file path, source text), so the self-tests can feed it synthetic offending files and
// prove each rule has teeth. Failures name the offending file and the rule, never file content.
//
// Rules:
//   sqlite     only src/db.mjs imports or dynamically imports the built-in sqlite module (ADR-0005)
//   network    no src file imports a network module or uses fetch, WebSocket or XMLHttpRequest (ADR-0002)
//   claude     no child-process call in src mentions claude within 300 characters of the call
//   renderer   src/report/render-*.mjs import only modules under src/measure/, sibling
//              src/report/render-*.mjs and node built-ins; a non-literal dynamic import or require fails
//   measure    modules under src/measure/ import only other src/measure/ modules and node built-ins
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));

// Removes block and line comments while leaving string and template literals intact (so a URL such
// as "http://x" inside a string is not mistaken for a comment).
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
    } else if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? n : end;
    } else if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

// Every literal module specifier in the text (static import and export-from, bare import, dynamic
// import and require with a string argument). A non-literal dynamic import or require is detected
// separately in scanSource.
export function specifiers(text) {
  const found = [];
  const staticRe = /(?:^|[\s;}])(?:import|export)\s[^'";]*?\bfrom\s*(['"])([^'"]+)\1|(?:^|[\s;}])import\s*(['"])([^'"]+)\3/g;
  for (const m of text.matchAll(staticRe)) found.push({ spec: m[2] ?? m[4], literal: true });
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*(['"])([^'"]*)\1\s*\)/g)) found.push({ spec: m[2], literal: true });
  return found;
}

const NET_MODULES = /^(?:node:)?(?:http|https|http2|net|dgram|tls|dns)(?:\/promises)?$/;
const isBuiltin = (spec) => spec.startsWith('node:') || BUILTINS.has(spec.split('/')[0]);

function resolveRel(file, spec) {
  return posix.normalize(posix.join(posix.dirname(file), spec));
}

// -> array of rule ids violated by `text` as the file `file` (repo-relative, forward slashes).
export function scanSource(file, rawText) {
  const text = stripComments(rawText);
  const out = new Set();
  const specs = specifiers(text);
  for (const { spec, literal } of specs) {
    if (!literal) continue;
    if (/^(?:node:)?sqlite$/.test(spec) && file !== 'src/db.mjs') out.add('sqlite');
    if (NET_MODULES.test(spec)) out.add('network');
  }
  if (/\b(?:fetch\s*\(|new\s+WebSocket\b|\bXMLHttpRequest\b)/.test(text)) out.add('network');
  for (const m of text.matchAll(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g)) {
    if (/\bclaude\b/.test(text.slice(m.index, m.index + 300))) out.add('claude');
  }
  const isRenderer = /^src\/report\/render-[^/]+\.mjs$/.test(file);
  const isMeasure = file.startsWith('src/measure/');
  if (isRenderer || isMeasure) {
    const rule = isRenderer ? 'renderer' : 'measure';
    if (/\b(?:import|require)\s*\(\s*[^'"\s)]/.test(text)) out.add(rule);
    for (const { spec, literal } of specs) {
      if (!literal) continue;
      if (isBuiltin(spec)) continue;
      if (spec.startsWith('.')) {
        const target = resolveRel(file, spec);
        if (target.startsWith('src/measure/')) continue;
        if (isRenderer && /^src\/report\/render-[^/]+\.mjs$/.test(target)) continue;
      }
      out.add(rule);
    }
  }
  return [...out].sort();
}

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p, base);
    return e.name.endsWith('.mjs') ? [p.slice(base.length).replace(/\\/g, '/')] : [];
  });
}

const srcFiles = () => walk(join(REPO, 'src')).map((f) => `src${f}`);
const violations = (rule) => srcFiles().filter((f) => scanSource(f, readFileSync(join(REPO, f), 'utf8')).includes(rule));

describe('scanner self-tests (each rule has teeth)', () => {
  it('sqlite: flags a static import, a dynamic import and a require outside src/db.mjs, allows src/db.mjs', () => {
    assert.deepEqual(scanSource('src/x.mjs', "import { DatabaseSync } from 'node:sqlite';"), ['sqlite']);
    assert.deepEqual(scanSource('src/x.mjs', "const m = await import('node:sqlite');"), ['sqlite']);
    assert.deepEqual(scanSource('src/x.mjs', "const m = require('node:sqlite');"), ['sqlite']);
    assert.deepEqual(scanSource('src/db.mjs', "import * as sqlite from 'node:sqlite';"), []);
  });

  it('network: flags every network module form, promises forms and the global network APIs', () => {
    for (const spec of ['node:http', 'node:https', 'node:http2', 'node:net', 'node:dgram', 'node:tls', 'node:dns', 'dns/promises', 'node:dns/promises', 'http']) {
      assert.deepEqual(scanSource('src/x.mjs', `import a from '${spec}';`), ['network'], spec);
    }
    assert.deepEqual(scanSource('src/x.mjs', 'const r = await fetch(u);'), ['network']);
    assert.deepEqual(scanSource('src/x.mjs', 'const w = new WebSocket(u);'), ['network']);
    assert.deepEqual(scanSource('src/x.mjs', 'const x = new XMLHttpRequest();'), ['network']);
    assert.deepEqual(scanSource('src/x.mjs', "import fs from 'node:fs';"), []);
  });

  it('claude: flags a child-process call that mentions claude and allows other binaries', () => {
    assert.deepEqual(scanSource('src/x.mjs', "spawn('claude', ['-p']);"), ['claude']);
    assert.deepEqual(scanSource('src/x.mjs', "execFileSync(cmd, ['--print', 'claude']);"), ['claude']);
    assert.deepEqual(scanSource('src/x.mjs', "execFileSync('git', ['status']);"), []);
    assert.deepEqual(scanSource('src/x.mjs', "const claude = 1; // no child process here"), []);
  });

  it('comments are stripped first, strings are kept', () => {
    assert.deepEqual(scanSource('src/x.mjs', "// import a from 'node:http';\n/* spawn('claude') */ const u = 'http://x';"), []);
  });

  it('renderer: allows a measure module, a second measure module, a sibling renderer and a node: built-in', () => {
    const f = 'src/report/render-text.mjs';
    for (const spec of ['../measure/measure.mjs', '../measure/stats.mjs', './render-evidence.mjs', 'node:path']) {
      assert.deepEqual(scanSource(f, `import a from '${spec}';`), [], spec);
    }
  });

  it('renderer: rejects the db, derive, ingest, a non-renderer report module, a bare package and a variable dynamic import', () => {
    const f = 'src/report/render-json.mjs';
    for (const spec of ['../db.mjs', '../derive/x.mjs', '../ingest/x.mjs', './cost.mjs', 'left-pad', '../sources/x.mjs']) {
      assert.deepEqual(scanSource(f, `import a from '${spec}';`), ['renderer'], spec);
    }
    assert.deepEqual(scanSource(f, 'const m = await import(name);'), ['renderer']);
    assert.deepEqual(scanSource(f, 'const m = require(name);'), ['renderer']);
  });

  it('measure layer: allows a sibling measure module and built-ins, rejects the db, report and derive layers', () => {
    const f = 'src/measure/measure.mjs';
    assert.deepEqual(scanSource(f, "import a from './stats.mjs'; import p from 'node:path';"), []);
    for (const spec of ['../db.mjs', '../report/x.mjs', '../derive/x.mjs']) {
      assert.deepEqual(scanSource(f, `import a from '${spec}';`), ['measure'], spec);
    }
  });

  it('rules do not leak across layers: a file outside report and measure may import anything local', () => {
    assert.deepEqual(scanSource('src/commands/x.mjs', "import a from '../db.mjs'; import b from './y.mjs';"), []);
  });
});

describe('import boundary over the real src tree', () => {
  it('src holds modules to scan', () => {
    assert.ok(srcFiles().length > 5);
  });

  it('only src/db.mjs imports the built-in sqlite module', () => {
    assert.deepEqual(violations('sqlite'), []);
  });

  it('no src file imports a network module or uses a global network API', () => {
    assert.deepEqual(violations('network'), []);
  });

  it('no src file starts a claude process', () => {
    assert.deepEqual(violations('claude'), []);
  });

  it('render-*.mjs files import only measure modules, sibling renderers and node built-ins', () => {
    assert.deepEqual(violations('renderer'), []);
  });

  it('modules under src/measure import only other measure modules and node built-ins', () => {
    assert.deepEqual(violations('measure'), []);
  });
});
