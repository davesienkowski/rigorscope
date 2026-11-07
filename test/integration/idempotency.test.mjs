// Idempotency, ordering, rotation and interruption of the incremental ingest (DATA-03, DATA-04).
// A digest of the sorted natural keys and token columns (no autoincrement ids, no run ids) of every
// natural-key table must be unchanged by a re-ingest, a different file order, a different line
// order, an interruption followed by a clean run, and a rotation re-read.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, readdirSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  buildFixtureTree, cliEnv, makeHome, queryDb, runCli, runCliAsync, sha256, shuffleLines, stateDirOf, windowsUsersDirFor,
} from '../fixtures/build.mjs';
import { buildUnitsHome } from '../fixtures/units-home.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const STORE = (home) => join(stateDirOf(home), 'store.db');
const CASES = ['tracer-base', 'subagents', 'iterations', 'backup-root'];

function digest(home) {
  const q = (sql) => queryDb(STORE(home), sql);
  const tables = {
    cc_message: q(`SELECT session_id, agent_id, message_id, input_tokens, output_tokens, cache_read, cache_creation,
                          cache_5m, cache_1h, has_iterations, has_server_tool_use FROM cc_message ORDER BY 1, 2, 3`),
    cc_message_iter: q('SELECT * FROM cc_message_iter ORDER BY session_id, agent_id, message_id, iter_seq'),
    cc_message_file: q(`SELECT m.session_id, m.agent_id, m.message_id, r.alias, f.rel_path FROM cc_message_file m
                          JOIN source_file f ON f.file_id = m.file_id JOIN source_root r ON r.root_id = f.root_id ORDER BY 1, 2, 3, 4, 5`),
    cc_agent_meta: q(`SELECT session_id, agent_id, agent_type, spawn_depth, model, tool_use_id, parent_agent_id, is_fork,
                             workflow_phase, finished FROM cc_agent_meta ORDER BY 1, 2`),
    source_root: q('SELECT source, alias, kind, display FROM source_root ORDER BY alias'),
    source_file: q(`SELECT r.alias, f.rel_path, f.kind, f.state FROM source_file f
                      JOIN source_root r ON r.root_id = f.root_id ORDER BY 1, 2`),
    unknown_attr: q('SELECT source, scope, name FROM unknown_attr ORDER BY 1, 2, 3'),
    // Plan 02-02: the migration 007 tables of repos and units (natural keys and values; never run ids or mtimes).
    dir_repo: q('SELECT dir, repo_key, method, is_worktree FROM dir_repo ORDER BY 1'),
    repo: q('SELECT repo_key, repo_name FROM repo ORDER BY 1'),
    unit_obs: q('SELECT unit_key, dir_rel, id_date, id_offset_min FROM unit_obs ORDER BY 1'),
    unit_artifact: q('SELECT unit_key, rel_path, role, first_commit_ms, tier_letter, tier_place FROM unit_artifact ORDER BY 1, 2'),
    // Plan 02-05: the git facts and artifact times (values only; never run ids or the run's mtimes).
    unit_path: q('SELECT unit_key, rel_path, path_source FROM unit_path ORDER BY 1, 2'),
    unit_commit: q('SELECT unit_key, sha, author_ms, files, added, deleted, touches_code FROM unit_commit ORDER BY 1, 2'),
    unit_commit_file: q('SELECT * FROM unit_commit_file ORDER BY unit_key, sha, rel_path'),
    unit_module_dir: q('SELECT unit_key, module_dir, existed FROM unit_module_dir ORDER BY 1, 2'),
    unit_git_scan: q('SELECT unit_key, refs_sha, commits FROM unit_git_scan ORDER BY 1'),
    unit_artifact_time: q('SELECT * FROM unit_artifact_time ORDER BY unit_key, rel_path'),
    // Plan 02-04: the planning refs and command names (every column; natural keys only, no run ids).
    cc_message_ref: q('SELECT * FROM cc_message_ref ORDER BY session_id, agent_id, message_id, ref_dir, rel_path'),
    cc_command: q('SELECT * FROM cc_command ORDER BY session_id, agent_id, uuid'),
  };
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
  return { counts, digest: sha256(JSON.stringify(tables)) };
}

