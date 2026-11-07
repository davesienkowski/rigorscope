// The deny-by-default OTel normalizer and the key helpers (plan 01-03, DATA-03, DATA-05, DATA-06).
// Result shape (documented in test/fixtures/otel.mjs): { type, row, reason, rejected, unknown, unknownToken, recordTs }.
// A result never carries line content: only the kept row, fixed reason names, rejected key names and
// shape-checked unknown names.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evAttrs, identityAttrs, resourceAttrs, OTEL_PLANTS } from '../fixtures/otel.mjs';

let N;
let K;
const ready = async () => {
  N = await import('../../src/sources/otel/normalize.mjs');
  K = await import('../../src/sources/otel/key.mjs');
};

const TS = '2026-10-27T12:00:01.000Z';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const event = (kind, extra = {}, { seq = 1, ts = TS, resource, over = {} } = {}) => ({
  ts, event: kind, attrs: evAttrs({ session: SESSION, seq, ts, name: kind, extra }), resource: resource ?? resourceAttrs(), ...over,
});
const metric = (name, value, extra = {}, { ts = TS, resource } = {}) => ({
  ts, metric: name, value, attrs: { ...identityAttrs(), 'session.id': SESSION, ...extra }, resource: resource ?? resourceAttrs(),
});
const rec = (obj) => N.normalizeOtelRecord(obj, {});
const attrsOf = (res) => JSON.parse(res.row.attrsJson);

