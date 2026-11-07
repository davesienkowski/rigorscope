// Prohibition (plan 02-01, UNIT-05, D-23, D-14): the migrate path MUST NOT apply any migration unless a backup of the
// current store was taken and verified against its manifest first. When the copy no longer matches its manifest
// (one byte flipped through the afterBackup seam, after the backup and before the verify), nothing is applied: the
// store keeps its user_version and its main-file bytes.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a module exporting migrateStore, resolved against process.cwd(); unset
// means src/store/migrate.mjs. test/prohibitions/fixtures/migrate-backup-first-violation.mjs (applies the pending
// migrations first, then runs the real migrate path: apply before backup) must fail this test;
// test/prohibitions/fixtures/migrate-backup-first-clean.mjs (re-exports the real function) must pass it.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadMigrations, openStore, storePath } from '../../src/db.mjs';
import { makeHome, queryDb, sha256File } from '../fixtures/build.mjs';
import { FIXTURE_NOW } from '../fixtures/clock.mjs';

const DEFAULT_SUBJECT = fileURLToPath(new URL('../../src/store/migrate.mjs', import.meta.url));
const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : DEFAULT_SUBJECT;
const MIGRATIONS = fileURLToPath(new URL('../../src/store/migrations/', import.meta.url));

it('migrateStore applies nothing when the backup does not verify', async () => {
  const ctx = makeHome();
  try {
    const all = await loadMigrations(MIGRATIONS);
    const latest = all[all.length - 1].version;
    openStore({ home: ctx.home, migrations: all.slice(0, latest - 1) }).close();
    const file = storePath(ctx.home);
    const sha = sha256File(file);
    const { migrateStore } = await import(pathToFileURL(subject).href);
    const lines = [];
    const afterBackup = ({ dir }) => {
      const copy = join(dir, 'store.db');
      const buf = readFileSync(copy);
      buf[buf.length - 1] ^= 0xff;
      writeFileSync(copy, buf);
    };
    try {
      await migrateStore({
        home: ctx.home, now: () => new Date(Date.parse(FIXTURE_NOW)), apply: true, out: (l) => lines.push(l), afterBackup,
      });
    } catch {
      /* a throw is fine as long as nothing was applied; the store is checked below */
    }
    assert.equal(queryDb(file, 'PRAGMA user_version')[0].user_version, latest - 1, 'a migration was applied without a verified backup');
    assert.equal(sha256File(file), sha, 'main-file bytes changed without a verified backup');
  } finally {
    ctx.cleanup();
  }
});
