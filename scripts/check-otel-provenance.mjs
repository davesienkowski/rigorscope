#!/usr/bin/env node
// Read-only OTel provenance check for a rigorscope store (plan 01-14, DATA-03, RR-01, D-16).
//
// What it checks: for every OTel file the store has a cursor for (a source_file row of an `otel` root), the number of
// stored provenance rows (otel_metric_line) must equal the number of metric records that the OTel source's own
// normalize yields from that file's complete lines up to the stored cursor offset. Provenance holds one row per metric
// line of the last full pass of a file, so the two counts agree on a healthy store.
//
// Why the store alone cannot tell: a stale provenance row of an earlier, longer layout of a file (before plan 01-12, a
// reread left them behind) looks exactly like a live row. Only the file itself says which line ends exist now.
//
// How: the files are found through the OTel descriptor's own discover (HOME and the existing environment overrides,
// such as HOOK_TELEMETRY_DIR), read with its own read and counted with its own normalize; there is no parser here.
// Store rows are matched to files by root alias and relative name (the store holds no absolute path). A file the store
// knows but discovery no longer finds is counted as missing and is not compared.
//
// Guarantees: the store is opened read-only (openStoreReadOnly; never openStore, which would migrate), no lock is taken
// and nothing is written. A read-only connection to a WAL store may leave empty -wal and -shm files beside it, which
// the next ingest adopts. Output is per-root counts only: no path, file name or value.
//
// Output: one line per root alias in sorted order, then a total line:
//   <alias>: compared N equal N differing N missing N
//   total: compared N equal N differing N missing N
// Exit 0 when no file differs (also when there is no store), 1 when a file differs or the store cannot be opened,
// 2 on a usage error.
import os from 'node:os';
import { lstatSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runPreflight } from '../src/preflight.mjs';

const USAGE = 'usage: node scripts/check-otel-provenance.mjs [--home DIR]';
const SOURCE = 'otel';
const METRIC_KIND = 'metric';

class UsageError extends Error {}

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);
const noop = () => {};

function parse(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { home: { type: 'string' } }, strict: true, allowPositionals: false }));
  } catch {
    throw new UsageError('unknown option or argument');
  }
  if (values.home !== undefined && values.home === '') throw new UsageError('--home needs a directory');
  return values;
}

const isFile = (p) => {
  try { return lstatSync(p).isFile(); } catch { return false; }
};

// Counts the metric records the descriptor's normalize yields from the complete lines that end at or before offset.
function normalizedMetricCount(src, unit, offset, ctx) {
  let n = 0;
  for (const item of src.read(unit, 0)) {
    if (item.end > offset) break;
    const res = src.normalize(item, unit, ctx);
    for (const rec of res?.records ?? []) if (rec.kind === METRIC_KIND) n += 1;
  }
  return n;
}

async function main(argv) {
  let values;
  try {
    values = parse(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`check-otel-provenance: ${e.message}`);
    err(USAGE);
    return 2;
  }
  const home = values.home ?? process.env.HOME ?? os.homedir();
  const env = process.env;
  const db = await import('../src/db.mjs');
  if (!isFile(db.storePath(home))) {
    out('check-otel-provenance: no store, nothing to check');
    return 0;
  }

  const { loadSources } = await import('../src/ingest/sources.mjs');
  const src = (await loadSources()).find((s) => s.name === SOURCE);
  if (!src) {
    err('check-otel-provenance: the otel source is not available');
    return 1;
  }
  // The context the runner gives normalize, with every tally a no-op: this run records nothing.
  const ctx = { home, env, windowsUsersDir: undefined, now: undefined, options: {}, tally: noop, attr: noop };

  let store;
  try {
    store = db.openStoreReadOnly({ home });
  } catch (e) {
    err(e?.name === 'StateDirError'
      ? 'check-otel-provenance: the state directory is a symlink or not a directory'
      : `check-otel-provenance: cannot open the store (${e?.errstr ?? e?.code ?? 'error'})`);
    return 1;
  }
  const byRoot = new Map();
  const tally = (alias, field) => {
    const t = byRoot.get(alias) ?? { compared: 0, equal: 0, differing: 0, missing: 0 };
    t[field] += 1;
    byRoot.set(alias, t);
  };
  try {
    const rows = store.prepare(
      `SELECT f.file_id AS file_id, r.alias AS alias, f.rel_path AS rel, f.offset AS offset
         FROM source_file f JOIN source_root r ON r.root_id = f.root_id
        WHERE r.source = ? ORDER BY r.alias, f.rel_path`,
    ).all(SOURCE);
    const stored = store.prepare('SELECT count(*) AS n FROM otel_metric_line WHERE file_id = ?');
    const units = new Map();
    for (const u of src.discover(ctx).units) units.set(`${u.rootAlias}\u0000${u.rel}`, u);
    for (const row of rows) {
      const unit = units.get(`${row.alias}\u0000${row.rel}`);
      if (!unit || !isFile(unit.abs)) { tally(row.alias, 'missing'); continue; }
      let expected;
      try {
        expected = normalizedMetricCount(src, unit, row.offset, ctx);
      } catch (e) {
        if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') { tally(row.alias, 'missing'); continue; }
        throw e;
      }
      tally(row.alias, 'compared');
      tally(row.alias, stored.get(row.file_id).n === expected ? 'equal' : 'differing');
    }
  } finally {
    store.close();
  }

  const total = { compared: 0, equal: 0, differing: 0, missing: 0 };
  for (const alias of [...byRoot.keys()].sort()) {
    const t = byRoot.get(alias);
    for (const k of Object.keys(total)) total[k] += t[k];
    out(`${alias}: compared ${t.compared} equal ${t.equal} differing ${t.differing} missing ${t.missing}`);
  }
  out(`total: compared ${total.compared} equal ${total.equal} differing ${total.differing} missing ${total.missing}`);
  return total.differing > 0 ? 1 : 0;
}

const pre = runPreflight();
if (!pre.ok) {
  err(pre.msg);
  process.exitCode = pre.exit;
} else {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    err(`check-otel-provenance: failed (${e?.errstr ?? e?.code ?? e?.name ?? 'error'})`);
    process.exitCode = 1;
  }
}
