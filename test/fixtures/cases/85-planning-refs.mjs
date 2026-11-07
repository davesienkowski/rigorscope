// Case 85 (plan 02-04, D-12 with amendment Q4, D-14 with amendment Q5): planning-file refs from structured tool_use
// fields and slash-command names from user lines, with the inputs that must never become a ref or a command. Every
// expectation is computed by hand from the lines below, never by the code under test. Never imports build.mjs.
//
// Main session file (cwd <home>/work/beta), in order:
//   1  user command line uuid-r-1 naming /gsd-quick with arguments
//   2  msg_r1  Read of alpha's quick PLAN (absolute, under HOME)
//   3  a byte-identical streaming copy of line 2
//   4  msg_r2  Edit of alpha's quick SUMMARY; old_string and new_string hold another planning path (never read)
//   5  msg_r3  Bash whose command names a planning path (never read)
//   6  msg_r4  Grep (pattern TODO, relative path .planning/phases/02-demo) and Glob (a glob pattern: ref_short)
//   7  msg_r5  Grep with a free-text pattern holding a planning path (never read: a Grep pattern is a content regex,
//              review WR-02; not counted)
//   8  msg_r6  two Read blocks of one phase PLAN (n 2)
//   9  user line with one tool_result block holding a command-name tag (command_tool_result)
//  10  user line naming a command with words after the name (command_no_name)
//  11  user line naming /gsd-plan-phase with no uuid (command_dropped)
//  14  user line quoting a well-formed command-name tag after prose (command_unanchored, review WR-06)
// Subagent file agent-agentrefs0000001.jsonl:
//  12  msg_r7  NotebookEdit of a phase notebook
//  13  user command line uuid-r-13 (agentId agentrefs0000001), text blocks naming /gsd-execute-phase with arguments
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

export const id = 'planning-refs';
export const group = 'extra';
export const sources = ['transcript'];

export const S85 = '85858585-8585-4585-8585-858585858585';
export const A85 = 'agentrefs0000001';
const t = (s) => `2026-10-27T16:00:${String(s).padStart(2, '0')}.000Z`;

const ALPHA_QUICK = '.planning/quick/261030-a1b-first-task';
const ALPHA_PHASE = '.planning/phases/02-demo/02-01-PLAN.md';
const NOTEBOOK = '.planning/phases/03-nb/03-01-NOTES.ipynb';

function userCmd({ uuid, ts, content, agentId }) {
  const o = { type: 'user', sessionId: S85, timestamp: ts, message: { role: 'user', content } };
  if (uuid !== undefined) o.uuid = uuid;
  if (agentId !== undefined) { o.agentId = agentId; o.isSidechain = true; }
  return JSON.stringify(o);
}

export function build(ctx) {
  const { root, home, helpers: h } = ctx;
  const proj = join(root, 'projects', `${h.mangleHome(home)}-work-beta`);
  const cwd = `${home}/work/beta`;
  const alpha = `${home}/repos/alpha`;
  const msg = (n, id2, content, extra = {}) => JSON.stringify(h.makeAssistant({
    session: S85, ts: t(n), id: id2, model: 'claude-opus-5-5', cwd, content,
    use: h.makeUsage({ input: n, output: n, read: 0, creation: 0 }), ...extra,
  }));
  const tu = (name, input) => ({ type: 'tool_use', id: `toolu_${name}`, name, input });
  const read = msg(2, 'msg_r1', [tu('Read', { file_path: `${alpha}/${ALPHA_QUICK}/261030-a1b-PLAN.md` })]);
  const main = join(proj, `${S85}.jsonl`);
  h.writeJsonl(main, [
    userCmd({
      uuid: 'uuid-r-1', ts: t(1),
      content: '<command-message>gsd-quick</command-message>\n<command-name>/gsd-quick</command-name>\n<command-args>refs case args text</command-args>',
    }),
    read,
    read,
    msg(4, 'msg_r2', [tu('Edit', {
      file_path: `${alpha}/${ALPHA_QUICK}/261030-a1b-SUMMARY.md`,
      old_string: 'see .planning/quick/261031-ced-edit-text/x.md',
      new_string: '.planning/quick/261031-ced-edit-text/x.md',
    })]),
    msg(5, 'msg_r3', [tu('Bash', { command: `cat ${alpha}/.planning/quick/261031-cnb-bash-only/261031-cnb-PLAN.md` })]),
    msg(6, 'msg_r4', [tu('Grep', { pattern: 'TODO', path: '.planning/phases/02-demo' }), tu('Glob', { pattern: '.planning/phases/02-*/*-PLAN.md' })]),
    msg(7, 'msg_r5', [tu('Grep', { pattern: 'grep free text .planning/quick/261030-a1b-first-task' })]),
    msg(8, 'msg_r6', [tu('Read', { file_path: `${alpha}/${ALPHA_PHASE}` }), tu('Read', { file_path: `${alpha}/${ALPHA_PHASE}` })]),
    userCmd({
      uuid: 'uuid-r-9', ts: t(9),
      content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: '<command-name>/gsd-fake</command-name>' }],
    }),
    userCmd({ uuid: 'uuid-r-10', ts: t(10), content: '<command-name>/gsd-quick extra words</command-name>' }),
    userCmd({ ts: t(11), content: '<command-name>/gsd-plan-phase</command-name>' }),
    userCmd({ uuid: 'uuid-r-14', ts: t(14), content: 'please quote <command-name>/gsd-fake2</command-name> here' }),
  ]);
  const sub = join(proj, S85, 'subagents', `agent-${A85}.jsonl`);
  h.writeJsonl(sub, [
    msg(12, 'msg_r7', [tu('NotebookEdit', { notebook_path: `${alpha}/${NOTEBOOK}`, new_source: 'x' })], { agentId: A85 }),
    userCmd({
      uuid: 'uuid-r-13', ts: t(13), agentId: A85,
      content: [{ type: 'text', text: '<command-message>gsd-execute-phase</command-message>\n<command-name>/gsd-execute-phase</command-name>\n<command-args>3</command-args>' }],
    }),
  ]);
  return [main, sub];
}

