// The link fixture of plan 02-07 (UNIT-06, UNIT-01, UNIT-04, D-10, D-12, D-13, D-17): two fixture repos with quick and
// plan units at fixed intervals, twelve sessions with fourteen (session, agent) scopes covering every link method,
// both lowering rules, every bucket and reason, and the hand-computed expectations. A helper, not a test. It uses only
// test/fixtures/git-repo.mjs helpers, the transcript helpers of test/fixtures/build.mjs and node built-ins; every
// expectation below is computed by hand from the constants of this module, never by the code under test. Read with
// TZ=UTC (every quick-id start is then the UTC midnight of its id date).
//
//   repos/alpha     `.planning/` tracked. Quick units 261001-q1a (PLAN tier A; commits 10-01 09:00 and 12:00),
//                   261001-q2b (tier B; 13:00 and 16:00), 261003-d1d (tier B; 10-03 10:00 and 11:00) and 261009-z9z (no
//                   tier; one commit 10-09 07:00). Phase dir 03-links: 03-CONTEXT.md (10-05 08:00, a commit naming no
//                   plan), 03-01 (PLAN tier B; 10-05 09:00 and 11:00), 03-02 (PLAN tier C; 13:00 and 15:00). A linked
//                   worktree wt/alpha-w1 is added after the last commit.
//   repos/beta      `.planning/` ignored: quick unit 261007-u1c (PLAN tier A, mtime 10-07 18:00; no git date, so
//                   git_evidence 0 and every link to it is lowered one level, D-10).
//   work/plain      a directory outside any repository. gone/place and gone/alpha-copy are never created.
//
// Unit intervals (closed, UTC): q1a [10-01 00:00, 12:00], q2b [10-01 00:00, 16:00], d1d [10-03 00:00, 11:00],
// z9z [10-09 00:00, 07:00], 03-01 [10-05 09:00, 11:00], 03-02 [10-05 13:00, 15:00], u1c [10-07 00:00, 18:00].
//
// Scopes (session, agent):
//   S1 main   cwd alpha, 10-01 10:00 and 10:05; a Write of q1a's SUMMARY
//   S1 sub    cwd alpha, 10-01 10:10 and 10:11; one message with an Edit of q2b's PLAN and a Read of q1a's PLAN
//   S2 main   cwd the worktree, 10-05 09:30; a Read of 03-01-PLAN.md through the worktree path
//   S2 sub    cwd the worktree, 10-05 10:00; attributionSkill gsd-execute-phase
//   S3 main   cwd alpha, 10-05 14:00; a Read of 03-CONTEXT.md (phase-level; only 03-02 overlaps 14:00)
//   S4 main   cwd alpha, 10-05 10:30 and 13:30; a Read of 03-CONTEXT.md (two plans overlap: phase_dropped)
//   S5 main   cwd alpha, 10-03 10:30; no ref (interval only)
//   S6 main   cwd beta, 10-07 12:00; a Write of u1c's PLAN
//   S7 main   cwd alpha; a slash-command line /gsd-quick at 10-01 14:00, calls 14:00:30 and 14:02
//   S8 main   cwd gone/place (unresolved), 10-03 09:00; an Edit of gone/alpha-copy/.planning/quick/261003-d1d-dirname/...
//             (no repo for that directory: the unique dir-name fallback; review WR-03: capped at low, so strict mode
//             leaves it unattributed and the widened mode attributes it to d1d)
//   S9 main   cwd work/plain, 10-09 08:00; nothing
//   S10 main  cwd alpha, 10-01 14:30; attributionSkill gsd-quick, no ref
//   S11 main  cwd work/plain, 10-09 09:00; nothing
//   S12 main  cwd work/plain (no repo), 10-03 12:00; a Write of d1d's PLAN in alpha (a repo-matched high link; the strict
//             mode attributes the scope, so the unit-link repo fallback gives its call the repo alpha: review WR-03)
// Main calls use model claude-opus-5-5, subagent calls claude-sonnet-5-5 with attributionAgent gsd-executor; every call
// has effort high and version 2.1.309 except S6 (effort medium, version 2.1.400). A message that both writes and reads
// one file stores the bytewise-smaller tool name (cc_message_ref merges tool_name by bytewise minimum): Write and Read
// store Read, so such a write is read-only evidence (the accepted residual), while Edit, MultiEdit and NotebookEdit all
// sort before Read and stay write evidence. That case is covered by the pure tests, not by this fixture.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  makeAssistant, makeUsage, mangleHome, shuffleLines, userLine, writeJsonl,
} from './build.mjs';
import {
  addWorktree, assertOutsideWorkTree, commitAt, makeRepo, writeFileAt, writePhaseDir,
} from './git-repo.mjs';

