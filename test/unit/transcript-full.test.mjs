// The full transcript normalizer (new allowlist entries, iterations, unknown key names), the meta
// allowlist, and the field-wise-max writer. Written before the code it covers; the 01-01 normalizer
// tests stay in transcript-source.test.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAssistant, makeUsage, makeHome, PLANTS } from '../fixtures/build.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const norm = () => mod('sources/transcript/normalize.mjs');
const metaMod = () => mod('sources/transcript/meta.mjs');
const HOME = ['', 'srv', 'users', 'CANARYuser'].join('/');
const line = (o = {}) => makeAssistant({
  session: 'S', ts: '2026-10-27T12:00:00.000Z', id: 'M', model: 'claude-opus-5-5', use: makeUsage({ input: 1, output: 2, read: 3, creation: 4 }), ...o,
});
const lines = (over, usageOver = {}) => {
  const o = line(over);
  Object.assign(o.message.usage, usageOver);
  return o;
};

describe('normalizer: the added allowlist entries', () => {
  it('keeps uuid, attribution skill, per-turn effort, advisor and requested model and entrypoint through their shape checks', async () => {
    const { normalizeAssistantLine } = await norm();
    const o = line();
    Object.assign(o, { attributionSkill: 'gsd-quick', perTurnEffort: 'high', advisorModel: 'claude-fable-5-0', requestedModel: 'claude-opus-5-5', entrypoint: 'cli' });
    const { row } = normalizeAssistantLine(o);
    assert.equal(row.uuid, o.uuid);
    assert.equal(row.attribution_skill, 'gsd-quick');
    assert.equal(row.per_turn_effort, 'high');
    assert.equal(row.advisor_model, 'claude-fable-5-0');
    assert.equal(row.requested_model, 'claude-opus-5-5');
    assert.equal(row.entrypoint, 'cli');
  });

  it('turns a hostile value in any added column into NULL and reports the column name only', async () => {
    const { normalizeAssistantLine } = await norm();
    const o = line();
    Object.assign(o, { uuid: PLANTS.email, attributionSkill: PLANTS.hostileAgent, advisorModel: PLANTS.hostileModel, entrypoint: PLANTS.prompt });
    const { row, rejected } = normalizeAssistantLine(o);
    for (const c of ['uuid', 'attribution_skill', 'advisor_model', 'entrypoint']) {
      assert.equal(row[c], null, c);
      assert.ok(rejected.includes(c), c);
    }
    assert.ok(!JSON.stringify(rejected).includes('CANARY'));
  });

  it('stores isSidechain as 1 or 0, NULL when absent, and rejects a non-boolean', async () => {
    const { normalizeAssistantLine } = await norm();
    assert.equal(normalizeAssistantLine(line({ agentId: 'agent1' })).row.is_sidechain, 1);
    const f = line(); f.isSidechain = false;
    assert.equal(normalizeAssistantLine(f).row.is_sidechain, 0);
    assert.equal(normalizeAssistantLine(line()).row.is_sidechain, null);
    const bad = line(); bad.isSidechain = 'yes';
    const r = normalizeAssistantLine(bad);
    assert.equal(r.row.is_sidechain, null);
    assert.ok(r.rejected.includes('is_sidechain'));
  });

  it('normalizes cwd through the home set of the context, and rejects an unusable value', async () => {
    const { normalizeAssistantLine } = await norm();
    const { buildHomeSet } = await mod('sources/transcript/home.mjs');
    const ctx = { homeSet: buildHomeSet({ home: HOME, windowsUsers: [] }) };
    assert.equal(normalizeAssistantLine(line({ cwd: `${HOME}/repos/app` }), ctx).row.cwd, '~/repos/app');
    assert.equal(normalizeAssistantLine(line({ cwd: '/Users/someone/x' }), ctx).row.cwd, '~other/x');
    const bad = normalizeAssistantLine(line({ cwd: 'bad\u0007' }), ctx);
    assert.equal(bad.row.cwd, null);
    assert.ok(bad.rejected.includes('cwd'));
    assert.equal(normalizeAssistantLine(line({ cwd: undefined }), ctx).row.cwd, null);
  });

  it('sets has_iterations and has_server_tool_use to 1 when present (a readable count above 0 for server_tool_use) and 0 when absent', async () => {
    const { normalizeAssistantLine } = await norm();
    const none = normalizeAssistantLine(line()).row;
    assert.equal(none.has_iterations, 0);
    assert.equal(none.has_server_tool_use, 0);
    const some = normalizeAssistantLine(lines({}, { iterations: [{ type: 'message' }], server_tool_use: { web_search_requests: 1 } })).row;
    assert.equal(some.has_iterations, 1);
    assert.equal(some.has_server_tool_use, 1);
    assert.equal(normalizeAssistantLine(lines({}, { iterations: [] })).row.has_iterations, 0);
  });
});

