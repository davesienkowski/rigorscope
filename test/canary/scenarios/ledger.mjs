// Scenario: the forward ledger (plan 03-01, LEDG-02, T-03-01, R6). The canary scan reads the databases and captured output;
// the ledger file is a new byte source, so this scenario returns its raw bytes as an extra source and the existing scan
// covers it. It builds every fixture case and, on the first run only, the units home with plants (the prompt plant in a
// quick PLAN body, the command plant on the tier line after the letter, the email plant in a SUMMARY body, a commit whose
// subject, body, author name and author email are plants, inside a HOME whose path holds the planted OS user name), runs
// `ingest`, then `unit-start --tier-source plan-at-start` and `unit-close` from the linked worktree with the planted email
// as CLAUDE_CODE_SESSION_ID and CLAUDECODE set. The email-shaped session id must degrade to null (exit 0, not exit 2), and
// the ledger bytes must hold no plant, OS user name or email shape. The second run rebuilds the cases only and appends two
// more lines.
//
// Plan 03-03 (the canary half): the legitimate ledger bytes are captured first (returned as the scanned ledger source), then
// hostile lines are appended straight to the file (an unknown key whose value is the planted email, a line whose session id is
// a path holding the planted OS user name, a branch-shaped key whose value is the prompt plant), then `ingest`, `units
// --json` and `doctor` run. The hostile bytes stay in the ledger file, which is the hostile input and not scanned; the scan
// covers store.db, derived.db and every output, and none of them may hold a plant.
import { appendFileSync, readFileSync } from 'node:fs';
import {
  PLANTS, buildFixtureTree, cliEnv, runCli,
} from '../../fixtures/build.mjs';
import { buildUnitsHome } from '../../fixtures/units-home.mjs';
import { ledgerPath } from '../../../src/ledger/append.mjs';
import { LINE_FIELDS, validateLine } from '../../../src/ledger/line.mjs';

export const id = 'ledger';

export async function run(ctx) {
  const { home, root, windowsUsersDir } = ctx;
  await buildFixtureTree(root, { home, cases: 'all', windowsUsersDir });
  const built = ctx.runId === 1 ? buildUnitsHome({ home, root, plants: true }) : null;
  const worktree = built ? built.worktree : `${home}/wt/alpha-fix`;
  const env = cliEnv(home);
  const ledgerEnv = cliEnv(home, { CLAUDE_CODE_SESSION_ID: PLANTS.email, CLAUDECODE: '1' });
  const commands = [];
  const outputs = [];
  const steps = [
    [['ingest'], env, undefined],
    [['unit-start', '--kind', 'quick', '--id', '261030-a1b', '--tier-source', 'plan-at-start', '--command', 'gsd-quick'], ledgerEnv, worktree],
    [['unit-close', '--kind', 'quick', '--id', '261030-a1b', '--status', 'complete'], ledgerEnv, worktree],
  ];
  for (const [args, e, cwd] of steps) {
    const r = runCli(args, { home, env: e, ...(cwd ? { cwd } : {}) });
    const tag = args.slice(0, 1).join(' ');
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${tag}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${tag}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  }
  // The legitimate ledger bytes: the lines the writer made. On the second run the file already holds the first run's hostile
  // lines, so a line counts as the writer's only when it has no key outside the allowlist and passes the line rules (a leak by
  // the writer into an allowed field would still be in these bytes and found by the scan).
  const lines = readFileSync(ledgerPath(home), 'utf8').split('\n').filter((l) => l !== '');
  const writerMade = lines.filter((l) => {
    try {
      const o = JSON.parse(l);
      return Object.keys(o).every((k) => LINE_FIELDS.includes(k)) && validateLine(o).ok;
    } catch {
      return false;
    }
  });
  outputs.push({ label: `ledger:${id}:units.jsonl`, buf: Buffer.from(`${writerMade.join('\n')}\n`, 'utf8') });
  // Hostile lines, derived from the first legitimate line so each differs from a valid one in exactly one respect.
  const first = JSON.parse(writerMade[0]);
  const hostile = [
    { ...first, owner_email: PLANTS.email },
    { ...first, session_id: `/srv/${PLANTS.osUser}/session` },
    { ...first, branch: `feature/${PLANTS.prompt}` },
    { ...first, unit_key: `${first.unit_key}-${PLANTS.command}` },
  ];
  appendFileSync(ledgerPath(home), hostile.map((l) => `${JSON.stringify(l)}\n`).join(''));
  for (const args of [['ingest'], ['units', '--json'], ['doctor']]) {
    const r = runCli(args, { home, env });
    const tag = args.join(' ');
    commands.push({ args, status: r.status });
    outputs.push({ label: `output:${id}:${tag}:stdout`, buf: Buffer.from(r.stdout, 'utf8') });
    outputs.push({ label: `output:${id}:${tag}:stderr`, buf: Buffer.from(r.stderr, 'utf8') });
  }
  return { commands, outputs };
}
