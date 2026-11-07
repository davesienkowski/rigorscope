// Plan 01-05 Task 2: the pure pricing rules (D-09, D-10, RR-04), written before the code (RED).
//
// The fixture table below is written by hand in nano-dollars per token (one nano-dollar is a billionth of a
// dollar; a rate of 1 dollar per million tokens is 1000 nano-dollars per token), in the shape the loader
// returns: { models: Map(id -> rates), geoUs: { num, den } }, rates { input, write5m, write1h, read, output,
// fast, longPrompt }. test/unit/price-table.test.mjs proves parsePriceTable builds this same table from
// the JSON form, so the rules here do not depend on the loader. Every expected cost is computed by hand,
// with the arithmetic beside it.
//
//   test-m  input 1000, 5m 1250, 1h 2000, read 100, output 5000; fast 2000, 2500, 4000, 200, 10000
//   test-t  input 100, 5m 125, 1h 200, read 10, output 500; prompt over 100,000: 500, 625, 1000, 50, 2500
//   test-f  test-t rates and long tier, plus fast 200, 250, 400, 20, 1000
//   geo us  11 / 10
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOOR_REASONS, NANO_PER_USD, PRICE_STATUSES, normalizeModelId, priceCall, pricePart, requestsFor,
} from '../../src/derive/price.mjs';
import { formatUsd, known, unknown, usdCell } from '../../src/measure/measure.mjs';

const NANO = 1e9;
const rates = (input, write5m, write1h, read, output) => Object.freeze({ input, write5m, write1h, read, output });
const T_BASE = rates(100, 125, 200, 10, 500);
const T_LONG = Object.freeze({ over: 100000, rates: rates(500, 625, 1000, 50, 2500) });
const TABLE = Object.freeze({
  models: new Map([
    ['test-m', Object.freeze({ ...rates(1000, 1250, 2000, 100, 5000), fast: rates(2000, 2500, 4000, 200, 10000), longPrompt: null })],
    ['test-t', Object.freeze({ ...T_BASE, fast: null, longPrompt: T_LONG })],
    ['test-f', Object.freeze({ ...T_BASE, fast: rates(200, 250, 400, 20, 1000), longPrompt: T_LONG })],
  ]),
  geoUs: Object.freeze({ num: 11, den: 10 }),
});

const CTX = Object.freeze({ speed: 'standard', serviceTier: 'standard', inferenceGeo: 'global', serverToolUse: 0 });

// The basic test-m part: input 1000, output 200, cache_read 5000, cache_creation 400 = 5m 300 + 1h 100.
const part = (o = {}) => ({
  kind: 'message', model: 'test-m', input_tokens: 1000, output_tokens: 200, cache_read: 5000,
  cache_creation: 400, cache_5m: 300, cache_1h: 100, ...o,
});
// A part whose only tokens are cache creation (for the TTL rules).
const cacheOnly = (creation, c5, c1, o = {}) => part({
  input_tokens: 0, output_tokens: 0, cache_read: 0, cache_creation: creation, cache_5m: c5, cache_1h: c1, ...o,
});
const req = (input, cacheRead, cacheCreation, cache5m = null, cache1h = null) => ({ input, cacheRead, cacheCreation, cache5m, cache1h });
const price = (p, ctx = {}) => pricePart(p, { ...CTX, ...ctx }, TABLE);
const brief = (r) => ({ status: r.status, costNano: r.costNano, floor: r.floor, floorReason: r.floorReason });

describe('constants', () => {
  it('NANO_PER_USD is one billion and the status and floor lists are frozen', () => {
    assert.equal(NANO_PER_USD, 1e9);
    assert.deepEqual([...PRICE_STATUSES], ['priced', 'unpriced_model', 'unknown_tokens', 'unknown_modifier', 'no_table']);
    assert.deepEqual([...FLOOR_REASONS], [
      'ttl_unresolved', 'server_tool_use', 'ttl_unresolved+server_tool_use',
      'server_tool_use_unknown', 'ttl_unresolved+server_tool_use_unknown',
    ]);
    assert.ok(Object.isFrozen(PRICE_STATUSES) && Object.isFrozen(FLOOR_REASONS));
  });
});

