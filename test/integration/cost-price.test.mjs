// Plan 01-05 contract: notional dollars in `rigorscope cost`, written before the pricing code (RED).
// Every dollar literal is hand-computed from the price table rates in nano-dollars per token (one
// nano-dollar is a billionth of a dollar; a rate in dollars per million tokens x 1000 is nano-dollars
// per token) with the arithmetic beside it, never computed by the code under test:
//   claude-opus-5-5    4000, 5000, 8000, 200, 20000      (input, 5m write, 1h write, cache read, output)
//   claude-sonnet-5-5  2000, 2500, 4000, 100, 10000
//   claude-haiku-5-5    100,  125,  200,  10,   500
//   claude-opus-4-8    5000, 6250, 10000, 500, 25000
//   claude-fable-5-0   not a table row (unpriced)
// A cell shows nano-dollars rounded half up to micro-dollars with six decimals; `>=` marks a floor.
//
// Assumed shapes (Tasks 2 and 3 implement them):
//   cost prints, after the table: labels, conservation, counts, totals, pricing, notional
//   parsePriceTable(obj, { fileName, sha }) -> prices; loadPrices({ dir }) -> prices
//   ensureDerived({ home, prices, ownerRule, force }) -> { rebuilt, reason }; reason price_table
//   checkCostConservation(db) -> { ok, total_nano, known_parts, unknown_parts, role_nano, model_nano,
//                                  call_mismatch_calls, violations }
// No planted value is printed in a failure message.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_COST_ROWS, LABELS_LINE, PLANTS, buildFixtureTree, cliEnv, describeCliFailure, isDataRow, makeHome, runCli, runCliAsync,
  sha256File, stateDirOf,
} from '../fixtures/build.mjs';
import { insertIter, insertMessage, openTempStore, queryOrEmpty } from '../fixtures/derive-rows.mjs';
import * as dups from '../fixtures/cases/70-derive-dups.mjs';
import * as roles from '../fixtures/cases/80-derive-roles-iter.mjs';
import * as pricing from '../fixtures/cases/90-pricing.mjs';
import { Db, derivedPath } from '../../src/db.mjs';
import { PRICES_URL, parsePriceTable } from '../../src/derive/price-table.mjs';
import { checkCostConservation } from '../../src/derive/conservation.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);

