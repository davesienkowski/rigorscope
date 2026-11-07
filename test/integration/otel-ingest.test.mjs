// OTel ingest contract (plan 01-03, DATA-03, DATA-05, DATA-06): both receiver directories are discovered,
// events are keyed on four fields, metrics on a hash plus ordinal, only allowlisted shape-checked attributes
// are stored, and every drop, rejection and unknown name is counted by name without failing the run.
// Written before the OTel source exists: the static import below fails with ERR_MODULE_NOT_FOUND until then.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverOtelRoots, listOtelFiles } from '../../src/sources/otel/dirs.mjs';
import {
  buildFixtureTree, cliEnv, makeHome, queryDb, runCli, stateDirOf, treeDigest,
} from '../fixtures/build.mjs';
import {
  OTEL_EXPECTED, PARTIAL_TAIL, SA, buildOtelTree, liveDirFor, otelNeedles, preserveDirFor, scanBuffers,
} from '../fixtures/otel.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const STORE = (home) => join(stateDirOf(home), 'store.db');
const q = (home, sql, p) => queryDb(STORE(home), sql, p);
const counts = (home, kind) => Object.fromEntries(
  q(home, 'SELECT name, sum(n) AS n FROM ingest_count WHERE source = \'otel\' AND kind = ? GROUP BY name', [kind]).map((r) => [r.name, r.n]),
);
const unknownAttr = (home) => Object.fromEntries(
  q(home, 'SELECT scope || \'|\' || name AS k, last_run_n AS n FROM unknown_attr WHERE source = \'otel\'').map((r) => [r.k, r.n]),
);

function ingested({ preserve = false, extra } = {}) {
  const ctx = makeHome();
  const tree = buildOtelTree(ctx.home, { preserve });
  if (extra) extra(ctx, tree);
  const r = runCli(['ingest'], { home: ctx.home });
  return { ctx, tree, r };
}

// Independent hand-written allowlist for the kinds the fixture uses (from 01-RESEARCH.md).
const ALLOWED = {
  api_request: ['model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cache_creation_5m_tokens',
    'cache_creation_1h_tokens', 'cost_usd', 'cost_usd_micros', 'duration_ms', 'ttft_ms', 'request_id', 'client_request_id', 'speed',
    'query_source', 'effort', 'agent.name', 'skill.name', 'mcp_server.name', 'mcp_tool.name', 'prompt.id'],
  api_error: ['model', 'status_code', 'duration_ms', 'attempt', 'request_id', 'client_request_id', 'speed', 'query_source', 'effort',
    'agent.name', 'skill.name', 'prompt.id'],
  tool_decision: ['decision', 'source', 'tool_name', 'tool_use_id', 'tool_source', 'classifier_verdict', 'permission_mode', 'prompt.id'],
  tool_result: ['tool_name', 'tool_use_id', 'success', 'duration_ms', 'tool_input_size_bytes', 'tool_result_size_bytes', 'error_type',
    'decision_source', 'decision_type', 'mcp_server_scope', 'vcs.ref.head.revision', 'vcs.ref.head.type', 'prompt.id'],
  hook_execution_start: ['hook_event', 'hook_name', 'num_hooks', 'num_success', 'num_blocking', 'num_non_blocking_error', 'num_cancelled',
    'total_duration_ms', 'stdout_chars', 'additional_context_chars', 'system_message_chars', 'initial_user_message_chars',
    'num_outputs_persisted', 'managed_only', 'hook_source', 'safe_mode', 'prompt.id'],
  subagent_completed: ['agent_type', 'agent.source', 'is_built_in', 'is_async', 'total_tokens', 'total_tool_uses', 'duration_ms', 'model',
    'final_model', 'model_swapped', 'prompt.id'],
  user_prompt: ['prompt_length', 'message.uuid', 'command_name', 'command_source', 'prompt.id'],
  assistant_response: ['response_length', 'request_id', 'message.uuid', 'model', 'query_source', 'prompt.id'],
  managed_settings_resolved: [],
  brand_new_event: [],
};
const SENSITIVE = /^(user\.|organization\.|terminal\.type$|prompt$|prompt_text$|response$|tool_parameters$|tool_input$|error$|vcs\.ref\.head\.name$)/;