export const LINK_TIMES = Object.freeze({
  q1aPlan: '2026-10-01T09:00:00.000Z',
  q1aCode: '2026-10-01T12:00:00.000Z',
  q2bPlan: '2026-10-01T13:00:00.000Z',
  q2bCode: '2026-10-01T16:00:00.000Z',
  d1dPlan: '2026-10-03T10:00:00.000Z',
  d1dCode: '2026-10-03T11:00:00.000Z',
  context: '2026-10-05T08:00:00.000Z',
  p1Plan: '2026-10-05T09:00:00.000Z',
  p1Code: '2026-10-05T11:00:00.000Z',
  p2Plan: '2026-10-05T13:00:00.000Z',
  p2Code: '2026-10-05T15:00:00.000Z',
  u1cMtime: '2026-10-07T18:00:00.000Z',
  z9zPlan: '2026-10-09T07:00:00.000Z',
  // The fixed clock of every link-home command: after every time above.
  now: '2026-10-10T00:00:00Z',
});

export const LINK_SESSIONS = Object.freeze({
  S1: '1a000001-0000-4000-8000-000000000001',
  S2: '1a000002-0000-4000-8000-000000000002',
  S3: '1a000003-0000-4000-8000-000000000003',
  S4: '1a000004-0000-4000-8000-000000000004',
  S5: '1a000005-0000-4000-8000-000000000005',
  S6: '1a000006-0000-4000-8000-000000000006',
  S7: '1a000007-0000-4000-8000-000000000007',
  S8: '1a000008-0000-4000-8000-000000000008',
  S9: '1a000009-0000-4000-8000-000000000009',
  S10: '1a000010-0000-4000-8000-000000000010',
  S11: '1a000011-0000-4000-8000-000000000011',
  S12: '1a000012-0000-4000-8000-000000000012',
  A1: 'agentlink00000001',
  A2: 'agentlink00000002',
});

const KEY = { alpha: '~/repos/alpha/.git', beta: '~/repos/beta/.git' };
const unitKey = (repo, kind, id) => `gsd-core:${KEY[repo]}:${kind}:${id}`;
export const LINK_UNITS = Object.freeze({
  q1a: unitKey('alpha', 'quick', '261001-q1a'),
  q2b: unitKey('alpha', 'quick', '261001-q2b'),
  d1d: unitKey('alpha', 'quick', '261003-d1d'),
  z9z: unitKey('alpha', 'quick', '261009-z9z'),
  p1: unitKey('alpha', 'plan', '03-01'),
  p2: unitKey('alpha', 'plan', '03-02'),
  u1c: unitKey('beta', 'quick', '261007-u1c'),
});

const DIRS = Object.freeze({
  q1a: '.planning/quick/261001-q1a-one',
  q2b: '.planning/quick/261001-q2b-two',
  d1d: '.planning/quick/261003-d1d-dirname',
  z9z: '.planning/quick/261009-z9z-idle',
  phase: '.planning/phases/03-links',
  u1c: '.planning/quick/261007-u1c-untracked',
});

const md = (front) => `${['---', ...front, '---', '', 'link fixture body', ''].join('\n')}\n`;
const MAIN_MODEL = 'claude-opus-5-5';
const SUB_MODEL = 'claude-sonnet-5-5';
const SUB_ROLE = 'gsd-executor';
const tool = (name, field, value, n) => ({
  type: 'tool_use', id: `toolu_link_${n}`, name, input: { [field]: value },
});

