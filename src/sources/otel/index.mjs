// The OTel source descriptor (see src/ingest/sources.mjs for the contract). Two directories of
// receiver files are read: the live one and rigorscope's own preserve copy (D-03); their records
// dedupe on the natural keys, so a backed-up copy never double counts. The runner holds no OTel code.
//
// Counter mapping onto the per-source columns of ingest_source_run (documented in docs/cli.md):
//   assistant_parsed  records recognized as events or metrics (printed as "assistant=")
//   kept              records normalized into a row
//   rows_upserted     rows newly inserted (duplicates = kept minus rows_upserted)
//   unknown_token_bearing  unknown kinds carrying a token key, unknown metric names containing token or cost
//   deferred_token_bearing 0 (OTel has no deferred kinds)
// A key collision with different content is counted as dropped / key_conflict through the record's
// onConflict hook, because the runner hands the writer only the record and the file id.
import { readLinesFrom } from '../../ingest/lines.mjs';
import { MAX_UNKNOWN_NAMES } from '../transcript/normalize.mjs';
import { discoverOtelRoots, listOtelFiles } from './dirs.mjs';
import { normalizeOtelLine } from './normalize.mjs';
import { createWriter } from './write.mjs';

export const name = 'otel';
export const freshness = { live: true, staleAfterHours: 36 };
export const MAX_OTEL_LINE_BYTES = 1048576;
export { createWriter };

export function discover(ctx) {
  const found = discoverOtelRoots({ home: ctx.home, env: ctx.env });
  const units = [];
  for (const root of found.roots) {
    const { files, skipped } = listOtelFiles(root.path);
    for (const f of files) {
      units.push({ rootAlias: root.alias, rel: f.name, abs: f.abs, kind: f.name.startsWith('events-') ? 'events' : 'metrics' });
    }
    for (const [reason, n] of Object.entries(skipped)) ctx.tally('walk_skip', reason, n);
  }
  return { roots: found.roots.map(({ alias, display, kind }) => ({ alias, display, kind })), units };
}

// The runner passes its own (larger) default line cap; the OTel cap is the smaller of the two.
export function read(unit, start, opts = {}) {
  return readLinesFrom(unit.abs, start, { ...opts, maxLineBytes: Math.min(opts.maxLineBytes ?? MAX_OTEL_LINE_BYTES, MAX_OTEL_LINE_BYTES) });
}

// At most MAX_UNKNOWN_NAMES distinct names per scope and run; the rest fall into the question-mark bucket.
const seenNames = new WeakMap();
function cappedName(ctx, scope, name) {
  if (name === '?') return name;
  let byScope = seenNames.get(ctx);
  if (!byScope) { byScope = new Map(); seenNames.set(ctx, byScope); }
  let set = byScope.get(scope);
  if (!set) { set = new Set(); byScope.set(scope, set); }
  if (set.has(name)) return name;
  if (set.size >= MAX_UNKNOWN_NAMES) return '?';
  set.add(name);
  return name;
}

export function normalize(item, unit, ctx) {
  if (item.oversized) {
    ctx.tally('counter', 'oversized');
    ctx.tally('oversized', unit.kind);
    return { records: [] };
  }
  const fn = ctx.options.otelNormalize ?? normalizeOtelLine;
  const res = fn(item.buf.toString('utf8'), unit, ctx);
  switch (res.type) {
    case 'skip':
      return { records: [] };
    case 'unparseable':
      ctx.tally('counter', 'candidates');
      ctx.tally('counter', 'unparseable');
      return { records: [] };
    case 'drop':
      ctx.tally('counter', 'candidates');
      if (res.reason !== 'record_type') ctx.tally('counter', 'assistant_parsed');
      ctx.tally('dropped', res.reason);
      return { records: [] };
    default:
  }
  ctx.tally('counter', 'candidates');
  ctx.tally('counter', 'assistant_parsed');
  for (const r of res.rejected ?? []) ctx.tally('rejected_field', r);
  for (const u of res.unknown ?? []) ctx.attr(u.scope, cappedName(ctx, u.scope, u.name));
  if (res.unknownToken) {
    ctx.tally('counter', 'unknown_token_bearing');
    ctx.tally('unknown_token', res.unknownToken);
  }
  ctx.tally('counter', 'kept');
  const record = { kind: res.type, row: res.row, end: item.end, onConflict: () => ctx.tally('dropped', 'key_conflict') };
  return { records: [record], ts: res.recordTs ?? undefined };
}
