// Scenario: the OTel join (plan 01-07). Builds every fixture case (so every earlier plant is present, and case
// otel-join plants a hostile query_source label and agent name on an OTel-only request), ingests, then runs
// `cost`, `cost --by model` and `cost --by role,model` under the hermetic child environment. The derivation
// pass copies OTel text into derived.db and the report prints it; the canary scans both.
import { buildFixtureTree, cliEnv, runCli } from '../../fixtures/build.mjs';

export const id = 'otel-join';

export async function run(ctx) {
  const { home, root, windowsUsersDir } = ctx;
  await buildFixtureTree(root, { home, cases: 'all', windowsUsersDir });
  const env = cliEnv(home);
  const commands = [];
  const outputs = [];
  const runs = [
    ['ingest', ['ingest']],
    ['cost', ['cost']],
    ['cost --by model', ['cost', '--by', 'model']],
    ['cost --by role,model', ['cost', '--by', 'role,model']],
  ];
  for (const [tag, args] of runs) {
    const r = runCli(args, { home, env });
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${tag}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${tag}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  }
  return { commands, outputs };
}
