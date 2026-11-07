// Scenario: the cost report shape and evidence (plan 01-08). Builds every fixture case (so every earlier plant is
// present, plus the report-shape sessions), ingests, then runs `cost`, `cost --json`, `cost --by` with all six
// dimensions and `--evidence`, `evidence main/total` and `evidence otel/total --json` under the hermetic child
// environment. The canary scans the captured outputs for every plant, the OS user name and absolute path prefixes.
import { buildFixtureTree, cliEnv, runCli } from '../../fixtures/build.mjs';
import { DST_NOW } from '../../fixtures/clock.mjs';

export const id = 'report-shape';

export async function run(ctx) {
  const { home, root, windowsUsersDir } = ctx;
  await buildFixtureTree(root, { home, cases: 'all', windowsUsersDir });
  const env = cliEnv(home, { RIGORSCOPE_NOW: DST_NOW });
  const commands = [];
  const outputs = [];
  const runs = [
    ['ingest', ['ingest']],
    ['cost', ['cost']],
    ['cost --json', ['cost', '--json']],
    ['cost --by six --evidence', ['cost', '--by', 'role,model,effort,day,session,repo', '--evidence']],
    ['evidence main/total', ['evidence', 'main/total']],
    ['evidence otel/total --json', ['evidence', 'otel/total', '--json']],
  ];
  for (const [tag, args] of runs) {
    const r = runCli(args, { home, env });
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${tag}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${tag}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  }
  return { commands, outputs };
}
