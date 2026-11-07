// Every fixture case, built alone under a fresh HOME and ingested, must match its hand-computed
// `expected` data. Adding a case file adds a test here with no edit to this file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CASES_DIR, buildFixtureTree, loadCases, makeHome, queryDb, runCli, stateDirOf, windowsUsersDirFor,
} from '../fixtures/build.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const STORE = (home) => join(stateDirOf(home), 'store.db');
const cases = await loadCases();

// Ingests the home: through the CLI, or in-process when the case needs runner options.
async function ingestHome(home, options) {
  if (!options) {
    const r = runCli(['ingest'], { home });
    assert.equal(r.status, 0, 'ingest exit status');
    return;
  }
  const { runIngest } = await mod('ingest/run.mjs');
  await runIngest({ home, env: { HOME: home }, windowsUsersDir: windowsUsersDirFor(home), ...options });
}

const keyOf = (r) => `${r.session_id}|${r.agent_id}|${r.message_id}`;

// `source` names the source whose ingest_source_run row is read (plan 01-03 registered a second source).
function snapshot(home, source = 'transcript') {
  const db = STORE(home);
  const q = (sql, p) => queryDb(db, sql, p);
  const messages = {};
  for (const r of q('SELECT * FROM cc_message')) messages[keyOf(r)] = r;
  return {
    messages,
    sourceFiles: q('SELECT r.alias || \':\' || f.rel_path AS p FROM source_file f JOIN source_root r ON r.root_id = f.root_id').map((r) => r.p).sort(),
    meta: q('SELECT * FROM cc_agent_meta ORDER BY session_id, agent_id').map((r) => { const { file_id: _f, ...rest } = r; return rest; }),
    // Plan 01-06: counts of the case's own source only (the cursorless usage source counts an absent cache).
    counts: (kind) => Object.fromEntries(q('SELECT name, sum(n) AS n FROM ingest_count WHERE kind = ? AND source = ? GROUP BY name', [kind, source]).map((r) => [r.name, r.n])),
    unknownAttr: Object.fromEntries(q('SELECT scope || \'|\' || name AS k, last_run_n AS n FROM unknown_attr').map((r) => [r.k, r.n])),
    iter: (k) => q('SELECT iter_seq, iter_type, model, input_tokens, output_tokens, cache_read, cache_creation, cache_5m, cache_1h FROM cc_message_iter WHERE session_id = ? AND agent_id = ? AND message_id = ? ORDER BY iter_seq', k.split('|')).map((r) => Object.values(r)),
    source: q('SELECT * FROM ingest_source_run WHERE source = ?', [source])[0],
  };
}

describe('fixture cases (each built alone)', () => {
  for (const c of cases) {
    it(`case ${c.id} matches its hand-computed expectations`, async () => {
      const ctx = makeHome();
      try {
        const built = await buildFixtureTree(ctx.root, { home: ctx.home, cases: [c.id] });
        assert.equal(built.built.length, 1);
        await ingestHome(ctx.home, c.options);
        const s = snapshot(ctx.home, c.sources[0]);
        const e = c.expected;

        const tuples = {};
        for (const [k, r] of Object.entries(s.messages)) {
          tuples[k] = [r.input_tokens, r.output_tokens, r.cache_read, r.cache_creation, r.cache_5m, r.cache_1h];
        }
        assert.deepEqual(tuples, e.messageKeys, 'message keys and token tuples');
        assert.deepEqual(s.sourceFiles, [...e.sourceFiles].sort(), 'source files (root alias and relative path)');
        assert.deepEqual(s.meta, e.agentMeta, 'agent meta rows');
        assert.deepEqual(s.counts('walk_skip'), e.skipped, 'walk skips by reason');
        assert.deepEqual(s.unknownAttr, e.unknownAttr, 'unknown_attr names');
        assert.deepEqual(s.counts('dropped'), e.dropped, 'dropped by reason');
        for (const [k, v] of Object.entries(e.cwd ?? {})) assert.equal(s.messages[k].cwd, v, `cwd of ${k}`);
        if (e.rejected) assert.deepEqual(s.counts('rejected_field'), e.rejected, 'rejected fields');
        for (const [k, rows] of Object.entries(e.iterations ?? {})) assert.deepEqual(s.iter(k), rows, `iterations of ${k}`);
        for (const [k, n] of Object.entries(e.iterationCounts ?? {})) assert.equal(s.iter(k).length, n, `iteration count of ${k}`);
        for (const [k, f] of Object.entries(e.flags ?? {})) {
          assert.equal(s.messages[k].has_iterations, f.has_iterations, `has_iterations of ${k}`);
          assert.equal(s.messages[k].has_server_tool_use, f.has_server_tool_use, `has_server_tool_use of ${k}`);
        }
        for (const [name, n] of Object.entries(e.counters ?? {})) assert.equal(s.source[name], n, `counter ${name}`);
        if (e.unknownToken) assert.deepEqual(s.counts('unknown_token'), e.unknownToken, 'unknown token-bearing names');
        if (e.iterationsTruncated !== undefined) {
          const total = Object.values(s.counts('iterations_truncated')).reduce((a, b) => a + b, 0);
          assert.equal(total, e.iterationsTruncated, 'iterations truncated');
        }
        if (c.verify) await c.verify({ ...ctx, snapshot: s });

        // Planted ids of skipped paths never reach the store file.
        const { checkpointStore } = await mod('db.mjs');
        checkpointStore({ home: ctx.home });
        const bytes = readFileSync(STORE(ctx.home)).toString('latin1');
        for (const id of e.leakIds ?? []) assert.ok(!bytes.includes(id), 'a skipped path leaked into the store');
      } finally {
        ctx.cleanup();
      }
    });
  }
});

