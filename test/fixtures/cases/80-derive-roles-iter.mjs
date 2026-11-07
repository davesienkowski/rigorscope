// Case 80: role precedence and usage.iterations for the derivation pass (plan 01-04, COST-01, COST-02).
// Session S12. Sub-agent files: eeee (meta Explore, no attribution), ffff (no meta, no attribution),
// gggg (meta gsd-verifier, attribution gsd-verifier), hhhh (meta general-purpose, attribution fork).
// Main file: R1 and I1 to I5. I1 has two advisor iterations on claude-fable-5-0, I2 a message iteration
// that disagrees with the top level, I3 an iteration of an unrecognized type, I4 an advisor iteration
// with no model, I5 no iterations. Everything is hand-computed below. Never imports build.mjs.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const id = 'derive-roles-iter';
export const group = 'extra';
export const sources = ['transcript'];

export const S12 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AE = 'agenteeee00000001';
const AF = 'agentffff00000002';
const AG = 'agentgggg00000003';
const AH = 'agenthhhh00000004';
const T = (hms) => `2026-10-27T${hms}Z`;

// [input, output, cache_read, cache_creation, cache_5m, cache_1h]
const tok = (a) => ({ input: a[0], output: a[1], read: a[2], creation: a[3], c5: a[4], c1: a[5] });
const iter = (type, model, a) => {
  const o = { type };
  if (model !== undefined) o.model = model;
  Object.assign(o, {
    input_tokens: a[0], output_tokens: a[1], cache_read_input_tokens: a[2], cache_creation_input_tokens: a[3],
    cache_creation: { ephemeral_5m_input_tokens: a[4], ephemeral_1h_input_tokens: a[5] },
  });
  return o;
};

export function build(ctx) {
  const { root, home, helpers: h } = ctx;
  const proj = join(root, 'projects', `${h.mangleHome(home)}-repos-roles`);
  const cwd = `${home}/repos/roles`;
  const sub = join(proj, S12, 'subagents');
  const line = ({ ts, id: mid, model, a, agentId, attributionAgent, iterations }) => {
    const use = h.makeUsage(tok(a));
    if (iterations) use.iterations = iterations;
    return JSON.stringify(h.makeAssistant({
      session: S12, ts: T(ts), id: mid, model, cwd, agentId, attributionAgent, use,
    }));
  };
  const files = [
    join(proj, `${S12}.jsonl`),
    join(sub, `agent-${AE}.jsonl`),
    join(sub, `agent-${AF}.jsonl`),
    join(sub, `agent-${AG}.jsonl`),
    join(sub, `agent-${AH}.jsonl`),
  ];
  const i1 = [100, 50, 1000, 200, 150, 50];
  h.writeJsonl(files[0], [
    line({ ts: '15:00:01.000', id: 'msg_r1', model: 'claude-opus-5-5', a: [1, 2, 3, 4, 4, 0] }),
    line({
      ts: '15:10:01.000', id: 'msg_i1', model: 'claude-opus-5-5', a: i1,
      iterations: [
        iter('message', 'claude-opus-5-5', i1),
        iter('advisor_message', 'claude-fable-5-0', [30, 20, 0, 0, 0, 0]),
        iter('advisor_message', 'claude-fable-5-0', [4, 6, 0, 0, 0, 0]),
      ],
    }),
    line({
      ts: '15:10:02.000', id: 'msg_i2', model: 'claude-sonnet-5-5', a: [10, 10, 10, 10, 10, 0],
      iterations: [iter('message', 'claude-sonnet-5-5', [9, 10, 10, 10, 10, 0])],
    }),
    line({
      ts: '15:10:03.000', id: 'msg_i3', model: 'claude-sonnet-5-5', a: [7, 7, 7, 7, 7, 0],
      iterations: [
        iter('message', 'claude-sonnet-5-5', [7, 7, 7, 7, 7, 0]),
        iter('tool_message', 'claude-sonnet-5-5', [100, 100, 100, 100, 100, 100]),
      ],
    }),
    line({
      ts: '15:10:04.000', id: 'msg_i4', model: 'claude-opus-5-5', a: [5, 5, 5, 5, 5, 0],
      iterations: [
        iter('message', 'claude-opus-5-5', [5, 5, 5, 5, 5, 0]),
        iter('advisor_message', undefined, [2, 3, 0, 0, 0, 0]),
      ],
    }),
    line({ ts: '15:10:05.000', id: 'msg_i5', model: 'claude-haiku-5-5', a: [3, 4, 5, 6, 6, 0] }),
  ]);
  h.writeJsonl(files[1], [line({ ts: '15:00:02.000', id: 'msg_r2', model: 'claude-haiku-5-5', a: [10, 11, 12, 13, 13, 0], agentId: AE })]);
  h.writeJsonl(files[2], [line({ ts: '15:00:03.000', id: 'msg_r3', model: 'claude-sonnet-5-5', a: [20, 21, 22, 23, 20, 3], agentId: AF })]);
  h.writeJsonl(files[3], [line({
    ts: '15:00:04.000', id: 'msg_r4', model: 'claude-opus-5-5', a: [30, 31, 32, 33, 30, 3], agentId: AG, attributionAgent: 'gsd-verifier',
  })]);
  h.writeJsonl(files[4], [line({
    ts: '15:00:05.000', id: 'msg_r5', model: 'claude-sonnet-5-5', a: [40, 41, 42, 43, 43, 0], agentId: AH, attributionAgent: 'fork',
  })]);
  writeFileSync(join(sub, `agent-${AE}.meta.json`), JSON.stringify({ agentType: 'Explore' }));
  writeFileSync(join(sub, `agent-${AG}.meta.json`), JSON.stringify({ agentType: 'gsd-verifier' }));
  writeFileSync(join(sub, `agent-${AH}.meta.json`), JSON.stringify({ agentType: 'general-purpose' }));
  return files;
}

