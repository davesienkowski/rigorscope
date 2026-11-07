// Prohibition (plan 01-12, COST-04, COST-05, TRUST-01): a call whose stored server_tool_use flag is 0 MUST NOT be
// marked a server-tool floor, and a count that was never stored MUST NOT be claimed: a NULL flag is a floor with
// its own reason (server_tool_use_unknown), a 1 is the server_tool_use floor.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a module exporting pricePart, resolved against process.cwd(); unset
// means src/derive/price.mjs. test/prohibitions/fixtures/presence-floor-price.mjs (the old presence rule) must fail
// this test; test/prohibitions/fixtures/current-price.mjs (re-exports the real function) must pass it.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_SUBJECT = fileURLToPath(new URL('../../src/derive/price.mjs', import.meta.url));
const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : DEFAULT_SUBJECT;

// A minimal valid price table, built the way test/unit/price.test.mjs builds its own (nano-dollars per token).
const rates = (input, write5m, write1h, read, output) => Object.freeze({ input, write5m, write1h, read, output });
const TABLE = Object.freeze({
  models: new Map([['test-m', Object.freeze({ ...rates(1000, 1250, 2000, 100, 5000), fast: null, longPrompt: null })]]),
  geoUs: Object.freeze({ num: 11, den: 10 }),
});
const PART = Object.freeze({
  kind: 'message', model: 'test-m', input_tokens: 1000, output_tokens: 200, cache_read: 5000,
  cache_creation: 400, cache_5m: 300, cache_1h: 100,
});
const ctx = (serverToolUse) => ({ speed: 'standard', serviceTier: 'standard', inferenceGeo: 'global', serverToolUse });

it('a stored flag of 0 is never a server-tool floor; 1 and NULL carry their own reasons', async () => {
  const { pricePart } = await import(pathToFileURL(subject).href);
  const zero = pricePart(PART, ctx(0), TABLE);
  assert.equal(zero.status, 'priced');
  assert.equal(zero.floor, false, 'a flag of 0 made a floor');
  assert.equal(zero.floorReason, null);
  assert.equal(pricePart(PART, ctx(1), TABLE).floorReason, 'server_tool_use');
  assert.equal(pricePart(PART, ctx(null), TABLE).floorReason, 'server_tool_use_unknown', 'an unknown count is claimed as a count');
});
