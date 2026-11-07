// Plan 01-08 (COST-04, COST-05, TRUST-01, TRUST-02, D-09): the versioned JSON documents. Written before the code
// (RED). The report objects come from loadCostReport on the cases report-shape, iterations and usage-window; the
// evidence object is built by hand. A document that is not JSON fails an assertion, never a TypeError.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildFixtureTree, cliEnv, makeHome, runCli } from '../fixtures/build.mjs';
import { DST_NOW } from '../fixtures/clock.mjs';
import { periodOf } from '../fixtures/period.mjs';
import { SNAPSHOTS, writeUsageCache } from '../fixtures/usage-cache.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const LA = 'America/Los_Angeles';
const nowFn = () => new Date(DST_NOW);

async function reportFor(caseId, opts = {}) {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases: [caseId] });
  assert.equal(runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home) }).status, 0);
  if (caseId === 'usage-window') {
    // The snapshot series of window-cost.test.mjs: caches B, C and E, with an ingest after each.
    for (const snap of [SNAPSHOTS.B, SNAPSHOTS.C, SNAPSHOTS.E]) {
      writeUsageCache(ctx.home, snap);
      assert.equal(runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home) }).status, 0);
    }
  }
  const { ensureDerived } = await mod('derive/ensure.mjs');
  const { loadCostReport } = await mod('report/cost.mjs');
  ensureDerived({ home: ctx.home, now: nowFn });
  let report;
  try { report = loadCostReport({ home: ctx.home, now: nowFn, tz: LA, period: periodOf({ mode: 'all', tz: LA }), ...opts }); } catch { report = { rows: [] }; }
  return { report, cleanup: ctx.cleanup };
}
const doc = async (report, options) => {
  const { renderCostJson } = await mod('report/render-json.mjs');
  const text = renderCostJson(report, options);
  try { return { text, json: JSON.parse(text) }; } catch { return { text, json: null }; }
};
const EVIDENCE = {
  rowKey: 'main/total', section: 'main', total: true, dims: [], calls: 1, sessions: 1, listed: 1, tz: 'UTC', asOfMs: Date.parse(DST_NOW), clockFixed: true,
  period: periodOf({ mode: 'all' }), callsTsUnknown: 0,
  freshnessCheck: { verdict: 'none', nowMs: Date.parse(DST_NOW), sources: [] },
  items: [{
    callKey: 'm:msg_x', sessionId: 'sess', agentId: '', messageId: 'msg_x', requestId: null, tsUtc: '2026-11-01T00:00:00.000Z', occurrences: 1,
    files: [{ root: 'claude', path: '~-p/sess.jsonl', offset: null }],
  }],
};