describe('normalizeModelId', () => {
  const cases = [
    ['strips one trailing -YYYYMMDD', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['keeps a seven-digit tail', 'claude-x-1234567', 'claude-x-1234567'],
    ['keeps a nine-digit tail', 'claude-x-123456789', 'claude-x-123456789'],
    ['strips a double suffix once and keeps the inner one', 'claude-haiku-4-5-20251001-20251001', 'claude-haiku-4-5-20251001'],
    ['does not fold case', 'Claude-Opus-5-5', 'Claude-Opus-5-5'],
    ['keeps an id without a suffix', 'claude-opus-5-5', 'claude-opus-5-5'],
  ];
  for (const [what, input, want] of cases) {
    it(`normalizeModelId ${what}`, () => assert.equal(normalizeModelId(input), want));
  }
  it('normalizeModelId gives null for non-strings, empty strings, spaces and non-ASCII (no trimming, no Unicode folding)', () => {
    for (const v of [null, undefined, 42, {}, '', 'claude opus', 'claude-opus-5-5 ', ' claude-opus-5-5', 'claude-оpus-5-5']) {
      assert.equal(normalizeModelId(v), null);
    }
  });
});

describe('pricePart: model lookup', () => {
  // 1000x1000 (1,000,000) + 200x5000 (1,000,000) + 5000x100 (500,000) + 300x1250 (375,000) + 100x2000 (200,000)
  //   = 3,075,000
  it('pricePart prices every class at its rate: 3,075,000 nano-dollars, tier standard, no floor', () => {
    assert.deepEqual({ ...price(part()) }, {
      status: 'priced', priceModel: 'test-m', tier: 'standard', geoUs: 0, costNano: 3075000, floor: false, floorReason: null,
    });
  });

  it('pricePart prices a date-suffixed id exactly as its base id', () => {
    assert.deepEqual({ ...price(part({ model: 'test-m-20251001' })) }, { ...price(part()) });
  });

  for (const id of ['Test-M', 'test-m ', 'test-м', 'constructor', 'toString', '__proto__', 'hasOwnProperty', null]) {
    it(`pricePart leaves ${JSON.stringify(id)} unpriced with a NULL cost, never 0`, () => {
      const r = price(part({ model: id }));
      assert.equal(r.status, 'unpriced_model');
      assert.equal(r.costNano, null);
      assert.equal(r.tier, null);
      assert.equal(r.floor, false);
    });
  }

  it('pricePart with no table gives no_table and a NULL cost', () => {
    const r = pricePart(part(), CTX, null);
    assert.deepEqual(brief(r), { status: 'no_table', costNano: null, floor: false, floorReason: null });
  });
});

describe('pricePart: cache creation by TTL', () => {
  // creation 400 = 5m 300 + 1h 100: 300x1250 (375,000) + 100x2000 (200,000) = 575,000
  it('pricePart: cache creation resolved by TTL prices the 1h tokens at the 1h rate and the rest at the 5m rate', () => {
    assert.deepEqual(brief(price(cacheOnly(400, 300, 100))), { status: 'priced', costNano: 575000, floor: false, floorReason: null });
  });
  // 5m and 1h both unknown: 400x1250 = 500,000, a floor
  it('pricePart prices an unsplit cache creation at the 5m rate as a floor', () => {
    assert.deepEqual(brief(price(cacheOnly(400, null, null))), { status: 'priced', costNano: 500000, floor: true, floorReason: 'ttl_unresolved' });
  });
  // 5m 300, 1h unknown: the unresolved 100 at the 5m rate: 400x1250 = 500,000, a floor
  it('pricePart with 5m known below the total and 1h unknown is a 5m-rate floor', () => {
    assert.deepEqual(brief(price(cacheOnly(400, 300, null))), { status: 'priced', costNano: 500000, floor: true, floorReason: 'ttl_unresolved' });
  });
  // 1h 400 equals the total: 400x2000 = 800,000, resolved
  it('pricePart with 1h equal to the total and 5m unknown resolves to the 1h rate', () => {
    assert.deepEqual(brief(price(cacheOnly(400, null, 400))), { status: 'priced', costNano: 800000, floor: false, floorReason: null });
  });
  // 5m 400 equals the total: 400x1250 = 500,000, resolved
  it('pricePart with 5m equal to the total and 1h unknown resolves to the 5m rate', () => {
    assert.deepEqual(brief(price(cacheOnly(400, 400, null))), { status: 'priced', costNano: 500000, floor: false, floorReason: null });
  });
  it('pricePart with zero cache creation and no split is a genuine 0, not a floor', () => {
    assert.deepEqual(brief(price(cacheOnly(0, null, null))), { status: 'priced', costNano: 0, floor: false, floorReason: null });
  });
  it('pricePart with a split above the total gives unknown_tokens', () => {
    assert.deepEqual(brief(price(cacheOnly(400, 300, 200))), { status: 'unknown_tokens', costNano: null, floor: false, floorReason: null });
  });
  it('pricePart with 1h alone above the total gives unknown_tokens', () => {
    assert.equal(price(cacheOnly(400, null, 500)).status, 'unknown_tokens');
  });
  it('pricePart with a NULL cache creation total gives unknown_tokens even when 5m and 1h are known', () => {
    assert.equal(price(cacheOnly(null, 300, 100)).status, 'unknown_tokens');
  });
  // 5m 100 + 1h 100 below 400: 100x2000 (200,000) + the other 300 at 5m 300x1250 (375,000) = 575,000, a floor
  it('pricePart with a split below the total prices the rest at the 5m rate as a floor', () => {
    assert.deepEqual(brief(price(cacheOnly(400, 100, 100))), { status: 'priced', costNano: 575000, floor: true, floorReason: 'ttl_unresolved' });
  });
  // requests 200 = 100 + 100 twice, summing to 400: 200x2000 (400,000) + 200x1250 (250,000) = 650,000
  it('pricePart takes the split from the message requests when their creation, 5m and 1h sum to the total', () => {
    const p = cacheOnly(400, null, null, { requests: [req(0, 0, 200, 100, 100), req(0, 0, 200, 100, 100)] });
    assert.deepEqual(brief(price(p)), { status: 'priced', costNano: 650000, floor: false, floorReason: null });
  });
  it('pricePart keeps the 5m-rate floor when the request split does not sum to the total', () => {
    const p = cacheOnly(400, null, null, { requests: [req(0, 0, 150, 100, 100), req(0, 0, 150, 100, 100)] });
    assert.deepEqual(brief(price(p)), { status: 'priced', costNano: 500000, floor: true, floorReason: 'ttl_unresolved' });
  });
});

describe('pricePart: missing tokens and precedence', () => {
  for (const col of ['input_tokens', 'output_tokens', 'cache_read']) {
    it(`pricePart with a NULL ${col} gives unknown_tokens`, () => {
      assert.deepEqual(brief(price(part({ [col]: null }))), { status: 'unknown_tokens', costNano: null, floor: false, floorReason: null });
    });
  }
  it('pricePart reports unpriced_model, then unknown_modifier, then unknown_tokens when several problems exist', () => {
    assert.equal(price(part({ model: 'nonesuch', input_tokens: null }), { speed: 'turbo' }).status, 'unpriced_model');
    assert.equal(price(part({ input_tokens: null }), { speed: 'turbo' }).status, 'unknown_modifier');
    assert.equal(price(part({ input_tokens: null })).status, 'unknown_tokens');
  });
});

describe('pricePart: prompt-length tier per request', () => {
  // prompt 60000 + 30000 + 10000 = 100,000, not over: 60000x100 (6,000,000) + 30000x10 (300,000)
  //   + 10000x125 (1,250,000) + 1000x500 (500,000) = 8,050,000
  it('pricePart puts a prompt of exactly 100,000 tokens in the base tier', () => {
    const r = price(part({ model: 'test-t', input_tokens: 60000, output_tokens: 1000, cache_read: 30000, cache_creation: 10000, cache_5m: 10000, cache_1h: 0 }));
    assert.deepEqual([r.status, r.tier, r.costNano], ['priced', 'standard', 8050000]);
  });
  // prompt 100,001, over: 60001x500 (30,000,500) + 30000x50 (1,500,000) + 10000x625 (6,250,000)
  //   + 1000x2500 (2,500,000) = 40,250,500
  it('pricePart puts a prompt of 100,001 tokens in the long tier', () => {
    const r = price(part({ model: 'test-t', input_tokens: 60001, output_tokens: 1000, cache_read: 30000, cache_creation: 10000, cache_5m: 10000, cache_1h: 0 }));
    assert.deepEqual([r.status, r.tier, r.costNano], ['priced', 'long_prompt', 40250500]);
  });
  // two requests of 60,000 each: base tier, 120000x100 = 12,000,000
  it('pricePart decides the tier per request: two requests of 60,000 stay in the base tier', () => {
    const r = price(part({ model: 'test-t', input_tokens: 120000, output_tokens: 0, cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0, requests: [req(60000, 0, 0), req(60000, 0, 0)] }));
    assert.deepEqual([r.status, r.tier, r.costNano], ['priced', 'standard', 12000000]);
  });
  it('pricePart with requests on both sides of the threshold gives unknown_modifier', () => {
    const r = price(part({ model: 'test-t', input_tokens: 160000, output_tokens: 0, cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0, requests: [req(150000, 0, 0), req(10000, 0, 0)] }));
    assert.deepEqual(brief(r), { status: 'unknown_modifier', costNano: null, floor: false, floorReason: null });
  });
  it('pricePart with a request whose prompt token is NULL gives unknown_tokens on a tiered model', () => {
    const r = price(part({ model: 'test-t', requests: [req(10, null, 0)] }));
    assert.equal(r.status, 'unknown_tokens');
  });
  // test-m has no long tier: a 500,000-token request changes nothing (3,075,000)
  it('pricePart ignores request sizes on a model without a long tier', () => {
    const r = price(part({ requests: [req(500000, 0, 0)] }));
    assert.deepEqual([r.status, r.tier, r.costNano], ['priced', 'standard', 3075000]);
  });
  // no requests: the part is the one request; prompt 100,001 -> long: 100001x500 = 50,000,500
  it('pricePart uses the part itself as the one request when it has no requests', () => {
    const r = price(part({ model: 'test-t', input_tokens: 100001, output_tokens: 0, cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0 }));
    assert.deepEqual([r.status, r.tier, r.costNano], ['priced', 'long_prompt', 50000500]);
  });
});

describe('pricePart: modifiers', () => {
  // fast test-m: 1000x2000 (2,000,000) + 200x10000 (2,000,000) + 5000x200 (1,000,000) + 300x2500 (750,000)
  //   + 100x4000 (400,000) = 6,150,000
  it('pricePart with speed fast uses the fast rates on a message part', () => {
    const r = price(part(), { speed: 'fast' });
    assert.deepEqual([r.status, r.tier, r.costNano], ['priced', 'fast', 6150000]);
  });
  it('pricePart with speed fast on a model without a fast row gives unknown_modifier', () => {
    assert.equal(price(part({ model: 'test-t' }), { speed: 'fast' }).status, 'unknown_modifier');
  });
  it('pricePart with speed fast on an advisor part gives unknown_modifier', () => {
    assert.equal(price(part({ kind: 'advisor' }), { speed: 'fast' }).status, 'unknown_modifier');
  });
  it('pricePart with speed fast over the long tier gives unknown_modifier, and under it uses the fast rates', () => {
    const over = part({ model: 'test-f', input_tokens: 100001, output_tokens: 0, cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0 });
    assert.equal(price(over, { speed: 'fast' }).status, 'unknown_modifier');
    // 100x200 = 20,000 at the test-f fast input rate
    const under = part({ model: 'test-f', input_tokens: 100, output_tokens: 0, cache_read: 0, cache_creation: 0, cache_5m: 0, cache_1h: 0 });
    assert.deepEqual([price(under, { speed: 'fast' }).tier, price(under, { speed: 'fast' }).costNano], ['fast', 20000]);
  });
  // 3,075,000 x 11 / 10 = 3,382,500
  it('pricePart with inference_geo us multiplies the part by 11/10', () => {
    const r = price(part(), { inferenceGeo: 'us' });
    assert.deepEqual([r.status, r.geoUs, r.costNano], ['priced', 1, 3382500]);
  });
  // one 5m write token on test-t: 125 x 11 / 10 = 137.5, rounded half up once to 138
  it('pricePart rounds the geo multiplier half up once: 137.5 becomes 138', () => {
    const r = price(cacheOnly(1, 1, 0, { model: 'test-t' }), { inferenceGeo: 'us' });
    assert.equal(r.costNano, 138);
  });
  // 6,150,000 x 11 / 10 = 6,765,000
  it('pricePart applies geo on top of fast', () => {
    assert.equal(price(part(), { speed: 'fast', inferenceGeo: 'us' }).costNano, 6765000);
  });
  for (const [field, value] of [['speed', 'turbo'], ['serviceTier', 'priority'], ['inferenceGeo', 'eu']]) {
    it(`pricePart with an unrecognized ${field} ${value} gives unknown_modifier and a NULL cost`, () => {
      assert.deepEqual(brief(price(part(), { [field]: value })), { status: 'unknown_modifier', costNano: null, floor: false, floorReason: null });
    });
  }
  it('pricePart applies nothing for absent, standard, global and not_available speed, service tier and geo', () => {
    for (const field of ['speed', 'serviceTier', 'inferenceGeo']) {
      for (const value of [null, undefined, 'standard', 'global', 'not_available']) {
        const r = price(part(), { [field]: value });
        assert.deepEqual([r.status, r.costNano, r.geoUs], ['priced', 3075000, 0], `${field}=${value}`);
      }
    }
  });
});

describe('pricePart: floors', () => {
  it('pricePart marks a message part of a server_tool_use call as a floor with the cost unchanged', () => {
    assert.deepEqual(brief(price(part(), { serverToolUse: 1 })), { status: 'priced', costNano: 3075000, floor: true, floorReason: 'server_tool_use' });
  });
  it('pricePart does not mark the advisor part of a server_tool_use call', () => {
    assert.deepEqual(brief(price(part({ kind: 'advisor' }), { serverToolUse: 1 })), { status: 'priced', costNano: 3075000, floor: false, floorReason: null });
  });
  // Plan 01-12 (WR-03, U5): the flag is a tri-state. 0 and an absent value add nothing; NULL (the count was not
  // readable or was never stored) is a floor with its own reason, so the lower bound stays honest.
  it('pricePart sets no floor for server_tool_use 0 or undefined', () => {
    for (const v of [0, undefined]) assert.equal(price(part(), { serverToolUse: v }).floor, false);
  });
  it('pricePart marks a message part of a call with an unknown server_tool_use (NULL) as a floor with its own reason', () => {
    assert.deepEqual(brief(price(part(), { serverToolUse: null })),
      { status: 'priced', costNano: 3075000, floor: true, floorReason: 'server_tool_use_unknown' });
  });
  it('pricePart does not mark the advisor part of a call with an unknown server_tool_use', () => {
    assert.deepEqual(brief(price(part({ kind: 'advisor' }), { serverToolUse: null })),
      { status: 'priced', costNano: 3075000, floor: false, floorReason: null });
  });
  it('pricePart names both reasons when the TTL is unresolved on a call with an unknown server_tool_use', () => {
    assert.deepEqual(brief(price(cacheOnly(400, null, null), { serverToolUse: null })),
      { status: 'priced', costNano: 500000, floor: true, floorReason: 'ttl_unresolved+server_tool_use_unknown' });
  });
  it('every floor reason pricePart emits is in FLOOR_REASONS and accepted by the derived CHECK list', async () => {
    const { FLOOR_REASON_SQL } = await import('../../src/derive/schema.mjs');
    const { Db } = await import('../../src/db.mjs');
    const seen = new Set();
    for (const p of [part(), part({ kind: 'advisor' }), cacheOnly(400, null, null)]) {
      for (const v of [0, 1, null, undefined]) {
        const r = price(p, { serverToolUse: v });
        if (r.floorReason !== null) seen.add(r.floorReason);
      }
    }
    assert.deepEqual([...seen].sort(), [...FLOOR_REASONS].sort());
    const db = new Db(':memory:');
    try {
      db.exec(`CREATE TABLE t (floor_reason TEXT CHECK (floor_reason IS NULL OR floor_reason IN (${FLOOR_REASON_SQL}))) STRICT`);
      const ins = db.prepare('INSERT INTO t VALUES (?)');
      for (const reason of FLOOR_REASONS) ins.run(reason);
      assert.throws(() => ins.run('not_a_reason'), /CHECK/);
    } finally {
      db.close();
    }
  });
  it('pricePart names both reasons when the TTL is unresolved on a server_tool_use call', () => {
    assert.deepEqual(brief(price(cacheOnly(400, null, null), { serverToolUse: 1 })),
      { status: 'priced', costNano: 500000, floor: true, floorReason: 'ttl_unresolved+server_tool_use' });
  });
});

describe('pricePart: integer money', () => {
  // 2^50 output tokens x 5000 is above 2^53: not a safe integer, so the cost is unknown, never a float
  it('pricePart gives unknown_tokens when a product is not a safe integer', () => {
    assert.deepEqual(brief(price(part({ output_tokens: 2 ** 50 }))), { status: 'unknown_tokens', costNano: null, floor: false, floorReason: null });
  });
  it('pricePart returns an integer or null cost for every case above, never a float', () => {
    const results = [
      price(part()), price(part(), { inferenceGeo: 'us' }), price(cacheOnly(1, 1, 0, { model: 'test-t' }), { inferenceGeo: 'us' }),
      price(cacheOnly(400, 100, 100)), price(part({ model: 'nonesuch' })), price(part({ output_tokens: 2 ** 50 })),
    ];
    for (const r of results) assert.ok(r.costNano === null || Number.isSafeInteger(r.costNano));
  });
});

describe('priceCall', () => {
  it('priceCall sums the parts and labels a known cost derived, with a floor when any part is a floor', () => {
    // 3,075,000 + 575,000 (TTL floor part) = 3,650,000
    const r = priceCall([part(), cacheOnly(400, 100, 100, { kind: 'advisor' })], CTX, TABLE);
    assert.deepEqual([r.costNano, r.floor, r.label, r.parts.length], [3650000, true, 'derived', 2]);
  });
  it('priceCall is NULL and unavailable when one part is NULL', () => {
    const r = priceCall([part(), part({ kind: 'advisor', model: 'nonesuch' })], CTX, TABLE);
    assert.deepEqual([r.costNano, r.label, r.parts[1].status], [null, 'unavailable', 'unpriced_model']);
  });
  it('priceCall with a null table gives every part no_table and a NULL cost', () => {
    const r = priceCall([part(), part({ kind: 'advisor' })], CTX, null);
    assert.deepEqual(r.parts.map((p) => [p.status, p.costNano]), [['no_table', null], ['no_table', null]]);
    assert.deepEqual([r.costNano, r.label, r.floor], [null, 'unavailable', false]);
  });
});

describe('requestsFor', () => {
  const it0 = (iter_type, model, a) => ({
    iter_type, model, input_tokens: a[0], output_tokens: a[1], cache_read: a[2], cache_creation: a[3], cache_5m: a[4], cache_1h: a[5],
  });
  const call = {
    iterations: [
      it0('message', 'test-m', [10, 1, 20, 30, 30, 0]),
      it0('advisor_message', 'adv-a', [5, 1, 6, 7, 7, 0]),
      it0('message', 'test-m', [11, 1, 21, 31, 0, 31]),
      it0('advisor_message', 'adv-b', [8, 1, 9, 0, 0, 0]),
      it0('advisor_message', null, [1, 1, 1, 1, 1, 0]),
    ],
  };
  it('requestsFor gives one request per message iteration for the message part', () => {
    assert.deepEqual(requestsFor({ kind: 'message', model: 'test-m' }, call), [req(10, 20, 30, 30, 0), req(11, 21, 31, 0, 31)]);
  });
  it('requestsFor gives the part itself for a call without iterations', () => {
    const p = part();
    assert.deepEqual(requestsFor(p, { iterations: [] }), [req(1000, 5000, 400, 300, 100)]);
    assert.deepEqual(requestsFor(p, {}), [req(1000, 5000, 400, 300, 100)]);
  });
  it('requestsFor gives the advisor iterations of the advisor part model only (NULL model its own group)', () => {
    assert.deepEqual(requestsFor({ kind: 'advisor', model: 'adv-b' }, call), [req(8, 9, 0, 0, 0)]);
    assert.deepEqual(requestsFor({ kind: 'advisor', model: null }, call), [req(1, 1, 1, 1, 0)]);
  });
});

describe('formatUsd and usdCell', () => {
  const cases = [
    [0, '0.000000', 'a genuine zero'],
    [499 / NANO, '<0.000001', '499 nano-dollars is below half a micro-dollar'],
    [500 / NANO, '0.000001', '500 nano-dollars rounds half up'],
    [1650000 / NANO, '0.001650', '1,650,000 nano-dollars'],
    [36750 / NANO, '0.000037', '36,750 nano-dollars'],
    [1500 / NANO, '0.000002', 'a tie at 1,500 rounds up'],
    [111600540 / NANO, '0.111601', '111,600,540 nano-dollars'],
    [4000123456789 / NANO, '4000.123457', 'a large value keeps its integer part'],
  ];
  for (const [value, want, what] of cases) {
    it(`formatUsd: ${what} gives ${want}`, () => assert.equal(formatUsd(value), want));
  }
  it('formatUsd throws on a negative, NaN, infinite or non-number value', () => {
    for (const v of [-1e-9, Number.NaN, Infinity, '1', null, undefined]) assert.throws(() => formatUsd(v), TypeError);
  });
  it('usdCell prints ? for unknown, the value for known, and >= only on a known floor', () => {
    assert.equal(usdCell(unknown({ n: 2 })), '?');
    assert.equal(usdCell(null), '?');
    assert.equal(usdCell(unknown({ n: 2 }), { floor: true }), '?');
    assert.equal(usdCell(known(1650000 / NANO, { label: 'derived' })), '0.001650');
    assert.equal(usdCell(known(131400 / NANO, { label: 'derived' }), { floor: true }), '>=0.000131');
    assert.equal(usdCell(known(0, { label: 'derived' }), { floor: false }), '0.000000');
  });
});