// The calls of every scope: [scope, agent, message id, ts, [input, output, cache_read, cache_creation], extra].
// extra: { refs: [[tool, path key]], skill, effort, version }. Path keys are resolved in writeSessions.
const CALLS = Object.freeze([
  ['S1', '', 'msg_link_s1_1', '2026-10-01T10:00:00.000Z', [101, 102, 1003, 104], { refs: [['Write', 'q1aSummary']] }],
  ['S1', '', 'msg_link_s1_2', '2026-10-01T10:05:00.000Z', [111, 112, 1013, 114], {}],
  ['S1', 'A1', 'msg_link_s1a_1', '2026-10-01T10:10:00.000Z', [201, 202, 2003, 204], { refs: [['Edit', 'q2bPlan'], ['Read', 'q1aPlan']] }],
  ['S1', 'A1', 'msg_link_s1a_2', '2026-10-01T10:11:00.000Z', [211, 212, 2013, 214], {}],
  ['S2', '', 'msg_link_s2_1', '2026-10-05T09:30:00.000Z', [301, 302, 3003, 304], { refs: [['Read', 'p1PlanWt']] }],
  ['S2', 'A2', 'msg_link_s2a_1', '2026-10-05T10:00:00.000Z', [401, 402, 4003, 404], { skill: 'gsd-execute-phase' }],
  ['S3', '', 'msg_link_s3_1', '2026-10-05T14:00:00.000Z', [501, 502, 5003, 504], { refs: [['Read', 'context']] }],
  ['S4', '', 'msg_link_s4_1', '2026-10-05T10:30:00.000Z', [601, 602, 6003, 604], { refs: [['Read', 'context']] }],
  ['S4', '', 'msg_link_s4_2', '2026-10-05T13:30:00.000Z', [611, 612, 6013, 614], {}],
  ['S5', '', 'msg_link_s5_1', '2026-10-03T10:30:00.000Z', [701, 702, 7003, 704], {}],
  ['S6', '', 'msg_link_s6_1', '2026-10-07T12:00:00.000Z', [801, 802, 8003, 804], { refs: [['Write', 'u1cPlan']], effort: 'medium', version: '2.1.400' }],
  ['S7', '', 'msg_link_s7_1', '2026-10-01T14:00:30.000Z', [901, 902, 9003, 904], {}],
  ['S7', '', 'msg_link_s7_2', '2026-10-01T14:02:00.000Z', [911, 912, 9013, 914], {}],
  ['S8', '', 'msg_link_s8_1', '2026-10-03T09:00:00.000Z', [1001, 1002, 10003, 1004], { refs: [['Edit', 'd1dGone']] }],
  ['S9', '', 'msg_link_s9_1', '2026-10-09T08:00:00.000Z', [1101, 1102, 11003, 1104], {}],
  ['S10', '', 'msg_link_s10_1', '2026-10-01T14:30:00.000Z', [1201, 1202, 12003, 1204], { skill: 'gsd-quick' }],
  ['S11', '', 'msg_link_s11_1', '2026-10-09T09:00:00.000Z', [1301, 1302, 13003, 1304], {}],
  ['S12', '', 'msg_link_s12_1', '2026-10-03T12:00:00.000Z', [1401, 1402, 14003, 1404], { refs: [['Write', 'd1dPlan']] }],
]);
const CWD_OF = Object.freeze({
  S1: 'alpha', S2: 'worktree', S3: 'alpha', S4: 'alpha', S5: 'alpha', S6: 'beta', S7: 'alpha', S8: 'gone', S9: 'plain', S10: 'alpha', S11: 'plain', S12: 'plain',
});
const COMMAND = Object.freeze({
  scope: 'S7', uuid: 'uuid-link-s7-command', ts: '2026-10-01T14:00:00.000Z', name: 'gsd-quick',
});

// ---- hand-computed expectations ----------------------------------------------------------------------------------
const scopeId = (scope, agent) => ({ session_id: LINK_SESSIONS[scope], agent_id: agent === '' ? '' : LINK_SESSIONS[agent] });
const SCOPE_LABELS = ['S1', 'S1/A1', 'S2', 'S2/A2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12'];
const labelOf = (scope, agent) => (agent === '' ? scope : `${scope}/${agent}`);
const parseLabel = (label) => { const [s, a = ''] = label.split('/'); return scopeId(s, a); };

function scopeTotals() {
  const out = {};
  for (const label of SCOPE_LABELS) {
    out[label] = {
      ...parseLabel(label), calls: [], input: 0, output: 0, cache_read: 0, cache_write: 0,
    };
  }
  for (const [scope, agent, id, , t] of CALLS) {
    const o = out[labelOf(scope, agent)];
    o.calls.push(`m:${id}`);
    o.input += t[0]; o.output += t[1]; o.cache_read += t[2]; o.cache_write += t[3];
  }
  for (const o of Object.values(out)) {
    o.calls.sort();
    o.tokens = o.input + o.output + o.cache_read + o.cache_write;
  }
  return out;
}

