// The OTel join, role precedence, harness rule, effort fill, cross-check and invariance of the derivation pass
// (plan 01-07, COST-02, COST-03, COST-05, COST-06, TRUST-01, D-06, D-12). Written before the code (RED).
// Expected values are hand-computed in test/fixtures/cases/97-otel-join.mjs or beside the direct-row cases
// below, never by the code under test. derived.db is read defensively (queryOrEmpty), modules that do not exist
// before this plan are imported dynamically, so a missing table, column or module fails an assertion. No planted
// value is printed in a failure message.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  buildFixtureTree, cliEnv, makeHome, runCli, shuffleLines, stateDirOf, windowsUsersDirFor,
} from '../fixtures/build.mjs';
import { derivedDigest, insertMessage, insertMeta, queryOrEmpty } from '../fixtures/derive-rows.mjs';
import { apiRequestAttrs, insertOtelEvent, openTempStore, otelDigest } from '../fixtures/otel-rows.mjs';
import { OTEL_PLANTS, liveDirFor, scanBuffers } from '../fixtures/otel.mjs';
import { O8_KEY, OTEL_FILE, expectedJoin } from '../fixtures/cases/97-otel-join.mjs';
import { Db, openDerivedReadOnly, storePath } from '../../src/db.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const tryMod = async (rel) => { try { return await mod(rel); } catch { return {}; } };
const J = expectedJoin;
const NOW = () => new Date('2026-10-28T05:00:00.000Z');
const DERIVED = (home) => join(stateDirOf(home), 'derived.db');
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function withDerived(home, fn) {
  const db = openDerivedReadOnly({ home });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const q = (home, sql, params) => withDerived(home, (db) => queryOrEmpty(db, sql, params));
const lineStarting = (stdout, prefix) => stdout.split('\n').find((l) => l.startsWith(prefix)) ?? null;
const cli = (home, args) => runCli(args, { home, env: cliEnv(home) });

// Builds the case under a fresh HOME, ingests in-process with a fixed clock and rebuilds derived.db.
async function caseDerived({ order, shuffle = false, otelRule, cases = ['otel-join'], beforeIngest } = {}) {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases });
  if (shuffle) {
    const walk = (d) => {
      if (!existsSync(d)) return;
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (n.endsWith('.jsonl')) shuffleLines(p, 11);
      }
    };
    walk(join(ctx.root, 'projects'));
    walk(liveDirFor(ctx.home));
  }
  if (beforeIngest) beforeIngest(ctx);
  const { runIngest } = await mod('ingest/run.mjs');
  await runIngest({ home: ctx.home, env: { HOME: ctx.home }, windowsUsersDir: windowsUsersDirFor(ctx.home), now: NOW, order });
  const { rebuildDerived } = await mod('derive/rebuild.mjs');
  rebuildDerived({ home: ctx.home, now: NOW, otelRule });
  return ctx;
}

// A store written directly: messages (cc_message rows), metas and OTel events, then one rebuild.
async function directDerived({ messages = [], metas = [], events = [] }, { otelRule } = {}) {
  const ctx = makeHome();
  const db = openTempStore({ home: ctx.home });
  try {
    for (const m of messages) insertMessage(db, m);
    for (const m of metas) insertMeta(db, m);
    for (const e of events) insertOtelEvent(db, e);
    db.exec("INSERT INTO ingest_run (started_utc, ended_utc, trigger) VALUES ('2026-10-28T04:00:00.000Z', '2026-10-28T04:00:01.000Z', 'manual')");
  } finally {
    db.close();
  }
  const { rebuildDerived } = await mod('derive/rebuild.mjs');
  rebuildDerived({ home: ctx.home, now: NOW, otelRule });
  return ctx;
}

const SX = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const SY = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
// A transcript call row (haiku 10/10/0/0 unless given): 1,000 + 5,000 = 6,000 nano.
const msg = (id, over = {}) => ({
  session_id: SX, agent_id: '', message_id: id, request_id: `req-${id}`, ts_utc: '2026-10-27T10:00:00.000Z', model: 'claude-haiku-5-5',
  input_tokens: 10, output_tokens: 10, cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0, effort: 'high', ...over,
});
// An OTel api_request event row.
const ev = ({
  session = SX, seq, ts = '2026-10-27T10:00:01.000Z', requestId, kind = 'api_request', ...attrs
}) => ({
  sessionId: session, seq, eventTs: ts, tsUtc: ts, kind, requestId: requestId ?? null, attrs: apiRequestAttrs({ requestId, ...attrs }),
});
const stat = (home) => Object.fromEntries(q(home, 'SELECT name, n FROM join_stat').map((r) => [r.name, r.n]));
const call = (home, key) => q(home, 'SELECT * FROM api_call WHERE call_key = ?', [key])[0] ?? {};

