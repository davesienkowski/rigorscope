// Scenario: reconstructed units (plan 02-02, UNIT-01, UNIT-05, T-02-10, T-02-11). Builds every fixture case (so every
// earlier plant is present) and, on the first run only, the units home with plants: the prompt plant in a quick PLAN
// body, the command plant on the tier line after the letter and the email plant in a SUMMARY body, inside a HOME whose
// path holds the planted OS user name. Then `ingest`, `units`, `units --json` and `cost --by repo` run under the
// hermetic child environment. The canary scans store.db, its WAL and shm files, derived.db and every captured output
// for every plant, the OS user name and any email shape. The second run rebuilds the cases only (the units home and
// its git repositories are already in place).
import { buildFixtureTree, cliEnv, runCli } from '../../fixtures/build.mjs';
import { buildUnitsHome } from '../../fixtures/units-home.mjs';

export const id = 'units';

export async function run(ctx) {
  const { home, root, windowsUsersDir } = ctx;
  await buildFixtureTree(root, { home, cases: 'all', windowsUsersDir });
  if (ctx.runId === 1) buildUnitsHome({ home, root, plants: true });
  const env = cliEnv(home);
  const commands = [];
  const outputs = [];
  for (const args of [['ingest'], ['units'], ['units', '--json'], ['cost', '--by', 'repo']]) {
    const r = runCli(args, { home, env });
    const tag = args.join(' ');
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${tag}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${tag}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  }
  return { commands, outputs };
}
