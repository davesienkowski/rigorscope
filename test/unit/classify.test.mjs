// Line classification (D-04). Written before src/sources/transcript/classify.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const load = () => import(new URL('../../src/sources/transcript/classify.mjs', import.meta.url).href);
const item = (text) => ({ buf: Buffer.from(text, 'utf8'), oversized: false });
const PLANT = 'CANARY-secret-value';

describe('classifyLine', () => {
  it('treats a line holding the assistant marker as a candidate', async () => {
    const { classifyLine } = await load();
    assert.deepEqual({ ...classifyLine(item('{"type":"assistant","message":{}}')) }, { action: 'candidate' });
    assert.equal(classifyLine(item('{"uuid":"u","type":"assistant"}')).action, 'candidate');
  });

  it('skips an empty line', async () => {
    const { classifyLine } = await load();
    assert.deepEqual({ ...classifyLine(item('')) }, { action: 'skip', reason: 'empty' });
  });

  it('routes a known non-token type by its head pattern without parsing (a broken body is not unparseable)', async () => {
    const { classifyLine } = await load();
    const r = classifyLine(item('{"type":"user", this is not json'));
    assert.deepEqual({ ...r }, { action: 'skip', reason: 'type', type: 'user' });
  });

  it('exports the known non-token types and the deferred types', async () => {
    const { KNOWN_NON_TOKEN_TYPES, DEFERRED_TOKEN_TYPES } = await load();
    for (const t of ['attachment', 'user', 'system', 'bridge-session', 'queue-operation', 'ai-title', 'started', 'result']) {
      assert.ok(KNOWN_NON_TOKEN_TYPES.includes(t), t);
    }
    assert.deepEqual([...DEFERRED_TOKEN_TYPES], ['cost-state']);
  });

  it('counts a cost-state record with token keys as deferred, and one without token keys as a skipped type', async () => {
    const { classifyLine } = await load();
    assert.deepEqual({ ...classifyLine(item('{"type":"cost-state","m":{"input_tokens":1}}')) }, { action: 'deferred', type: 'cost-state' });
    assert.deepEqual({ ...classifyLine(item('{"type":"cost-state","m":{}}')) }, { action: 'skip', reason: 'type', type: 'cost-state' });
  });

  it('counts an unknown typed record with a token key as unknown token-bearing, with its type and version', async () => {
    const { classifyLine } = await load();
    const r = classifyLine(item('{"type":"mystery-usage","version":"2.9.9","usage":{"input_tokens":5,"output_tokens":6}}'));
    assert.deepEqual({ ...r }, { action: 'unknown', type: 'mystery-usage', version: '2.9.9' });
  });

  it('puts an unsafe type name or version into the question-mark bucket and never echoes it', async () => {
    const { classifyLine } = await load();
    const r = classifyLine(item(`{"type":"bad ${PLANT}@x","version":"${PLANT}","u":{"input_tokens":1}}`));
    assert.equal(r.action, 'unknown');
    assert.equal(r.type, '?');
    assert.equal(r.version, '?');
    assert.ok(!JSON.stringify(r).includes(PLANT));
  });

  it('reports an unknown type whose body cannot be parsed with the question-mark version', async () => {
    const { classifyLine } = await load();
    const r = classifyLine(item('{"type":"mystery-usage","u":{"input_tokens":1'));
    assert.deepEqual({ ...r }, { action: 'unknown', type: 'mystery-usage', version: '?' });
  });

  it('skips an unknown typed record that carries no token key', async () => {
    const { classifyLine } = await load();
    assert.deepEqual({ ...classifyLine(item('{"type":"brand-new","x":1}')) }, { action: 'skip', reason: 'type', type: 'brand-new' });
  });

  it('parses an ambiguous line (no head type, token key present) once to read its type', async () => {
    const { classifyLine } = await load();
    const r = classifyLine(item('{"uuid":"u","type":"user","message":{"content":"quote input_tokens here"}}'));
    assert.deepEqual({ ...r }, { action: 'skip', reason: 'type', type: 'user' });
    const unk = classifyLine(item('{"uuid":"u","type":"mystery-usage","version":"3.0.1","usage":{"output_tokens":2}}'));
    assert.deepEqual({ ...unk }, { action: 'unknown', type: 'mystery-usage', version: '3.0.1' });
  });

  it('skips an untyped line with a token key whose parse fails, and an untyped line without token keys', async () => {
    const { classifyLine } = await load();
    assert.deepEqual({ ...classifyLine(item('{"uuid":"u","x":"input_tokens" broken')) }, { action: 'skip', reason: 'untyped' });
    assert.deepEqual({ ...classifyLine(item('{"uuid":"u","x":1}')) }, { action: 'skip', reason: 'untyped' });
  });

  it('detects each of the four token key strings', async () => {
    const { classifyLine } = await load();
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      const r = classifyLine(item(`{"type":"mystery-usage","version":"1.0.0","u":{"${key}":1}}`));
      assert.equal(r.action, 'unknown', key);
    }
  });

  it('counts an oversized item with its head type and never parses it', async () => {
    const { classifyLine } = await load();
    const big = { oversized: true, head: Buffer.from('{"type":"assistant","pad":"AAAA'), size: 300000 };
    assert.deepEqual({ ...classifyLine(big) }, { action: 'oversized', type: 'assistant' });
    const blind = { oversized: true, head: Buffer.from('{"pad":"AAAA'), size: 300000 };
    assert.deepEqual({ ...classifyLine(blind) }, { action: 'oversized', type: '?' });
  });
});

