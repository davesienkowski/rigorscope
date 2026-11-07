// Plan 03-05 review fix M4/M5 (D-25): the advisor-part query of the decision sheet, run against real api_call and api_call_part rows
// of a temporary derived.db. The windows: baseline = the 7 days before the first snapshot with a different advisor_model, trial = the 7
// days from it. Boundaries: a window holds ts_ms >= its start and < its end. Only kind = 'advisor' parts of calls whose token label is
// transcript count; a part with no price makes its model's dollars unknown, never a partial sum.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ingestHome, makeHome, runCli, stateDirOf } from '../fixtures/build.mjs';
import { buildCalibrateHome, calEnv } from '../fixtures/calibrate-home.mjs';
import { loadAdvisorTrial } from '../../src/report/advisor-trial.mjs';

const DAY = 86_400_000;
const T = (iso) => Date.parse(iso);
const START = T('2026-10-31T00:00:00Z'); // the first snapshot with the second model
const END = START + 7 * DAY;
const BASE_LO = START - 7 * DAY;
const ASOF = T('2026-11-08T00:00:00Z');

let seq = 0;
function insertPart(db, { ts, kind = 'advisor', model, cost, label = 'transcript' }) {
  seq += 1;
  const key = `call-${seq}`;
  const otelOnly = label === 'otel';
  db.prepare(`INSERT INTO api_call (call_key, message_id, owner_session_id, owner_agent_id, occurrences, role, role_rule, role_source,
                                   join_state, price_basis, iter_mismatch, iter_unknown_type, token_label, ts_ms)
              VALUES (?, ?, 's', '', 1, 'main', 'main', 'transcript', ?, 'iterations', 0, 0, ?, ?)`)
    .run(key, otelOnly ? null : `m-${seq}`, otelOnly ? 'otel_only' : 'transcript_only', label, ts);
  if (cost === null) {
    db.prepare("INSERT INTO api_call_part (call_key, part_seq, kind, model, price_status, cost_nano) VALUES (?, 0, ?, ?, 'unknown_tokens', NULL)").run(key, kind, model);
  } else {
    db.prepare("INSERT INTO api_call_part (call_key, part_seq, kind, model, price_status, price_tier, cost_nano) VALUES (?, 0, ?, ?, 'priced', 'standard', ?)")
      .run(key, kind, model, cost);
  }
}

describe('advisor-trial parts: baseline and trial windows over real rows (review M4, M5)', () => {
  let ctx;
  let res;
  before(async () => {
    ctx = makeHome();
    await buildCalibrateHome({ home: ctx.home, root: ctx.root });
    writeFileSync(join(ctx.root, 'settings.json'), JSON.stringify({ advisorModel: 'adv-model-one' }));
    await ingestHome(ctx.home, calEnv(ctx.home, { RIGORSCOPE_NOW: '2026-10-30T00:00:00Z' }));
    writeFileSync(join(ctx.root, 'settings.json'), JSON.stringify({ advisorModel: 'adv-model-two' }));
    await ingestHome(ctx.home, calEnv(ctx.home, { RIGORSCOPE_NOW: '2026-10-31T00:00:00Z' }));
    assert.equal(runCli(['units', '--json'], { home: ctx.home, env: calEnv(ctx.home, { RIGORSCOPE_NOW: '2026-10-31T00:00:00Z' }) }).status, 0);
    const db = new DatabaseSync(join(stateDirOf(ctx.home), 'derived.db'));
    // baseline window [START - 7 days, START)
    insertPart(db, { ts: BASE_LO, model: 'adv-A', cost: 2_000_000_000 }); // the lower bound is inclusive
    insertPart(db, { ts: START - DAY, model: 'adv-A', cost: 1_000_000_000 });
    insertPart(db, { ts: START - DAY, model: 'adv-U', cost: null }); // unpriced next to a priced part: the model's dollars are unknown
    insertPart(db, { ts: START - 2 * DAY, model: 'adv-U', cost: 1_000_000_000 });
    insertPart(db, { ts: BASE_LO - 1, model: 'adv-A', cost: 9_000_000_000 }); // just before the baseline window
    // trial window [START, END)
    insertPart(db, { ts: START, model: 'adv-B', cost: 1_000_000_000 }); // the start is inclusive (not in the baseline)
    insertPart(db, { ts: START + 2 * DAY, model: 'adv-B', cost: 2_000_000_000 });
    insertPart(db, { ts: END, model: 'adv-B', cost: 9_000_000_000 }); // the end is exclusive
    insertPart(db, { ts: START + DAY, model: 'adv-B', kind: 'message', cost: 9_000_000_000 }); // a message part is not an advisor part
    insertPart(db, { ts: START + DAY, model: 'adv-B', label: 'otel', cost: 9_000_000_000 }); // only transcript tokens count
    db.close();
    res = loadAdvisorTrial({ home: ctx.home, asOfMs: ASOF });
  });
  after(() => ctx.cleanup());

  it('the state has the baseline window of 7 days before the first differing snapshot and the trial window after it', () => {
    assert.equal(res.state.window_start_ms, START);
    assert.equal(res.state.window_end_ms, END);
    assert.equal(res.state.baseline_start_ms, BASE_LO);
    assert.equal(res.state.full, true);
    assert.equal(res.scope, 'window');
  });

  it('baseline window: advisor parts by model, bounds inclusive below and exclusive above, unpriced makes the dollars unknown', () => {
    assert.deepEqual(res.baseline, [
      { model: 'adv-A', parts: 2, usd_nano: 3_000_000_000 },
      { model: 'adv-U', parts: 2, usd_nano: null },
    ]);
  });

  it('trial window: only advisor parts of transcript calls inside [start, end)', () => {
    assert.deepEqual(res.trial, [{ model: 'adv-B', parts: 2, usd_nano: 3_000_000_000 }]);
  });

  it('through the CLI the advisor-trial row names both windows with n per window, and n is the smaller one', () => {
    const r = runCli(['cost', '--sheet', '--json'], { home: ctx.home, env: calEnv(ctx.home, { RIGORSCOPE_NOW: '2026-11-08T00:00:00Z' }) });
    assert.equal(r.status, 0, r.stderr);
    const row = JSON.parse(r.stdout).sheet.find((x) => x.id === 'advisor-trial');
    assert.match(row.reason, /baseline window 2026-10-24T00:00:00\.000Z to 2026-10-31T00:00:00\.000Z: 4 parts/);
    assert.match(row.reason, /trial window 2026-10-31T00:00:00\.000Z to 2026-11-07T00:00:00\.000Z: 2 parts/);
    assert.equal(row.n, 2, 'n is the smaller of the two windows');
    assert.equal(row.status, 'cannot', 'n 2 is below the evidence floor of 10');
    assert.match(row.reason, /n 2 is below the floor 10/);
  });
});