describe('OTel discovery', () => {
  it('finds the live and preserve directories as roots with aliases and kinds, display strings with no absolute path', () => {
    const ctx = makeHome();
    try {
      buildOtelTree(ctx.home, { preserve: true });
      const res = discoverOtelRoots({ home: ctx.home, env: {} });
      assert.deepEqual(res.roots.map((r) => [r.alias, r.kind]), [['live', 'live'], ['preserve', 'preserve']]);
      for (const r of res.roots) {
        assert.ok(r.display.startsWith('~'), 'display starts with a tilde');
        assert.ok(!r.display.includes(ctx.home), 'display holds no absolute path');
      }
    } finally {
      ctx.cleanup();
    }
  });

  it('a missing directory is skipped with reason absent, not an error', () => {
    const ctx = makeHome();
    try {
      buildOtelTree(ctx.home, { preserve: false });
      const res = discoverOtelRoots({ home: ctx.home, env: {} });
      assert.deepEqual(res.roots.map((r) => r.alias), ['live']);
      assert.ok(res.skipped.some((s) => s.reason === 'absent'));
    } finally {
      ctx.cleanup();
    }
  });

  it('HOOK_TELEMETRY_DIR is honored when absolute and ignored when relative', () => {
    const ctx = makeHome();
    try {
      buildOtelTree(ctx.home, { preserve: false });
      const alt = join(ctx.home, 'alt-telemetry');
      mkdirSync(alt, { recursive: true });
      const abs = discoverOtelRoots({ home: ctx.home, env: { HOOK_TELEMETRY_DIR: alt } });
      assert.equal(abs.roots[0].alias, 'live');
      assert.equal(abs.roots[0].display, '$HOOK_TELEMETRY_DIR');
      assert.ok(abs.roots[0].path.endsWith('alt-telemetry'));
      const rel = discoverOtelRoots({ home: ctx.home, env: { HOOK_TELEMETRY_DIR: 'alt-telemetry' } });
      assert.ok(rel.roots[0].path.endsWith(join('.local', 'share', 'hook-telemetry')));
    } finally {
      ctx.cleanup();
    }
  });

  it('lists only regular events and metrics files in bytewise order and counts reports, odd names and symlinks as skips', () => {
    const ctx = makeHome();
    try {
      const tree = buildOtelTree(ctx.home, { preserve: false });
      mkdirSync(join(tree.liveDir, 'reports'), { recursive: true });
      writeFileSync(join(tree.liveDir, 'reports', 'events-2026-10-20.jsonl'), 'x\n');
      writeFileSync(join(tree.liveDir, 'notes.txt'), 'x\n');
      symlinkSync(tree.files.liveEvents, join(tree.liveDir, 'events-2026-10-26.jsonl'));
      const res = listOtelFiles(tree.liveDir);
      assert.deepEqual(res.files.map((f) => f.name), ['events-2026-10-27.jsonl', 'metrics-2026-10-27.jsonl']);
      assert.deepEqual(res.skipped, { name: 2, symlink: 1 });
    } finally {
      ctx.cleanup();
    }
  });
});