describe('classifyType', () => {
  it('is the shared routing a parsed candidate uses when it turns out not to be an assistant record', async () => {
    const { classifyType } = await load();
    assert.deepEqual({ ...classifyType('user', true) }, { action: 'skip', reason: 'type', type: 'user' });
    assert.deepEqual({ ...classifyType('cost-state', true) }, { action: 'deferred', type: 'cost-state' });
    assert.deepEqual({ ...classifyType('weird', true, '1.2.3') }, { action: 'unknown', type: 'weird', version: '1.2.3' });
    assert.deepEqual({ ...classifyType('weird', false) }, { action: 'skip', reason: 'type', type: 'weird' });
    assert.equal(classifyType('weird', true).version, '?');
  });
});

// Plan 02-04 (D-14, amendment Q5): a user line holding the `<command-name>` tag is routed to the command picker. The
// branch runs after the assistant marker and the usage-report check and before the token checks; any other head type
// keeps its old routing, and a result still never carries line content.
describe('classifyLine: the command-name branch (plan 02-04)', () => {
  const TAG = '<command-name>/gsd-quick</command-name>';

  it('a user line holding the command-name tag is classified command', async () => {
    const { classifyLine } = await load();
    const r = classifyLine(item(`{"type":"user","uuid":"u","message":{"role":"user","content":"${TAG}"}}`));
    assert.deepEqual({ ...r }, { action: 'command', type: 'user' });
    const headless = classifyLine(item(`{"uuid":"u","type":"user","message":{"content":"${TAG} input_tokens"}}`));
    assert.deepEqual({ ...headless }, { action: 'command', type: null });
  });

  it('keeps the assistant marker and the usage-report routing ahead of the tag', async () => {
    const { classifyLine } = await load();
    assert.deepEqual({ ...classifyLine(item(`{"type":"assistant","message":{"content":"${TAG}"}}`)) }, { action: 'candidate' });
    const report = `{"type":"system","subtype":"local_command","usageReport":{},"content":"${TAG}"}`;
    assert.deepEqual({ ...classifyLine(item(report)) }, { action: 'usage_report' });
  });

  it('routes a line holding the tag with another head type exactly as before', async () => {
    const { classifyLine } = await load();
    assert.deepEqual({ ...classifyLine(item(`{"type":"system","content":"${TAG}"}`)) }, { action: 'skip', reason: 'type', type: 'system' });
    const unk = classifyLine(item(`{"type":"mystery-usage","version":"1.0.0","content":"${TAG}","u":{"input_tokens":1}}`));
    assert.deepEqual({ ...unk }, { action: 'unknown', type: 'mystery-usage', version: '1.0.0' });
  });

  it('a broken user line without the tag is still a skipped user line', async () => {
    const { classifyLine } = await load();
    assert.deepEqual({ ...classifyLine(item('{"type":"user", this is not json')) }, { action: 'skip', reason: 'type', type: 'user' });
  });
});