// Plan 02-04: env_snapshot is a run-log table (one row per run), never part of the natural-key digest.
const runLogCounts = (home) => Object.fromEntries(
  ['ingest_run', 'ingest_source_run', 'ingest_count', 'env_snapshot'].map((t) => [t, queryDb(STORE(home), `SELECT count(*) AS n FROM ${t}`)[0].n]),
);

async function fresh(cases = CASES) {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases });
  return ctx;
}

const opts = (home, extra = {}) => ({ home, env: { HOME: home }, windowsUsersDir: windowsUsersDirFor(home), ...extra });

function sessionFile(ctx, suffix) {
  const proj = join(ctx.root, 'projects');
  for (const d of readdirSync(proj)) {
    for (const f of readdirSync(join(proj, d))) if (f.endsWith(suffix)) return join(proj, d, f);
  }
  throw new Error('fixture file not found');
}

describe('re-ingest', () => {
  it('a second run reads 0 bytes and leaves every natural-key table unchanged; only the run-log tables grow', async () => {
    const ctx = await fresh();
    try {
      assert.equal(runCli(['ingest'], { home: ctx.home }).status, 0);
      const d1 = digest(ctx.home);
      const logs1 = runLogCounts(ctx.home);
      const r2 = runCli(['ingest'], { home: ctx.home });
      assert.equal(r2.status, 0, r2.stderr);
      assert.deepEqual(digest(ctx.home), d1);
      const logs2 = runLogCounts(ctx.home);
      assert.equal(logs2.ingest_run, logs1.ingest_run + 1);
      assert.equal(logs2.env_snapshot, logs1.env_snapshot + 1, 'one env_snapshot row per run, like ingest_run');
      assert.equal(logs2.env_snapshot, logs2.ingest_run);
      assert.ok(logs2.ingest_source_run > logs1.ingest_source_run);
      // Plan 01-06: the usage source (cursorless) runs after transcript in every run; these rows are the transcript's.
      const [src] = queryDb(STORE(ctx.home), 'SELECT bytes_read, lines_read FROM ingest_source_run WHERE source = \'transcript\' ORDER BY run_id DESC LIMIT 1');
      assert.equal(src.bytes_read, 0);
      assert.equal(src.lines_read, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it('on the units home a second run leaves dir_repo, repo, unit_obs and unit_artifact unchanged', async () => {
    const ctx = makeHome();
    try {
      buildUnitsHome({ home: ctx.home, root: ctx.root });
      const env = cliEnv(ctx.home, { TZ: 'America/New_York' });
      assert.equal(runCli(['ingest'], { home: ctx.home, env }).status, 0);
      const d1 = digest(ctx.home);
      assert.ok(d1.counts.unit_obs > 0 && d1.counts.dir_repo > 0, 'the units home yields units and resolved dirs');
      const r2 = runCli(['ingest'], { home: ctx.home, env });
      assert.equal(r2.status, 0, r2.stderr);
      assert.deepEqual(digest(ctx.home), d1);
    } finally {
      ctx.cleanup();
    }
  });

  it('on the adapter home a second run scans no unit and leaves every 02-05 table unchanged', async () => {
    const { buildAdapterHome } = await import('../fixtures/adapter-home.mjs');
    const ctx = makeHome();
    try {
      buildAdapterHome({ home: ctx.home, root: ctx.root });
      const env = cliEnv(ctx.home, { TZ: 'UTC' });
      assert.equal(runCli(['ingest'], { home: ctx.home, env }).status, 0);
      const d1 = digest(ctx.home);
      assert.ok(d1.counts.unit_commit > 0 && d1.counts.unit_git_scan > 0 && d1.counts.unit_path > 0, 'the adapter home yields facts');
      assert.ok(d1.counts.unit_artifact_time > 0, 'artifact times are stored');
      const r2 = runCli(['ingest'], { home: ctx.home, env });
      assert.equal(r2.status, 0, r2.stderr);
      assert.match(r2.stdout, / facts=not_needed facts_units=0 /);
      assert.deepEqual(digest(ctx.home), d1);
    } finally {
      ctx.cleanup();
    }
  });

  it('reversed file order gives the same key digest as the natural order', async () => {
    const a = await fresh();
    const b = await fresh();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(a.home));
      await runIngest(opts(b.home, { order: 'reverse' }));
      assert.deepEqual(digest(b.home), digest(a.home));
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('shuffled line order inside every file gives the same key digest (field-wise max is order independent)', async () => {
    const a = await fresh();
    const b = await fresh();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      for (const dir of ['projects']) {
        const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (
          e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.jsonl') && !e.name.startsWith('agent-agentlink') ? [join(d, e.name)] : []));
        for (const f of walk(join(b.root, dir))) {
          try { if (statSync(f).isFile()) shuffleLines(f, 7); } catch { /* a dangling link is not a file */ }
        }
      }
      await runIngest(opts(a.home));
      await runIngest(opts(b.home));
      assert.deepEqual(digest(b.home), digest(a.home));
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('appended complete lines are the only bytes read, and the new key appears', async () => {
    const ctx = await fresh(['tracer-base']);
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(ctx.home));
      const before = digest(ctx.home);
      const file = sessionFile(ctx, 'sess-fixture-s1.jsonl');
      const { makeAssistant, makeUsage } = await import('../fixtures/build.mjs');
      const line = `${JSON.stringify(makeAssistant({
        session: 'sess-fixture-s1', ts: '2026-10-27T12:00:30.000Z', id: 'msg_appended', model: 'claude-opus-5-5',
        use: makeUsage({ input: 1, output: 2, read: 3, creation: 4 }),
      }))}\n`;
      appendFileSync(file, line);
      await runIngest(opts(ctx.home));
      const [src] = queryDb(STORE(ctx.home), 'SELECT bytes_read FROM ingest_source_run WHERE source = \'transcript\' ORDER BY run_id DESC LIMIT 1');
      assert.equal(src.bytes_read, Buffer.byteLength(line));
      assert.equal(digest(ctx.home).counts.cc_message, before.counts.cc_message + 1);
    } finally {
      ctx.cleanup();
    }
  });

  it('a trailing partial line is not consumed until its newline arrives', async () => {
    const ctx = await fresh(['tracer-base']);
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(ctx.home));
      const file = sessionFile(ctx, 'sess-fixture-s1.jsonl');
      const { makeAssistant, makeUsage } = await import('../fixtures/build.mjs');
      const full = JSON.stringify(makeAssistant({
        session: 'sess-fixture-s1', ts: '2026-10-27T12:00:31.000Z', id: 'msg_partial', model: 'claude-opus-5-5',
        use: makeUsage({ input: 1, output: 2, read: 3, creation: 4 }),
      }));
      const cut = Math.floor(full.length / 2);
      const count = () => queryDb(STORE(ctx.home), 'SELECT count(*) AS n FROM cc_message')[0].n;
      const before = count();
      appendFileSync(file, full.slice(0, cut));
      await runIngest(opts(ctx.home));
      assert.equal(count(), before, 'a partial line adds no row');
      const [mid] = queryDb(STORE(ctx.home), 'SELECT pending_tail_bytes AS p FROM ingest_source_run WHERE source = \'transcript\' ORDER BY run_id DESC LIMIT 1');
      assert.equal(mid.p, cut);
      appendFileSync(file, `${full.slice(cut)}\n`);
      await runIngest(opts(ctx.home));
      assert.equal(count(), before + 1, 'the completed line is read once');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('rotation', () => {
  it('a truncated file is re-read from offset 0 without duplicate rows', async () => {
    const ctx = await fresh(['tracer-base']);
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(ctx.home));
      const before = digest(ctx.home);
      const file = sessionFile(ctx, 'sess-fixture-s1.jsonl');
      truncateSync(file, Math.floor(statSync(file).size / 2));
      await runIngest(opts(ctx.home));
      assert.deepEqual(digest(ctx.home).counts.cc_message, before.counts.cc_message);
      const re = queryDb(STORE(ctx.home), "SELECT name, sum(n) AS n FROM ingest_count WHERE kind = 'reread' GROUP BY name");
      assert.deepEqual(re.map((r) => `${r.name}:${r.n}`), ['truncated:1']);
    } finally {
      ctx.cleanup();
    }
  });

  it('a replaced file (new inode, new content) is re-read and its new key added, with no duplicates', async () => {
    const ctx = await fresh(['tracer-base']);
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(ctx.home));
      const before = digest(ctx.home);
      const file = sessionFile(ctx, 'sess-fixture-s1.jsonl');
      const { makeAssistant, makeUsage } = await import('../fixtures/build.mjs');
      const text = readFileSync(file, 'utf8');
      const extra = JSON.stringify(makeAssistant({
        session: 'sess-fixture-s1', ts: '2026-10-27T12:00:40.000Z', id: 'msg_replaced', model: 'claude-opus-5-5',
        use: makeUsage({ input: 1, output: 2, read: 3, creation: 4 }),
      }));
      writeFileSync(`${file}.new`, `${extra}\n${text}`);
      renameSync(`${file}.new`, file);
      await runIngest(opts(ctx.home));
      assert.equal(digest(ctx.home).counts.cc_message, before.counts.cc_message + 1);
      const re = queryDb(STORE(ctx.home), "SELECT name FROM ingest_count WHERE kind = 'reread'").map((r) => r.name);
      assert.ok(re.includes('replaced') || re.includes('rewritten'), `reread reasons: ${re}`);
    } finally {
      ctx.cleanup();
    }
  });

  it('a head-changed file of the same size is re-read from offset 0 (rewritten)', async () => {
    const ctx = await fresh(['tracer-base']);
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(ctx.home));
      const file = sessionFile(ctx, 'sess-fixture-s1.jsonl');
      const text = readFileSync(file, 'utf8');
      writeFileSync(file, text.replace('summarize', 'SUMMARIZE'));
      await runIngest(opts(ctx.home));
      const re = queryDb(STORE(ctx.home), "SELECT name, sum(n) AS n FROM ingest_count WHERE kind = 'reread' GROUP BY name");
      assert.deepEqual(re.map((r) => `${r.name}:${r.n}`), ['rewritten:1']);
    } finally {
      ctx.cleanup();
    }
  });

  it('after a rotation re-read the store digest equals that of a clean ingest of the same final content', async () => {
    const a = await fresh(['tracer-base']);
    const b = await fresh(['tracer-base']);
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(a.home));
      const fa = sessionFile(a, 'sess-fixture-s1.jsonl');
      const full = readFileSync(fa);
      truncateSync(fa, 100);
      await runIngest(opts(a.home));
      writeFileSync(fa, full);
      await runIngest(opts(a.home));
      await runIngest(opts(b.home));
      assert.deepEqual(digest(a.home), digest(b.home));
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});

describe('interruption and concurrency', () => {
  it('a run cut between chunks (open chunk rolled back, lock released) then a clean run equals one uninterrupted run', async () => {
    const a = await fresh();
    const b = await fresh();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(a.home));
      let chunks = 0;
      await assert.rejects(runIngest(opts(b.home, {
        chunkLines: 2, beforeCommit: () => { chunks += 1; if (chunks === 2) throw new Error('cut-here'); },
      })), /cut-here/);
      assert.ok(!existsSync(join(stateDirOf(b.home), 'ingest.lock')), 'lock released after the failure');
      const failed = queryDb(STORE(b.home), 'SELECT status, error_code FROM ingest_run');
      assert.equal(failed[0].status, 'failed');
      assert.ok(failed[0].error_code);
      await runIngest(opts(b.home));
      assert.deepEqual(digest(b.home), digest(a.home));
      const runs = queryDb(STORE(b.home), 'SELECT status FROM ingest_run ORDER BY run_id').map((r) => r.status);
      assert.deepEqual(runs, ['failed', 'ok']);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('two ingest processes started together never duplicate a key; each prints a run or the lock-skip line and exits 0', async () => {
    const ctx = await fresh();
    try {
      const [x, y] = await Promise.all([runCliAsync(['ingest'], { home: ctx.home }), runCliAsync(['ingest'], { home: ctx.home })]);
      for (const r of [x, y]) {
        assert.equal(r.status, 0, r.stderr);
        assert.ok(/^ingest: roots=/m.test(r.stdout) || /^ingest: skipped, another ingest holds the lock/m.test(r.stdout));
      }
      const ran = [x, y].filter((r) => /^ingest: roots=/m.test(r.stdout)).length;
      assert.equal(queryDb(STORE(ctx.home), 'SELECT count(*) AS n FROM ingest_run')[0].n, ran);
      const solo = await fresh();
      try {
        const { runIngest } = await mod('ingest/run.mjs');
        await runIngest(opts(solo.home));
        assert.deepEqual(digest(ctx.home), digest(solo.home));
      } finally {
        solo.cleanup();
      }
    } finally {
      ctx.cleanup();
    }
  });

  it('a stale lock whose process is dead is taken over and the run completes', async () => {
    const ctx = await fresh(['tracer-base']);
    try {
      const { ensureStateDir } = await mod('db.mjs');
      ensureStateDir(ctx.home);
      writeFileSync(join(stateDirOf(ctx.home), 'ingest.lock'), `${JSON.stringify({ pid: 2 ** 22 - 3, started_utc: '2026-10-27T00:00:00.000Z', proc_start: '' })}\n`, { mode: 0o600 });
      const r = runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home) });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^ingest: roots=/m);
      assert.ok(!existsSync(join(stateDirOf(ctx.home), 'ingest.lock')));
    } finally {
      ctx.cleanup();
    }
  });

  it('every natural-key table keeps its row count and digest across a re-ingest (unclassified family)', async () => {
    const ctx = await fresh();
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(ctx.home));
      const d1 = digest(ctx.home);
      await runIngest(opts(ctx.home, { order: 'reverse' }));
      const d2 = digest(ctx.home);
      assert.deepEqual(d2.counts, d1.counts);
      assert.equal(d2.digest, d1.digest);
      for (const t of ['cc_message', 'cc_message_iter', 'cc_message_file', 'cc_agent_meta', 'source_root', 'source_file', 'unknown_attr']) {
        assert.ok(t in d1.counts && d1.counts[t] > 0, `${t} holds rows`);
      }
    } finally {
      ctx.cleanup();
    }
  });
});

