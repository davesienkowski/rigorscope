// Case 30: usage.iterations and server_tool_use. M41 streams in three lines; the last line carries
// the field-wise maximum and an advisor_message iteration with its own model.
import { join } from 'node:path';

export const id = 'iterations';
export const group = 'extra';
export const sources = ['transcript'];

export const S4 = '44444444-4444-4444-8444-444444444444';
const t = (s) => `2026-10-27T13:10:0${s}.000Z`;

const iter = (type, model, o) => ({
  type, model, input_tokens: o.input, output_tokens: o.output, cache_read_input_tokens: o.read,
  cache_creation_input_tokens: o.creation,
  cache_creation: { ephemeral_5m_input_tokens: o.c5, ephemeral_1h_input_tokens: o.c1 },
});

export function build(ctx) {
  const { root, home, helpers: h } = ctx;
  const file = join(root, 'projects', `${h.mangleHome(home)}-repos-adv`, `${S4}.jsonl`);
  const cwd = `${home}/repos/adv`;
  const m41 = (n, out, withAdvisor) => {
    const use = h.makeUsage({ input: 100, output: out, read: 1000, creation: 50, c5: 50, c1: 0 });
    use.iterations = [iter('message', 'claude-opus-5-5', { input: 100, output: out, read: 1000, creation: 50, c5: 50, c1: 0 })];
    if (withAdvisor) use.iterations.push(iter('advisor_message', 'claude-fable-5-0', { input: 30, output: 20, read: 0, creation: 0, c5: 0, c1: 0 }));
    return JSON.stringify(h.makeAssistant({ session: S4, ts: t(n), id: 'msg_m41', model: 'claude-opus-5-5', cwd, use }));
  };
  const u42 = h.makeUsage({ input: 9, output: 9, read: 9, creation: 9, c5: 9, c1: 0 });
  u42.server_tool_use = { web_search_requests: 1 };
  h.writeJsonl(file, [
    m41(1, 5, false), m41(2, 25, false), m41(3, 40, true),
    JSON.stringify(h.makeAssistant({ session: S4, ts: t(4), id: 'msg_m42', model: 'claude-sonnet-5-5', cwd, use: u42 })),
  ]);
  return [file];
}

export const expected = {
  messageKeys: {
    [`${S4}||msg_m41`]: [100, 40, 1000, 50, 50, 0],
    [`${S4}||msg_m42`]: [9, 9, 9, 9, 9, 0],
  },
  // [iter_seq, iter_type, model, input, output, cache_read, cache_creation, cache_5m, cache_1h]
  iterations: {
    [`${S4}||msg_m41`]: [
      [0, 'message', 'claude-opus-5-5', 100, 40, 1000, 50, 50, 0],
      [1, 'advisor_message', 'claude-fable-5-0', 30, 20, 0, 0, 0, 0],
    ],
  },
  flags: {
    [`${S4}||msg_m41`]: { has_iterations: 1, has_server_tool_use: 0 },
    [`${S4}||msg_m42`]: { has_iterations: 0, has_server_tool_use: 1 },
  },
  sourceFiles: [`claude:~-repos-adv/${S4}.jsonl`],
  agentMeta: [],
  skipped: {},
  unknownAttr: {},
  dropped: {},
  cwd: {},
};