describe('normalizer: iterations', () => {
  const iter = (i, extra = {}) => ({
    type: 'message', model: 'claude-opus-5-5', input_tokens: i, output_tokens: i + 1, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, ...extra,
  });

  it('exports ITER_ALLOWLIST with the type, model, four token fields and two cache_creation fields', async () => {
    const { ITER_ALLOWLIST } = await norm();
    assert.deepEqual(ITER_ALLOWLIST.map((e) => e.column).sort(), [
      'cache_1h', 'cache_5m', 'cache_creation', 'cache_read', 'input_tokens', 'iter_type', 'model', 'output_tokens',
    ]);
  });

  it('stores entries by index through the allowlist and ignores unlisted entry keys', async () => {
    const { normalizeAssistantLine } = await norm();
    const r = normalizeAssistantLine(lines({}, { iterations: [iter(1, { secret: PLANTS.prompt }), iter(2, { type: 'advisor_message', model: 'claude-fable-5-0' })] }));
    assert.equal(r.iterations.length, 2);
    assert.deepEqual({ ...r.iterations[1] }, {
      iter_seq: 1, iter_type: 'advisor_message', model: 'claude-fable-5-0', input_tokens: 2, output_tokens: 3,
      cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0,
    });
    assert.ok(!JSON.stringify(r).includes('CANARY'));
  });

  it('keeps at most 16 entries and reports how many were dropped', async () => {
    const { normalizeAssistantLine } = await norm();
    const r = normalizeAssistantLine(lines({}, { iterations: Array.from({ length: 20 }, (_, i) => iter(i)) }));
    assert.equal(r.iterations.length, 16);
    assert.equal(r.iterationsTruncated, 4);
    assert.equal(r.iterations[15].iter_seq, 15);
  });

  it('skips a non-object entry but keeps the index of the others, and NULLs a hostile entry model', async () => {
    const { normalizeAssistantLine } = await norm();
    const r = normalizeAssistantLine(lines({}, { iterations: [iter(1), 'junk', iter(3, { model: PLANTS.hostileModel })] }));
    assert.deepEqual(r.iterations.map((x) => x.iter_seq), [0, 2]);
    assert.equal(r.iterations[1].model, null);
    assert.ok(r.rejected.includes('iter_model'));
  });
});