describe('join on case otel-join', () => {
  let ctx;
  before(async () => { ctx = await caseDerived(); });
  after(() => ctx.cleanup());

  it('sets join_state per call: six joined, two transcript_only, nine otel_only', () => {
    const rows = q(ctx.home, "SELECT message_id, join_state FROM api_call WHERE call_key LIKE 'm:%' ORDER BY message_id");
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.message_id, r.join_state])), J.joinState);
    const only = q(ctx.home, "SELECT call_key FROM api_call WHERE join_state = 'otel_only' ORDER BY call_key").map((r) => r.call_key);
    assert.deepEqual(only, Object.keys(J.otelOnlyNano).sort());
  });

  it('stores every join_stat figure with its hand-computed value', () => {
    assert.deepEqual(stat(ctx.home), J.joinStat);
  });

  it('a joined request never becomes an otel_only call and every unjoined request is exactly one', () => {
    const st = stat(ctx.home);
    const only = q(ctx.home, "SELECT count(*) AS n FROM api_call WHERE join_state = 'otel_only'")[0]?.n;
    assert.equal(only, st.otel_requests - st.joined, 'otel_only calls = requests - joined requests');
    const joinedKeys = q(ctx.home, "SELECT request_key FROM otel_call WHERE state = 'joined'").map((r) => `o:${r.request_key}`);
    assert.equal(joinedKeys.length, 6);
    const clash = q(ctx.home, `SELECT count(*) AS n FROM api_call WHERE call_key IN (${joinedKeys.map(() => '?').join(',')})`, joinedKeys);
    assert.equal(clash[0]?.n, 0);
  });

  it('keys an event without request_id as e:<session>:<sequence>:<event time>', () => {
    const c = call(ctx.home, `o:${O8_KEY}`);
    assert.equal(c.join_state, 'otel_only');
    assert.equal(c.request_id, null);
    assert.deepEqual([c.role, c.role_rule, c.role_source], ['main', 'query_source_main', 'otel']);
  });

  it('gives every call its role, rule and source by the full precedence', () => {
    const rows = q(ctx.home, 'SELECT call_key, role, role_rule, role_source FROM api_call ORDER BY call_key');
    const got = Object.fromEntries(rows.map((r) => [r.call_key, [r.role, r.role_rule, r.role_source]]));
    assert.deepEqual(got, Object.fromEntries(Object.entries(J.roles).sort(([a], [b]) => (a < b ? -1 : 1))));
  });

  it('records the parsed query_source role and its conflict with the transcript role', () => {
    for (const [key, [qsRole, conflict]] of Object.entries(J.qs)) {
      const c = call(ctx.home, key);
      assert.equal(c.qs_role, qsRole, `qs_role of ${key}`);
      assert.equal(c.qs_conflict, conflict, `qs_conflict of ${key}`);
    }
    assert.equal(call(ctx.home, 'm:msg_oj_a').qs_role, null, 'repl_main_thread parses to no role');
    assert.equal(call(ctx.home, 'm:msg_oj_e').qs_role, null, 'agent:custom parses to no role');
  });

  it('fills effort from OTel only when the transcript has none, and records its source', () => {
    for (const [key, [effort, source]] of Object.entries(J.effort)) {
      const c = call(ctx.home, key);
      assert.equal(c.effort, effort, `effort of ${key}`);
      assert.equal(c.effort_source, source, `effort_source of ${key}`);
    }
  });

  it('classifies the agent-name cross-check of every joined call, never using the name as a role', () => {
    for (const [key, state] of Object.entries(J.xcheck)) assert.equal(call(ctx.home, key).xcheck, state, `xcheck of ${key}`);
    assert.equal(call(ctx.home, 'm:msg_oj_c').role, 'fork', 'the OTel name general-purpose did not become the role');
  });

  it('keeps the derived cost of joined calls and takes OTel cost only for otel_only calls', () => {
    const rows = q(ctx.home, "SELECT message_id, cost_nano, cost_label, token_label FROM api_call WHERE call_key LIKE 'm:%' ORDER BY message_id");
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.message_id, r.cost_nano])), J.derivedNano);
    for (const r of rows) assert.deepEqual([r.cost_label, r.token_label], ['derived', 'transcript']);
    const only = q(ctx.home, "SELECT call_key, cost_nano, cost_label, token_label, price_basis FROM api_call WHERE join_state = 'otel_only'");
    assert.deepEqual(Object.fromEntries(only.map((r) => [r.call_key, r.cost_nano])), J.otelOnlyNano);
    for (const r of only) assert.deepEqual([r.cost_label, r.token_label, r.price_basis], ['otel', 'otel', 'otel_executor_only']);
  });

  it('stores the measured cost of each joined request from the owner event, and its derived cost', () => {
    const rows = q(ctx.home, "SELECT request_key, cost_nano, derived_nano, transcript_calls, occurrences, conflicting FROM otel_call WHERE state = 'joined' ORDER BY request_key");
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.request_key, r.cost_nano])), J.measuredNano);
    const d = J.derivedNano;
    assert.deepEqual(rows.map((r) => r.derived_nano), [d.msg_oj_a, d.msg_oj_b, d.msg_oj_c, d.msg_oj_d, d.msg_oj_e, d.msg_oj_g]);
    assert.deepEqual(rows.map((r) => [r.transcript_calls, r.occurrences, r.conflicting]), [[1, 2, 1], [1, 1, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0]]);
  });

  it('puts each call in one section and gives each otel_only call one message part with its OTel tokens', () => {
    const rows = q(ctx.home, 'SELECT section, count(*) AS n FROM api_call GROUP BY section ORDER BY section');
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.section, r.n])), J.sections);
    const parts = q(ctx.home, `SELECT p.part_seq, p.kind, p.input_tokens, p.output_tokens, p.cache_read, p.cache_creation, p.price_status, p.cost_nano
      FROM api_call_part p WHERE p.call_key = 'o:req_oo_5'`);
    assert.deepEqual(parts, [{
      part_seq: 0, kind: 'message', input_tokens: 100, output_tokens: 100, cache_read: 200, cache_creation: 0, price_status: 'otel_measured', cost_nano: 62000,
    }]);
  });

  it('the window query sees the nine otel_only parts (a non-NULL time and token label otel)', () => {
    const n = q(ctx.home, `SELECT count(*) AS n FROM api_call_part p JOIN api_call c ON c.call_key = p.call_key
      WHERE c.ts_utc IS NOT NULL AND c.token_label = 'otel'`)[0]?.n;
    assert.equal(n, 9);
  });

  it('the sum over the three sections equals the total for every token class', () => {
    for (const c of ['input_tokens', 'output_tokens', 'cache_read', 'cache_creation', 'cache_5m', 'cache_1h']) {
      const r = q(ctx.home, `SELECT (SELECT sum(s) FROM (SELECT sum(p.${c}) AS s FROM api_call_part p JOIN api_call a ON a.call_key = p.call_key GROUP BY a.section)) AS by_section,
        (SELECT sum(${c}) FROM api_call_part) AS total, (SELECT count(DISTINCT section) FROM api_call) AS sections`)[0] ?? {};
      assert.equal(r.sections, 3, 'three sections exist');
      assert.equal(r.by_section, r.total, `${c}: sections sum to the total`);
    }
  });

  it('the hostile query_source label and agent name reach no byte of the databases, and the scan has teeth', async () => {
    const dir = stateDirOf(ctx.home);
    const { checkpointStore } = await mod('db.mjs');
    checkpointStore({ home: ctx.home });
    const needles = [OTEL_PLANTS.hostileLabel, OTEL_PLANTS.hostileAgentName];
    const bufs = ['store.db', 'store.db-wal', 'store.db-shm', 'derived.db'].filter((n) => existsSync(join(dir, n)))
      .map((n) => ({ label: n, buf: readFileSync(join(dir, n)) }));
    const report = cli(ctx.home, ['cost', '--by', 'role,model']);
    bufs.push({ label: 'stdout', buf: Buffer.from(report.stdout) }, { label: 'stderr', buf: Buffer.from(report.stderr) });
    assert.deepEqual(scanBuffers(bufs, needles, { email: false }), []);
    const tainted = Buffer.concat([readFileSync(join(dir, 'derived.db')), Buffer.from(needles[1])]);
    assert.equal(scanBuffers([{ label: 'tainted', buf: tainted }], needles, { email: false }).length, 1, 'the scan finds a planted copy');
    assert.equal(call(ctx.home, 'o:req_oo_7').role, 'unknown');
    assert.ok(report.stdout.includes('otel-only calls'), 'the report ran with the OTel blocks');
  });

  it('every OTel-sourced text column of otel_call and api_call matches its shape constant', async () => {
    const { QS_SHAPE, AGENT_NAME_SHAPE } = await tryMod('derive/query-source.mjs');
    assert.ok(QS_SHAPE instanceof RegExp && AGENT_NAME_SHAPE instanceof RegExp, 'query-source.mjs exports the shapes');
    const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/; // the 01-03 name shape for model and effort
    const oc = q(ctx.home, 'SELECT query_source, agent_name, model, effort FROM otel_call');
    assert.equal(oc.length, 15);
    for (const r of oc) {
      if (r.query_source !== null) assert.match(r.query_source, QS_SHAPE);
      if (r.agent_name !== null) assert.match(r.agent_name, AGENT_NAME_SHAPE);
      if (r.model !== null) assert.match(r.model, NAME);
      if (r.effort !== null) assert.match(r.effort, NAME);
    }
    for (const r of q(ctx.home, 'SELECT qs, qs_role, otel_agent_name, role FROM api_call')) {
      if (r.qs !== null) assert.match(r.qs, QS_SHAPE);
      if (r.qs_role !== null) assert.match(r.qs_role, AGENT_NAME_SHAPE);
      if (r.otel_agent_name !== null) assert.match(r.otel_agent_name, AGENT_NAME_SHAPE);
    }
    const o7 = q(ctx.home, "SELECT query_source, agent_name FROM otel_call WHERE request_key = 'req_oo_7'")[0] ?? {};
    assert.deepEqual([o7.query_source, o7.agent_name], [null, null]);
  });

  it('a tampered otel_only part is caught by checkConservation, which still returns its usual keys', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'rigorscope-join-tamper-'));
    try {
      const file = join(copy, 'derived.db');
      writeFileSync(file, readFileSync(DERIVED(ctx.home)));
      const { checkConservation } = await mod('derive/conservation.mjs');
      const ok = new Db(file, { readOnly: true });
      try {
        assert.equal(checkConservation(ok).ok, true, 'conserved before the tamper');
      } finally {
        ok.close();
      }
      const w = new Db(file);
      try {
        w.exec("UPDATE api_call_part SET input_tokens = input_tokens + 5 WHERE call_key = 'o:req_oo_6'");
        const r = checkConservation(w);
        assert.equal(r.ok, false, 'the tamper is a violation');
        assert.deepEqual(Object.keys(r).sort(), ['classes', 'counts', 'ok', 'violations']);
        const v = r.violations.find((x) => x.column === 'input_tokens');
        assert.ok(v && Object.hasOwn(v, 'sections'), 'the violation names input_tokens with its sections sum');
      } finally {
        w.close();
      }
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});

