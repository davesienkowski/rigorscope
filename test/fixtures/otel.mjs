// Synthetic OTel receiver fixtures (plan 01-03). A helper, not a test: the quoted test glob never
// collects it. Everything here is invented; no line is copied from real receiver files.
//
// Line format of the receiver (probe 2026-10-28): { ts, event|metric, [value], attrs, resource }. Every
// line carries five identity keys and terminal.type next to the token and cost attributes, so a leak
// of any of them is detectable by value. The expectations in OTEL_EXPECTED are computed BY HAND from the
// lines below and never by the code under test.
//
// Normalizer result shape the contract tests and the leaking stub rely on (documented here once):
//   { type: 'event' | 'metric' | 'drop' | 'skip' | 'unparseable', row, reason, rejected: [names],
//     unknown: [{ scope, name }], unknownToken: 'name|version' | null, recordTs }
//   event row:  { sessionId, seq, eventTs, kind, tsUtc, promptId, requestId, toolUseId, ccVersion, attrsJson, attrsSha }
//   metric row: { tsUtc, metric, attrsSha, value, sessionId, ccVersion, attrsJson }
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLANTS, escapeNonAscii } from './build.mjs';

const homePath = (...parts) => ['', 'home', ...parts].join('/');

// Unique strings, each holding the marker CANARY. Never print one in a failure message.
export const OTEL_PLANTS = {
  userId: 'CANARY-otel-user-id-0001',
  userEmail: 'CANARY-otel-mail@canary-example.invalid',
  userAccountUuid: 'CANARY-otel-acct-uuid-0002',
  userAccountId: 'CANARY-otel-acct-id-0003',
  organizationId: 'CANARY-otel-org-0004',
  terminalType: 'CANARY-otel-terminal-xterm',
  // No quote, backslash or control character in any plant: a JSON-escaped copy in a stored attrs text must
  // still match the needle byte for byte.
  toolParameters: `{full_command: curl -H Authorization:CANARYtoken-otel9 ${homePath(PLANTS.osUser, 'secret.txt')}}`,
  toolInput: 'CANARY-otel-tool-input {file_path: CANARY-otel-input-path}',
  errorText: 'CANARY-otel-error-text exploded at CANARY-otel-error-site',
  promptText: 'CANARY-otel-prompt summarize the board numbers',
  responseText: 'CANARY-otel-response here are the board numbers',
  branchName: 'CANARY-owner-handle/feature-otel',
  hostileKeyName: 'CANARY-otel-key@canary-example.invalid',
  hostileAgentName: 'CANARY otel agent spaced tok-CANARYotel1',
  hostileModel: 'model-CANARY-otel@canary-example.invalid',
  hostileLabel: 'CANARY=label@host',
  // e-acute and snowman as JavaScript escapes so this file stays ASCII.
  nonAscii: 'CANARY-otel café ☃ note',
};
export const OTEL_NON_ASCII_ESCAPED = 'CANARY-otel caf\\u00e9 \\u2603 note';

// Every value (and the OS user plant of build.mjs, and the escaped non-ASCII form) a scan must not find.
export function otelNeedles() {
  return [...Object.values(OTEL_PLANTS), OTEL_NON_ASCII_ESCAPED, PLANTS.osUser];
}

// ASCII/latin1 lowercase decode so the OS user name matches case-insensitively without touching other bytes.
const fold = (buf) => Buffer.from(buf).toString('latin1').toLowerCase();
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

// buffers: Buffer | { label, buf } | array of those. Returns [{ source, needle }] where needle is an index
// into `needles` or the text 'email-shape' (skipped with { email: false }). Never returns a value.
export function scanBuffers(buffers, needles = otelNeedles(), { email = true } = {}) {
  const list = (Array.isArray(buffers) ? buffers : [buffers]).map((b, i) => (Buffer.isBuffer(b) ? { label: `buffer-${i}`, buf: b } : b));
  const folded = needles.map((n) => fold(Buffer.from(n, 'utf8')));
  const out = [];
  for (const { label, buf } of list) {
    const hay = fold(buf);
    folded.forEach((n, i) => { if (hay.includes(n)) out.push({ source: label, needle: i }); });
    if (email && EMAIL_SHAPE.test(buf.toString('latin1'))) out.push({ source: label, needle: 'email-shape' });
  }
  return out;
}

