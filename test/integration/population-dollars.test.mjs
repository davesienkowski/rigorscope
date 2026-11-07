// Plan 03-04 review fix MEDIUM-5 (LEDG-08, D-17): loadPopulationDollars and loadWindowBuckets are pinned with exact nano-dollar
// figures on the tier fixture (36 units with attributed calls) plus one forward unit, ga0, with a ledger line at 08:02 on
// 2026-10-02 (its calls are at 08:00 and 08:05). The expectations are plain sums over api_call parts selected by explicit call
// instants and the model, never through the attribution join the loaders use: forward = the ga0 calls, overlap = the multi-unit
// scope O (2026-10-03 08:30, 08:35) and the low-only scope L (2026-10-01 13:00, 13:05, overlap in mode medium), unlinked = the
// scope N (2026-10-04 09:00), reconstructed = the rest. Run on one model (M1) so every dollar is known. Temporary HOME only.
// Mutations this file must catch: drop the cutoff (`c.ts_ms >= ?`), use link confidence low, swap the population group key.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  cliEnv, ingestHome, makeHome, queryDb, runCli, stateDirOf,
} from '../fixtures/build.mjs';
import { STRATA_NOW, buildStrataHome, lineText } from '../fixtures/strata-home.mjs';
import { MODEL_M1, REPO_KEY as TIERS_REPO_KEY, TIER_SPEC } from '../fixtures/tier-home.mjs';
import { loadPopulationDollars, loadWindowBuckets } from '../../src/report/unit-cost.mjs';

const CUTOFF = '2026-10-02T08:02:00.000Z';
const CUTOFF_MS = Date.parse(CUTOFF);
const GA0 = TIER_SPEC.find((s) => s.id === 'ga0');
const env = (home) => cliEnv(home, { TZ: 'UTC', RIGORSCOPE_NOW: STRATA_NOW });
const ONLY_M1 = { sql: 'c.model = ?', params: [MODEL_M1] };
const FORWARD_TS = ['2026-10-02T08:00:00.000Z', '2026-10-02T08:05:00.000Z'];
const OVERLAP_TS = ['2026-10-03T08:30:00.000Z', '2026-10-03T08:35:00.000Z'];
const LOW_ONLY_TS = ['2026-10-01T13:00:00.000Z', '2026-10-01T13:05:00.000Z'];
const UNLINKED_TS = ['2026-10-04T09:00:00.000Z'];

