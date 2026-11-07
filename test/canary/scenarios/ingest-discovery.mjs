// Scenario: discovery. Builds every fixture case (including a fake Windows profile), a second config
// directory reachable only through CLAUDE_CONFIG_DIR, then runs `ingest` with no flags twice and `cost`
// under the hermetic child environment.
import { join } from 'node:path';
import { buildFixtureTree, cliEnv, HELPERS, PLANTS, runCli } from '../../fixtures/build.mjs';

export const id = 'ingest-discovery';

export async function run(ctx) {
  const { home, root, windowsUsersDir } = ctx;
  await buildFixtureTree(root, { home, cases: 'all', windowsUsersDir });
  const second = join(home, 'second-config');
  const h = HELPERS;
  h.writeJsonl(join(second, 'projects', `${h.mangleHome(home)}-repos-second`, 'sess-second.jsonl'), [
    JSON.stringify(h.makeAssistant({
      session: 'sess-second', ts: '2026-10-27T15:00:00.000Z', id: 'msg_second', model: 'claude-opus-5-5',
      cwd: ['C:', 'Users', PLANTS.osUser, 'second'].join('\\'), use: h.makeUsage({ input: 1, output: 1, read: 1, creation: 1 }),
    })),
  ]);
  const env = cliEnv(home, { CLAUDE_CONFIG_DIR: second });
  const commands = [];
  const outputs = [];
  for (const args of [['ingest'], ['ingest'], ['cost']]) {
    const r = runCli(args, { home, env });
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${args[0]}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${args[0]}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  }
  return { commands, outputs };
}
