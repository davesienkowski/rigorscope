// The OTel allowlist (D-05, D-06, DATA-05, DATA-06). Deny by default: a key is stored only if this file
// names it for its event kind (or for metrics) with a shape kind (src/redact/shapes.mjs). Sensitive keys
// are checked FIRST by the normalizer (isSensitiveKey), so no edit to a table below can re-admit identity
// or content keys. The per-kind rows come from 01-RESEARCH.md "Allowlist and scrub specification"; the
// header keys and prompt.id are kept for every kind (prompt.id only for kinds that store attributes).
// Every export is frozen and every lookup elsewhere uses Object.hasOwn.
const freeze = (v) => Object.freeze(v);

// Read from attrs to key the row; never stored in `attrs`.
export const HEADER_KEYS = freeze(['session.id', 'event.sequence', 'event.timestamp', 'event.name']);
export const IDENTITY_PREFIXES = freeze(['user.', 'organization.']);
// preserve-scrub rule sets: the default is exactly D-05; the full set is the opt-in superset.
export const SCRUB_DEFAULT_KEYS = freeze(['tool_parameters', 'tool_input', 'error']);
export const SCRUB_FULL_KEYS = freeze([...SCRUB_DEFAULT_KEYS, 'prompt', 'prompt_text', 'response', 'vcs.ref.head.name']);

export function isSensitiveKey(key) {
  if (typeof key !== 'string') return false;
  return IDENTITY_PREFIXES.some((p) => key.startsWith(p)) || key === 'terminal.type' || SCRUB_FULL_KEYS.includes(key);
}

const SHAPE_GROUPS = {
  id: ['prompt.id', 'message.uuid', 'request_id', 'client_request_id', 'tool_use_id', 'plugin_id_hash'],
  count: ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cache_creation_5m_tokens',
    'cache_creation_1h_tokens', 'cost_usd_micros', 'status_code', 'attempt', 'total_attempts', 'total_retry_duration_ms',
    'num_hooks', 'num_success', 'num_blocking', 'num_non_blocking_error', 'num_cancelled', 'stdout_chars',
    'additional_context_chars', 'system_message_chars', 'initial_user_message_chars', 'num_outputs_persisted',
    'tool_input_size_bytes', 'tool_result_size_bytes', 'sandbox_violation_count', 'prompt_length', 'response_length',
    'total_tokens', 'total_tool_uses', 'skill_path_count', 'command_path_count', 'agent_path_count'],
  ms: ['duration_ms', 'ttft_ms', 'total_duration_ms'],
  money: ['cost_usd'],
  bool: ['success', 'managed_only', 'safe_mode', 'sandbox_enabled', 'is_built_in', 'is_async', 'model_swapped', 'has_hooks',
    'has_mcp', 'host_owned_mcp', 'is_plugin', 'has_category', 'has_explanation', 'server_fallback_hop'],
  label: ['server_name'],
  pattern: ['hook_matcher'],
  hex: ['vcs.ref.head.revision'],
};
const shapeOf = (key) => Object.entries(SHAPE_GROUPS).find(([, keys]) => keys.includes(key))?.[0] ?? 'name';

const HOOK_KEYS = ['hook_event', 'hook_name', 'num_hooks', 'num_success', 'num_blocking', 'num_non_blocking_error', 'num_cancelled',
  'total_duration_ms', 'stdout_chars', 'additional_context_chars', 'system_message_chars', 'initial_user_message_chars',
  'num_outputs_persisted', 'managed_only', 'hook_source', 'safe_mode'];

const KIND_KEYS = {
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
  hook_execution_start: HOOK_KEYS,
  hook_execution_complete: HOOK_KEYS,
  hook_registered: ['hook_event', 'hook_type', 'hook_source', 'safe_mode', 'hook_matcher', 'plugin.name', 'plugin_id_hash'],
  safety_event: ['category', 'decision', 'decision_source', 'reason_type', 'reason_code', 'hook_event', 'tool_class', 'tool_name',
    'tool_source', 'permission_mode', 'tool_use_id', 'sandbox_violation_count', 'sandbox_enabled', 'rule_source', 'circuit_breaker',
    'grant_scope'],
  // total_tokens is a reconciliation hint stored only inside attrs; nothing sums it (D-12).
  subagent_completed: ['agent_type', 'agent.source', 'is_built_in', 'is_async', 'total_tokens', 'total_tool_uses', 'duration_ms', 'model',
    'final_model', 'model_swapped'],
  skill_activated: ['skill.name', 'invocation_trigger', 'skill.source'],
  user_prompt: ['prompt_length', 'message.uuid', 'command_name', 'command_source'],
  assistant_response: ['response_length', 'request_id', 'message.uuid', 'model', 'query_source'],
  plugin_loaded: ['plugin.name', 'marketplace.name', 'plugin.version', 'plugin.scope', 'enabled_via', 'plugin_id_hash', 'has_hooks',
    'has_mcp', 'host_owned_mcp', 'skill_path_count', 'command_path_count', 'agent_path_count', 'safe_mode'],
  mcp_server_connection: ['status', 'transport_type', 'server_scope', 'duration_ms', 'is_plugin', 'server_name', 'error_code'],
};

const byKey = (keys) => freeze(Object.fromEntries([...keys, 'prompt.id'].map((k) => [k, shapeOf(k)])));
const built = Object.fromEntries(Object.entries(KIND_KEYS).map(([kind, keys]) => [kind, byKey(keys)]));
export const EVENT_ALLOW = freeze(built);

// Kinds with no consumer in Phases 1 to 4: stored header-only, attrs {}.
export const HEADER_ONLY_KINDS = freeze(['managed_settings_resolved', 'retention_sweep', 'at_mention', 'feedback_survey', 'internal_error', 'auth']);

const METRIC_NAMES = ['model', 'query_source', 'effort', 'type', 'agent.name', 'skill.name', 'mcp_server.name', 'mcp_tool.name', 'decision',
  'source', 'tool_name', 'start_type'];
export const METRIC_ALLOW = freeze({
  'session.id': 'id', language: 'label', ...Object.fromEntries(METRIC_NAMES.map((k) => [k, 'name'])),
});
export const KNOWN_METRICS = freeze([
  'claude_code.session.count', 'claude_code.cost.usage', 'claude_code.token.usage', 'claude_code.active_time.total',
  'claude_code.lines_of_code.count', 'claude_code.code_edit_tool.decision', 'claude_code.commit.count', 'claude_code.pull_request.count',
]);

// Resource keys: only service.version is kept (the Claude Code version, a confounder).
export const RESOURCE_KEEP = freeze(['service.version']);
export const NOISE_RESOURCE_KEYS = freeze(['host.arch', 'os.type', 'os.version', 'wsl.version', 'service.name']);
// An unknown kind carrying one of these is counted as an unknown token-bearing record.
export const TOKEN_KEYS = freeze(['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'total_tokens', 'cost_usd']);
