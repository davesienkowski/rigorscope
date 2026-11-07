// Case 10: the 01-01 tracer tree (group "tracer"). Three project directories under the fixture
// home, named from the mangled home plus a suffix, so the home-prefix rule applies to them.
// Everything here is hand-computed from the line generators in build.mjs; none of it is computed by
// the code under test. This module never imports build.mjs (build.mjs imports it).
import { join } from 'node:path';

export const id = 'tracer-base';
export const group = 'tracer';
export const sources = ['transcript'];

export function build(ctx) {
  const { root, home, helpers: h } = ctx;
  const pre = h.mangleHome(home);
  const a = join(root, 'projects', `${pre}-repos-app`);
  const b = join(root, 'projects', `${pre}-repos-other`);
  const c = join(root, 'projects', `${pre}-repos-empty`);
  const files = [
    join(a, 'sess-fixture-s1.jsonl'),
    join(b, 'sess-fixture-s2.jsonl'),
    join(c, 'sess-fixture-zero.jsonl'),
    join(c, 'sess-fixture-useronly.jsonl'),
  ];
  h.writeJsonl(files[0], h.session1Lines({ cwd: `${home}/repos/app` }), '\n');
  h.writeJsonl(files[1], h.session2Lines({ cwd: `${home}/repos/other` }), '\r\n');
  h.writeJsonl(files[2], [], '\n');
  h.writeJsonl(files[3], [JSON.stringify({
    type: 'user', uuid: 'uuid-user-2', sessionId: 'sess-fixture-useronly', timestamp: h.T(0),
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  })], '\n');
  return files;
}

const S1 = 'sess-fixture-s1';
const S2 = 'sess-fixture-s2';
const AGENT = 'agent0123456789ab';

// Cells: role, model, calls, input, output, cache_read, cache_write. Output order is role then
// model ascending with a NULL model last. M4 has no cache_creation fields, so the gsd-executor
// cache_write is unknown ("?"), while the Haiku row holds genuine zeros.
const costRows = [
  ['gsd-executor', 'claude-sonnet-5-5', '2', '30', '5', '600', '?'],
  ['main', 'claude-haiku-5-5', '1', '7', '0', '0', '0'],
  ['main', 'claude-opus-4-8', '1', '1', '1', '1', '1'],
  ['main', 'claude-opus-5-5', '2', '170', '105', '6000', '400'],
  ['main', '?', '2', '4', '5', '6', '7'],
];

export const expected = {
  costRows,
  // [input, output, cache_read, cache_creation, cache_5m, cache_1h]; null = unknown
  messageKeys: {
    [`${S1}||msg_01m1`]: [120, 80, 5000, 300, 200, 100],
    [`${S1}||msg_01m2`]: [50, 25, 1000, 100, null, null],
    [`${S1}|${AGENT}|msg_01m3`]: [10, 0, 200, 30, null, null],
    [`${S1}|${AGENT}|msg_01m4`]: [20, 5, 400, null, null, null],
    [`${S1}||msg_01m5`]: [7, 0, 0, 0, null, null],
    [`${S1}||msg_01m6`]: [3, 4, 5, 6, null, null],
    [`${S2}||msg_02m7`]: [1, 1, 1, 1, null, null],
    [`${S2}||msg_02m8`]: [1, 1, 1, 1, null, null],
  },
  sourceFiles: [
    'claude:~-repos-app/sess-fixture-s1.jsonl',
    'claude:~-repos-empty/sess-fixture-useronly.jsonl',
    'claude:~-repos-empty/sess-fixture-zero.jsonl',
    'claude:~-repos-other/sess-fixture-s2.jsonl',
  ],
  agentMeta: [],
  skipped: {},
  unknownAttr: {},
  dropped: {},
  cwd: { [`${S1}||msg_01m1`]: '~/repos/app', [`${S2}||msg_02m7`]: '~/repos/other' },
};
