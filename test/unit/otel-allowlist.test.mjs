// The OTel allowlist (plan 01-03, DATA-05, DATA-06, D-05, D-06). The expected table below is an
// INDEPENDENT hand-written copy of 01-RESEARCH.md "Allowlist and scrub specification" (plus prompt.id,
// which the research keeps for every kind): the module never computes the expectation, so an edit to
// src/sources/otel/allowlist.mjs fails this file. A second, negative layer asserts that no kept key of any
// kind satisfies the sensitive-key rule.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

let A;
const ready = async () => {
  A = await import('../../src/sources/otel/allowlist.mjs');
};

const KINDS = {
  api_request: ['model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cache_creation_5m_tokens',
    'cache_creation_1h_tokens', 'cost_usd', 'cost_usd_micros', 'duration_ms', 'ttft_ms', 'request_id', 'client_request_id', 'speed',
    'query_source', 'effort', 'agent.name', 'skill.name', 'mcp_server.name', 'mcp_tool.name'],
  api_error: ['model', 'status_code', 'duration_ms', 'attempt', 'request_id', 'client_request_id', 'speed', 'query_source', 'effort',
    'agent.name', 'skill.name'],
  api_retries_exhausted: ['model', 'status_code', 'total_attempts', 'total_retry_duration_ms', 'speed', 'query_source', 'effort'],
  api_refusal: ['model', 'request_id', 'speed', 'attempt', 'server_fallback_hop', 'query_source', 'effort', 'has_category',
    'has_explanation', 'agent.name', 'skill.name'],
  tool_decision: ['decision', 'source', 'tool_name', 'tool_use_id', 'tool_source', 'classifier_verdict', 'permission_mode'],
  tool_result: ['tool_name', 'tool_use_id', 'success', 'duration_ms', 'tool_input_size_bytes', 'tool_result_size_bytes', 'error_type',
    'decision_source', 'decision_type', 'mcp_server_scope', 'vcs.ref.head.revision', 'vcs.ref.head.type'],
  hook_execution_start: ['hook_event', 'hook_name', 'num_hooks', 'num_success', 'num_blocking', 'num_non_blocking_error', 'num_cancelled',
    'total_duration_ms', 'stdout_chars', 'additional_context_chars', 'system_message_chars', 'initial_user_message_chars',
    'num_outputs_persisted', 'managed_only', 'hook_source', 'safe_mode'],
  hook_registered: ['hook_event', 'hook_type', 'hook_source', 'safe_mode', 'hook_matcher', 'plugin.name', 'plugin_id_hash'],
  safety_event: ['category', 'decision', 'decision_source', 'reason_type', 'reason_code', 'hook_event', 'tool_class', 'tool_name',
    'tool_source', 'permission_mode', 'tool_use_id', 'sandbox_violation_count', 'sandbox_enabled', 'rule_source', 'circuit_breaker',
    'grant_scope'],
  subagent_completed: ['agent_type', 'agent.source', 'is_built_in', 'is_async', 'total_tokens', 'total_tool_uses', 'duration_ms', 'model',
    'final_model', 'model_swapped'],
  skill_activated: ['skill.name', 'invocation_trigger', 'skill.source'],
  user_prompt: ['prompt_length', 'message.uuid', 'command_name', 'command_source'],
  assistant_response: ['response_length', 'request_id', 'message.uuid', 'model', 'query_source'],
  plugin_loaded: ['plugin.name', 'marketplace.name', 'plugin.version', 'plugin.scope', 'enabled_via', 'plugin_id_hash', 'has_hooks',
    'has_mcp', 'host_owned_mcp', 'skill_path_count', 'command_path_count', 'agent_path_count', 'safe_mode'],
  mcp_server_connection: ['status', 'transport_type', 'server_scope', 'duration_ms', 'is_plugin', 'server_name', 'error_code'],
};
KINDS.hook_execution_complete = KINDS.hook_execution_start;
const HEADER_ONLY = ['managed_settings_resolved', 'retention_sweep', 'at_mention', 'feedback_survey', 'internal_error', 'auth'];

