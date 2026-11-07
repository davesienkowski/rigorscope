// Scenario: the environment snapshot (plan 02-04, DATA-07, D-16 with amendment Q3). Runs `ingest` and `cost` under the
// hermetic child environment with RIGORSCOPE_INSTALLED_BASE_FILE and RIGORSCOPE_LOCAL_MODS_DIR pointing at the env
// plant's base file and local-mods repository, so every snapshot source is read. The canary scans store.db, its WAL
// and shm files, derived.db and every captured output for every plant.
import { cliEnv, runCli } from '../../fixtures/build.mjs';
import { pathsOf } from '../plants/env.mjs';

export const id = 'env-snapshot';

export async function run(ctx) {
  const { home } = ctx;
  const { baseFile, modsDir } = pathsOf(home);
  const env = cliEnv(home, { RIGORSCOPE_INSTALLED_BASE_FILE: baseFile, RIGORSCOPE_LOCAL_MODS_DIR: modsDir });
  const commands = [];
  const outputs = [];
  for (const args of [['ingest'], ['cost']]) {
    const r = runCli(args, { home, env });
    const tag = args.join(' ');
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${tag}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${tag}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  }
  return { commands, outputs };
}
