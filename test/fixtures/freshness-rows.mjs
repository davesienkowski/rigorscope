// Seeds ingest runs, source roots and source files straight into a writable store.db for the freshness tests
// (plan 01-08). A helper, not a test: it imports nothing from src/derive or src/report. Every column is bound
// explicitly (NULL when absent), so a new column cannot silently change what a test seeds.
const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);

function insertAll(db, table, row) {
  const cols = columnsOf(db, table);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return db.prepare(sql).run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
}

// spec: { runs: [{ ended, status = 'ok', sources: ['transcript', ...], newest = null }],
//         files: [{ source, alias, rel, last }] }
export function seedFreshness(db, spec) {
  for (const run of spec.runs ?? []) {
    const started = run.started ?? run.ended;
    const r = insertAll(db, 'ingest_run', {
      started_utc: started, ended_utc: run.ended, trigger: 'test', status: run.status ?? 'ok',
    });
    const runId = Number(r.lastInsertRowid);
    for (const source of run.sources ?? []) {
      insertAll(db, 'ingest_source_run', { run_id: runId, source, newest_record_utc: run.newest ?? null });
    }
  }
  for (const f of spec.files ?? []) {
    let root = db.prepare('SELECT root_id FROM source_root WHERE source = ? AND alias = ?').get(f.source, f.alias);
    if (!root) {
      insertAll(db, 'source_root', { source: f.source, alias: f.alias, kind: f.alias, display: `~/.${f.alias}` });
      root = db.prepare('SELECT root_id FROM source_root WHERE source = ? AND alias = ?').get(f.source, f.alias);
    }
    insertAll(db, 'source_file', {
      root_id: root.root_id, rel_path: f.rel, kind: 'session', offset: 0, last_record_utc: f.last ?? null,
    });
  }
}