export const liveDirFor = (home) => join(home, '.local', 'share', 'hook-telemetry');
export const preserveDirFor = (home) => join(home, '.local', 'share', 'rigorscope', 'preserve', 'hook-telemetry');

export function identityAttrs() {
  return {
    'user.id': OTEL_PLANTS.userId,
    'user.email': OTEL_PLANTS.userEmail,
    'user.account_uuid': OTEL_PLANTS.userAccountUuid,
    'user.account_id': OTEL_PLANTS.userAccountId,
    'organization.id': OTEL_PLANTS.organizationId,
    'terminal.type': OTEL_PLANTS.terminalType,
  };
}

export function resourceAttrs(extra = {}) {
  return {
    'host.arch': 'x64', 'os.type': 'linux', 'os.version': '6.1-fixture', 'wsl.version': '2.0-fixture',
    'service.name': 'claude-code', 'service.version': '2.1.309', ...extra,
  };
}

// The receiver's key order: ts, event or metric, value (metrics), attrs, resource.
export function eventLine({ ts, event, attrs, resource = resourceAttrs(), eol = '' }) {
  return JSON.stringify({ ts, event, attrs, resource }) + eol;
}
export function metricLine({ ts, metric, value, attrs, resource = resourceAttrs(), eol = '' }) {
  return JSON.stringify({ ts, metric, value, attrs, resource }) + eol;
}

// Attributes of one event: identity keys, then the four header keys, then the kind specific ones. A
// header field passed as undefined is omitted by JSON.stringify.
export function evAttrs({ session, seq, ts, name, extra = {} }) {
  return {
    ...identityAttrs(), 'session.id': session, 'event.sequence': seq, 'event.timestamp': ts, 'event.name': name, ...extra,
  };
}
export const mAttrs = (extra = {}) => ({ ...identityAttrs(), ...extra });

export const SA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const SB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const SC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = '2026-10-27T';
const REV = 'abc123abc123abc123abc123abc123abc123abc1';

// One event of kind `event` at `ts`: the header event.timestamp equals the line ts.
const ev = (session, seq, ts, event, extra, over = {}) => ({
  ts, event, attrs: evAttrs({ session, seq, ts, name: event, extra }), ...over,
});

