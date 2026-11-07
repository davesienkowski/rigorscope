// Case 90: one call per pricing rule (plan 01-05, COST-04, D-09, D-10). Session S13, one main file, no
// sub-agents. Each call is one assistant message whose attributionAgent names the rule it exercises, so
// `cost --by role,model` prints one row per rule (p07 prints two: its advisor part and its executor part).
// Every call has speed standard, service_tier standard and inference_geo global unless stated.
//
// Rates in nano-dollars per token (dollars per million tokens x 1000), as input, 5m write, 1h write,
// cache read, output:
//   claude-opus-5-5    4000, 5000, 8000, 200, 20000
//   claude-sonnet-5-5  2000, 2500, 4000, 100, 10000
//   claude-haiku-5-5    100,  125,  200,  10,   500   (prompt over 100,000 tokens: 500, 625, 1000, 50, 2500)
//   claude-fable-5-1  10000, 12500, 20000, 250, 50000
// Every literal below is computed by hand from these rates, with the arithmetic beside it; none of it is
// computed by the code under test. Never imports build.mjs.
import { join } from 'node:path';

export const id = 'pricing';
export const group = 'extra';
export const sources = ['transcript'];

export const S13 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const t = (n) => `2026-10-27T16:00:${String(n).padStart(2, '0')}.000Z`;

// [input, output, cache_read, cache_creation, cache_5m, cache_1h]; undefined = the field is absent
const CALLS = [
  { n: 1, role: 'p01-ttl-split', model: 'claude-opus-5-5', a: [1000, 500, 20000, 2000, 1500, 500] },
  { n: 2, role: 'p02-date-suffix', model: 'claude-sonnet-5-5-20260101', a: [100, 200, 300, 40, 40, 0] },
  { n: 3, role: 'p03-haiku-at-100000', model: 'claude-haiku-5-5', a: [60000, 1002, 30000, 10000, 10000, 0] },
  { n: 4, role: 'p04-haiku-over-100000', model: 'claude-haiku-5-5', a: [60001, 1001, 30000, 10000, 10000, 0] },
  { n: 5, role: 'p05-geo-us', model: 'claude-sonnet-5-5', a: [100, 200, 300, 40, 40, 0], geo: 'us' },
  { n: 6, role: 'p06-unknown-model', model: 'claude-nonesuch-9', a: [10, 10, 10, 10, 10, 0] },
  { n: 7, role: 'p07-advisor', model: 'claude-opus-5-5', a: [100, 50, 0, 0, 0, 0], advisor: true },
  { n: 8, role: 'p08-server-tool', model: 'claude-haiku-5-5', a: [10, 5, 0, 0, 0, 0], serverTool: true },
  { n: 9, role: 'p09-ttl-unsplit', model: 'claude-sonnet-5-5', a: [0, 0, 0, 1000, undefined, undefined] },
  { n: 10, role: 'p10-unknown-speed', model: 'claude-sonnet-5-5', a: [10, 10, 10, 10, 10, 0], speed: 'turbo' },
  { n: 11, role: 'p11-tiny', model: 'claude-haiku-5-5', a: [0, 0, 4, 0, 0, 0] },
  { n: 12, role: 'p12-zero', model: 'claude-haiku-5-5', a: [0, 0, 0, 0, 0, 0] },
  { n: 13, role: 'p13-no-cache-fields', model: 'claude-sonnet-5-5', a: [10, 10, 10, undefined, undefined, undefined] },
  // Plan 01-12 (U5): server_tool_use present but with no readable member, so the stored flag is NULL (unknown).
  { n: 14, role: 'p14-server-tool-unknown', model: 'claude-haiku-5-5', a: [10, 5, 0, 0, 0, 0], serverToolUnknown: true },
];

const msgId = (n) => `msg_p${String(n).padStart(2, '0')}`;

const iter = (type, model, a) => ({
  type, model, input_tokens: a[0], output_tokens: a[1], cache_read_input_tokens: a[2], cache_creation_input_tokens: a[3],
  cache_creation: { ephemeral_5m_input_tokens: a[4], ephemeral_1h_input_tokens: a[5] },
});
const P07_ADVISOR = [1000, 200, 5000, 300, 300, 0];