// The shipped table, found independently of the loader: the newest name by the fixed pattern.
const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));
const SHIPPED = readdirSync(DATA_DIR).filter((n) => /^prices-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().pop();
const SHIPPED_READ = JSON.parse(readFileSync(join(DATA_DIR, SHIPPED), 'utf8')).date_read;
// The table every hand-computed dollar cell in this file was computed against. A newer shipped table means the
// cells must be recomputed by hand from its rates (plan 01-11), not that this name should simply be bumped.
const CELLS_COMPUTED_AGAINST = 'prices-2026-10-28.json';

// Plan 01-06: the window_share column became window_5h and window_7d (each '?' here: no usage snapshot).
const NUM_HEADER = ['calls', 'input', 'output', 'cache_read', 'cache_write', 'notional_usd', 'window_5h', 'window_7d'];
const CONSERVATION_OK = 'conservation: OK (role sums = model sums = part total = store total for each of the 6 token classes)';
const LABELS_DERIVED = 'labels: tokens=transcript notional_usd=derived window_share=unavailable; ' +
  '? means unknown (label unavailable), never zero';
// Plan 01-06: the window footer line of a store with no usage snapshot, for T parts.
const noWindow = (t) => 'window: weights=input:1,output:1,cache_read:1,cache_creation:1 snapshots=0 intervals_5h=none ' +
  `intervals_7d=none parts_5h=0/${t} parts_7d=0/${t} window_conservation=OK`;
// Plan 01-07: the join: line (short form, no OTel stored) and the roles: line after window:, for C transcript
// calls and the counts [attribution, meta, transcript_main, unknown, conflict_attr_meta] (from the case modules).
const noOtel = (c, [attr, meta, main, unknown, conflict]) => [
  `join: otel_requests=0 transcript_calls=${c}`,
  `roles: harness=0 attribution=${attr} meta=${meta} transcript_main=${main} query_source=0 query_source_main=0 unknown=${unknown} `
    + `conflict_attr_meta=${conflict} conflict_query_source=0 harness_joined=0`,
];
const OTEL_ITER = noOtel(2, [0, 0, 2, 0, 0]); //       iterations: two main-thread calls
const OTEL_DUPS = noOtel(3, [1, 0, 2, 0, 0]); //       derive-dups: one attributed call, two main
const OTEL_ROLES = noOtel(10, [2, 1, 6, 1, 1]); //     derive-roles-iter: r4 r5 attributed (r5 fork vs meta general-purpose), r2 meta, r3 unknown, r1 i1-i5 main
const OTEL_PRICING = noOtel(14, [14, 0, 0, 0, 0]); //  pricing: every call attributed (14 calls since plan 01-12)
const OTEL_TRACER = noOtel(8, [2, 0, 6, 0, 0]); //     tracer-base: m3 m4 attributed, six main-thread calls
const warning = (code) => `warning: price table unusable (${code}); notional dollars are unavailable\n`;

const PRICING_KEYS = [
  'priced_parts', 'unpriced_parts', 'unpriced_model', 'unknown_tokens', 'unknown_modifier', 'no_table',
  'floor_parts', 'server_tool_use_calls', 'server_tool_use_unknown_calls', 'top_level_only_calls',
];
function pricingLine(p, { table = SHIPPED, read = SHIPPED_READ, conservation = 'OK' } = {}) {
  return `pricing: table=${table} read=${read} ${PRICING_KEYS.map((k) => `${k}=${p[k]}`).join(' ')} cost_conservation=${conservation}`;
}

// The 01-02 `iterations` case. msg_m41 executor part (claude-opus-5-5):
//   100x4000 (400,000) + 40x20000 (800,000) + 1000x200 (200,000) + 50x5000 (250,000) = 1,650,000
// msg_m41 advisor part: claude-fable-5-0, not a table row: ?
// msg_m42 (claude-sonnet-5-5, server_tool_use, so a floor):
//   9x2000 (18,000) + 9x10000 (90,000) + 9x100 (900) + 9x2500 (22,500) = 131,400 -> >=0.000131
// known total 1,650,000 + 131,400 = 1,781,400 -> 0.001781
const ITER = {
  rows: [
    ['main', 'claude-fable-5-0', '1', '30', '20', '0', '0', '?', '?', '?'],
    ['main', 'claude-opus-5-5', '1', '100', '40', '1000', '50', '0.001650', '?', '?'],
    ['main', 'claude-sonnet-5-5', '1', '9', '9', '9', '9', '>=0.000131', '?', '?'],
  ],
  counts: 'counts: calls=2 parts=3 duplicates_collapsed=0 synthetic_skipped=0 top_level_only=1 iteration_mismatch=0 unknown_iteration_type=0',
  totals: 'totals: input=139 output=69 cache_read=1009 cache_write=59 cache_5m=59 cache_1h=0',
  pricing: {
    priced_parts: 2, unpriced_parts: 1, unpriced_model: 1, unknown_tokens: 0, unknown_modifier: 0, no_table: 0,
    floor_parts: 1, server_tool_use_calls: 1, server_tool_use_unknown_calls: 0, top_level_only_calls: 1,
  },
  notional: 'notional: usd>=0.001781(1 unknown, 1 floor) label=derived',
  totalNano: 1781400, // 1,650,000 + 131,400
};

// Case derive-dups (one owner-independent total):
//   general-purpose / opus-5-5: 10x4000 (40,000) + 20x20000 (400,000) + 30x200 (6,000) + 4x5000 (20,000) = 466,000
//   main / haiku-5-5: 40x100 (4,000) + 12x500 (6,000) + 100x10 (1,000) + 8x125 (1,000) = 12,000
//   main / sonnet-5-5 (maxima over the copies): 5x2000 (10,000) + 25x10000 (250,000) = 260,000
//   total 466,000 + 12,000 + 260,000 = 738,000
const DUPS = {
  cells: ['0.000466', '0.000012', '0.000260'],
  pricing: {
    priced_parts: 3, unpriced_parts: 0, unpriced_model: 0, unknown_tokens: 0, unknown_modifier: 0, no_table: 0,
    floor_parts: 0, server_tool_use_calls: 0, server_tool_use_unknown_calls: 0, top_level_only_calls: 3,
  },
  notional: 'notional: usd=0.000738 label=derived',
  totalNano: 738000,
};

// Case derive-roles-iter:
//   Explore / haiku r2: 10x100 (1,000) + 11x500 (5,500) + 12x10 (120) + 13x125 (1,625) = 8,245 -> 0.000008
//   fork / sonnet r5: 40x2000 (80,000) + 41x10000 (410,000) + 42x100 (4,200) + 43x2500 (107,500) = 601,700 -> 0.000602
//   gsd-verifier / opus r4: 30x4000 (120,000) + 31x20000 (620,000) + 32x200 (6,400) + 30x5000 (150,000)
//     + 3x8000 (24,000) = 920,400 -> 0.000920
//   main / fable-5-0: ?   main / ? (advisor with no model): ?
//   main / haiku i5: 3x100 (300) + 4x500 (2,000) + 5x10 (50) + 6x125 (750) = 3,100 -> 0.000003
//   main / opus: r1 4,000 + 40,000 + 600 + 20,000 = 64,600; i1 400,000 + 1,000,000 + 200,000 + 150x5000 (750,000)
//     + 50x8000 (400,000) = 2,750,000; i4 20,000 + 100,000 + 1,000 + 25,000 = 146,000; sum 2,960,600 -> 0.002961
//   main / sonnet: i2 20,000 + 100,000 + 1,000 + 25,000 = 146,000; i3 14,000 + 70,000 + 700 + 17,500 = 102,200;
//     sum 248,200 -> 0.000248
//   unknown / sonnet r3: 20x2000 (40,000) + 21x10000 (210,000) + 22x100 (2,200) + 20x2500 (50,000)
//     + 3x4000 (12,000) = 314,200 -> 0.000314
//   by model: haiku 8,245 + 3,100 = 11,345 -> 0.000011; opus 920,400 + 2,960,600 = 3,881,000 -> 0.003881;
//     sonnet 601,700 + 248,200 + 314,200 = 1,164,100 -> 0.001164
//   known total 8,245 + 601,700 + 920,400 + 3,100 + 2,960,600 + 248,200 + 314,200 = 5,056,445 -> 0.005056
const ROLES = {
  cells: ['0.000008', '0.000602', '0.000920', '?', '0.000003', '0.002961', '0.000248', '?', '0.000314'],
  byRole: ['0.000008', '0.000602', '0.000920', '?', '0.000314'],
  byModel: ['?', '0.000011', '0.003881', '0.001164', '?'],
  pricing: {
    priced_parts: 10, unpriced_parts: 2, unpriced_model: 2, unknown_tokens: 0, unknown_modifier: 0, no_table: 0,
    floor_parts: 0, server_tool_use_calls: 0, server_tool_use_unknown_calls: 0, top_level_only_calls: 6,
  },
  notional: 'notional: usd>=0.005056(2 unknown) label=derived',
  totalNano: 5056445,
};

// Case 10 (01-01 tracer tree), parts priced one by one:
//   M1 opus-5-5: 120x4000 (480,000) + 80x20000 (1,600,000) + 5000x200 (1,000,000) + 200x5000 (1,000,000)
//     + 100x8000 (800,000) = 4,880,000
//   M2 opus-5-5 (creation 100, no 5m/1h split, so a floor at the 5m rate):
//     50x4000 (200,000) + 25x20000 (500,000) + 1000x200 (200,000) + 100x5000 (500,000) = 1,400,000
//   M3 sonnet-5-5 (creation 30, no split, a floor): 10x2000 (20,000) + 0 + 200x100 (20,000) + 30x2500 (75,000) = 115,000
//   M4 sonnet-5-5: no cache_creation at all: unknown tokens
//   M5 haiku-5-5: 7x100 = 700 -> 0.000001 (700 + 500 = 1,200, rounded down to 1 micro)
//   M6 no model: ?   M8 hostile model (rejected at ingest, stored NULL): ?
//   M7 opus-4-8 (creation 1, no split, a floor): 1x5000 + 1x25000 + 1x500 + 1x6250 = 36,750 -> >=0.000037
//   rows: gsd-executor/sonnet ? (M4 unknown); main/haiku 0.000001; main/opus-4-8 >=0.000037;
//         main/opus-5-5 4,880,000 + 1,400,000 = 6,280,000 -> >=0.006280; main/? ?
//   known total 4,880,000 + 1,400,000 + 115,000 + 700 + 36,750 = 6,432,450 -> 0.006432 (3 unknown, 3 floor)
const TRACER = {
  cells: ['?', '0.000001', '>=0.000037', '>=0.006280', '?'],
  counts: 'counts: calls=8 parts=8 duplicates_collapsed=0 synthetic_skipped=0 top_level_only=8 iteration_mismatch=0 unknown_iteration_type=0',
  totals: 'totals: input=212 output=116 cache_read=6607 cache_write>=438(1 unknown) cache_5m>=200(7 unknown) cache_1h>=100(7 unknown)',
  pricing: {
    priced_parts: 5, unpriced_parts: 3, unpriced_model: 2, unknown_tokens: 1, unknown_modifier: 0, no_table: 0,
    floor_parts: 3, server_tool_use_calls: 0, server_tool_use_unknown_calls: 0, top_level_only_calls: 8,
  },
  notional: 'notional: usd>=0.006432(3 unknown, 3 floor) label=derived',
};

// Every stdout and stderr captured here, so the last test can prove no dollar is labeled measured or otel.
const OUTPUTS = [];

function costOut(stdout) {
  const lines = stdout.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const labelsAt = lines.findIndex((l) => l.startsWith('labels:'));
  // Plan 01-08: the freshness block has several lines, so the period line is found by its prefix; the table follows it.
  const p0 = lines.findIndex((l) => l.startsWith('period:'));
  const hasTable = p0 >= 0 && lines.length > p0 + 1 && lines[p0 + 1] !== 'no rows';
  // Plan 01-06: a window usage line sits between period and the table header when rows exist.
  const w = hasTable && lines[p0 + 1].startsWith('window usage:') ? 1 : 0;
  return {
    lines,
    header: hasTable ? lines[p0 + 1 + w].trim().split(/\s+/) : null,
    rows: hasTable ? lines.slice(p0 + 2 + w, labelsAt >= 0 ? labelsAt : undefined).filter(isDataRow).map((l) => l.trim().split(/\s+/)) : [],
    labels: labelsAt >= 0 ? lines[labelsAt] : null,
    // Plan 01-08: the scope: line is asserted in cost-cli.test.mjs, not in these footer lists.
    footer: labelsAt >= 0 ? lines.slice(labelsAt + 1).filter((l) => !l.startsWith('scope:')) : [],
  };
}

async function ingested(cases) {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases });
  const r = runCli(['ingest'], { home: ctx.home });
  // Plan 01-11 (WR-06): explain a failed or empty ingest instead of yielding zero rows with exit 0 (for example
  // a TMPDIR so deep that the walker skips the project directory).
  assert.equal(r.status, 0, describeCliFailure(r));
  assert.equal(r.signal, null, describeCliFailure(r));
  assert.ok(!r.stdout.startsWith('ingest: skipped'), `the ingest was skipped\n${describeCliFailure(r)}`);
  const line = /^transcript: files=(\d+) new=(\d+)/m.exec(r.stdout);
  assert.ok(line && Number(line[1]) >= 1 && Number(line[2]) >= 1, `no transcript file was read\n${describeCliFailure(r)}`);
  return ctx;
}

