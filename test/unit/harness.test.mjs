// Plan 01-07 Task 2: query_source rules and the full role precedence (COST-02, COST-03, D-06). Written before
// src/derive/query-source.mjs and resolveFullRole (RED). Comparison is byte for byte everywhere: no trimming, no
// case folding, no normalization.
//
// resolveFullRole({ attribution, metaType, agentId, querySource }) -> { role, rule, source, meta, conflict, qsRole, qsConflict }
//   harness (one of six query sources) > attribution > meta > transcript main > query_source parse
//   (agent:builtin:<Name>) > query_source main (repl_main_thread, repl_main_thread:...) > unknown
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const qsMod = await import(new URL('../../src/derive/query-source.mjs', import.meta.url).href);
const roleMod = await import(new URL('../../src/derive/role.mjs', import.meta.url).href);
const {
  HARNESS_SOURCES, SDK_SOURCE, QS_SHAPE, AGENT_NAME_SHAPE, isHarnessSource, harnessRole, parseQuerySourceRole, isMainThreadSource,
  safeQuerySource, safeAgentName,
} = qsMod;
const { resolveRole, resolveFullRole, FULL_ROLE_RULES } = roleMod;

const full = (attribution, metaType, agentId, querySource) => ({ ...resolveFullRole({ attribution, metaType, agentId, querySource }) });
const R = (role, rule, source, meta, conflict, qsRole, qsConflict) => ({ role, rule, source, meta, conflict, qsRole, qsConflict });
const NON_STRINGS = [null, undefined, 0, 1, true, {}, [], Symbol.iterator];
const SIX = ['agent_summary', 'prompt_suggestion', 'web_fetch_apply', 'web_search_tool', 'generate_session_title', 'away_summary'];

describe('query-source constants', () => {
  it('HARNESS_SOURCES is exactly the six pure-harness sources, frozen', () => {
    assert.ok(Array.isArray(HARNESS_SOURCES), 'an array');
    assert.deepEqual([...HARNESS_SOURCES], SIX);
    assert.ok(Object.isFrozen(HARNESS_SOURCES));
  });

  it('SDK_SOURCE is sdk and is not a harness source', () => {
    assert.equal(SDK_SOURCE, 'sdk');
    assert.equal(isHarnessSource('sdk'), false);
    assert.ok(!HARNESS_SOURCES.includes?.('sdk'));
  });

  it('the shapes are anchored regular expressions', () => {
    assert.ok(QS_SHAPE instanceof RegExp && AGENT_NAME_SHAPE instanceof RegExp, 'two RegExp shapes');
    assert.ok(QS_SHAPE.source.startsWith('^') && QS_SHAPE.source.endsWith('$'));
    assert.ok(AGENT_NAME_SHAPE.source.startsWith('^') && AGENT_NAME_SHAPE.source.endsWith('$'));
  });
});

describe('isHarnessSource and harnessRole', () => {
  it('each of the six sources is a harness source and gives the role harness:<source>', () => {
    for (const s of SIX) {
      assert.equal(isHarnessSource(s), true, s);
      assert.equal(harnessRole(s), `harness:${s}`);
    }
  });

  it('membership is byte-exact: case, prefix, suffix and padding miss', () => {
    for (const s of ['Agent_summary', 'AGENT_SUMMARY', 'agent_summary ', ' agent_summary', 'agent_summary:x', 'agent_summar', 'xagent_summary', 'web_search', 'repl_main_thread']) {
      assert.equal(isHarnessSource(s), false, s);
      assert.equal(harnessRole(s), null, s);
    }
  });

  it('non-strings are never harness sources', () => {
    for (const v of NON_STRINGS) {
      assert.equal(isHarnessSource(v), false);
      assert.equal(harnessRole(v), null);
    }
  });
});

describe('parseQuerySourceRole', () => {
  it('returns the name of agent:builtin:<Name> for a shape-valid name', () => {
    for (const [qs, name] of [
      ['agent:builtin:Explore', 'Explore'], ['agent:builtin:general-purpose', 'general-purpose'],
      ['agent:builtin:claude-code-guide', 'claude-code-guide'], ['agent:builtin:a.b_c-1', 'a.b_c-1'], ['agent:builtin:9x', '9x'],
      [`agent:builtin:${'a'.repeat(64)}`, 'a'.repeat(64)],
    ]) assert.equal(parseQuerySourceRole(qs), name, qs);
  });

  it('gives no role for agent:custom, an empty name, a bad character, 65 characters or another prefix case', () => {
    for (const qs of [
      'agent:custom', 'agent:builtin:', 'agent:builtin:Ex plore', 'agent:builtin:a@b', 'agent:builtin:a:b', 'agent:builtin:-lead',
      `agent:builtin:${'a'.repeat(65)}`, 'Agent:builtin:Explore', 'agent:Builtin:Explore', 'agent:builtin', 'agent:plugin:x',
      'sdk', 'repl_main_thread', '',
    ]) assert.equal(parseQuerySourceRole(qs), null, qs);
  });

  it('non-strings give no role', () => {
    for (const v of NON_STRINGS) assert.equal(parseQuerySourceRole(v), null);
  });
});

