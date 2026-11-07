// Case 98: the report-shape fixture (plan 01-08, COST-05, TRUST-01, TRUST-04). Six one-call rows that straddle the
// 2026-11-01 daylight-saving change in America/Los_Angeles (the local day 2026-11-01 lasts 25 hours:
// [2026-11-01T07:00:00Z, 2026-11-02T08:00:00Z)). Four sessions give the repo rules. Plan 02-02 (D-09): the repo of a
// call is the git common dir its owner message's cwd resolved to at ingest, so build() creates real git repositories
// through the idempotent helpers of git-repo.mjs: S1 works in the main checkout of a repo named rigorscope at
// HOME/src/rigorscope (rule git; not HOME/repos/rigorscope, which the doctor and schedule fixtures make a symlink to this
// checkout, so a fixture repo there would either break those fixtures or point the resolver at this checkout),
// S2 in a linked worktree of a second repo named gsd-core (rule git; the worktree's directory name never becomes the
// repo), S3 in a scratch directory that does not exist and S4 on a line with no cwd (rule none). A second build on one
// HOME (every canary scenario rebuilds every case) finds the repositories and the worktree in place and changes nothing.
// Every number is hand-computed from the lines this module writes, never by the code under test. Never imports build.mjs.
import { join } from 'node:path';
import { addWorktree, makeRepo } from '../git-repo.mjs';

export const id = 'report-shape';
export const group = 'extra';
export const sources = ['transcript'];

export const S1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
export const S2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
export const S3 = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
export const S4 = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';

// Epoch milliseconds, hand-computed. 2026-11-01T00:00:00Z is 1793491200 s (20,758 days after 1970-01-01 at 86,400 s).
//   A 06:59:59.000Z = +25199 s            -> 1793516399000
//   B 07:00:00.000Z = +25200 s            -> 1793516400000
//   C 08:30:00.000Z = +30600 s            -> 1793521800000
//   D 09:30:00.000Z = +34200 s            -> 1793525400000
//   E 2026-11-02T07:59:59.999Z = +86400 s + 28799 s + 999 ms -> 1793606399999
//   F 2026-11-02T08:00:00.000Z = +86400 s + 28800 s          -> 1793606400000
export const TS_MS = {
  A: 1793516399000, B: 1793516400000, C: 1793521800000, D: 1793525400000, E: 1793606399999, F: 1793606400000,
};
export const TS = {
  A: '2026-11-01T06:59:59.000Z', B: '2026-11-01T07:00:00.000Z', C: '2026-11-01T08:30:00.000Z',
  D: '2026-11-01T09:30:00.000Z', E: '2026-11-02T07:59:59.999Z', F: '2026-11-02T08:00:00.000Z',
};
export const MSG = { A: 'msg_rs_a', B: 'msg_rs_b', C: 'msg_rs_c', D: 'msg_rs_d', E: 'msg_rs_e', F: 'msg_rs_f' };
export const REQ = { A: 'req_rs_a', B: 'req_rs_b', C: 'req_rs_c', D: 'req_rs_d', E: 'req_rs_e', F: 'req_rs_f' };
export const SESSION_OF = { A: S1, B: S1, C: S2, D: S2, E: S3, F: S4 };

// [letter, model, input, output, effort (null = no effort field), session]
const CALLS = [
  ['A', 'claude-haiku-5-5', 100, 10, 'high', S1],
  ['B', 'claude-haiku-5-5', 100, 10, 'high', S1],
  ['C', 'claude-haiku-5-5', 100, 10, 'medium', S2],
  ['D', 'claude-haiku-5-5', 100, 10, null, S2],
  ['E', 'claude-haiku-5-5', 100, 10, 'high', S3],
  ['F', 'claude-opus-5-5', 50, 20, 'low', S4],
];

export function build(ctx) {
  const { root, home, helpers: h } = ctx;
  makeRepo(join(home, 'src', 'rigorscope'), { home, files: { 'README.md': 'report-shape fixture\n' } });
  const core = makeRepo(join(home, 'repos', 'gsd-core'), { home, files: { 'README.md': 'report-shape fixture\n' } });
  addWorktree(core, join(home, 'wsroot', 'workspaces', 'gsd-core', 'fix-x'), 'fix-x', { home });
  const cwdOf = {
    [S1]: `${home}/src/rigorscope`,
    [S2]: `${home}/wsroot/workspaces/gsd-core/fix-x`,
    [S3]: `${home}/scratch/play`,
    [S4]: undefined,
  };
  // Project directory names are kept from plan 01-08 (S1's still says repos-rigorscope); only the cwd moved.
  const dirOf = {
    [S1]: `${h.mangleHome(home)}-repos-rigorscope`,
    [S2]: `${h.mangleHome(home)}-wsroot-workspaces-gsd-core-fix-x`,
    [S3]: `${h.mangleHome(home)}-scratch-play`,
    [S4]: `${h.mangleHome(home)}-repos-nocwd`,
  };
  const files = [];
  for (const session of [S1, S2, S3, S4]) {
    const lines = CALLS.filter((c) => c[5] === session).map(([letter, model, input, output, effort]) => {
      const o = h.makeAssistant({
        session, ts: TS[letter], id: MSG[letter], model, cwd: cwdOf[session],
        use: h.makeUsage({ input, output, read: 0, creation: 0, c5: 0, c1: 0 }),
      });
      o.requestId = REQ[letter];
      if (effort === null) delete o.effort; else o.effort = effort;
      return JSON.stringify(o);
    });
    const file = join(root, 'projects', dirOf[session], `${session}.jsonl`);
    h.writeJsonl(file, lines);
    files.push(file);
  }
  return files;
}