export function build(ctx) {
  const { root, home, helpers: h } = ctx;
  const file = join(root, 'projects', `${h.mangleHome(home)}-repos-pricing`, `${S13}.jsonl`);
  const cwd = `${home}/repos/pricing`;
  const lines = CALLS.map((c) => {
    const [input, output, read, creation, c5, c1] = c.a;
    const use = h.makeUsage({ input, output, read, creation, c5, c1 });
    use.inference_geo = c.geo ?? 'global';
    if (c.speed !== undefined) use.speed = c.speed;
    if (c.serverTool) use.server_tool_use = { web_search_requests: 1 };
    if (c.serverToolUnknown) use.server_tool_use = {};
    if (c.advisor) {
      use.iterations = [iter('message', c.model, c.a), iter('advisor_message', 'claude-fable-5-1', P07_ADVISOR)];
    }
    return JSON.stringify(h.makeAssistant({
      session: S13, ts: t(c.n), id: msgId(c.n), model: c.model, cwd, attributionAgent: c.role, use,
    }));
  });
  h.writeJsonl(file, lines);
  return [file];
}

const key = (n) => `${S13}||${msgId(n)}`;
const tuple = (a) => a.map((v) => (v === undefined ? null : v));

export const expected = {
  messageKeys: Object.fromEntries(CALLS.map((c) => [key(c.n), tuple(c.a)])),
  // [iter_seq, iter_type, model, input, output, cache_read, cache_creation, cache_5m, cache_1h]
  iterations: {
    [key(7)]: [
      [0, 'message', 'claude-opus-5-5', 100, 50, 0, 0, 0, 0],
      [1, 'advisor_message', 'claude-fable-5-1', 1000, 200, 5000, 300, 300, 0],
    ],
  },
  flags: {
    [key(7)]: { has_iterations: 1, has_server_tool_use: 0 },
    [key(8)]: { has_iterations: 0, has_server_tool_use: 1 },
    [key(14)]: { has_iterations: 0, has_server_tool_use: null },
  },
  sourceFiles: [`claude:~-repos-pricing/${S13}.jsonl`],
  agentMeta: [],
  skipped: {},
  unknownAttr: {},
  dropped: {},
  cwd: {},
};

