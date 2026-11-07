// Scenario: a HOME that is itself a git repository (review 02-02 CR-01, RR-03). The shared canary HOME from makeHome()
// cannot show this leak: its basename holds a space and a hash character, which fail the repo name shape, so the OS
// user name never became a repo name there. This scenario makes a second, nested HOME `<canary home>/<PLANTS.osUser>`,
// a plain valid name, runs `git init` in it, and gives it a quick dir at HOME's own `.planning/quick/` plus three
// session working directories: HOME itself, an existing non-repo dir under HOME and a vanished dir under HOME. It runs
// `ingest`, `units`, `units --json`, `doctor`, `doctor --json` and `cost --by repo` on the nested HOME and returns their output and the raw bytes of
// the nested store.db, its WAL and shm files and derived.db as outputs, so the canary scans them for the OS user name.
// The outer canary HOME gets one plain `ingest` (so its store exists for the canary's store digest check). Every step
// is idempotent: the second canary run finds the repository and the files in place.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PLANTS, cliEnv, makeAssistant, makeUsage, mangleHome, runCli, stateDirOf, writeJsonl,
} from '../../fixtures/build.mjs';
import {
  assertOutsideWorkTree, git, writeFileAt, writeQuickDir,
} from '../../fixtures/git-repo.mjs';
import { checkpointStore } from '../../../src/db.mjs';

export const id = 'units-home-repo';

const SESSIONS = [
  ['c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', []],
  ['c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2', ['scratch']],
  ['c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3', ['gone', 'place']],
];

function buildHomeRepo(home) {
  assertOutsideWorkTree(dirname(home));
  mkdirSync(join(home, 'scratch'), { recursive: true });
  if (!existsSync(join(home, '.git'))) {
    git(home, ['init', '--quiet'], { home });
    git(home, ['commit', '--quiet', '--allow-empty', '-m', 'fixture commit'], { home });
  }
  writeQuickDir(home, {
    id: '261030-h0m', slug: 'home-task', plan: { tier: 'A', body: 'Plan body.' }, summary: { tier: 'A', body: 'Summary body.' },
  });
  // Plan 03.1-04 (T-03.1-11): an unclassified file whose name holds the OS user name as a word. It is counted, but its stem must
  // reach no database file and no output (the stem filter drops an owner word into the remainder row).
  writeFileAt(home, `.planning/quick/261030-h0m-home-task/notes-${PLANTS.osUser}.md`, 'note\n');
  const root = join(home, '.claude');
  SESSIONS.forEach(([session, rel], i) => {
    const cwd = join(home, ...rel);
    const line = makeAssistant({
      session, ts: `2026-10-27T16:00:0${i}.000Z`, id: `msg_homerepo_${i}`, model: 'claude-opus-5-5', cwd,
      use: makeUsage({ input: 10, output: 5, read: 0, creation: 0 }),
    });
    writeJsonl(join(root, 'projects', mangleHome(cwd), `${session}.jsonl`), [JSON.stringify(line)]);
  });
}

export async function run(ctx) {
  const commands = [];
  const outputs = [];
  const outer = runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home) });
  commands.push({ args: ['ingest'], status: outer.status });

  const home = join(ctx.home, PLANTS.osUser);
  buildHomeRepo(home);
  const env = cliEnv(home);
  for (const args of [['ingest'], ['units'], ['units', '--json'], ['doctor'], ['doctor', '--json'], ['cost', '--by', 'repo']]) {
    const r = runCli(args, { home, env });
    const tag = args.join(' ');
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${tag}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${tag}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  }
  checkpointStore({ home });
  const dir = stateDirOf(home);
  for (const n of ['store.db', 'store.db-wal', 'store.db-shm', 'derived.db']) {
    if (existsSync(join(dir, n))) outputs.push({ label: `${id}:home-repo:${n}`, buf: readFileSync(join(dir, n)) });
  }
  return { commands, outputs };
}
