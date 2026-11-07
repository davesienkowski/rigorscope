// Transcript source, ingest, derive and report units. Written before the modules.
//
// Assumed API (the contract Task 3 implements):
//   listTranscriptFiles(root)          sync -> full paths of projects/*/*.jsonl, sorted bytewise
//   readCandidateLines(file)           async iterable of lines that hold the assistant marker (CR stripped)
//   parseCandidate(text)               { ok: true, obj } | { ok: false, reason: 'unparseable' | 'not-assistant' }
//   normalizeAssistantLine(obj)        { row, rejected }; row is null when the line is dropped
//   runIngest({ home, root, normalize, now })   async -> { files, candidates, assistant, kept, unparseable, rejected }
//   rebuildDerived({ home, now, beforeRename }), loadCostReport({ home }), renderCostText(report)
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLANTS, MSG, EXPECTED_COST_ROWS, EXPECTED_COUNTS, ASSISTANT_MARKER, NEWEST_RECORD_UTC,
  makeHome, buildTranscriptTree, makeAssistant, makeUsage, writeJsonl, queryDb, stateDirOf,
} from '../fixtures/build.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const STORE = (home) => join(stateDirOf(home), 'store.db');
const DERIVED = (home) => join(stateDirOf(home), 'derived.db');

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});
function home() {
  const ctx = makeHome();
  cleanups.push(ctx.cleanup);
  return ctx;
}
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const line = (o) => JSON.stringify(o);
const T1 = '2026-10-27T12:00:01.000Z';
function obj(over = {}) {
  return makeAssistant({
    session: 'sess-1', ts: T1, id: 'msg_a', model: 'claude-opus-5-5', cwd: ['', 'home', PLANTS.osUser].join('/'),
    use: makeUsage({ input: 1, output: 2, read: 3, creation: 4, c5: 5, c1: 6 }),
    ...over,
  });
}

describe('listTranscriptFiles', () => {
  it('returns only regular projects/*/*.jsonl files, as full paths sorted bytewise, whatever the creation order', async () => {
    const { listTranscriptFiles } = await mod('sources/transcript/reader.mjs');
    const root = scratch('rigorscope-list-');
    // Created in reverse order on purpose.
    writeJsonl(join(root, 'projects', 'z', 'b.jsonl'), [line({ a: 1 })]);
    writeJsonl(join(root, 'projects', 'a', 'c.jsonl'), [line({ a: 1 })]);
    writeJsonl(join(root, 'projects', 'a', 'B.jsonl'), [line({ a: 1 })]);
    writeFileSync(join(root, 'projects', 'a', 'note.txt'), 'x');
    writeFileSync(join(root, 'projects', 'a', 'x.meta.json'), '{}');
    writeJsonl(join(root, 'projects', 'a', 'sub', 'deep.jsonl'), [line({ a: 1 })]);
    writeJsonl(join(root, 'projects', 'top.jsonl'), [line({ a: 1 })]);
    writeJsonl(join(root, 'other', 'stray.jsonl'), [line({ a: 1 })]);
    symlinkSync(join(root, 'projects', 'a', 'c.jsonl'), join(root, 'projects', 'a', 'link.jsonl'));
    symlinkSync(join(root, 'projects', 'a'), join(root, 'projects', 'linkdir'));
    const got = listTranscriptFiles(root);
    const want = [
      join(root, 'projects', 'a', 'B.jsonl'),
      join(root, 'projects', 'a', 'c.jsonl'),
      join(root, 'projects', 'z', 'b.jsonl'),
    ];
    assert.deepEqual(got, want);
    assert.deepEqual([...got].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))), got);
  });

  it('returns an empty list when the projects directory is missing', async () => {
    const { listTranscriptFiles } = await mod('sources/transcript/reader.mjs');
    const root = scratch('rigorscope-list-empty-');
    assert.deepEqual(listTranscriptFiles(root), []);
  });
});

