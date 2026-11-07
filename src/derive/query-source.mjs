// OTel query_source rules (plan 01-07, COST-02, COST-03, D-06, T-01-60). Pure: no database access.
//
// query_source is the label Claude Code puts on every api_request event. Three of its forms matter to the
// derivation pass:
//   - the six pure-harness sources: calls the harness makes on its own (summaries, suggestions, titles, web
//     helpers). They are never a role's work: their role is `harness:<query_source>` and they are reported in
//     their own rows (COST-03). `sdk` is NOT one of them: an sdk call is a real agent call whose role comes
//     from the transcript when it has one.
//   - `agent:builtin:<Name>`: a built-in sub-agent; Name is a role when it matches AGENT_NAME_SHAPE.
//     `agent:custom` and every other `agent:` form carry no name.
//   - `repl_main_thread` and `repl_main_thread:<anything>`: the main thread.
//
// Every comparison is byte for byte: no trimming, no case folding, no normalization. Every function accepts
// any input and returns null or false for a non-string. The shapes are re-checked before any OTel text is
// stored in derived.db (safeQuerySource, safeAgentName), so a value the 01-03 normalizer let through still
// has to match these narrower shapes.
const freeze = (v) => Object.freeze(v);

export const HARNESS_SOURCES = freeze([
  'agent_summary', 'prompt_suggestion', 'web_fetch_apply', 'web_search_tool', 'generate_session_title', 'away_summary',
]);
export const SDK_SOURCE = 'sdk';

// A query source: a letter, then letters, digits, colon, dot, underscore or hyphen; 1 to 96 characters.
export const QS_SHAPE = /^[A-Za-z][A-Za-z0-9:._-]{0,95}$/;
// An agent name: an ASCII letter or digit, then letters, digits, dot, underscore or hyphen; 1 to 64 characters.
export const AGENT_NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const BUILTIN_PREFIX = 'agent:builtin:';
const MAIN_THREAD = 'repl_main_thread';

export function isHarnessSource(qs) {
  return typeof qs === 'string' && HARNESS_SOURCES.includes(qs);
}

export function harnessRole(qs) {
  return isHarnessSource(qs) ? `harness:${qs}` : null;
}

export function parseQuerySourceRole(qs) {
  if (typeof qs !== 'string' || !qs.startsWith(BUILTIN_PREFIX)) return null;
  const name = qs.slice(BUILTIN_PREFIX.length);
  return AGENT_NAME_SHAPE.test(name) ? name : null;
}

export function isMainThreadSource(qs) {
  return typeof qs === 'string' && (qs === MAIN_THREAD || qs.startsWith(`${MAIN_THREAD}:`));
}

export function safeQuerySource(value) {
  return typeof value === 'string' && QS_SHAPE.test(value) ? value : null;
}

export function safeAgentName(value) {
  return typeof value === 'string' && AGENT_NAME_SHAPE.test(value) ? value : null;
}
