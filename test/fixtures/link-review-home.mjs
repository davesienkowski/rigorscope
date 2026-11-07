// The review fixture of plan 02-07 (02-07-REVIEW.md WR-01, WR-02, WR-04, WR-05): one repository, "gamma", whose
// expectations are computed by hand from the constants below, never by the code under test. A helper, not a test. It uses
// only test/fixtures/git-repo.mjs helpers, the transcript helpers of test/fixtures/build.mjs and node built-ins. Read
// with TZ=UTC (every quick-id start is then the UTC midnight of its id date).
//
//   repos/gamma   `.planning/` tracked.
//     Six quick units 261001-b01 .. 261006-b06, all added by ONE bulk planning commit at 10-20 10:00, so every one of
//     them ends at that instant (end source git, a shared end: SHARED_END_MIN is 5). Their intervals are
//     [10-0N 00:00, 10-20 10:00].
//     Phase dir 07-twin: 07-CONTEXT.md (10-08 08:00, a commit naming no plan), plan 07-01 (PLAN 10-08 09:00, code 11:00)
//     and plan 07-02 (PLAN 13:00, code 15:00). Their ends are not shared.
//
// Scopes (session, agent), every call in repos/gamma:
//   SA main   a /gsd-quick command line at 10-01 12:00 and one call at 10-01 12:01. Exactly one unit (b01) contains the
//             instant, but its end is the shared bulk end (WR-01).
//   SB main   10-08 14:00 a Write of 07-01-PLAN.md; 10-08 14:05 a Read of 07-CONTEXT.md. Only 07-02 overlaps the scope
//             (phase-level ref -> 07-02); 07-01 holds the direct Write (WR-02).
//   SC sub    one call at 10-09 12:00 by a subagent that carries no attribution agent and no meta type (role unknown,
//             role_source unavailable), with a Write of 07-02-PLAN.md (WR-04).
import { dirname, join } from 'node:path';
import {
  makeAssistant, makeUsage, mangleHome, userLine, writeJsonl,
} from './build.mjs';
import {
  assertOutsideWorkTree, commitAt, makeRepo, writeFileAt, writePhaseDir,
} from './git-repo.mjs';

export const REVIEW_TIMES = Object.freeze({
  context: '2026-10-08T08:00:00.000Z',
  p1Plan: '2026-10-08T09:00:00.000Z',
  p1Code: '2026-10-08T11:00:00.000Z',
  p2Plan: '2026-10-08T13:00:00.000Z',
  p2Code: '2026-10-08T15:00:00.000Z',
  bulk: '2026-10-20T10:00:00.000Z',
  now: '2026-10-25T00:00:00Z',
});

export const REVIEW_SESSIONS = Object.freeze({
  SA: '2a000001-0000-4000-8000-000000000001',
  SB: '2a000002-0000-4000-8000-000000000002',
  SC: '2a000003-0000-4000-8000-000000000003',
  AC: 'agentreview00001',
});

const KEY = '~/repos/gamma/.git';
const unitKey = (kind, id) => `gsd-core:${KEY}:${kind}:${id}`;
export const BULK_IDS = Object.freeze(['261001-b01', '261002-b02', '261003-b03', '261004-b04', '261005-b05', '261006-b06']);
export const REVIEW_UNITS = Object.freeze({
  bulk: BULK_IDS.map((id) => unitKey('quick', id)),
  p1: unitKey('plan', '07-01'),
  p2: unitKey('plan', '07-02'),
});
export const REVIEW_BULK_END_MS = Date.parse(REVIEW_TIMES.bulk);

const md = (front) => `${['---', ...front, '---', '', 'review fixture body', ''].join('\n')}\n`;
const PHASE_DIR = '.planning/phases/07-twin';
const quickDir = (id) => `.planning/quick/${id}-bulk`;
const MODEL = 'claude-opus-5-5';
const tool = (name, value, n) => ({
  type: 'tool_use', id: `toolu_review_${n}`, name, input: { file_path: value },
});