describe('readCandidateLines and parseCandidate', () => {
  it('yields only lines holding the assistant marker, strips CR, skips blanks, keeps an unterminated last line', async () => {
    const { readCandidateLines } = await mod('sources/transcript/reader.mjs');
    const dir = scratch('rigorscope-read-');
    const file = join(dir, 's.jsonl');
    const a1 = line({ type: 'assistant', n: 1 });
    const a2 = line({ type: 'assistant', n: 2 });
    const a3 = line({ type: 'assistant', n: 3 });
    writeFileSync(file, [line({ type: 'user', n: 0 }), a1, '', line({ type: 'attachment' }), a2, '', a3].join('\r\n'));
    const got = [];
    for await (const l of readCandidateLines(file)) got.push(l);
    assert.deepEqual(got, [a1, a2, a3]);
    assert.ok(got.every((l) => l.includes(ASSISTANT_MARKER)));
    assert.ok(got.every((l) => !l.endsWith('\r')));
  });

  it('parseCandidate returns not-ok for broken JSON without exposing the parser message or the text', async () => {
    const { parseCandidate } = await mod('sources/transcript/reader.mjs');
    const broken = `{"type":"assistant","${['sec', 'ret'].join('')}":"${PLANTS.prompt}","cut":`;
    const r = parseCandidate(broken);
    assert.deepEqual({ ...r }, { ok: false, reason: 'unparseable' });
    assert.ok(!JSON.stringify(r).includes('CANARY'));
  });

  it('parseCandidate requires a post-parse type of assistant (the marker can sit in a nested object)', async () => {
    const { readCandidateLines, parseCandidate } = await mod('sources/transcript/reader.mjs');
    const text = line({ type: 'user', nested: { type: 'assistant' } });
    assert.ok(text.includes(ASSISTANT_MARKER), 'the marker is present, so the line is a candidate');
    assert.deepEqual({ ...parseCandidate(text) }, { ok: false, reason: 'not-assistant' });
    assert.equal(parseCandidate('[1,2,3]').ok, false);
    assert.equal(parseCandidate('"assistant"').ok, false);
    const ok = parseCandidate(line({ type: 'assistant', x: 1 }));
    assert.equal(ok.ok, true);
    assert.equal(ok.obj.x, 1);
    assert.equal(typeof readCandidateLines, 'function');
  });
});

