// Plan 01-09 contract (TRUST-09, D-15): every signal that `cost` and `doctor` print is registered with a named
// consumer, and the registry matches what the commands actually print, in both directions. Written before the
// registry (RED). Titles contain exactly one of the words registry, validator, coverage or docs so a task can select a
// group by name. The validator is local to this test (not imported from src) and is proven able to fail first.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { cliEnv, makeHome, buildFixtureTree, runCli } from '../fixtures/build.mjs';
import { DST_NOW } from '../fixtures/clock.mjs';
import { linkCheckout } from '../fixtures/doctor-rows.mjs';
import { plantFakeNode } from '../fixtures/fake-bin.mjs';
import { CONSUMERS, SIGNALS } from '../../src/report/signals.mjs';
import { buildUnitsHome } from '../fixtures/units-home.mjs';
import { TIER_TIMES, buildTierHome } from '../fixtures/tier-home.mjs';
import { buildCalibrateHome, calEnv } from '../fixtures/calibrate-home.mjs';

const EMPTY_MARKERS = new Set(['tbd', 'todo', 'none', 'n/a', 'unknown', '?', '-']);
const ID = /^[a-z][a-z0-9-]*$/;
const KEY = /^[a-z][a-z0-9 ()_-]*$/;
const NON_ASCII = /[^\x20-\x7e]/;

// -> list of violation codes. surfaces: the keys of a signal's `keys` object.
export function validateRegistry(signals, consumers) {
  const v = [];
  if (!Array.isArray(signals) || signals.length === 0) v.push('empty_registry');
  if (!consumers || typeof consumers !== 'object' || Object.keys(consumers).length === 0) v.push('empty_consumers');
  const ids = new Set();
  const normalized = new Map();
  const claims = new Set();
  const used = new Set();
  const text = (value, empty, short, marker) => {
    if (typeof value !== 'string' || value.trim() === '') { v.push(empty); return; }
    if (NON_ASCII.test(value)) v.push('non_ascii');
    if (short && value.length < 20) v.push(short);
    if (EMPTY_MARKERS.has(value.trim().toLowerCase())) v.push(marker);
  };
  for (const s of Array.isArray(signals) ? signals : []) {
    if (typeof s.id !== 'string' || !ID.test(s.id)) v.push('bad_id');
    if (ids.has(s.id)) v.push('duplicate_id');
    ids.add(s.id);
    const n = String(s.id).toLowerCase().replaceAll('_', '-');
    if (normalized.has(n) && normalized.get(n) !== s.id) v.push('ambiguous_id');
    normalized.set(n, s.id);
    text(s.consumer, 'empty_consumer', null, 'placeholder_consumer');
    if (typeof s.consumer === 'string' && !Object.hasOwn(consumers ?? {}, s.consumer)) v.push('unknown_consumer');
    else used.add(s.consumer);
    text(s.decision, 'empty_decision', 'short_decision', 'placeholder_decision');
    for (const [surface, keys] of Object.entries(s.keys ?? {})) {
      for (const k of keys) {
        if (typeof k !== 'string' || !KEY.test(k)) v.push('bad_key');
        if (claims.has(`${surface}:${k}`)) v.push('duplicate_key');
        claims.add(`${surface}:${k}`);
      }
    }
  }
  for (const [k, value] of Object.entries(consumers ?? {})) {
    if (!ID.test(k)) v.push('bad_consumer_key');
    text(value, 'empty_consumer_text', null, 'placeholder_consumer_text');
    if (!used.has(k)) v.push('unused_consumer');
  }
  return [...new Set(v)];
}

const GOOD = () => ({
  signals: [
    { id: 'alpha-one', keys: { cost: ['alpha'] }, consumer: 'c-one', decision: 'decide whether alpha is worth acting on' },
    { id: 'beta-two', keys: { doctor: ['beta'] }, consumer: 'c-one', decision: 'decide whether beta is worth acting on' },
  ],
  consumers: { 'c-one': 'The owner acts on these.' },
});

