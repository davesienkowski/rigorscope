// Case 70: duplicate occurrences of one message id for the derivation pass (plan 01-04, D-03, D-12).
//   S9   a fork pair: msg_dup_1 in two sub-agent files (agent cccc with attribution general-purpose,
//        agent dddd with attribution fork; both metas say general-purpose). Equal timestamps, equal file
//        times, same root: under the earliest owner rule the relative path decides (cccc).
//   S10  msg_dup_2 (output 7), a <synthetic> line, msg_stream_1 streamed over three lines (output 3, 9, 12)
//   S11  a partial copy: msg_dup_2 again, later, with output 25
// Everything is hand-computed below, never by the code under test. Never imports build.mjs.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const id = 'derive-dups';
export const group = 'extra';
export const sources = ['transcript'];

export const S9 = '99999999-9999-4999-8999-999999999999';
export const S10 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const S11 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AC = 'agentcccc00000001';
const AD = 'agentdddd00000002';
const T = (hms) => `2026-10-27T${hms}Z`;

export function build(ctx) {
  const { root, home, plants, helpers: h } = ctx;
  const proj = join(root, 'projects', `${h.mangleHome(home)}-repos-dups`);
  const cwd = `${home}/repos/dups`;
  const sub = join(proj, S9, 'subagents');
  const dup1 = (agentId, attributionAgent) => JSON.stringify(h.makeAssistant({
    session: S9, ts: T('14:00:01.000'), id: 'msg_dup_1', model: 'claude-opus-5-5', cwd, agentId, attributionAgent,
    use: h.makeUsage({ input: 10, output: 20, read: 30, creation: 4, c5: 4, c1: 0 }),
  })).replace('"requestId":"req_msg_dup_1"', '"requestId":"req-d1"');
  const files = [
    join(proj, `${S9}.jsonl`),
    join(sub, `agent-${AC}.jsonl`),
    join(sub, `agent-${AD}.jsonl`),
    join(proj, `${S10}.jsonl`),
    join(proj, `${S11}.jsonl`),
  ];
  h.writeJsonl(files[0], [h.userLine({ session: S9, ts: T('13:59:59.000'), text: plants.prompt, cwd })]);
  h.writeJsonl(files[1], [dup1(AC, 'general-purpose')]);
  h.writeJsonl(files[2], [dup1(AD, 'fork')]);
  writeFileSync(join(sub, `agent-${AC}.meta.json`), JSON.stringify({ agentType: 'general-purpose' }));
  writeFileSync(join(sub, `agent-${AD}.meta.json`), JSON.stringify({ agentType: 'general-purpose' }));

  const synthetic = h.makeAssistant({
    session: S10, ts: T('14:10:02.000'), id: 'msg_synth_1', model: '<synthetic>', cwd,
    use: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  const stream = (ts, output) => JSON.stringify(h.makeAssistant({
    session: S10, ts: T(ts), id: 'msg_stream_1', model: 'claude-haiku-5-5', cwd,
    use: h.makeUsage({ input: 40, output, read: 100, creation: 8, c5: 8, c1: 0 }),
  }));
  h.writeJsonl(files[3], [
    JSON.stringify(h.makeAssistant({
      session: S10, ts: T('14:10:01.000'), id: 'msg_dup_2', model: 'claude-sonnet-5-5', cwd,
      use: h.makeUsage({ input: 5, output: 7, read: 0, creation: 0, c5: 0, c1: 0 }),
    })),
    JSON.stringify(synthetic),
    stream('14:10:10.000', 3), stream('14:10:11.000', 9), stream('14:10:12.000', 12),
  ]);
  h.writeJsonl(files[4], [
    JSON.stringify(h.makeAssistant({
      session: S11, ts: T('14:10:05.000'), id: 'msg_dup_2', model: 'claude-sonnet-5-5', cwd,
      use: h.makeUsage({ input: 5, output: 25, read: 0, creation: 0, c5: 0, c1: 0 }),
    })),
  ]);
  return files;
}

const pre = '~-repos-dups';
const meta = (agentId) => ({
  session_id: S9, agent_id: agentId, agent_type: 'general-purpose', spawn_depth: null, model: null,
  tool_use_id: null, parent_agent_id: null, is_fork: null, workflow_phase: null, finished: null,
  spawned_with_worktree: null, stopped_by_user: null, launched_with_defaults: null, request_non_interactive: null,
});

export const expected = {
  // [input, output, cache_read, cache_creation, cache_5m, cache_1h]; null = unknown
  messageKeys: {
    [`${S9}|${AC}|msg_dup_1`]: [10, 20, 30, 4, 4, 0],
    [`${S9}|${AD}|msg_dup_1`]: [10, 20, 30, 4, 4, 0],
    [`${S10}||msg_dup_2`]: [5, 7, 0, 0, 0, 0],
    [`${S11}||msg_dup_2`]: [5, 25, 0, 0, 0, 0],
    [`${S10}||msg_synth_1`]: [0, 0, 0, 0, null, null],
    [`${S10}||msg_stream_1`]: [40, 12, 100, 8, 8, 0],
  },
  sourceFiles: [
    `claude:${pre}/${S9}.jsonl`,
    `claude:${pre}/${S9}/subagents/agent-${AC}.jsonl`,
    `claude:${pre}/${S9}/subagents/agent-${AC}.meta.json`,
    `claude:${pre}/${S9}/subagents/agent-${AD}.jsonl`,
    `claude:${pre}/${S9}/subagents/agent-${AD}.meta.json`,
    `claude:${pre}/${S10}.jsonl`,
    `claude:${pre}/${S11}.jsonl`,
  ],
  agentMeta: [meta(AC), meta(AD)],
  skipped: {},
  unknownAttr: {},
  dropped: {},
  cwd: {},
};

// Hand-computed derived facts (plan 01-04). Rows: [role, model, calls, input, output, cache_read, cache_write].
export const expectedDerived = {
  calls: 3,
  parts: 3,
  rows: [
    ['general-purpose', 'claude-opus-5-5', '1', '10', '20', '30', '4'],
    ['main', 'claude-haiku-5-5', '1', '40', '12', '100', '8'],
    ['main', 'claude-sonnet-5-5', '1', '5', '25', '0', '0'],
  ],
  // Under the reversed (latest) owner rule msg_dup_1 is owned by agent dddd: role fork, meta general-purpose.
  rowsLatest: [
    ['fork', 'claude-opus-5-5', '1', '10', '20', '30', '4'],
    ['main', 'claude-haiku-5-5', '1', '40', '12', '100', '8'],
    ['main', 'claude-sonnet-5-5', '1', '5', '25', '0', '0'],
  ],
  counts: 'counts: calls=3 parts=3 duplicates_collapsed=2 synthetic_skipped=1 top_level_only=3 iteration_mismatch=0 unknown_iteration_type=0',
  totalsLine: 'totals: input=55 output=57 cache_read=130 cache_write=12 cache_5m=12 cache_1h=0',
  // Per class: known sum and known part count.
  totals: {
    input_tokens: [55, 3], output_tokens: [57, 3], cache_read: [130, 3], cache_creation: [12, 3], cache_5m: [12, 3], cache_1h: [0, 3],
  },
  occurrences: { msg_dup_1: 2, msg_dup_2: 2, msg_stream_1: 1 },
  owner: {
    earliest: { msg_dup_1: [S9, AC], msg_dup_2: [S10, ''], msg_stream_1: [S10, ''] },
    latest: { msg_dup_1: [S9, AD], msg_dup_2: [S11, ''], msg_stream_1: [S10, ''] },
  },
  roleLatestDup1: { role: 'fork', role_rule: 'attribution', role_meta: 'general-purpose', role_conflict: 1 },
  state: {
    api_call_rows: 3, api_call_part_rows: 3, duplicate_occurrences: 2, synthetic_skipped: 1, top_level_only_calls: 3,
    iter_mismatch_calls: 0, iter_unknown_type_calls: 0, role_conflict_calls: 0, cache_split_mismatch_parts: 0,
  },
};
