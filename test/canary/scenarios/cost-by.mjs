// Scenario: the derivation core (plan 01-04). Builds every fixture case, so the planted values of all
// earlier cases are present to be found, ingests under the hermetic child environment, and runs `cost`,
// `cost --by model` and `cost --by role,model`. The canary scans derived.db (api_call, api_call_part,
// derive_state), the store and every captured output for the planted values.
import { buildFixtureTree, cliEnv, runCli } from '../../fixtures/build.mjs';

export const id = 'cost-by';

export async function run(ctx) {
  const { home, root, windowsUsersDir } = ctx;
  await buildFixtureTree(root, { home, cases: 'all', windowsUsersDir });
  const env = cliEnv(home);
  const commands = [];
  const outputs = [];
  for (const args of [['ingest'], ['cost'], ['cost', '--by', 'model'], ['cost', '--by', 'role,model']]) {
    const r = runCli(args, { home, env });
    const tag = args.join(' ');
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${tag}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${tag}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  }
  return { commands, outputs };
}