// The twenty complete lines of the live events file (L1 to L20), in file order.
function eventSpecs() {
  const t = (s) => `${D}${s}`;
  return [
    ev(SA, 1, t('12:00:01.000Z'), 'api_request', {
      model: 'claude-opus-5-5', input_tokens: 120, output_tokens: 80, cache_read_tokens: 5000, cache_creation_tokens: 300,
      cache_creation_5m_tokens: 200, cache_creation_1h_tokens: 100, cost_usd: 0.0123, cost_usd_micros: 12300,
      duration_ms: 1500, ttft_ms: 400, request_id: 'req-e1', client_request_id: 'creq-e1', speed: 'standard',
      query_source: 'repl_main_thread', effort: 'high', 'agent.name': 'gsd-executor', 'skill.name': 'plan-check',
      'prompt.id': 'prompt-e1',
    }),
    ev(SA, 2, t('12:00:02.000Z'), 'api_request', {
      model: OTEL_PLANTS.hostileModel, input_tokens: -5, request_id: 'req-e2', 'agent.name': OTEL_PLANTS.hostileAgentName,
      brand_new_attr: 1, [OTEL_PLANTS.hostileKeyName]: 1, cost_usd: 'NaN',
    }),
    ev(SA, 5, t('12:00:03.000Z'), 'tool_result', {
      tool_parameters: OTEL_PLANTS.toolParameters, tool_input: OTEL_PLANTS.toolInput, error: OTEL_PLANTS.errorText,
      'vcs.ref.head.name': OTEL_PLANTS.branchName, 'vcs.ref.head.revision': REV, 'vcs.ref.head.type': 'branch',
      tool_name: 'Bash', tool_use_id: 'toolu_01', success: 'true', duration_ms: '-4', tool_input_size_bytes: '40',
    }),
    ev(SA, 5, t('12:00:03.500Z'), 'tool_decision', {
      tool_parameters: OTEL_PLANTS.toolParameters, decision: 'accept', source: 'config', tool_name: 'Bash', tool_use_id: 'toolu_01',
    }),
    ev(SA, 7, t('12:00:04.000Z'), 'hook_execution_start', { hook_event: 'PreToolUse', hook_name: 'PreToolUse:Bash', num_hooks: '3' }),
    ev(SA, 7, t('12:00:04.250Z'), 'hook_execution_start', { hook_event: 'PreToolUse', hook_name: 'PreToolUse:Bash', num_hooks: '3' }),
    ev(SB, 1, t('12:05:00.000Z'), 'api_error', {
      error: OTEL_PLANTS.errorText, status_code: '529', attempt: 1, model: 'claude-opus-5-5', request_id: 'req-e7',
    }),
    ev(SB, 2, t('12:05:01.000Z'), 'user_prompt', {
      prompt: `${OTEL_PLANTS.promptText} ${OTEL_PLANTS.nonAscii}`, prompt_text: OTEL_PLANTS.promptText, prompt_length: '55',
      command_name: 'usage',
    }),
    ev(SB, 3, t('12:05:02.000Z'), 'assistant_response', {
      response: `${OTEL_PLANTS.responseText} ${OTEL_PLANTS.nonAscii}`, response_length: 10, request_id: 'req-e9', 'message.uuid': 'muuid-e9',
    }),
    ev(SB, 4, t('12:05:03.000Z'), 'managed_settings_resolved', {
      'managed_settings.sources': ['policy', 'file'], 'managed_settings.a': 'x', 'managed_settings.b': 'y',
    }),
    ev(SB, 5, t('12:05:04.000Z'), 'brand_new_event', { input_tokens: 5 }),
    {
      ts: t('12:05:05.000Z'),
      event: 'subagent_completed',
      attrs: evAttrs({
        session: SB, seq: 6, ts: t('12:05:05.000Z'), name: 'subagent_stopped', extra: { total_tokens: 777, agent_type: 'gsd-executor' },
      }),
      resource: resourceAttrs({ 'weird.resource.key': 'w' }),
    },
    // Lines that cannot be keyed: one defect each.
    ev(undefined, 8, t('12:06:00.000Z'), 'api_request', { model: 'claude-opus-5-5' }),
    ev(SB, undefined, t('12:06:01.000Z'), 'api_request', { model: 'claude-opus-5-5' }),
    { ts: t('12:06:02.000Z'), event: 'api_request', attrs: evAttrs({ session: SB, seq: 9, ts: 'yesterday', name: 'api_request', extra: {} }) },
    ev(SB, 10, t('12:06:03.000Z'), 'Bad Name', {}),
    ev(SB, 11, undefined, 'api_request', {}, { ts: undefined }),
  ];
}

export function liveEventLines() {
  const text = eventSpecs().map((s) => eventLine({ ...s, resource: s.resource ?? resourceAttrs() }));
  text[7] = escapeNonAscii(text[7]); // L8 carries the non-ASCII plant as JSON escapes, L9 as raw UTF-8
  text.push('not json {', '', '[1,2]');
  return text; // 20 entries; index 17 is unparseable, 18 is the blank line, 19 is a JSON array
}

// First bytes of a line that has not been completed yet (a receiver mid-write).
export const PARTIAL_TAIL = '{"ts":"2026-10-27T12:06:30.000Z","event":"api_request","attrs":{"session.id":"aaaaaaaa-aaaa';