describe('renderCostJson on report-shape', () => {
  let h;
  let d;
  before(async () => {
    h = await reportFor('report-shape', { by: ['role', 'model', 'effort', 'day', 'session', 'repo'] });
    d = await doc(h.report, undefined);
  });
  after(() => h.cleanup());

  it('prints one document that ends with a newline and uses two-space indentation', () => {
    assert.ok(d.json, 'the output is JSON');
    assert.equal(d.text.endsWith('}\n'), true);
    assert.match(d.text, /^\{\n {2}"schema": "rigorscope.cost\/1",\n/);
  });
  it('has the fixed top-level key order', () => {
    assert.deepEqual(Object.keys(d.json ?? {}), ['schema', 'as_of_utc', 'clock_fixed', 'freshness', 'period', 'by', 'population', 'populations', 'units', 'labels', 'by_labels', 'window_usage', 'sections', 'footer', 'filters']);
  });
  it('every measured cell has exactly value, n, label, coverage and evidence in that order', () => {
    const row = d.json?.sections?.main?.rows?.[0];
    for (const c of ['input', 'output', 'cache_read', 'cache_write', 'notional_usd', 'window_5h', 'window_7d']) {
      assert.deepEqual(Object.keys(row?.[c] ?? {}), ['value', 'n', 'label', 'coverage', 'evidence'], c);
    }
  });
  it('an unknown cell is null with label unavailable, never 0 and never a string', () => {
    const cell = d.json?.sections?.main?.rows?.[0]?.window_5h;
    assert.equal(cell?.value, null);
    assert.equal(cell?.label, 'unavailable');
  });
  it('money is integer nano-dollars with unit nano_usd', () => {
    const row = d.json?.sections?.main?.rows?.[0];
    assert.equal(row?.notional_usd?.value, 15000); // 100 x 100 + 10 x 500
    assert.equal(d.json?.units?.notional_usd, 'nano_usd');
    assert.equal(d.json?.sections?.main?.total?.notional_usd?.value, 675000);
  });
  it('tokens are integers and carry the transcript label on the main section', () => {
    const t = d.json?.sections?.main?.total;
    assert.deepEqual([t?.input?.value, t?.output?.value, t?.input?.label, t?.calls], [550, 70, 'transcript', 6]);
  });
  it('the evidence field of every cell is the row key and the total row key is section/total', () => {
    const row = d.json?.sections?.main?.rows?.[0];
    assert.equal(row?.input?.evidence, row?.key);
    assert.equal(d.json?.sections?.main?.total?.key, 'main/total');
  });
  it('rows keep the text order and carry dims with value and label', () => {
    const rows = d.json?.sections?.main?.rows ?? [];
    assert.equal(rows.length, 6);
    assert.deepEqual(rows[0]?.dims?.repo, { value: 'rigorscope', label: 'reconstructed' });
    assert.deepEqual(rows[5]?.dims?.repo, { value: null, label: 'reconstructed' });
  });
  it('the total check and an empty section are explicit', () => {
    assert.deepEqual(d.json?.sections?.main?.total_check, { ok: true, columns: [] });
    assert.deepEqual(d.json?.sections?.otel, { rows: [], total: null, total_check: null });
  });
  it('the footer holds the plain-data footer lines in snake_case and nothing else', () => {
    assert.deepEqual(Object.keys(d.json?.footer ?? {}), ['conservation', 'counts', 'totals', 'pricing', 'notional', 'window', 'join', 'roles', 'otel_only', 'crosscheck', 'error_band', 'rules']);
  });
  it('no key or value holds an absolute path', () => {
    assert.equal(/\/(home|Users|mnt)\//.test(d.text), false);
  });
  it('the evidence map is present only with the option', async () => {
    const without = await doc(h.report, undefined);
    const withEv = await doc(h.report, { evidence: { 'main/total': EVIDENCE } });
    assert.equal(Object.hasOwn(without.json ?? {}, 'evidence'), false);
    assert.deepEqual(Object.keys(withEv.json?.evidence ?? {}), ['main/total']);
    assert.equal(withEv.json?.evidence?.['main/total']?.schema, 'rigorscope.evidence/1');
  });
  it('an injected NaN or Infinity throws instead of becoming null', async () => {
    const { renderCostJson } = await mod('report/render-json.mjs');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const broken = structuredClone(h.report);
      broken.rows[0].input = { value: bad, n: 1, label: 'transcript', coverage: 1, evidence: null };
      assert.throws(() => renderCostJson(broken), TypeError);
    }
  });
});

describe('renderCostJson on other cases', () => {
  it('window cells are percent points labeled estimated on the usage-window case', async () => {
    const h = await reportFor('usage-window', { by: ['role'] });
    try {
      const d = await doc(h.report, undefined);
      const cells = (d.json?.sections?.main?.rows ?? []).map((r) => r.window_7d);
      assert.ok(cells.length > 0 && cells.some((c) => c.value !== null), 'a known window cell exists');
      for (const c of cells) assert.equal(c.value === null ? c.label === 'unavailable' : c.label === 'estimated', true);
      assert.equal(d.json?.units?.window_7d, 'percent_of_window');
      assert.notEqual(d.json?.window_usage, null);
    } finally { h.cleanup(); }
  });
  it('the iterations case rows match the report rows cell for cell', async () => {
    const h = await reportFor('iterations', { by: ['role', 'model'] });
    try {
      const d = await doc(h.report, undefined);
      const rows = d.json?.sections?.main?.rows ?? [];
      assert.equal(rows.length, h.report.rows.length);
      assert.ok(rows.length > 0);
      rows.forEach((jr, i) => {
        assert.equal(jr.input.value, h.report.rows[i].input.value);
        assert.equal(jr.dims.model.value, h.report.rows[i].model);
      });
    } finally { h.cleanup(); }
  });
  it('an empty store gives empty rows, null totals and window_usage and no cell-bearing structure', async () => {
    const ctx = makeHome();
    try {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      const { loadCostReport } = await mod('report/cost.mjs');
      ensureDerived({ home: ctx.home, now: nowFn });
      const d = await doc(loadCostReport({ home: ctx.home, now: nowFn, tz: 'UTC' }), undefined);
      assert.deepEqual(d.json?.sections?.main, { rows: [], total: null, total_check: null });
      assert.equal(d.json?.window_usage, null);
      assert.deepEqual(d.json?.footer, {});
    } finally { ctx.cleanup(); }
  });
});

describe('renderEvidenceJson', () => {
  it('has the fixed key order, the schema string and snake_case items', async () => {
    const { renderEvidenceJson } = await mod('report/render-json.mjs');
    let json = null;
    try { json = JSON.parse(renderEvidenceJson(EVIDENCE)); } catch { json = null; }
    assert.deepEqual(Object.keys(json ?? {}), ['schema', 'as_of_utc', 'clock_fixed', 'freshness', 'period', 'row_key', 'section', 'dims', 'calls', 'sessions', 'listed', 'items']);
    assert.equal(json?.schema, 'rigorscope.evidence/1');
    assert.deepEqual(Object.keys(json?.items?.[0] ?? {}), ['call_key', 'session_id', 'agent_id', 'message_id', 'request_id', 'ts_utc', 'occurrences', 'files']);
    assert.deepEqual(json?.items?.[0]?.files?.[0], { root: 'claude', path: '~-p/sess.jsonl', offset: null });
    assert.equal(json?.items?.[0]?.request_id, null);
  });
  it('throws on a non-finite number', async () => {
    const { renderEvidenceJson } = await mod('report/render-json.mjs');
    assert.throws(() => renderEvidenceJson({ ...EVIDENCE, calls: Number.NaN }), TypeError);
  });
});
