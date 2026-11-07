// rigorscope doctor [--json | --signals]
//
// Advisory (RR-01): it exits 0 whatever it finds; non-zero is for a usage error (2) or rigorscope's own failure (1).
// Read-only: store.db and derived.db are opened read-only after the same lazy derived rebuild that `cost` runs (so the
// join figures are never stale) and only when store.db already exists, so an empty HOME stays empty. It takes no lock
// and writes nothing outside HOME/.rigorscope. --signals prints the signal registry and reads no state.
import { lstatSync } from 'node:fs';
import { UsageError } from '../cli.mjs';
import { storePath } from '../db.mjs';
import { ensureDerived } from '../derive/ensure.mjs';
import { PriceTableError, loadPrices } from '../derive/price-table.mjs';
import { loadDoctor } from '../report/doctor.mjs';
import { renderDoctorJson, renderDoctorText, renderSignalsText } from '../report/render-doctor.mjs';
import { CONSUMERS, SIGNALS } from '../report/signals.mjs';
import { defaultRun } from '../schedule/systemctl.mjs';
import { windowsUsersDirFromEnv } from '../sources/transcript/roots.mjs';

export const description = 'Check that the data behind the reports is current and the daily ingest is installed and healthy (advisory)';
export const options = { json: { type: 'boolean' }, signals: { type: 'boolean' } };

const storeExists = (home) => {
  try { return lstatSync(storePath(home), { throwIfNoEntry: false }) !== undefined; } catch { return false; }
};

// The same price-table rule as `cost`, so a rebuild decision never differs between the two commands.
function pricesFor(env) {
  try {
    return loadPrices({ dir: env.RIGORSCOPE_PRICES_DIR });
  } catch (err) {
    if (!(err instanceof PriceTableError)) throw err;
    return null;
  }
}

export async function run(args, ctx) {
  if (args.json && args.signals) throw new UsageError('--json and --signals cannot be used together');
  if (args.signals) {
    ctx.stdout.write(renderSignalsText(SIGNALS, CONSUMERS));
    return 0;
  }
  const env = ctx.env ?? {};
  let derivedError = null;
  if (storeExists(ctx.home)) {
    try {
      ensureDerived({ home: ctx.home, now: ctx.now, prices: pricesFor(env) });
    } catch (err) {
      if (err?.name === 'StoreTooNewError' || err?.name === 'StateDirError') throw err;
      derivedError = typeof err?.code === 'string' ? err.code.replace(/[^A-Za-z0-9_]/g, '_') : (err?.name ?? 'Error');
    }
  }
  const report = await loadDoctor({
    home: ctx.home, env, nowMs: ctx.now().getTime(), windowsUsersDir: windowsUsersDirFromEnv(env),
    run: (file, a) => defaultRun(file, a, { env }), clockFixed: ctx.clockFixed === true, derivedError,
  });
  ctx.stdout.write(args.json ? renderDoctorJson(report) : renderDoctorText(report));
  return 0;
}
