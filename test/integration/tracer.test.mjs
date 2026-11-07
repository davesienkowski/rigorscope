// Walking-skeleton contract: ingest a synthetic transcript tree, then `cost`. Written before any
// production code; every expectation below is hand-computed in test/fixtures/build.mjs.
//
// Assumed shapes (the contract Task 3 implements):
//   runIngest({ home, root, normalize, now })  async -> { files, candidates, assistant, kept, unparseable, rejected }
//   rebuildDerived({ home, now, beforeRename }) sync; loadCostReport({ home }) sync; renderCostText(report) sync
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  PLANTS, MSG, SESSION, AGENT_ID, EXPECTED_COST_ROWS, EXPECTED_COUNTS, NEWEST_RECORD_UTC, LABELS_LINE,
  HEADER_TOKENS, makeHome, buildTranscriptTree, runCli, runCliAsync, parseCost, queryDb, storeDigest,
  sha256File, stateDirOf, listState, treeDigest, session2Lines, writeJsonl,
} from '../fixtures/build.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
// Plan 01-05 dollar cells of the five rows: gsd-executor/sonnet ? (M4 has no cache_creation); haiku 700
// nano-dollars; opus-4-8 36,750 (a floor); opus-5-5 6,280,000 (a floor); NULL model ?.
const TRACER_DOLLARS = ['?', '0.000001', '>=0.000037', '>=0.006280', '?'];
const STORE = (home) => join(stateDirOf(home), 'store.db');
const DERIVED = (home) => join(stateDirOf(home), 'derived.db');

function fullTree() {
  const ctx = makeHome();
  buildTranscriptTree(ctx.root);
  return ctx;
}

describe('tracer path', () => {
  let ctx;
  let ingest;
  let cost;
  let parsed;
  before(() => {
    ctx = fullTree();
    ingest = runCli(['ingest', '--root', ctx.root], { home: ctx.home });
    cost = runCli(['cost'], { home: ctx.home });
    parsed = parseCost(cost.stdout);
  });
  after(() => ctx.cleanup());

  it('ingest exits 0 and ends with the summary line holding the counts', () => {
    assert.equal(ingest.status, 0, ingest.stderr);
    const c = EXPECTED_COUNTS;
    // 01-02 added a header and per-source progress lines; the 01-01 summary line is the last line.
    const lines = ingest.stdout.trimEnd().split('\n');
    assert.equal(
      lines[lines.length - 1],
      `ingest: files=${c.files} lines=${c.candidates} assistant=${c.assistant} kept=${c.kept} ` +
        `unparseable=${c.unparseable} rejected=attribution_agent:1,model:1`,
    );
  });

  it('cost exits 0 and prints the five expected rows in the expected order', () => {
    assert.equal(cost.status, 0, cost.stderr);
    assert.deepEqual(parsed.header, HEADER_TOKENS);
    // Plan 01-05: notional_usd is priced (hand-computed in test/integration/cost-price.test.mjs, case 10).
    assert.deepEqual(parsed.rows, EXPECTED_COST_ROWS.map((r, i) => [...r, TRACER_DOLLARS[i], '?', '?']));
  });

  it('starts with a freshness line holding the newest record time, then the period line', () => {
    assert.ok(parsed.freshness.startsWith('freshness:'), parsed.freshness);
    // Plan 01-08: the freshness block lists the newest record per source; the period line names the default window.
    assert.ok(parsed.lines.some((l) => l.includes(NEWEST_RECORD_UTC)), 'the transcript newest record time is in the freshness block');
    assert.match(parsed.period, /^period: last 7 days, from 2026-10-21T12:00:00.000Z \(default\), tz=UTC, calls_ts_unknown=0$/);
  });

  it('prints the labels line, one label per column group in the fixed order', () => {
    assert.equal(parsed.labels, LABELS_LINE.replace('notional_usd=unavailable', 'notional_usd=derived'));
    const groups = [...parsed.labels.matchAll(/(tokens|notional_usd|window_share)=([a-z]+)/g)].map((m) => m[1]);
    assert.deepEqual(groups, ['tokens', 'notional_usd', 'window_share']);
  });

  it('shows the notional_usd cells and ? for window_5h and window_7d in every row', () => {
    for (const [i, row] of parsed.rows.entries()) {
      assert.equal(row[7], TRACER_DOLLARS[i], row.join(' '));
      assert.deepEqual(row.slice(8), ['?', '?'], row.join(' '));
    }
    assert.ok(parsed.rows.length === 5);
  });

  it('records one ingest_run row with the counts', () => {
    const [run] = queryDb(STORE(ctx.home), 'SELECT * FROM ingest_run');
    assert.ok(run, 'one ingest_run row');
    assert.equal(run.files, 4);
    assert.equal(run.lines_read, 10);
    assert.equal(run.assistant_lines, 9);
    assert.equal(run.rows_upserted, 9);
    assert.equal(run.unparseable, 1);
    assert.equal(typeof run.started_utc, 'string');
    assert.equal(typeof run.ended_utc, 'string');
  });

  it('keeps 8 distinct cc_message rows and the streaming message holds the field-wise maximum', () => {
    assert.equal(storeDigest(ctx.home).count, EXPECTED_COUNTS.rows);
    const [m2] = queryDb(STORE(ctx.home), 'SELECT * FROM cc_message WHERE message_id = ?', [MSG.m2]);
    assert.equal(m2.input_tokens, 50);
    assert.equal(m2.output_tokens, 25);
    assert.equal(m2.cache_read, 1000);
    assert.equal(m2.cache_creation, 100);
  });
});