describe('join rules on direct rows', () => {
  it('an api_error or assistant_response with a request_id never creates a request, a join or an otel_only call', async () => {
    const ctx = await directDerived({
      messages: [msg('m1')],
      events: [
        ev({ seq: 1, kind: 'api_error', requestId: 'req-m1', model: 'claude-haiku-5-5' }),
        ev({ seq: 2, kind: 'assistant_response', requestId: 'req-m1', model: 'claude-haiku-5-5' }),
      ],
    });
    try {
      assert.equal(call(ctx.home, 'm:m1').join_state, 'transcript_only');
      assert.equal(stat(ctx.home).otel_requests, 0);
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM api_call')[0]?.n, 1);
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM otel_call')[0]?.n, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it('a request shared by two transcript calls joins both, counts once, and its derived cost is their sum', async () => {
    const ctx = await directDerived({
      messages: [msg('m1', { request_id: 'req-shared' }), msg('m2', { request_id: 'req-shared', input_tokens: 20 })],
      events: [ev({ seq: 1, requestId: 'req-shared', model: 'claude-haiku-5-5', input: 30, output: 20, costUsd: 0.000013 })],
    });
    try {
      assert.equal(call(ctx.home, 'm:m1').join_state, 'joined');
      assert.equal(call(ctx.home, 'm:m2').join_state, 'joined');
      const st = stat(ctx.home);
      assert.deepEqual([st.otel_requests, st.joined, st.joined_calls, st.multi_message_requests], [1, 1, 2, 1]);
      const oc = q(ctx.home, 'SELECT derived_nano, transcript_calls, cost_nano FROM otel_call')[0] ?? {};
      // m1 6,000 + m2 (20 x 100 + 10 x 500 = 7,000) = 13,000; measured 0.000013 -> 13,000
      assert.deepEqual([oc.derived_nano, oc.transcript_calls, oc.cost_nano], [13000, 2, 13000]);
      const r = cli(ctx.home, ['cost']);
      assert.match(lineStarting(r.stdout, 'error-band:') ?? '', /^error-band: joined n=1 median_abs_err=0\.00% /);
      assert.match(lineStarting(r.stdout, 'join:') ?? '', / multi_message_requests=1$/);
    } finally {
      ctx.cleanup();
    }
  });

  it('a shared request with one unpriced call has a NULL derived cost and is excluded from the band as derived_unknown', async () => {
    const ctx = await directDerived({
      messages: [msg('m1', { request_id: 'req-shared' }), msg('m2', { request_id: 'req-shared', model: 'claude-mystery-9-9' })],
      events: [ev({ seq: 1, requestId: 'req-shared', model: 'claude-haiku-5-5', input: 20, output: 20, costUsd: 0.00002 })],
    });
    try {
      const oc = q(ctx.home, 'SELECT derived_nano FROM otel_call')[0] ?? {};
      assert.equal(oc.derived_nano, null);
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM otel_call')[0]?.n, 1);
      const r = cli(ctx.home, ['cost']);
      assert.equal(r.status, 0);
      assert.equal(lineStarting(r.stdout, 'error-band:'),
        'error-band: joined n=0 median_abs_err=? p99_abs_err=? max_abs_err=? sum_derived=? sum_measured=? diff=? (?) '
        + 'excluded=derived_unknown:1,measured_unknown:0,zero_measured:0 top_level_only=0 floor=0 measured=otel derived=notional');
    } finally {
      ctx.cleanup();
    }
  });

  it('a joined harness call keeps its transcript tokens in the main section with role harness and is counted', async () => {
    const ctx = await directDerived({
      messages: [msg('m1')],
      events: [ev({ seq: 1, requestId: 'req-m1', model: 'claude-haiku-5-5', input: 10, output: 10, costUsd: 0.000006, querySource: 'agent_summary' })],
    });
    try {
      const c = call(ctx.home, 'm:m1');
      assert.deepEqual([c.role, c.role_rule, c.role_source, c.section, c.join_state, c.token_label],
        ['harness:agent_summary', 'harness', 'otel', 'main', 'joined', 'transcript']);
      const st = stat(ctx.home);
      assert.deepEqual([st.harness_requests, st.harness_joined], [1, 1]);
      const r = cli(ctx.home, ['cost']);
      assert.match(lineStarting(r.stdout, 'roles:') ?? '', / harness_joined=1$/);
      assert.match(lineStarting(r.stdout, 'join:') ?? '', / joinable=0\/0 \(\?\) excl_sdk=0\/0 \(\?\) /);
    } finally {
      ctx.cleanup();
    }
  });

  it('a zero denominator prints 0/0 (?), never a percentage', async () => {
    const ctx = await directDerived({
      events: [ev({ seq: 1, requestId: 'req-h1', model: 'claude-haiku-5-5', input: 1, output: 1, costUsd: 0.000001, querySource: 'away_summary' })],
    });
    try {
      const r = cli(ctx.home, ['cost']);
      assert.equal(r.status, 0);
      assert.match(lineStarting(r.stdout, 'join:') ?? '', /^join: otel_requests=1 joined=0 raw=0\/1 \(0\.00%\) joinable=0\/0 \(\?\) excl_sdk=0\/0 \(\?\) /);
    } finally {
      ctx.cleanup();
    }
  });

  it('identical duplicates count once, are not conflicting, and the owner rule does not change the content', async () => {
    const two = [
      ev({ seq: 4, requestId: 'req-d', model: 'claude-haiku-5-5', input: 5, output: 5, costUsd: 0.000003 }),
      ev({ seq: 9, requestId: 'req-d', model: 'claude-haiku-5-5', input: 5, output: 5, costUsd: 0.000003 }),
    ];
    const a = await directDerived({ events: two }, { otelRule: 'earliest' });
    const b = await directDerived({ events: two }, { otelRule: 'latest' });
    try {
      const st = stat(a.home);
      assert.deepEqual([st.otel_requests, st.duplicates, st.conflicting_duplicates], [1, 1, 0]);
      const da = withDerived(a.home, (db) => [otelDigest(db), derivedDigest(db)]);
      const dbb = withDerived(b.home, (db) => [otelDigest(db), derivedDigest(db)]);
      assert.deepEqual(da, dbb);
      assert.equal(q(a.home, 'SELECT count(*) AS n FROM otel_call')[0]?.n, 1);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('equal times written differently fall to session then sequence, never to text order', async () => {
    const ctx = await directDerived({
      events: [
        // As text '...01.000Z' sorts before '...01Z'; as instants they tie, so sequence 1 owns the request.
        ev({ seq: 2, ts: '2026-10-27T10:00:01.000Z', requestId: 'req-t', model: 'claude-haiku-5-5', input: 1, output: 1, costUsd: 0.000002 }),
        ev({ seq: 1, ts: '2026-10-27T10:00:01Z', requestId: 'req-t', model: 'claude-haiku-5-5', input: 1, output: 1, costUsd: 0.000007 }),
      ],
    });
    try {
      const oc = q(ctx.home, 'SELECT cost_nano, occurrences, conflicting FROM otel_call')[0] ?? {};
      assert.deepEqual([oc.cost_nano, oc.occurrences, oc.conflicting], [7000, 2, 1]);
    } finally {
      ctx.cleanup();
    }
  });

  it('cost forms: cost_usd before micros, micros alone, neither NULL, zero kept, a string-typed count NULL', async () => {
    const ctx = await directDerived({
      events: [
        ev({ seq: 1, requestId: 'r-both', model: 'claude-haiku-5-5', input: 1, output: 1, costUsd: 0.000005, costMicros: 9, querySource: 'agent:builtin:Alpha' }),
        ev({ seq: 2, requestId: 'r-micros', model: 'claude-haiku-5-5', input: 1, output: 1, costMicros: 7, querySource: 'agent:builtin:Beta' }),
        ev({ seq: 3, requestId: 'r-none', model: 'claude-haiku-5-5', input: 1, output: 1, querySource: 'agent:builtin:Gamma' }),
        ev({ seq: 4, requestId: 'r-zero', model: 'claude-haiku-5-5', input: 1, output: 1, costUsd: 0, querySource: 'agent:builtin:Delta' }),
        ev({ seq: 5, requestId: 'r-text', model: 'claude-haiku-5-5', input: '12', output: 1, costUsd: 0.000001, querySource: 'agent:builtin:Eps' }),
      ],
    });
    try {
      const rows = q(ctx.home, 'SELECT request_key, cost_nano, input_tokens FROM otel_call ORDER BY request_key');
      assert.deepEqual(rows.map((r) => [r.request_key, r.cost_nano, r.input_tokens]), [
        ['r-both', 5000, 1], ['r-micros', 7000, 1], ['r-none', null, 1], ['r-text', 1000, null], ['r-zero', 0, 1],
      ]);
      const parts = q(ctx.home, "SELECT c.call_key, p.price_status, c.cost_label FROM api_call c JOIN api_call_part p ON p.call_key = c.call_key WHERE c.call_key IN ('o:r-none', 'o:r-zero') ORDER BY c.call_key");
      assert.deepEqual(parts.map((r) => [r.call_key, r.price_status, r.cost_label]), [['o:r-none', 'otel_no_cost', 'unavailable'], ['o:r-zero', 'otel_measured', 'otel']]);
      const r = cli(ctx.home, ['cost', '--by', 'role']);
      assert.equal(r.status, 0);
      const row = (role) => r.stdout.split('\n').find((l) => l.trim().split(/\s+/)[0] === role)?.trim().split(/\s+/) ?? [];
      assert.equal(row('Gamma')[6], '?', 'a NULL OTel cost renders ?');
      assert.equal(row('Delta')[6], '0.000000', 'a measured 0 renders 0.000000');
      assert.equal(row('Eps')[2], '?', 'a string-typed count renders ?');
      assert.match(lineStarting(r.stdout, 'otel-only:') ?? '', / input>=4\(1 unknown\) .* usd>=0\.000013\(1 unknown\) label=otel /);
    } finally {
      ctx.cleanup();
    }
  });

  it('a measured 0 and a missing measured cost are excluded from the band by their own reasons', async () => {
    const ctx = await directDerived({
      messages: [msg('m1'), msg('m2')],
      events: [
        ev({ seq: 1, requestId: 'req-m1', model: 'claude-haiku-5-5', input: 10, output: 10, costUsd: 0 }),
        ev({ seq: 2, requestId: 'req-m2', model: 'claude-haiku-5-5', input: 10, output: 10 }),
      ],
    });
    try {
      const r = cli(ctx.home, ['cost']);
      assert.equal(r.status, 0);
      assert.match(lineStarting(r.stdout, 'error-band:') ?? '', /^error-band: joined n=0 .* excluded=derived_unknown:0,measured_unknown:1,zero_measured:1 /);
    } finally {
      ctx.cleanup();
    }
  });

  it('sdk is not a harness source: a joined sdk call keeps its transcript role, an otel_only sdk call is unknown', async () => {
    const ctx = await directDerived({
      messages: [msg('m1', { attribution_agent: 'gsd-planner', agent_id: 'agent0000000000aa' })],
      events: [
        ev({ seq: 1, requestId: 'req-m1', model: 'claude-haiku-5-5', input: 10, output: 10, costUsd: 0.000006, querySource: 'sdk' }),
        ev({ seq: 2, requestId: 'req-x', model: 'claude-haiku-5-5', input: 1, output: 1, costUsd: 0.000001, querySource: 'sdk' }),
      ],
    });
    try {
      assert.deepEqual([call(ctx.home, 'm:m1').role, call(ctx.home, 'm:m1').role_rule], ['gsd-planner', 'attribution']);
      const x = call(ctx.home, 'o:req-x');
      assert.deepEqual([x.role, x.role_rule, x.section], ['unknown', 'none', 'otel']);
      const st = stat(ctx.home);
      assert.deepEqual([st.sdk_requests, st.sdk_joined, st.harness_requests], [2, 1, 0]);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('owner rule, invariance and rebuilds', () => {
  it('owner rule latest picks the later of two conflicting duplicates and changes the measured cost', async () => {
    const a = await caseDerived();
    const b = await caseDerived({ otelRule: 'latest' });
    try {
      const cost = (h) => q(h, "SELECT cost_nano FROM otel_call WHERE request_key = 'req_oj_a'")[0]?.cost_nano;
      assert.equal(cost(a.home), 600000, 'earliest: oA (0.0006)');
      assert.equal(cost(b.home), 900000, 'latest: oA2 (0.0009)');
      assert.notEqual(withDerived(a.home, otelDigest), withDerived(b.home, otelDigest));
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('an unknown OTel owner rule name throws before any file is touched', async () => {
    const { otelOwnerOrderBy } = await tryMod('derive/otel-owner.mjs');
    assert.equal(typeof otelOwnerOrderBy, 'function', 'otel-owner.mjs exports otelOwnerOrderBy');
    assert.throws(() => otelOwnerOrderBy('newest'), RangeError);
    assert.throws(() => otelOwnerOrderBy('unixepoch(ts_utc) DESC'), RangeError);
    assert.throws(() => otelOwnerOrderBy(1), RangeError);
    assert.match(otelOwnerOrderBy('earliest'), /^unixepoch\(ts_utc,'subsec'\) ASC NULLS LAST, session_id ASC NULLS LAST, event_seq ASC NULLS LAST, event_ts ASC NULLS LAST$/);
  });

  it('adding the OTel files leaves every transcript-sourced token and cost column unchanged', async () => {
    const withOtel = await caseDerived();
    const without = await caseDerived({ beforeIngest: (ctx) => rmSync(join(liveDirFor(ctx.home), OTEL_FILE)) });
    try {
      const cols = (h) => q(h, `SELECT c.call_key, c.message_id, c.cost_nano, c.cost_floor, c.cost_label, c.token_label, c.price_basis,
          p.part_seq, p.model, p.input_tokens, p.output_tokens, p.cache_read, p.cache_creation, p.cache_5m, p.cache_1h,
          p.price_status, p.price_tier, p.cost_nano AS part_nano
        FROM api_call c JOIN api_call_part p ON p.call_key = c.call_key WHERE c.call_key LIKE 'm:%' ORDER BY c.call_key, p.part_seq`);
      const a = cols(withOtel.home);
      assert.equal(a.length, 8);
      assert.deepEqual(a, cols(without.home));
      assert.equal(q(withOtel.home, "SELECT count(*) AS n FROM api_call WHERE join_state = 'joined'")[0]?.n, 6, 'the OTel files were joined');
    } finally {
      withOtel.cleanup();
      without.cleanup();
    }
  });

  it('reversed unit order and shuffled lines give the same derived and OTel digests', async () => {
    const a = await caseDerived();
    const b = await caseDerived({ order: 'reverse', shuffle: true });
    try {
      const da = withDerived(a.home, (db) => [derivedDigest(db), otelDigest(db)]);
      const dbb = withDerived(b.home, (db) => [derivedDigest(db), otelDigest(db)]);
      assert.deepEqual(da, dbb);
      assert.equal(q(a.home, 'SELECT count(*) AS n FROM otel_call')[0]?.n, 15, 'the OTel requests were derived');
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('a second rebuild of the same store gives the same digests', async () => {
    const ctx = await caseDerived();
    try {
      const first = withDerived(ctx.home, (db) => [derivedDigest(db), otelDigest(db)]);
      const { rebuildDerived } = await mod('derive/rebuild.mjs');
      rebuildDerived({ home: ctx.home, now: NOW });
      assert.deepEqual(withDerived(ctx.home, (db) => [derivedDigest(db), otelDigest(db)]), first);
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM join_stat')[0]?.n, 16, 'sixteen join_stat rows');
    } finally {
      ctx.cleanup();
    }
  });

  it('ensureDerived rebuilds with reason store_fingerprint after an ingest that stored OTel events', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['otel-join'] });
      const file = join(liveDirFor(ctx.home), OTEL_FILE);
      const aside = join(ctx.home, 'otel-aside.jsonl');
      renameSync(file, aside);
      assert.equal(cli(ctx.home, ['ingest']).status, 0);
      const { ensureDerived } = await mod('derive/ensure.mjs');
      assert.equal(ensureDerived({ home: ctx.home }).rebuilt, true);
      assert.equal(ensureDerived({ home: ctx.home }).rebuilt, false, 'nothing stale');
      renameSync(aside, file);
      assert.equal(cli(ctx.home, ['ingest']).status, 0);
      assert.deepEqual(ensureDerived({ home: ctx.home }), { rebuilt: true, reason: 'store_fingerprint' });
      assert.equal(q(ctx.home, 'SELECT count(*) AS n FROM otel_call')[0]?.n, 15);
      assert.ok(existsSync(storePath(ctx.home)));
    } finally {
      ctx.cleanup();
    }
  });
});

describe('static scans of the derivation and report code', () => {
  const files = (dir) => readdirSync(join(SRC, dir)).filter((n) => n.endsWith('.mjs')).map((n) => join(SRC, dir, n));
  // Needles are split so this file does not contain them.
  const NEEDLES = ['subagent' + '_completed', 'total' + '_tokens'];

  it('no file under src/derive or src/report names the run-level sub-agent token total or its event kind', () => {
    const all = [...files('derive'), ...files('report')];
    assert.ok(all.length >= 10);
    for (const f of all) {
      const text = readFileSync(f, 'utf8');
      for (const n of NEEDLES) assert.ok(!text.includes(n), `a needle appears in ${f.slice(SRC.length)}`);
    }
  });

  it('rebuild.mjs calls fillOtel after fillDerived and before fillWindows', () => {
    const text = readFileSync(join(SRC, 'derive', 'rebuild.mjs'), 'utf8');
    const at = (s) => text.indexOf(s);
    assert.ok(at('fillOtel({') > 0, 'rebuild.mjs calls fillOtel');
    assert.ok(at('fillDerived({') < at('fillOtel({') && at('fillOtel({') < at('fillWindows({'), 'fillDerived, fillOtel, fillWindows in that order');
  });

  it('the OTel pass selects only api_request events and writes nothing to the attached store', () => {
    const p = join(SRC, 'derive', 'otel-fill.mjs');
    assert.ok(existsSync(p), 'otel-fill.mjs exists');
    const text = readFileSync(p, 'utf8') + readFileSync(join(SRC, 'derive', 'otel-owner.mjs'), 'utf8');
    assert.ok(text.includes("kind = 'api_request'"), 'the kind filter is a literal');
    assert.ok(!/\b(INSERT|UPDATE|DELETE)\s+(INTO\s+)?s\./i.test(text), 'no write to schema s');
    assert.ok(!/kind\s*(IN|<>|!=)/i.test(text), 'no other kind is selected');
  });
});
