// The source-agnostic ingest runner (D-04, D-12, D-13, RR-08). It knows descriptors (see
// src/ingest/sources.mjs) and nothing about any particular source. Per run:
//   lock -> ingest_run row -> for each source: discover, order, then per unit decide the start offset
//   from the stored cursor, read items, normalize them, and write the rows of each chunk in ONE
//   transaction together with the cursor update. A failed chunk rolls back, leaves the earlier chunks
//   and their cursors committed, marks the run failed and releases the lock.
//   After the last source the run ends with the unit post-step (plan 02-02, src/units/ingest-step.mjs): repo
//   resolution of new session directories, then the quick units of every known repo, inside the same lock and before
//   the run row is closed. It is not a source, so the source list and the first output line do not change; its counts
//   become summary.units. The ingest environment (o.env) is passed to it for the configured repo roots (plan 02-05).
//   Plan 02-04: just before the unit post-step (after its checkpoint, with no new yield point) the run takes one
//   environment snapshot (src/env/snapshot.mjs, D-16) inside the lock and writes one env_snapshot row keyed by its run
//   id; the printed values become summary.env.
//
// Options: { home, root, roots, env, windowsUsersDir, sources, sourcesDir, normalize, now, trigger,
//   lock, maxLineBytes, chunkBytes, chunkLines, beforeCommit, order, stop }. The 01-01 call shape
//   { home, root, normalize, now } still works: `root` is a single explicit root.
//
// Interrupts (plan 01-11, WR-01): the lock is held in `flag` mode, so SIGTERM or SIGINT only records the
// signal. The runner yields to the event loop (setImmediate) after every committed chunk, after each
// cursorless unit's commit and before each unit, and throws InterruptError there when a signal is pending;
// no transaction is open at any of these points, so every committed chunk is whole and the next run
// resumes from the cursors. A signal that arrives after the last yield point lets the run finish. `stop`
// (a function returning a signal name or null) is a test seam used only with lock: false.
//
// The summary returned is a superset of the 01-01 one: { files, candidates, assistant, kept,
// unparseable, rejected } plus run id, roots, status and per-source details. A held lock returns
// { skipped: 'lock_held', holder } without touching the store.
import { statSync } from 'node:fs';
import { openStore } from '../db.mjs';
import { HASH_WINDOW, decideStart, statIdentity, windowHash } from './cursor.mjs';
import { MAX_LINE_BYTES } from './lines.mjs';
import { InterruptError, withLock } from './lock.mjs';
import { SOURCES_DIR, loadSources } from './sources.mjs';
import { runUnitSteps } from '../units/ingest-step.mjs';
import { takeSnapshot, writeSnapshot } from '../env/snapshot.mjs';

const CHUNK_LINES = 20000;
const compareBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const REREAD = new Set(['truncated', 'replaced', 'rewritten']);
const VANISHED = new Set(['ENOENT', 'ENOTDIR']);
const UNREADABLE = new Set(['EACCES', 'EPERM']);
const COUNTERS = [
  'candidates', 'assistant_parsed', 'kept', 'unparseable', 'oversized', 'unknown_token_bearing', 'deferred_token_bearing',
];

const isDirectory = (p) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

function newTallies() {
  return { counters: Object.fromEntries(COUNTERS.map((c) => [c, 0])), counts: new Map(), attrs: new Map() };
}

function makeCtx({ base, tallies }) {
  return {
    ...base,
    tally(kind, name, n = 1) {
      if (kind === 'counter') { tallies.counters[name] = (tallies.counters[name] ?? 0) + n; return; }
      const byName = tallies.counts.get(kind) ?? new Map();
      byName.set(name, (byName.get(name) ?? 0) + n);
      tallies.counts.set(kind, byName);
    },
    attr(scope, name, n = 1) {
      const key = `${scope}\u0000${name}`;
      tallies.attrs.set(key, (tallies.attrs.get(key) ?? 0) + n);
    },
  };
}