// [scope label, unit, method, confidence, base_confidence, lowered_by, match, phase_level]
const L = (scope, unit, method, confidence, base, lowered = null, match = null, phase = 0) => ({
  scope, unit_key: LINK_UNITS[unit], method, confidence, base_confidence: base, lowered_by: lowered, match, phase_level: phase,
});
const LINKS = [
  L('S1', 'q1a', 'tool-path', 'high', 'high', null, 'repo'),
  L('S1', 'q1a', 'interval', 'low', 'low'),
  L('S1', 'q2b', 'interval', 'low', 'low'),
  L('S1/A1', 'q1a', 'tool-path', 'medium', 'medium', null, 'repo'),
  L('S1/A1', 'q1a', 'interval', 'low', 'low'),
  L('S1/A1', 'q2b', 'tool-path', 'high', 'high', null, 'repo'),
  L('S1/A1', 'q2b', 'interval', 'low', 'low'),
  L('S2', 'p1', 'tool-path', 'medium', 'medium', null, 'repo'),
  L('S2', 'p1', 'interval', 'low', 'low'),
  L('S2/A2', 'p1', 'slash-command', 'medium', 'medium'),
  L('S2/A2', 'p1', 'interval', 'low', 'low'),
  L('S3', 'p2', 'tool-path', 'medium', 'medium', null, 'repo', 1),
  L('S3', 'p2', 'interval', 'low', 'low'),
  L('S4', 'p1', 'interval', 'low', 'low'),
  L('S4', 'p2', 'interval', 'low', 'low'),
  L('S5', 'd1d', 'interval', 'low', 'low'),
  L('S6', 'u1c', 'tool-path', 'medium', 'high', 'no-git-dates', 'repo'),
  L('S6', 'u1c', 'interval', 'low', 'low', 'no-git-dates'),
  L('S7', 'q2b', 'slash-command', 'medium', 'medium'),
  L('S7', 'q2b', 'interval', 'low', 'low'),
  L('S8', 'd1d', 'tool-path', 'low', 'high', 'dir-name', 'dir-name'),
  L('S10', 'q2b', 'slash-command', 'medium', 'medium'),
  L('S10', 'q2b', 'interval', 'low', 'low'),
  L('S12', 'd1d', 'tool-path', 'high', 'high', null, 'repo'),
];

// [scope label, bucket, reason, unit] per mode.
const A = (scope, bucket, reason, unit = null) => ({
  scope, bucket, reason, unit_key: unit === null ? null : LINK_UNITS[unit],
});
const ATTRIBUTION = {
  medium: [
    A('S1', 'attributed', 'one-unit', 'q1a'), A('S1/A1', 'unattributed_overlap', 'multi-unit'),
    A('S2', 'attributed', 'one-unit', 'p1'), A('S2/A2', 'attributed', 'one-unit', 'p1'),
    A('S3', 'attributed', 'one-unit', 'p2'), A('S4', 'unattributed_overlap', 'low-only'),
    A('S5', 'unattributed_overlap', 'low-only'), A('S6', 'attributed', 'one-unit', 'u1c'),
    A('S7', 'attributed', 'one-unit', 'q2b'), A('S8', 'unattributed_overlap', 'low-only'),
    A('S9', 'unlinked', 'no-link'), A('S10', 'attributed', 'one-unit', 'q2b'), A('S11', 'unlinked', 'no-link'),
    A('S12', 'attributed', 'one-unit', 'd1d'),
  ],
  low: [
    A('S1', 'attributed', 'one-unit', 'q1a'), A('S1/A1', 'unattributed_overlap', 'multi-unit'),
    A('S2', 'attributed', 'one-unit', 'p1'), A('S2/A2', 'attributed', 'one-unit', 'p1'),
    A('S3', 'attributed', 'one-unit', 'p2'), A('S4', 'unattributed_overlap', 'multi-unit'),
    A('S5', 'attributed', 'one-low-unit', 'd1d'), A('S6', 'attributed', 'one-unit', 'u1c'),
    A('S7', 'attributed', 'one-unit', 'q2b'), A('S8', 'attributed', 'one-low-unit', 'd1d'),
    A('S9', 'unlinked', 'no-link'), A('S10', 'attributed', 'one-unit', 'q2b'), A('S11', 'unlinked', 'no-link'),
    A('S12', 'attributed', 'one-unit', 'd1d'),
  ],
};

