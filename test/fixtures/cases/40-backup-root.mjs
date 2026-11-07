// Case 40: a second Claude config directory (home/.claude-contrib, alias claude-contrib) holding the
// same session as case 20 plus a copy under another session id. Self-contained: it writes the same
// lines with the helpers and copies nothing from other cases.
import { join } from 'node:path';

export const id = 'backup-root';
export const group = 'extra';
export const sources = ['transcript'];

export const S3 = '33333333-3333-4333-8333-333333333333';
export const S5 = '55555555-5555-4555-8555-555555555555';
const t = (s) => `2026-10-27T13:00:0${s}.000Z`;

export function build(ctx) {
  const { home, plants, helpers: h } = ctx;
  const root2 = join(home, '.claude-contrib');
  const proj = join(root2, 'projects', `${h.mangleHome(home)}-repos-agents`);
  const cwd = `${home}/repos/agents`;
  const lines = (session) => [
    h.userLine({ session, ts: t(0), text: plants.prompt, cwd }),
    JSON.stringify(h.makeAssistant({
      session, ts: t(1), id: 'msg_m31', model: 'claude-opus-5-5', cwd,
      use: h.makeUsage({ input: 10, output: 20, read: 100, creation: 5, c5: 5, c1: 0 }),
    })),
    JSON.stringify(h.makeAssistant({
      session, ts: t(2), id: 'msg_m32', model: 'claude-opus-5-5', cwd,
      use: h.makeUsage({ input: 3, output: 4, read: 0, creation: 0, c5: 0, c1: 0 }),
    })),
  ];
  h.writeJsonl(join(proj, `${S3}.jsonl`), lines(S3));
  h.writeJsonl(join(proj, `${S5}.jsonl`), lines(S5));
  return [join(proj, `${S3}.jsonl`), join(proj, `${S5}.jsonl`)];
}

export const expected = {
  messageKeys: {
    [`${S3}||msg_m31`]: [10, 20, 100, 5, 5, 0],
    [`${S3}||msg_m32`]: [3, 4, 0, 0, 0, 0],
    [`${S5}||msg_m31`]: [10, 20, 100, 5, 5, 0],
    [`${S5}||msg_m32`]: [3, 4, 0, 0, 0, 0],
  },
  sourceFiles: [`claude-contrib:~-repos-agents/${S3}.jsonl`, `claude-contrib:~-repos-agents/${S5}.jsonl`],
  agentMeta: [],
  skipped: {},
  unknownAttr: {},
  dropped: {},
  cwd: {},
};
