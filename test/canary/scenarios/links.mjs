// Scenario: session-to-unit links, attribution and evidence ids (plan 02-07, UNIT-06, D-19, T-02-64). Builds every
// fixture case (so every earlier plant is present) and, on the first run only, the link home of
// test/fixtures/link-home.mjs inside the HOME whose path holds the planted OS user name. Then `ingest`, `units
// --evidence` and `units --json --link-confidence low` run under the hermetic child environment, and `evidence` runs on
// the first unit id and the first link id read from that JSON (skipped, not failed, when the home has none). The canary
// scans both databases and every captured output for every plant, the OS user name and any email shape; evidence prints
// only stored home-normalized ref dirs and repo-relative paths.
import { buildFixtureTree, cliEnv, runCli } from '../../fixtures/build.mjs';
import { buildLinkHome } from '../../fixtures/link-home.mjs';

export const id = 'links';

export async function run(ctx) {
  const { home, root, windowsUsersDir } = ctx;
  await buildFixtureTree(root, { home, cases: 'all', windowsUsersDir });
  if (ctx.runId === 1) buildLinkHome({ home, root });
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
  exec(['units', '--evidence']);
  const low = exec(['units', '--json', '--link-confidence', 'low']);
  let doc = null;
  try {
    doc = JSON.parse(low.stdout);
  } catch {
    doc = null;
  }
  const unit = doc?.units?.[0] ?? null;
  const link = doc?.units?.flatMap((u) => u.links ?? [])[0] ?? null;
  if (unit) exec(['evidence', unit.evidence_id]);
  if (link) exec(['evidence', link.evidence_id]);
  return { commands, outputs };
}
