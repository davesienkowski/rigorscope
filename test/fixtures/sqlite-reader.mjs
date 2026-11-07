// Child-process reader for the SQLite-tool test (plan 01-08). A helper, not a test. It imports only src/db.mjs
// and opens both databases through the repo's read-only openers.
//   node sqlite-reader.mjs HOME snapshot          -> one JSON line
//   node sqlite-reader.mjs HOME hold SIGNAL_FILE  -> a ready line, then (once SIGNAL_FILE exists) a second JSON line
import { existsSync } from 'node:fs';
import { openDerivedReadOnly, openStoreReadOnly } from '../../src/db.mjs';

const [, , home, mode, signal] = process.argv;

function describeDb(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const counts = {};
  for (const t of tables) counts[t] = db.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n;
  const strict = Object.fromEntries(db.prepare("PRAGMA table_list").all().filter((r) => r.schema === 'main' && !r.name.startsWith('sqlite_')).map((r) => [r.name, r.strict]));
  return {
    tables, counts, strict, userVersion: db.prepare('PRAGMA user_version').get().user_version,
    integrity: db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check),
  };
}

const snapshot = () => {
  const store = openStoreReadOnly({ home });
  const derived = openDerivedReadOnly({ home });
  try {
    return { sqlite: process.versions.sqlite, store: describeDb(store), derived: describeDb(derived) };
  } finally {
    store.close();
    derived.close();
  }
};

if (mode === 'snapshot') {
  process.stdout.write(`${JSON.stringify(snapshot())}\n`);
} else if (mode === 'hold') {
  const derived = openDerivedReadOnly({ home });
  derived.exec('BEGIN');
  const first = derived.prepare('SELECT count(*) AS n FROM api_call').get().n;
  process.stdout.write(`${JSON.stringify({ ready: true, first })}\n`);
  while (!existsSync(signal)) await new Promise((r) => setTimeout(r, 25));
  const second = derived.prepare('SELECT count(*) AS n FROM api_call').get().n;
  derived.exec('COMMIT');
  derived.close();
  process.stdout.write(`${JSON.stringify({ first, second })}\n`);
} else {
  process.stderr.write('unknown mode\n');
  process.exit(2);
}