const SHAPE_GROUPS = {
  id: ['prompt.id', 'message.uuid', 'request_id', 'client_request_id', 'tool_use_id', 'plugin_id_hash'],
  count: ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cache_creation_5m_tokens', 'cache_creation_1h_tokens',
    'cost_usd_micros', 'status_code', 'attempt', 'total_attempts', 'total_retry_duration_ms', 'num_hooks', 'num_success', 'num_blocking',
    'num_non_blocking_error', 'num_cancelled', 'stdout_chars', 'additional_context_chars', 'system_message_chars',
    'initial_user_message_chars', 'num_outputs_persisted', 'tool_input_size_bytes', 'tool_result_size_bytes', 'sandbox_violation_count',
    'prompt_length', 'response_length', 'total_tokens', 'total_tool_uses', 'skill_path_count', 'command_path_count', 'agent_path_count'],
  ms: ['duration_ms', 'ttft_ms', 'total_duration_ms'],
  money: ['cost_usd'],
  bool: ['success', 'managed_only', 'safe_mode', 'sandbox_enabled', 'is_built_in', 'is_async', 'model_swapped', 'has_hooks', 'has_mcp',
    'host_owned_mcp', 'is_plugin', 'has_category', 'has_explanation', 'server_fallback_hop'],
  label: ['server_name'],
  pattern: ['hook_matcher'],
  hex: ['vcs.ref.head.revision'],
};
const shapeOf = (key) => Object.entries(SHAPE_GROUPS).find(([, keys]) => keys.includes(key))?.[0] ?? 'name';

const METRIC_KEYS = ['session.id', 'language', 'model', 'query_source', 'effort', 'type', 'agent.name', 'skill.name', 'mcp_server.name',
  'mcp_tool.name', 'decision', 'source', 'tool_name', 'start_type'];
const KNOWN = ['claude_code.session.count', 'claude_code.cost.usage', 'claude_code.token.usage', 'claude_code.active_time.total',
  'claude_code.lines_of_code.count', 'claude_code.code_edit_tool.decision', 'claude_code.commit.count', 'claude_code.pull_request.count'];

describe('allowlist: the per-kind table equals the independent copy', () => {
  it('lists exactly the known kinds, with the research key set plus prompt.id, each with the right shape kind', async () => {
    await ready();
    assert.deepEqual(Object.keys(A.EVENT_ALLOW).sort(), Object.keys(KINDS).sort());
    for (const [kind, keys] of Object.entries(KINDS)) {
      const got = A.EVENT_ALLOW[kind];
      assert.deepEqual(Object.keys(got).sort(), [...keys, 'prompt.id'].sort(), `keys of ${kind}`);
      for (const key of Object.keys(got)) assert.equal(got[key], shapeOf(key), `shape of ${kind}.${key}`);
    }
  });

  it('header-only kinds are exactly six and are not in EVENT_ALLOW', async () => {
    await ready();
    assert.deepEqual([...A.HEADER_ONLY_KINDS].sort(), [...HEADER_ONLY].sort());
    for (const k of HEADER_ONLY) assert.equal(Object.hasOwn(A.EVENT_ALLOW, k), false);
  });

  it('hook_execution_start and hook_execution_complete share the same key set', async () => {
    await ready();
    assert.deepEqual(Object.keys(A.EVENT_ALLOW.hook_execution_complete).sort(), Object.keys(A.EVENT_ALLOW.hook_execution_start).sort());
  });

  it('the metric attribute list and the eight known metric names equal the hand-written copy', async () => {
    await ready();
    assert.deepEqual(Object.keys(A.METRIC_ALLOW).sort(), [...METRIC_KEYS].sort());
    assert.equal(A.METRIC_ALLOW['session.id'], 'id');
    assert.equal(A.METRIC_ALLOW.language, 'label');
    for (const k of METRIC_KEYS.filter((x) => !['session.id', 'language'].includes(x))) assert.equal(A.METRIC_ALLOW[k], 'name', k);
    assert.deepEqual([...A.KNOWN_METRICS].sort(), [...KNOWN].sort());
  });

  it('header keys, resource keys, token keys and the scrub rule sets equal the hand-written copy', async () => {
    await ready();
    assert.deepEqual([...A.HEADER_KEYS].sort(), ['event.name', 'event.sequence', 'event.timestamp', 'session.id']);
    assert.deepEqual([...A.IDENTITY_PREFIXES].sort(), ['organization.', 'user.']);
    assert.deepEqual([...A.SCRUB_DEFAULT_KEYS].sort(), ['error', 'tool_input', 'tool_parameters']);
    assert.deepEqual([...A.SCRUB_FULL_KEYS].sort(), ['error', 'prompt', 'prompt_text', 'response', 'tool_input', 'tool_parameters', 'vcs.ref.head.name']);
    assert.deepEqual([...A.RESOURCE_KEEP], ['service.version']);
    assert.deepEqual([...A.NOISE_RESOURCE_KEYS].sort(), ['host.arch', 'os.type', 'os.version', 'service.name', 'wsl.version']);
    assert.deepEqual([...A.TOKEN_KEYS].sort(), ['cache_creation_tokens', 'cache_read_tokens', 'cost_usd', 'input_tokens', 'output_tokens', 'total_tokens']);
  });
});

