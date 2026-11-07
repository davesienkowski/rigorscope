// Case 97: the OTel join fixture (plan 01-07, COST-02, COST-03, COST-05, COST-06, TRUST-01, TRUST-02).
// Three transcript sessions (SJ1, SJ2, SJ3) with eight calls A to H, and OTel api_request events for six of
// them plus nine OTel-only requests in three OTel-only sessions (SO1, SO2, SO3) and in SJ3. Every number
// below is hand-computed from the lines this module writes, never by the code under test; the arithmetic
// sits in a comment beside each literal. Never imports build.mjs.
//
// Price rates in nano-dollars per token (validated rows of data/prices-2026-10-28.json, plan 01-05):
//   claude-opus-5-5    input 4000, output 20000, cache read 200, 5m write 5000
//   claude-sonnet-5-5  input 2000, output 10000, cache read 100, 5m write 2500
//   claude-haiku-5-5   input  100, output   500, cache read  10, 5m write  125 (prompt up to 100,000 tokens)
//
// The OTel lines go to events-2026-10-28.jsonl in the live directory. The plan named events-2026-10-27.jsonl,
// but case 82 and the canary OTel plant write that exact file, and a build of every case would overwrite
// their lines (deviation recorded in the 01-07 SUMMARY); the event times stay on 2026-10-27.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OTEL_PLANTS, eventLine, evAttrs, liveDirFor, resourceAttrs } from '../otel.mjs';

export const id = 'otel-join';
export const group = 'extra';
export const sources = ['transcript', 'otel'];

export const SJ1 = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
export const SJ2 = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
export const SJ3 = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
export const SO1 = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
export const SO2 = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2';
export const SO3 = 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3';
export const AB = 'agentbbbb00000021';
export const AC = 'agentcccc00000022';
export const AD = 'agentdddd00000023';
export const AE = 'agenteeee00000024';
export const OTEL_FILE = 'events-2026-10-28.jsonl';

const T = (hms) => `2026-10-27T${hms}Z`;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';

// Transcript calls: [letter, session, agent ('' = main file), message id, request id, model, time,
// [input, output, cache_read, cache_creation, cache_5m, cache_1h], effort (undefined = no field), attributionAgent]
export const CALLS = [
  ['A', SJ1, '', 'msg_oj_a', 'req_oj_a', OPUS, '16:00:01.000', [100, 10, 0, 0, 0, 0], 'high'],
  ['B', SJ1, AB, 'msg_oj_b', 'req_oj_b', HAIKU, '16:00:02.000', [1000, 200, 5000, 0, 0, 0], 'high'],
  ['C', SJ1, AC, 'msg_oj_c', 'req_oj_c', SONNET, '16:00:03.000', [200, 50, 1000, 400, 400, 0], 'high', 'fork'],
  ['D', SJ1, AD, 'msg_oj_d', 'req_oj_d', HAIKU, '16:00:04.000', [50, 20, 0, 0, 0, 0], undefined],
  ['F', SJ2, '', 'msg_oj_f', 'req_oj_f', HAIKU, '16:10:01.000', [10, 10, 0, 0, 0, 0], 'high'],
  ['G', SJ2, '', 'msg_oj_g', 'req_oj_g', HAIKU, '16:10:02.000', [20, 20, 0, 0, 0, 0], 'high'],
  ['E', SJ2, AE, 'msg_oj_e', 'req_oj_e', SONNET, '16:10:03.000', [10, 10, 0, 0, 0, 0], 'medium'],
  ['H', SJ3, '', 'msg_oj_h', 'req_oj_h', HAIKU, '16:20:01.000', [10, 10, 0, 0, 0, 0], undefined],
];
// Meta agent types (agent D has no meta file).
const META = [[SJ1, AB, 'Explore'], [SJ1, AC, 'general-purpose'], [SJ2, AE, 'gsd-executor']];

