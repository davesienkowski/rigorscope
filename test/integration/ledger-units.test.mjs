// Plan 03-03 (LEDG-03, TRUST-03, D-12, D-13, D-14): ledger lines become forward units. Task 1 holds the tracer; Task 3 adds
// the merge, provenance, incomplete, mixed-case pins and labels to this file. Every run uses a HOME from makeHome(); the
// real ~/.rigorscope is never touched. Expectations are computed by hand from what the fixture writes.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  cliEnv, ingestHome, makeHome, queryDb, runCli, stateDirOf,
} from '../fixtures/build.mjs';
import { buildUnitsHome } from '../fixtures/units-home.mjs';
import { LINK_TIMES, buildLinkHome } from '../fixtures/link-home.mjs';
import { appendLine } from '../../src/ledger/append.mjs';
import { buildLine } from '../../src/ledger/line.mjs';

const KEY = 'gsd-core:~/repos/alpha/.git:quick:261030-a1b';
const REPO_KEY = '~/repos/alpha/.git';
const TS = '2026-10-28T12:00:00.000Z';

const startLine = (over = {}) => {
  const r = buildLine({
    record: 'start', ts: TS, repo_key: REPO_KEY, kind: 'quick', native_id: '261030-a1b', tier: 'A', tier_source: 'plan-at-start',
    start: TS, ...over,
  });
  assert.equal(r.ok, true, r.reason);
  return r;
};

describe('tracer: one ledger line through ingest and derive to units --json (03-03 Task 1)', () => {
  let ctx;
  let line;
  before(async () => {
    ctx = makeHome();
    buildUnitsHome({ home: ctx.home, root: ctx.root });
    await ingestHome(ctx.home);
    line = startLine();
    appendLine(ctx.home, line.text);
  });
  after(() => ctx.cleanup());

  it('ingest stores the line keyed by its line_id and units --json reports that unit forward, every other reconstructed', () => {
    const ing = runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home) });
    assert.equal(ing.status, 0, ing.stderr);
    const rows = queryDb(join(stateDirOf(ctx.home), 'store.db'), 'SELECT line_id, unit_key, record, tier, tier_source FROM ledger_line');
    assert.deepEqual(rows, [{ line_id: line.line.line_id, unit_key: KEY, record: 'start', tier: 'A', tier_source: 'plan-at-start' }]);

    const r = runCli(['units', '--json'], { home: ctx.home, env: cliEnv(ctx.home) });
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.units.length, 3, 'the unit_key appears once');
    const by = Object.fromEntries(doc.units.map((u) => [u.key, u.population]));
    assert.equal(by[KEY], 'forward');
    for (const [k, p] of Object.entries(by)) if (k !== KEY) assert.equal(p, 'reconstructed', k);
  });
});

// ---- Task 3: the merge, provenance, incomplete status, labels and the ledger-only unit -------------------------------------
const A1 = 'gsd-core:~/repos/alpha/.git:quick:261030-a1b'; // PLAN and SUMMARY tier A in the fixture
const C2D = 'gsd-core:~/repos/alpha/.git:quick:261029-c2d'; // no tier, no SUMMARY
const E3F = 'gsd-core:~/work/beta/.git:quick:261028-e3f'; // never gets a ledger line
const L1 = 'gsd-core:~/repos/alpha/.git:quick:261101-zzz'; // ledger-only, start only
const L2 = 'gsd-core:~/repos/alpha/.git:quick:261101-yyy'; // ledger-only, end before start

