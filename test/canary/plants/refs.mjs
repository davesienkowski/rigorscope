// Plant module for the planning refs and command names (plan 02-04, D-12 with amendment Q4, D-14 with amendment Q5,
// T-02-30, T-02-31, T-02-34). One session under the canary root, cwd under HOME, with:
//   - a Bash command naming a planning path (amendment Q4: never a ref)
//   - Write content holding a planning path, and a free-text Grep pattern holding one (never a ref)
//   - a user command line whose <command-args> hold a plant and the command plant (only the name is kept)
//   - a user line whose tool_result block holds a <command-name> tag (never a command)
//   - assistant lines with a line-level gitBranch whose value starts with the OS user name plant (amendment Q5)
//   - valid refs in the drive-letter and WSL-mount forms with the OS user name plant as the user segment and plain
//     slugs: they are stored home-normalized (`~win` or `~other`), so the OS user name never reaches the store
// plant(ctx) returns the extra strings to scan for, beyond every PLANTS value.
import { join } from 'node:path';

export const id = 'refs';
export const source = 'transcript';

const SESSION = '86868686-8686-4686-8686-868686868686';
const t = (s) => `2026-10-27T16:30:${String(s).padStart(2, '0')}.000Z`;

export function plant(ctx) {
  const { root, home, plants: P, helpers: h } = ctx;
  const extra = {
    bash: 'CANARYbashref',
    content: 'CANARYcontentref',
    grep: 'CANARYgrepref',
    args: 'CANARY-plant-command-args',
    toolResult: 'CANARY-tr-name',
    branch: 'CANARY-plant-branch-ref',
  };
  const cwd = `${home}/repos/p`;
  // The WSL-mount form of a Windows profile, built from segments (no home-path literal in this source).
  const wslProfile = ['', 'mnt', 'c', 'Users', P.osUser].join('/');
  const proj = join(root, 'projects', `${h.mangleHome(home)}-repos-p`);
  const tu = (name, input) => ({ type: 'tool_use', id: `toolu_${name}`, name, input });
  const mk = (n, content) => {
    const o = h.makeAssistant({
      session: SESSION, ts: t(n), id: `msg_refplant_${n}`, model: 'claude-opus-5-5', cwd, content,
      use: h.makeUsage({ input: n, output: n, read: 0, creation: 0 }),
    });
    o.gitBranch = `${P.osUser}/${extra.branch}`;
    return JSON.stringify(o);
  };
  h.writeJsonl(join(proj, `${SESSION}.jsonl`), [
    JSON.stringify({
      type: 'user', uuid: 'uuid-refplant-0', sessionId: SESSION, timestamp: t(0), cwd,
      message: { role: 'user', content: `<command-name>/gsd-quick</command-name>\n<command-args>${extra.args} ${P.command}</command-args>` },
    }),
    mk(1, [tu('Bash', { command: `cat ${home}/repos/p/.planning/quick/261031-cnb-${extra.bash}/261031-cnb-PLAN.md` })]),
    mk(2, [tu('Write', { file_path: `${home}/repos/p/notes.md`, content: `see .planning/quick/261031-cwr-${extra.content}/x` })]),
    mk(3, [tu('Grep', { pattern: `CANARY grep text .planning/quick/261031-cgp-${extra.grep}` })]),
    JSON.stringify({
      type: 'user', uuid: 'uuid-refplant-4', sessionId: SESSION, timestamp: t(4), cwd,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_Bash', content: `<command-name>/${extra.toolResult}</command-name>` }] },
    }),
    mk(5, [tu('Read', { file_path: ['C:', 'Users', P.osUser, 'code', 'w', '.planning', 'quick', '261031-cok-winform', '261031-cok-PLAN.md'].join('\\') })]),
    mk(6, [tu('Read', { file_path: `${wslProfile}/q/.planning/quick/261031-cok-winform/261031-cok-SUMMARY.md` })]),
  ]);
  return { needles: Object.values(extra) };
}