describe('normalizeAssistantLine', () => {
  it('keeps exactly the allowlisted fields and nothing else', async () => {
    const { normalizeAssistantLine, ALLOWLIST } = await mod('sources/transcript/normalize.mjs');
    const o = obj({ agentId: 'agent01', attributionAgent: 'gsd-executor', content: [{ type: 'text', text: PLANTS.prompt }] });
    const { row, rejected } = normalizeAssistantLine(o);
    assert.deepEqual(rejected, []);
    assert.deepEqual({ ...row }, {
      session_id: 'sess-1', agent_id: 'agent01', message_id: 'msg_a', request_id: 'req_msg_a', ts_utc: T1,
      model: 'claude-opus-5-5', attribution_agent: 'gsd-executor', effort: 'high', version: '2.1.309',
      input_tokens: 1, output_tokens: 2, cache_read: 3, cache_creation: 4, cache_5m: 5, cache_1h: 6,
      speed: 'standard', service_tier: 'standard', inference_geo: 'not_available',
      // added by 01-02 (migration 002); cwd is home-normalized before it is stored
      uuid: 'uuid-msg_a-01', is_sidechain: 1, attribution_skill: null, per_turn_effort: null, advisor_model: null,
      requested_model: null, entrypoint: null, cwd: '~other', has_iterations: 0, has_server_tool_use: 0,
    });
    const text = JSON.stringify(row);
    for (const secret of [PLANTS.osUser, PLANTS.prompt, 'topic/fixture-branch']) assert.ok(!text.includes(secret));
    assert.deepEqual(Object.keys(row).sort(), ALLOWLIST.map((e) => e.column).sort());
  });

  it('exposes the allowlist as unique {source, column, kind} entries including the cache_creation split', async () => {
    const { ALLOWLIST } = await mod('sources/transcript/normalize.mjs');
    assert.ok(Array.isArray(ALLOWLIST));
    for (const e of ALLOWLIST) {
      assert.equal(typeof e.source, 'string');
      assert.equal(typeof e.column, 'string');
      assert.equal(typeof e.kind, 'string');
    }
    assert.equal(new Set(ALLOWLIST.map((e) => e.column)).size, ALLOWLIST.length);
    const sources = ALLOWLIST.map((e) => e.source);
    for (const s of ['sessionId', 'agentId', 'message.id', 'message.model', 'attributionAgent', 'timestamp',
      'message.usage.cache_creation.ephemeral_5m_input_tokens', 'message.usage.cache_creation.ephemeral_1h_input_tokens']) {
      assert.ok(sources.includes(s), s);
    }
  });

  it('stores a hostile attribution agent and a hostile model as NULL and names only the column', async () => {
    const { normalizeAssistantLine } = await mod('sources/transcript/normalize.mjs');
    const a = normalizeAssistantLine(obj({ attributionAgent: PLANTS.hostileAgent }));
    assert.equal(a.row.attribution_agent, null);
    assert.deepEqual(a.rejected, ['attribution_agent']);
    const m = normalizeAssistantLine(obj({ model: PLANTS.hostileModel }));
    assert.equal(m.row.model, null);
    assert.deepEqual(m.rejected, ['model']);
    assert.ok(!JSON.stringify([a, m]).includes('CANARY'), 'rejected values never appear in the result');
  });

  it('drops the line when the session id or message id is missing or invalid (including a 5000-character id)', async () => {
    const { normalizeAssistantLine } = await mod('sources/transcript/normalize.mjs');
    for (const over of [
      { session: undefined }, { session: 'a'.repeat(5000) }, { session: 'has space' },
      { id: undefined }, { id: 'a'.repeat(5000) }, { id: 'msg bad' },
    ]) {
      const { row } = normalizeAssistantLine(obj(over));
      assert.equal(row, null, JSON.stringify(Object.keys(over)));
    }
  });

  it('drops a line with no message.usage and turns a missing agentId into the empty string', async () => {
    const { normalizeAssistantLine } = await mod('sources/transcript/normalize.mjs');
    const noUsage = obj();
    delete noUsage.message.usage;
    assert.equal(normalizeAssistantLine(noUsage).row, null);
    assert.equal(normalizeAssistantLine(obj()).row.agent_id, '');
    assert.equal(normalizeAssistantLine(obj({ agentId: 'bad agent id' })).row, null, 'a present but invalid agent id cannot become part of a key');
  });

  it('counts must be non-negative safe integers: negative, fractional, string, infinite become NULL and are named', async () => {
    const { normalizeAssistantLine } = await mod('sources/transcript/normalize.mjs');
    const o = obj();
    o.message.usage.input_tokens = -1;
    o.message.usage.output_tokens = 1.5;
    o.message.usage.cache_read_input_tokens = '7';
    o.message.usage.cache_creation_input_tokens = Number.POSITIVE_INFINITY;
    const { row, rejected } = normalizeAssistantLine(o);
    assert.equal(row.input_tokens, null);
    assert.equal(row.output_tokens, null);
    assert.equal(row.cache_read, null);
    assert.equal(row.cache_creation, null);
    assert.equal(row.cache_5m, 5, 'untouched counts survive');
    assert.deepEqual([...rejected].sort(), ['cache_creation', 'cache_read', 'input_tokens', 'output_tokens']);
    const z = obj({ use: makeUsage({ input: 0, output: 0, read: 0, creation: 0 }) });
    const r0 = normalizeAssistantLine(z).row;
    assert.deepEqual([r0.input_tokens, r0.output_tokens, r0.cache_read, r0.cache_creation], [0, 0, 0, 0]);
  });

  it('a timestamp or label field that fails its shape becomes NULL and is named', async () => {
    const { normalizeAssistantLine } = await mod('sources/transcript/normalize.mjs');
    const { row, rejected } = normalizeAssistantLine(obj({ ts: '2026-10-27 12:00:01', effort: 'high effort!' }));
    assert.equal(row.ts_utc, null);
    assert.equal(row.effort, null);
    assert.deepEqual([...rejected].sort(), ['effort', 'ts_utc']);
  });

  it('never throws on non-object input and drops it', async () => {
    const { normalizeAssistantLine } = await mod('sources/transcript/normalize.mjs');
    for (const bad of [null, undefined, 'x', 5, [], { message: 'str' }, { message: { usage: 'str' } }]) {
      let r;
      assert.doesNotThrow(() => { r = normalizeAssistantLine(bad); });
      assert.equal(r.row, null);
    }
  });
});