describe('allowlist: the negative layer (sensitive keys can never be kept)', () => {
  it('isSensitiveKey is true for identity prefixes, terminal.type and every full-scrub key, false for ordinary keys', async () => {
    await ready();
    for (const k of ['user.id', 'user.email', 'user.account_uuid', 'user.account_id', 'organization.id', 'user.', 'terminal.type',
      'tool_parameters', 'tool_input', 'error', 'prompt', 'prompt_text', 'response', 'vcs.ref.head.name']) {
      assert.equal(A.isSensitiveKey(k), true, k);
    }
    for (const k of ['model', 'error_type', 'input_tokens', 'users', 'organization', 'terminal', 'vcs.ref.head.revision', 'prompt.id', 'prompt_length', '']) {
      assert.equal(A.isSensitiveKey(k), false, k);
    }
  });

  it('no kept key of any kind and no metric key is sensitive', async () => {
    await ready();
    for (const [kind, keys] of Object.entries(A.EVENT_ALLOW)) {
      for (const key of Object.keys(keys)) assert.equal(A.isSensitiveKey(key), false, `${kind}.${key}`);
    }
    for (const key of Object.keys(A.METRIC_ALLOW)) assert.equal(A.isSensitiveKey(key), false, `metric ${key}`);
    for (const key of A.RESOURCE_KEEP) assert.equal(A.isSensitiveKey(key), false, key);
  });

  it('header keys are never attribute keys of a kind or of the metric list', async () => {
    await ready();
    for (const h of A.HEADER_KEYS) {
      for (const keys of Object.values(A.EVENT_ALLOW)) assert.equal(Object.hasOwn(keys, h), false, h);
    }
    assert.equal(Object.hasOwn(A.METRIC_ALLOW, 'event.name'), false);
  });

  it('lookups use own properties: __proto__, constructor and toString are unknown names, never kinds', async () => {
    await ready();
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(Object.hasOwn(A.EVENT_ALLOW, name), false, name);
      assert.equal(Object.hasOwn(A.METRIC_ALLOW, name), false, name);
    }
  });

  it('the exports are frozen so a later edit cannot widen them at run time', async () => {
    await ready();
    for (const v of [A.HEADER_KEYS, A.IDENTITY_PREFIXES, A.SCRUB_DEFAULT_KEYS, A.SCRUB_FULL_KEYS, A.EVENT_ALLOW, A.HEADER_ONLY_KINDS,
      A.METRIC_ALLOW, A.KNOWN_METRICS, A.RESOURCE_KEEP, A.NOISE_RESOURCE_KEYS, A.TOKEN_KEYS]) {
      assert.ok(Object.isFrozen(v));
    }
    assert.ok(Object.isFrozen(A.EVENT_ALLOW.api_request));
  });

  it('the default scrub set is exactly the D-05 trio and is a subset of the full set', async () => {
    await ready();
    assert.equal(A.SCRUB_DEFAULT_KEYS.length, 3);
    for (const k of A.SCRUB_DEFAULT_KEYS) assert.ok(A.SCRUB_FULL_KEYS.includes(k));
  });
});
