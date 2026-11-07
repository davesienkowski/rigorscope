// Known-bad subject for test/prohibitions/migrate-backup-first.test.mjs: it applies the pending migrations through
// src/db.mjs's openStore with the opt-in first and only then runs the real migrate path (apply before backup, the
// wrong order), so a migration lands with no verified backup. The prohibition test must fail on it.
import { openStore } from '../../../src/db.mjs';
import { migrateStore as realMigrateStore } from '../../../src/store/migrate.mjs';

export async function migrateStore(options) {
  const { home, migrations } = options;
  openStore({ home, ...(migrations ? { migrations } : {}), migrate: true }).close();
  return realMigrateStore(options);
}
