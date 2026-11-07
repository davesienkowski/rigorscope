// TRUST-02 labels across the cost report sections (plan 01-07, RR-05, D-07, D-09, D-12). Written before the code
// (RED). loadCostReport is called as src/commands/cost.mjs calls it, after ensureDerived, on built fixture cases
// and on direct rows. Every Measure in the report carries one of the seven labels; a null value is labeled
// unavailable; main rows carry transcript tokens and derived dollars, otel and harness rows otel tokens and otel
// dollars; no group combines two token labels. Missing report fields fail an assertion, never a TypeError.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildFixtureTree, makeHome, runCli, cliEnv, stateDirOf } from '../fixtures/build.mjs';
import { queryOrEmpty } from '../fixtures/derive-rows.mjs';
import { apiRequestAttrs, insertOtelEvent, openTempStore } from '../fixtures/otel-rows.mjs';
import { LABELS } from '../../src/measure/measure.mjs';
import { Db, openDerivedReadOnly } from '../../src/db.mjs';
import { ensureDerived } from '../../src/derive/ensure.mjs';
import { loadCostReport } from '../../src/report/cost.mjs';
import { renderCostText } from '../../src/report/render-text.mjs';

const NOW = () => new Date('2026-10-28T05:00:00.000Z');
const isMeasure = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && ['value', 'n', 'label', 'coverage'].every((k) => Object.hasOwn(v, k));

// Every Measure-shaped value reachable from the report, with its path.
function measures(value, path = 'report', out = []) {
  if (isMeasure(value)) out.push({ path, m: value });
  else if (Array.isArray(value)) value.forEach((v, i) => measures(v, `${path}[${i}]`, out));
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) measures(v, `${path}.${k}`, out);
  return out;
}
const TOKEN_CELLS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const WINDOW_CELLS = ['window_5h', 'window_7d'];
const labelOf = (m) => m.label;

async function caseReport(cases, by = ['role', 'model']) {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases });
  assert.equal(runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home) }).status, 0);
  ensureDerived({ home: ctx.home, now: NOW });
  return { ctx, report: loadCostReport({ home: ctx.home, by, now: NOW }) };
}

// (section, role, model) groups of derived.db whose parts carry more than one token label, or whose label does
// not belong to the section (main <-> transcript, otel and harness <-> otel).
const MIXED_SQL = `
SELECT c.section, c.role, p.model, count(DISTINCT c.token_label) AS labels,
       sum(CASE WHEN (c.section = 'main') <> (c.token_label = 'transcript') THEN 1 ELSE 0 END) AS misplaced
  FROM api_call_part p JOIN api_call c ON c.call_key = p.call_key
 GROUP BY c.section, c.role, p.model
HAVING count(DISTINCT c.token_label) > 1 OR misplaced > 0`;

describe('labels on case otel-join', () => {
  let ctx;
  let report;
  before(async () => { ({ ctx, report } = await caseReport(['otel-join'])); });
  after(() => ctx.cleanup());

  it('every Measure carries one of the seven labels and a null value is labeled unavailable', () => {
    const all = measures(report);
    assert.ok(all.length >= 12 * 7, 'the main, otel and harness rows hold Measures');
    for (const { m } of all) {
      assert.ok(LABELS.includes(m.label), 'a label from the fixed set');
      if (m.value === null) assert.equal(m.label, 'unavailable');
      else assert.notEqual(m.label, 'unavailable');
    }
  });

  it('main rows carry transcript token cells and derived dollar cells', () => {
    assert.equal(report.rows.length, 6);
    for (const r of report.rows) {
      for (const k of TOKEN_CELLS) assert.equal(r[k].label, 'transcript', k);
      assert.equal(r.notionalUsd.label, 'derived');
    }
  });

  it('otel rows carry otel token cells and otel dollar cells', () => {
    assert.ok(Array.isArray(report.otelRows), 'report.otelRows');
    assert.equal(report.otelRows.length, 4);
    for (const r of report.otelRows) {
      for (const k of TOKEN_CELLS) assert.equal(r[k].label, 'otel', k);
      assert.equal(r.notionalUsd.label, 'otel');
    }
  });

  it('harness rows carry otel token cells and otel dollar cells and only harness roles', () => {
    assert.ok(Array.isArray(report.harnessRows), 'report.harnessRows');
    assert.deepEqual(report.harnessRows.map((r) => r.role), ['harness:agent_summary', 'harness:prompt_suggestion']);
    for (const r of report.harnessRows) {
      for (const k of TOKEN_CELLS) assert.equal(r[k].label, 'otel', k);
      assert.equal(r.notionalUsd.label, 'otel');
    }
  });

  it('window cells are estimated or unavailable in every section', () => {
    const rows = [...report.rows, ...(report.otelRows ?? []), ...(report.harnessRows ?? [])];
    assert.equal(rows.length, 12);
    for (const r of rows) for (const k of WINDOW_CELLS) assert.ok(['estimated', 'unavailable'].includes(r[k].label), k);
  });

  it('the labels: line describes the main rows and the labels (otel rows): line the otel and harness rows', () => {
    const lines = renderCostText(report).split('\n');
    const main = lines.find((l) => l.startsWith('labels: '));
    assert.equal(main, 'labels: tokens=transcript notional_usd=derived window_share=unavailable; ? means unknown (label unavailable), never zero');
    const otel = lines.find((l) => l.startsWith('labels (otel rows): '));
    assert.equal(otel, 'labels (otel rows): tokens=otel notional_usd=otel window_share=unavailable');
    const set = new Set([...(report.otelRows ?? []), ...(report.harnessRows ?? [])].flatMap((r) => TOKEN_CELLS.map((k) => labelOf(r[k]))));
    assert.deepEqual([...set], ['otel'], 'the otel line matches the token labels of its rows');
  });

  it('every (section, role, model) group of derived.db has exactly one token label, matching its section', () => {
    const db = openDerivedReadOnly({ home: ctx.home });
    try {
      const cols = db.prepare('PRAGMA table_info(api_call)').all().map((r) => r.name);
      assert.ok(cols.includes('section'), 'api_call has a section column');
      assert.deepEqual(queryOrEmpty(db, MIXED_SQL), []);
      const groups = queryOrEmpty(db, 'SELECT section, token_label, count(*) AS n FROM api_call GROUP BY section, token_label ORDER BY section');
      assert.deepEqual(groups.map((g) => [g.section, g.token_label, g.n]), [['harness', 'otel', 2], ['main', 'transcript', 8], ['otel', 'otel', 7]]);
    } finally {
      db.close();
    }
  });

  it('a part relabeled into the wrong section makes the structural check fail (the check has teeth)', () => {
    const file = join(stateDirOf(ctx.home), 'derived.db');
    const w = new Db(file);
    try {
      const cols = w.prepare('PRAGMA table_info(api_call)').all().map((r) => r.name);
      assert.ok(cols.includes('section'), 'api_call has a section column');
      w.exec('BEGIN');
      w.exec("UPDATE api_call SET token_label = 'transcript' WHERE call_key = 'o:req_oo_5'");
      const bad = queryOrEmpty(w, MIXED_SQL);
      w.exec('ROLLBACK');
      assert.equal(bad.length, 1, 'one mixed or misplaced group');
      assert.deepEqual([bad[0].section, bad[0].role], ['otel', 'Explore']);
    } finally {
      w.close();
    }
  });

  it('nothing printed in a label position comes from data: the two labels lines use fixed words only', () => {
    const text = renderCostText(report);
    for (const l of text.split('\n').filter((x) => x.startsWith('labels'))) {
      assert.match(l, /^labels(?: \(otel rows\))?: tokens=(transcript|otel|unavailable) notional_usd=(derived|otel|unavailable) window_share=(estimated|unavailable)(; \? means unknown \(label unavailable\), never zero)?$/);
    }
    assert.equal(text.split('\n').filter((x) => x.startsWith('labels')).length, 2);
  });
});

