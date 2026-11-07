// Plant module for the transcript source (01-02). It writes values into the positions that case 10
// of the fixtures does not already carry; case 10 plants: the prompt in a user line and in assistant
// content, a command in a tool_use input, the OS user name in the home path, the project directory
// name and cwd, account and organization ids in user, attachment and bridge-session lines, a hostile
// attribution agent and a hostile model, and non-ASCII text. This module adds:
//   - a sub-agent file with bridge-session and attachment lines carrying account and organization ids
//   - a sub-agent meta file with description, worktreePath and worktreeBranch values
//   - a credentials file and a backups file under the config root
//   - hostile key names (email shape; spaces plus a token) at line, message and usage level
//   - cwd values built from the OS user name in four forms (home, drive-letter, WSL mount, generic)
// plant(ctx) returns the extra strings to scan for, beyond every PLANTS value.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const id = 'transcript';
export const source = 'transcript';

const SESSION = '99999999-9999-4999-8999-999999999999';
const AGENT = 'agentplant00000001';
const t = (s) => `2026-10-27T14:00:0${s}.000Z`;

export function plant(ctx) {
  const { root, home, plants: P, helpers: h } = ctx;
  const extra = {
    desc: 'CANARY-plant-meta-description-text',
    wt: `${h.homePath(P.osUser, 'wsroot', 'wt')}/CANARY-plant-wt`,
    branch: 'CANARY-plant/branch-name',
    keySpaced: 'CANARY plant key spaced tok-CANARYk1',
    keyMail: 'CANARY-plant-mail@canary-example.invalid',
    cred: 'CANARY-plant-credential-secret',
  };
  const proj = join(root, 'projects', `${h.mangleHome(home)}-repos-plant`);
  const use = (n) => h.makeUsage({ input: n, output: n, read: n, creation: n });
  const mk = (n, extraOpts) => h.makeAssistant({
    session: SESSION, ts: t(n), id: `msg_plant_${n}`, model: 'claude-opus-5-5', use: use(n), ...extraOpts,
  });

  const forms = [`${home}/repos/p`, ['C:', 'Users', P.osUser, 'x'].join('\\'), ['', 'mnt', 'c', 'Users', P.osUser, 'y'].join('/'), h.homePath(P.osUser, 'w')];
  const mainLines = [
    h.userLine({ session: SESSION, ts: t(0), text: P.prompt, cwd: forms[0], extra: { accountUuid: P.account } }),
    ...forms.map((cwd, i) => JSON.stringify(mk(i + 1, { cwd, content: [{ type: 'text', text: P.nonAscii }] }))),
  ];
  const hostile = mk(6, { cwd: forms[0] });
  hostile[extra.keySpaced] = 1;
  hostile.message[extra.keyMail] = 1;
  hostile.message.usage[extra.keySpaced] = 1;
  mainLines.push(JSON.stringify(hostile));
  h.writeJsonl(join(proj, `${SESSION}.jsonl`), mainLines);

  const sub = join(proj, SESSION, 'subagents');
  h.writeJsonl(join(sub, `agent-${AGENT}.jsonl`), [
    JSON.stringify(mk(7, { agentId: AGENT, attributionAgent: 'gsd-executor', cwd: forms[1] })),
    JSON.stringify({ type: 'bridge-session', sessionId: SESSION, ownerAccountUuid: P.account, ownerOrganizationUuid: P.org }),
    JSON.stringify({ type: 'attachment', sessionId: SESSION, attachment: { type: 'credential_org', organizationUuid: P.org, email: P.email } }),
    h.userLine({ session: SESSION, ts: t(8), text: P.command }),
  ]);
  writeFileSync(join(sub, `agent-${AGENT}.meta.json`), JSON.stringify({
    agentType: 'gsd-executor', spawnDepth: 1, description: extra.desc, worktreePath: extra.wt, worktreeBranch: extra.branch,
  }));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '.credentials.json'), JSON.stringify({ accountUuid: P.account, token: extra.cred }));
  h.writeJsonl(join(root, 'backups', 'x', 'projects', 'zz', 'b.jsonl'), [
    JSON.stringify(mk(9, { content: [{ type: 'text', text: extra.cred }] })),
  ]);
  return { needles: Object.values(extra) };
}