describe('isMainThreadSource', () => {
  it('is true for repl_main_thread and any value beginning repl_main_thread:', () => {
    for (const qs of ['repl_main_thread', 'repl_main_thread:outputStyle:Explanatory', 'repl_main_thread:']) assert.equal(isMainThreadSource(qs), true, qs);
  });

  it('is false for near misses and non-strings', () => {
    for (const qs of ['repl_main_threadX', 'repl_main_thread_x', 'Repl_main_thread', ' repl_main_thread', 'main', 'sdk']) assert.equal(isMainThreadSource(qs), false, qs);
    for (const v of NON_STRINGS) assert.equal(isMainThreadSource(v), false);
  });
});

describe('safeQuerySource and safeAgentName', () => {
  it('safeQuerySource keeps a shape-valid value byte for byte', () => {
    for (const v of ['sdk', 'agent:builtin:Explore', 'repl_main_thread:outputStyle:Explanatory', 'a', `a${'b'.repeat(95)}`]) assert.equal(safeQuerySource(v), v);
  });

  it('safeQuerySource drops a bad first character, a bad character, an over-long value and non-strings', () => {
    for (const v of ['', '1sdk', ':sdk', 'sdk tool', 'CANARY=label@host', 'a/b', `a${'b'.repeat(96)}`, 'café']) assert.equal(safeQuerySource(v), null, JSON.stringify(v.length));
    for (const v of NON_STRINGS) assert.equal(safeQuerySource(v), null);
  });

  it('safeAgentName keeps a shape-valid name and drops spaces, colons, an at sign, 65 characters and non-strings', () => {
    for (const v of ['Explore', 'general-purpose', 'custom', '9lives', 'a.b_c']) assert.equal(safeAgentName(v), v);
    for (const v of ['', 'two words', 'a:b', 'a@b', '-x', `${'a'.repeat(65)}`, 'trail ']) assert.equal(safeAgentName(v), null);
    for (const v of NON_STRINGS) assert.equal(safeAgentName(v), null);
  });
});