describe('self-tests that prove the checks can fail', () => {
  it('validator accepts a good set of signals', () => {
    const g = GOOD();
    assert.deepEqual(validateRegistry(g.signals, g.consumers), []);
  });
  const BAD = [
    ['validator flags an empty signal list', (g) => { g.signals = []; }, 'empty_registry'],
    ['validator flags an empty consumers table', (g) => { g.consumers = {}; }, 'empty_consumers'],
    ['validator flags a duplicate id', (g) => { g.signals[1].id = 'alpha-one'; }, 'duplicate_id'],
    ['validator flags ids that differ only by case or by underscore versus hyphen', (g) => { g.signals[1].id = 'alpha_one'; }, 'ambiguous_id'],
    ['validator flags a printed key claimed twice on one surface', (g) => { g.signals[1].keys = { cost: ['alpha'] }; }, 'duplicate_key'],
    ['validator flags a consumer that is not an exact key of the table', (g) => { g.signals[0].consumer = 'C-one'; }, 'unknown_consumer'],
    ['validator flags a whitespace consumer', (g) => { g.signals[0].consumer = '   '; }, 'empty_consumer'],
    ['validator flags an empty decision', (g) => { g.signals[0].decision = ''; }, 'empty_decision'],
    ['validator flags a decision shorter than 20 characters', (g) => { g.signals[0].decision = 'too short'; }, 'short_decision'],
    ['validator flags an empty-marker decision', (g) => { g.signals[0].decision = 'N/A'; }, 'short_decision'],
    ['validator flags a non-ASCII byte', (g) => { g.signals[0].decision = 'decide whether alpha — matters a lot'; }, 'non_ascii'],
    ['validator flags an id that fails the id pattern', (g) => { g.signals[0].id = 'Alpha one'; }, 'bad_id'],
    ['validator flags a consumer key used by no signal', (g) => { g.consumers['c-two'] = 'Nobody uses this.'; }, 'unused_consumer'],
  ];
  for (const [title, mutate, code] of BAD) {
    it(title, () => {
      const g = GOOD();
      mutate(g);
      assert.ok(validateRegistry(g.signals, g.consumers).includes(code), `expected ${code}`);
    });
  }
  it('validator flags each empty-marker word as the whole value of a consumer text', () => {
    for (const word of ['TBD', 'TODO', 'none', 'N/A', 'unknown', '?', '-']) {
      const g = GOOD();
      g.consumers['c-one'] = word;
      assert.ok(validateRegistry(g.signals, g.consumers).includes('placeholder_consumer_text'), word);
    }
  });
});

describe('structure rules', () => {
  it('registry satisfies every structure rule', () => {
    assert.deepEqual(validateRegistry([...SIGNALS], CONSUMERS), []);
  });

  it('registry order puts every signal that prints on cost before every doctor-only signal', () => {
    const onCost = SIGNALS.map((s, i) => (Object.hasOwn(s.keys, 'cost') ? i : -1)).filter((i) => i >= 0);
    const doctorOnly = SIGNALS.map((s, i) => (!Object.hasOwn(s.keys, 'cost') ? i : -1)).filter((i) => i >= 0);
    assert.ok(onCost.length > 0 && doctorOnly.length > 0);
    assert.ok(Math.max(...onCost) < Math.min(...doctorOnly));
  });

  it('registry names the four consumers D-15 needs and each is used by at least one signal', () => {
    for (const key of ['owner-cost-decisions', 'phase-2-planner', 'owner-report-trust', 'owner-ingest-ops']) {
      assert.ok(Object.hasOwn(CONSUMERS, key), `consumer ${key} exists`);
      assert.ok(SIGNALS.some((s) => s.consumer === key), `consumer ${key} is used`);
    }
  });

  it('registry strings are plain ASCII with no em dash', () => {
    assert.ok(SIGNALS.length > 0);
    const all = JSON.stringify([SIGNALS, CONSUMERS]);
    assert.ok(!NON_ASCII.test(all));
  });
});