const line = (over) => {
  const r = buildLine({ repo_key: REPO_KEY, kind: 'quick', ...over });
  assert.equal(r.ok, true, `${r.reason} ${JSON.stringify(over)}`);
  return r.text;
};
const derivedOf = (home, sql) => queryDb(join(stateDirOf(home), 'derived.db'), sql);
const unitsJson = (home) => {
  const r = runCli(['units', '--json'], { home, env: cliEnv(home) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const byKey = (doc) => Object.fromEntries(doc.units.map((u) => [u.key, u]));

describe('forward units: merge, provenance and incomplete (03-03 Task 3)', () => {
  let ctx;
  let baseline;
  let doc;
  let u;
  before(async () => {
    ctx = makeHome();
    buildUnitsHome({ home: ctx.home, root: ctx.root });
    await ingestHome(ctx.home);
    baseline = byKey(unitsJson(ctx.home));
    for (const text of [
      line({
        record: 'start', ts: '2026-10-27T10:00:00.000Z', native_id: '261030-a1b', tier: 'C', tier_source: 'declared-at-start',
        start: '2026-10-27T09:00:00.000Z', command: 'gsd-quick', runtime: 'claude-code', session_id: 'sess-a1b',
      }),
      line({
        record: 'close', ts: '2026-10-27T11:00:00.000Z', native_id: '261030-a1b', tier_source: 'unknown', status: 'complete',
        end: '2026-10-27T10:55:00.000Z',
      }),
      line({ record: 'start', ts: '2026-10-27T10:30:00.000Z', native_id: '261029-c2d', tier_source: 'unknown' }),
      line({
        record: 'start', ts: '2026-10-28T09:00:00.000Z', native_id: '261101-zzz', tier: 'B', tier_source: 'declared-at-start',
        start: '2026-10-28T09:00:00.000Z',
      }),
      line({ record: 'start', ts: '2026-10-27T10:00:00.000Z', native_id: '261101-yyy', tier_source: 'unknown', start: '2026-10-27T10:00:00.000Z' }),
      line({ record: 'close', ts: '2026-10-27T11:00:00.000Z', native_id: '261101-yyy', tier_source: 'unknown', status: 'failed', end: '2026-10-27T09:00:00.000Z' }),
    ]) appendLine(ctx.home, text);
    await ingestHome(ctx.home);
    doc = unitsJson(ctx.home);
    u = byKey(doc);
  });
  after(() => ctx.cleanup());

  it('the same unit_key never appears twice and the ledger-only units are counted', () => {
    assert.equal(doc.units.length, 5);
    assert.equal(new Set(doc.units.map((x) => x.key)).size, 5);
    assert.deepEqual(doc.strata.map((x) => [x.population, x.n, x.counts.quick]), [['forward', 4, 4], ['reconstructed', 1, 1]]);
    assert.equal(Object.hasOwn(doc, 'counts'), false, 'no figure adds the strata');
  });

  it('a start line with no close line is incomplete, forward and still counted', () => {
    assert.equal(u[C2D].population, 'forward');
    assert.equal(u[C2D].ledger.status, 'incomplete');
    assert.equal(u[C2D].ledger.lines, 1);
    assert.equal(u[L1].ledger.status, 'incomplete');
    assert.equal(u[A1].ledger.status, 'complete');
    assert.equal(u[L2].ledger.status, 'failed');
    const rows = derivedOf(ctx.home, "SELECT unit_key, status FROM unit WHERE status = 'incomplete' ORDER BY unit_key");
    assert.deepEqual(rows.map((r) => r.unit_key), [C2D, L1].sort());
  });

  it('incomplete is ledger-only and counted: a reconstructed unit has status NULL and population reconstructed', () => {
    assert.equal(u[E3F].population, 'reconstructed');
    assert.equal(u[E3F].ledger, null);
    assert.deepEqual(derivedOf(ctx.home, `SELECT status, ledger_lines, has_recon FROM unit WHERE unit_key = '${E3F}'`), [{ status: null, ledger_lines: 0, has_recon: 1 }]);
    assert.equal(derivedOf(ctx.home, "SELECT count(*) AS n FROM unit WHERE status = 'incomplete' AND population = 'reconstructed'")[0].n, 0);
  });

  it('a ledger tier overlays the fixture tier: signal ledger, declared-at-start, comparable; the reconstruction tier is kept in recon_tier', () => {
    assert.equal(baseline[A1].tier.value, 'A');
    assert.equal(baseline[A1].tier.signal, 'frontmatter');
    assert.equal(u[A1].tier.value, 'C');
    assert.equal(u[A1].tier.signal, 'ledger');
    assert.equal(u[A1].tier.timing, 'declared-at-start');
    assert.equal(u[A1].tier.comparable, true);
    assert.equal(u[A1].ledger.tier_source, 'declared-at-start');
    assert.deepEqual(derivedOf(ctx.home, `SELECT recon_tier, tier_source, tier_signal FROM unit WHERE unit_key = '${A1}'`),
      [{ recon_tier: 'A', tier_source: 'declared-at-start', tier_signal: 'ledger' }]);
  });

  it('an unknown ledger tier is not used: the reconstructed tier (or none) stays', () => {
    assert.equal(u[C2D].tier.value, baseline[C2D].tier.value);
    assert.equal(u[C2D].tier.signal, baseline[C2D].tier.signal);
    assert.equal(u[C2D].tier.signal, 'none');
    assert.equal(derivedOf(ctx.home, `SELECT tier_source FROM unit WHERE unit_key = '${C2D}'`)[0].tier_source, null);
  });

  it('a ledger start and end become start_ms and end_ms with source ledger; a null one falls back to reconstruction', () => {
    assert.equal(u[A1].start.utc, '2026-10-27T09:00:00.000Z');
    assert.equal(u[A1].start.date_source, 'ledger');
    assert.equal(u[A1].end.utc, '2026-10-27T10:55:00.000Z');
    assert.equal(u[A1].end.date_source, 'ledger');
    assert.equal(u[C2D].start.date_source, baseline[C2D].start.date_source, 'no ledger start: the reconstructed one');
    assert.equal(u[C2D].start.utc, baseline[C2D].start.utc);
    assert.equal(u[C2D].end.utc, baseline[C2D].end.utc);
    assert.equal(u[C2D].end.date_source, baseline[C2D].end.date_source);
  });

  it('recon_* hold what reconstruction alone computed, and ledger_start_ms / ledger_end_ms the merge result', () => {
    const r = derivedOf(ctx.home, `SELECT recon_start_ms, recon_end_ms, ledger_start_ms, ledger_end_ms FROM unit WHERE unit_key = '${A1}'`)[0];
    assert.equal(new Date(r.recon_start_ms).toISOString(), baseline[A1].start.utc);
    if (baseline[A1].end.date_source === 'clamped') assert.ok(r.recon_end_ms < r.recon_start_ms, 'recon_end_ms is the end before the clamp (review M1)');
    else assert.equal(new Date(r.recon_end_ms).toISOString(), baseline[A1].end.utc);
    assert.equal(r.ledger_start_ms, Date.parse('2026-10-27T09:00:00.000Z'));
    assert.equal(r.ledger_end_ms, Date.parse('2026-10-27T10:55:00.000Z'));
    const c = derivedOf(ctx.home, `SELECT ledger_start_ms, ledger_end_ms FROM unit WHERE unit_key = '${C2D}'`)[0];
    assert.deepEqual(c, { ledger_start_ms: null, ledger_end_ms: null });
  });

  it('recon_date_source and recon_end_source keep the reconstruction own sources; recon_end_ms is the unclamped end (review H1, M1)', () => {
    const r = derivedOf(ctx.home, `SELECT recon_date_source, recon_end_source FROM unit WHERE unit_key = '${A1}'`)[0];
    assert.equal(r.recon_date_source, baseline[A1].start.date_source, 'overlaid by the ledger in date_source, kept in recon_date_source');
    assert.equal(u[A1].start.date_source, 'ledger');
    assert.equal(r.recon_end_source, baseline[A1].end.date_source);
    const clamped = derivedOf(ctx.home, "SELECT unit_key, recon_start_ms, recon_end_ms FROM unit WHERE recon_end_source = 'clamped' AND has_recon = 1");
    assert.ok(clamped.length > 0, 'the fixture has a reconstruction whose end was raised to its start');
    for (const c of clamped) assert.ok(c.recon_end_ms < c.recon_start_ms, 'recon_end_ms is the value before the raise');
    assert.deepEqual(derivedOf(ctx.home, `SELECT recon_date_source, recon_end_source FROM unit WHERE unit_key = '${L1}'`),
      [{ recon_date_source: null, recon_end_source: null }], 'a ledger-only unit has no reconstruction sources');
  });

  it('recorded_at_utc is the earliest ledger line time for a forward unit and the reconstructed value for a unit with no line', () => {
    assert.notEqual(baseline[A1].recorded_at_utc, '2026-10-27T10:00:00.000Z', 'the reconstructed value differs in this fixture');
    assert.equal(u[A1].recorded_at_utc, '2026-10-27T10:00:00.000Z');
    assert.equal(u[L1].recorded_at_utc, '2026-10-28T09:00:00.000Z', 'a ledger-only unit');
    assert.equal(u[E3F].recorded_at_utc, baseline[E3F].recorded_at_utc, 'no line: unchanged');
  });

  it('a ledger-only unit is forward with present false, no dir, no reconstruction and every reconstruction-derived field unknown', () => {
    assert.equal(u[L1].population, 'forward');
    assert.equal(u[L1].present, false);
    assert.equal(u[L1].dir, null);
    assert.equal(u[L1].repo.display, 'alpha');
    assert.equal(u[L1].tier.value, 'B');
    assert.equal(u[L1].tier.signal, 'ledger');
    assert.equal(u[L1].git_evidence, false);
    assert.equal(u[L1].risk_class.value === null || Array.isArray(u[L1].risk_class.value), true);
    assert.equal(u[L1].confounders.unit_size.value, null);
    assert.ok(Object.values(u[L1].artifacts).every((n) => n === 0));
    assert.deepEqual(derivedOf(ctx.home, `SELECT has_recon, ledger_lines, size_commits, novelty, recon_tier, recon_start_ms, recon_end_ms, dir_rel FROM unit WHERE unit_key = '${L1}'`),
      [{ has_recon: 0, ledger_lines: 1, size_commits: null, novelty: null, recon_tier: null, recon_start_ms: null, recon_end_ms: null, dir_rel: null }]);
    assert.deepEqual(derivedOf(ctx.home, "SELECT count(*) AS n FROM unit WHERE has_recon = 0")[0], { n: 2 }, 'has_recon is 0 only for the ledger-only units');
  });

  it('an end before the start is clamped and the ledger end is kept unchanged in ledger_end_ms', () => {
    assert.equal(u[L2].end.date_source, 'clamped');
    assert.equal(u[L2].end.utc, u[L2].start.utc);
    const r = derivedOf(ctx.home, `SELECT ledger_start_ms, ledger_end_ms FROM unit WHERE unit_key = '${L2}'`)[0];
    assert.equal(r.ledger_end_ms, Date.parse('2026-10-27T09:00:00.000Z'));
    assert.equal(r.ledger_start_ms, Date.parse('2026-10-27T10:00:00.000Z'));
  });

  it('ledger end is not a git end: interval_trusted is 0 for a unit whose end comes from the ledger', () => {
    const rows = derivedOf(ctx.home, `SELECT unit_key, end_source, interval_trusted FROM unit WHERE end_source = 'ledger'`);
    assert.ok(rows.some((r) => r.unit_key === A1));
    for (const r of rows) assert.equal(r.interval_trusted, 0, r.unit_key);
  });

  it('strata replace the interim mixed label: units --json reports both populations and labels ledger-sourced tier, start and end as recorded', () => {
    assert.equal(doc.population, 'all');
    assert.equal(u[A1].tier.label, 'recorded');
    assert.equal(u[A1].start.label, 'recorded');
    assert.equal(u[A1].end.label, 'recorded');
    assert.equal(u[C2D].tier.label, 'unavailable');
    assert.equal(u[C2D].start.label, 'reconstructed');
    assert.equal(u[E3F].tier.label, 'reconstructed');
    assert.deepEqual(u[A1].ledger, {
      lines: 2, status: 'complete', command: 'gsd-quick', runtime: 'claude-code', session_id: 'sess-a1b', tier_source: 'declared-at-start',
    });
  });

  it('the text listing and the tier report print one population line per stratum, never mixed', () => {
    const t = runCli(['units'], { home: ctx.home, env: cliEnv(ctx.home) });
    assert.equal(t.status, 0, t.stderr);
    const pops = t.stdout.split('\n').filter((l) => l.startsWith('population:'));
    assert.deepEqual(pops.map((l) => l.split(' ').slice(0, 3).join(' ')), ['population: forward n=4', 'population: reconstructed n=1']);
    assert.ok(!t.stdout.includes('population: mixed'));
    const tj = runCli(['tier', '--json'], { home: ctx.home, env: cliEnv(ctx.home) });
    assert.equal(tj.status, 0, tj.stderr);
    const tdoc = JSON.parse(tj.stdout);
    assert.equal(tdoc.population, 'all');
    assert.deepEqual(tdoc.populations.map((p) => [p.population, p.counts.units]), [['forward', 4], ['reconstructed', 1]]);
    const tt = runCli(['tier'], { home: ctx.home, env: cliEnv(ctx.home) });
    assert.ok(tt.stdout.split('\n').some((l) => l.startsWith('population: forward units=4 ')), 'tier text');
    assert.ok(!tt.stdout.includes('population: mixed'));
  });

  it('a derived.db built one pass earlier than PASS_VERSION is rebuilt with reason pass_version', async () => {
    const { PASS_VERSION } = await import('../../src/derive/schema.mjs');
    const { ensureDerived } = await import('../../src/derive/ensure.mjs');
    const c3 = makeHome();
    try {
      buildUnitsHome({ home: c3.home, root: c3.root });
      await ingestHome(c3.home);
      assert.equal(ensureDerived({ home: c3.home, passVersion: PASS_VERSION - 1 }).rebuilt, true);
      assert.deepEqual(ensureDerived({ home: c3.home }), { rebuilt: true, reason: 'pass_version' });
      assert.equal(derivedOf(c3.home, 'SELECT pass_version FROM derive_state')[0].pass_version, PASS_VERSION);
    } finally {
      c3.cleanup();
    }
  });

  it('a home with no forward unit prints an empty forward stratum and every unit in the reconstructed one', async () => {
    const c2 = makeHome();
    try {
      buildUnitsHome({ home: c2.home, root: c2.root });
      await ingestHome(c2.home);
      const d2 = unitsJson(c2.home);
      assert.deepEqual(d2.strata.map((x) => [x.population, x.n]), [['forward', 0], ['reconstructed', 3]]);
    } finally {
      c2.cleanup();
    }
  });
});

// ---- Pins of the unedited trust and link rules on forward units (R1-09, M4; coordinator decisions) --------------------------
// These are pins of current behavior, not trust judgments: link-fill.mjs and the unit-fill trust loop are not edited by plan
// 03-03, and the expected values below are what those unedited rules produce (read from one run, then checked against the
// rule text: link-fill.mjs intervalTrust gives 1 for end_source git unless the end is shared by 5 or more units).
describe('forward units and the unedited link rules (03-03 Task 3 pins)', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    buildLinkHome({ home: ctx.home, root: ctx.root });
    ctx.env = cliEnv(ctx.home, { TZ: 'UTC', RIGORSCOPE_NOW: LINK_TIMES.now });
    const r = runCli(['ingest'], { home: ctx.home, env: ctx.env });
    assert.equal(r.status, 0, r.stderr);
  });
  after(() => ctx.cleanup());

  const cli = (args) => {
    const r = runCli(args, { home: ctx.home, env: ctx.env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const snap = () => {
    const doc = JSON.parse(cli(['units', '--json']));
    return {
      units: derivedOf(ctx.home, 'SELECT unit_key, date_source, end_source, interval_trusted, population FROM unit ORDER BY unit_key'),
      links: derivedOf(ctx.home, `SELECT unit_key, session_id, agent_id, method, confidence, base_confidence, lowered_by, match
                                    FROM unit_link ORDER BY unit_key, session_id, agent_id, method`),
      stats: doc.links,
    };
  };
  const unitOf = (snapshot, id) => snapshot.units.find((u) => u.unit_key.endsWith(`:${id}`));
  const linksOf = (snapshot, id) => snapshot.links.filter((l) => l.unit_key.endsWith(`:${id}`));
  const aLine = (over) => line({ repo_key: REPO_KEY, kind: 'quick', ...over });

  it('ledger start mixed case is pinned: a ledger start with a reconstructed git end keeps the trust and links the unedited rules give', () => {
    const before = snap();
    assert.deepEqual([unitOf(before, '261003-d1d').date_source, unitOf(before, '261003-d1d').end_source], ['quick-id', 'git']);
    appendLine(ctx.home, aLine({
      record: 'start', ts: '2026-10-03T00:30:00.000Z', native_id: '261003-d1d', tier_source: 'unknown', start: '2026-10-03T00:00:00.000Z',
    }));
    cli(['ingest']);
    const after = snap();
    const d1d = unitOf(after, '261003-d1d');
    assert.deepEqual([d1d.population, d1d.date_source, d1d.end_source], ['forward', 'ledger', 'git']);
    // Pinned values: trusted 1 (a git end shared by fewer than 5 units), exactly as the reconstructed control q1a.
    assert.equal(d1d.interval_trusted, 1);
    assert.equal(unitOf(after, '261001-q1a').interval_trusted, 1, 'control: a reconstructed start with a git end');
    assert.equal(unitOf(before, '261003-d1d').interval_trusted, 1);
    // The links into the unit are the same rows with the same confidence as before the ledger line: an interval link low,
    // the repo-matched tool-path link high, the dir-name tool-path link lowered to low.
    assert.deepEqual(linksOf(after, '261003-d1d'), linksOf(before, '261003-d1d'));
    assert.deepEqual(linksOf(after, '261003-d1d').map((l) => `${l.method}/${l.confidence}`).sort(), ['interval/low', 'tool-path/high', 'tool-path/low']);
    assert.deepEqual(after.stats, before.stats, 'no link count moves');
  });

  it('ledger interval makes a slash link ambiguous: a ledger-timed forward unit of the same kind and repo takes the slash link of a reconstructed unit', () => {
    const before = snap();
    // The slash-command instant of S7 (10-01 14:00) lies in q2b's interval only, so q2b holds the slash links of S7 and S10.
    const slash = (snapshot) => linksOf(snapshot, '261001-q2b').filter((l) => l.method === 'slash-command');
    assert.deepEqual(slash(before).map((l) => `${l.session_id.slice(0, 8)}/${l.confidence}`), ['1a000007/medium', '1a000010/medium']);
    assert.equal(before.stats.slash_ambiguous, 0);
    appendLine(ctx.home, aLine({
      record: 'start', ts: '2026-10-01T13:00:00.000Z', native_id: '261001-f1a', tier_source: 'unknown', start: '2026-10-01T13:00:00.000Z',
    }));
    appendLine(ctx.home, aLine({
      record: 'close', ts: '2026-10-01T15:30:00.000Z', native_id: '261001-f1a', tier_source: 'unknown', status: 'complete',
      end: '2026-10-01T15:00:00.000Z',
    }));
    cli(['ingest']);
    const after = snap();
    const fwd = unitOf(after, '261001-f1a');
    assert.deepEqual([fwd.population, fwd.date_source, fwd.end_source, fwd.interval_trusted], ['forward', 'ledger', 'ledger', 0]);
    // The unedited rule: the instant now lies in two usable intervals, so neither unit gets the slash link. The count of
    // slash_ambiguous rises by the two scopes (S7, S10) and the medium slash-command links fall from 3 to 1.
    assert.deepEqual(slash(after), []);
    assert.equal(after.stats.slash_ambiguous, 2);
    assert.equal(before.stats.methods['slash-command'].medium, 3);
    assert.equal(after.stats.methods['slash-command'].medium, 1);
    // The forward unit gets only low interval links (its ledger end is not a git end: no medium link of any kind).
    assert.deepEqual(linksOf(after, '261001-f1a').map((l) => `${l.method}/${l.confidence}`), ['interval/low', 'interval/low']);
    // Decision recorded: honest ambiguity, not a bug (docs/units.md, ADR-0011 consequences).
  });
});

// ---- The derived DDL pin list (plan 03.1-02, J8, T-03.1-27) --------------------------------------------------------------
// Append-only: one entry per PASS_VERSION at which the derived DDL changed, with the sha256 of the sorted `sql` texts of
// sqlite_master of a freshly built derived.db. A DDL change with no new entry fails the hash check; a new entry that reuses
// the current version fails the version check. A change of pass OUTPUT with no DDL change has no failing test: it is a review
// check of the PASS_VERSION diff (plan 03.1-02 J8). Overwriting the last entry is visible only in the diff.
const DDL_PINS = [
  // PASS_VERSION 17 (plan 03.1-02 Task 1): the DDL unchanged since 16; the pass raised membership to canonical paths.
  { version: 17, ddl: 'sha256:f0eb51096ba2d2c27e92a14ea461797d2476f2e241b67124623660ccc1ebce2b' },
  // PASS_VERSION 18 (plan 03.1-02 Task 2): the table repo_scan_count and the column unit.id_repeats.
  { version: 18, ddl: 'sha256:ff9cc1fa4d907406a07986636425e5fb1e5c05dff01ba49fb030fcee3c7e256d' },
  // PASS_VERSION 19 (review CR-03): repo_scan_count output only (a 0 row per counter); the DDL is unchanged, so no new entry.
  // PASS_VERSION 20 (plan 03.1-03 Task 2): link-fill output only (former live path, reused plan id); the DDL is unchanged, so no new entry.
];

describe('the derived DDL pin list (J8)', () => {
  const ddlSha = async () => {
    const { createHash } = await import('node:crypto');
    const c = makeHome();
    try {
      buildUnitsHome({ home: c.home, root: c.root });
      await ingestHome(c.home);
      const { ensureDerived } = await import('../../src/derive/ensure.mjs');
      ensureDerived({ home: c.home });
      const sqls = derivedOf(c.home, 'SELECT sql FROM sqlite_master WHERE sql IS NOT NULL').map((r) => r.sql).sort();
      return `sha256:${createHash('sha256').update(sqls.join('\n')).digest('hex')}`;
    } finally {
      c.cleanup();
    }
  };

  it('the last entry is the current DDL, versions strictly increase, neighbours differ and the last is at most PASS_VERSION', async () => {
    const { PASS_VERSION } = await import('../../src/derive/schema.mjs');
    assert.ok(DDL_PINS.length >= 1, 'at least one pin');
    for (let i = 1; i < DDL_PINS.length; i += 1) {
      assert.ok(DDL_PINS[i].version > DDL_PINS[i - 1].version, `version ${DDL_PINS[i].version} strictly after ${DDL_PINS[i - 1].version}`);
      assert.notEqual(DDL_PINS[i].ddl, DDL_PINS[i - 1].ddl, 'consecutive entries have different DDL');
    }
    const last = DDL_PINS[DDL_PINS.length - 1];
    assert.ok(last.version <= PASS_VERSION, 'the last pinned version is at most PASS_VERSION');
    assert.equal(await ddlSha(), last.ddl, 'the derived DDL changed: append a pin entry at a new, higher PASS_VERSION');
  });
});