describe('runIngest', () => {
  async function ingestLines(ctx, lines, extra = {}) {
    const { runIngest } = await mod('ingest/run.mjs');
    writeJsonl(join(ctx.root, 'projects', 'p', 's.jsonl'), lines);
    return runIngest({ home: ctx.home, root: ctx.root, ...extra });
  }
  const one = (home, id) => queryDb(STORE(home), 'SELECT * FROM cc_message WHERE message_id = ?', [id])[0];

  it('keeps the field-wise maximum of a streaming message whatever the line order', async () => {
    for (const order of [[10, 25], [25, 10]]) {
      const ctx = home();
      const lines = order.map((out, i) => line(obj({
        id: 'msg_s', ts: `2026-10-27T12:00:0${i + 1}.000Z`, use: makeUsage({ input: 50, output: out, read: 1000, creation: 100 }),
      })));
      const summary = await ingestLines(ctx, lines);
      assert.equal(summary.assistant, 2);
      assert.equal(queryDb(STORE(ctx.home), 'SELECT count(*) AS n FROM cc_message')[0].n, 1);
      assert.equal(one(ctx.home, 'msg_s').output_tokens, 25, `order ${order}`);
      assert.equal(one(ctx.home, 'msg_s').input_tokens, 50);
    }
  });

  it('the max is NULL-safe and text columns keep the first non-NULL value', async () => {
    const ctx = home();
    const u1 = makeUsage({ input: 5, output: 1, read: 1 }); // no cache_creation
    const u2 = makeUsage({ input: 3, output: 1, read: 1, creation: 9 });
    delete u2.input_tokens;
    const l1 = obj({ id: 'msg_n', model: undefined, use: u1, attributionAgent: 'first-agent' });
    const l2 = obj({ id: 'msg_n', model: 'claude-late', use: u2, attributionAgent: 'second-agent' });
    await ingestLines(ctx, [line(l1), line(l2)]);
    const r = one(ctx.home, 'msg_n');
    assert.equal(r.input_tokens, 5, 'NULL on one side keeps the known value');
    assert.equal(r.cache_creation, 9, 'known value wins over NULL');
    assert.equal(r.model, 'claude-late', 'first non-NULL text wins');
    assert.equal(r.attribution_agent, 'first-agent', 'a later value does not replace the first');
  });

  it('returns the summary, writes one ingest_run row, and uses the injected clock', async () => {
    const ctx = home();
    buildTranscriptTree(ctx.root);
    const { runIngest } = await mod('ingest/run.mjs');
    const now = () => new Date('2026-10-28T01:02:03.000Z');
    const full = await runIngest({ home: ctx.home, root: ctx.root, now });
    // 01-02 returns a superset of the 01-01 summary; the 01-01 keys keep their meaning.
    const { files, candidates, assistant, kept, unparseable, rejected } = full;
    const s = { files, candidates, assistant, kept, unparseable, rejected };
    assert.deepEqual({ ...s, rejected: { ...s.rejected } }, {
      files: EXPECTED_COUNTS.files, candidates: EXPECTED_COUNTS.candidates, assistant: EXPECTED_COUNTS.assistant,
      kept: EXPECTED_COUNTS.kept, unparseable: EXPECTED_COUNTS.unparseable, rejected: EXPECTED_COUNTS.rejected,
    });
    const runs = queryDb(STORE(ctx.home), 'SELECT * FROM ingest_run');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].started_utc, '2026-10-28T01:02:03.000Z');
    assert.equal(runs[0].trigger, 'manual');
    assert.equal(runs[0].rows_upserted, EXPECTED_COUNTS.kept);
  });

  it('uses the injectable normalize function', async () => {
    const ctx = home();
    const seen = [];
    const normalize = (o) => {
      seen.push(o.message.id);
      return { row: null, rejected: ['model'] };
    };
    const s = await ingestLines(ctx, [line(obj({ id: 'msg_x' }))], { normalize });
    assert.deepEqual(seen, ['msg_x']);
    assert.equal(s.kept, 0);
    assert.deepEqual({ ...s.rejected }, { model: 1 });
    assert.equal(queryDb(STORE(ctx.home), 'SELECT count(*) AS n FROM cc_message')[0].n, 0);
  });

  it('commits one transaction per file: an error in the second file keeps the first and rolls back the second', async () => {
    const ctx = home();
    const { runIngest } = await mod('ingest/run.mjs');
    const { normalizeAssistantLine } = await mod('sources/transcript/normalize.mjs');
    writeJsonl(join(ctx.root, 'projects', 'p', '1.jsonl'), [line(obj({ id: 'msg_f1' }))]);
    writeJsonl(join(ctx.root, 'projects', 'p', '2.jsonl'), [line(obj({ id: 'msg_f2a' })), line(obj({ id: 'msg_boom' }))]);
    const normalize = (o) => {
      if (o.message.id === 'msg_boom') throw new Error('stop-here');
      return normalizeAssistantLine(o);
    };
    await assert.rejects(runIngest({ home: ctx.home, root: ctx.root, normalize }), /stop-here/);
    const ids = queryDb(STORE(ctx.home), 'SELECT message_id FROM cc_message ORDER BY message_id').map((r) => r.message_id);
    assert.deepEqual(ids, ['msg_f1']);
  });

  it('rejects a root that is not a directory and never reads outside projects/*/*.jsonl', async () => {
    const ctx = home();
    const { runIngest } = await mod('ingest/run.mjs');
    await assert.rejects(runIngest({ home: ctx.home, root: join(ctx.home, 'missing') }), Error);
    writeJsonl(join(ctx.root, 'elsewhere', 'x.jsonl'), [line(obj({ id: 'msg_out' }))]);
    writeJsonl(join(ctx.root, 'projects', 'p', 'deep', 'y.jsonl'), [line(obj({ id: 'msg_deep' }))]);
    const s = await runIngest({ home: ctx.home, root: ctx.root });
    assert.equal(s.files, 0);
    assert.equal(queryDb(STORE(ctx.home), 'SELECT count(*) AS n FROM cc_message')[0].n, 0);
  });
});