describe('OTel ingest of the live directory', () => {
  it('stores 12 events and 7 metrics, prints an otel progress line and exits 0', () => {
    const { ctx, r } = ingested();
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^ingest: roots=\d+ sources=.*otel/m);
      assert.match(r.stdout, new RegExp(`^otel: files=2 new=2 reread=0 unchanged=0 skipped=0 bytes=\\d+ lines=29 assistant=${OTEL_EXPECTED.liveOnly.parsed} kept=${OTEL_EXPECTED.liveOnly.kept} unparseable=1 oversized=0 dropped=`, 'm'));
      assert.match(r.stdout, new RegExp(`pending_tail_bytes=${PARTIAL_TAIL.length}$`, 'm'));
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM otel_event')[0].n, OTEL_EXPECTED.liveOnly.events);
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM otel_metric')[0].n, OTEL_EXPECTED.liveOnly.metrics);
    } finally {
      ctx.cleanup();
    }
  });

  it('counts every drop by reason, every rejected field by name and every unknown name, exactly as hand-computed', () => {
    const { ctx } = ingested();
    try {
      assert.deepEqual(counts(ctx.home, 'dropped'), OTEL_EXPECTED.dropped.live);
      assert.deepEqual(counts(ctx.home, 'rejected_field'), OTEL_EXPECTED.rejected.live);
      assert.deepEqual(counts(ctx.home, 'unknown_token'), OTEL_EXPECTED.unknownToken.live);
      assert.deepEqual(unknownAttr(ctx.home), OTEL_EXPECTED.unknownAttr.live);
      const [src] = q(ctx.home, 'SELECT * FROM ingest_source_run WHERE source = \'otel\'');
      assert.equal(src.unparseable, OTEL_EXPECTED.unparseable);
      assert.equal(src.rows_upserted, OTEL_EXPECTED.liveOnly.rowsUpserted);
    } finally {
      ctx.cleanup();
    }
  });

  it('prints one WARNING per unknown token-bearing source on stderr naming both names, never failing the run', () => {
    const { ctx, r } = ingested();
    try {
      assert.equal(r.status, 0);
      const warn = r.stderr.split('\n').filter((l) => l.startsWith('WARNING: otel: unknown_token_bearing=2'));
      assert.equal(warn.length, 1, r.stderr);
      assert.ok(warn[0].includes('brand_new_event|2.1.309') && warn[0].includes('claude_code.token.bonus|2.1.309'));
    } finally {
      ctx.cleanup();
    }
  });

  it('keeps both events of a (session, sequence) pair that differs only in name or only in timestamp', () => {
    const { ctx } = ingested();
    try {
      const groups = q(ctx.home, 'SELECT session_id, event_seq, count(*) AS n FROM otel_event GROUP BY 1, 2 HAVING count(*) > 1 ORDER BY 1, 2');
      assert.deepEqual(groups.map((g) => [g.session_id, g.event_seq, g.n]), OTEL_EXPECTED.keyPairs.map(([s, n]) => [s, n, 2]));
      const names = q(ctx.home, 'SELECT kind FROM otel_event WHERE session_id = ? AND event_seq = 5 ORDER BY kind', [SA]).map((x) => x.kind);
      assert.deepEqual(names, ['tool_decision', 'tool_result']);
      const stamps = q(ctx.home, 'SELECT event_ts FROM otel_event WHERE session_id = ? AND event_seq = 7 ORDER BY event_ts', [SA]).map((x) => x.event_ts);
      assert.equal(new Set(stamps).size, 2);
    } finally {
      ctx.cleanup();
    }
  });

  it('stores only allowlisted keys for each kind and no sensitive key anywhere', () => {
    const { ctx } = ingested();
    try {
      for (const row of q(ctx.home, 'SELECT kind, attrs FROM otel_event')) {
        const allowed = ALLOWED[row.kind];
        assert.ok(allowed, `kind ${row.kind} is expected in the fixture`);
        for (const key of Object.keys(JSON.parse(row.attrs))) {
          assert.ok(allowed.includes(key), `${row.kind} stores ${key}`);
          assert.ok(!SENSITIVE.test(key), `${row.kind} stores a sensitive key`);
        }
      }
      for (const row of q(ctx.home, 'SELECT attrs FROM otel_metric')) {
        for (const key of Object.keys(JSON.parse(row.attrs))) {
          assert.ok(!SENSITIVE.test(key), 'a metric stores a sensitive key');
        }
      }
    } finally {
      ctx.cleanup();
    }
  });

  it('normalizes typed values: numeric strings become integers, bool strings become booleans, negative durations stay', () => {
    const { ctx } = ingested();
    try {
      const tr = JSON.parse(q(ctx.home, 'SELECT attrs FROM otel_event WHERE kind = \'tool_result\'')[0].attrs);
      assert.equal(tr.success, true);
      assert.equal(tr.duration_ms, -4);
      assert.equal(tr.tool_input_size_bytes, 40);
      const hook = JSON.parse(q(ctx.home, 'SELECT attrs FROM otel_event WHERE kind = \'hook_execution_start\' LIMIT 1')[0].attrs);
      assert.strictEqual(hook.num_hooks, 3);
      const err = JSON.parse(q(ctx.home, 'SELECT attrs FROM otel_event WHERE kind = \'api_error\'')[0].attrs);
      assert.strictEqual(err.status_code, 529);
      assert.strictEqual(err.attempt, 1);
      assert.equal(q(ctx.home, 'SELECT json_type(attrs, \'$.input_tokens\') AS t FROM otel_event WHERE request_id = \'req-e1\'')[0].t, 'integer');
    } finally {
      ctx.cleanup();
    }
  });

  it('stores header-only and unknown kinds with attrs {} and keeps request, prompt and tool ids as columns', () => {
    const { ctx } = ingested();
    try {
      for (const kind of ['managed_settings_resolved', 'brand_new_event']) {
        assert.equal(q(ctx.home, 'SELECT attrs FROM otel_event WHERE kind = ?', [kind])[0].attrs, '{}');
      }
      const a = q(ctx.home, 'SELECT prompt_id, request_id, cc_version FROM otel_event WHERE request_id = \'req-e1\'')[0];
      assert.deepEqual({ ...a }, { prompt_id: 'prompt-e1', request_id: 'req-e1', cc_version: '2.1.309' });
      assert.equal(q(ctx.home, 'SELECT tool_use_id FROM otel_event WHERE kind = \'tool_result\'')[0].tool_use_id, 'toolu_01');
    } finally {
      ctx.cleanup();
    }
  });

  it('keeps subagent_completed.total_tokens inside attrs only: no column, view or aggregate carries it', () => {
    const { ctx } = ingested();
    try {
      const sub = JSON.parse(q(ctx.home, 'SELECT attrs FROM otel_event WHERE kind = \'subagent_completed\'')[0].attrs);
      assert.equal(sub.total_tokens, 777);
      assert.equal(sub.agent_type, 'gsd-executor');
      for (const t of q(ctx.home, 'SELECT name FROM sqlite_master WHERE type = \'table\'')) {
        for (const c of q(ctx.home, `PRAGMA table_info(${t.name})`)) assert.notEqual(c.name, 'total_tokens', `${t.name} has a total_tokens column`);
      }
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM sqlite_master WHERE type = \'view\'')[0].n, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it('stores a metric by hash and ordinal: the byte-identical pair is two rows, an unknown metric is stored, a bad value is dropped', () => {
    const { ctx } = ingested();
    try {
      const pair = q(ctx.home, 'SELECT ordinal, value FROM otel_metric WHERE metric = \'claude_code.cost.usage\' ORDER BY ordinal');
      assert.deepEqual(pair.map((r) => r.ordinal), OTEL_EXPECTED.metricOrdinals);
      assert.ok(q(ctx.home, 'SELECT count(*) AS n FROM otel_metric WHERE metric = \'claude_code.token.bonus\'')[0].n === 1);
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM otel_metric WHERE value IS NULL')[0].n, 0);
      const lang = JSON.parse(q(ctx.home, 'SELECT attrs FROM otel_metric WHERE value = 120')[0].attrs);
      assert.equal(lang.language, 'Type Script, JS');
    } finally {
      ctx.cleanup();
    }
  });

  it('finds none of the planted values or an email shape in the store file and its WAL', async () => {
    const { ctx } = ingested({ preserve: true });
    try {
      const { checkpointStore } = await mod('db.mjs');
      checkpointStore({ home: ctx.home });
      const dir = stateDirOf(ctx.home);
      const bufs = readdirSync(dir).filter((n) => n.startsWith('store.db')).map((n) => ({ label: n, buf: readFileSync(join(dir, n)) }));
      assert.ok(bufs.length >= 1);
      assert.deepEqual(scanBuffers(bufs, otelNeedles()), []);
    } finally {
      ctx.cleanup();
    }
  });

  it('never changes the live directory (bytes and mtimes) and creates only the state directory', () => {
    const ctx = makeHome();
    try {
      const tree = buildOtelTree(ctx.home, { preserve: false });
      const before = treeDigest(tree.liveDir);
      const mtimes = readdirSync(tree.liveDir).map((n) => statSync(join(tree.liveDir, n)).mtimeMs);
      const top = readdirSync(ctx.home).sort();
      const r = runCli(['ingest'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(treeDigest(tree.liveDir), before);
      assert.deepEqual(readdirSync(tree.liveDir).map((n) => statSync(join(tree.liveDir, n)).mtimeMs), mtimes);
      assert.deepEqual(readdirSync(ctx.home).sort(), [...top, '.rigorscope'].sort());
    } finally {
      ctx.cleanup();
    }
  });

  it('counts a reports directory, a symlinked file and a non-matching name as walk_skip and reads none of them', () => {
    const { ctx } = ingested({
      extra: (c, tree) => {
        mkdirSync(join(tree.liveDir, 'reports'), { recursive: true });
        writeFileSync(join(tree.liveDir, 'reports', 'events-2026-10-20.jsonl'), 'CANARY-otel-report-line\n');
        writeFileSync(join(tree.liveDir, 'notes.txt'), 'CANARY-otel-notes-line\n');
        symlinkSync(tree.files.liveEvents, join(tree.liveDir, 'events-2026-10-26.jsonl'));
      },
    });
    try {
      assert.deepEqual(counts(ctx.home, 'walk_skip'), { name: 2, symlink: 1 });
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM source_file f JOIN source_root r ON r.root_id = f.root_id WHERE r.source = \'otel\'')[0].n, 2);
    } finally {
      ctx.cleanup();
    }
  });

  it('honors an absolute HOOK_TELEMETRY_DIR through the CLI and ignores a relative one', () => {
    const ctx = makeHome();
    try {
      buildOtelTree(ctx.home, { preserve: false });
      const tree = buildOtelTree(join(ctx.home, 'other-home'), { preserve: false });
      assert.ok(existsSync(tree.files.liveEvents));
      const r = runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home, { HOOK_TELEMETRY_DIR: tree.liveDir }) });
      assert.equal(r.status, 0, r.stderr);
      const roots = q(ctx.home, 'SELECT alias, display FROM source_root WHERE source = \'otel\'');
      assert.deepEqual(roots.map((x) => x.alias), ['live']);
      assert.equal(roots[0].display, '$HOOK_TELEMETRY_DIR');
      const rel = runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home, { HOOK_TELEMETRY_DIR: 'relative-dir' }) });
      assert.equal(rel.status, 0);
      assert.equal(q(ctx.home, 'SELECT display FROM source_root WHERE source = \'otel\' AND alias = \'live\'')[0].display.startsWith('~'), true);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('OTel ingest of both directories', () => {
  it('stores 14 events and 7 metrics: the prefix copy and the identical metrics copy add nothing, the preserve-only day adds 2', () => {
    const { ctx, r } = ingested({ preserve: true });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM otel_event')[0].n, OTEL_EXPECTED.both.events);
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM otel_metric')[0].n, OTEL_EXPECTED.both.metrics);
      assert.match(r.stdout, new RegExp(`^otel: files=5 new=5 reread=0 unchanged=0 skipped=0 bytes=\\d+ lines=49 assistant=${OTEL_EXPECTED.both.parsed} kept=${OTEL_EXPECTED.both.kept} `, 'm'));
      const roots = q(ctx.home, 'SELECT alias, kind FROM source_root WHERE source = \'otel\' ORDER BY alias');
      assert.deepEqual(roots.map((x) => [x.alias, x.kind]), [['live', 'live'], ['preserve', 'preserve']]);
      const files = q(ctx.home, 'SELECT r.alias || \':\' || f.rel_path AS p FROM source_file f JOIN source_root r ON r.root_id = f.root_id WHERE r.source = \'otel\'').map((x) => x.p).sort();
      assert.deepEqual(files, [...OTEL_EXPECTED.sourceFiles].sort());
      assert.deepEqual(counts(ctx.home, 'dropped'), OTEL_EXPECTED.dropped.both);
      assert.deepEqual(counts(ctx.home, 'rejected_field'), OTEL_EXPECTED.rejected.both);
      assert.deepEqual(unknownAttr(ctx.home), OTEL_EXPECTED.unknownAttr.both);
      const [src] = q(ctx.home, 'SELECT * FROM ingest_source_run WHERE source = \'otel\'');
      assert.equal(src.rows_upserted, OTEL_EXPECTED.both.rowsUpserted);
    } finally {
      ctx.cleanup();
    }
  });

  it('prints the otel line next to the transcript line and a second run reads 0 bytes', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['tracer-base'] });
      buildOtelTree(ctx.home, { preserve: true });
      const first = runCli(['ingest'], { home: ctx.home });
      assert.equal(first.status, 0, first.stderr);
      const lines = first.stdout.split('\n');
      const at = (p) => lines.findIndex((l) => l.startsWith(p));
      assert.ok(at('otel: files=') >= 0 && at('transcript: files=') >= 0, 'both progress lines');
      const second = runCli(['ingest'], { home: ctx.home });
      assert.match(second.stdout, /^otel: files=5 new=0 reread=0 unchanged=5 skipped=0 bytes=0 lines=0 assistant=0 kept=0 /m);
      assert.equal(second.status, 0);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('HOMEs without OTel directories', () => {
  it('print otel: files=0 and store nothing', () => {
    const ctx = makeHome();
    try {
      const r = runCli(['ingest'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^otel: files=0 /m);
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM otel_event')[0].n, 0);
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM otel_metric')[0].n, 0);
      assert.ok(existsSync(liveDirFor(ctx.home)) === false && existsSync(preserveDirFor(ctx.home)) === false);
    } finally {
      ctx.cleanup();
    }
  });
});
