// Plan 01-08 (TRUST-04, D-08): the strict row-key codec. Written before the code (RED).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTIONS, buildRowKey, buildTotalKey, encodeKeyValue, parseRowKey,
} from '../../src/measure/rowkey.mjs';

const DIMS = ['role', 'model', 'effort', 'day', 'session', 'repo'];
const throwsRange = (fn) => assert.throws(fn, (e) => e instanceof RangeError && /^[ -~]+$/.test(e.message));

describe('encodeKeyValue', () => {
  it('leaves the unreserved set alone', () => assert.equal(encodeKeyValue('Aa09._:~-'), 'Aa09._:~-'));
  it('encodes every other byte with upper-case hex', () => {
    assert.equal(encodeKeyValue('a b/c=d?e%'), 'a%20b%2Fc%3Dd%3Fe%25');
  });
  it('encodes a multi-byte character as its UTF-8 bytes', () => {
    assert.equal(encodeKeyValue('café'), 'caf%C3%A9'); // U+00E9 is C3 A9
    assert.equal(encodeKeyValue('☃'), '%E2%98%83'); // snowman is E2 98 83
  });
  it('maps null to the question mark and a literal question mark to %3F', () => {
    assert.equal(encodeKeyValue(null), '?');
    assert.equal(encodeKeyValue('?'), '%3F');
  });
  it('rejects a non-string, non-null value', () => {
    for (const v of [1, undefined, {}, true]) throwsRange(() => encodeKeyValue(v));
  });
});

describe('buildRowKey and buildTotalKey', () => {
  it('joins the section and the dimension pairs with slashes', () => {
    assert.equal(buildRowKey('main', [['role', 'main'], ['model', 'claude-haiku-5-5'], ['repo', null]]), 'main/role=main/model=claude-haiku-5-5/repo=?');
  });
  it('builds the total key', () => assert.equal(buildTotalKey('otel'), 'otel/total'));
  it('rejects an unknown section', () => throwsRange(() => buildTotalKey('Main')));
  it('SECTIONS is the frozen list main, otel, harness', () => {
    assert.deepEqual([...SECTIONS], ['main', 'otel', 'harness']);
    assert.equal(Object.isFrozen(SECTIONS), true);
  });
});

describe('parseRowKey', () => {
  it('parses a total key', () => {
    assert.deepEqual(parseRowKey('harness/total', DIMS), { section: 'harness', total: true, pairs: [] });
  });
  it('parses pairs, decodes values, maps ? to null and %3F to a literal question mark', () => {
    assert.deepEqual(parseRowKey('main/role=Explore/repo=?/model=a%3Fb/effort=%3F', DIMS), {
      section: 'main', total: false, pairs: [['role', 'Explore'], ['repo', null], ['model', 'a?b'], ['effort', '?']],
    });
  });
  it('decodes multi-byte values strictly', () => {
    assert.deepEqual(parseRowKey('main/role=caf%C3%A9', DIMS).pairs, [['role', 'café']]);
  });
  it('build then parse is the identity for awkward values', () => {
    const values = ['a b', 'x/y', 'q=r', '100%', '☃', '?', 'plain', ':~-._', 'café/ü'];
    for (const v of values) {
      const key = buildRowKey('otel', [['role', v], ['day', '2026-11-01']]);
      assert.deepEqual(parseRowKey(key, DIMS).pairs, [['role', v], ['day', '2026-11-01']]);
    }
  });
  const bad = {
    'unknown section': 'bogus/total', 'section is case-sensitive': 'Main/total', 'section alone': 'main', 'trailing slash': 'main/role=x/',
    'leading slash': '/main/total', 'total with trailing slash': 'main/total/', 'unknown dimension': 'main/unknown=x',
    'duplicate dimension': 'main/role=a/role=b', 'empty value': 'main/role=', 'missing equals': 'main/role', 'lower-case hex': 'main/role=%7e',
    'truncated escape': 'main/role=%7', 'invalid utf-8': 'main/role=%FF', 'truncated utf-8': 'main/role=%C3', 'total with pairs': 'main/total/role=x',
    'pair before total': 'main/role=x/total', 'space': 'main/role=a b', 'tab': 'main/role=a\tb', 'newline': 'main/role=a\nb', 'delete character': 'main/role=a\u007fb',
    'raw equals in value': 'main/role=a=b', 'empty key': '', 'over-long key': `main/role=${'x'.repeat(520)}`,
    'seven pairs': 'main/role=1/model=2/effort=3/day=4/session=5/repo=6/role=7', 'empty segment': 'main//role=x', 'sql text': "main/role=x'; DROP TABLE api_call; --",
  };
  for (const [name, key] of Object.entries(bad)) {
    it(`rejects ${name}`, () => throwsRange(() => parseRowKey(key, DIMS)));
  }
  it('rejects a non-string', () => {
    for (const v of [null, undefined, 5, {}, ['main/total']]) throwsRange(() => parseRowKey(v, DIMS));
  });
  it('validates dimension names against the allowed list it is given', () => {
    throwsRange(() => parseRowKey('main/repo=x', ['role', 'model']));
    assert.deepEqual(parseRowKey('main/role=x', ['role']).pairs, [['role', 'x']]);
  });
  it('all errors share one fixed message that never echoes the key', () => {
    const msgs = new Set(Object.values(bad).map((k) => { try { parseRowKey(k, DIMS); } catch (e) { return e.message; } return null; }));
    assert.equal(msgs.size, 1);
    assert.equal(typeof [...msgs][0], 'string', 'every bad key throws');
    assert.equal(String([...msgs][0]).includes('DROP'), false);
  });
});

