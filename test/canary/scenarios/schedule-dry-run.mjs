// Scenario: `schedule install` (plan 01-09, DATA-04, TRUST-05). Plants a fake node in the fixture HOME (whose path
// holds the planted OS user name, a space and a hash character) and a symlink HOME/repos/rigorscope to this checkout,
// then runs the dry run, `--apply --no-systemctl` and the dry run again under the hermetic child environment. Every
// command must exit 0; the canary scans every captured output for each plant, the OS user name inside the home path,
// the unit directory and the node path.
import { cliEnv, runCli } from '../../fixtures/build.mjs';
import { linkCheckout } from '../../fixtures/doctor-rows.mjs';
import { plantFakeNode } from '../../fixtures/fake-bin.mjs';

export const id = 'schedule-dry-run';

export async function run(ctx) {
  const { home } = ctx;
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
  exec('dry-run', ['schedule', 'install']);
  exec('apply', ['schedule', 'install', '--apply', '--no-systemctl']);
  exec('dry-run-again', ['schedule', 'install']);
  return { commands, outputs };
}