// api_request attributes in the receiver's key names; an undefined value is omitted from the line.
// t = [input, output, cache_read, cache_creation, cache_5m, cache_1h]
function reqAttrs({ model, t, usd, micros, requestId, qs, effort, agent }) {
  return {
    model,
    input_tokens: t[0],
    output_tokens: t[1],
    cache_read_tokens: t[2],
    cache_creation_tokens: t[3],
    cache_creation_5m_tokens: t[4],
    cache_creation_1h_tokens: t[5],
    cost_usd: usd,
    cost_usd_micros: micros,
    request_id: requestId,
    query_source: qs,
    effort,
    'agent.name': agent,
  };
}

// OTel events: [tag, session, sequence, time, kind, attrs]
export const OTEL_EVENTS = [
  ['oA', SJ1, 1, '16:00:01.500', 'api_request', reqAttrs({
    model: OPUS, t: [100, 10, 0, 0, 0, 0], usd: 0.0006, micros: 600, requestId: 'req_oj_a', qs: 'repl_main_thread', effort: 'high',
  })],
  // A conflicting duplicate of oA: same request and fields, a different cost. The earlier event owns the request.
  ['oA2', SJ1, 2, '16:00:06.000', 'api_request', reqAttrs({
    model: OPUS, t: [100, 10, 0, 0, 0, 0], usd: 0.0009, micros: 900, requestId: 'req_oj_a', qs: 'repl_main_thread', effort: 'high',
  })],
  ['oB', SJ1, 3, '16:00:02.500', 'api_request', reqAttrs({
    model: HAIKU, t: [1000, 200, 5000, 0, 0, 0], usd: 0.00025, micros: 250, requestId: 'req_oj_b', qs: 'agent:builtin:Explore', effort: 'high', agent: 'Explore',
  })],
  ['oC', SJ1, 4, '16:00:03.500', 'api_request', reqAttrs({
    model: SONNET, t: [200, 50, 1000, 400, 400, 0], usd: 0.0021, micros: 2100, requestId: 'req_oj_c', qs: 'agent:builtin:general-purpose', effort: 'high', agent: 'general-purpose',
  })],
  ['oD', SJ1, 5, '16:00:04.500', 'api_request', reqAttrs({
    model: HAIKU, t: [50, 20, 0, 0, 0, 0], usd: 0.0000156, micros: 16, requestId: 'req_oj_d', qs: 'agent:builtin:claude-code-guide', effort: 'medium', agent: 'claude-code-guide',
  })],
  // Decoys: other kinds that carry a request_id; the join must never use them.
  ['xC', SJ1, 6, '16:00:05.000', 'api_error', {
    model: SONNET, status_code: 529, attempt: 1, request_id: 'req_oj_c', query_source: 'agent:builtin:general-purpose', 'agent.name': 'general-purpose',
  }],
  ['xA', SJ1, 7, '16:00:05.500', 'assistant_response', { response_length: 12, request_id: 'req_oj_a', model: OPUS, query_source: 'sdk' }],
  ['oE', SJ2, 1, '16:10:03.500', 'api_request', reqAttrs({
    model: SONNET, t: [10, 10, 0, 0, 0, 0], usd: 0.000125, micros: 125, requestId: 'req_oj_e', qs: 'agent:custom', effort: 'medium', agent: 'custom',
  })],
  ['oG', SJ2, 2, '16:10:02.500', 'api_request', reqAttrs({
    model: HAIKU, t: [20, 20, 0, 0, 0, 0], usd: 0.0000121, micros: 12, requestId: 'req_oj_g', qs: 'sdk', effort: 'high',
  })],
  ['O1', SO1, 1, '16:30:01.000', 'api_request', reqAttrs({
    model: HAIKU, t: [300, 100, 0, 0, 0, 0], usd: 0.00008, micros: 80, requestId: 'req_oo_1', qs: 'agent_summary',
  })],
  // cost_usd_micros only (no cost_usd).
  ['O2', SO1, 2, '16:30:02.000', 'api_request', reqAttrs({
    model: HAIKU, t: [10, 5, 0, 0, 0, 0], micros: 4, requestId: 'req_oo_2', qs: 'prompt_suggestion',
  })],
  // No request_id: keyed e:<session>:<sequence>:<event time>.
  ['O8', SO1, 3, '16:30:03.000', 'api_request', reqAttrs({
    model: HAIKU, t: [5, 5, 0, 0, 0, 0], usd: 0.000003, micros: 3, qs: 'repl_main_thread',
  })],
  ['O5', SO2, 1, '16:40:01.000', 'api_request', reqAttrs({
    model: HAIKU, t: [100, 100, 200, 0, 0, 0], usd: 0.000062, micros: 62, requestId: 'req_oo_5', qs: 'agent:builtin:Explore', effort: 'low', agent: 'Explore',
  })],
  ['O6', SO2, 2, '16:40:02.000', 'api_request', reqAttrs({
    model: OPUS, t: [20, 30, 0, 0, 0, 0], usd: 0.00068, micros: 680, requestId: 'req_oo_6', qs: 'repl_main_thread:outputStyle:Explanatory',
  })],
  ['O4', SO3, 1, '16:50:01.000', 'api_request', reqAttrs({
    model: SONNET, t: [40, 10, 0, 0, 0, 0], usd: 0.00018, micros: 180, requestId: 'req_oo_4', qs: 'sdk', effort: 'low',
  })],
  // The planted hostile label as query_source and the hostile agent name: the 01-03 normalizer rejects both.
  ['O7', SO3, 2, '16:50:02.000', 'api_request', reqAttrs({
    model: SONNET, t: [2, 2, 0, 0, 0, 0], usd: 0.000024, micros: 24, requestId: 'req_oo_7', qs: OTEL_PLANTS.hostileLabel, agent: OTEL_PLANTS.hostileAgentName,
  })],
  ['O10', SO3, 3, '16:50:03.000', 'api_request', reqAttrs({
    model: SONNET, t: [5, 5, 0, 0, 0, 0], usd: 0.00006, micros: 60, requestId: 'req_oo_10', qs: 'sdk',
  })],
  ['O9', SJ3, 1, '16:20:01.500', 'api_request', reqAttrs({
    model: HAIKU, t: [10, 10, 0, 0, 0, 0], usd: 0.000006, micros: 6, requestId: 'req_oo_9', qs: 'repl_main_thread',
  })],
];

