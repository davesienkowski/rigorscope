// Static read guard for the main Claude Code config file (plan 01-06, D-11a, T-01-50 to T-01-53). The
// scanner is a pure function of source text, so the self-tests feed it synthetic offending snippets and prove
// each rule has teeth. Comments are stripped before the usage rules are scanned; failures name the file and
// the rule, never file content.
//
// Rules for every file under src/sources/usage:
//   hash        no hashing, hmac, digest, subtle-digest or random-byte facility, no crypto import
//   enumerate   no enumeration of keys, entries or values, no for-in loop, no spread, no Object.assign
//   serialize   no JSON serializer
//   output      no console and no write to a standard stream
//   message     never reads an error object's message property
//   cursor      never names source_file, source_root or unknown_attr, never calls a cursor or hash helper or
//               the unknown-name mechanism (ctx.attr)
// Rules over all of src:
//   single-reader  the literal file name .claude.json occurs in non-comment text of exactly one file,
//                  src/sources/usage/cache.mjs
//   identity       no file (comments included) names the account-id key, the oauth account block or the
//                  email key. No earlier plan's drop list names one (checked when this test was written), so
//                  there is no exact-path allowance.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(REPO, 'src');
const USAGE_DIR = join(SRC, 'sources', 'usage');
const CACHE_READER = 'src/sources/usage/cache.mjs';

// Removes block and line comments while leaving string and template literals intact (a copy of the
// scanner helper in test/invariant/imports.test.mjs; importing a test file would re-register its tests).
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

const USAGE_RULES = Object.freeze({
  hash: /(?:['"](?:node:)?crypto['"]|\bcreateHash\b|\bcreateHmac\b|\bhash|\bhmac\b|\bdigest\b|\bsubtle\b|\brandomBytes\b|\brandomUUID\b|\bgetRandomValues\b)/i,
  enumerate: /(?:\bObject\s*\.\s*(?:keys|entries|values|getOwnPropertyNames|getOwnPropertyDescriptors|getOwnPropertySymbols|assign|fromEntries)\b|\bReflect\s*\.\s*ownKeys\b|\bfor\s*\([^;)]*\bin\b|\.\.\.|\bstructuredClone\b)/,
  serialize: /\bJSON\s*\.\s*stringify\b/,
  output: /(?:\bconsole\b|\bprocess\s*\.\s*(?:stdout|stderr)\b|\bemitWarning\b|\bwriteSync\s*\(\s*[12]\b)/,
  message: /\.\s*message\b/,
  cursor: /(?:\bsource_file\b|\bsource_root\b|\bunknown_attr\b|\bwindowHash\b|\bstatIdentity\b|\bdecideStart\b|\bctx\s*\.\s*attr\b)/,
});
const IDENTITY = /(?:accountUuid|oauthAccount|emailAddress)/;
const FILE_NAME = '.claude.json';

// -> array of rule ids violated by a file under src/sources/usage.
export function scanUsageText(rawText) {
  const text = stripComments(rawText);
  return Object.entries(USAGE_RULES).filter(([, re]) => re.test(text)).map(([id]) => id);
}

const mentionsFileName = (rawText) => stripComments(rawText).includes(FILE_NAME);
const mentionsIdentity = (rawText) => IDENTITY.test(rawText);

function listMjs(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listMjs(p));
    else if (name.endsWith('.mjs')) out.push(p);
  }
  return out;
}
const rel = (p) => relative(REPO, p).split(sep).join('/');

describe('usage read guard: the usage source exists and obeys the rules', () => {
  it('the directory src/sources/usage and its cache.mjs exist', () => {
    assert.ok(existsSync(USAGE_DIR), 'src/sources/usage exists');
    assert.ok(existsSync(join(REPO, CACHE_READER)), 'the cache reader exists');
  });

  it('no file under src/sources/usage hashes, enumerates, serializes, prints, reads an error message or names a cursor table', () => {
    const files = listMjs(USAGE_DIR);
    assert.ok(files.length >= 1, 'at least one usage file is scanned');
    const bad = files.map((f) => [rel(f), scanUsageText(readFileSync(f, 'utf8'))]).filter(([, ids]) => ids.length > 0);
    assert.deepEqual(bad, []);
  });

  it('exactly one src file, the cache reader, names the cache file outside comments', () => {
    const named = listMjs(SRC).filter((f) => mentionsFileName(readFileSync(f, 'utf8'))).map(rel);
    assert.deepEqual(named, [CACHE_READER]);
  });

  it('no src file names the account-id key, the oauth account block or the email key', () => {
    const named = listMjs(SRC).filter((f) => mentionsIdentity(readFileSync(f, 'utf8'))).map(rel);
    assert.deepEqual(named, []);
  });
});

describe('usage read guard self-tests: every rule has teeth', () => {
  const offending = {
    hash: [
      "import { createHash } from 'node:crypto';",
      "const c = await import('crypto');",
      'const h = createHmac(k);',
      'crypto.subtle.digest(x);',
      'const id = randomUUID();',
      'const fingerprint = hashOf(buf);',
    ],
    enumerate: [
      'for (const k of Object.keys(o)) n += 1;',
      'Object.entries(o).length;',
      'Object.values(o);',
      'for (const k in o) n += 1;',
      'const copy = { ...o };',
      'Reflect.ownKeys(o);',
      'Object.assign({}, o);',
    ],
    serialize: ['const s = JSON.stringify(parsed);', 'JSON .stringify(x)'],
    output: ['console.log(x);', 'process.stderr.write(x);', 'process.stdout.write(x);'],
    message: ['catch (err) { return err.message; }', 'const m = e . message;'],
    cursor: [
      "db.prepare('SELECT * FROM source_file');",
      "const t = 'source_root';",
      'insert into unknown_attr',
      'windowHash(p, 0, 10);',
      'statIdentity(p);',
      'decideStart(a, b, c);',
      "ctx.attr('scope', name);",
    ],
  };
  for (const [rule, snippets] of Object.entries(offending)) {
    it(`rule ${rule} fires on each of its ${snippets.length} offending snippets`, () => {
      for (const [i, s] of snippets.entries()) assert.ok(scanUsageText(s).includes(rule), `snippet ${i} of ${rule}`);
    });
  }

  it('a comment that mentions a banned facility does not fire, and clean pick code passes every rule', () => {
    assert.deepEqual(scanUsageText('// never hash, never JSON.stringify, never console.log\nconst a = 1;'), []);
    assert.deepEqual(scanUsageText('const u = c.utilization; const w = u === null ? null : u.five_hour; for (const x of list) n += 1;'), []);
  });

  it('the single-reader and identity rules fire on synthetic text and ignore a comment for the file name', () => {
    assert.ok(mentionsFileName("const f = '.claude.json';"));
    assert.ok(!mentionsFileName('// reads ~/.claude.json\nconst f = name;'));
    assert.ok(mentionsIdentity('// accountUuid'));
    assert.ok(mentionsIdentity("const k = 'emailAddress';"));
    assert.ok(mentionsIdentity('o.oauthAccount'));
    assert.ok(!mentionsIdentity('const account = 1;'));
  });
});
