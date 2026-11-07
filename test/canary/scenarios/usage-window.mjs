// Scenario: usage snapshots and window share (plan 01-06, D-11a). Builds case usage-window (its transcript
// carries the usageReport line of snapshot D, and its build writes the hostile cache file of snapshot A), then
// under the hermetic child environment runs `ingest` twice, `cost --by role,model`, `cost` and `--help`;
// replaces the cache with unparseable text that holds the plants and runs `ingest` and `cost`; restores a
// valid hostile cache (snapshot E) and runs `ingest` once more. Every command must exit 0; every captured
// stdout and stderr is scanned.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFixtureTree, cliEnv, runCli } from '../../fixtures/build.mjs';
import { SNAPSHOTS, USAGE_PLANTS, writeUsageCache } from '../../fixtures/usage-cache.mjs';

export const id = 'usage-window';

export async function run(ctx) {
  const { home, root, windowsUsersDir } = ctx;
  await buildFixtureTree(root, { home, cases: ['usage-window'], windowsUsersDir });
  const env = cliEnv(home);
  const commands = [];
  const outputs = [];
  const exec = (tag, args) => {
    const r = runCli(args, { home, env });
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${tag}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${tag}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  };
  exec('ingest-1', ['ingest']);
  exec('ingest-2', ['ingest']);
  exec('cost-by', ['cost', '--by', 'role,model']);
  exec('cost', ['cost']);
  exec('help', ['--help']);
  writeFileSync(
    join(home, '.claude.json'),
    `{"cachedUsageUtilization":{"fetchedAtMs":1793034000000,"accountUuid":"${USAGE_PLANTS.accountId}",` +
      `"utilization":{"x":"${USAGE_PLANTS.email}","y":"${USAGE_PLANTS.moneyString}"`,
  );
  exec('ingest-unparseable', ['ingest']);
  exec('cost-unparseable', ['cost']);
  writeUsageCache(home, SNAPSHOTS.E);
  exec('ingest-restored', ['ingest']);
  return { commands, outputs };
}