describe('resolveFullRole precedence', () => {
  it('FULL_ROLE_RULES lists the rules in precedence order', () => {
    assert.deepEqual([...(FULL_ROLE_RULES ?? [])], ['harness', 'attribution', 'meta', 'main', 'query_source', 'query_source_main', 'none']);
  });

  it('resolveFullRole: a harness source overrides attribution and meta, attribution beats meta, meta beats the query_source parse', () => {
    assert.deepEqual(full('fork', 'general-purpose', 'agent1', 'agent_summary'), R('harness:agent_summary', 'harness', 'otel', 'general-purpose', 1, null, null));
    assert.deepEqual(full('fork', 'general-purpose', 'agent1', 'agent:builtin:general-purpose'), R('fork', 'attribution', 'transcript', 'general-purpose', 1, 'general-purpose', 1));
    assert.deepEqual(full(null, 'Explore', 'agent1', 'agent:builtin:Plan'), R('Explore', 'meta', 'transcript', 'Explore', null, 'Plan', 1));
  });

  it('transcript main beats the query_source parse; the parse beats query_source main', () => {
    assert.deepEqual(full(null, null, '', 'agent:builtin:Explore'), R('main', 'main', 'derived', null, null, 'Explore', 1));
    assert.deepEqual(full(null, null, 'agent1', 'agent:builtin:claude-code-guide'), R('claude-code-guide', 'query_source', 'otel', null, null, 'claude-code-guide', null));
    assert.deepEqual(full(null, null, null, 'repl_main_thread'), R('main', 'query_source_main', 'otel', null, null, null, null));
    assert.deepEqual(full(null, null, null, 'repl_main_thread:outputStyle:Explanatory'), R('main', 'query_source_main', 'otel', null, null, null, null));
  });

  it('nothing left gives unknown with rule none and source unavailable', () => {
    assert.deepEqual(full(null, null, null, 'agent:custom'), R('unknown', 'none', 'unavailable', null, null, null, null));
    assert.deepEqual(full(null, null, 'agent1', null), R('unknown', 'none', 'unavailable', null, null, null, null));
    assert.deepEqual(full(null, null, null, 'repl_main_threadX'), R('unknown', 'none', 'unavailable', null, null, null, null));
  });

  it('sdk is no harness source: with agentId null it is unknown, with agentId empty it is transcript main', () => {
    assert.deepEqual(full(null, null, null, 'sdk'), R('unknown', 'none', 'unavailable', null, null, null, null));
    assert.deepEqual(full(null, null, '', 'sdk'), R('main', 'main', 'derived', null, null, null, null));
    assert.deepEqual(full('gsd-planner', null, 'agent1', 'sdk'), R('gsd-planner', 'attribution', 'transcript', null, null, null, null));
  });

  it('an agentId of null or undefined is never main', () => {
    assert.equal(full(null, null, null, null).role, 'unknown');
    assert.equal(full(null, null, undefined, null).role, 'unknown');
    assert.equal(full(null, null, '', null).role, 'main');
  });

  it('qsConflict is 0 when the parsed role equals the transcript role, null for harness and query_source rules', () => {
    assert.equal(full(null, 'Explore', 'agent1', 'agent:builtin:Explore').qsConflict, 0);
    assert.equal(full('fork', null, 'agent1', 'agent:builtin:fork').qsConflict, 0);
    assert.equal(full(null, null, 'agent1', 'agent:builtin:Explore').qsConflict, null);
    assert.equal(full('Explore', null, 'agent1', 'web_search_tool').qsConflict, null);
  });

  it('names are compared byte for byte: case, a trailing space and decomposed accents differ', () => {
    assert.equal(full(null, 'Explore', 'agent1', 'agent:builtin:explore').qsConflict, 1);
    assert.equal(full('Explore ', null, 'agent1', 'agent:builtin:Explore').qsConflict, 1);
    assert.equal(full('café', null, 'agent1', 'agent:builtin:Explore').role, 'café');
  });

  it('a non-string or unshaped query source adds no role and no harness', () => {
    for (const qs of [null, 1, {}, 'agent_summary ', 'AGENT_SUMMARY']) {
      assert.deepEqual(full(null, null, 'agent1', qs), R('unknown', 'none', 'unavailable', null, null, null, null), String(qs));
    }
  });

  it('back-compatibility: without a query source resolveFullRole equals resolveRole plus two null fields', () => {
    const table = [
      ['fork', 'general-purpose', 'agent1'], ['gsd-verifier', 'gsd-verifier', 'agent1'], ['gsd-executor', null, 'agent1'],
      [null, 'Explore', 'agent1'], [null, null, ''], ['custom-agent', null, ''], [null, null, 'agent1'], ['', 'Explore', 'agent1'],
      [null, 'Explore', ''], [null, '', 'agent1'], [null, null, null], [null, 'Explore', null], [undefined, undefined, undefined],
    ];
    for (const [a, m, id] of table) {
      const base = { ...resolveRole({ attribution: a, metaType: m, agentId: id }) };
      assert.deepEqual({ ...resolveFullRole({ attribution: a, metaType: m, agentId: id }) }, { ...base, qsRole: null, qsConflict: null });
    }
  });

  it('precedence table over the otel-join fixture calls', () => {
    // [attribution, metaType, agentId, querySource] -> [role, rule, source, qsRole, qsConflict]
    const table = [
      [[null, null, '', 'repl_main_thread'], ['main', 'main', 'derived', null, null]], //                       A
      [[null, 'Explore', 'agentbbbb00000021', 'agent:builtin:Explore'], ['Explore', 'meta', 'transcript', 'Explore', 0]], // B
      [['fork', 'general-purpose', 'agentcccc00000022', 'agent:builtin:general-purpose'], ['fork', 'attribution', 'transcript', 'general-purpose', 1]], // C
      [[null, null, 'agentdddd00000023', 'agent:builtin:claude-code-guide'], ['claude-code-guide', 'query_source', 'otel', 'claude-code-guide', null]], // D
      [[null, 'gsd-executor', 'agenteeee00000024', 'agent:custom'], ['gsd-executor', 'meta', 'transcript', null, null]], // E
      [[null, null, '', 'sdk'], ['main', 'main', 'derived', null, null]], //                                   G
      [[null, null, null, 'agent_summary'], ['harness:agent_summary', 'harness', 'otel', null, null]], //       O1
      [[null, null, null, 'agent:builtin:Explore'], ['Explore', 'query_source', 'otel', 'Explore', null]], //   O5
      [[null, null, null, 'repl_main_thread:outputStyle:Explanatory'], ['main', 'query_source_main', 'otel', null, null]], // O6
      [[null, null, null, 'sdk'], ['unknown', 'none', 'unavailable', null, null]], //                          O4
      [[null, null, null, null], ['unknown', 'none', 'unavailable', null, null]], //                           O7 (rejected label)
    ];
    for (const [[a, m, id, qs], [role, rule, source, qsRole, qsConflict]] of table) {
      const r = full(a, m, id, qs);
      assert.deepEqual([r.role, r.rule, r.source, r.qsRole, r.qsConflict], [role, rule, source, qsRole, qsConflict], String(qs));
    }
  });
});