export function otelLines() {
  return OTEL_EVENTS.map(([, session, seq, hms, kind, extra]) => eventLine({
    ts: T(hms), event: kind, attrs: evAttrs({ session, seq, ts: T(hms), name: kind, extra }), resource: resourceAttrs(),
  }));
}

export function build(ctx) {
  const { root, home, helpers: h } = ctx;
  const proj = join(root, 'projects', `${h.mangleHome(home)}-repos-join`);
  const cwd = `${home}/repos/join`;
  const fileOf = (session, agent) => (agent === ''
    ? join(proj, `${session}.jsonl`)
    : join(proj, session, 'subagents', `agent-${agent}.jsonl`));
  const byFile = new Map();
  for (const [, session, agent, msg, reqId, model, hms, a, effort, attribution] of CALLS) {
    const o = h.makeAssistant({
      session, ts: T(hms), id: msg, model, cwd, agentId: agent === '' ? undefined : agent, attributionAgent: attribution,
      use: h.makeUsage({ input: a[0], output: a[1], read: a[2], creation: a[3], c5: a[4], c1: a[5] }),
    });
    o.requestId = reqId;
    if (effort === undefined) delete o.effort;
    else o.effort = effort;
    const file = fileOf(session, agent);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(JSON.stringify(o));
  }
  for (const [file, lines] of byFile) h.writeJsonl(file, lines);
  for (const [session, agent, type] of META) {
    h.writeJsonl(join(proj, session, 'subagents', `agent-${agent}.meta.json`), [JSON.stringify({ agentType: type })], '');
  }
  const otelFile = join(liveDirFor(home), OTEL_FILE);
  h.writeJsonl(otelFile, otelLines());
  return [...byFile.keys(), otelFile];
}

const pre = '~-repos-join';
const meta = (session, agentId, agentType) => ({
  session_id: session, agent_id: agentId, agent_type: agentType, spawn_depth: null, model: null,
  tool_use_id: null, parent_agent_id: null, is_fork: null, workflow_phase: null, finished: null,
  spawned_with_worktree: null, stopped_by_user: null, launched_with_defaults: null, request_non_interactive: null,
});

