// Scenario: `doctor` (plan 01-09, TRUST-05, DATA-05). Builds every fixture case (so every earlier plant is present,
// including the usage-cache plants of 01-06: an account id, an email shape and money values), plants a fake node and
// the checkout symlink, ingests, installs the units with `--apply --no-systemctl`, then runs `doctor`, `doctor --json`
// and `doctor --signals`. Every command must exit 0; every captured output is scanned.
import { buildFixtureTree, cliEnv, runCli } from '../../fixtures/build.mjs';
import { linkCheckout } from '../../fixtures/doctor-rows.mjs';
import { plantFakeNode } from '../../fixtures/fake-bin.mjs';

export const id = 'doctor';

export async function run(ctx) {
  const { home, root, windowsUsersDir } = ctx;
  await buildFixtureTree(root, { home, cases: 'all', windowsUsersDir });
  plantFakeNode(home);
  linkCheckout(home);
  const env = cliEnv(home);
  const commands = [];
  const outputs = [];
  const exec = (tag, args) => {
    const r = runCli(args, { home, env });
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${tag}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${tag}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  };
  exec('ingest', ['ingest']);
  exec('schedule-apply', ['schedule', 'install', '--apply', '--no-systemctl']);
  exec('doctor', ['doctor']);
  exec('doctor-json', ['doctor', '--json']);
  exec('doctor-signals', ['doctor', '--signals']);
  return { commands, outputs };
}