export const LINK_EXPECTED = Object.freeze({
  units: LINK_UNITS,
  scopes: scopeTotals(),
  scopeLabels: SCOPE_LABELS,
  scopeOf: parseLabel,
  links: LINKS,
  attribution: ATTRIBUTION,
  // Per-unit `links` cell of the units table: scopes by best final confidence, high/medium/low.
  linkCells: {
    q1a: '1/1/0', q2b: '1/2/1', d1d: '1/0/2', z9z: '0/0/0', p1: '0/2/1', p2: '0/1/1', u1c: '0/1/0',
  },
  // The `links:` line counts: per method the (scope, unit) pairs by final confidence, high/medium/low.
  methodCounts: { 'tool-path': '3/4/1', 'slash-command': '0/3/0', interval: '0/0/13' },
  counters: {
    scopes: 14, refs: 9, unmatched: 0, ambiguous: 0, dir_name: 1, phase_dropped: 1, slash_ambiguous: 0, lowered: 3,
    no_interval_units: 0, shared_end_units: 0,
  },
  // Unit native ids of each repo, in listing order (repo display, kind, native id).
  alphaIds: ['03-01', '03-02', '261001-q1a', '261001-q2b', '261003-d1d', '261009-z9z'],
  betaIds: ['261007-u1c'],
  command: COMMAND,
  roles: { main: 'main', sub: SUB_ROLE },
  models: { main: MAIN_MODEL, sub: SUB_MODEL },
});

// ---- the build ---------------------------------------------------------------------------------------------------
function buildAlpha(alpha, home) {
  const T = LINK_TIMES;
  makeRepo(alpha, { home, files: { 'README.md': 'alpha\n' } });
  writeFileAt(alpha, `${DIRS.q1a}/261001-q1a-PLAN.md`, md(['tier: A']));
  commitAt(alpha, { home, date: T.q1aPlan, message: 'docs(261001-q1a): plan' });
  writeFileAt(alpha, 'src/q1a.mjs', 'export const q1a = 1;\n');
  commitAt(alpha, { home, date: T.q1aCode, message: 'feat(261001-q1a): one' });
  writeFileAt(alpha, `${DIRS.q2b}/261001-q2b-PLAN.md`, md(['tier: B']));
  commitAt(alpha, { home, date: T.q2bPlan, message: 'docs(261001-q2b): plan' });
  writeFileAt(alpha, 'src/q2b.mjs', 'export const q2b = 1;\n');
  commitAt(alpha, { home, date: T.q2bCode, message: 'feat(261001-q2b): two' });
  writeFileAt(alpha, `${DIRS.d1d}/261003-d1d-PLAN.md`, md(['tier: B']));
  commitAt(alpha, { home, date: T.d1dPlan, message: 'docs(261003-d1d): plan' });
  writeFileAt(alpha, 'src/d1d.mjs', 'export const d1d = 1;\n');
  commitAt(alpha, { home, date: T.d1dCode, message: 'feat(261003-d1d): dirname' });
  writePhaseDir(alpha, { name: '03-links', files: { '03-CONTEXT.md': md(['phase: 03-links']) } });
  commitAt(alpha, { home, date: T.context, message: 'docs(03-links): context' });
  writePhaseDir(alpha, { name: '03-links', files: { '03-01-PLAN.md': md(['tier: B']) } });
  commitAt(alpha, { home, date: T.p1Plan, message: 'docs(03-01): plan' });
  writeFileAt(alpha, 'src/p1.mjs', 'export const p1 = 1;\n');
  commitAt(alpha, { home, date: T.p1Code, message: 'feat(03-01): one' });
  writePhaseDir(alpha, { name: '03-links', files: { '03-02-PLAN.md': md(['tier: C']) } });
  commitAt(alpha, { home, date: T.p2Plan, message: 'docs(03-02): plan' });
  writeFileAt(alpha, 'src/p2.mjs', 'export const p2 = 1;\n');
  commitAt(alpha, { home, date: T.p2Code, message: 'feat(03-02): two' });
  writeFileAt(alpha, `${DIRS.z9z}/261009-z9z-PLAN.md`, md(['status: draft']));
  commitAt(alpha, { home, date: T.z9zPlan, message: 'docs(261009-z9z): plan' });
}