describe('normalizer: unknown key names and dropped lines', () => {
  it('lists unlisted key names at the line, message and usage scopes, shape-checked', async () => {
    const { normalizeAssistantLine } = await norm();
    const o = lines({}, { brand_new_usage_field: 1 });
    o.brandNewLineField = 1;
    o.message.brandNewMsgField = 1;
    const r = normalizeAssistantLine(o);
    assert.deepEqual([...r.unknown.line], ['brandNewLineField']);
    assert.deepEqual([...r.unknown.message], ['brandNewMsgField']);
    assert.deepEqual([...r.unknown.usage], ['brand_new_usage_field']);
  });

  it('puts an email-shaped or spaced key name into the question-mark bucket and never keeps the name', async () => {
    const { normalizeAssistantLine } = await norm();
    const o = line();
    o[PLANTS.email] = 1;
    o[PLANTS.hostileAgent] = 1;
    const r = normalizeAssistantLine(o);
    assert.deepEqual([...r.unknown.line], ['?', '?']);
    assert.ok(!JSON.stringify(r.unknown).includes('CANARY'));
  });

  it('caps distinct unknown names at 200 per scope, sending the overflow to the bucket', async () => {
    const { normalizeAssistantLine } = await norm();
    const o = line();
    for (let i = 0; i < 250; i += 1) o[`extraKey${i}`] = 1;
    const r = normalizeAssistantLine(o);
    const names = new Set(r.unknown.line);
    assert.equal(names.size, 201);
    assert.ok(names.has('?'));
  });

  it('knows the dropped keys: content, parentUuid, gitBranch and the type keys are not reported as unknown', async () => {
    const { normalizeAssistantLine } = await norm();
    const r = normalizeAssistantLine(line());
    assert.deepEqual([...r.unknown.line], []);
    assert.deepEqual([...r.unknown.message], []);
    assert.deepEqual([...r.unknown.usage], []);
  });

  it('names the drop reason: usage, session_id, message_id, agent_id', async () => {
    const { normalizeAssistantLine } = await norm();
    assert.equal(normalizeAssistantLine(line({ use: undefined })).dropped, 'usage');
    assert.equal(normalizeAssistantLine(line({ session: undefined })).dropped, 'session_id');
    assert.equal(normalizeAssistantLine(line({ id: undefined })).dropped, 'message_id');
    assert.equal(normalizeAssistantLine(line({ agentId: PLANTS.hostileAgent })).dropped, 'agent_id');
    assert.equal(normalizeAssistantLine(line()).dropped, null);
  });

  it('keeps the 01-01 call shape: one argument works and the row has exactly the allowlist columns', async () => {
    const { normalizeAssistantLine, ALLOWLIST, KNOWN_KEYS } = await norm();
    const { row } = normalizeAssistantLine(line());
    assert.deepEqual(Object.keys(row).sort(), ALLOWLIST.map((e) => e.column).sort());
    for (const scope of ['line', 'message', 'usage']) assert.ok(KNOWN_KEYS[scope].includes(scope === 'line' ? 'sessionId' : scope === 'message' ? 'id' : 'input_tokens'));
  });
});