// Plan 02-07 (D-19, UNIT-01): unit and link evidence ids. The module is imported dynamically so this file still loads
// and runs its row-key tests before the new exports exist (RED).
describe('unit and link evidence ids (plan 02-07)', () => {
  const mod = () => import('../../src/measure/rowkey.mjs');
  const KEYS = ['gsd-core:~/repos/alpha/.git:quick:261001-q1a', 'gsd-core:~/a b/.git:plan:03-01', 'gsd-core:~/café/.git:quick:x'];
  it('buildUnitEvidenceId round-trips through parseEvidenceId for keys with /, ~, :, a space and a non-ASCII character', async () => {
    const { buildUnitEvidenceId, parseEvidenceId, UNIT_ID_PREFIX } = await mod();
    assert.equal(UNIT_ID_PREFIX, 'u:');
    for (const k of KEYS) {
      const id = buildUnitEvidenceId(k);
      assert.ok(id.startsWith('u:') && !id.slice(2).includes('/'));
      assert.deepEqual(parseEvidenceId(id, DIMS), { kind: 'unit', unitKey: k });
    }
    assert.equal(buildUnitEvidenceId(KEYS[0]), 'u:gsd-core:~%2Frepos%2Falpha%2F.git:quick:261001-q1a');
  });
  it('buildLinkEvidenceId has two segments after l: for a main-thread scope and three for a subagent scope, and round-trips', async () => {
    const { buildLinkEvidenceId, parseEvidenceId, LINK_ID_PREFIX } = await mod();
    assert.equal(LINK_ID_PREFIX, 'l:');
    const main = buildLinkEvidenceId(KEYS[1], 'sess one', '');
    assert.equal(main.slice(2).split('/').length, 2);
    assert.deepEqual(parseEvidenceId(main, DIMS), {
      kind: 'link', unitKey: KEYS[1], sessionId: 'sess one', agentId: '',
    });
    const sub = buildLinkEvidenceId(KEYS[2], 's/1', 'agent:x');
    assert.equal(sub.slice(2).split('/').length, 3);
    assert.deepEqual(parseEvidenceId(sub, DIMS), {
      kind: 'link', unitKey: KEYS[2], sessionId: 's/1', agentId: 'agent:x',
    });
  });
  it('a row key parses exactly as parseRowKey does', async () => {
    const { parseEvidenceId } = await mod();
    assert.deepEqual(parseEvidenceId('main/role=x', DIMS), { kind: 'row', ...parseRowKey('main/role=x', DIMS) });
    assert.deepEqual(parseEvidenceId('main/total', DIMS), { kind: 'row', ...parseRowKey('main/total', DIMS) });
  });
  it('empty, over-long, control-character, bad-escape, empty-segment and extra-segment ids throw one fixed message', async () => {
    const { parseEvidenceId } = await mod();
    const bad = ['u:', 'l:', `u:${'a'.repeat(1030)}`, 'u:a\u0001b', 'u:%ZZ', 'u:a/b', 'l:a', 'l:a/', 'l:a//b', 'l:a/b/c/d', 'u:%C3', 'l:%ZZ/b'];
    const msgs = new Set();
    for (const id of bad) {
      assert.throws(() => parseEvidenceId(id, DIMS), (e) => e instanceof RangeError && /^[ -~]+$/.test(e.message), id);
      try { parseEvidenceId(id, DIMS); } catch (e) { msgs.add(e.message); }
    }
    assert.equal(msgs.size, 1);
    assert.equal([...msgs][0].includes('ZZ'), false);
    for (const id of ['x:abc', 'U:abc', '']) throwsRange(() => parseEvidenceId(id, DIMS));
  });
});