describe('labels without OTel rows and with unknown OTel cost', () => {
  it('with no OTel rows there is no otel-labeled cell and no second labels line', async () => {
    const { ctx, report } = await caseReport(['subagents']);
    try {
      assert.deepEqual(report.otelRows, [], 'an empty otel block');
      assert.deepEqual(report.harnessRows, [], 'an empty harness block');
      assert.ok(measures(report).every(({ m }) => m.label !== 'otel'), 'no otel label anywhere');
      const text = renderCostText(report);
      assert.ok(!text.includes('labels (otel rows):'));
      assert.ok(text.includes('labels: tokens=transcript '));
    } finally {
      ctx.cleanup();
    }
  });

  it('an OTel-only request with no cost gives an unavailable dollar cell, never 0, and its tokens stay otel', async () => {
    const ctx = makeHome();
    try {
      const db = openTempStore({ home: ctx.home });
      try {
        insertOtelEvent(db, {
          sessionId: 'caf00000-caf0-4caf-8caf-caf00000caf0', seq: 1, eventTs: '2026-10-27T10:00:00.000Z', requestId: 'req-nocost',
          attrs: apiRequestAttrs({ model: 'claude-haiku-5-5', input: 3, output: 4, cacheRead: 0, cacheCreation: 0, requestId: 'req-nocost', querySource: 'repl_main_thread' }),
        });
      } finally {
        db.close();
      }
      ensureDerived({ home: ctx.home, now: NOW });
      const report = loadCostReport({ home: ctx.home, by: ['role', 'model'], now: NOW });
      assert.equal(report.otelRows?.length, 1, 'one otel row');
      const row = report.otelRows[0];
      assert.deepEqual([row.notionalUsd.value, row.notionalUsd.label], [null, 'unavailable']);
      assert.deepEqual([row.input.value, row.input.label], [3, 'otel']);
      assert.equal(report.rows.length, 0);
      const text = renderCostText(report);
      assert.ok(text.includes('labels (otel rows): tokens=otel notional_usd=otel window_share=unavailable'));
      const otelRow = text.split('\n').find((l) => l.startsWith('main '));
      assert.equal(otelRow?.trim().split(/\s+/)[7], '?', 'the dollar cell prints ?');
    } finally {
      ctx.cleanup();
    }
  });

  it('a harness-only report puts the request in the harness block with otel labels', async () => {
    const ctx = makeHome();
    try {
      const db = openTempStore({ home: ctx.home });
      try {
        insertOtelEvent(db, {
          sessionId: 'caf00000-caf0-4caf-8caf-caf00000caf0', seq: 1, eventTs: '2026-10-27T10:00:00.000Z', requestId: 'req-title',
          attrs: apiRequestAttrs({ model: 'claude-haiku-5-5', input: 2, output: 2, costUsd: 0.000002, requestId: 'req-title', querySource: 'generate_session_title' }),
        });
      } finally {
        db.close();
      }
      ensureDerived({ home: ctx.home, now: NOW });
      const report = loadCostReport({ home: ctx.home, by: ['role'], now: NOW });
      assert.deepEqual(report.harnessRows?.map((r) => [r.role, r.input.label, r.notionalUsd.label]), [['harness:generate_session_title', 'otel', 'otel']]);
      assert.deepEqual(report.otelRows, []);
    } finally {
      ctx.cleanup();
    }
  });
});