// Plan 02-04 (UNIT-06 capture ordering, T-02-39): case 85's refs and command names do not depend on read order.
describe('planning refs and command names (case planning-refs)', () => {
  const REFS_CASE = ['planning-refs'];
  const nonEmpty = (d) => d.counts.cc_message_ref > 0 && d.counts.cc_command > 0;

  it('a second ingest leaves cc_message_ref and cc_command unchanged', async () => {
    const ctx = await fresh(REFS_CASE);
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest(opts(ctx.home));
      const d1 = digest(ctx.home);
      assert.ok(nonEmpty(d1), 'the case stores refs and commands');
      await runIngest(opts(ctx.home));
      assert.deepEqual(digest(ctx.home), d1);
    } finally {
      ctx.cleanup();
    }
  });

  it('shuffled lines and reversed file order give the same digest as the natural order', async () => {
    const a = await fresh(REFS_CASE);
    const b = await fresh(REFS_CASE);
    const c = await fresh(REFS_CASE);
    try {
      const { runIngest } = await mod('ingest/run.mjs');
      const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (
        e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.jsonl') ? [join(d, e.name)] : []));
      for (const f of walk(join(b.root, 'projects'))) shuffleLines(f, 11);
      await runIngest(opts(a.home));
      await runIngest(opts(b.home));
      await runIngest(opts(c.home, { order: 'reverse' }));
      const da = digest(a.home);
      assert.ok(nonEmpty(da));
      assert.deepEqual(digest(b.home), da, 'shuffled lines');
      assert.deepEqual(digest(c.home), da, 'reversed file order');
    } finally {
      a.cleanup();
      b.cleanup();
      c.cleanup();
    }
  });
});

