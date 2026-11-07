// Scenario: notional dollars (plan 01-05). Builds every fixture case, ingests, runs
// `cost --by role,model` with the shipped price table, then runs `cost` twice more with
// RIGORSCOPE_PRICES_DIR pointing at two hostile tables inside the fixture HOME:
//   1. valid JSON with the prompt plant as an extra key name and the email plant in notes
//   2. a JSON syntax error whose text holds the command plant at the error position
// Both must be refused with a fixed code (exit 0, one warning line) and leave no planted byte in any
// output, the store, derived.db or its WAL. The canary scans all of them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFixtureTree, cliEnv, runCli } from '../../fixtures/build.mjs';

export const id = 'cost-price';

const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';

function hostileValid(plants) {
  return JSON.stringify({
    schema: 1,
    date_read: '2026-12-31',
    source_url: PRICING_URL,
    reread: false,
    unit: 'usd_per_million_tokens',
    label: 'notional',
    modifiers: { geo_us: { num: 11, den: 10 } },
    models: {
      'claude-opus-5-5': { input: 4, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2, output: 20, status: 'cited' },
    },
    notes: [plants.email],
    [plants.prompt]: 1,
  });
}

export async function run(ctx) {
  const { home, root, windowsUsersDir, plants } = ctx;
  await buildFixtureTree(root, { home, cases: 'all', windowsUsersDir });
  const keyDir = join(home, 'prices-hostile-key');
  const jsonDir = join(home, 'prices-hostile-json');
  mkdirSync(keyDir, { recursive: true });
  mkdirSync(jsonDir, { recursive: true });
  writeFileSync(join(keyDir, 'prices-2026-12-31.json'), hostileValid(plants));
  writeFileSync(join(jsonDir, 'prices-2026-12-31.json'), `{"schema": 1, "notes": [${plants.command}`);

  const commands = [];
  const outputs = [];
  const runs = [
    ['ingest', ['ingest'], {}],
    ['cost --by role,model', ['cost', '--by', 'role,model'], {}],
    ['cost hostile-key', ['cost', '--by', 'role,model'], { RIGORSCOPE_PRICES_DIR: keyDir }],
    ['cost hostile-json', ['cost', '--by', 'role,model'], { RIGORSCOPE_PRICES_DIR: jsonDir }],
  ];
  for (const [tag, args, extra] of runs) {
    const r = runCli(args, { home, env: cliEnv(home, extra) });
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${tag}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${tag}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  }
  return { commands, outputs };
}