const k = (id2, agent = '') => `${S85}|${agent}|${id2}`;
const pre = '~-work-beta';

// The two row sets of migration 007, ordered by key.
export const REFS = [
  [S85, '', 'msg_r1', '~/repos/alpha', `${ALPHA_QUICK}/261030-a1b-PLAN.md`, 'quick', 'Read', 1],
  [S85, '', 'msg_r2', '~/repos/alpha', `${ALPHA_QUICK}/261030-a1b-SUMMARY.md`, 'quick', 'Edit', 1],
  [S85, '', 'msg_r4', '~/work/beta', '.planning/phases/02-demo', 'phase', 'Grep', 1],
  [S85, '', 'msg_r6', '~/repos/alpha', ALPHA_PHASE, 'phase', 'Read', 2],
  [S85, A85, 'msg_r7', '~/repos/alpha', NOTEBOOK, 'phase', 'NotebookEdit', 1],
];
export const COMMANDS = [
  [S85, '', 'uuid-r-1', t(1), 'gsd-quick'],
  [S85, A85, 'uuid-r-13', t(13), 'gsd-execute-phase'],
];
// ingest_count kind capture: refs counts every kept ref of every line (lines 2, 3, 4, 6, 8 and 12 keep one each).
export const CAPTURE = {
  command_dropped: 1, command_no_name: 1, command_tool_result: 1, command_unanchored: 1, commands: 2, ref_short: 1, refs: 6,
};

export const expected = {
  messageKeys: {
    [k('msg_r1')]: [2, 2, 0, 0, null, null],
    [k('msg_r2')]: [4, 4, 0, 0, null, null],
    [k('msg_r3')]: [5, 5, 0, 0, null, null],
    [k('msg_r4')]: [6, 6, 0, 0, null, null],
    [k('msg_r5')]: [7, 7, 0, 0, null, null],
    [k('msg_r6')]: [8, 8, 0, 0, null, null],
    [k('msg_r7', A85)]: [12, 12, 0, 0, null, null],
  },
  sourceFiles: [`claude:${pre}/${S85}.jsonl`, `claude:${pre}/${S85}/subagents/agent-${A85}.jsonl`],
  agentMeta: [],
  skipped: {},
  unknownAttr: {},
  dropped: {},
  cwd: { [k('msg_r1')]: '~/work/beta', [k('msg_r7', A85)]: '~/work/beta' },
  leakIds: ['261031-cnb-bash-only', '261031-ced-edit-text', 'refs case args text', 'gsd-fake', 'gsd-fake2', 'extra words', 'grep free text'],
};

export function verify(ctx) {
  const db = new DatabaseSync(join(ctx.home, '.rigorscope', 'store.db'), { readOnly: true });
  try {
    const rows = (sql) => db.prepare(sql).all().map((r) => Object.values(r));
    assert.deepEqual(rows(`SELECT session_id, agent_id, message_id, ref_dir, rel_path, ref_kind, tool_name, n FROM cc_message_ref
      ORDER BY session_id, agent_id, message_id, ref_dir, rel_path`), REFS, 'cc_message_ref rows');
    assert.deepEqual(rows('SELECT session_id, agent_id, uuid, ts_utc, command_name FROM cc_command ORDER BY session_id, agent_id, uuid'),
      COMMANDS, 'cc_command rows');
    const capture = Object.fromEntries(db.prepare("SELECT name, sum(n) AS n FROM ingest_count WHERE kind = 'capture' GROUP BY name ORDER BY name")
      .all().map((r) => [r.name, r.n]));
    assert.deepEqual(capture, CAPTURE, 'capture counts');
    const user = db.prepare("SELECT sum(n) AS n FROM ingest_count WHERE kind = 'skipped_type' AND name = 'user'").get().n;
    assert.equal(user, 4, 'the four user lines that yield no command row stay skipped user lines');
  } finally {
    db.close();
  }
}