// The nine complete lines of the live metrics file (M1 to M9).
export function liveMetricLines() {
  const t = (s) => `${D}${s}`;
  const sa = { 'session.id': SA };
  const m = (ts, metric, value, extra) => metricLine({ ts, metric, value, attrs: mAttrs({ ...sa, ...extra }) });
  const m3 = m(t('12:00:01.000Z'), 'claude_code.cost.usage', 0.0123, { model: 'claude-opus-5-5', query_source: 'repl_main_thread' });
  return [
    m(t('12:00:01.000Z'), 'claude_code.token.usage', 120, {
      model: 'claude-opus-5-5', query_source: 'repl_main_thread', effort: 'high', type: 'input', 'agent.name': 'gsd-executor',
      language: 'Type Script, JS',
    }),
    m(t('12:00:01.000Z'), 'claude_code.token.usage', 80, {
      model: 'claude-opus-5-5', query_source: 'repl_main_thread', effort: 'high', type: 'output', 'agent.name': 'gsd-executor',
    }),
    m3,
    m3, // byte-identical copy of M3
    m(t('12:00:00.000Z'), 'claude_code.session.count', 1, { start_type: 'fresh', language: OTEL_PLANTS.hostileLabel }),
    m(t('12:00:02.000Z'), 'claude_code.token.bonus', 3, {}),
    m(t('12:00:03.000Z'), 'claude_code.token.usage', 7, { model: OTEL_PLANTS.hostileModel, brand_new_metric_attr: 'z' }),
    m(t('12:00:04.000Z'), 'claude_code.token.usage', 'abc', { model: 'claude-opus-5-5' }),
    m('later', 'claude_code.token.usage', 9, { model: 'claude-opus-5-5' }),
  ];
}

function writeFile(file, text) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text, 'utf8');
}
const joinLines = (lines, eol = '\n') => (lines.length ? lines.join(eol) + eol : '');

// Preserve-only day: two events of session SC.
export function preserveDayLines() {
  return [
    eventLine({
      ts: '2026-10-26T09:00:00.000Z', event: 'api_request',
      attrs: evAttrs({ session: SC, seq: 1, ts: '2026-10-26T09:00:00.000Z', name: 'api_request', extra: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, request_id: 'req-c1' } }),
    }),
    eventLine({
      ts: '2026-10-26T09:00:01.000Z', event: 'tool_decision',
      attrs: evAttrs({ session: SC, seq: 2, ts: '2026-10-26T09:00:01.000Z', name: 'tool_decision', extra: { tool_parameters: OTEL_PLANTS.toolParameters, decision: 'accept', source: 'config', tool_name: 'Read', tool_use_id: 'toolu_c2' } }),
    }),
  ];
}

// Writes the live directory and, with { preserve: true }, the preserve directory under `home`.
export function buildOtelTree(home, { preserve = false } = {}) {
  const liveDir = liveDirFor(home);
  const preserveDir = preserveDirFor(home);
  const events = liveEventLines();
  const metrics = liveMetricLines();
  const files = {
    liveEvents: join(liveDir, 'events-2026-10-27.jsonl'),
    liveMetrics: join(liveDir, 'metrics-2026-10-27.jsonl'),
    preserveEvents27: join(preserveDir, 'events-2026-10-27.jsonl'),
    preserveEvents26: join(preserveDir, 'events-2026-10-26.jsonl'),
    preserveMetrics27: join(preserveDir, 'metrics-2026-10-27.jsonl'),
  };
  writeFile(files.liveEvents, joinLines(events) + PARTIAL_TAIL);
  writeFile(files.liveMetrics, joinLines(metrics));
  if (preserve) {
    // events-2026-10-27: L1 to L9 byte for byte plus the first 40 bytes of L10 (a strict byte prefix of the live file).
    writeFile(files.preserveEvents27, joinLines(events.slice(0, 9)) + events[9].slice(0, 40));
    writeFile(files.preserveEvents26, joinLines(preserveDayLines()));
    writeFile(files.preserveMetrics27, joinLines(metrics));
  }
  return { liveDir, preserveDir, files, lines: { events, metrics, partialTail: PARTIAL_TAIL } };
}