const sumOf = (tallies, kind) => [...(tallies.counts.get(kind)?.values() ?? [])].reduce((a, b) => a + b, 0);
const objectOf = (tallies, kind) => Object.fromEntries([...(tallies.counts.get(kind) ?? new Map())].sort(([a], [b]) => compareBytes(a, b)));

function orderUnits(units, rootIndex, order) {
  // A cursorless source may have no roots: an unknown alias sorts first.
  const at = (alias) => rootIndex.get(alias) ?? -1;
  const out = [...units].sort((a, b) => (at(a.rootAlias) - at(b.rootAlias)) || compareBytes(a.rel, b.rel));
  if (order === 'reverse') out.reverse();
  else if (typeof order === 'function') return order(out);
  return out;
}

export async function runIngest(options = {}) {
  const {
    home, root, roots, env = {}, windowsUsersDir = '', now = () => new Date(), trigger = 'manual',
    maxLineBytes = MAX_LINE_BYTES, chunkBytes, chunkLines = CHUNK_LINES, beforeCommit, order,
  } = options;
  const explicit = roots ?? (root ? [root] : undefined);
  for (const p of explicit ?? []) if (!isDirectory(p)) throw new Error('ingest root is not a directory');
  const sources = options.sources ?? await loadSources({ dir: options.sourcesDir ?? SOURCES_DIR });
  // The lock is taken without waiting (a held lock skips the run), so the wait recorded is 0.
  const body = (stop) => execute({ ...options, explicit, sources, env, windowsUsersDir, now, trigger, maxLineBytes, chunkBytes, chunkLines, beforeCommit, order, stop, lockWaitMs: 0 }, home);
  if (options.lock === false) return body(typeof options.stop === 'function' ? options.stop : () => null);
  const res = await withLock({ home, now }, (handle) => body(() => handle.stopSignal ?? null), { onSignal: 'flag' });
  if (!res.acquired) return { skipped: 'lock_held', holder: res.holder };
  return res.value;
}

async function execute(o, home) {
  const db = openStore({ home });
  let runId = null;
  try {
    runId = db.prepare('INSERT INTO ingest_run (started_utc, trigger, status) VALUES (?, ?, ?)')
      .run(o.now().toISOString(), o.trigger, 'running').lastInsertRowid;
    const summary = {
      runId: Number(runId), status: 'ok', roots: 0, files: 0, candidates: 0, assistant: 0, kept: 0, unparseable: 0,
      rejected: {}, unknownTokenBearing: 0, sources: {},
    };
    let chunkCounter = 0;
    for (const src of o.sources) {
      const per = await runSource({ db, src, o, home, runId: Number(runId), nextChunk: () => { chunkCounter += 1; return chunkCounter; } });
      summary.sources[src.name] = per;
      summary.roots += per.roots;
      summary.files += per.files;
      summary.candidates += per.candidates;
      summary.assistant += per.assistant;
      summary.kept += per.kept;
      summary.unparseable += per.unparseable;
      summary.unknownTokenBearing += per.unknown_token_bearing;
      for (const [k, n] of Object.entries(per.rejected)) summary.rejected[k] = (summary.rejected[k] ?? 0) + n;
    }
    await checkpoint(o);
    const snap = takeSnapshot({ home, env: o.env, now: o.now });
    writeSnapshot({ db, runId: Number(runId), row: snap.row });
    summary.env = snap.line;
    summary.units = await runUnitSteps({
      db, home, runId: Number(runId), checkpoint: () => checkpoint(o), env: o.env ?? {},
    });
    db.prepare(
      `UPDATE ingest_run SET ended_utc = ?, files = ?, lines_read = ?, assistant_lines = ?, rows_upserted = ?, unparseable = ?,
         status = 'ok', roots = ?, unknown_token_bearing = ?, lock_wait_ms = ? WHERE run_id = ?`,
    ).run(o.now().toISOString(), summary.files, summary.candidates, summary.assistant, summary.kept, summary.unparseable,
      summary.roots, summary.unknownTokenBearing, o.lockWaitMs, runId);
    return summary;
  } catch (err) {
    if (runId !== null) {
      const code = typeof err?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(err.code) ? err.code : (err?.name ?? 'Error');
      try {
        db.prepare("UPDATE ingest_run SET ended_utc = ?, status = 'failed', error_code = ? WHERE run_id = ?")
          .run(o.now().toISOString(), String(code).slice(0, 40), runId);
      } catch { /* the original error matters more */ }
    }
    throw err;
  } finally {
    db.close();
  }
}

