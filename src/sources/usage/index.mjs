// The usage source descriptor (plan 01-06, D-11a; see src/ingest/sources.mjs for the contract). One unit: the
// subscription-window cache in the main Claude Code config file of HOME, read whole on every run through
// readUsageCache. The source is cursorless: the runner keeps no cursor row, stat or window hash for it, because
// the generic cursor stores hashes of file bytes and the file holds the account id. The snapshot itself is
// deduplicated on its own fetchedAtMs by the writer.
//
// Counter mapping onto the per-source columns of ingest_source_run (documented in docs/cli.md):
//   files      1 when the file was opened, 0 otherwise
//   new        1 when a snapshot row was inserted (its fetchedAtMs was not stored yet)
//   unchanged  1 when the snapshot's fetchedAtMs was already stored
//   skipped    1 for any status other than ok (absent, not_regular, oversized, unreadable, unparseable,
//              no_cache, rejected); the status is also counted under dropped
//   bytes      the size read; rejected_field counts CACHE_PICK paths, never a key name of the file
// Test seams: ctx.options.usagePick replaces pickUsageCache, ctx.options.usageMaxBytes the size cap.
import { join } from 'node:path';
import {
  CACHE_DISPLAY, CACHE_FILE_NAME, MAX_CACHE_BYTES, pickUsageCache, readUsageCache,
} from './cache.mjs';
import { createUsageWriter } from './write.mjs';

export const name = 'usage';
// Not live: the snapshot age is shown by the cost header line (and by doctor), so the freshness header never
// reports this source STALE.
export const freshness = { live: false, staleAfterHours: 168 };
export const cursorless = true;
export const CACHE_SOURCE = 'claude-json-cache';

export function discover(ctx) {
  const o = ctx.options ?? {};
  const maxBytes = Number.isSafeInteger(o.usageMaxBytes) ? o.usageMaxBytes : MAX_CACHE_BYTES;
  const pick = typeof o.usagePick === 'function' ? o.usagePick : pickUsageCache;
  // The path lives only in this in-memory unit; nothing stores or prints it (rel is the fixed display text).
  const unit = {
    rootAlias: null, rel: CACHE_DISPLAY, kind: 'cache', abs: join(ctx.home, CACHE_FILE_NAME), home: ctx.home, maxBytes, pick,
  };
  return { roots: [], units: [unit] };
}

export function* read(unit) {
  const result = readUsageCache({ home: unit.home, maxBytes: unit.maxBytes, pick: unit.pick });
  yield { result, opened: result.opened, end: result.bytes };
}

export function normalize(item, unit, ctx) {
  const r = item.result;
  for (const x of r.rejected) ctx.tally('rejected_field', x.path, x.n);
  if (r.status !== 'ok' || r.snapshot === null) {
    ctx.tally('walk_skip', r.status);
    ctx.tally('dropped', r.status);
    return { records: [] };
  }
  return { records: [{ kind: 'usage_snapshot', source: CACHE_SOURCE, label: 'measured', snapshot: r.snapshot }] };
}

export function createWriter(db) {
  return createUsageWriter(db);
}