describe('rebuildDerived', () => {
  async function built(over = {}) {
    const ctx = home();
    buildTranscriptTree(ctx.root);
    const { runIngest } = await mod('ingest/run.mjs');
    const { rebuildDerived } = await mod('derive/rebuild.mjs');
    await runIngest({ home: ctx.home, root: ctx.root, now: () => new Date('2026-10-28T01:00:00.000Z') });
    rebuildDerived({ home: ctx.home, now: () => new Date('2026-10-28T02:00:00.000Z'), ...over });
    return ctx;
  }
  const call = (h, id) => queryDb(DERIVED(h), 'SELECT * FROM api_call WHERE message_id = ?', [id])[0];

  it('derives one api_call row per message with role, role_source, join_state and token label', async () => {
    const ctx = await built();
    assert.equal(queryDb(DERIVED(ctx.home), 'SELECT count(*) AS n FROM api_call')[0].n, EXPECTED_COUNTS.rows);
    const m3 = call(ctx.home, MSG.m3);
    assert.equal(m3.role, 'gsd-executor');
    assert.equal(m3.role_source, 'transcript');
    assert.equal(m3.join_state, 'transcript_only');
    assert.equal(m3.token_label, 'transcript');
    // 01-04: one api_call per message id (dedup), keyed 'm:' + message id; the owner occurrence is kept apart.
    assert.equal(m3.call_key, `m:${MSG.m3}`);
    assert.deepEqual([m3.owner_session_id, m3.owner_agent_id], ['sess-fixture-s1', 'agent0123456789ab']);
    const m1 = call(ctx.home, MSG.m1);
    assert.equal(m1.role, 'main');
    assert.equal(m1.role_source, 'derived');
    assert.equal(call(ctx.home, MSG.m7).role, 'main', 'a rejected (NULL) attribution agent on a main-thread line is main');
  });

  it('an agent line with no attribution agent has role unknown and role_source unavailable', async () => {
    const ctx = home();
    const { runIngest } = await mod('ingest/run.mjs');
    const { rebuildDerived } = await mod('derive/rebuild.mjs');
    writeJsonl(join(ctx.root, 'projects', 'p', 's.jsonl'), [line(obj({ id: 'msg_u', agentId: 'agent99' }))]);
    await runIngest({ home: ctx.home, root: ctx.root });
    rebuildDerived({ home: ctx.home });
    const r = call(ctx.home, 'msg_u');
    assert.equal(r.role, 'unknown');
    assert.equal(r.role_source, 'unavailable');
  });

  it('writes one derive_state row with the newest record time, the row count and the injected clock', async () => {
    const ctx = await built();
    const rows = queryDb(DERIVED(ctx.home), 'SELECT * FROM derive_state');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 1);
    assert.equal(rows[0].newest_record_utc, NEWEST_RECORD_UTC);
    assert.equal(rows[0].api_call_rows, EXPECTED_COUNTS.rows);
    // derive_state records the store's schema version: it follows the latest migration (3 since plan 01-03).
    assert.equal(rows[0].store_user_version, queryDb(STORE(ctx.home), 'PRAGMA user_version')[0].user_version, 'store schema version');
    assert.equal(rows[0].built_utc, '2026-10-28T02:00:00.000Z');
    assert.equal(rows[0].last_run_end_utc, '2026-10-28T01:00:00.000Z');
  });

  it('is repeatable: a second rebuild yields the same api_call content', async () => {
    const ctx = await built();
    const a = queryDb(DERIVED(ctx.home), 'SELECT * FROM api_call ORDER BY call_key');
    const { rebuildDerived } = await mod('derive/rebuild.mjs');
    rebuildDerived({ home: ctx.home });
    const b = queryDb(DERIVED(ctx.home), 'SELECT * FROM api_call ORDER BY call_key');
    assert.deepEqual(a, b);
  });

  it('works on a HOME with no earlier ingest: a schema-only store, zero rows, no ingest recorded', async () => {
    const ctx = home();
    const { rebuildDerived } = await mod('derive/rebuild.mjs');
    rebuildDerived({ home: ctx.home });
    assert.equal(queryDb(DERIVED(ctx.home), 'SELECT count(*) AS n FROM api_call')[0].n, 0);
    const st = queryDb(DERIVED(ctx.home), 'SELECT * FROM derive_state')[0];
    assert.equal(st.newest_record_utc, null);
    assert.equal(st.last_run_end_utc, null);
  });
});