// The preserve directory used by the preserve-scrub tests: dirty files, clean files and decoys.
export function buildPreserveScrubTree(home) {
  const dir = preserveDirFor(home);
  const SD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const at = (day, s) => `2026-10-${day}T10:00:${s}.000Z`;
  const e = (day, s, seq, event, extra, resource) => eventLine({
    ts: at(day, s), event, attrs: evAttrs({ session: SD, seq, ts: at(day, s), name: event, extra }), ...(resource ? { resource } : {}),
  });
  const mm = (day, s, metric, value) => metricLine({ ts: at(day, s), metric, value, attrs: mAttrs({ 'session.id': SD, model: 'claude-opus-5-5' }) });

  const files = {
    ev27: join(dir, 'events-2026-10-27.jsonl'),
    ev26: join(dir, 'events-2026-10-26.jsonl'),
    ev25: join(dir, 'events-2026-10-25.jsonl'),
    mt27: join(dir, 'metrics-2026-10-27.jsonl'),
  };
  writeFile(files.ev27, joinLines([
    e('27', '01', 1, 'tool_result', {
      tool_parameters: OTEL_PLANTS.toolParameters, tool_input: OTEL_PLANTS.toolInput, error: OTEL_PLANTS.errorText,
      'vcs.ref.head.name': OTEL_PLANTS.branchName, tool_name: 'Bash', tool_use_id: 'toolu_s1',
    }),
    e('27', '02', 2, 'tool_decision', { tool_parameters: OTEL_PLANTS.toolParameters, decision: 'accept', tool_name: 'Bash' }),
    e('27', '03', 3, 'api_error', { error: OTEL_PLANTS.errorText, status_code: 529, model: 'claude-opus-5-5' }),
    e('27', '04', 4, 'user_prompt', { prompt: OTEL_PLANTS.promptText, prompt_text: OTEL_PLANTS.promptText, prompt_length: 40 }),
    escapeNonAscii(e('27', '05', 5, 'assistant_response', { response: `${OTEL_PLANTS.responseText} ${OTEL_PLANTS.nonAscii}`, response_length: 12 })),
    e('27', '06', 6, 'api_request', { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1 }),
  ]));
  writeFile(files.ev26, joinLines([
    e('26', '01', 1, 'api_request', { model: 'claude-opus-5-5', input_tokens: 2, output_tokens: 3 }),
    e('26', '02', 2, 'tool_decision', { decision: 'accept', tool_name: 'Read' }),
  ]));
  const bom = '﻿';
  const trunc = `{"ts":"${at('25', '03')}","event":"tool_result","attrs":{"session.id":"${SD}","tool_parameters":"CANARY-otel-trunc-cut`;
  writeFile(files.ev25, [
    `${bom}${e('25', '01', 1, 'api_request', { model: 'claude-opus-5-5' })}`,
    '',
    'not json at all',
    trunc,
    e('25', '05', 5, 'tool_result', { tool_parameters: OTEL_PLANTS.toolParameters, tool_input: OTEL_PLANTS.toolInput, prompt_text: OTEL_PLANTS.promptText, tool_name: 'Bash' }),
  ].join('\r\n')); // CRLF between lines, no terminator after the last line
  writeFile(files.mt27, joinLines([mm('27', '01', 'claude_code.token.usage', 5), mm('27', '02', 'claude_code.cost.usage', 0.5)]));

  // Decoys: a reports directory, another name, a symlink named like an events file that points outside,
  // and a directory named like a metrics file.
  const outside = join(home, 'outside-otel');
  const outsideFile = join(outside, 'leak.jsonl');
  writeFile(outsideFile, joinLines([e('24', '01', 1, 'tool_result', { tool_parameters: OTEL_PLANTS.toolParameters })]));
  writeFile(join(dir, 'reports', 'summary.txt'), 'report CANARY-otel-report-decoy\n');
  writeFile(join(dir, 'notes.txt'), 'notes CANARY-otel-notes-decoy\n');
  symlinkSync(outsideFile, join(dir, 'events-2026-10-24.jsonl'));
  mkdirSync(join(dir, 'metrics-2026-10-24.jsonl'), { recursive: true });
  // Group readable so a rewrite that forgets to tighten the mode is detectable.
  for (const f of [files.ev27, files.ev25]) chmodSync(f, 0o644);
  return { dir, files, outside, outsideFile };
}