const key = (letter) => `${SESSION_OF[letter]}||${MSG[letter]}`;
export const expected = {
  messageKeys: Object.fromEntries(CALLS.map(([l, , i, o]) => [key(l), [i, o, 0, 0, 0, 0]])),
  cwd: {
    [key('A')]: '~/src/rigorscope', [key('B')]: '~/src/rigorscope',
    [key('C')]: '~/wsroot/workspaces/gsd-core/fix-x', [key('D')]: '~/wsroot/workspaces/gsd-core/fix-x',
    [key('E')]: '~/scratch/play', [key('F')]: null,
  },
  sourceFiles: [
    `claude:~-repos-rigorscope/${S1}.jsonl`, `claude:~-wsroot-workspaces-gsd-core-fix-x/${S2}.jsonl`,
    `claude:~-scratch-play/${S3}.jsonl`, `claude:~-repos-nocwd/${S4}.jsonl`,
  ],
  agentMeta: [],
  skipped: {},
  unknownAttr: {},
  dropped: {},
};

// Notional cost per call in nano-dollars: haiku 100 x 100 + 10 x 500 = 15,000; opus F 50 x 4000 + 20 x 20000 =
// 200,000 + 400,000 = 600,000; all six 5 x 15,000 + 600,000 = 675,000. Tokens: input 5 x 100 + 50 = 550, output 5 x 10 + 20 = 70.
// Days: Los_Angeles A 2026-10-31 (23:59:59 PDT), B, C (01:30 PDT), D (01:30 PST, the repeated hour) and E
// (23:59:59.999 PST) 2026-11-01, F 2026-11-02; UTC A, B, C, D 2026-11-01 and E, F 2026-11-02.
// Rows are [by values..., calls, input, output, notional_usd] (cache cells are 0 and window cells are ? in this case).
export const expectedReport = {
  totalNano: 675000,
  total: { calls: 6, input: 550, output: 70, notional: '0.000675' },
  callsOrder: ['A', 'B', 'E', 'C', 'D', 'F'],
  roleModelEffortDay: {
    'America/Los_Angeles': [
      ['main', 'claude-haiku-5-5', 'high', '2026-10-31', '1', '100', '10', '0.000015'],
      ['main', 'claude-haiku-5-5', 'high', '2026-11-01', '2', '200', '20', '0.000030'],
      ['main', 'claude-haiku-5-5', 'medium', '2026-11-01', '1', '100', '10', '0.000015'],
      ['main', 'claude-haiku-5-5', '?', '2026-11-01', '1', '100', '10', '0.000015'],
      ['main', 'claude-opus-5-5', 'low', '2026-11-02', '1', '50', '20', '0.000600'],
    ],
    UTC: [
      ['main', 'claude-haiku-5-5', 'high', '2026-11-01', '2', '200', '20', '0.000030'],
      ['main', 'claude-haiku-5-5', 'high', '2026-11-02', '1', '100', '10', '0.000015'],
      ['main', 'claude-haiku-5-5', 'medium', '2026-11-01', '1', '100', '10', '0.000015'],
      ['main', 'claude-haiku-5-5', '?', '2026-11-01', '1', '100', '10', '0.000015'],
      ['main', 'claude-opus-5-5', 'low', '2026-11-02', '1', '50', '20', '0.000600'],
    ],
  },
  day: {
    'America/Los_Angeles': [
      ['2026-10-31', '1', '100', '10', '0.000015'], ['2026-11-01', '4', '400', '40', '0.000060'],
      ['2026-11-02', '1', '50', '20', '0.000600'],
    ],
    UTC: [['2026-11-01', '4', '400', '40', '0.000060'], ['2026-11-02', '2', '150', '30', '0.000615']],
  },
  repo: [['gsd-core', '2', '200', '20', '0.000030'], ['rigorscope', '2', '200', '20', '0.000030'], ['?', '2', '150', '30', '0.000615']],
  session: [
    [S1, '2', '200', '20', '0.000030'], [S2, '2', '200', '20', '0.000030'],
    [S3, '1', '100', '10', '0.000015'], [S4, '1', '50', '20', '0.000600'],
  ],
  effort: [
    ['high', '3', '300', '30', '0.000045'], ['low', '1', '50', '20', '0.000600'],
    ['medium', '1', '100', '10', '0.000015'], ['?', '1', '100', '10', '0.000015'],
  ],
  // Evidence: letters of the calls listed for a key, in time order.
  evidence: {
    highDay1LA: { key: 'main/role=main/model=claude-haiku-5-5/effort=high/day=2026-11-01', tz: 'America/Los_Angeles', calls: ['B', 'E'], sessions: 2 },
    totalDay1LA: { since: '2026-11-01', until: '2026-11-01', tz: 'America/Los_Angeles', calls: ['B', 'C', 'D', 'E'] },
    totalDay1UTC: { since: '2026-11-01', until: '2026-11-01', tz: 'UTC', calls: ['A', 'B', 'C', 'D'] },
  },
  // Repos by session (plan 02-02, rule = the resolver method): S1 rigorscope (git, the main checkout), S2 gsd-core (git,
  // a linked worktree), S3 and S4 NULL (none).
  repoOf: { [S1]: ['rigorscope', 'git'], [S2]: ['gsd-core', 'git'], [S3]: [null, 'none'], [S4]: [null, 'none'] },
  repoKeyOf: { [S1]: '~/src/rigorscope/.git', [S2]: '~/repos/gsd-core/.git', [S3]: null, [S4]: null },
};
