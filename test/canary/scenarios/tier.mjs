// Scenario: the tier report and the new cost dimensions (plan 02-08, D-18, RPT-01, T-02-77). Builds every fixture case (so every
// earlier plant is present) and, on the first run only, the tier home of test/fixtures/tier-home.mjs inside the HOME whose path
// holds the planted OS user name. Then `ingest`, `tier`, `tier --json --include-inferred --link-confidence low`, `tier
// --evidence` and `cost --by tier,unit,framework,runtime --evidence` run under the hermetic child environment. The canary scans
// both databases and every captured output for every plant, the OS user name and any email shape; the report prints only
// home-normalized unit keys, `u:` ids and stored confounder values, never an absolute path or command text.
import { buildFixtureTree, cliEnv, runCli } from '../../fixtures/build.mjs';
import { buildTierHome } from '../../fixtures/tier-home.mjs';

export const id = 'tier';

export async function run(ctx) {
  const { home, root, windowsUsersDir } = ctx;
  await buildFixtureTree(root, { home, cases: 'all', windowsUsersDir });
  if (ctx.runId === 1) buildTierHome({ home, root });
  const env = cliEnv(home);
  const commands = [];
  const outputs = [];
  const exec = (args) => {
    const r = runCli(args, { home, env });
    const tag = args.join(' ');
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${tag}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${tag}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
    return r;
  };
  exec(['ingest']);
  exec(['tier']);
  exec(['tier', '--json', '--include-inferred', '--link-confidence', 'low']);
  exec(['tier', '--evidence']);
  exec(['cost', '--by', 'tier,unit,framework,runtime', '--since', '2026-10-01', '--until', '2026-11-01', '--evidence']);
  return { commands, outputs };
}