describe('trust edges', () => {
  it('a genuine zero renders 0 and a missing value renders ?, never one for the other', () => {
    const ctx = fullTree();
    try {
      runCli(['ingest', '--root', ctx.root], { home: ctx.home });
      const { rows } = parseCost(runCli(['cost'], { home: ctx.home }).stdout);
      const haiku = rows.find((r) => r[1] === 'claude-haiku-5-5');
      assert.deepEqual(haiku.slice(4, 7), ['0', '0', '0'], 'real zeros print as 0');
      const executor = rows.find((r) => r[0] === 'gsd-executor');
      assert.equal(executor[6], '?', 'one member without cache_creation makes the sum unknown');
      assert.equal(executor[4], '5', 'a zero member does not turn the known sum into ?');
    } finally {
      ctx.cleanup();
    }
  });

  it('stores shape-rejected and absent values as NULL, never as 0 or as text', () => {
    const ctx = fullTree();
    try {
      runCli(['ingest', '--root', ctx.root], { home: ctx.home });
      const get = (id) => queryDb(STORE(ctx.home), 'SELECT * FROM cc_message WHERE message_id = ?', [id])[0];
      assert.equal(get(MSG.m7).attribution_agent, null, 'hostile agent name rejected');
      assert.equal(get(MSG.m7).model, 'claude-opus-4-8');
      assert.equal(get(MSG.m8).model, null, 'hostile model rejected');
      assert.equal(get(MSG.m6).model, null, 'absent model');
      assert.equal(get(MSG.m4).cache_creation, null, 'absent cache_creation stays NULL');
      assert.equal(get(MSG.m3).output_tokens, 0, 'real zero stays 0');
      assert.equal(get(MSG.m3).agent_id, AGENT_ID);
      assert.equal(get(MSG.m1).agent_id, '', 'main-thread line has the empty agent id');
    } finally {
      ctx.cleanup();
    }
  });

  it('a NULL model renders ? in the model column and sorts after every row that has a model', () => {
    const ctx = fullTree();
    try {
      runCli(['ingest', '--root', ctx.root], { home: ctx.home });
      const { rows } = parseCost(runCli(['cost'], { home: ctx.home }).stdout);
      const last = rows[rows.length - 1];
      assert.equal(last[0], 'main');
      assert.equal(last[1], '?');
      const mainRows = rows.filter((r) => r[0] === 'main');
      assert.deepEqual(mainRows.map((r) => r[1]), ['claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-5-5', '?']);
    } finally {
      ctx.cleanup();
    }
  });

  it('a file with CRLF endings ingests the same rows as the same file with LF endings', () => {
    const a = makeHome();
    const b = makeHome();
    try {
      writeJsonl(join(a.root, 'projects', 'p', 's.jsonl'), session2Lines(), '\n');
      writeJsonl(join(b.root, 'projects', 'p', 's.jsonl'), session2Lines(), '\r\n');
      assert.equal(runCli(['ingest', '--root', a.root], { home: a.home }).status, 0);
      assert.equal(runCli(['ingest', '--root', b.root], { home: b.home }).status, 0);
      const da = storeDigest(a.home);
      const db = storeDigest(b.home);
      assert.equal(da.count, 2);
      assert.deepEqual(da, db);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('zero-byte and no-assistant files ingest with 0 rows, exit 0 and a recorded run; cost has no labels line', () => {
    const ctx = makeHome();
    try {
      writeJsonl(join(ctx.root, 'projects', 'p', 'zero.jsonl'), [], '\n');
      writeJsonl(join(ctx.root, 'projects', 'p', 'useronly.jsonl'), [JSON.stringify({ type: 'user', sessionId: 'x' })], '\n');
      const ing = runCli(['ingest', '--root', ctx.root], { home: ctx.home });
      assert.equal(ing.status, 0, ing.stderr);
      assert.match(ing.stdout, /^ingest: files=2 lines=0 assistant=0 kept=0 unparseable=0 rejected=none\n$/m);
      assert.equal(queryDb(STORE(ctx.home), 'SELECT count(*) AS n FROM ingest_run')[0].n, 1);
      assert.equal(queryDb(STORE(ctx.home), 'SELECT count(*) AS n FROM cc_message')[0].n, 0);
      const out = runCli(['cost'], { home: ctx.home });
      assert.equal(out.status, 0);
      const p = parseCost(out.stdout);
      // Plan 01-08: the freshness block has a line per source, so the report ends with the period line and no rows.
      assert.ok(p.lines.length >= 3, out.stdout);
      assert.ok(p.freshness.startsWith('freshness:'));
      assert.equal(p.lines[p.lines.length - 1], 'no rows');
      assert.ok(p.lines[p.lines.length - 2].startsWith('period:'));
      assert.equal(p.labels, null);
      assert.ok(!/\d+\s+\d+/.test(p.lines[p.lines.length - 1]), 'no number cells');
    } finally {
      ctx.cleanup();
    }
  });

  it('cost on a HOME with no earlier ingest exits 0 and prints the empty report', () => {
    const ctx = makeHome();
    try {
      const out = runCli(['cost'], { home: ctx.home });
      assert.equal(out.status, 0, out.stderr);
      assert.equal(
        out.stdout,
        'freshness: no ingest recorded\nperiod: last 7 days, from 2026-10-21T12:00:00.000Z (default), tz=UTC, calls_ts_unknown=0\nno rows\n',
      );
      assert.ok(!out.stdout.includes('labels:'));
    } finally {
      ctx.cleanup();
    }
  });
});

describe('state and robustness', () => {
  it('creates only HOME/.rigorscope, with modes 0700 and 0600, and never changes its sources', () => {
    const ctx = fullTree();
    try {
      const before = treeDigest(ctx.root);
      const top = readdirSync(ctx.home).sort();
      assert.deepEqual(top, ['.claude']);
      assert.equal(runCli(['ingest', '--root', ctx.root], { home: ctx.home }).status, 0);
      assert.equal(runCli(['cost'], { home: ctx.home }).status, 0);
      assert.deepEqual(readdirSync(ctx.home).sort(), ['.claude', '.rigorscope']);
      assert.equal(treeDigest(ctx.root), before, 'sources are read-only');
      const dir = stateDirOf(ctx.home);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      for (const name of listState(ctx.home)) {
        assert.match(name, /^(store\.db(-wal|-shm)?|derived\.db)$/, `unexpected state file ${name}`);
        assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
      }
      assert.ok(existsSync(STORE(ctx.home)) && existsSync(DERIVED(ctx.home)));
    } finally {
      ctx.cleanup();
    }
  });

  it('exits 2 on usage errors and 0 on --help', () => {
    const ctx = makeHome();
    try {
      assert.equal(runCli(['bogus-command'], { home: ctx.home }).status, 2);
      assert.equal(runCli([], { home: ctx.home }).status, 2);
      // 01-02: ingest with no --root now discovers the roots, so only a bad --root is a usage error.
      assert.equal(runCli(['ingest', '--root', join(ctx.home, 'no-such-dir')], { home: ctx.home }).status, 2);
      assert.equal(runCli(['cost', '--no-such-flag'], { home: ctx.home }).status, 2);
      const help = runCli(['--help'], { home: ctx.home });
      assert.equal(help.status, 0);
      assert.match(help.stdout, /ingest/);
      assert.match(help.stdout, /cost/);
      assert.equal(runCli(['-h'], { home: ctx.home }).status, 0);
      assert.deepEqual(listState(ctx.home).filter((n) => n.endsWith('.db')), [], 'usage errors write no database');
    } finally {
      ctx.cleanup();
    }
  });

  it('ingest twice leaves the row count and key/token digest unchanged; cost twice prints identical output', () => {
    const ctx = fullTree();
    try {
      runCli(['ingest', '--root', ctx.root], { home: ctx.home });
      const first = storeDigest(ctx.home);
      const cost1 = runCli(['cost'], { home: ctx.home }).stdout;
      const second = runCli(['ingest', '--root', ctx.root], { home: ctx.home });
      assert.equal(second.status, 0);
      assert.deepEqual(storeDigest(ctx.home), first);
      assert.equal(first.count, EXPECTED_COUNTS.rows);
      const cost2 = runCli(['cost'], { home: ctx.home }).stdout;
      const cost3 = runCli(['cost'], { home: ctx.home }).stdout;
      assert.equal(cost2, cost3, 'cost twice prints identical output');
      assert.deepEqual(parseCost(cost1).rows, parseCost(cost2).rows);
      assert.equal(queryDb(STORE(ctx.home), 'SELECT count(*) AS n FROM ingest_run')[0].n, 2);
    } finally {
      ctx.cleanup();
    }
  });

  it('a throw before the rename keeps derived.db byte-identical and leaves no temp file', async () => {
    const ctx = fullTree();
    try {
      runCli(['ingest', '--root', ctx.root], { home: ctx.home });
      const { rebuildDerived } = await mod('derive/rebuild.mjs');
      rebuildDerived({ home: ctx.home });
      const before = sha256File(DERIVED(ctx.home));
      assert.throws(
        () => rebuildDerived({ home: ctx.home, beforeRename: () => { throw new Error('boom-before-rename'); } }),
        /boom-before-rename/,
      );
      assert.equal(sha256File(DERIVED(ctx.home)), before);
      assert.deepEqual(listState(ctx.home).filter((n) => n.endsWith('.tmp')), []);
    } finally {
      ctx.cleanup();
    }
  });

  it('a leftover temp-named file neither blocks a rebuild nor is ever promoted', async () => {
    const ctx = fullTree();
    try {
      runCli(['ingest', '--root', ctx.root], { home: ctx.home });
      const { rebuildDerived } = await mod('derive/rebuild.mjs');
      const { ensureStateDir } = await mod('db.mjs');
      ensureStateDir(ctx.home);
      const dir = stateDirOf(ctx.home);
      const mine = join(dir, `derived.db.${process.pid}.tmp`);
      const foreign = join(dir, 'derived.db.99999999.tmp');
      writeFileSync(mine, 'JUNK-not-a-database');
      writeFileSync(foreign, 'JUNK-other-process');
      rebuildDerived({ home: ctx.home });
      const head = readFileSync(DERIVED(ctx.home)).subarray(0, 16).toString('latin1');
      assert.equal(head, 'SQLite format 3\0', 'derived.db is a real database, not the junk file');
      const rows = queryDb(DERIVED(ctx.home), 'SELECT count(*) AS n FROM api_call');
      assert.equal(rows[0].n, EXPECTED_COUNTS.rows);
      assert.equal(existsSync(mine), false, 'own temp name is removed');
      assert.equal(readFileSync(foreign, 'utf8'), 'JUNK-other-process', 'a foreign temp file is left alone');
    } finally {
      ctx.cleanup();
    }
  });

  it('two cost processes started together both exit 0 with identical stdout', async () => {
    const ctx = fullTree();
    try {
      runCli(['ingest', '--root', ctx.root], { home: ctx.home });
      const solo = runCli(['cost'], { home: ctx.home }).stdout;
      const [a, b] = await Promise.all([
        runCliAsync(['cost'], { home: ctx.home }),
        runCliAsync(['cost'], { home: ctx.home }),
      ]);
      assert.equal(a.status, 0, a.stderr);
      assert.equal(b.status, 0, b.stderr);
      assert.equal(a.stdout, b.stdout);
      assert.equal(a.stdout, solo);
    } finally {
      ctx.cleanup();
    }
  });

  it('the fixture home really holds the planted OS user name, a space and a hash character', () => {
    const ctx = makeHome();
    try {
      assert.ok(ctx.home.includes(PLANTS.osUser));
      assert.ok(ctx.home.includes(' '));
      assert.ok(ctx.home.includes('#'));
      assert.equal(SESSION.s1.length > 0, true);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('measure contract (tracer minimum)', () => {
  const load = () => mod('measure/measure.mjs');

  it('exposes exactly the seven source labels', async () => {
    const { LABELS } = await load();
    assert.deepEqual(
      [...LABELS].sort(),
      ['derived', 'estimated', 'measured', 'otel', 'reconstructed', 'transcript', 'unavailable'],
    );
  });

  it('throws on a label outside the seven, and on a known label for a null value', async () => {
    const { makeMeasure } = await load();
    assert.throws(() => makeMeasure({ value: 1, n: 1, label: 'guessed' }), TypeError);
    assert.throws(() => makeMeasure({ value: 1, n: 1, label: 'Measured' }), TypeError);
    assert.throws(() => makeMeasure({ value: 1, n: 1, label: undefined }), TypeError);
    assert.throws(() => makeMeasure({ value: null, n: 1, label: 'transcript' }), TypeError);
    assert.throws(() => makeMeasure({ value: Number.NaN, n: 1, label: 'transcript' }), TypeError);
  });

  it('a null value forces the label unavailable', async () => {
    const { makeMeasure, unknown } = await load();
    assert.equal(makeMeasure({ value: null, n: 0 }).label, 'unavailable');
    assert.equal(unknown({ label: 'transcript' }).label, 'unavailable');
    assert.equal(unknown().value, null);
  });

  it('fromAggregate over zero members is null with n 0, never 0', async () => {
    const { fromAggregate, cell } = await load();
    const m = fromAggregate({ sum: null, known: 0, n: 0, label: 'transcript' });
    assert.equal(m.value, null);
    assert.equal(m.n, 0);
    assert.equal(cell(m), '?');
    const m0 = fromAggregate({ sum: 0, known: 0, n: 0, label: 'transcript' });
    assert.equal(m0.value, null, 'a sum of 0 over no members is still unknown');
  });

  it('a partial aggregate is null with coverage known over n; a full one is known', async () => {
    const { fromAggregate, cell } = await load();
    const partial = fromAggregate({ sum: 7, known: 1, n: 2, label: 'transcript' });
    assert.equal(partial.value, null);
    assert.equal(partial.n, 2);
    assert.equal(partial.coverage, 0.5);
    assert.equal(partial.label, 'unavailable');
    assert.equal(cell(partial), '?');
    const full = fromAggregate({ sum: 7, known: 2, n: 2, label: 'transcript' });
    assert.equal(full.value, 7);
    assert.equal(full.label, 'transcript');
    assert.equal(cell(full), '7');
    const zero = fromAggregate({ sum: 0, known: 3, n: 3, label: 'transcript' });
    assert.equal(cell(zero), '0', 'a genuine zero renders 0');
  });

  it('known() carries its value and label; cell() never turns null into 0', async () => {
    const { known, unknown, cell } = await load();
    const k = known(0, { label: 'transcript', n: 1 });
    assert.equal(k.value, 0);
    assert.equal(cell(k), '0');
    assert.equal(cell(unknown()), '?');
  });
});

describe('sqlite3 CLI', () => {
  const have = spawnSync('sqlite3', ['-version']).status === 0;
  const skip = have ? false : 'sqlite3 binary not found';
  let ctx;
  let ready;
  // Lazy setup inside the tests (not a hook), so a missing module fails a test, not the whole run.
  const setup = () => {
    ready ??= (async () => {
      ctx = fullTree();
      runCli(['ingest', '--root', ctx.root], { home: ctx.home });
      runCli(['cost'], { home: ctx.home });
      const { checkpointStore } = await mod('db.mjs');
      checkpointStore({ home: ctx.home });
    })();
    return ready;
  };
  after(() => ctx?.cleanup());

  const sql = (file, text) => {
    const r = spawnSync('sqlite3', ['-readonly', file, text], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };

  it('opens store.db and derived.db read-only twice, lists the tables, leaves the bytes unchanged', { skip }, async () => {
    await setup();
    for (const [file, tables] of [[STORE(ctx.home), ['cc_message', 'ingest_run']], [DERIVED(ctx.home), ['api_call', 'derive_state']]]) {
      const before = sha256File(file);
      const one = sql(file, '.tables');
      const two = sql(file, '.tables');
      assert.equal(one, two);
      for (const t of tables) assert.ok(one.includes(t), `${t} listed`);
      assert.equal(sha256File(file), before, 'main database file byte-identical');
    }
  });

  it('every table is STRICT and integrity_check prints ok', { skip }, async () => {
    await setup();
    for (const file of [STORE(ctx.home), DERIVED(ctx.home)]) {
      const lax = sql(file, "SELECT count(*) FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' AND strict=0");
      const strict = sql(file, "SELECT count(*) FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' AND strict=1");
      assert.equal(lax, '0', 'no non-STRICT table');
      // Plan 02-02: later migrations and passes add tables, so the counts are floors: nineteen store tables since
      // migration 007 (repo, dir_repo, unit_obs, unit_artifact); ten derived tables since 02-02 (repo_label, unit).
      assert.ok(Number(strict) >= (file === STORE(ctx.home) ? 19 : 10), 'nineteen store tables since migration 007 (fifteen after 004, thirteen after 003, ten after 002); ten derived tables since 02-02 (repo_label, unit), eight since 01-07 (otel_call, join_stat), six since 01-06, three since 01-04 (api_call, api_call_part, derive_state)');
      assert.equal(sql(file, 'PRAGMA integrity_check'), 'ok');
    }
  });
});