// ---- printed-key coverage ---------------------------------------------------------------------------------------
// A column-0 `key: ` line. Table rows cannot match (a role never contains a colon followed by a space) and indented
// detail lines start with a space. EXCLUDED lists headings that match the pattern but are not signals; none are
// expected on the homes below, so the list is empty by design.
const KEY_LINE = /^([a-z0-9(][a-z0-9 ()_-]*): /;
const EXCLUDED = [];
const keysOf = (stdout) => stdout.split('\n').map((l) => KEY_LINE.exec(l)?.[1]).filter((k) => k && !EXCLUDED.includes(k));
const registered = (surface) => SIGNALS.flatMap((s) => s.keys[surface] ?? []);

describe('printed keys', () => {
  let costKeys = null;
  let doctorKeys = null;
  const collectCost = async () => {
    if (costKeys) return costKeys;
    costKeys = new Set();
    for (const cases of [['otel-join'], ['usage-window'], ['report-shape'], ['iterations']]) {
      const ctx = makeHome();
      try {
        await buildFixtureTree(ctx.root, { home: ctx.home, cases });
        const env = cliEnv(ctx.home, { RIGORSCOPE_NOW: DST_NOW });
        runCli(['ingest'], { home: ctx.home, env });
        const r = runCli(['cost', '--by', 'role,model,effort'], { home: ctx.home, env });
        assert.equal(r.status, 0);
        for (const k of keysOf(r.stdout)) costKeys.add(k);
      } finally {
        ctx.cleanup();
      }
    }
    // Plan 03-04: a unit-level dimension brings the population footer lines.
    const units = makeHome();
    try {
      buildUnitsHome({ home: units.home, root: units.root });
      const env = cliEnv(units.home);
      runCli(['ingest'], { home: units.home, env });
      const r = runCli(['cost', '--by', 'tier'], { home: units.home, env });
      assert.equal(r.status, 0);
      for (const k of keysOf(r.stdout)) costKeys.add(k);
      // Plan 03-05: the decision sheet prints its own key behind --sheet.
      const sheet = runCli(['cost', '--by', 'tier', '--sheet'], { home: units.home, env });
      assert.equal(sheet.status, 0);
      for (const k of keysOf(sheet.stdout)) costKeys.add(k);
    } finally {
      units.cleanup();
    }
    return costKeys;
  };
  const collectDoctor = async () => {
    if (doctorKeys) return doctorKeys;
    doctorKeys = new Set();
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: 'all' });
      plantFakeNode(ctx.home);
      linkCheckout(ctx.home);
      const env = cliEnv(ctx.home);
      runCli(['ingest'], { home: ctx.home, env });
      runCli(['schedule', 'install', '--apply', '--no-systemctl'], { home: ctx.home, env });
      const r = runCli(['doctor'], { home: ctx.home, env });
      assert.equal(r.status, 0);
      for (const k of keysOf(r.stdout)) doctorKeys.add(k);
    } finally {
      ctx.cleanup();
    }
    return doctorKeys;
  };

  // Plan 02-02: the units surface, printed on the units home.
  let unitsKeys = null;
  const collectUnits = async () => {
    if (unitsKeys) return unitsKeys;
    unitsKeys = new Set();
    const ctx = makeHome();
    try {
      buildUnitsHome({ home: ctx.home, root: ctx.root });
      const env = cliEnv(ctx.home);
      runCli(['ingest'], { home: ctx.home, env });
      const r = runCli(['units'], { home: ctx.home, env });
      assert.equal(r.status, 0);
      for (const k of keysOf(r.stdout)) unitsKeys.add(k);
      // Plan 03-05: the decision sheet prints its own key behind --sheet.
      const s = runCli(['units', '--sheet'], { home: ctx.home, env });
      assert.equal(s.status, 0);
      for (const k of keysOf(s.stdout)) unitsKeys.add(k);
    } finally {
      ctx.cleanup();
    }
    return unitsKeys;
  };

  it('coverage: every key units prints on the units home is registered on the units surface', async () => {
    const printed = await collectUnits();
    assert.ok(printed.size >= 4, 'units printed its keys');
    assert.deepEqual([...printed].filter((k) => !registered('units').includes(k)), []);
  });

  // Plan 02-07: the units key lines of links and attribution join existing signals (no new signal id).
  it('plan 02-07: links is registered on unit-inventory and attribution on conservation, both on the units surface', () => {
    const on = (id) => SIGNALS.find((x) => x.id === id).keys.units ?? [];
    assert.ok(on('unit-inventory').includes('links'), 'links on unit-inventory');
    assert.ok(on('conservation').includes('attribution'), 'attribution on conservation');
    assert.ok(on('labels').includes('scope'), 'scope on labels');
  });

  it('coverage: every key registered on the units surface was printed by units', async () => {
    const printed = await collectUnits();
    assert.ok(registered('units').length >= 4, 'the registry lists units keys');
    assert.deepEqual(registered('units').filter((k) => !printed.has(k)), []);
  });

  // Plan 02-08: the tier surface, printed on the empty HOME and on the tier fixture HOME.
  let tierKeys = null;
  const collectTier = async () => {
    if (tierKeys) return tierKeys;
    tierKeys = new Set();
    const empty = makeHome();
    try {
      const r = runCli(['tier'], { home: empty.home, env: cliEnv(empty.home) });
      assert.equal(r.status, 0);
      for (const k of keysOf(r.stdout)) tierKeys.add(k);
    } finally {
      empty.cleanup();
    }
    const ctx = makeHome();
    try {
      buildTierHome({ home: ctx.home, root: ctx.root });
      const env = cliEnv(ctx.home, { TZ: 'UTC', RIGORSCOPE_NOW: TIER_TIMES.now });
      runCli(['ingest'], { home: ctx.home, env });
      const r = runCli(['tier'], { home: ctx.home, env });
      assert.equal(r.status, 0);
      for (const k of keysOf(r.stdout)) tierKeys.add(k);
      // Plan 03-05: the decision sheet prints its own key behind --sheet.
      const sheet = runCli(['tier', '--sheet'], { home: ctx.home, env });
      assert.equal(sheet.status, 0);
      for (const k of keysOf(sheet.stdout)) tierKeys.add(k);
    } finally {
      ctx.cleanup();
    }
    return tierKeys;
  };

  it('coverage: every key tier prints on the empty HOME and on the tier fixture HOME is registered on the tier surface', async () => {
    const printed = await collectTier();
    assert.ok(printed.size >= 7, 'tier printed its keys');
    assert.deepEqual([...printed].filter((k) => !registered('tier').includes(k)), []);
  });

  it('coverage: every key registered on the tier surface was printed by tier on one of those homes', async () => {
    const printed = await collectTier();
    assert.ok(registered('tier').length >= 7, 'the registry lists tier keys');
    assert.deepEqual(registered('tier').filter((k) => !printed.has(k)), []);
  });

  it('plan 02-08: the three tier-only signals have the owner-rigor-decisions consumer and come after every existing signal', () => {
    const ids = SIGNALS.map((s) => s.id);
    const tier = ids.filter((id) => ['tier-strata', 'confounder-changes', 'tier-leads'].includes(id));
    assert.deepEqual(tier, ['tier-strata', 'confounder-changes', 'tier-leads'].slice(0, tier.length));
    assert.ok(tier.length >= 1);
    assert.equal(ids.indexOf('tier-strata'), ids.length - tier.length);
    for (const id of tier) assert.equal(SIGNALS.find((s) => s.id === id).consumer, 'owner-rigor-decisions');
    assert.ok(Object.hasOwn(CONSUMERS, 'owner-rigor-decisions'));
  });

  it('coverage: every key cost prints on the four rich homes is registered on the cost surface', async () => {
    const printed = await collectCost();
    assert.ok(printed.size > 10, 'cost printed its keys');
    assert.deepEqual([...printed].filter((k) => !registered('cost').includes(k)), []);
  });

  it('coverage: every key registered on the cost surface was printed by cost at least once', async () => {
    const printed = await collectCost();
    assert.ok(registered('cost').length > 10, 'the registry lists cost keys');
    assert.deepEqual(registered('cost').filter((k) => !printed.has(k)), []);
  });

  it('coverage: every key doctor prints is registered on the doctor surface', async () => {
    const printed = await collectDoctor();
    assert.ok(printed.size >= 15, 'doctor printed its keys');
    assert.deepEqual([...printed].filter((k) => !registered('doctor').includes(k)), []);
  });

  it('coverage: every key registered on the doctor surface was printed by doctor', async () => {
    const printed = await collectDoctor();
    assert.ok(registered('doctor').length >= 15, 'the registry lists doctor keys');
    assert.deepEqual(registered('doctor').filter((k) => !printed.has(k)), []);
  });
  // Plan 03-05: the calibrate surface, printed on the calibrate home (one pair, so every field line prints).
  let calibrateKeys = null;
  const collectCalibrate = async () => {
    if (calibrateKeys) return calibrateKeys;
    calibrateKeys = new Set();
    const ctx = makeHome();
    try {
      await buildCalibrateHome({ home: ctx.home, root: ctx.root, pairs: [{ id: 'a1b', tier: 'B', startMin: 5, endMin: 5, session: 'sess-cal-1' }] });
      const r = runCli(['calibrate'], { home: ctx.home, env: calEnv(ctx.home) });
      assert.equal(r.status, 0);
      for (const k of keysOf(r.stdout)) calibrateKeys.add(k);
    } finally {
      ctx.cleanup();
    }
    return calibrateKeys;
  };

  it('coverage: every key calibrate prints is registered on the calibrate surface', async () => {
    const printed = await collectCalibrate();
    assert.ok(printed.size >= 6, 'calibrate printed its keys');
    assert.deepEqual([...printed].filter((k) => !registered('calibrate').includes(k)), []);
  });

  it('coverage: every key registered on the calibrate surface was printed by calibrate', async () => {
    const printed = await collectCalibrate();
    assert.ok(registered('calibrate').length >= 6, 'the registry lists calibrate keys');
    assert.deepEqual(registered('calibrate').filter((k) => !printed.has(k)), []);
  });
});

describe('documentation', () => {
  it('docs: docs/operations.md points to `doctor --signals`, which prints every signal id and its consumer key', () => {
    assert.ok(SIGNALS.length > 0, 'the registry is not empty');
    const file = new URL('../../docs/operations.md', import.meta.url);
    assert.ok(existsSync(file));
    assert.ok(readFileSync(file, 'utf8').includes('`rigorscope doctor --signals`'), 'the page names the command');
    const ctx = makeHome();
    try {
      const r = runCli(['doctor', '--signals'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      for (const s of SIGNALS) {
        assert.ok(r.stdout.includes(`${s.id}:`), `the command prints the signal ${s.id}`);
        assert.ok(r.stdout.includes(`consumer=${s.consumer}`), `the command prints the consumer ${s.consumer}`);
      }
    } finally {
      ctx.cleanup();
    }
  });
});
