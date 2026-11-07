// loadFreshness (plan 01-08, TRUST-05, D-14): the per-source freshness verdict from store.db, read-only.
//
// For every registered source (registry order): its live flag and limit from the descriptor, the newest record and
// the last ok ingest run. The newest record is the maximum of source_file.last_record_utc over the roots in scope
// (ROOT_SCOPE: the OTel source counts only the root with alias live, so a fresher preserve copy never hides a stale
// live directory), compared by unixepoch(..., 'subsec'). A source with no source_file rows at all (the cursorless
// usage source) falls back to the maximum ingest_source_run.newest_record_utc. The last run is the latest ended_utc of
// a run with status ok that has an ingest_source_run row for the source. A missing store.db gives verdict none and is
// never created. Every query has fixed text; the alias list is built from the constant, never from input.
import { existsSync } from 'node:fs';
import { openStoreReadOnly, storePath } from '../db.mjs';
import { loadSources } from '../ingest/sources.mjs';
import { evaluateFreshness } from '../measure/freshness.mjs';

const REGISTRY = await loadSources();

// Source name -> the root aliases whose files count. A source not named here counts all its roots.
export const ROOT_SCOPE = Object.freeze({ otel: Object.freeze(['live']) });

const HAS_FILES_SQL = `
SELECT 1 AS present FROM source_file f JOIN source_root r ON r.root_id = f.root_id WHERE r.source = ? LIMIT 1`;
const FALLBACK_SQL = `
SELECT newest_record_utc AS t FROM ingest_source_run
 WHERE source = ? AND newest_record_utc IS NOT NULL
 ORDER BY unixepoch(newest_record_utc, 'subsec') DESC LIMIT 1`;
const RUN_SQL = `
SELECT r.ended_utc AS t FROM ingest_run r JOIN ingest_source_run sr ON sr.run_id = r.run_id
 WHERE sr.source = ? AND r.status = 'ok' AND r.ended_utc IS NOT NULL
 ORDER BY unixepoch(r.ended_utc, 'subsec') DESC LIMIT 1`;

function newestSql(aliases) {
  const scope = aliases ? ` AND r.alias IN (${aliases.map(() => '?').join(', ')})` : '';
  return `
SELECT f.last_record_utc AS t FROM source_file f JOIN source_root r ON r.root_id = f.root_id
 WHERE r.source = ? AND f.last_record_utc IS NOT NULL${scope}
 ORDER BY unixepoch(f.last_record_utc, 'subsec') DESC LIMIT 1`;
}

// -> the evaluateFreshness result ({ verdict, nowMs, sources }).
export function loadFreshness({ home, nowMs }) {
  const sources = REGISTRY.map((d) => ({
    name: d.name, live: d.freshness.live, staleAfterHours: d.freshness.staleAfterHours, newestRecordUtc: null, lastRunUtc: null,
  }));
  if (existsSync(storePath(home))) {
    const db = openStoreReadOnly({ home });
    try {
      for (const s of sources) {
        const aliases = Object.hasOwn(ROOT_SCOPE, s.name) ? ROOT_SCOPE[s.name] : null;
        const newest = db.prepare(newestSql(aliases)).get(s.name, ...(aliases ?? []));
        if (newest) s.newestRecordUtc = newest.t;
        else if (!db.prepare(HAS_FILES_SQL).get(s.name)) s.newestRecordUtc = db.prepare(FALLBACK_SQL).get(s.name)?.t ?? null;
        s.lastRunUtc = db.prepare(RUN_SQL).get(s.name)?.t ?? null;
      }
    } finally {
      db.close();
    }
  }
  return evaluateFreshness({ sources, nowMs });
}
