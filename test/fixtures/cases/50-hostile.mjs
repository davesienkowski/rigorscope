// Case 50: one session full of hostile and edge-case lines: a BOM, an oversized line, invalid UTF-8,
// a truncated line, an unknown token-bearing record type, a deferred type, lines the classifier must
// route by type, dropped assistants, hostile key names and an iterations overflow. Also an empty file
// and a path nine directories below subagents. Hand-computed from the lines below.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const id = 'hostile';
export const group = 'extra';
export const sources = ['transcript'];

export const S6 = '66666666-6666-4666-8666-666666666666';
// The 300000-byte line is above this cap, so tests run this case with it.
export const options = { maxLineBytes: 100000 };
const t = (s) => `2026-10-27T13:20:${String(s).padStart(2, '0')}.000Z`;

export function build(ctx) {
  const { root, home, plants, helpers: h } = ctx;
  const proj = join(root, 'projects', `${h.mangleHome(home)}-repos-hostile`);
  const file = join(proj, `${S6}.jsonl`);
  const cwd = `${home}/repos/hostile`;
  const mk = (extra) => h.makeAssistant({ session: S6, cwd, model: 'claude-opus-5-5', ...extra });
  const u = (n) => h.makeUsage({ input: n, output: n, read: n, creation: n, c5: n, c1: 0 });
  const parts = [];
  const push = (buf) => { parts.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8'), Buffer.from('\n')); };

  // 1. BOM, then M61.
  push(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(mk({ ts: t(1), id: 'msg_m61', use: u(1) })))]));
  // 2. an assistant-marker line of exactly 300000 bytes.
  const head = '{"type":"assistant","pad":"';
  push(`${head}${'A'.repeat(300000 - head.length - 2)}"}`);
  // 3. M62 with two invalid UTF-8 bytes inside the content text.
  const m62 = Buffer.from(JSON.stringify(mk({ ts: t(2), id: 'msg_m62', use: u(2), content: [{ type: 'text', text: 'bad-@@-bytes' }] })));
  const at = m62.indexOf('@@');
  m62[at] = 0xff;
  m62[at + 1] = 0xfe;
  push(m62);
  // 4. truncated assistant line.
  push(`{"type":"assistant","sessionId":"${S6}","message":{"id":"msg_cut","usage":{"input_tokens":1`);
  // 5. unknown token-bearing type with a version.
  push(JSON.stringify({ type: 'mystery-usage', version: '2.9.9', sessionId: S6, usage: { input_tokens: 5, output_tokens: 6 } }));
  // 6. deferred type (cost-state) with token keys.
  push(JSON.stringify({ type: 'cost-state', sessionId: S6, models: { m: { input_tokens: 1, output_tokens: 2 } } }));
  // 7. a user line that does not start with the type key and quotes a token key name.
  push(JSON.stringify({ uuid: 'u-q', type: 'user', sessionId: S6, message: { content: 'quote input_tokens here' } }));
  // 8. assistants without sessionId, without message id, without usage.
  push(JSON.stringify(mk({ session: undefined, ts: t(3), id: 'msg_nosess', use: u(3) })));
  push(JSON.stringify(mk({ ts: t(4), id: undefined, use: u(4) })));
  push(JSON.stringify(mk({ ts: t(5), id: 'msg_nousage', use: undefined })));
  // 9. M66 with unknown keys at line, message and usage level, two of them hostile names.
  const m66 = mk({ ts: t(6), id: 'msg_m66', use: u(6) });
  m66.brandNewLineField = 1;
  m66[plants.email] = 1;
  m66[plants.hostileAgent] = 1;
  m66.message.brandNewMsgField = 1;
  m66.message.usage.brand_new_usage_field = 1;
  push(JSON.stringify(m66));
  // 10. M67 with 20 iterations.
  const m67 = mk({ ts: t(7), id: 'msg_m67', use: u(7) });
  m67.message.usage.iterations = Array.from({ length: 20 }, (_, i) => ({
    type: 'message', model: 'claude-opus-5-5', input_tokens: i + 1, output_tokens: 1, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  }));
  push(JSON.stringify(m67));
  mkdirSync(proj, { recursive: true });
  writeFileSync(file, Buffer.concat(parts));

  // An empty session file and a sub-agent file nine directories deep.
  writeFileSync(join(proj, 'empty.jsonl'), '');
  const deep = join(proj, S6, 'subagents', ...['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9']);
  h.writeJsonl(join(deep, 'agent-agentdeep00000009.jsonl'), [
    JSON.stringify(h.makeAssistant({ session: S6, ts: t(8), id: 'm-deep-leak', agentId: 'agentdeep00000009', use: u(9) })),
  ]);
  return [file];
}

export const expected = {
  messageKeys: {
    [`${S6}||msg_m61`]: [1, 1, 1, 1, 1, 0],
    [`${S6}||msg_m62`]: [2, 2, 2, 2, 2, 0],
    [`${S6}||msg_m66`]: [6, 6, 6, 6, 6, 0],
    [`${S6}||msg_m67`]: [7, 7, 7, 7, 7, 0],
  },
  iterationCounts: { [`${S6}||msg_m67`]: 16 },
  sourceFiles: [`claude:~-repos-hostile/${S6}.jsonl`, 'claude:~-repos-hostile/empty.jsonl'],
  agentMeta: [],
  skipped: { depth: 1 },
  unknownAttr: {
    'line|brandNewLineField': 1, 'message|brandNewMsgField': 1, 'usage|brand_new_usage_field': 1, 'line|?': 2,
  },
  counters: { unparseable: 1, oversized: 1, unknown_token_bearing: 1, deferred_token_bearing: 1 },
  unknownToken: { 'mystery-usage|2.9.9': 1 },
  iterationsTruncated: 1,
  dropped: { session_id: 1, message_id: 1, usage: 1 },
  cwd: {},
  leakIds: ['m-deep-leak'],
};