function buildGamma(gamma, home) {
  const T = REVIEW_TIMES;
  makeRepo(gamma, { home, files: { 'README.md': 'gamma\n' } });
  writePhaseDir(gamma, { name: '07-twin', files: { '07-CONTEXT.md': md(['phase: 07-twin']) } });
  commitAt(gamma, { home, date: T.context, message: 'docs(07-twin): context' });
  writePhaseDir(gamma, { name: '07-twin', files: { '07-01-PLAN.md': md(['tier: B']) } });
  commitAt(gamma, { home, date: T.p1Plan, message: 'docs(07-01): plan' });
  writeFileAt(gamma, 'src/p1.mjs', 'export const p1 = 1;\n');
  commitAt(gamma, { home, date: T.p1Code, message: 'feat(07-01): one' });
  writePhaseDir(gamma, { name: '07-twin', files: { '07-02-PLAN.md': md(['tier: C']) } });
  commitAt(gamma, { home, date: T.p2Plan, message: 'docs(07-02): plan' });
  writeFileAt(gamma, 'src/p2.mjs', 'export const p2 = 1;\n');
  commitAt(gamma, { home, date: T.p2Code, message: 'feat(07-02): two' });
  for (const id of BULK_IDS) writeFileAt(gamma, `${quickDir(id)}/${id}-PLAN.md`, md(['tier: B']));
  commitAt(gamma, { home, date: T.bulk, message: 'docs(planning): bulk quick plans' });
}

// [file kind, scope, message id, ts, [input, output, cache_read, cache_creation], refs: [[tool, path key]]]
const CALLS = Object.freeze([
  ['main', 'SA', 'msg_rev_sa_1', '2026-10-01T12:01:00.000Z', [101, 102, 1003, 104], []],
  ['main', 'SB', 'msg_rev_sb_1', '2026-10-08T14:00:00.000Z', [201, 202, 2003, 204], [['Write', 'p1Plan']]],
  ['main', 'SB', 'msg_rev_sb_2', '2026-10-08T14:05:00.000Z', [211, 212, 2013, 214], [['Read', 'context']]],
  ['sub', 'SC', 'msg_rev_sc_1', '2026-10-09T12:00:00.000Z', [301, 302, 3003, 304], [['Write', 'p2Plan']]],
]);
const COMMAND = Object.freeze({
  scope: 'SA', uuid: 'uuid-review-sa-command', ts: '2026-10-01T12:00:00.000Z', name: 'gsd-quick',
});

export const REVIEW_EXPECTED = Object.freeze({
  units: REVIEW_UNITS,
  sessions: REVIEW_SESSIONS,
  command: COMMAND,
  // The refs that created each unit_link row, by hand: SB writes 07-01's PLAN (tool-path 07-01, 1 ref) and reads 07-CONTEXT
  // (phase-level; only 07-02 overlaps the scope, 1 ref).
  sbRefs: { p1: 1, p2: 1 },
  callIds: { SA: ['msg_rev_sa_1'], SB: ['msg_rev_sb_1', 'msg_rev_sb_2'], SC: ['msg_rev_sc_1'] },
});

function writeSessions(root, places) {
  const paths = {
    p1Plan: join(places.gamma, PHASE_DIR, '07-01-PLAN.md'),
    p2Plan: join(places.gamma, PHASE_DIR, '07-02-PLAN.md'),
    context: join(places.gamma, PHASE_DIR, '07-CONTEXT.md'),
  };
  const files = new Map();
  const add = (file, line) => { if (!files.has(file)) files.set(file, []); files.get(file).push(line); };
  let n = 0;
  const proj = join(root, 'projects', mangleHome(places.gamma));
  for (const [kind, scope, id, ts, t, refs] of CALLS) {
    const session = REVIEW_SESSIONS[scope];
    const content = refs.map(([name, key]) => { n += 1; return tool(name, paths[key], n); });
    const line = makeAssistant({
      session, ts, id, model: MODEL, cwd: places.gamma,
      use: makeUsage({ input: t[0], output: t[1], read: t[2], creation: t[3], c5: t[3], c1: 0 }),
      ...(kind === 'sub' ? { agentId: REVIEW_SESSIONS.AC } : {}),
      ...(content.length > 0 ? { content: [...content, { type: 'text', text: 'ok' }] } : {}),
    });
    const file = kind === 'main' ? join(proj, `${session}.jsonl`) : join(proj, session, 'subagents', `agent-${REVIEW_SESSIONS.AC}.jsonl`);
    if (scope === COMMAND.scope && !files.has(file)) {
      add(file, userLine({
        session, ts: COMMAND.ts, cwd: places.gamma,
        text: `<command-message>${COMMAND.name}</command-message>\n<command-name>/${COMMAND.name}</command-name>\n<command-args>review fixture args</command-args>`,
        extra: { uuid: COMMAND.uuid },
      }));
    }
    add(file, JSON.stringify(line));
  }
  for (const [file, lines] of files) writeJsonl(file, lines);
}

// -> { gamma, expected }.
export function buildReviewHome({ home, root = join(home, '.claude') }) {
  assertOutsideWorkTree(dirname(home));
  const places = { gamma: join(home, 'repos', 'gamma') };
  buildGamma(places.gamma, home);
  writeSessions(root, places);
  return { ...places, expected: REVIEW_EXPECTED };
}
