// Known-bad subject for test/prohibitions/migrate-guard.test.mjs: everything from src/db.mjs except openStore, which
// forces the opt-in on every open (the "any caller opts in silently" violation), so a pending migration is applied to
// an existing store with no backup. test/prohibitions/migrate-guard.test.mjs must fail on it.
import { openStore as realOpenStore } from '../../../src/db.mjs';

export * from '../../../src/db.mjs';

export function openStore(options) {
  return realOpenStore({ ...options, migrate: true });
}
