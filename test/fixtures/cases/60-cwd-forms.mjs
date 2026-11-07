// Case 60: cwd values in every form the home-prefix rule handles, plus a Windows profile under the
// fixture Windows users directory. Hand-computed from the values below.
import { join } from 'node:path';

export const id = 'cwd-forms';
export const group = 'extra';
export const sources = ['transcript'];

export const S7 = '77777777-7777-4777-8777-777777777777';
export const S8 = '88888888-8888-4888-8888-888888888888';
const t = (s) => `2026-10-27T13:30:0${s}.000Z`;

export function build(ctx) {
  const { root, home, plants, windowsUsersDir, helpers: h } = ctx;
  const user = plants.osUser;
  // Built from parts so no drive-letter path literal appears in this file.
  const winCwd = ['C:', 'Users', user, 'code', 'w'].join('\\');
  const file = join(root, 'projects', `${h.mangleHome(home)}-repos-cwd`, `${S7}.jsonl`);
  const cwds = [
    `${home}/repos/app`,
    home,
    winCwd,
    h.homePath('intruder', 'z'),
    `${home}/repos/caf\u00e9`,
    ['', 'mnt', 'c', 'Users', user, 'q'].join('/'),
    'bad\u0007value',
    'x'.repeat(2000),
  ];
  const use = (n) => h.makeUsage({ input: n, output: n, read: n, creation: n });
  h.writeJsonl(file, cwds.map((cwd, i) => JSON.stringify(h.makeAssistant({
    session: S7, ts: t(i), id: `msg_m7${i + 1}`, model: 'claude-opus-5-5', cwd, use: use(i + 1),
  }))));
  const winFile = join(windowsUsersDir, user, '.claude', 'projects', `C--Users-${user}-code-w`, `${S8}.jsonl`);
  h.writeJsonl(winFile, [JSON.stringify(h.makeAssistant({
    session: S8, ts: t(9), id: 'msg_m81', model: 'claude-opus-5-5', cwd: winCwd, use: use(9),
  }))]);
  return [file, winFile];
}

const k = (n) => `${S7}||msg_m7${n}`;
export const expected = {
  messageKeys: {
    [k(1)]: [1, 1, 1, 1, null, null], [k(2)]: [2, 2, 2, 2, null, null], [k(3)]: [3, 3, 3, 3, null, null],
    [k(4)]: [4, 4, 4, 4, null, null], [k(5)]: [5, 5, 5, 5, null, null], [k(6)]: [6, 6, 6, 6, null, null],
    [k(7)]: [7, 7, 7, 7, null, null], [k(8)]: [8, 8, 8, 8, null, null],
    [`${S8}||msg_m81`]: [9, 9, 9, 9, null, null],
  },
  cwd: {
    [k(1)]: '~/repos/app', [k(2)]: '~', [k(3)]: '~win/code/w', [k(4)]: '~other/z', [k(5)]: '~/repos/caf\u00e9',
    [k(6)]: '~win/q', [k(7)]: null, [k(8)]: null, [`${S8}||msg_m81`]: '~win/code/w',
  },
  rejected: { cwd: 2 },
  sourceFiles: [`claude:~-repos-cwd/${S7}.jsonl`, `win:~win-code-w/${S8}.jsonl`],
  agentMeta: [],
  skipped: {},
  unknownAttr: {},
  dropped: {},
};