const begin = (db) => db.exec('BEGIN IMMEDIATE');

// The only interrupt point: called with no transaction open. Yielding lets a pending signal listener run.
async function checkpoint(o) {
  await new Promise((resolve) => { setImmediate(resolve); });
  const signal = o.stop?.() ?? null;
  if (signal) throw new InterruptError(signal);
}
function rollback(db) {
  try { db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
}

// A cursorless unit (plan 01-06): no stat, no cursor row, no window hash; read from offset 0 every run and
// written in one transaction (fileId null), with the same beforeCommit hook as a cursor chunk.
async function readCursorless({ db, src, o, ctx, unit, writer, runId, stat, nextChunk }) {
  const records = [];
  let opened = false;
  let lastEnd = 0;
  for await (const item of src.read(unit, 0, { maxLineBytes: o.maxLineBytes, chunkBytes: o.chunkBytes, stats: {} })) {
    stat.lines += 1;
    stat.bytes += item.end - lastEnd;
    lastEnd = item.end;
    if (item.opened !== false) opened = true;
    const res = src.normalize(item, unit, ctx);
    if (res?.records?.length) records.push(...res.records);
  }
  if (opened) stat.files += 1;
  let rows = 0;
  begin(db);
  try {
    for (const rec of records) rows += writer.write(rec, null, runId);
    if (o.beforeCommit) o.beforeCommit({ source: src.name, unit, chunk: nextChunk(), final: true });
    db.exec('COMMIT');
  } catch (err) {
    rollback(db);
    throw err;
  }
  stat.rows += rows;
  if (records.length > 0) {
    if (rows > 0) stat.new += 1;
    else stat.unchanged += 1;
  }
  await checkpoint(o);
}

async function runSource({ db, src, o, home, runId, nextChunk }) {
  const tallies = newTallies();
  const base = {
    home, env: o.env, windowsUsersDir: o.windowsUsersDir, homeSet: undefined, now: o.now,
    options: { ...o, roots: o.explicit },
  };
  const ctx = makeCtx({ base, tallies });
  const disc = await src.discover(ctx);

  // Roots.
  begin(db);
  const rootIds = new Map();
  try {
    const up = db.prepare(
      `INSERT INTO source_root (source, alias, kind, display, first_seen_run, last_seen_run) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, alias) DO UPDATE SET kind = excluded.kind, display = excluded.display, last_seen_run = excluded.last_seen_run
       RETURNING root_id`,
    );
    for (const r of disc.roots) rootIds.set(r.alias, up.get(src.name, r.alias, r.kind, r.display, runId, runId).root_id);
    db.exec('COMMIT');
  } catch (err) {
    rollback(db);
    throw err;
  }
  const rootIndex = new Map(disc.roots.map((r, i) => [r.alias, i]));
  const units = orderUnits(disc.units, rootIndex, o.order);
  const writer = src.createWriter(db);

  const selectFile = db.prepare('SELECT * FROM source_file WHERE root_id = ? AND rel_path = ?');
  const touch = db.prepare('UPDATE source_file SET last_seen_run = ? WHERE file_id = ?');
  const upsertFile = db.prepare(
    `INSERT INTO source_file (root_id, rel_path, kind, dev, ino, size, mtime_ms, offset, head_hash, tail_hash, state,
                              first_record_utc, last_record_utc, last_seen_run, last_read_run)
     VALUES ($root_id, $rel_path, $kind, $dev, $ino, $size, $mtime_ms, $offset, $head_hash, $tail_hash, $state,
             $first, $last, $run, $run)
     ON CONFLICT (root_id, rel_path) DO UPDATE SET kind = excluded.kind, dev = excluded.dev, ino = excluded.ino,
       size = excluded.size, mtime_ms = excluded.mtime_ms, offset = excluded.offset, head_hash = excluded.head_hash,
       tail_hash = excluded.tail_hash, state = excluded.state, first_record_utc = excluded.first_record_utc,
       last_record_utc = excluded.last_record_utc, last_seen_run = excluded.last_seen_run, last_read_run = excluded.last_read_run
     RETURNING file_id`,
  );

  const cursorless = src.cursorless === true;
  const stat = {
    files: cursorless ? 0 : units.length, new: 0, reread: 0, unchanged: 0, skipped: 0, bytes: 0, lines: 0, rows: 0, pending: 0,
  };

  for (const unit of units) {
    await checkpoint(o);
    if (cursorless) {
      await readCursorless({ db, src, o, ctx, unit, writer, runId, stat, nextChunk });
      continue;
    }
    let cur;
    try {
      cur = statIdentity(unit.abs);
    } catch (err) {
      if (VANISHED.has(err.code)) ctx.tally('walk_skip', 'vanished');
      else if (err.code === 'ERR_NOT_REGULAR') ctx.tally('walk_skip', 'not_regular');
      else throw err;
      continue;
    }
    // From here to the file's last commit a vanished or unreadable file (plan 01-11, WR-05) is counted and
    // skipped: its unflushed lines are dropped and the run goes on. A failing flush has already rolled back.
    // Every other error (SQLite, an interrupt) is rethrown unchanged.
    let pending = [];
    try {
      const rootId = rootIds.get(unit.rootAlias);
      const stored = selectFile.get(rootId, unit.rel) ?? null;
      const headOf = (off) => windowHash(unit.abs, 0, Math.min(off, HASH_WINDOW));
      const tailOf = (off) => windowHash(unit.abs, Math.max(0, off - HASH_WINDOW), off);
      let decision;
      if (unit.whole && stored) {
        const same = stored.dev === cur.dev && stored.ino === cur.ino && stored.size === cur.size
          && stored.mtime_ms === cur.mtimeMs && stored.state === 'ok';
        if (same && stored.head_hash === headOf(cur.size)) decision = { start: 0, reason: 'unchanged' };
        else decision = { start: 0, reason: stored.dev === cur.dev && stored.ino === cur.ino ? 'rewritten' : 'replaced' };
      } else {
        decision = decideStart(stored, cur, { head: () => headOf(stored.offset), tail: () => tailOf(stored.offset) });
      }

      if (decision.reason === 'unchanged') {
        stat.unchanged += 1;
        stat.pending += Math.max(0, stored.size - stored.offset);
        touch.run(runId, stored.file_id);
        continue;
      }

      let first = decision.start > 0 ? stored.first_record_utc : null;
      let last = decision.start > 0 ? stored.last_record_utc : null;
      let lastEnd = decision.start;
      let inChunk = 0;
      const readStats = {};
      // A reread (truncated, replaced or rewritten) tells the writer once, in its first transaction, before any
      // write, so a writer can drop rows that described the earlier pass (plan 01-12: OTel provenance).
      let rereadPending = REREAD.has(decision.reason) && typeof writer.onReread === 'function';

      const flush = (final) => {
        begin(db);
        try {
          const size = Math.max(cur.size, lastEnd);
          const fileId = upsertFile.get({
            root_id: rootId, rel_path: unit.rel, kind: unit.kind, dev: cur.dev, ino: cur.ino, size, mtime_ms: cur.mtimeMs,
            offset: lastEnd, head_hash: headOf(lastEnd), tail_hash: tailOf(lastEnd), state: final ? 'ok' : 'reading',
            first: first ?? null, last: last ?? null, run: runId,
          }).file_id;
          if (rereadPending) writer.onReread(fileId);
          for (const rec of pending) stat.rows += writer.write(rec, fileId, runId);
          if (o.beforeCommit) o.beforeCommit({ source: src.name, unit, chunk: nextChunk(), final });
          db.exec('COMMIT');
        } catch (err) {
          rollback(db);
          throw err;
        }
        rereadPending = false;
        pending = [];
        inChunk = 0;
      };

      for await (const item of src.read(unit, decision.start, {
        maxLineBytes: o.maxLineBytes, chunkBytes: o.chunkBytes, stats: readStats,
      })) {
        stat.lines += 1;
        stat.bytes += item.end - lastEnd;
        lastEnd = item.end;
        const res = src.normalize(item, unit, ctx);
        if (res?.records?.length) pending.push(...res.records);
        if (res?.ts) {
          if (first === null || res.ts < first) first = res.ts;
          if (last === null || res.ts > last) last = res.ts;
        }
        inChunk += 1;
        if (inChunk >= o.chunkLines) {
          flush(false);
          await checkpoint(o);
        }
      }
      flush(true);
      if (decision.reason === 'new') stat.new += 1;
      else if (REREAD.has(decision.reason)) { stat.reread += 1; ctx.tally('reread', decision.reason); }
      stat.pending += readStats.pendingTailBytes ?? 0;
      await checkpoint(o);
    } catch (err) {
      pending = [];
      if (VANISHED.has(err?.code)) ctx.tally('walk_skip', 'vanished');
      else if (UNREADABLE.has(err?.code)) ctx.tally('walk_skip', 'unreadable');
      else throw err;
    }
  }

  // Run log: progress row, name-keyed counts, unknown attribute names.
  const c = tallies.counters;
  const newest = db.prepare(
    `SELECT max(f.last_record_utc) AS t FROM source_file f JOIN source_root r ON r.root_id = f.root_id WHERE r.source = ?`,
  ).get(src.name).t ?? null;
  stat.skipped = sumOf(tallies, 'walk_skip');
  begin(db);
  try {
    db.prepare(
      `INSERT INTO ingest_source_run (run_id, source, files, files_new, files_reread, files_unchanged, files_skipped, bytes_read,
         lines_read, assistant_parsed, rows_upserted, unparseable, oversized, unknown_token_bearing, deferred_token_bearing,
         pending_tail_bytes, newest_record_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, src.name, stat.files, stat.new, stat.reread, stat.unchanged, stat.skipped, stat.bytes, stat.lines,
      c.assistant_parsed, stat.rows, c.unparseable, c.oversized, c.unknown_token_bearing, c.deferred_token_bearing, stat.pending, newest);
    const insCount = db.prepare('INSERT INTO ingest_count (run_id, source, kind, name, n) VALUES (?, ?, ?, ?, ?)');
    for (const [kind, byName] of tallies.counts) for (const [name, n] of byName) insCount.run(runId, src.name, kind, name, n);
    const insAttr = db.prepare(
      `INSERT INTO unknown_attr (source, scope, name, first_run_id, last_run_id, last_run_n) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, scope, name) DO UPDATE SET last_run_id = excluded.last_run_id, last_run_n = excluded.last_run_n`,
    );
    for (const [key, n] of tallies.attrs) {
      const [scope, name] = key.split('\u0000');
      insAttr.run(src.name, scope, name, runId, runId, n);
    }
    db.exec('COMMIT');
  } catch (err) {
    rollback(db);
    throw err;
  }

  const dropped = { session_id: 0, message_id: 0, usage: 0, ...objectOf(tallies, 'dropped') };
  return {
    roots: disc.roots.length,
    files: stat.files,
    new: stat.new,
    reread: stat.reread,
    unchanged: stat.unchanged,
    skipped: stat.skipped,
    bytes: stat.bytes,
    lines: stat.lines,
    candidates: c.candidates,
    assistant: c.assistant_parsed,
    kept: c.kept,
    unparseable: c.unparseable,
    oversized: c.oversized,
    unknown_token_bearing: c.unknown_token_bearing,
    deferred_token_bearing: c.deferred_token_bearing,
    pending_tail_bytes: stat.pending,
    dropped,
    rejected: objectOf(tallies, 'rejected_field'),
    skippedTypes: objectOf(tallies, 'skipped_type'),
    unknownTokens: objectOf(tallies, 'unknown_token'),
    newest_record_utc: newest,
  };
}