const pre = '~-repos-roles';
const meta = (agentId, agentType) => ({
  session_id: S12, agent_id: agentId, agent_type: agentType, spawn_depth: null, model: null,
  tool_use_id: null, parent_agent_id: null, is_fork: null, workflow_phase: null, finished: null,
  spawned_with_worktree: null, stopped_by_user: null, launched_with_defaults: null, request_non_interactive: null,
});

export const expected = {
  messageKeys: {
    [`${S12}||msg_r1`]: [1, 2, 3, 4, 4, 0],
    [`${S12}|${AE}|msg_r2`]: [10, 11, 12, 13, 13, 0],
    [`${S12}|${AF}|msg_r3`]: [20, 21, 22, 23, 20, 3],
    [`${S12}|${AG}|msg_r4`]: [30, 31, 32, 33, 30, 3],
    [`${S12}|${AH}|msg_r5`]: [40, 41, 42, 43, 43, 0],
    [`${S12}||msg_i1`]: [100, 50, 1000, 200, 150, 50],
    [`${S12}||msg_i2`]: [10, 10, 10, 10, 10, 0],
    [`${S12}||msg_i3`]: [7, 7, 7, 7, 7, 0],
    [`${S12}||msg_i4`]: [5, 5, 5, 5, 5, 0],
    [`${S12}||msg_i5`]: [3, 4, 5, 6, 6, 0],
  },
  // [iter_seq, iter_type, model, input, output, cache_read, cache_creation, cache_5m, cache_1h]
  iterations: {
    [`${S12}||msg_i1`]: [
      [0, 'message', 'claude-opus-5-5', 100, 50, 1000, 200, 150, 50],
      [1, 'advisor_message', 'claude-fable-5-0', 30, 20, 0, 0, 0, 0],
      [2, 'advisor_message', 'claude-fable-5-0', 4, 6, 0, 0, 0, 0],
    ],
    [`${S12}||msg_i2`]: [[0, 'message', 'claude-sonnet-5-5', 9, 10, 10, 10, 10, 0]],
    [`${S12}||msg_i3`]: [
      [0, 'message', 'claude-sonnet-5-5', 7, 7, 7, 7, 7, 0],
      [1, 'tool_message', 'claude-sonnet-5-5', 100, 100, 100, 100, 100, 100],
    ],
    [`${S12}||msg_i4`]: [
      [0, 'message', 'claude-opus-5-5', 5, 5, 5, 5, 5, 0],
      [1, 'advisor_message', null, 2, 3, 0, 0, 0, 0],
    ],
  },
  sourceFiles: [
    `claude:${pre}/${S12}.jsonl`,
    `claude:${pre}/${S12}/subagents/agent-${AE}.jsonl`,
    `claude:${pre}/${S12}/subagents/agent-${AE}.meta.json`,
    `claude:${pre}/${S12}/subagents/agent-${AF}.jsonl`,
    `claude:${pre}/${S12}/subagents/agent-${AG}.jsonl`,
    `claude:${pre}/${S12}/subagents/agent-${AG}.meta.json`,
    `claude:${pre}/${S12}/subagents/agent-${AH}.jsonl`,
    `claude:${pre}/${S12}/subagents/agent-${AH}.meta.json`,
  ],
  agentMeta: [meta(AE, 'Explore'), meta(AG, 'gsd-verifier'), meta(AH, 'general-purpose')],
  skipped: {},
  unknownAttr: {},
  dropped: {},
  cwd: {},
};