describe('fixture case conventions', () => {
  it('every case module follows the contract and its id equals its file name without the prefix', () => {
    assert.ok(cases.length >= 6, 'cases 10 to 60 are present');
    for (const c of cases) {
      assert.equal(c.id, c.file.replace(/^\d+-/, '').replace(/\.mjs$/, ''));
      assert.ok(['tracer', 'extra'].includes(c.group));
      assert.ok(Array.isArray(c.sources) && c.sources.length >= 1 && c.sources.every((n) => /^[a-z][a-z0-9-]*$/.test(n))); // transcript, otel (plan 01-03), ...
      assert.equal(typeof c.build, 'function');
      assert.equal(typeof c.expected, 'object');
    }
  });

  it('a temporary case file is picked up by loadCases from a private directory, never written into the shared one', async () => {
    // The probe lives in its own temp directory: writing it into CASES_DIR let a parallel test file list it and
    // then fail to import it after it was removed (WR-03 of the 09-01 re-review).
    const sharedBefore = readdirSync(CASES_DIR).sort();
    const dir = mkdtempSync(join(tmpdir(), 'fixture-cases-probe-'));
    const file = join(dir, '99-temporary-probe.mjs');
    writeFileSync(file, "export const id = 'temporary-probe';\nexport const group = 'extra';\nexport const sources = ['transcript'];\nexport function build() { return []; }\nexport const expected = {};\n");
    try {
      const names = (await loadCases(dir)).map((c) => c.id);
      assert.deepEqual(names, ['temporary-probe']);
      assert.deepEqual(readdirSync(CASES_DIR).sort(), sharedBefore, 'the shared cases directory was not touched');
      assert.ok(!(await loadCases()).some((c) => c.id === 'temporary-probe'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(!existsSync(file));
    assert.ok(!(await loadCases()).some((c) => c.id === 'temporary-probe'));
  });

  it('a backup root dedupes by message key: the S3 keys are one row each with two files, the S5 keys are separate', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['subagents', 'backup-root'] });
      await ingestHome(ctx.home);
      const q = (sql, p) => queryDb(STORE(ctx.home), sql, p);
      const s3 = '33333333-3333-4333-8333-333333333333';
      const s5 = '55555555-5555-4555-8555-555555555555';
      assert.equal(q('SELECT count(*) AS n FROM cc_message WHERE session_id = ? AND agent_id = \'\'', [s3])[0].n, 2);
      assert.equal(q('SELECT count(*) AS n FROM cc_message WHERE session_id = ?', [s5])[0].n, 2);
      const files = q(
        `SELECT m.message_id, count(*) AS n, group_concat(r.alias, ',') AS roots FROM cc_message_file m
           JOIN source_file f ON f.file_id = m.file_id JOIN source_root r ON r.root_id = f.root_id
          WHERE m.session_id = ? AND m.agent_id = '' GROUP BY m.message_id ORDER BY m.message_id`, [s3],
      );
      assert.deepEqual(files.map((r) => r.n), [2, 2]);
      for (const r of files) assert.deepEqual(r.roots.split(',').sort(), ['claude', 'claude-contrib']);
    } finally {
      ctx.cleanup();
    }
  });

  it('all cases together ingest with exit 0 and the union of their message keys', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['tracer-base', 'subagents', 'iterations', 'backup-root', 'cwd-forms'] });
      await ingestHome(ctx.home);
      const union = new Set();
      for (const c of cases.filter((x) => ['tracer-base', 'subagents', 'iterations', 'backup-root', 'cwd-forms'].includes(x.id))) {
        for (const k of Object.keys(c.expected.messageKeys)) union.add(k);
      }
      const got = new Set(queryDb(STORE(ctx.home), 'SELECT session_id || \'|\' || agent_id || \'|\' || message_id AS k FROM cc_message').map((r) => r.k));
      assert.deepEqual([...got].sort(), [...union].sort());
    } finally {
      ctx.cleanup();
    }
  });
});