describe('Measure, cost report and text renderer', () => {
  it('loadCostReport groups by role and model with Measures: unknown member makes the cell unknown, order is role then model, NULL model last', async () => {
    const ctx = home();
    buildTranscriptTree(ctx.root);
    const { runIngest } = await mod('ingest/run.mjs');
    const { rebuildDerived } = await mod('derive/rebuild.mjs');
    const { loadCostReport } = await mod('report/cost.mjs');
    await runIngest({ home: ctx.home, root: ctx.root });
    rebuildDerived({ home: ctx.home });
    const report = loadCostReport({ home: ctx.home });
    assert.equal(report.freshness.newestRecordUtc, NEWEST_RECORD_UTC);
    assert.equal(report.freshness.rows, EXPECTED_COUNTS.rows);
    assert.deepEqual(
      report.rows.map((r) => [r.role, r.model]),
      EXPECTED_COST_ROWS.map((r) => [r[0], r[1] === '?' ? null : r[1]]),
    );
    const executor = report.rows[0];
    assert.equal(executor.calls, 2);
    assert.equal(executor.input.value, 30);
    assert.equal(executor.input.label, 'transcript');
    assert.equal(executor.cacheWrite.value, null, 'one member without cache_creation: the sum is unknown, not 29');
    assert.equal(executor.cacheWrite.label, 'unavailable');
    assert.equal(executor.cacheWrite.coverage, 0.5);
    assert.equal(executor.notionalUsd.value, null);
    assert.equal(executor.notionalUsd.label, 'unavailable');
    assert.equal(executor.notionalUsd.n, 2);
    assert.equal(executor.window_5h.value, null); // plan 01-06: window_share became window_5h and window_7d
    assert.equal(executor.window_7d.value, null);
    assert.equal(report.rows[1].output.value, 0, 'a genuine zero sum stays 0');
  });

  it('renderCostText prints freshness, period, an aligned table with right-aligned numbers, and the labels line', async () => {
    const { renderCostText } = await mod('report/render-text.mjs');
    const { known, unknown } = await mod('measure/measure.mjs');
    const k = (v, n) => known(v, { label: 'transcript', n });
    const rows = [
      { role: 'main', model: 'claude-opus-5-5', calls: 12, input: k(1234, 12), output: k(0, 12), cacheRead: k(7, 12), cacheWrite: k(123456, 12), notionalUsd: unknown({ n: 12 }), window_5h: unknown({ n: 12 }), window_7d: unknown({ n: 12 }) },
      { role: 'main', model: null, calls: 3, input: k(5, 3), output: unknown({ n: 3 }), cacheRead: k(1, 3), cacheWrite: k(2, 3), notionalUsd: unknown({ n: 3 }), window_5h: unknown({ n: 3 }), window_7d: unknown({ n: 3 }) },
    ];
    const text = renderCostText({
      freshness: { newestRecordUtc: '2026-10-27T12:00:09.000Z', lastRunEndUtc: '2026-10-28T01:02:03.000Z', rows: 15 },
      rows,
    });
    const lines = text.split('\n');
    assert.equal(lines[0], 'freshness: transcript newest record 2026-10-27T12:00:09.000Z; last ingest run 2026-10-28T01:02:03.000Z (staleness check not applied in this build)');
    assert.equal(lines[1], 'period: all ingested records');
    assert.deepEqual(lines[2].trim().split(/\s+/), ['role', 'model', 'calls', 'input', 'output', 'cache_read', 'cache_write', 'notional_usd', 'window_5h', 'window_7d']);
    assert.deepEqual(lines[3].trim().split(/\s+/), ['main', 'claude-opus-5-5', '12', '1234', '0', '7', '123456', '?', '?', '?']);
    assert.deepEqual(lines[4].trim().split(/\s+/), ['main', '?', '3', '5', '?', '1', '2', '?', '?', '?']);
    assert.equal(lines[5], 'labels: tokens=transcript notional_usd=unavailable window_share=unavailable; ? means unknown (label unavailable), never zero');
    assert.equal(lines[6], '');
    // Right alignment: every numeric cell ends where its header ends.
    const header = lines[2];
    for (const col of ['calls', 'input', 'output', 'cache_read', 'cache_write']) {
      const end = header.indexOf(col) + col.length;
      for (const l of [lines[3], lines[4]]) {
        assert.ok(l.length >= end && l[end - 1] !== ' ' && (l[end] === ' ' || l[end] === undefined), `${col} right-aligned in "${l}"`);
      }
    }
    assert.ok(lines[3].includes('  '), 'columns are separated by two spaces');
  });

  it('renderCostText with zero rows prints no labels line and no number, only freshness, period and "no rows"', async () => {
    const { renderCostText } = await mod('report/render-text.mjs');
    const none = renderCostText({ freshness: { newestRecordUtc: null, lastRunEndUtc: null, rows: null }, rows: [] });
    assert.equal(none, 'freshness: no ingest recorded\nperiod: all ingested records\nno rows\n');
    const afterRun = renderCostText({ freshness: { newestRecordUtc: null, lastRunEndUtc: '2026-10-28T01:02:03.000Z', rows: 0 }, rows: [] });
    const lines = afterRun.split('\n');
    assert.equal(lines[0], 'freshness: transcript newest record ?; last ingest run 2026-10-28T01:02:03.000Z (staleness check not applied in this build)');
    assert.equal(lines[2], 'no rows');
    assert.ok(!afterRun.includes('labels:'));
  });

  it('render-text imports nothing from the database, derive or ingest layers', () => {
    const text = readFileSync(new URL('../../src/report/render-text.mjs', import.meta.url), 'utf8');
    const imports = [...text.matchAll(/(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const i of imports) {
      assert.ok(!/(^|\/)db\.mjs$|\/derive\/|\/ingest\/|node:sqlite/.test(i), i);
    }
    assert.ok(imports.some((i) => i.endsWith('measure/measure.mjs')));
  });

  it('the cost report SQL guards unknowns and orders NULL models last', () => {
    const text = readFileSync(new URL('../../src/report/cost.mjs', import.meta.url), 'utf8');
    assert.ok(text.includes('NULLS LAST'));
    assert.ok(text.includes('count(*)'));
  });
});