// Hand-computed priced rows in output order (role bytewise, then model bytewise).
// [role, model, calls, input, output, cache_read, cache_write, notional_usd, window_share]
// plus, per row, the nano-dollar value (null = unknown) and the part status.
export const expectedPriced = {
  rows: [
    // 1000x4000 (4,000,000) + 500x20000 (10,000,000) + 20000x200 (4,000,000) + 1500x5000 (7,500,000)
    //   + 500x8000 (4,000,000) = 29,500,000
    { cells: ['p01-ttl-split', 'claude-opus-5-5', '1', '1000', '500', '20000', '2000', '0.029500', '?'], nano: 29500000, status: 'priced' },
    // stored id keeps its date suffix; priced as claude-sonnet-5-5:
    //   100x2000 (200,000) + 200x10000 (2,000,000) + 300x100 (30,000) + 40x2500 (100,000) = 2,330,000
    { cells: ['p02-date-suffix', 'claude-sonnet-5-5-20260101', '1', '100', '200', '300', '40', '0.002330', '?'], nano: 2330000, status: 'priced' },
    // prompt 60000 + 30000 + 10000 = 100,000 (not over): base tier
    //   60000x100 (6,000,000) + 1002x500 (501,000) + 30000x10 (300,000) + 10000x125 (1,250,000) = 8,051,000
    { cells: ['p03-haiku-at-100000', 'claude-haiku-5-5', '1', '60000', '1002', '30000', '10000', '0.008051', '?'], nano: 8051000, status: 'priced' },
    // prompt 60001 + 30000 + 10000 = 100,001 (over): long tier
    //   60001x500 (30,000,500) + 1001x2500 (2,502,500) + 30000x50 (1,500,000) + 10000x625 (6,250,000) = 40,253,000
    { cells: ['p04-haiku-over-100000', 'claude-haiku-5-5', '1', '60001', '1001', '30000', '10000', '0.040253', '?'], nano: 40253000, status: 'priced' },
    // inference_geo us: 2,330,000 x 11 / 10 = 2,563,000 (exact, no rounding needed)
    { cells: ['p05-geo-us', 'claude-sonnet-5-5', '1', '100', '200', '300', '40', '0.002563', '?'], nano: 2563000, status: 'priced' },
    // model id not in the table: NULL, never 0
    { cells: ['p06-unknown-model', 'claude-nonesuch-9', '1', '10', '10', '10', '10', '?', '?'], nano: null, status: 'unpriced_model' },
    // advisor part at claude-fable-5-1:
    //   1000x10000 (10,000,000) + 200x50000 (10,000,000) + 5000x250 (1,250,000) + 300x12500 (3,750,000) = 25,000,000
    { cells: ['p07-advisor', 'claude-fable-5-1', '1', '1000', '200', '5000', '300', '0.025000', '?'], nano: 25000000, status: 'priced' },
    // executor part at claude-opus-5-5: 100x4000 (400,000) + 50x20000 (1,000,000) = 1,400,000
    { cells: ['p07-advisor', 'claude-opus-5-5', '1', '100', '50', '0', '0', '0.001400', '?'], nano: 1400000, status: 'priced' },
    // 10x100 (1,000) + 5x500 (2,500) = 3,500; server_tool_use makes it a floor; 3,500 rounds half up to 4 micro
    { cells: ['p08-server-tool', 'claude-haiku-5-5', '1', '10', '5', '0', '0', '>=0.000004', '?'], nano: 3500, status: 'priced', floor: 'server_tool_use' },
    // creation 1000 with no 5m/1h split: 1000x2500 (5m rate) = 2,500,000, a floor
    { cells: ['p09-ttl-unsplit', 'claude-sonnet-5-5', '1', '0', '0', '0', '1000', '>=0.002500', '?'], nano: 2500000, status: 'priced', floor: 'ttl_unresolved' },
    // speed turbo is not a known modifier: NULL
    { cells: ['p10-unknown-speed', 'claude-sonnet-5-5', '1', '10', '10', '10', '10', '?', '?'], nano: null, status: 'unknown_modifier' },
    // 4x10 = 40 nano-dollars, below half a micro-dollar
    { cells: ['p11-tiny', 'claude-haiku-5-5', '1', '0', '0', '4', '0', '<0.000001', '?'], nano: 40, status: 'priced' },
    // a genuine zero
    { cells: ['p12-zero', 'claude-haiku-5-5', '1', '0', '0', '0', '0', '0.000000', '?'], nano: 0, status: 'priced' },
    // no cache_creation field at all: NULL
    { cells: ['p13-no-cache-fields', 'claude-sonnet-5-5', '1', '10', '10', '10', '?', '?', '?'], nano: null, status: 'unknown_tokens' },
    // plan 01-12: the p08 tokens again, 10x100 (1,000) + 5x500 (2,500) = 3,500; server_tool_use is {} (no readable
    // member), so the stored flag is NULL and the part is a floor with the reason server_tool_use_unknown
    { cells: ['p14-server-tool-unknown', 'claude-haiku-5-5', '1', '10', '5', '0', '0', '>=0.000004', '?'], nano: 3500, status: 'priced', floor: 'server_tool_use_unknown' },
  ],
  // 14 calls, 15 parts (p07 has two); every call but p07 has no iteration detail: 13 top-level-only
  counts: 'counts: calls=14 parts=15 duplicates_collapsed=0 synthetic_skipped=0 top_level_only=13 iteration_mismatch=0 unknown_iteration_type=0',
  // input: 1000+100+60000+60001+100+10+1000+100+10+0+10+0+0+10+10 = 122,351
  // output: 500+200+1002+1001+200+10+200+50+5+0+10+0+0+10+5 = 3,193
  // cache_read: 20000+300+30000+30000+300+10+5000+0+0+0+10+4+0+10+0 = 85,634
  // cache_write: 2000+40+10000+10000+40+10+300+0+0+1000+10+0+0+0 = 23,400 known, p13 unknown
  // cache_5m: 1500+40+10000+10000+40+10+300+0+0+10+0+0+0 = 21,900 known, p09 and p13 unknown
  // cache_1h: 500 known (all others 0), p09 and p13 unknown
  totals: 'totals: input=122351 output=3193 cache_read=85634 cache_write>=23400(1 unknown) cache_5m>=21900(2 unknown) cache_1h>=500(2 unknown)',
  // priced: p01 p02 p03 p04 p05 p07x2 p08 p09 p11 p12 p14 = 12; unpriced: p06 (model), p10 (modifier), p13 (tokens)
  // floors: p08 (server_tool_use), p09 (ttl_unresolved), p14 (server_tool_use_unknown) = 3
  // server-tool calls: p08 (flag 1) = 1; unknown: p14 (flag NULL) = 1
  pricing: {
    priced_parts: 12, unpriced_parts: 3, unpriced_model: 1, unknown_tokens: 1, unknown_modifier: 1, no_table: 0,
    floor_parts: 3, server_tool_use_calls: 1, server_tool_use_unknown_calls: 1, top_level_only_calls: 13,
  },
  // 29,500,000 + 2,330,000 + 8,051,000 + 40,253,000 + 2,563,000 + 25,000,000 + 1,400,000 + 3,500
  //   + 2,500,000 + 40 + 0 + 3,500 = 111,604,040 nano-dollars; (111,604,040 + 500) / 1000 rounded down = 111,604 micro
  totalNano: 111604040,
  notional: 'notional: usd>=0.111604(3 unknown, 3 floor) label=derived',
};