// Rows: [dimension values..., calls, input, output, cache_read, cache_write]; '?' is a NULL model.
export const expectedDerived = {
  calls: 10,
  parts: 12,
  rows: [
    ['Explore', 'claude-haiku-5-5', '1', '10', '11', '12', '13'],
    ['fork', 'claude-sonnet-5-5', '1', '40', '41', '42', '43'],
    ['gsd-verifier', 'claude-opus-5-5', '1', '30', '31', '32', '33'],
    ['main', 'claude-fable-5-0', '1', '34', '26', '0', '0'],
    ['main', 'claude-haiku-5-5', '1', '3', '4', '5', '6'],
    ['main', 'claude-opus-5-5', '3', '106', '57', '1008', '209'],
    ['main', 'claude-sonnet-5-5', '2', '17', '17', '17', '17'],
    ['main', '?', '1', '2', '3', '0', '0'],
    ['unknown', 'claude-sonnet-5-5', '1', '20', '21', '22', '23'],
  ],
  rowsByRole: [
    ['Explore', '1', '10', '11', '12', '13'],
    ['fork', '1', '40', '41', '42', '43'],
    ['gsd-verifier', '1', '30', '31', '32', '33'],
    ['main', '6', '162', '107', '1030', '232'],
    ['unknown', '1', '20', '21', '22', '23'],
  ],
  rowsByModel: [
    ['claude-fable-5-0', '1', '34', '26', '0', '0'],
    ['claude-haiku-5-5', '2', '13', '15', '17', '19'],
    ['claude-opus-5-5', '4', '136', '88', '1040', '242'],
    ['claude-sonnet-5-5', '4', '77', '79', '81', '83'],
    ['?', '1', '2', '3', '0', '0'],
  ],
  counts: 'counts: calls=10 parts=12 duplicates_collapsed=0 synthetic_skipped=0 top_level_only=6 iteration_mismatch=1 unknown_iteration_type=1',
  totalsLine: 'totals: input=262 output=211 cache_read=1138 cache_write=344 cache_5m=288 cache_1h=56',
  totals: {
    input_tokens: [262, 12], output_tokens: [211, 12], cache_read: [1138, 12], cache_creation: [344, 12], cache_5m: [288, 12], cache_1h: [56, 12],
  },
  calls_facts: {
    msg_r1: { role: 'main', role_rule: 'main', role_source: 'derived', role_meta: null, role_conflict: null, price_basis: 'top_level_only' },
    msg_r2: { role: 'Explore', role_rule: 'meta', role_source: 'transcript', role_meta: 'Explore', role_conflict: null, price_basis: 'top_level_only' },
    msg_r3: { role: 'unknown', role_rule: 'none', role_source: 'unavailable', role_meta: null, role_conflict: null, price_basis: 'top_level_only' },
    msg_r4: { role: 'gsd-verifier', role_rule: 'attribution', role_source: 'transcript', role_meta: 'gsd-verifier', role_conflict: 0, price_basis: 'top_level_only' },
    msg_r5: { role: 'fork', role_rule: 'attribution', role_source: 'transcript', role_meta: 'general-purpose', role_conflict: 1, price_basis: 'top_level_only' },
    msg_i1: { price_basis: 'iterations', iter_mismatch: 0, iter_unknown_type: 0 },
    msg_i2: { price_basis: 'iterations', iter_mismatch: 1, iter_unknown_type: 0 },
    msg_i3: { price_basis: 'iterations', iter_mismatch: 0, iter_unknown_type: 1 },
    msg_i4: { price_basis: 'iterations', iter_mismatch: 0, iter_unknown_type: 0 },
    msg_i5: { price_basis: 'top_level_only', iter_mismatch: 0, iter_unknown_type: 0 },
  },
  state: {
    api_call_rows: 10, api_call_part_rows: 12, duplicate_occurrences: 0, synthetic_skipped: 0, top_level_only_calls: 6,
    iter_mismatch_calls: 1, iter_unknown_type_calls: 1, role_conflict_calls: 1, cache_split_mismatch_parts: 0,
  },
};
