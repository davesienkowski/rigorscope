// Scenario: OTel ingest. Builds the OTel fixture tree (live and preserve directories), then runs `ingest`
// twice and `cost` under the hermetic child environment, capturing stdout and stderr of every run.
import { cliEnv, runCli } from '../../fixtures/build.mjs';
import { buildOtelTree } from '../../fixtures/otel.mjs';

export const id = 'otel-ingest';

export async function run(ctx) {
  buildOtelTree(ctx.home, { preserve: true });
  const env = cliEnv(ctx.home);
  const commands = [];
  const outputs = [];
  for (const args of [['ingest'], ['ingest'], ['cost']]) {
    const r = runCli(args, { home: ctx.home, env });
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${args[0]}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${args[0]}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  }
  return { commands, outputs };
}
