// Scenario: the 01-01 flows, unchanged in behavior. Builds the tracer tree, then runs ingest with an
// explicit root, cost and --help through the CLI under a hermetic environment.
import { buildTranscriptTree, runCli } from '../../fixtures/build.mjs';

export const id = 'ingest-cost';

export async function run(ctx) {
  buildTranscriptTree(ctx.root);
  const commands = [];
  const outputs = [];
  for (const args of [['ingest', '--root', ctx.root], ['cost'], ['--help']]) {
    const r = runCli(args, { home: ctx.home });
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${args[0]}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${args[0]}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  }
  return { commands, outputs };
}
