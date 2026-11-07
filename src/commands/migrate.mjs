// rigorscope migrate [--apply]: show the pending store migrations (a dry run, the default), or, with --apply, take
// the ingest lock, back the store up with the same code as scripts/backup-store.mjs (label pre-migrate), verify that
// backup against its manifest and only then apply them (plan 02-01, D-23 Q9, ADR-0008). Every other command refuses
// an existing store with a pending migration. The logic lives in src/store/migrate.mjs.
import { migrateStore } from '../store/migrate.mjs';

export const description = 'Apply pending store migrations after taking and verifying a backup (a dry run unless --apply)';
export const options = { apply: { type: 'boolean' } };

export async function run(args, ctx) {
  const res = await migrateStore({
    home: ctx.home, now: ctx.now, apply: args.apply === true, out: (line) => ctx.stdout.write(`${line}\n`),
  });
  return res.exitCode;
}