export const expected = {
  messageKeys: Object.fromEntries(CALLS.map(([, session, agent, msg, , , , a]) => [`${session}|${agent}|${msg}`, a])),
  sourceFiles: [
    `claude:${pre}/${SJ1}.jsonl`,
    `claude:${pre}/${SJ1}/subagents/agent-${AB}.jsonl`,
    `claude:${pre}/${SJ1}/subagents/agent-${AB}.meta.json`,
    `claude:${pre}/${SJ1}/subagents/agent-${AC}.jsonl`,
    `claude:${pre}/${SJ1}/subagents/agent-${AC}.meta.json`,
    `claude:${pre}/${SJ1}/subagents/agent-${AD}.jsonl`,
    `claude:${pre}/${SJ2}.jsonl`,
    `claude:${pre}/${SJ2}/subagents/agent-${AE}.jsonl`,
    `claude:${pre}/${SJ2}/subagents/agent-${AE}.meta.json`,
    `claude:${pre}/${SJ3}.jsonl`,
    `live:${OTEL_FILE}`,
  ],
  agentMeta: [meta(SJ1, AB, 'Explore'), meta(SJ1, AC, 'general-purpose'), meta(SJ2, AE, 'gsd-executor')],
  skipped: {},
  unknownAttr: {},
  dropped: {},
  cwd: {},
};

// The OTel-only request keys. O8 has no request_id: e:<session>:<sequence>:<event time>.
export const O8_KEY = `e:${SO1}:3:${T('16:30:03.000')}`;