function cost(ctx, by, extraEnv) {
  const args = by === undefined ? ['cost'] : ['cost', '--by', by];
  const r = runCli(args, { home: ctx.home, env: cliEnv(ctx.home, extraEnv ?? {}) });
  OUTPUTS.push(r.stdout, r.stderr);
  return r;
}

const withCells = (rows, cells) => rows.map((r, i) => [...r, cells[i], '?', '?']);

function readDerived(home, fn) {
  const db = new Db(derivedPath(home), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function writeDerived(home, sql) {
  const db = new Db(derivedPath(home));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

const pickCost = (r) => ({
  ok: r.ok, total_nano: r.total_nano, known_parts: r.known_parts, unknown_parts: r.unknown_parts,
  role_nano: r.role_nano, model_nano: r.model_nano, call_mismatch_calls: r.call_mismatch_calls,
});

describe('tracer: priced advisor iteration', () => {
  it('tracer: cost --by role,model prices the executor part, leaves the unknown advisor model at ? and prints the notional line', async () => {
    const ctx = await ingested(['iterations']);
    try {
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0, 'cost --by role,model exit status');
      const o = costOut(r.stdout);
      assert.deepEqual(o.header, ['role', 'model', ...NUM_HEADER]);
      assert.deepEqual(o.rows, ITER.rows, 'executor part priced, unknown advisor model ?, server_tool_use a floor');
      assert.equal(o.labels, LABELS_DERIVED);
      assert.deepEqual(o.footer, [CONSERVATION_OK, ITER.counts, ITER.totals, pricingLine(ITER.pricing), ITER.notional, noWindow(3), ...OTEL_ITER]);
      assert.equal(r.stderr, '', 'no warning with the shipped table');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('cases priced end to end', () => {
  it('derive-dups: three priced rows and the exact notional total 0.000738', async () => {
    const ctx = await ingested(['derive-dups']);
    try {
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      const o = costOut(r.stdout);
      assert.deepEqual(o.rows, withCells(dups.expectedDerived.rows, DUPS.cells));
      assert.equal(o.labels, LABELS_DERIVED);
      assert.deepEqual(o.footer, [
        CONSERVATION_OK, dups.expectedDerived.counts, dups.expectedDerived.totalsLine, pricingLine(DUPS.pricing), DUPS.notional,
        noWindow(3), ...OTEL_DUPS,
      ]);
    } finally {
      ctx.cleanup();
    }
  });

  it('derive-roles-iter --by role,model: nine rows, the unknown advisor models and the NULL model stay ?', async () => {
    const ctx = await ingested(['derive-roles-iter']);
    try {
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      const o = costOut(r.stdout);
      assert.deepEqual(o.rows, withCells(roles.expectedDerived.rows, ROLES.cells));
      assert.deepEqual(o.footer, [
        CONSERVATION_OK, roles.expectedDerived.counts, roles.expectedDerived.totalsLine, pricingLine(ROLES.pricing), ROLES.notional,
        noWindow(12), ...OTEL_ROLES,
      ]);
    } finally {
      ctx.cleanup();
    }
  });

  it('derive-roles-iter --by role: the main group holds an unpriced part, so its cell is ? and never its known sum', async () => {
    const ctx = await ingested(['derive-roles-iter']);
    try {
      const r = cost(ctx, 'role');
      assert.equal(r.status, 0);
      assert.deepEqual(costOut(r.stdout).rows, withCells(roles.expectedDerived.rowsByRole, ROLES.byRole));
    } finally {
      ctx.cleanup();
    }
  });

  it('derive-roles-iter --by model: haiku 0.000011, opus 0.003881, sonnet 0.001164, fable and NULL ?', async () => {
    const ctx = await ingested(['derive-roles-iter']);
    try {
      const r = cost(ctx, 'model');
      assert.equal(r.status, 0);
      const o = costOut(r.stdout);
      assert.deepEqual(o.rows, withCells(roles.expectedDerived.rowsByModel, ROLES.byModel));
      assert.equal(o.footer[4], ROLES.notional, 'the notional line does not depend on --by');
    } finally {
      ctx.cleanup();
    }
  });

  it('the shipped price table is the one the hand-computed cells were computed against', () => {
    assert.equal(SHIPPED, CELLS_COMPUTED_AGAINST, 'a newer price table: recompute the hand-computed cells from its rates');
  });

  it('pricing: fifteen rows, one per rule, with the hand-computed cells, pricing and notional lines', async () => {
    const ctx = await ingested(['pricing']);
    try {
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      const o = costOut(r.stdout);
      assert.deepEqual(o.rows, pricing.expectedPriced.rows.map((x) => [...x.cells, '?'])); // plan 01-06: a second window cell
      assert.equal(o.labels, LABELS_DERIVED);
      assert.deepEqual(o.footer, [
        CONSERVATION_OK, pricing.expectedPriced.counts, pricing.expectedPriced.totals,
        pricingLine(pricing.expectedPriced.pricing), pricing.expectedPriced.notional, noWindow(15), ...OTEL_PRICING,
      ]);
    } finally {
      ctx.cleanup();
    }
  });

  // Plan 01-12 (WR-03, U5, TRUST-01): a call whose server_tool_use count is unknown (NULL) is never shown as 0
  // server-tool calls: it is counted in server_tool_use_unknown_calls, in the text line and the JSON footer, and the
  // derived pass is rebuilt at PASS_VERSION 8 (7 was plan 01-12; 8 is review CR-01, the unknown-sticky aggregate).
  // Plan 02-02: later plans raise the pass version, so the test asserts at least 8 and reads the imported constant.
  it('pricing: the JSON footer carries server_tool_use_calls and server_tool_use_unknown_calls; PASS_VERSION is at least 8', async () => {
    const { PASS_VERSION } = await import('../../src/derive/schema.mjs');
    assert.ok(PASS_VERSION >= 8);
    const ctx = await ingested(['pricing']);
    try {
      const r = runCli(['cost', '--by', 'role,model', '--json'], { home: ctx.home, env: cliEnv(ctx.home) });
      OUTPUTS.push(r.stdout, r.stderr);
      assert.equal(r.status, 0, r.stderr);
      const doc = JSON.parse(r.stdout);
      assert.equal(doc.footer.pricing.server_tool_use_calls, 1);
      assert.equal(doc.footer.pricing.server_tool_use_unknown_calls, 1);
      const keys = Object.keys(doc.footer.pricing);
      assert.equal(keys.indexOf('server_tool_use_unknown_calls'), keys.indexOf('server_tool_use_calls') + 1, 'listed right after');
      const pass = readDerived(ctx.home, (db) => queryOrEmpty(db, 'SELECT pass_version FROM derive_state'));
      assert.deepEqual(pass.map((x) => x.pass_version), [PASS_VERSION]);
    } finally {
      ctx.cleanup();
    }
  });

  it('pricing: each derived part carries the hand-computed nano-dollars, status and floor reason', async () => {
    const ctx = await ingested(['pricing']);
    try {
      assert.equal(cost(ctx, 'role,model').status, 0);
      const parts = readDerived(ctx.home, (db) => queryOrEmpty(db, `
        SELECT c.role, p.model, p.cost_nano, p.price_status, p.floor_reason
          FROM api_call_part p JOIN api_call c ON c.call_key = p.call_key
         ORDER BY c.role, p.model`));
      assert.deepEqual(parts.map((p) => [p.role, p.model, p.cost_nano, p.price_status, p.floor_reason]),
        pricing.expectedPriced.rows.map((x) => [x.cells[0], x.cells[1], x.nano, x.status, x.floor ?? null]));
    } finally {
      ctx.cleanup();
    }
  });

  it('tracer group (case 10): the five 01-01 token rows are unchanged and gain their dollar cells', async () => {
    const ctx = await ingested(['tracer-base']);
    try {
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      const o = costOut(r.stdout);
      assert.deepEqual(o.rows, withCells(EXPECTED_COST_ROWS, TRACER.cells));
      assert.deepEqual(o.footer, [CONSERVATION_OK, TRACER.counts, TRACER.totals, pricingLine(TRACER.pricing), TRACER.notional, noWindow(8), ...OTEL_TRACER]);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('table trouble: every dollar is ?, tokens unchanged, one warning, exit 0', () => {
  const NO_TABLE = {
    priced_parts: 0, unpriced_parts: 3, unpriced_model: 0, unknown_tokens: 0, unknown_modifier: 0, no_table: 3,
    floor_parts: 0, server_tool_use_calls: 1, server_tool_use_unknown_calls: 0, top_level_only_calls: 1,
  };
  const unusable = (stdout, code, stderr) => {
    const o = costOut(stdout);
    assert.deepEqual(o.rows, ITER.rows.map((x) => [...x.slice(0, 7), '?', '?', '?']), 'tokens unchanged, every dollar ?');
    assert.equal(o.labels, LABELS_LINE, 'notional_usd=unavailable');
    assert.deepEqual(o.footer, [
      CONSERVATION_OK, ITER.counts, ITER.totals, pricingLine(NO_TABLE, { table: 'none', read: 'none' }),
      'notional: usd=?(3 unknown) label=unavailable', noWindow(3), ...OTEL_ITER,
    ]);
    assert.equal(stderr, warning(code));
  };

  it('an empty RIGORSCOPE_PRICES_DIR gives code no_price_file', async () => {
    const ctx = await ingested(['iterations']);
    try {
      const dir = join(ctx.home, 'prices-empty');
      mkdirSync(dir);
      const r = cost(ctx, 'role,model', { RIGORSCOPE_PRICES_DIR: dir });
      assert.equal(r.status, 0);
      unusable(r.stdout, 'no_price_file', r.stderr);
    } finally {
      ctx.cleanup();
    }
  });

  it('a relative RIGORSCOPE_PRICES_DIR gives code bad_dir, even when it names the shipped data directory', async () => {
    const ctx = await ingested(['iterations']);
    try {
      const r = cost(ctx, 'role,model', { RIGORSCOPE_PRICES_DIR: 'data' });
      assert.equal(r.status, 0);
      unusable(r.stdout, 'bad_dir', r.stderr);
    } finally {
      ctx.cleanup();
    }
  });

  it('a newest file with a JSON syntax error gives code bad_json and no file text anywhere in the output', async () => {
    const ctx = await ingested(['iterations']);
    try {
      const dir = mkdtempSync(join(ctx.home, 'prices-bad-'));
      writeFileSync(join(dir, 'prices-2026-01-01.json'), readFileSync(join(DATA_DIR, SHIPPED)));
      writeFileSync(join(dir, 'prices-2026-12-31.json'), `{"schema": 1, ${PLANTS.command}`);
      const r = cost(ctx, 'role,model', { RIGORSCOPE_PRICES_DIR: dir });
      assert.equal(r.status, 0);
      unusable(r.stdout, 'bad_json', r.stderr);
      assert.ok(!(r.stdout + r.stderr).includes('CANARY'), 'no planted byte in the output');
    } finally {
      ctx.cleanup();
    }
  });

  it('after an unusable table the next run with the shipped table rebuilds and the dollars return', async () => {
    const ctx = await ingested(['iterations']);
    try {
      const dir = join(ctx.home, 'prices-empty');
      mkdirSync(dir);
      assert.equal(cost(ctx, 'role,model', { RIGORSCOPE_PRICES_DIR: dir }).status, 0);
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      assert.deepEqual(costOut(r.stdout).rows, ITER.rows);
      assert.equal(r.stderr, '');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('trust edges', () => {
  it('an empty HOME prints the freshness line and no rows, with no labels, pricing or notional line', () => {
    const ctx = makeHome();
    try {
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      assert.equal(r.stdout, 'freshness: no ingest recorded\nperiod: last 7 days, from 2026-10-21T12:00:00.000Z (default), tz=UTC, calls_ts_unknown=0\nno rows\n');
    } finally {
      ctx.cleanup();
    }
  });

  it('the footer lists labels, conservation, counts, totals, pricing, notional in that fixed order', async () => {
    const ctx = await ingested(['pricing']);
    try {
      const o = costOut(cost(ctx, 'role,model').stdout);
      const tail = o.lines.slice(o.lines.indexOf(o.labels));
      assert.deepEqual(tail.map((l) => l.split(/[: ]/)[0]), ['labels', 'scope', 'conservation', 'counts', 'totals', 'pricing', 'notional', 'window', 'join', 'roles']);
      const fields = [...o.footer[3].matchAll(/ ([a-z_]+)=/g)].map((m) => m[1]);
      assert.deepEqual(fields, ['table', 'read', ...PRICING_KEYS, 'cost_conservation']);
    } finally {
      ctx.cleanup();
    }
  });

  it('with rows but no priced part the labels line says notional_usd=unavailable and the notional line has no number', () => {
    const ctx = makeHome();
    try {
      const db = openTempStore({ home: ctx.home });
      try {
        insertMessage(db, {
          session_id: 'sess-unpriced', message_id: 'msg_u1', model: 'model-nonesuch', input_tokens: 1, output_tokens: 1,
          cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0, ts_utc: '2026-10-27T16:00:01.000Z',
        });
      } finally {
        db.close();
      }
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      const o = costOut(r.stdout);
      assert.deepEqual(o.rows, [['main', 'model-nonesuch', '1', '1', '1', '0', '0', '?', '?', '?']]);
      assert.equal(o.labels, LABELS_LINE);
      assert.equal(o.footer[4], 'notional: usd=?(1 unknown) label=unavailable');
    } finally {
      ctx.cleanup();
    }
  });

  // Direct rows, one call per model id, each with input 1 and every other class 0:
  //   claude-haiku-4-5-20251001 prices as claude-haiku-4-5: 1 x 1000 = 1,000 -> 0.000001
  //   claude-opus-5-5: 1 x 4000 = 4,000 -> 0.000004
  //   Claude-Opus-5-5, a Cyrillic look-alike, constructor and toString: not table rows -> ?
  it('lookup is byte-exact after the one date-suffix strip: case variants, look-alikes and property names stay ?', () => {
    const ctx = makeHome();
    try {
      const models = ['Claude-Opus-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5', 'claude-оpus-5-5', 'constructor', 'toString'];
      const db = openTempStore({ home: ctx.home });
      try {
        models.forEach((model, i) => insertMessage(db, {
          session_id: 'sess-ids', message_id: `msg_id${i}`, model, input_tokens: 1, output_tokens: 0,
          cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0, ts_utc: `2026-10-27T16:00:0${i}.000Z`,
        }));
      } finally {
        db.close();
      }
      const r = cost(ctx, 'model');
      assert.equal(r.status, 0);
      const o = costOut(r.stdout);
      assert.deepEqual(o.rows.map((x) => [x[0], x[6]]), [
        ['Claude-Opus-5-5', '?'],
        ['claude-haiku-4-5-20251001', '0.000001'],
        ['claude-opus-5-5', '0.000004'],
        ['claude-оpus-5-5', '?'],
        ['constructor', '?'],
        ['toString', '?'],
      ]);
    } finally {
      ctx.cleanup();
    }
  });

  it('every row keeps window_share ? (the window half of COST-04 belongs to plan 01-06)', async () => {
    const ctx = await ingested(['pricing']);
    try {
      const o = costOut(cost(ctx, 'role,model').stdout);
      assert.equal(o.rows.length, 15); // 14 calls, p07 in two rows (plan 01-12 added p14)
      for (const row of o.rows) assert.deepEqual(row.slice(8), ['?', '?']); // plan 01-06: window_5h and window_7d
      assert.match(o.labels, / window_share=unavailable;/);
    } finally {
      ctx.cleanup();
    }
  });

  it('a second cost on unchanged inputs prints the same output and does not rewrite derived.db', async () => {
    const ctx = await ingested(['pricing']);
    try {
      const a = cost(ctx, 'role,model');
      const p = derivedPath(ctx.home);
      const before = sha256File(p);
      const b = cost(ctx, 'role,model');
      assert.equal(sha256File(p), before, 'derived.db byte-identical');
      assert.equal(b.stdout, a.stdout);
      assert.equal(costOut(b.stdout).footer[4], pricing.expectedPriced.notional);
    } finally {
      ctx.cleanup();
    }
  });

  it('two cost processes started together both exit 0 with identical priced stdout', async () => {
    const ctx = await ingested(['iterations']);
    try {
      const [a, b] = await Promise.all([
        runCliAsync(['cost', '--by', 'role,model'], { home: ctx.home }),
        runCliAsync(['cost', '--by', 'role,model'], { home: ctx.home }),
      ]);
      OUTPUTS.push(a.stdout, a.stderr, b.stdout, b.stderr);
      assert.equal(a.status, 0, 'first child');
      assert.equal(b.status, 0, 'second child');
      assert.equal(a.stdout, b.stdout);
      assert.deepEqual(costOut(a.stdout).rows, ITER.rows);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('ensureDerived: a changed price table is a named staleness reason', () => {
  const literal = (dateRead) => ({
    schema: 1,
    date_read: dateRead,
    source_url: PRICES_URL,
    reread: false,
    unit: 'usd_per_million_tokens',
    label: 'notional',
    modifiers: { geo_us: { num: 11, den: 10 } },
    models: {
      'claude-opus-5-5': { input: 4, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2, output: 20, status: 'cited' },
    },
    notes: [],
  });

  it('table to a different table, table to none and none to table each rebuild with reason price_table', async () => {
    const ctx = await ingested(['iterations']);
    try {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      const a = parsePriceTable(literal('2026-01-01'), { fileName: 'prices-2026-01-01.json', sha: 'a'.repeat(64) });
      const b = parsePriceTable(literal('2026-01-01'), { fileName: 'prices-2026-01-01.json', sha: 'b'.repeat(64) });
      assert.deepEqual(ensureDerived({ home: ctx.home, prices: a }), { rebuilt: true, reason: 'missing' });
      assert.deepEqual(ensureDerived({ home: ctx.home, prices: a }), { rebuilt: false, reason: null });
      assert.deepEqual(ensureDerived({ home: ctx.home, prices: b }), { rebuilt: true, reason: 'price_table' });
      assert.deepEqual(ensureDerived({ home: ctx.home, prices: null }), { rebuilt: true, reason: 'price_table' });
      assert.deepEqual(ensureDerived({ home: ctx.home, prices: null }), { rebuilt: false, reason: null });
      assert.deepEqual(ensureDerived({ home: ctx.home, prices: a }), { rebuilt: true, reason: 'price_table' });
    } finally {
      ctx.cleanup();
    }
  });

  it('derive_state records the table file, date read and sha (NULL with no table); an identical call writes nothing', async () => {
    const ctx = await ingested(['iterations']);
    try {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      const a = parsePriceTable(literal('2026-01-01'), { fileName: 'prices-2026-01-01.json', sha: 'a'.repeat(64) });
      ensureDerived({ home: ctx.home, prices: a });
      const state = () => readDerived(ctx.home, (db) => queryOrEmpty(db, 'SELECT price_file, price_date_read, price_sha FROM derive_state'));
      assert.deepEqual(state(), [{ price_file: 'prices-2026-01-01.json', price_date_read: '2026-01-01', price_sha: 'a'.repeat(64) }]);
      const before = sha256File(derivedPath(ctx.home));
      assert.equal(ensureDerived({ home: ctx.home, prices: a }).rebuilt, false);
      assert.equal(sha256File(derivedPath(ctx.home)), before, 'derived.db byte-identical');
      ensureDerived({ home: ctx.home, prices: null });
      assert.deepEqual(state(), [{ price_file: null, price_date_read: null, price_sha: null }]);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('iteration split (direct rows)', () => {
  // claude-sonnet-5-5 message, top-level creation 400 with no 5m/1h split, two message iterations each with
  // creation 200 = 5m 100 + 1h 100. The iterations resolve the split:
  //   200 x 4000 (1h, 800,000) + 200 x 2500 (5m, 500,000) = 1,300,000, priced, no floor -> 0.001300
  it('a top-level split that does not resolve is taken from the message iterations when they sum to the total', () => {
    const ctx = makeHome();
    try {
      const db = openTempStore({ home: ctx.home });
      try {
        insertMessage(db, {
          session_id: 'sess-split', message_id: 'msg_split', model: 'claude-sonnet-5-5', has_iterations: 1,
          input_tokens: 0, output_tokens: 0, cache_read: 0, cache_creation: 400, cache_5m: null, cache_1h: null,
          ts_utc: '2026-10-27T16:00:01.000Z',
        });
        for (const seq of [0, 1]) {
          insertIter(db, {
            session_id: 'sess-split', message_id: 'msg_split', iter_seq: seq, iter_type: 'message', model: 'claude-sonnet-5-5',
            input_tokens: 0, output_tokens: 0, cache_read: 0, cache_creation: 200, cache_5m: 100, cache_1h: 100,
          });
        }
      } finally {
        db.close();
      }
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      assert.deepEqual(costOut(r.stdout).rows, [['main', 'claude-sonnet-5-5', '1', '0', '0', '0', '400', '0.001300', '?', '?']]);
      const parts = readDerived(ctx.home, (db2) => queryOrEmpty(db2, 'SELECT cost_nano, price_status, cost_floor, floor_reason FROM api_call_part'));
      assert.deepEqual(parts, [{ cost_nano: 1300000, price_status: 'priced', cost_floor: 0, floor_reason: null }]);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('derived.db price columns', () => {
  const COLUMNS = {
    api_call: ['speed', 'service_tier', 'inference_geo', 'server_tool_use', 'cost_nano', 'cost_floor', 'cost_label'],
    api_call_part: ['price_model', 'price_status', 'price_tier', 'geo_us', 'cost_nano', 'cost_floor', 'floor_reason', 'price_version'],
    derive_state: ['price_file', 'price_date_read', 'price_sha'],
  };

  it('a fresh derived.db has the price columns, every table STRICT, and NULL costs exactly where a part is unpriced', async () => {
    const ctx = await ingested(['pricing']);
    try {
      assert.equal(cost(ctx, 'role,model').status, 0);
      readDerived(ctx.home, (db) => {
        for (const [table, cols] of Object.entries(COLUMNS)) {
          const have = queryOrEmpty(db, `PRAGMA table_info(${table})`).map((c) => c.name);
          for (const c of cols) assert.ok(have.includes(c), `${table}.${c}`);
        }
        const tables = queryOrEmpty(db, "SELECT name, sql FROM sqlite_master WHERE type = 'table'");
        // plan 01-06 added window_interval, api_call_part_window and usage_latest; 01-07 otel_call and join_stat; 02-02
        // repo_label and unit. A floor, so a later pass that adds a table does not break this test.
        assert.ok(tables.length >= 10, `${tables.length} derived tables`);
        for (const t of tables) assert.match(t.sql, /\)\s*STRICT\s*$/, `${t.name} is STRICT`);
        const bad = queryOrEmpty(db, `
          SELECT count(*) AS n FROM api_call_part
           WHERE (price_status = 'priced') IS NOT (cost_nano IS NOT NULL)
              OR (price_status = 'priced') IS NOT (price_tier IS NOT NULL)`);
        assert.deepEqual(bad, [{ n: 0 }]);
        const calls = queryOrEmpty(db, `
          SELECT count(*) AS n FROM api_call a
           WHERE (a.cost_nano IS NULL) IS NOT EXISTS (
             SELECT 1 FROM api_call_part p WHERE p.call_key = a.call_key AND p.cost_nano IS NULL)`);
        assert.deepEqual(calls, [{ n: 0 }], 'a call cost is NULL exactly when one of its parts is');
        const labels = queryOrEmpty(db, 'SELECT DISTINCT cost_label FROM api_call ORDER BY 1').map((x) => x.cost_label);
        assert.deepEqual(labels, ['derived', 'unavailable']);
      });
    } finally {
      ctx.cleanup();
    }
  });

  it('a CHECK constraint refuses a priced part with a NULL cost', async () => {
    const ctx = await ingested(['iterations']);
    try {
      assert.equal(cost(ctx, 'role,model').status, 0);
      let message = 'no error';
      try {
        writeDerived(ctx.home, "UPDATE api_call_part SET cost_nano = NULL WHERE price_status = 'priced'");
      } catch (err) {
        message = String(err?.message);
      }
      assert.match(message, /CHECK constraint failed/);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('cost conservation', () => {
  const cases = [
    ['iterations', ITER.totalNano, 2, 1],
    ['derive-dups', DUPS.totalNano, 3, 0],
    ['derive-roles-iter', ROLES.totalNano, 10, 2],
    ['pricing', pricing.expectedPriced.totalNano, 12, 3], // plan 01-12: p14 is the twelfth priced part
  ];
  for (const [id, total, known, unknownParts] of cases) {
    it(`${id}: the part total equals the role and model sums and the hand-computed ${total} nano-dollars`, async () => {
      const ctx = await ingested([id]);
      try {
        assert.equal(cost(ctx, 'role,model').status, 0);
        const res = readDerived(ctx.home, (db) => checkCostConservation(db));
        assert.deepEqual(pickCost(res), {
          ok: true, total_nano: total, known_parts: known, unknown_parts: unknownParts,
          role_nano: total, model_nano: total, call_mismatch_calls: 0,
        });
        assert.deepEqual(res.violations, []);
      } finally {
        ctx.cleanup();
      }
    });
  }

  it('passes on an empty derived database with a NULL total, never 0', () => {
    const ctx = makeHome();
    try {
      assert.equal(cost(ctx, 'role,model').status, 0);
      const res = readDerived(ctx.home, (db) => checkCostConservation(db));
      assert.deepEqual(pickCost(res), {
        ok: true, total_nano: null, known_parts: 0, unknown_parts: 0, role_nano: null, model_nano: null, call_mismatch_calls: 0,
      });
    } finally {
      ctx.cleanup();
    }
  });

  const tampers = [
    ['an altered part cost', "UPDATE api_call_part SET cost_nano = cost_nano + 1 WHERE call_key = 'm:msg_m42' AND part_seq = 0"],
    ['a deleted part', "DELETE FROM api_call_part WHERE call_key = 'm:msg_m42'"],
    ['an altered call cost', "UPDATE api_call SET cost_nano = cost_nano + 1 WHERE call_key = 'm:msg_m42'"],
  ];
  for (const [what, sql] of tampers) {
    it(`fails after ${what}`, async () => {
      const ctx = await ingested(['iterations']);
      try {
        assert.equal(cost(ctx, 'role,model').status, 0);
        assert.equal(readDerived(ctx.home, (db) => checkCostConservation(db)).ok, true, 'ok before the tamper');
        writeDerived(ctx.home, sql);
        const res = readDerived(ctx.home, (db) => checkCostConservation(db));
        assert.equal(res.ok, false);
        assert.ok(res.violations.length >= 1);
        for (const v of res.violations) {
          for (const value of Object.values(v)) assert.ok(value === null || ['string', 'number'].includes(typeof value));
        }
      } finally {
        ctx.cleanup();
      }
    });
  }

  it('a tampered part cost prints cost_conservation=VIOLATED and the exit status stays 0', async () => {
    const ctx = await ingested(['iterations']);
    try {
      const first = cost(ctx, 'role,model');
      assert.equal(first.status, 0);
      assert.equal(costOut(first.stdout).footer[3], pricingLine(ITER.pricing), 'OK before the tamper');
      writeDerived(ctx.home, tampers[0][1]);
      const r = cost(ctx, 'role,model');
      assert.equal(r.status, 0);
      assert.equal(costOut(r.stdout).footer[3], pricingLine(ITER.pricing, { conservation: 'VIOLATED' }));
    } finally {
      ctx.cleanup();
    }
  });

  it('the total is 738,000 nano-dollars under owner rules earliest and latest', async () => {
    const ctx = await ingested(['derive-dups']);
    try {
      assert.equal(cost(ctx, 'role,model').status, 0);
      const { ensureDerived } = await mod('derive/ensure.mjs');
      const totals = [];
      for (const ownerRule of ['latest', 'earliest']) {
        ensureDerived({ home: ctx.home, ownerRule, force: true });
        const res = readDerived(ctx.home, (db) => checkCostConservation(db));
        assert.equal(res.ok, true, ownerRule);
        totals.push(res.total_nano);
      }
      assert.deepEqual(totals, [DUPS.totalNano, DUPS.totalNano]);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('labels', () => {
  it('no output of any command above labels a dollar measured or otel', () => {
    assert.ok(OUTPUTS.length > 10, 'outputs were captured');
    for (const text of OUTPUTS) {
      assert.ok(!/notional_usd=(measured|otel)/.test(text));
      assert.ok(!/notional: .*label=(measured|otel)/.test(text));
    }
  });

  it('stateDirOf and the shipped table name are consistent fixtures (characterization)', () => {
    assert.match(SHIPPED, /^prices-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(SHIPPED, `prices-${SHIPPED_READ}.json`);
    assert.equal(typeof stateDirOf, 'function');
  });
});
