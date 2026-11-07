// Case 20: a main session with a sub-agent file, a nested workflow sub-agent file, their metas, and
// the paths the walk must NOT read (journal, non-agent names, symlinks, tool-results, credentials,
// backups). All expectations are hand-computed from the lines below. Never imports build.mjs.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const id = 'subagents';
export const group = 'extra';
export const sources = ['transcript'];

export const S3 = '33333333-3333-4333-8333-333333333333';
const A1 = 'agentaaaa00000001';
const A2 = 'agentbbbb00000002';
export const LEAK_IDS = [
  'm-journal-leak', 'm-notes-leak', 'm-outside-leak', 'm-outside-dir-leak', 'm-toolresults-leak', 'm-backupdir-leak',
];

const t = (s) => `2026-10-27T13:00:0${s}.000Z`;

export function build(ctx) {
  const { root, home, plants, helpers: h } = ctx;
  const proj = join(root, 'projects', `${h.mangleHome(home)}-repos-agents`);
  const cwd = `${home}/repos/agents`;
  const sess = join(proj, `${S3}.jsonl`);
  const subdir = join(proj, S3, 'subagents');
  const leak = (id2, session = S3) => JSON.stringify(h.makeAssistant({
    session, ts: t(9), id: id2, model: 'claude-opus-5-5', use: h.makeUsage({ input: 999, output: 999, read: 999, creation: 999 }),
  }));

  h.writeJsonl(sess, [
    h.userLine({ session: S3, ts: t(0), text: plants.prompt, cwd }),
    JSON.stringify(h.makeAssistant({
      session: S3, ts: t(1), id: 'msg_m31', model: 'claude-opus-5-5', cwd,
      use: h.makeUsage({ input: 10, output: 20, read: 100, creation: 5, c5: 5, c1: 0 }),
    })),
    JSON.stringify(h.makeAssistant({
      session: S3, ts: t(2), id: 'msg_m32', model: 'claude-opus-5-5', cwd,
      use: h.makeUsage({ input: 3, output: 4, read: 0, creation: 0, c5: 0, c1: 0 }),
    })),
    JSON.stringify({ type: 'system', subtype: 'info', sessionId: S3, timestamp: t(2) }),
  ]);

  const a1 = join(subdir, `agent-${A1}.jsonl`);
  h.writeJsonl(a1, [
    JSON.stringify(h.makeAssistant({
      session: S3, ts: t(3), id: 'msg_m33', model: 'claude-sonnet-5-5', cwd, agentId: A1, attributionAgent: 'gsd-executor',
      use: h.makeUsage({ input: 4, output: 6, read: 8, creation: 2, c5: 2, c1: 0 }),
    })),
    JSON.stringify({
      type: 'bridge-session', sessionId: S3, ownerAccountUuid: plants.account, ownerOrganizationUuid: plants.org,
    }),
  ]);
  writeFileSync(join(subdir, `agent-${A1}.meta.json`), JSON.stringify({
    agentType: 'gsd-executor', spawnDepth: 1, model: 'claude-sonnet-5-5', toolUseId: 'toolu_01AAA', isFork: false,
    finished: true, description: plants.prompt, worktreePath: `${home}/wt/${plants.osUser}-x`, worktreeBranch: 'feat/x',
    brandNewMetaKey: 'x',
  }));

  const wf = join(subdir, 'workflows', 'wf_0001');
  h.writeJsonl(join(wf, `agent-${A2}.jsonl`), [
    JSON.stringify(h.makeAssistant({
      session: S3, ts: t(5), id: 'msg_m34', model: 'claude-haiku-5-5', cwd, agentId: A2, attributionAgent: 'Explore',
      use: h.makeUsage({ input: 1, output: 1, read: 0, creation: 0, c5: 0, c1: 0 }),
    })),
  ]);
  writeFileSync(join(wf, `agent-${A2}.meta.json`), JSON.stringify({
    agentType: 'Explore', spawnDepth: 2, parentAgentId: A1, isFork: true, workflowPhase: 'plan',
  }));

  // Paths that must be skipped or never entered.
  h.writeJsonl(join(wf, 'journal.jsonl'), [
    JSON.stringify({ type: 'started', sessionId: S3 }), JSON.stringify({ type: 'result', sessionId: S3 }), leak('m-journal-leak'),
  ]);
  h.writeJsonl(join(subdir, 'notes.jsonl'), [leak('m-notes-leak')]);
  const outside = join(home, 'outside');
  h.writeJsonl(join(outside, 'leak.jsonl'), [leak('m-outside-leak')]);
  rmSync(join(subdir, 'agent-agentlink00000003.jsonl'), { force: true });
  symlinkSync(join(outside, 'leak.jsonl'), join(subdir, 'agent-agentlink00000003.jsonl'));
  h.writeJsonl(join(outside, 'linkproj', 'S.jsonl'), [leak('m-outside-dir-leak', 'sess-outside')]);
  rmSync(join(root, 'projects', 'linkproj'), { force: true });
  symlinkSync(join(outside, 'linkproj'), join(root, 'projects', 'linkproj'));
  h.writeJsonl(join(proj, S3, 'tool-results', 'stray.jsonl'), [leak('m-toolresults-leak')]);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '.credentials.json'), JSON.stringify({ accountUuid: plants.account, organizationUuid: plants.org }));
  h.writeJsonl(join(root, 'backups', 'archive', 'projects', 'zz', 'old.jsonl'), [leak('m-backupdir-leak')]);
  return [sess, a1, join(wf, `agent-${A2}.jsonl`)];
}

const pre = '~-repos-agents';
export const expected = {
  messageKeys: {
    [`${S3}||msg_m31`]: [10, 20, 100, 5, 5, 0],
    [`${S3}||msg_m32`]: [3, 4, 0, 0, 0, 0],
    [`${S3}|${A1}|msg_m33`]: [4, 6, 8, 2, 2, 0],
    [`${S3}|${A2}|msg_m34`]: [1, 1, 0, 0, 0, 0],
  },
  sourceFiles: [
    `claude:${pre}/${S3}.jsonl`,
    `claude:${pre}/${S3}/subagents/agent-${A1}.jsonl`,
    `claude:${pre}/${S3}/subagents/agent-${A1}.meta.json`,
    `claude:${pre}/${S3}/subagents/workflows/wf_0001/agent-${A2}.jsonl`,
    `claude:${pre}/${S3}/subagents/workflows/wf_0001/agent-${A2}.meta.json`,
  ],
  agentMeta: [
    {
      session_id: S3, agent_id: A1, agent_type: 'gsd-executor', spawn_depth: 1, model: 'claude-sonnet-5-5',
      tool_use_id: 'toolu_01AAA', parent_agent_id: null, is_fork: 0, workflow_phase: null, finished: 1,
      spawned_with_worktree: null, stopped_by_user: null, launched_with_defaults: null, request_non_interactive: null,
    },
    {
      session_id: S3, agent_id: A2, agent_type: 'Explore', spawn_depth: 2, model: null,
      tool_use_id: null, parent_agent_id: A1, is_fork: 1, workflow_phase: 'plan', finished: null,
      spawned_with_worktree: null, stopped_by_user: null, launched_with_defaults: null, request_non_interactive: null,
    },
  ],
  skipped: { journal: 1, name: 1, symlink: 2 },
  unknownAttr: { 'meta|brandNewMetaKey': 1 },
  dropped: {},
  cwd: { [`${S3}||msg_m31`]: '~/repos/agents' },
  leakIds: LEAK_IDS,
};
