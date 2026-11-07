// Case 95: the window-share fixture (plan 01-06, D-11a, COST-04). Session S14, one main file, no sub-agents.
// Nine calls on 2026-10-26 (UTC) between the snapshots of test/fixtures/usage-cache.mjs; the transcript also
// carries the usageReport line of snapshot D, and the build writes the cache file of snapshot A into HOME.
// Roles come from attributionAgent (main has none); every line has speed standard.
//
//   call  role          model              time      input output read creation  weight (their sum)
//   c8    Explore       claude-haiku-5-5   08:00:00     8     2     0     0         10   (outside every interval)
//   c1    main          claude-opus-5-5    10:00:00    60    20    15     5        100
//   c2    gsd-executor  claude-sonnet-5-5  11:00:00   120    40    30    10        200
//   c10   main          claude-haiku-5-5   11:30:00     0     0     0     0          0
//   c3    main          claude-haiku-5-5   12:00:00   200    60    30    10        300   (exactly snapshot B)
//   c4    main          claude-opus-5-5    13:30:00    30    10     5     5         50
//   c5    gsd-verifier  claude-sonnet-5-5  15:30:00    40    10     0     (absent)   unknown
//   c6    main          claude-opus-5-5    16:30:00    70    20     5     5        100
//   c7    Explore       claude-haiku-5-5   17:30:00    10     5     0     0         15   (outside every interval)
//
// cache_creation is split 5m = total, 1h = 0. Message ids msg_wNN follow the call number (c9 is unused).
// The hand-computed shares, intervals and rows live in EXPECTED_WINDOW of usage-cache.mjs. This module
// declares no verify hook: the usage assertions live in test/integration/usage-snapshot.test.mjs and
// window-cost.test.mjs. Never imports build.mjs.
import { join } from 'node:path';
import { SNAPSHOTS, usageReportLine, writeUsageCache } from '../usage-cache.mjs';

export const id = 'usage-window';
export const group = 'extra';
export const sources = ['transcript', 'usage'];

export const S14 = '14141414-1414-4141-8141-141414141414';

// [n, role (undefined = main), model, time, [input, output, read, creation]]
export const CALLS = [
  [8, 'Explore', 'claude-haiku-5-5', '08:00:00', [8, 2, 0, 0]],
  [1, undefined, 'claude-opus-5-5', '10:00:00', [60, 20, 15, 5]],
  [2, 'gsd-executor', 'claude-sonnet-5-5', '11:00:00', [120, 40, 30, 10]],
  [10, undefined, 'claude-haiku-5-5', '11:30:00', [0, 0, 0, 0]],
  [3, undefined, 'claude-haiku-5-5', '12:00:00', [200, 60, 30, 10]],
  [4, undefined, 'claude-opus-5-5', '13:30:00', [30, 10, 5, 5]],
  [5, 'gsd-verifier', 'claude-sonnet-5-5', '15:30:00', [40, 10, 0, undefined]],
  [6, undefined, 'claude-opus-5-5', '16:30:00', [70, 20, 5, 5]],
  [7, 'Explore', 'claude-haiku-5-5', '17:30:00', [10, 5, 0, 0]],
];

export const msgId = (n) => `msg_w${String(n).padStart(2, '0')}`;

export function build(ctx) {
  const { root, home, helpers: h } = ctx;
  const file = join(root, 'projects', `${h.mangleHome(home)}-repos-uwin`, `${S14}.jsonl`);
  const cwd = `${home}/repos/uwin`;
  const lines = CALLS.map(([n, role, model, time, [input, output, read, creation]]) => {
    const use = creation === undefined
      ? h.makeUsage({ input, output, read })
      : h.makeUsage({ input, output, read, creation, c5: creation, c1: 0 });
    return JSON.stringify(h.makeAssistant({
      session: S14, ts: `2026-10-26T${time}.000Z`, id: msgId(n), model, cwd, attributionAgent: role, use,
    }));
  });
  // The usageReport of snapshot D, between c5 and c6 in time (its position in the file does not matter).
  lines.splice(7, 0, usageReportLine(SNAPSHOTS.D, { session: S14, cwd }));
  h.writeJsonl(file, lines);
  writeUsageCache(home, SNAPSHOTS.A);
  return [file];
}

const key = (n) => `${S14}||${msgId(n)}`;
// [input, output, cache_read, cache_creation, cache_5m, cache_1h]
const tuple = ([input, output, read, creation]) => (creation === undefined
  ? [input, output, read, null, null, null]
  : [input, output, read, creation, creation, 0]);

export const expected = {
  messageKeys: Object.fromEntries(CALLS.map(([n, , , , a]) => [key(n), tuple(a)])),
  sourceFiles: [`claude:~-repos-uwin/${S14}.jsonl`],
  agentMeta: [],
  skipped: {},
  unknownAttr: {},
  dropped: {},
  cwd: {},
};
