// rigorscope schedule install [--apply] [--no-systemctl]
//
// Installs the two repo-tracked systemd user units (the daily ingest and its timer). A dry run by default: without
// --apply it creates and modifies nothing (not even the unit directory), spawns no systemctl, and prints what --apply
// would do. With --apply it writes the units (temp file then rename, mode 0644, a differing file saved as NAME.bak-STAMP),
// then runs `systemctl --user daemon-reload` and `systemctl --user enable --now rigorscope-ingest.timer`;
// --no-systemctl skips those two calls. It refuses, printing every reason and exiting 2 before writing anything, when the
// node on the unit PATH is missing, below the floor, lacks sqlite or is unreadable, when this checkout is not
// ~/repos/rigorscope, or when a destination is a symlink or not a regular file. Paths print home-normalized.
import { fileURLToPath } from 'node:url';
import { UsageError } from '../cli.mjs';
import { InstallError, applyInstall, planInstall } from '../schedule/install.mjs';
import { defaultRun } from '../schedule/systemctl.mjs';

export const description = 'Install the daily ingest timer as systemd user units (dry run unless --apply)';
export const options = { apply: { type: 'boolean' }, 'no-systemctl': { type: 'boolean' } };
export const positionals = { min: 1, max: 1, names: ['install'] };

const CHECKOUT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RELOAD = 'systemctl --user daemon-reload';
const ENABLE = 'systemctl --user enable --now rigorscope-ingest.timer';

function nodeLine(n) {
  switch (n.status) {
    case 'ok': return `node: ${n.display} ${n.version} floor=${n.floor} ok`;
    case 'not_found': return 'node: not found on the unit PATH';
    case 'below_floor': return `node: ${n.display} ${n.version} BELOW FLOOR ${n.floor}`;
    case 'no_sqlite': return `node: ${n.display} ${n.version} LACKS node:sqlite`;
    default: return `node: ${n.display ?? 'unknown'} unusable (unreadable version or could not be run)`;
  }
}

export async function run(args, ctx) {
  if (args.positionals[0] !== 'install') throw new UsageError('the only schedule action is install; run rigorscope schedule --help');
  const env = ctx.env ?? {};
  const noSystemctl = args['no-systemctl'] === true;
  const nowMs = ctx.now().getTime();
  const sysrun = (file, a) => defaultRun(file, a, { env });
  const plan = planInstall({ home: ctx.home, env, checkoutRoot: CHECKOUT_ROOT, run: sysrun, nowMs });

  const out = [args.apply ? 'schedule install: applying' : 'schedule install: dry run (nothing is written; add --apply to install)'];
  out.push(plan.checkout.ok ? `checkout: ok (${plan.checkout.display})` : `checkout: mismatch (the unit runs ${plan.checkout.display}, which is not this checkout)`);
  out.push(nodeLine(plan.node));
  out.push(`unit directory: ${plan.dirDisplay}`);
  for (const u of plan.units) {
    out.push(`${u.name}: ${u.status}`);
    if (u.status === 'new' || u.status === 'changed') for (const d of u.diff) if (d.op !== ' ') out.push(`${d.op} ${d.text}`);
  }
  if (plan.refusals.length > 0) {
    for (const r of plan.refusals) out.push(`REFUSED ${r.code}: ${r.hint}`);
    ctx.stdout.write(`${out.join('\n')}\n`);
    throw new UsageError('schedule install: refused, nothing was written');
  }
  const pending = plan.units.filter((u) => u.status === 'new' || u.status === 'changed').length;
  if (!args.apply) {
    out.push(noSystemctl
      ? `would write ${pending} file(s), then skip systemctl (--no-systemctl)`
      : `would write ${pending} file(s), then run: ${RELOAD}; ${ENABLE}`);
    ctx.stdout.write(`${out.join('\n')}\n`);
    return 0;
  }
  let res;
  try {
    res = applyInstall(plan, { run: sysrun, noSystemctl, nowMs });
  } catch (err) {
    if (!(err instanceof InstallError)) throw err;
    ctx.stdout.write(`${out.join('\n')}\n`);
    ctx.stderr.write(`schedule install: step failed: ${err.step} (exit ${err.code ?? 'n/a'})\n`);
    return 1;
  }
  out.push(`wrote ${res.written.length} file(s) (backups: ${res.backups.length})`);
  for (const s of res.steps) out.push(`${s.step}: ${s.status === 'ok' ? 'ok' : 'skipped (--no-systemctl)'}`);
  ctx.stdout.write(`${out.join('\n')}\n`);
  return 0;
}
