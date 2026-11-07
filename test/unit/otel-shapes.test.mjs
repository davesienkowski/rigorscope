// Shape checkers shared by the OTel normalizer (plan 01-03, DATA-05, RR-03). A shape checker returns the
// normalized value or undefined; every stored string passes one, so free text never rides through a
// kept key.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The module is imported inside each test (ready), so a missing module fails each test with ERR_MODULE_NOT_FOUND
// (the authored RED shape; a failing hook would cancel the run instead).
let SHAPE_KINDS;
let checkShape;
const ready = async () => {
  ({ SHAPE_KINDS, checkShape } = await import('../../src/redact/shapes.mjs'));
};

const ok = (kind, value, expected = value) => assert.strictEqual(checkShape(kind, value), expected, `${kind} accepts ${JSON.stringify(value)}`);
const no = (kind, value) => assert.strictEqual(checkShape(kind, value), undefined, `${kind} rejects ${JSON.stringify(value)}`);

describe('shapes: the kinds', () => {
  it('lists exactly the eleven shape kinds', async () => {
    await ready();
    assert.deepEqual([...SHAPE_KINDS].sort(), ['bool', 'count', 'hex', 'id', 'iso', 'label', 'money', 'ms', 'name', 'pattern', 'version']);
  });

  it('an unknown kind rejects everything', async () => {
    await ready();
    no('nope', 'x');
    no('constructor', 'x');
  });
});

describe('shapes: strings', () => {
  it('iso accepts UTC timestamps with 0 to 9 fraction digits and rejects offsets, dates and free text', async () => {
    await ready();
    ok('iso', '2026-10-27T12:00:01.000Z');
    ok('iso', '2026-10-27T12:00:01Z');
    ok('iso', '2026-10-27T12:00:01.123456789Z');
    no('iso', '2026-10-27T12:00:01+00:00');
    no('iso', '2026-10-27');
    no('iso', 'yesterday');
    no('iso', '2026-10-27T12:00:01.0000000000Z');
  });

  it('id accepts 1 to 128 characters of letters, digits and . _ : - and rejects spaces, slashes and 129 characters', async () => {
    await ready();
    ok('id', 'req-e1');
    ok('id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    ok('id', 'a'.repeat(128));
    no('id', 'a'.repeat(129));
    no('id', '');
    no('id', 'a b');
    no('id', 'a/b');
    no('id', 'a@b.invalid');
  });

  it('name accepts a leading alphanumeric then . _ : / - up to 64 characters', async () => {
    await ready();
    ok('name', 'claude-opus-5-5');
    ok('name', 'PreToolUse:Bash');
    ok('name', 'gsd-executor');
    ok('name', 'plugin/skill.v2');
    no('name', '-leading');
    no('name', 'has space');
    no('name', 'a'.repeat(65));
    no('name', 'model-CANARY-mail@canary-example.invalid');
    no('name', 'CANARY agent spaced tok-CANARYsecret77');
  });

  it('label accepts up to four short words with a comma and rejects an equals sign, an at sign and a fifth word', async () => {
    await ready();
    ok('label', 'Type Script, JS');
    ok('label', 'C-sharp');
    ok('label', 'one two three four');
    no('label', 'one two three four five');
    no('label', 'CANARY=label@host');
    no('label', 'a'.repeat(65));
    no('label', ' leading');
    no('label', 'trailing ');
    no('label', 'two  spaces');
  });

  it('pattern accepts a tool-name regex and rejects spaces, quotes, slashes and equals signs', async () => {
    await ready();
    ok('pattern', '^(Bash|mcp__.+)$');
    ok('pattern', 'Edit|Write');
    ok('pattern', '*');
    no('pattern', 'has space');
    no('pattern', 'a/b');
    no('pattern', 'a="b"');
    no('pattern', 'a'.repeat(121));
    no('pattern', '');
  });

  it('hex accepts 7 to 64 lowercase hex digits', async () => {
    await ready();
    ok('hex', 'abc123abc123abc123abc123abc123abc123abc1');
    ok('hex', 'abcdef0');
    no('hex', 'abcde');
    no('hex', 'ABCDEF0');
    no('hex', 'g'.repeat(40));
    no('hex', 'a'.repeat(65));
  });

  it('version accepts dotted numbers with an optional short suffix', async () => {
    await ready();
    ok('version', '2.1.309');
    ok('version', '2.1');
    ok('version', '1.2.3.4');
    ok('version', '2.1.309-beta.1');
    no('version', '2');
    no('version', 'v2.1.3');
    no('version', '2.1.3 beta');
    no('version', '2.1.3-' + 'a'.repeat(17));
  });
});

describe('shapes: numbers and booleans', () => {
  it('count accepts safe non-negative integers and digit strings, returning a number', async () => {
    await ready();
    ok('count', 3);
    ok('count', '3', 3);
    ok('count', 0);
    ok('count', '0012', 12);
    no('count', -1);
    no('count', '-1');
    no('count', 1.5);
    no('count', '1.5');
    no('count', '1e3');
    no('count', Number.MAX_SAFE_INTEGER + 1);
    no('count', '9'.repeat(17));
    no('count', NaN);
    no('count', Infinity);
    no('count', ' 3');
  });

  it('ms accepts finite numbers up to 1e12 in magnitude and numeric strings, including negatives', async () => {
    await ready();
    ok('ms', 1500);
    ok('ms', -4);
    ok('ms', '-4', -4);
    ok('ms', '12.5', 12.5);
    ok('ms', 1e12);
    no('ms', 1e12 + 1);
    no('ms', '1e3');
    no('ms', NaN);
    no('ms', -Infinity);
    no('ms', '');
    no('ms', '12.1234567');
  });

  it('money accepts finite numbers from 0 to 1e6 and rejects strings', async () => {
    await ready();
    ok('money', 0);
    ok('money', 0.0123);
    ok('money', 1e6);
    no('money', -0.01);
    no('money', 1e6 + 1);
    no('money', 'NaN');
    no('money', '1.5');
    no('money', NaN);
    no('money', Infinity);
  });

  it('bool accepts booleans and the exact strings true and false', async () => {
    await ready();
    ok('bool', true);
    ok('bool', false);
    ok('bool', 'true', true);
    ok('bool', 'false', false);
    no('bool', 'True');
    no('bool', 1);
    no('bool', 0);
    no('bool', 'yes');
  });
});

describe('shapes: rejects everything that is not a primitive of the right type', () => {
  it('null, undefined, arrays, objects, functions and symbols are rejected by every kind', async () => {
    await ready();
    for (const kind of SHAPE_KINDS) {
      for (const v of [null, undefined, [], ['a'], {}, { a: 1 }, () => 1, Symbol('x')]) no(kind, v);
    }
  });

  it('non-ASCII text is rejected by every string kind, so decoded plants cannot be stored', async () => {
    await ready();
    for (const kind of ['iso', 'id', 'name', 'label', 'pattern', 'hex', 'version']) no(kind, 'café');
    no('name', 'a☃');
    no('id', 'a\u0000b');
    no('name', 'a\nb');
  });

  it('equal typed and string forms normalize to one value (count, bool, ms)', async () => {
    await ready();
    assert.strictEqual(checkShape('count', 3), checkShape('count', '3'));
    assert.strictEqual(checkShape('bool', true), checkShape('bool', 'true'));
    assert.strictEqual(checkShape('ms', -4), checkShape('ms', '-4'));
  });
});