// Review CR-01 (RR-08, ADR-0009 amendment 2026-10-30): one API message written as several transcript lines (parallel
// tool calls) can name one rel_path under two repositories and with two tools. The key holds ref_dir, so both
// repositories keep a row; tool_name merges by the bytewise minimum, so the stored row never depends on read order.
describe('one message over several lines naming one rel_path in two repos (review CR-01)', () => {
  const SESSION = 'c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5';
  const REL = '.planning/phases/01-foundation/01-01-PLAN.md';

  async function build(order) {
    const { makeAssistant, makeUsage, writeJsonl, mangleHome } = await import('../fixtures/build.mjs');
    const ctx = makeHome();
    const cwd = join(ctx.home, 'work', 'beta');
    const use = makeUsage({ input: 10, output: 5, read: 0, creation: 0 });
    const line = (n, id, blocks) => JSON.stringify(makeAssistant({
      session: SESSION, ts: `2026-10-27T15:00:0${n}.000Z`, id, model: 'claude-opus-5-5', cwd, use, content: blocks,
    }));
    const tu = (n, name, repo) => ({ type: 'tool_use', id: `toolu_${n}`, name, input: { file_path: join(ctx.home, 'repos', repo, REL) } });
    // msg_x: line 1 a Read of alpha's PLAN, line 2 an Edit of gamma's PLAN (the reviewer's probe), line 3 an Edit of
    // alpha's PLAN (a second tool for one (ref_dir, rel_path)). msg_y: one line with a Read and an Edit of alpha's PLAN.
    const lines = [
      line(1, 'msg_x', [tu(1, 'Read', 'alpha')]),
      line(2, 'msg_x', [tu(2, 'Edit', 'gamma')]),
      line(3, 'msg_x', [tu(3, 'Edit', 'alpha')]),
      line(4, 'msg_y', [tu(4, 'Read', 'alpha'), tu(5, 'Edit', 'alpha')]),
    ];
    if (order === 'reverse') lines.reverse();
    const file = join(ctx.root, 'projects', mangleHome(cwd), `${SESSION}.jsonl`);
    writeJsonl(file, lines);
    if (typeof order === 'number') shuffleLines(file, order);
    return ctx;
  }

  it('keeps one row per repository with the bytewise-minimum tool name, whatever the line order', async () => {
    const { runIngest } = await mod('ingest/run.mjs');
    const homes = [];
    try {
      for (const order of ['forward', 'reverse', 5, 9]) {
        const ctx = await build(order);
        homes.push(ctx);
        await runIngest(opts(ctx.home));
      }
      const rows = queryDb(STORE(homes[0].home), `SELECT message_id, ref_dir, rel_path, ref_kind, tool_name, n FROM cc_message_ref
        ORDER BY session_id, agent_id, message_id, ref_dir, rel_path`).map((r) => Object.values(r));
      assert.deepEqual(rows, [
        ['msg_x', '~/repos/alpha', REL, 'phase', 'Edit', 1],
        ['msg_x', '~/repos/gamma', REL, 'phase', 'Edit', 1],
        ['msg_y', '~/repos/alpha', REL, 'phase', 'Edit', 2],
      ], 'both repositories are kept and tool_name is the bytewise minimum');
      const d0 = digest(homes[0].home);
      for (const [i, label] of ['reversed lines', 'shuffled lines (seed 5: 2,4,3,1)', 'shuffled lines (seed 9: 3,2,4,1)'].entries()) {
        assert.equal(digest(homes[i + 1].home).digest, d0.digest, label);
      }
    } finally {
      for (const ctx of homes) ctx.cleanup();
    }
  });
});