describe('loadPopulationDollars and loadWindowBuckets: exact figures (03-04 review fix MEDIUM-5)', () => {
  let ctx;
  let file;
  const sum = (where, params = []) => queryDb(file, `SELECT sum(p.cost_nano) AS n FROM api_call c JOIN api_call_part p ON p.call_key = c.call_key
    WHERE c.token_label = 'transcript' AND c.model = ? AND ${where}`, [MODEL_M1, ...params])[0].n;
  const inList = (list) => `c.ts_utc IN (${list.map(() => '?').join(',')})`;
  const withDb = (fn) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  before(async () => {
    ctx = makeHome();
    buildStrataHome({
      home: ctx.home,
      root: ctx.root,
      base: 'tier',
      texts: [lineText({
        record: 'start', ts: CUTOFF, native_id: GA0.idFull, repo_key: TIERS_REPO_KEY, tier: 'C', tier_source: 'plan-at-start',
      })],
    });
    await ingestHome(ctx.home, env(ctx.home));
    assert.equal(runCli(['units'], { home: ctx.home, env: env(ctx.home) }).status, 0, 'a report builds derived.db');
    file = join(stateDirOf(ctx.home), 'derived.db');
  });
  after(() => ctx.cleanup());

  // Expected, from explicit call instants.
  const expectAll = () => {
    const forwardAll = sum(inList(FORWARD_TS), FORWARD_TS);
    const total = sum('1 = 1');
    const lowOnly = sum(inList(LOW_ONLY_TS), LOW_ONLY_TS);
    const overlap = sum(inList(OVERLAP_TS), OVERLAP_TS);
    const unlinked = sum(inList(UNLINKED_TS), UNLINKED_TS);
    return {
      forwardAll, total, reconstructed: total - forwardAll - lowOnly - overlap - unlinked,
    };
  };

  it('without a cutoff: the forward numerator is both ga0 calls, the reconstructed numerator is the rest, the denominator every main call', () => {
    const e = expectAll();
    const d = withDb((db) => loadPopulationDollars(db, { callWhere: ONLY_M1 }));
    assert.equal(d.attributed.get('forward'), e.forwardAll);
    assert.equal(d.attributed.get('reconstructed'), e.reconstructed);
    assert.equal(d.total_nano, e.total);
    assert.ok(e.forwardAll > 0 && e.reconstructed > 0);
  });

  it('with the cutoff instant: the calls before it leave the numerator and the denominator alike (the cutoff filter)', () => {
    const e = expectAll();
    const preAll = sum('c.ts_ms < ?', [CUTOFF_MS]);
    const pre0800 = sum(inList([FORWARD_TS[0]]), [FORWARD_TS[0]]);
    const preLowOnly = sum(inList(LOW_ONLY_TS), LOW_ONLY_TS);
    assert.ok(pre0800 > 0 && preLowOnly > 0 && preAll > pre0800 + preLowOnly, 'gb4 is a reconstructed unit before the cutoff too');
    const d = withDb((db) => loadPopulationDollars(db, { callWhere: ONLY_M1, sinceMs: CUTOFF_MS }));
    assert.equal(d.attributed.get('forward'), e.forwardAll - pre0800, 'only the 08:05 call of ga0');
    assert.equal(d.attributed.get('reconstructed'), e.reconstructed - (preAll - pre0800 - preLowOnly));
    assert.equal(d.total_nano, e.total - preAll);
  });

  it('link confidence is medium whatever the caller says elsewhere: the low-only scope L is not attributed to a unit', () => {
    const e = expectAll();
    const d = withDb((db) => loadPopulationDollars(db, { callWhere: ONLY_M1 }));
    // In mode low L is attributed to gb4 (a reconstructed unit), which would add its two calls to the reconstructed numerator.
    const lowOnly = sum(inList(LOW_ONLY_TS), LOW_ONLY_TS);
    assert.ok(lowOnly > 0);
    assert.equal(d.attributed.get('reconstructed'), e.reconstructed);
    assert.notEqual(d.attributed.get('reconstructed'), e.reconstructed + lowOnly);
  });

  it('the population group key: forward is the ledger unit and reconstructed the rest, never swapped', () => {
    const d = withDb((db) => loadPopulationDollars(db, { callWhere: ONLY_M1 }));
    assert.deepEqual([...d.attributed.keys()].sort(), ['forward', 'reconstructed']);
    assert.ok(d.attributed.get('forward') < d.attributed.get('reconstructed'), 'one unit against the rest');
  });

  it('loadWindowBuckets: the four buckets since the cutoff add up to the independent total, exact per bucket', () => {
    const e = expectAll();
    const { rows, total } = withDb((db) => loadWindowBuckets(db, { callWhere: ONLY_M1, sinceMs: CUTOFF_MS }));
    const by = (bucket, population = null) => rows.find((r) => r.bucket === bucket && r.population === population);
    assert.equal(by('attributed', 'forward').usd_nano, sum(inList([FORWARD_TS[1]]), [FORWARD_TS[1]]));
    assert.equal(by('unattributed_overlap').usd_nano, sum(inList(OVERLAP_TS), OVERLAP_TS), 'L is before the cutoff, O after');
    assert.equal(by('unlinked').usd_nano, sum(inList(UNLINKED_TS), UNLINKED_TS));
    assert.equal(total.usd_nano, e.total - sum('c.ts_ms < ?', [CUTOFF_MS]));
    assert.equal(rows.reduce((n, r) => n + r.usd_nano, 0), total.usd_nano);
    assert.equal(rows.reduce((n, r) => n + r.calls, 0), total.calls);
  });
});
