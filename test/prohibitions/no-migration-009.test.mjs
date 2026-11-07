// Phase-scoped pin (plan 03.1-01, D-18, checker W6): phase 03.1 adds no store migration. The directory src/store/migrations/
// holds exactly migrations 001 to 008 and a fresh store's schema version is that of the last of them.
//
// RETIREMENT RULE: this file is removable. The first plan of a LATER phase that adds a migration deletes this file in its
// own first task and records that in its plan (REQUIREMENTS.md makes opt-in migrations the normal route), so the pin never
// turns a later phase's legitimate migration red for an unrelated reason.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LATEST_STORE_VERSION, loadMigrations } from '../../src/db.mjs';

const DIR = fileURLToPath(new URL('../../src/store/migrations/', import.meta.url));
const AT_PHASE_03_1 = Object.freeze([
  '001-init.mjs', '002-transcript.mjs', '003-otel.mjs', '004-usage.mjs', '005-otel-provenance-reread.mjs',
  '006-server-tool-use-flag.mjs', '007-reconstructed-units.mjs', '008-ledger-line.mjs',
]);

describe('phase 03.1 adds no store migration', () => {
  it('the migrations directory holds exactly the files present at phase 03.1', () => {
    const present = readdirSync(DIR).sort();
    assert.deepEqual(present, [...AT_PHASE_03_1],
      'phase 03.1 adds no store migration (D-18); if a later phase adds one, it deletes this pin in its first task and says so in its plan');
  });

  it('a fresh store schema version is the number of the last of those migrations', async () => {
    const migrations = await loadMigrations(DIR);
    assert.equal(migrations.length, AT_PHASE_03_1.length);
    const last = migrations[migrations.length - 1].version;
    assert.equal(last, Number(AT_PHASE_03_1[AT_PHASE_03_1.length - 1].slice(0, 3)));
    assert.equal(LATEST_STORE_VERSION, last, 'phase 03.1 adds no store migration');
  });
});
