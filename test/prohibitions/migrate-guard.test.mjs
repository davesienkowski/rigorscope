// Prohibition (plan 02-01, UNIT-05, D-23 Q9, ADR-0008): openStore MUST NOT apply a pending migration to an existing
// store (user_version 1 to latest-1) without the `migrate` option. It throws StoreMigrationPendingError before any
// write, and the store keeps its user_version and its main-file bytes.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a module exporting openStore, resolved against process.cwd(); unset
// means src/db.mjs. test/prohibitions/fixtures/migrate-guard-violation.mjs (an openStore that forces the opt-in on
// every open, the "any caller opts in silently" violation) must fail this test;
// test/prohibitions/fixtures/migrate-guard-clean.mjs (re-exports the real module) must pass it.
//
// The pending store is built with the real src/db.mjs on a fresh temporary HOME through the `migrations` seam (a
// sliced list, applied from user_version 0), and the latest version is computed from the migration files.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadMigrations, openStore, storePath } from '../../src/db.mjs';
import { makeHome, queryDb, sha256File } from '../fixtures/build.mjs';

const DEFAULT_SUBJECT = fileURLToPath(new URL('../../src/db.mjs', import.meta.url));
const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : DEFAULT_SUBJECT;
const MIGRATIONS = fileURLToPath(new URL('../../src/store/migrations/', import.meta.url));

it('openStore without the migrate option refuses a store with a pending migration and changes nothing', async () => {
  const ctx = makeHome();
  try {
    const all = await loadMigrations(MIGRATIONS);
    const latest = all[all.length - 1].version;
    openStore({ home: ctx.home, migrations: all.slice(0, latest - 1) }).close();
    const file = storePath(ctx.home);
    const sha = sha256File(file);
    const mod = await import(pathToFileURL(subject).href);
    let caught = null;
    try {
      mod.openStore({ home: ctx.home }).close();
    } catch (err) {
      caught = err;
    }
    assert.equal(caught?.name, 'StoreMigrationPendingError', 'the pending store was opened without a refusal');
    assert.equal(queryDb(file, 'PRAGMA user_version')[0].user_version, latest - 1, 'user_version changed');
    assert.equal(sha256File(file), sha, 'main-file bytes changed');
  } finally {
    ctx.cleanup();
  }
});