describe('meta allowlist', () => {
  it('has twelve entries and picks them with shape checks; booleans become 0 or 1', async () => {
    const { META_ALLOWLIST, normalizeMeta } = await metaMod();
    assert.equal(META_ALLOWLIST.length, 12);
    const { row, unknown } = normalizeMeta({
      agentType: 'gsd-executor', spawnDepth: 2, model: 'claude-sonnet-5-5', toolUseId: 'toolu_01A', parentAgentId: 'agentp', isFork: true,
      workflowPhase: 'plan', finished: false, spawnedWithWorktree: true, stoppedByUser: false, launchedWithDefaults: true, requestNonInteractive: false,
    });
    assert.deepEqual({ ...row }, {
      agent_type: 'gsd-executor', spawn_depth: 2, model: 'claude-sonnet-5-5', tool_use_id: 'toolu_01A', parent_agent_id: 'agentp', is_fork: 1,
      workflow_phase: 'plan', finished: 0, spawned_with_worktree: 1, stopped_by_user: 0, launched_with_defaults: 1, request_non_interactive: 0,
    });
    assert.deepEqual([...unknown], []);
  });

  it('drops description and the worktree keys silently and never reports or stores their values', async () => {
    const { META_DROPPED, normalizeMeta } = await metaMod();
    for (const k of ['description', 'worktreePath', 'worktreeBranch', 'worktreeCleanlyRemoved', 'requestShape']) assert.ok(META_DROPPED.includes(k), k);
    const r = normalizeMeta({ agentType: 'Explore', description: PLANTS.prompt, worktreePath: HOME, worktreeBranch: 'feat/x', requestShape: PLANTS.command });
    assert.deepEqual([...r.unknown], []);
    assert.ok(!JSON.stringify(r).includes('CANARY'));
    assert.ok(!JSON.stringify(r).includes('srv'));
  });

  it('records an unlisted key by shape-checked name only', async () => {
    const { normalizeMeta } = await metaMod();
    const o = { agentType: 'Explore', brandNewMetaKey: 'v' };
    o[PLANTS.email] = 1;
    const r = normalizeMeta(o);
    assert.deepEqual([...r.unknown].sort(), ['?', 'brandNewMetaKey']);
  });

  it('turns a value of the wrong shape into NULL: spawnDepth text, a spaced agent type, a non-boolean flag, a bad phase', async () => {
    const { normalizeMeta } = await metaMod();
    const { row } = normalizeMeta({ spawnDepth: 'deep', agentType: 'has space', isFork: 'yes', workflowPhase: { x: 1 }, model: PLANTS.hostileModel });
    for (const c of ['spawn_depth', 'agent_type', 'is_fork', 'workflow_phase', 'model']) assert.equal(row[c], null, c);
    assert.equal(normalizeMeta({ workflowPhase: 3 }).row.workflow_phase, '3');
    assert.equal(normalizeMeta({ spawnDepth: 100000 }).row.spawn_depth, null);
  });

  it('readMetaFile tolerates empty, whitespace, array, non-JSON and over-cap files with a reason, and reads a good one', async () => {
    const { readMetaFile, MAX_META_BYTES } = await metaMod();
    assert.equal(MAX_META_BYTES, 64 * 1024);
    const d = mkdtempSync(join(tmpdir(), 'rigorscope-meta-'));
    try {
      const w = (name, content) => { const p = join(d, name); writeFileSync(p, content); return p; };
      assert.deepEqual({ ...readMetaFile(w('a', '')) }, { ok: false, reason: 'empty' });
      assert.deepEqual({ ...readMetaFile(w('b', '  \n ')) }, { ok: false, reason: 'empty' });
      assert.deepEqual({ ...readMetaFile(w('c', '[1,2]')) }, { ok: false, reason: 'not_object' });
      assert.deepEqual({ ...readMetaFile(w('d', 'not json {')) }, { ok: false, reason: 'not_json' });
      assert.deepEqual({ ...readMetaFile(w('e', `{"a":"${'x'.repeat(MAX_META_BYTES)}"}`)) }, { ok: false, reason: 'too_large' });
      const good = readMetaFile(w('f', '{"agentType":"Explore"}'));
      assert.equal(good.ok, true);
      assert.equal(good.obj.agentType, 'Explore');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('store schema and the field-wise-max writer', () => {
  async function store() {
    const ctx = makeHome();
    const { openStore } = await mod('db.mjs');
    const db = openStore({ home: ctx.home });
    db.exec("INSERT INTO source_root (root_id, source, alias, kind, display) VALUES (1, 'transcript', 'claude', 'home', '~/.claude'), (2, 'transcript', 'claude-contrib', 'home', '~/.claude-contrib')");
    db.exec("INSERT INTO source_file (file_id, root_id, rel_path, kind, offset) VALUES (1, 1, 'a.jsonl', 'session', 0), (2, 2, 'a.jsonl', 'session', 0)");
    return { ctx, db };
  }
  const rowOf = (over = {}) => ({
    session_id: 'S', agent_id: '', message_id: 'M', request_id: null, ts_utc: null, model: null, attribution_agent: null, effort: null,
    version: null, input_tokens: null, output_tokens: null, cache_read: null, cache_creation: null, cache_5m: null, cache_1h: null,
    speed: null, service_tier: null, inference_geo: null, uuid: null, is_sidechain: null, attribution_skill: null, per_turn_effort: null,
    advisor_model: null, requested_model: null, entrypoint: null, cwd: null, has_iterations: 0, has_server_tool_use: 0, ...over,
  });

  it('migration 002 columns equal the allowlists: cc_message, cc_message_iter and cc_agent_meta', async () => {
    const { ctx, db } = await store();
    try {
      const { ALLOWLIST, ITER_ALLOWLIST } = await norm();
      const { META_ALLOWLIST } = await metaMod();
      const cols = (t) => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name).sort();
      assert.deepEqual(cols('cc_message'), ALLOWLIST.map((e) => e.column).sort());
      assert.deepEqual(cols('cc_message_iter'), ['agent_id', 'iter_seq', 'message_id', 'session_id', ...ITER_ALLOWLIST.map((e) => e.column)].sort());
      assert.deepEqual(cols('cc_agent_meta'), ['agent_id', 'file_id', 'session_id', ...META_ALLOWLIST.map((e) => e.column)].sort());
      for (const t of ['source_root', 'source_file', 'cc_message_file', 'cc_message_iter', 'cc_agent_meta', 'ingest_source_run', 'ingest_count', 'unknown_attr']) {
        assert.equal(db.prepare('SELECT strict FROM pragma_table_list WHERE name = ?').get(t).strict, 1, `${t} is STRICT`);
      }
      assert.ok(db.prepare('PRAGMA user_version').get().user_version >= 2, 'migration 002 (or a later one) is applied');
    } finally {
      db.close();
      ctx.cleanup();
    }
  });

  it('keeps the field-wise maximum, never lets a later smaller or NULL value lower a stored one, and fills a NULL', async () => {
    const { ctx, db } = await store();
    try {
      const { createWriter } = await mod('sources/transcript/write.mjs');
      const w = createWriter(db);
      w.write({ kind: 'message', row: rowOf({ input_tokens: 5, output_tokens: 10, ts_utc: 'first', model: 'm1' }), iterations: [] }, 1);
      w.write({ kind: 'message', row: rowOf({ input_tokens: 3, output_tokens: null, cache_read: 7, ts_utc: 'second', model: 'm2' }), iterations: [] }, 1);
      w.write({ kind: 'message', row: rowOf({ input_tokens: 9, output_tokens: 4 }), iterations: [] }, 1);
      const r = db.prepare('SELECT * FROM cc_message').get();
      assert.deepEqual([r.input_tokens, r.output_tokens, r.cache_read, r.cache_creation], [9, 10, 7, null]);
      assert.equal(r.ts_utc, 'first');
      assert.equal(r.model, 'm1');
      assert.equal(db.prepare('SELECT count(*) AS n FROM cc_message').get().n, 1);
    } finally {
      db.close();
      ctx.cleanup();
    }
  });

  it('records every file a message was seen in, once each, and merges iterations per index by field-wise max', async () => {
    const { ctx, db } = await store();
    try {
      const { createWriter } = await mod('sources/transcript/write.mjs');
      const w = createWriter(db);
      const it0 = (out) => ({ iter_seq: 0, iter_type: 'message', model: 'm', input_tokens: 1, output_tokens: out, cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0 });
      w.write({ kind: 'message', row: rowOf({ has_iterations: 1 }), iterations: [it0(5)] }, 1);
      w.write({ kind: 'message', row: rowOf({ has_iterations: 1 }), iterations: [it0(2), { ...it0(9), iter_seq: 1, iter_type: 'advisor_message' }] }, 2);
      w.write({ kind: 'message', row: rowOf(), iterations: [] }, 2);
      assert.deepEqual(db.prepare('SELECT file_id FROM cc_message_file ORDER BY file_id').all().map((x) => x.file_id), [1, 2]);
      assert.deepEqual(db.prepare('SELECT iter_seq, output_tokens FROM cc_message_iter ORDER BY iter_seq').all().map((x) => [x.iter_seq, x.output_tokens]), [[0, 5], [1, 9]]);
      assert.equal(db.prepare('SELECT has_iterations AS h FROM cc_message').get().h, 1, 'a later 0 does not lower the flag');
    } finally {
      db.close();
      ctx.cleanup();
    }
  });

  it('keeps the latest non-NULL value of each agent meta column', async () => {
    const { ctx, db } = await store();
    try {
      const { createWriter } = await mod('sources/transcript/write.mjs');
      const w = createWriter(db);
      const meta = (o) => ({ kind: 'meta', session_id: 'S', agent_id: 'A', row: { agent_type: null, spawn_depth: null, model: null, tool_use_id: null, parent_agent_id: null, is_fork: null, workflow_phase: null, finished: null, spawned_with_worktree: null, stopped_by_user: null, launched_with_defaults: null, request_non_interactive: null, ...o } });
      w.write(meta({ agent_type: 'Explore', finished: 0 }), 1);
      w.write(meta({ finished: 1, model: 'm' }), 1);
      const r = db.prepare('SELECT * FROM cc_agent_meta').get();
      assert.deepEqual([r.agent_type, r.finished, r.model], ['Explore', 1, 'm']);
    } finally {
      db.close();
      ctx.cleanup();
    }
  });
});
