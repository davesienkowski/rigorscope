// Regression tests of the plan 02-07 review findings (02-07-REVIEW.md WR-01, WR-02, WR-04) and of the fix plan's revision
// rows, written before each fix (RED). Every run spawns the CLI on a temporary HOME from makeHome() built by
// test/fixtures/link-review-home.mjs, under a fixed clock and TZ=UTC; expectations come from that fixture's hand-computed
// constants. The derived database is read with queryDb only.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  cliEnv, makeHome, queryDb, runCli, stateDirOf,
} from '../fixtures/build.mjs';
import {
  REVIEW_BULK_END_MS, REVIEW_EXPECTED, REVIEW_SESSIONS, REVIEW_TIMES, buildReviewHome,
} from '../fixtures/link-review-home.mjs';

const E = REVIEW_EXPECTED;
const envOf = (home) => cliEnv(home, { TZ: 'UTC', RIGORSCOPE_NOW: REVIEW_TIMES.now });
const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const derivedOf = (home) => join(stateDirOf(home), 'derived.db');
const cli = (home, args) => runCli(args, { home, env: envOf(home) });
const enc = (v) => {
  let out = '';
  for (const byte of new TextEncoder().encode(v)) {
    const ch = String.fromCharCode(byte);
    out += byte < 128 && /[A-Za-z0-9._:~-]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
};
const linkId = (key, s, a) => `l:${enc(key)}/${enc(s)}${a === '' ? '' : `/${enc(a)}`}`;

// Registers a before/after pair that builds and ingests the review fixture; -> a holder whose .home is set in before().
function useHome() {
  const h = { home: null, cleanup: null };
  before(() => {
    const c = makeHome();
    h.home = c.home;
    h.cleanup = c.cleanup;
    buildReviewHome({ home: c.home, root: c.root });
    const ing = cli(c.home, ['ingest']);
    assert.equal(ing.status, 0, ing.stderr);
    const units = cli(c.home, ['units']);
    assert.equal(units.status, 0, units.stderr);
  });
  after(() => h.cleanup());
  return h;
}

describe('WR-01: units whose end is the shared bulk planning commit get no medium link from an interval', () => {
  const ctx = useHome();
  it('the fixture really ends all six quick units at the one bulk instant (git) and the plan units elsewhere', () => {
    const rows = queryDb(derivedOf(ctx.home), 'SELECT unit_key, end_ms, end_source FROM unit ORDER BY unit_key');
    for (const key of E.units.bulk) {
      const r = rows.find((x) => x.unit_key === key);
      assert.deepEqual([r.end_ms, r.end_source], [REVIEW_BULK_END_MS, 'git'], key);
    }
    for (const key of [E.units.p1, E.units.p2]) assert.notEqual(rows.find((x) => x.unit_key === key).end_ms, REVIEW_BULK_END_MS);
  });

  it('interval_trusted is a derived unit column: 0 for the six shared-end units, 1 for the two plans', () => {
    const rows = queryDb(derivedOf(ctx.home), 'SELECT unit_key, interval_trusted FROM unit ORDER BY unit_key');
    for (const key of E.units.bulk) assert.equal(rows.find((x) => x.unit_key === key).interval_trusted, 0, key);
    for (const key of [E.units.p1, E.units.p2]) assert.equal(rows.find((x) => x.unit_key === key).interval_trusted, 1, key);
  });

  it('the /gsd-quick instant inside exactly one of them makes no slash-command link; strict mode does not attribute the scope', () => {
    const slash = queryDb(derivedOf(ctx.home), "SELECT unit_key FROM unit_link WHERE session_id = ? AND method = 'slash-command'", [REVIEW_SESSIONS.SA]);
    assert.deepEqual(slash, []);
    const attr = queryDb(derivedOf(ctx.home), `
SELECT link_confidence, bucket, reason, unit_key FROM scope_attribution WHERE session_id = ? AND agent_id = '' ORDER BY link_confidence`, [REVIEW_SESSIONS.SA]);
    assert.deepEqual(attr.map((r) => [r.link_confidence, r.bucket, r.reason]), [
      ['low', 'attributed', 'one-low-unit'], ['medium', 'unattributed_overlap', 'low-only'],
    ]);
    assert.equal(attr[0].unit_key, E.units.bulk[0], 'the widened mode still shows the low interval link');
  });

  it('shared_end_units is counted: derive_state holds 6 and the links: line ends with shared_end_units=6', () => {
    assert.equal(queryDb(derivedOf(ctx.home), 'SELECT link_shared_end_units AS n FROM derive_state')[0].n, 6);
    const line = linesOf(cli(ctx.home, ['units']).stdout).find((l) => l.startsWith('links: '));
    assert.ok(line.endsWith(' shared_end_units=6'), line);
    assert.ok(line.includes(' slash_ambiguous=0 '), 'a trust drop is not an ambiguity');
    assert.ok(line.includes(' phase_dropped=0 '), 'a trust drop is not a phase drop');
  });
});

describe('WR-02: link evidence lists exactly the refs and instants that created the link', () => {
  const ctx = useHome();
  const evidence = (unit, session, agent = '') => {
    const r = cli(ctx.home, ['evidence', linkId(unit, session, agent), '--json']);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  it('reviewer shape: SB writes plan A and reads CONTEXT while only plan B overlaps it; A lists 1 ref (as unit_link), B lists the CONTEXT read', () => {
    const a = evidence(E.units.p1, REVIEW_SESSIONS.SB);
    assert.equal(a.totals.refs, E.sbRefs.p1);
    assert.deepEqual(a.evidence.refs.map((r) => [r.rel_path.split('/').pop(), r.tool_name]), [['07-01-PLAN.md', 'Write']]);
    const b = evidence(E.units.p2, REVIEW_SESSIONS.SB);
    assert.equal(b.totals.refs, E.sbRefs.p2);
    assert.deepEqual(b.evidence.refs.map((r) => [r.rel_path.split('/').pop(), r.tool_name]), [['07-CONTEXT.md', 'Read']]);
  });

  it('for every link of the fixture the evidence totals equal the unit_link counts (refs for tool-path, commands plus skills for slash-command)', () => {
    const rows = queryDb(derivedOf(ctx.home), `SELECT session_id, agent_id, unit_key, method, refs, instants FROM unit_link
 WHERE method <> 'interval' ORDER BY session_id, agent_id, unit_key, method`);
    assert.ok(rows.length >= 3, 'the fixture has tool-path links');
    for (const r of rows) {
      const e = evidence(r.unit_key, r.session_id, r.agent_id);
      if (r.method === 'tool-path') assert.equal(e.totals.refs, r.refs, `${r.unit_key} ${r.session_id}`);
      else assert.equal(e.totals.commands + e.totals.skills, r.instants, `${r.unit_key} ${r.session_id}`);
    }
  });
});

describe('WR-04: --role ? selects the calls whose role is unknown', () => {
  const ctx = useHome();
  const unitsOf = (args) => {
    const r = cli(ctx.home, ['units', '--json', ...args]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).units.map((u) => u.key).sort();
  };

  it('the fixture holds calls of role unknown with role_source unavailable (a subagent with no attribution agent and no meta type)', () => {
    const rows = queryDb(derivedOf(ctx.home), "SELECT role, role_source FROM api_call WHERE role_source = 'unavailable'");
    assert.deepEqual(rows, [{ role: 'unknown', role_source: 'unavailable' }]);
  });

  it('units --role ? lists the unit that owns them (07-02) and nothing else; --role unknown still works and lists the same', () => {
    assert.deepEqual(unitsOf(['--role', '?']), [E.units.p2]);
    assert.deepEqual(unitsOf(['--role', 'unknown']), [E.units.p2]);
  });

  it('a list mixing ? with a known role is the union (every main-thread scope of the fixture is unattributed in the strict mode, so only 07-02 remains)', () => {
    assert.deepEqual(unitsOf(['--role', 'main']), []);
    assert.deepEqual(unitsOf(['--role', 'main,?']), [E.units.p2]);
  });
});

describe('WR-05: units --json labels every attribution value', () => {
  const ctx = useHome();
  it('each bucket carries labels.tokens and labels.usd_nano: derived for a known value, unavailable only for null; buckets still sum to the total', () => {
    const r = cli(ctx.home, ['units', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const a = JSON.parse(r.stdout).attribution;
    for (const name of ['attributed', 'unattributed_overlap', 'unlinked', 'total']) {
      const b = a[name];
      assert.deepEqual(Object.keys(b.labels), ['tokens', 'usd_nano'], name);
      assert.equal(b.labels.tokens, b.tokens === null ? 'unavailable' : 'derived', name);
      assert.equal(b.labels.usd_nano, b.usd_nano === null ? 'unavailable' : 'derived', name);
    }
    assert.equal(a.unlinked.calls, 0);
    assert.deepEqual([a.unlinked.tokens, a.unlinked.usd_nano], [0, 0], 'a known-zero empty bucket stays 0');
    assert.equal(a.attributed.tokens + a.unattributed_overlap.tokens + a.unlinked.tokens, a.total.tokens);
  });
});