// Hand-computed expectations (see the line lists above).
//   live only:  12 events (L1 to L12), 7 metrics (M1 to M7); L13 to L17 and M8, M9 dropped, L18 unparseable,
//               L19 blank (skipped), L20 record_type.
//   both dirs:  the preserve prefix re-normalizes L1 to L9 and the metrics copy re-normalizes all of M1 to M9;
//               the preserve-only day adds exactly 2 events.
export const OTEL_EXPECTED = {
  liveOnly: { events: 12, metrics: 7, parsed: 26, kept: 19, rowsUpserted: 19 },
  both: { events: 14, metrics: 7, parsed: 46, kept: 37, rowsUpserted: 21 },
  dropped: {
    live: { session_id: 1, event_sequence: 1, event_timestamp: 1, event_name: 1, ts: 2, record_type: 1, value: 1 },
    both: { session_id: 1, event_sequence: 1, event_timestamp: 1, event_name: 1, ts: 3, record_type: 1, value: 2 },
  },
  rejected: {
    live: {
      'api_request.agent.name': 1, 'api_request.model': 1, 'api_request.input_tokens': 1, 'api_request.cost_usd': 1,
      'metric.model': 1, 'metric.language': 1, 'header.event.name': 1,
    },
    both: {
      'api_request.agent.name': 2, 'api_request.model': 2, 'api_request.input_tokens': 2, 'api_request.cost_usd': 2,
      'metric.model': 2, 'metric.language': 2, 'header.event.name': 1,
    },
  },
  unknownToken: {
    live: { 'brand_new_event|2.1.309': 1, 'claude_code.token.bonus|2.1.309': 1 },
    both: { 'brand_new_event|2.1.309': 1, 'claude_code.token.bonus|2.1.309': 2 },
  },
  unparseable: 1,
  unknownAttr: {
    live: {
      'event_kind|brand_new_event': 1, 'brand_new_event|input_tokens': 1, 'api_request|brand_new_attr': 1, 'api_request|?': 1,
      'metric_name|claude_code.token.bonus': 1, 'metric|brand_new_metric_attr': 1, 'resource|weird.resource.key': 1,
    },
    both: {
      'event_kind|brand_new_event': 1, 'brand_new_event|input_tokens': 1, 'api_request|brand_new_attr': 2, 'api_request|?': 2,
      'metric_name|claude_code.token.bonus': 2, 'metric|brand_new_metric_attr': 2, 'resource|weird.resource.key': 1,
    },
  },
  keyPairs: [[SA, 5], [SA, 7]],
  metricOrdinals: [0, 1],
  roots: { live: 'live', preserve: 'preserve' },
  sourceFiles: [
    'live:events-2026-10-27.jsonl', 'live:metrics-2026-10-27.jsonl', 'preserve:events-2026-10-26.jsonl',
    'preserve:events-2026-10-27.jsonl', 'preserve:metrics-2026-10-27.jsonl',
  ],
  scrub: {
    removed: { tool_parameters: 3, tool_input: 2, error: 2 },
    dropped: 1,
    unparseableKept: 1,
    skipped: { name: 2, symlink: 1, not_regular: 1 },
    files: 4,
    rewrittenFiles: 2,
  },
};

// Reads every regular file directly inside `dir` (symlinks and directories are not followed).
export function readRegularFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (lstatSync(p).isFile()) out.push({ label: `preserve:${name}`, buf: readFileSync(p) });
  }
  return out;
}