function buildBeta(beta, home) {
  makeRepo(beta, { home, files: { 'README.md': 'beta\n' }, untrackedPlanning: true });
  writeFileAt(beta, `${DIRS.u1c}/261007-u1c-PLAN.md`, md(['tier: A']), { mtimeMs: Date.parse(LINK_TIMES.u1cMtime) });
}

// options: reverse (write the session files in reverse order), shuffleSeed (shuffle every transcript's lines),
// s5Ts (move S5's one call to this instant: the adjacency variant).
function writeSessions(root, places, { reverse = false, shuffleSeed = null, s5Ts = null } = {}) {
  const paths = {
    q1aSummary: join(places.alpha, DIRS.q1a, '261001-q1a-SUMMARY.md'),
    q1aPlan: join(places.alpha, DIRS.q1a, '261001-q1a-PLAN.md'),
    q2bPlan: join(places.alpha, DIRS.q2b, '261001-q2b-PLAN.md'),
    p1PlanWt: join(places.worktree, DIRS.phase, '03-01-PLAN.md'),
    context: join(places.alpha, DIRS.phase, '03-CONTEXT.md'),
    u1cPlan: join(places.beta, DIRS.u1c, '261007-u1c-PLAN.md'),
    d1dGone: join(places.goneCopy, DIRS.d1d, '261003-d1d-PLAN.md'),
    d1dPlan: join(places.alpha, DIRS.d1d, '261003-d1d-PLAN.md'),
  };
  const files = new Map();
  const add = (file, line) => { if (!files.has(file)) files.set(file, []); files.get(file).push(line); };
  let n = 0;
  for (const [scope, agent, id, ts0, t, extra] of CALLS) {
    const cwd = places[CWD_OF[scope]];
    const session = LINK_SESSIONS[scope];
    const ts = scope === 'S5' && s5Ts !== null ? s5Ts : ts0;
    const content = (extra.refs ?? []).map(([name, key]) => {
      n += 1;
      return tool(name, 'file_path', paths[key], n);
    });
    const line = makeAssistant({
      session, ts, id, model: agent === '' ? MAIN_MODEL : SUB_MODEL, cwd,
      use: makeUsage({ input: t[0], output: t[1], read: t[2], creation: t[3], c5: t[3], c1: 0 }),
      ...(agent === '' ? {} : { agentId: LINK_SESSIONS[agent], attributionAgent: SUB_ROLE }),
      ...(content.length > 0 ? { content: [...content, { type: 'text', text: 'ok' }] } : {}),
      ...(extra.effort ? { effort: extra.effort } : {}),
      ...(extra.version ? { version: extra.version } : {}),
    });
    if (extra.skill) line.attributionSkill = extra.skill;
    const proj = join(root, 'projects', mangleHome(cwd));
    const file = agent === '' ? join(proj, `${session}.jsonl`) : join(proj, session, 'subagents', `agent-${LINK_SESSIONS[agent]}.jsonl`);
    if (scope === COMMAND.scope && !files.has(file)) {
      add(file, userLine({
        session, ts: COMMAND.ts, cwd,
        text: `<command-message>${COMMAND.name}</command-message>\n<command-name>/${COMMAND.name}</command-name>\n<command-args>link fixture args</command-args>`,
        extra: { uuid: COMMAND.uuid },
      }));
    }
    add(file, JSON.stringify(line));
  }
  const entries = [...files.entries()];
  if (reverse) entries.reverse();
  for (const [file, lines] of entries) {
    writeJsonl(file, lines);
    if (shuffleSeed !== null) shuffleLines(file, shuffleSeed);
  }
}

// -> { alpha, beta, worktree, plain, expected }. options: see writeSessions.
export function buildLinkHome({ home, root = join(home, '.claude'), ...options }) {
  assertOutsideWorkTree(dirname(home));
  const places = {
    alpha: join(home, 'repos', 'alpha'),
    beta: join(home, 'repos', 'beta'),
    worktree: join(home, 'wt', 'alpha-w1'),
    plain: join(home, 'work', 'plain'),
    gone: join(home, 'gone', 'place'),
    goneCopy: join(home, 'gone', 'alpha-copy'),
  };
  buildAlpha(places.alpha, home);
  addWorktree(places.alpha, places.worktree, 'w1', { home });
  buildBeta(places.beta, home);
  mkdirSync(places.plain, { recursive: true });
  writeSessions(root, places, options);
  return { ...places, expected: LINK_EXPECTED };
}