describe('keys', () => {
  it('canonicalJson sorts keys recursively, has no whitespace and is stable under insertion order', async () => {
    await ready();
    assert.equal(K.canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    assert.equal(K.canonicalJson({ a: 1, b: 2 }), K.canonicalJson({ b: 2, a: 1 }));
  });

  it('sha256Hex is deterministic and matches the standard test vector', async () => {
    await ready();
    assert.equal(K.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(K.sha256Hex('abc'), K.sha256Hex('abc'));
  });

  it('eventKey carries the four normalized parts with the sequence as a decimal integer and a display string', async () => {
    await ready();
    const k = K.eventKey({ sessionId: 's', seq: 7, ts: TS, kind: 'api_request' });
    assert.deepEqual({ ...k }, { sessionId: 's', seq: 7, ts: TS, kind: 'api_request', display: `s|7|${TS}|api_request` });
  });

  it('metricBaseKey joins the timestamp, the metric name and the attribute hash', async () => {
    await ready();
    const k = K.metricBaseKey({ ts: TS, metric: 'm', attrsSha: 'abc' });
    assert.equal(typeof k, 'string');
    assert.ok(k.includes(TS) && k.includes('m') && k.includes('abc'));
    assert.notEqual(k, K.metricBaseKey({ ts: TS, metric: 'm', attrsSha: 'abd' }));
  });
});

describe('normalizeOtelLine', () => {
  it('blank and whitespace-only text is skipped', async () => {
    await ready();
    for (const t of ['', '   ', '\t', ' \r ']) assert.equal(N.normalizeOtelLine(t, {}, {}).type, 'skip');
  });

  it('unparseable text is reported without the parser message or any of the text', async () => {
    await ready();
    const res = N.normalizeOtelLine('{"ts": CANARY-broken {', {}, {});
    assert.equal(res.type, 'unparseable');
    const text = JSON.stringify(res);
    assert.ok(!text.includes('CANARY') && !/Unexpected|position|token/i.test(text));
  });

  it('a parsed line goes through the record normalizer', async () => {
    await ready();
    const res = N.normalizeOtelLine(JSON.stringify(event('api_request', { model: 'claude-opus-5-5' })), {}, {});
    assert.equal(res.type, 'event');
    assert.equal(res.row.kind, 'api_request');
  });
});

describe('events', () => {
  it('maps a valid api_request to a row with the four key fields, ids, version and sorted kept attrs', async () => {
    await ready();
    const res = rec(event('api_request', {
      model: 'claude-opus-5-5', input_tokens: 120, cost_usd: 0.0123, request_id: 'req-1', 'prompt.id': 'p-1', 'agent.name': 'gsd-executor',
    }));
    assert.equal(res.type, 'event');
    const { row } = res;
    assert.deepEqual({ sessionId: row.sessionId, seq: row.seq, eventTs: row.eventTs, kind: row.kind, tsUtc: row.tsUtc }, {
      sessionId: SESSION, seq: 1, eventTs: TS, kind: 'api_request', tsUtc: TS,
    });
    assert.deepEqual({ p: row.promptId, r: row.requestId, t: row.toolUseId, v: row.ccVersion }, { p: 'p-1', r: 'req-1', t: null, v: '2.1.309' });
    assert.equal(row.attrsJson, '{"agent.name":"gsd-executor","cost_usd":0.0123,"input_tokens":120,"model":"claude-opus-5-5","prompt.id":"p-1","request_id":"req-1"}');
    assert.equal(row.attrsSha, K.sha256Hex(row.attrsJson));
    assert.equal(res.recordTs, TS);
    assert.deepEqual(res.rejected, []);
    assert.deepEqual(res.unknown, []);
    assert.equal(res.unknownToken, null);
  });

  it('copies the tool use id of a tool_result and keeps the stored form of typed values', async () => {
    await ready();
    const res = rec(event('tool_result', { tool_name: 'Bash', tool_use_id: 'toolu_01', success: 'true', duration_ms: '-4', tool_input_size_bytes: '40' }));
    assert.equal(res.row.toolUseId, 'toolu_01');
    assert.deepEqual(attrsOf(res), { duration_ms: -4, success: true, tool_input_size_bytes: 40, tool_name: 'Bash', tool_use_id: 'toolu_01' });
  });

  it('a count given as 3 or "3", a bool as true or "true" and a duration as -4 or "-4" give the same attrs JSON and hash', async () => {
    await ready();
    const typed = rec(event('hook_execution_start', { num_hooks: 3, safe_mode: true, total_duration_ms: -4 }));
    const text = rec(event('hook_execution_start', { num_hooks: '3', safe_mode: 'true', total_duration_ms: '-4' }));
    assert.equal(typed.row.attrsJson, text.row.attrsJson);
    assert.equal(typed.row.attrsSha, text.row.attrsSha);
    assert.equal(typed.row.attrsJson, '{"num_hooks":3,"safe_mode":true,"total_duration_ms":-4}');
  });

  it('drops a line that cannot be keyed with one reason each: session_id, event_sequence, event_timestamp, event_name, ts, record_type', async () => {
    await ready();
    const cases = {
      session_id: event('api_request', {}, { over: { attrs: evAttrs({ session: undefined, seq: 1, ts: TS, name: 'api_request' }) } }),
      event_sequence: event('api_request', {}, { over: { attrs: evAttrs({ session: SESSION, seq: undefined, ts: TS, name: 'api_request' }) } }),
      event_timestamp: event('api_request', {}, { over: { attrs: evAttrs({ session: SESSION, seq: 1, ts: 'yesterday', name: 'api_request' }) } }),
      event_name: event('Bad Name'),
      ts: { ...event('api_request'), ts: undefined },
      record_type: { ts: TS, nothing: 1, attrs: {} },
    };
    for (const [reason, obj] of Object.entries(cases)) {
      const res = rec(JSON.parse(JSON.stringify(obj)));
      assert.equal(res.type, 'drop', reason);
      assert.equal(res.reason, reason);
      assert.equal(res.row, null);
      assert.equal(res.recordTs, null);
    }
    for (const bad of [null, 5, 'x', [1, 2]]) assert.equal(rec(bad).reason, 'record_type');
  });

  it('rejects a bad sequence: negative, fractional and boolean are dropped, the digit string "5" is accepted as 5', async () => {
    await ready();
    for (const seq of [-1, 1.5, true, 'x']) {
      const o = event('api_request', {}, { seq });
      assert.equal(rec(JSON.parse(JSON.stringify(o))).reason, 'event_sequence', String(seq));
    }
    assert.equal(rec(event('api_request', {}, { seq: '5' })).row.seq, 5);
  });

  it('an event.name attribute that disagrees with the top-level event is reported as header.event.name and the top-level value keys the row', async () => {
    await ready();
    const o = event('subagent_completed', { agent_type: 'gsd-executor' });
    o.attrs['event.name'] = 'subagent_stopped';
    const res = rec(o);
    assert.equal(res.row.kind, 'subagent_completed');
    assert.deepEqual(res.rejected, ['header.event.name']);
  });

  it('reports a value that fails its shape as <kind>.<key> and omits it, never carrying the value', async () => {
    await ready();
    const res = rec(event('api_request', {
      model: OTEL_PLANTS.hostileModel, 'agent.name': OTEL_PLANTS.hostileAgentName, input_tokens: -5, cost_usd: 'NaN', output_tokens: 3,
    }));
    assert.deepEqual([...res.rejected].sort(), ['api_request.agent.name', 'api_request.cost_usd', 'api_request.input_tokens', 'api_request.model']);
    assert.deepEqual(attrsOf(res), { output_tokens: 3 });
    assert.ok(!JSON.stringify(res).includes('CANARY'));
  });

  it('rejects non-finite, over-long and non-ASCII values and keeps nothing of them', async () => {
    await ready();
    const res = rec(event('api_request', { cost_usd: Infinity, model: 'café', request_id: 'x'.repeat(200), speed: 'a\nb' }));
    assert.deepEqual(attrsOf(res), {});
    assert.deepEqual([...res.rejected].sort(), ['api_request.cost_usd', 'api_request.model', 'api_request.request_id', 'api_request.speed']);
  });

  it('drops identity keys and terminal.type on every kind silently (no rejection, no unknown entry)', async () => {
    await ready();
    for (const kind of [...Object.keys(attrsByKind()), 'managed_settings_resolved', 'brand_new_event']) {
      const res = rec(event(kind, {}));
      assert.equal(res.type, 'event', kind);
      assert.deepEqual(res.rejected, [], kind);
      assert.ok(res.unknown.every((u) => !/user|organization|terminal/.test(u.name)), kind);
      const text = JSON.stringify(res);
      for (const v of Object.values(identityAttrs())) assert.ok(!text.includes(v), `${kind} leaks an identity value`);
    }
  });

  it('drops tool_parameters, tool_input, error, prompt, prompt_text, response and vcs.ref.head.name on every kind', async () => {
    await ready();
    const bad = {
      tool_parameters: OTEL_PLANTS.toolParameters, tool_input: OTEL_PLANTS.toolInput, error: OTEL_PLANTS.errorText,
      prompt: OTEL_PLANTS.promptText, prompt_text: OTEL_PLANTS.promptText, response: OTEL_PLANTS.responseText,
      'vcs.ref.head.name': OTEL_PLANTS.branchName,
    };
    for (const kind of [...Object.keys(attrsByKind()), 'managed_settings_resolved', 'brand_new_event']) {
      const res = rec(event(kind, bad));
      const text = JSON.stringify(res);
      for (const v of Object.values(bad)) assert.ok(!text.includes(v), `${kind} leaks a content value`);
      for (const k of Object.keys(bad)) assert.ok(!res.row.attrsJson.includes(`"${k}"`), `${kind} stores ${k}`);
      assert.ok(res.unknown.every((u) => !Object.hasOwn(bad, u.name)), `${kind} reports a dropped key as unknown`);
    }
  });

  it('reports unknown attribute names of a known kind by shape-checked name under scope = kind; a hostile name goes to the question-mark bucket', async () => {
    await ready();
    const res = rec(event('api_request', { brand_new_attr: 1, [OTEL_PLANTS.hostileKeyName]: 1, model: 'claude-opus-5-5' }));
    assert.deepEqual(res.unknown, [{ scope: 'api_request', name: 'brand_new_attr' }, { scope: 'api_request', name: '?' }]);
    assert.deepEqual(attrsOf(res), { model: 'claude-opus-5-5' });
  });

  it('a header-only kind keeps nothing and reports nothing: attrs is {}', async () => {
    await ready();
    const res = rec(event('managed_settings_resolved', { 'managed_settings.sources': ['a'], x: 'y' }));
    assert.equal(res.row.attrsJson, '{}');
    assert.deepEqual(res.unknown, []);
    assert.equal(res.unknownToken, null);
  });

  it('an unknown kind keeps nothing, records the kind and its key names, and flags a token-bearing record by name|version', async () => {
    await ready();
    const res = rec(event('brand_new_event', { input_tokens: 5, other_thing: 'v' }));
    assert.equal(res.row.attrsJson, '{}');
    assert.deepEqual(res.unknown, [
      { scope: 'event_kind', name: 'brand_new_event' }, { scope: 'brand_new_event', name: 'input_tokens' }, { scope: 'brand_new_event', name: 'other_thing' },
    ]);
    assert.equal(res.unknownToken, 'brand_new_event|2.1.309');
    const quiet = rec(event('brand_new_event', { other_thing: 'v' }));
    assert.equal(quiet.unknownToken, null);
  });

  it('kind names that are properties of Object.prototype are unknown kinds, not allowlist hits', async () => {
    await ready();
    const res = rec(event('constructor', { model: 'x' }));
    assert.equal(res.type, 'event');
    assert.equal(res.row.attrsJson, '{}');
    assert.deepEqual(res.unknown[0], { scope: 'event_kind', name: 'constructor' });
    assert.equal(rec(event('__proto__')).reason, 'event_name');
  });

  it('reads the version from resource service.version, reports other resource keys by name and ignores the noise keys', async () => {
    await ready();
    const res = rec(event('api_request', {}, { resource: resourceAttrs({ 'weird.resource.key': 'w', 'user.email': OTEL_PLANTS.userEmail }) }));
    assert.equal(res.row.ccVersion, '2.1.309');
    assert.deepEqual(res.unknown, [{ scope: 'resource', name: 'weird.resource.key' }]);
    const none = rec(event('brand_new_event', { input_tokens: 1 }, { resource: { 'service.version': 'not a version' } }));
    assert.equal(none.row.ccVersion, null);
    assert.equal(none.unknownToken, 'brand_new_event|?');
    assert.equal(rec(event('api_request', {}, { over: { resource: undefined } })).row.ccVersion, null);
  });

  it('inspects at most MAX_ATTR_KEYS attributes of a record', async () => {
    await ready();
    assert.equal(N.MAX_ATTR_KEYS, 256);
    const extra = {};
    for (let i = 0; i < 300; i += 1) extra[`k${i}`] = 1;
    extra.model = 'late-model';
    const res = rec(event('api_request', extra));
    assert.equal(res.unknown.length <= 256, true);
    assert.ok(!Object.hasOwn(attrsOf(res), 'model'), 'a key beyond the cap is not inspected');
  });

  it('non-ASCII and over-long attribute names fall into the question-mark bucket', async () => {
    await ready();
    const res = rec(event('api_request', { 'café': 1, ['x'.repeat(80)]: 1 }));
    assert.deepEqual(res.unknown.map((u) => u.name), ['?', '?']);
  });

  it('a result for a hostile line carries no plant anywhere', async () => {
    await ready();
    const res = rec(event('user_prompt', {
      prompt: OTEL_PLANTS.promptText, command_name: OTEL_PLANTS.hostileLabel, prompt_length: '55', [OTEL_PLANTS.hostileKeyName]: OTEL_PLANTS.nonAscii,
    }));
    const text = JSON.stringify(res);
    for (const v of Object.values(OTEL_PLANTS)) assert.ok(!text.includes(v), 'a plant is in the result');
  });
});

describe('metrics', () => {
  it('maps a metric to a row with value, session id, version, sorted attrs and a hash of the kept attrs', async () => {
    await ready();
    const res = rec(metric('claude_code.token.usage', 120, { model: 'claude-opus-5-5', type: 'input', language: 'Type Script, JS', 'agent.name': 'gsd-executor' }));
    assert.equal(res.type, 'metric');
    const { row } = res;
    assert.deepEqual({ ts: row.tsUtc, metric: row.metric, value: row.value, session: row.sessionId, v: row.ccVersion }, {
      ts: TS, metric: 'claude_code.token.usage', value: 120, session: SESSION, v: '2.1.309',
    });
    assert.equal(row.attrsJson, '{"agent.name":"gsd-executor","language":"Type Script, JS","model":"claude-opus-5-5","session.id":"' + SESSION + '","type":"input"}');
    assert.equal(row.attrsSha, K.sha256Hex(row.attrsJson));
    assert.equal(res.unknownToken, null);
    assert.equal(res.recordTs, TS);
  });

  it('identical attrs give the same hash and a different value does not change it', async () => {
    await ready();
    const a = rec(metric('claude_code.cost.usage', 0.5, { model: 'm' }));
    const b = rec(metric('claude_code.cost.usage', 0.7, { model: 'm' }));
    assert.equal(a.row.attrsSha, b.row.attrsSha);
  });

  it('drops a non-finite or non-numeric value (value), a bad name (metric_name) and a bad timestamp (ts)', async () => {
    await ready();
    assert.equal(rec(JSON.parse(JSON.stringify(metric('claude_code.token.usage', 'abc')))).reason, 'value');
    assert.equal(rec(JSON.parse(JSON.stringify(metric('claude_code.token.usage', NaN)))).reason, 'value');
    assert.equal(rec(metric('Bad Name', 1)).reason, 'metric_name');
    assert.equal(rec(metric('claude_code.token.usage', 1, {}, { ts: 'later' })).reason, 'ts');
  });

  it('reports rejected attribute values as metric.<key> and unknown attribute names under scope metric', async () => {
    await ready();
    const res = rec(metric('claude_code.token.usage', 7, { model: OTEL_PLANTS.hostileModel, language: OTEL_PLANTS.hostileLabel, brand_new_metric_attr: 'z' }));
    assert.deepEqual([...res.rejected].sort(), ['metric.language', 'metric.model']);
    assert.deepEqual(res.unknown, [{ scope: 'metric', name: 'brand_new_metric_attr' }]);
    assert.ok(!JSON.stringify(res).includes('CANARY'));
  });

  it('stores an unknown metric name and flags it: metric_name always, token-bearing when the name contains token or cost', async () => {
    await ready();
    const bonus = rec(metric('claude_code.token.bonus', 3));
    assert.equal(bonus.type, 'metric');
    assert.deepEqual(bonus.unknown, [{ scope: 'metric_name', name: 'claude_code.token.bonus' }]);
    assert.equal(bonus.unknownToken, 'claude_code.token.bonus|2.1.309');
    const cost = rec(metric('claude_code.cost.extra', 3));
    assert.equal(cost.unknownToken, 'claude_code.cost.extra|2.1.309');
    const quiet = rec(metric('claude_code.widget.count', 3));
    assert.deepEqual(quiet.unknown, [{ scope: 'metric_name', name: 'claude_code.widget.count' }]);
    assert.equal(quiet.unknownToken, null);
    assert.equal(rec(metric('claude_code.session.count', 1)).unknown.length, 0);
  });

  it('drops identity keys and terminal.type from metric attrs silently', async () => {
    await ready();
    const res = rec(metric('claude_code.session.count', 1, { start_type: 'fresh' }));
    for (const v of Object.values(identityAttrs())) assert.ok(!JSON.stringify(res).includes(v));
    assert.deepEqual(res.unknown, []);
  });
});

// A map kind -> true for the kinds the fixtures use; only the keys are read.
function attrsByKind() {
  return Object.fromEntries(['api_request', 'api_error', 'tool_result', 'tool_decision', 'hook_execution_start', 'user_prompt',
    'assistant_response', 'subagent_completed', 'mcp_server_connection', 'plugin_loaded'].map((k) => [k, true]));
}