// Hand-computed join expectations. Nano-dollars unless a field says usd.
export const expectedJoin = {
  // Derived (01-05) cost per transcript call:
  derivedNano: {
    msg_oj_a: 600000, //   100 x 4000 + 10 x 20000 = 400,000 + 200,000
    msg_oj_b: 250000, //   1000 x 100 + 200 x 500 + 5000 x 10 = 100,000 + 100,000 + 50,000
    msg_oj_c: 2000000, //  200 x 2000 + 50 x 10000 + 1000 x 100 + 400 x 2500 = 400,000 + 500,000 + 100,000 + 1,000,000
    msg_oj_d: 15000, //    50 x 100 + 20 x 500 = 5,000 + 10,000
    msg_oj_e: 120000, //   10 x 2000 + 10 x 10000 = 20,000 + 100,000
    msg_oj_f: 6000, //     10 x 100 + 10 x 500 = 1,000 + 5,000
    msg_oj_g: 12000, //    20 x 100 + 20 x 500 = 2,000 + 10,000
    msg_oj_h: 6000, //     10 x 100 + 10 x 500
  },
  mainNano: 3009000, // 600,000 + 250,000 + 2,000,000 + 15,000 + 120,000 + 6,000 + 12,000 + 6,000
  // Measured (OTel owner) cost per joined request: cost_usd x 1e9, rounded half up.
  measuredNano: {
    req_oj_a: 600000, //  0.0006 (oA, the earlier of oA and oA2, owns the request)
    req_oj_b: 250000, //  0.00025
    req_oj_c: 2100000, // 0.0021
    req_oj_d: 15600, //   0.0000156
    req_oj_e: 125000, //  0.000125
    req_oj_g: 12100, //   0.0000121
  },
  joinState: {
    msg_oj_a: 'joined', msg_oj_b: 'joined', msg_oj_c: 'joined', msg_oj_d: 'joined', msg_oj_e: 'joined', msg_oj_g: 'joined',
    msg_oj_f: 'transcript_only', msg_oj_h: 'transcript_only',
  },
  // OTel-only calls: call_key -> cost_nano (cost_usd x 1e9; O2 from cost_usd_micros 4 x 1000).
  otelOnlyNano: {
    'o:req_oo_1': 80000, 'o:req_oo_2': 4000, [`o:${O8_KEY}`]: 3000, 'o:req_oo_5': 62000, 'o:req_oo_6': 680000,
    'o:req_oo_4': 180000, 'o:req_oo_7': 24000, 'o:req_oo_10': 60000, 'o:req_oo_9': 6000,
  },
  otelOnlySumNano: 1099000, // 80,000 + 4,000 + 3,000 + 62,000 + 680,000 + 180,000 + 24,000 + 60,000 + 6,000
  // call_key -> [role, role_rule, role_source]
  roles: {
    'm:msg_oj_a': ['main', 'main', 'derived'],
    'm:msg_oj_b': ['Explore', 'meta', 'transcript'],
    'm:msg_oj_c': ['fork', 'attribution', 'transcript'],
    'm:msg_oj_d': ['claude-code-guide', 'query_source', 'otel'],
    'm:msg_oj_e': ['gsd-executor', 'meta', 'transcript'],
    'm:msg_oj_f': ['main', 'main', 'derived'],
    'm:msg_oj_g': ['main', 'main', 'derived'],
    'm:msg_oj_h': ['main', 'main', 'derived'],
    'o:req_oo_1': ['harness:agent_summary', 'harness', 'otel'],
    'o:req_oo_2': ['harness:prompt_suggestion', 'harness', 'otel'],
    'o:req_oo_5': ['Explore', 'query_source', 'otel'],
    'o:req_oo_6': ['main', 'query_source_main', 'otel'],
    [`o:${O8_KEY}`]: ['main', 'query_source_main', 'otel'],
    'o:req_oo_9': ['main', 'query_source_main', 'otel'],
    'o:req_oo_4': ['unknown', 'none', 'unavailable'],
    'o:req_oo_7': ['unknown', 'none', 'unavailable'],
    'o:req_oo_10': ['unknown', 'none', 'unavailable'],
  },
  // call_key -> [qs_role, qs_conflict]; only C has a parsed role that differs from its transcript role.
  qs: {
    'm:msg_oj_b': ['Explore', 0],
    'm:msg_oj_c': ['general-purpose', 1],
    'm:msg_oj_d': ['claude-code-guide', null],
  },
  // call_key -> [effort, effort_source]
  effort: {
    'm:msg_oj_a': ['high', 'transcript'],
    'm:msg_oj_d': ['medium', 'otel'],
    'm:msg_oj_e': ['medium', 'transcript'],
    'm:msg_oj_h': [null, null],
    'o:req_oo_4': ['low', 'otel'],
    'o:req_oo_5': ['low', 'otel'],
    'o:req_oo_1': [null, null],
  },
  xcheck: {
    'm:msg_oj_a': 'no_name', 'm:msg_oj_b': 'agree', 'm:msg_oj_c': 'disagree', 'm:msg_oj_d': 'no_transcript_role',
    'm:msg_oj_e': 'custom', 'm:msg_oj_g': 'no_name', 'm:msg_oj_f': null, 'm:msg_oj_h': null, 'o:req_oo_1': 'not_joined',
  },
  sections: { main: 8, otel: 7, harness: 2 },
  // Rows: role, model, calls, input, output, cache_read, cache_write, notional_usd (window cells are ?).
  mainRows: [
    ['Explore', HAIKU, '1', '1000', '200', '5000', '0', '0.000250'], //            B: 250,000 nano
    ['claude-code-guide', HAIKU, '1', '50', '20', '0', '0', '0.000015'], //       D: 15,000
    ['fork', SONNET, '1', '200', '50', '1000', '400', '0.002000'], //               C: 2,000,000
    ['gsd-executor', SONNET, '1', '10', '10', '0', '0', '0.000120'], //             E: 120,000
    ['main', HAIKU, '3', '40', '40', '0', '0', '0.000024'], //                      F G H: 10+20+10, 10+20+10, 6,000+12,000+6,000
    ['main', OPUS, '1', '100', '10', '0', '0', '0.000600'], //                      A: 600,000
  ],
  otelRows: [
    ['Explore', HAIKU, '1', '100', '100', '200', '0', '0.000062'], //               O5: 62,000
    ['main', HAIKU, '2', '15', '15', '0', '0', '0.000009'], //                      O8 + O9: 5+10, 5+10, 3,000 + 6,000
    ['main', OPUS, '1', '20', '30', '0', '0', '0.000680'], //                       O6: 680,000
    ['unknown', SONNET, '3', '47', '17', '0', '0', '0.000264'], //                  O4 O7 O10: 40+2+5, 10+2+5, 180,000+24,000+60,000
  ],
  harnessRows: [
    ['harness:agent_summary', HAIKU, '1', '300', '100', '0', '0', '0.000080'], //   O1: 80,000
    ['harness:prompt_suggestion', HAIKU, '1', '10', '5', '0', '0', '0.000004'], //  O2: 4,000
  ],
  footer: {
    labels: 'labels: tokens=transcript notional_usd=derived window_share=unavailable; ? means unknown (label unavailable), never zero',
    labelsOtel: 'labels (otel rows): tokens=otel notional_usd=otel window_share=unavailable',
    conservation: 'conservation: OK (role sums = model sums = part total = store total for each of the 6 token classes)',
    counts: 'counts: calls=8 parts=8 duplicates_collapsed=0 synthetic_skipped=0 top_level_only=8 iteration_mismatch=0 unknown_iteration_type=0',
    // input 100+1000+200+50+10+20+10+10 = 1400; output 10+200+50+20+10+10+20+10 = 330; cache_read 5000+1000 = 6000; write 400 (5m)
    totals: 'totals: input=1400 output=330 cache_read=6000 cache_write=400 cache_5m=400 cache_1h=0',
    pricingParts: { priced_parts: 8, unpriced_parts: 0 },
    notional: 'notional: usd=0.003009 label=derived',
    // 8 transcript parts + 9 OTel-only parts, no usage snapshot
    window: 'window: weights=input:1,output:1,cache_read:1,cache_creation:1 snapshots=0 intervals_5h=none intervals_7d=none parts_5h=0/17 parts_7d=0/17 window_conservation=OK',
    // 15 requests (oA/oA2 one request); joined 6 (A B C D E G); joinable denominator 15 - 2 harness = 13;
    // excl_sdk: denominator 13 - 3 sdk (oG, O4, O10) = 10, numerator 6 - 1 joined sdk (oG) = 5.
    // 6/15 = 40.00%, 6/13 = 46.153...% -> 46.15%, 5/10 = 50.00%. Sessions: SJ1 SJ2 SJ3 SO1 SO2 SO3 = 6; no transcript
    // SO1 SO2 SO3 = 3; zero joined SJ3 SO1 SO2 SO3 = 4.
    join: 'join: otel_requests=15 joined=6 raw=6/15 (40.00%) joinable=6/13 (46.15%) excl_sdk=5/10 (50.00%) transcript_calls=8 '
      + 'joined_calls=6 transcript_only_calls=2 otel_sessions=6 sessions_no_transcript=3 sessions_zero_joined=4 duplicates=1 '
      + 'conflicting_duplicates=1 no_request_id=1 multi_message_requests=0',
    // harness O1 O2; attribution C; meta B E; transcript main A F G H; query_source D O5; query_source_main O6 O8 O9;
    // unknown O4 O7 O10 (17 calls)
    roles: 'roles: harness=2 attribution=1 meta=2 transcript_main=4 query_source=2 query_source_main=3 unknown=3 '
      + 'conflict_attr_meta=1 conflict_query_source=1 harness_joined=0',
    // input 300+10+5+100+20+40+2+5+10 = 492; output 100+5+5+100+30+10+2+5+10 = 267; cache_read 200; usd 1,099,000 nano
    otelOnly: 'otel-only: calls=9 harness_calls=2 input=492 output=267 cache_read=200 cache_write=0 usd=0.001099 label=otel tokens=executor_only',
    crosscheck: 'crosscheck: compared=2 agree=1 disagree=1 custom=1 no_name=2 no_transcript_role=1 not_joined=9',
    disagree: ['  disagree: transcript=fork otel=general-purpose n=1'],
    // Band (joined requests A B C D E G): errors in ppm, abs(derived - measured) x 1e6 / measured, half up:
    //   A 0, B 0, G 100 x 1e6 / 12,100 = 8264.46 -> 8264, D 600 x 1e6 / 15,600 = 38461.54 -> 38462,
    //   E 5,000 x 1e6 / 125,000 = 40000, C 100,000 x 1e6 / 2,100,000 = 47619.05 -> 47619.
    // median rank ceil(50 x 6 / 100) = 3 -> 8264 (0.83%); p99 rank ceil(5.94) = 6 -> 47619 (4.76%); max 4.76%.
    // sum_derived 600,000+250,000+2,000,000+15,000+120,000+12,000 = 2,997,000 (0.002997);
    // sum_measured 600,000+250,000+2,100,000+15,600+125,000+12,100 = 3,102,700 (0.003103);
    // diff -105,700 (-0.000106), 105,700 x 1e6 / 3,102,700 = 34067 ppm -> -3.41%.
    errorBand: 'error-band: joined n=6 median_abs_err=0.83% p99_abs_err=4.76% max_abs_err=4.76% sum_derived=0.002997 '
      + 'sum_measured=0.003103 diff=-0.000106 (-3.41%) excluded=derived_unknown:0,measured_unknown:0,zero_measured:0 '
      + 'top_level_only=6 floor=0 measured=otel derived=notional',
    outliers: [
      `  outlier: request=req_oj_c calls=1 role=fork model=${SONNET} derived=0.002000 measured=0.002100 err=4.76%`,
      `  outlier: request=req_oj_e calls=1 role=gsd-executor model=${SONNET} derived=0.000120 measured=0.000125 err=4.00%`,
      `  outlier: request=req_oj_d calls=1 role=claude-code-guide model=${HAIKU} derived=0.000015 measured=0.000016 err=3.85%`,
      `  outlier: request=req_oj_g calls=1 role=main model=${HAIKU} derived=0.000012 measured=0.000012 err=0.83%`,
    ],
    rules: 'rules: role=harness,attribution,meta,transcript_main,query_source,query_source_main,unknown (first match wins); '
      + 'sdk=transcript role when joined, else unknown; harness_sources=agent_summary,prompt_suggestion,web_fetch_apply,'
      + 'web_search_tool,generate_session_title,away_summary; effort=transcript else otel; tokens=transcript for transcript calls, '
      + 'otel executor-only for otel-only calls; cost=derived from the price table for transcript calls, otel cost_usd for otel-only calls',
  },
  bandPpm: [0, 0, 8264, 38462, 40000, 47619],
  joinStat: {
    otel_requests: 15, joined: 6, harness_requests: 2, harness_joined: 0, sdk_requests: 3, sdk_joined: 1, otel_sessions: 6,
    sessions_no_transcript: 3, sessions_zero_joined: 4, duplicates: 1, conflicting_duplicates: 1, no_request_id: 1,
    multi_message_requests: 0, transcript_calls: 8, joined_calls: 6, transcript_only_calls: 2,
  },
  footerOrder: ['labels', 'labels (otel rows)', 'conservation', 'counts', 'totals', 'pricing', 'notional', 'window', 'join', 'roles',
    'otel-only', 'crosscheck', 'error-band', 'rules'],
};

// The 01-03 normalizer must have rejected O7's hostile query_source and agent name: confirm on the store.
export function verify(ctx) {
  const db = new DatabaseSync(join(ctx.home, '.rigorscope', 'store.db'), { readOnly: true });
  try {
    const n = db.prepare("SELECT count(*) AS n FROM otel_event WHERE kind = 'api_request'").get().n;
    if (n !== 16) throw new Error(`api_request events ${n}`); // 18 OTel lines minus the two decoys
    const o7 = db.prepare("SELECT attrs FROM otel_event WHERE request_id = 'req_oo_7'").get();
    const attrs = JSON.parse(o7.attrs);
    if (Object.hasOwn(attrs, 'query_source') || Object.hasOwn(attrs, 'agent.name')) throw new Error('a hostile O7 field was stored');
  } finally {
    db.close();
  }
}
