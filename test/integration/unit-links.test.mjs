// Plan 02-07 (UNIT-06, UNIT-01, D-12, D-13, D-19): session-to-unit links at (session, agent) scope, the D-13 attribution
// buckets with their conservation check, the per-unit cost of `rigorscope units` and the unit evidence ids. Written
// before the code (RED).
//
// Every run spawns the CLI on a temporary HOME from makeHome() built by test/fixtures/link-home.mjs, under a fixed
// clock and TZ=UTC; every git repository is created inside that HOME. The expectations come from the fixture's
// hand-computed tables; dollar sums are checked against an independent query of the derived calls' cost. Modules this
// plan creates are imported dynamically inside each test, so the file loads at RED and fails on its assertions.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  cliEnv, makeHome, queryDb, runCli, stateDirOf,
} from '../fixtures/build.mjs';
import {
  makeAssistant, makeUsage, mangleHome, writeJsonl,
} from '../fixtures/build.mjs';
import {
  archiveDir, commitAt, makeRepo, planText, writeFileAt, writePlanningDir,
} from '../fixtures/git-repo.mjs';
import { LINK_EXPECTED, LINK_SESSIONS, LINK_TIMES, buildLinkHome } from '../fixtures/link-home.mjs';
import { formatUsd } from '../../src/measure/measure.mjs';

const E = LINK_EXPECTED;
const envOf = (home) => cliEnv(home, { TZ: 'UTC', RIGORSCOPE_NOW: LINK_TIMES.now });
const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const derivedOf = (home) => join(stateDirOf(home), 'derived.db');
const enc = (v) => {
  let out = '';
  for (const byte of new TextEncoder().encode(v)) {
    const ch = String.fromCharCode(byte);
    out += byte < 128 && /[A-Za-z0-9._:~-]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
};
const unitId = (key) => `u:${enc(key)}`;
const linkId = (key, s, a) => `l:${enc(key)}/${enc(s)}${a === '' ? '' : `/${enc(a)}`}`;
const usdOf = (home, callKeys) => queryDb(
  derivedOf(home),
  `SELECT sum(cost_nano) AS n, count(cost_nano) AS k, count(*) AS c FROM api_call WHERE call_key IN (${callKeys.map(() => '?').join(', ')})`,
  callKeys,
)[0];

function cli(home, args) {
  const r = runCli(args, { home, env: envOf(home) });
  return r;
}

describe('tracer: a tool-path write link travels to unit cost, the attribution line and a unit evidence id (02-07 Task 1)', () => {
  let ctx;
  let doc;
  let text;
  before(() => {
    ctx = makeHome();
    buildLinkHome({ home: ctx.home, root: ctx.root });
    const ing = cli(ctx.home, ['ingest']);
    assert.equal(ing.status, 0, ing.stderr);
    const j = cli(ctx.home, ['units', '--json']);
    assert.equal(j.status, 0, j.stderr);
    doc = JSON.parse(j.stdout);
    const t = cli(ctx.home, ['units']);
    assert.equal(t.status, 0, t.stderr);
    text = t.stdout;
  });
  after(() => ctx.cleanup());

  const recordOf = (key) => doc.units.find((u) => u.key === key);

  it("units --json: q1a's cost block equals the S1 main-thread scope (calls, scopes, tokens by class, usd), label derived", () => {
    const s1 = E.scopes.S1;
    const cost = recordOf(E.units.q1a).cost;
    assert.equal(cost.calls, s1.calls.length, 'calls of the S1 main scope');
    assert.equal(cost.scopes, 1);
    assert.equal(cost.link_confidence, 'medium');
    assert.equal(cost.input, s1.input);
    assert.equal(cost.output, s1.output);
    assert.equal(cost.cache_read, s1.cache_read);
    assert.equal(cost.cache_write, s1.cache_write);
    assert.equal(cost.tokens, s1.tokens);
    const usd = usdOf(ctx.home, s1.calls);
    assert.equal(usd.k, usd.c, 'every S1 main call is priced');
    assert.equal(cost.usd_nano, usd.n);
    assert.equal(cost.label, 'derived');
  });

  it("units --json: q1a's links hold the S1 main entry (best high, tool-path, an l: id) and the S1 subagent entry (best medium)", () => {
    const u = recordOf(E.units.q1a);
    assert.equal(u.evidence_id, unitId(E.units.q1a));
    const main = u.links.find((l) => l.session_id === LINK_SESSIONS.S1 && l.agent_id === '');
    const sub = u.links.find((l) => l.session_id === LINK_SESSIONS.S1 && l.agent_id === LINK_SESSIONS.A1);
    assert.ok(main && sub, 'both S1 scopes are linked to q1a');
    assert.equal(main.confidence, 'high');
    assert.ok(main.evidence_id.startsWith('l:'));
    assert.equal(main.evidence_id, linkId(E.units.q1a, LINK_SESSIONS.S1, ''));
    assert.ok(main.methods.some((m) => m.method === 'tool-path' && m.confidence === 'high'));
    assert.equal(sub.confidence, 'medium');
    assert.equal(sub.evidence_id, linkId(E.units.q1a, LINK_SESSIONS.S1, LINK_SESSIONS.A1));
  });

  it('units --json: the attribution object of mode medium sums its buckets to the total and says check ok', () => {
    const a = doc.attribution;
    assert.equal(a.link_confidence, 'medium');
    assert.equal(a.check, 'ok');
    const total = Object.values(E.scopes).reduce((n, s) => n + s.calls.length, 0);
    assert.equal(a.total.calls, total);
    assert.equal(a.attributed.calls + a.unattributed_overlap.calls + a.unlinked.calls, a.total.calls);
    assert.equal(a.attributed.tokens + a.unattributed_overlap.tokens + a.unlinked.tokens, a.total.tokens);
    assert.equal(a.attributed.usd_nano + a.unattributed_overlap.usd_nano + a.unlinked.usd_nano, a.total.usd_nano);
    assert.equal(a.total.tokens, Object.values(E.scopes).reduce((n, sc) => n + sc.tokens, 0));
    assert.equal(a.refs_unknown_calls, 0);
  });

  it('units text: the header gains links tokens usd, q1a ends 1/1/0 with its tokens and usd, z9z ends 0/0/0 ? ?, then the attribution line', () => {
    const lines = linesOf(text);
    const header = lines.find((l) => l.startsWith('repo '));
    assert.deepEqual(header.trim().split(/\s+/).slice(-3), ['links', 'tokens', 'usd']);
    const row = (id) => lines.find((l) => l.trim().split(/\s+/)[2] === id).trim().split(/\s+/);
    const s1 = E.scopes.S1;
    const usd = usdOf(ctx.home, s1.calls);
    assert.deepEqual(row('261001-q1a').slice(-3), ['1/1/0', String(s1.tokens), formatUsd(usd.n / 1e9)]);
    assert.deepEqual(row('261009-z9z').slice(-3), ['0/0/0', '?', '?']);
    const unitsAt = lines.findIndex((l) => l.startsWith('units: '));
    const attrAt = lines.findIndex((l) => l.startsWith('attribution: '));
    assert.ok(unitsAt >= 0 && attrAt > unitsAt, 'the attribution line follows the units line');
    assert.ok(lines[attrAt].startsWith('attribution: whole store, both populations (not a stratum figure) link_confidence=medium section=main '));
    assert.ok(lines[attrAt].endsWith('check=ok (otel and harness calls are outside attribution)'), lines[attrAt]);
  });

  it("evidence <q1a's u: id> lists the unit, both links and exactly the S1 main-thread calls", () => {
    const id = unitId(E.units.q1a);
    const r = cli(ctx.home, ['evidence', id]);
    assert.equal(r.status, 0, r.stderr);
    const lines = linesOf(r.stdout);
    assert.ok(lines.includes(`evidence: unit ${id}`), 'the heading names the unit id');
    const unitLine = lines.find((l) => l.startsWith('unit '));
    assert.ok(unitLine && /tier=A /.test(unitLine) && /tier_signal=frontmatter /.test(unitLine) && /tier_conflict=no/.test(unitLine), unitLine);
    const mainLink = lines.find((l) => l.startsWith(`link ${linkId(E.units.q1a, LINK_SESSIONS.S1, '')} `));
    assert.ok(mainLink && mainLink.includes('tool-path/high'), mainLink);
    assert.ok(lines.some((l) => l.startsWith(`link ${linkId(E.units.q1a, LINK_SESSIONS.S1, LINK_SESSIONS.A1)} `)));
    const calls = lines.filter((l) => l.startsWith('call ')).map((l) => l.split(' ')[1]).sort();
    assert.deepEqual(calls, E.scopes.S1.calls);
  });

  it('evidence: a malformed unit or link id exits 2 with one fixed line that holds no input; a well-formed id of no unit lists nothing', () => {
    for (const bad of ['u:%ZZ', 'l:x', 'u:', `u:${'a'.repeat(1030)}`]) {
      const r = cli(ctx.home, ['evidence', bad]);
      assert.equal(r.status, 2, 'exit 2 for a malformed id');
      assert.equal(r.stderr.trim().split('\n').length, 1);
      assert.ok(!r.stderr.includes('%ZZ') && !r.stderr.includes('aaaa'), 'the id is never echoed');
      assert.equal(r.stdout, '');
    }
    const none = cli(ctx.home, ['evidence', unitId('gsd-core:~/nowhere/.git:quick:261001-xxx')]);
    assert.equal(none.status, 0, none.stderr);
    assert.ok(/links=0 calls=0/.test(none.stdout), none.stdout);
  });

  it('checkAttribution is ok in both modes and reports a violation of class sums only on a copy with one scope_attribution row deleted', async () => {
    const { checkAttribution } = await import('../../src/derive/attribution.mjs');
    const db = new DatabaseSync(derivedOf(ctx.home), { readOnly: true });
    try {
      for (const mode of ['medium', 'low']) {
        const r = checkAttribution(db, { mode });
        assert.equal(r.ok, true, `mode ${mode}`);
        assert.equal(r.missing_calls, 0);
      }
    } finally {
      db.close();
    }
    const copy = join(ctx.home, 'derived-copy.db');
    copyFileSync(derivedOf(ctx.home), copy);
    const w = new DatabaseSync(copy);
    try {
      w.prepare("DELETE FROM scope_attribution WHERE session_id = ? AND agent_id = '' AND link_confidence = 'medium'").run(LINK_SESSIONS.S1);
      const r = checkAttribution(w, { mode: 'medium' });
      assert.equal(r.ok, false);
      assert.equal(r.missing_calls, E.scopes.S1.calls.length);
      assert.ok(r.classes.some((c) => c.column === 'input_tokens'));
      assert.ok(JSON.stringify(r).length > 0 && !JSON.stringify(r).includes(LINK_SESSIONS.S1), 'names and numbers only');
      assert.equal(checkAttribution(w, { mode: 'low' }).ok, true, 'the other mode is untouched');
    } finally {
      w.close();
    }
  });
});

describe('empty HOME (02-07 Task 1)', () => {
  it('units --json carries an attribution object with zero totals and check ok; units prints the attribution line with check=ok', () => {
    const ctx = makeHome();
    try {
      const j = cli(ctx.home, ['units', '--json']);
      assert.equal(j.status, 0, j.stderr);
      const a = JSON.parse(j.stdout).attribution;
      assert.ok(a, 'the attribution object exists');
      assert.equal(a.check, 'ok');
      assert.equal(a.total.calls, 0);
      assert.equal(a.unlinked.calls, 0);
      const t = cli(ctx.home, ['units']);
      assert.ok(linesOf(t.stdout).some((l) => l.startsWith('attribution: ') && l.includes(' check=ok ')), t.stdout);
    } finally {
      ctx.cleanup();
    }
  });
});

// ---- Task 2: every method, lowering rule, reason and mode on the fixture table ------------------------------------
const scopeKey = (r) => `${r.session_id}\0${r.agent_id}`;
const sortRows = (rows, cols) => rows.slice().sort((a, b) => {
  const ka = cols.map((c) => String(a[c])).join('\0');
  const kb = cols.map((c) => String(b[c])).join('\0');
  return ka < kb ? -1 : ka > kb ? 1 : 0;
});
const LINK_COLS = ['session_id', 'agent_id', 'unit_key', 'method', 'confidence', 'base_confidence', 'lowered_by', 'match', 'phase_level'];
const expectedLinks = () => sortRows(E.links.map((l) => {
  const { scope, ...rest } = l;
  return { ...E.scopeOf(scope), ...rest };
}), ['session_id', 'agent_id', 'unit_key', 'method']).map((r) => Object.fromEntries(LINK_COLS.map((c) => [c, r[c]])));
const expectedAttribution = (refsKnown = () => 1) => sortRows(['low', 'medium'].flatMap((mode) => E.attribution[mode].map((a) => ({
  ...E.scopeOf(a.scope), link_confidence: mode, bucket: a.bucket, reason: a.reason, unit_key: a.unit_key, refs_known: refsKnown(a.scope),
}))), ['session_id', 'agent_id', 'link_confidence']);
const linkRows = (home) => queryDb(derivedOf(home), `SELECT ${LINK_COLS.join(', ')} FROM unit_link ORDER BY session_id, agent_id, unit_key, method`);
const attrRows = (home) => queryDb(derivedOf(home), `
SELECT session_id, agent_id, link_confidence, bucket, reason, unit_key, refs_known FROM scope_attribution
 ORDER BY session_id, agent_id, link_confidence`);
const tableDigest = (home) => JSON.stringify([
  queryDb(derivedOf(home), 'SELECT * FROM unit_link ORDER BY session_id, agent_id, unit_key, method'),
  queryDb(derivedOf(home), 'SELECT * FROM scope_attribution ORDER BY session_id, agent_id, link_confidence'),
  queryDb(derivedOf(home), 'SELECT * FROM unit_attribution ORDER BY unit_key, link_confidence'),
  queryDb(derivedOf(home), 'SELECT * FROM unit_confounder ORDER BY unit_key, link_confidence, name, role'),
]);

describe('the link fixture table (02-07 Task 2)', () => {
  let ctx;
  let text;
  before(() => {
    ctx = makeHome();
    buildLinkHome({ home: ctx.home, root: ctx.root });
    const ing = cli(ctx.home, ['ingest']);
    assert.equal(ing.status, 0, ing.stderr);
    text = cli(ctx.home, ['units']).stdout;
  });
  after(() => ctx.cleanup());

  it("S7 is linked to q2b by slash-command (medium) from its /gsd-quick instant inside q2b's interval only", () => {
    const row = linkRows(ctx.home).find((r) => r.session_id === LINK_SESSIONS.S7 && r.method === 'slash-command');
    assert.deepEqual(row, {
      session_id: LINK_SESSIONS.S7, agent_id: '', unit_key: E.units.q2b, method: 'slash-command', confidence: 'medium',
      base_confidence: 'medium', lowered_by: null, match: null, phase_level: 0,
    });
  });

  it('unit_link equals the hand-computed table (unit, method, confidence, base, lowered_by, match, phase_level)', () => {
    assert.deepEqual(linkRows(ctx.home), expectedLinks());
  });

  it('scope_attribution of both modes equals the hand-computed table (bucket, reason, unit, refs_known)', () => {
    assert.deepEqual(attrRows(ctx.home), expectedAttribution());
  });

  it('every main-section call has exactly one scope_attribution row per mode', () => {
    for (const mode of ['medium', 'low']) {
      const r = queryDb(derivedOf(ctx.home), `
SELECT count(*) AS n FROM api_call c WHERE c.token_label = 'transcript'
   AND (SELECT count(*) FROM scope_attribution sa WHERE sa.session_id = c.owner_session_id AND sa.agent_id = c.owner_agent_id
         AND sa.link_confidence = ?) <> 1`, [mode]);
      assert.equal(r[0].n, 0, mode);
    }
  });

  it('the buckets of mode medium hold the hand-computed scopes', async () => {
    const { loadAttributionTotals } = await import('../../src/report/unit-cost.mjs');
    const db = new DatabaseSync(derivedOf(ctx.home), { readOnly: true });
    try {
      const a = loadAttributionTotals(db, { mode: 'medium' });
      const tokensOf = (labels) => labels.reduce((n, l) => n + E.scopes[l].tokens, 0);
      assert.equal(a.unlinked.tokens, tokensOf(['S9', 'S11']));
      assert.equal(a.unattributed_overlap.tokens, tokensOf(['S1/A1', 'S4', 'S5', 'S8']));
      assert.equal(a.unattributed_overlap.multi_unit_calls, E.scopes['S1/A1'].calls.length);
      assert.equal(a.unattributed_overlap.low_only_calls, E.scopes.S4.calls.length + E.scopes.S5.calls.length + E.scopes.S8.calls.length);
      assert.equal(a.check, 'ok');
    } finally {
      db.close();
    }
  });

  it('widening: mode low keeps every mode-medium attribution, adds S5 to d1d, and prints widened calls', async () => {
    const { loadAttributionTotals } = await import('../../src/report/unit-cost.mjs');
    const rows = attrRows(ctx.home);
    const by = (mode) => new Map(rows.filter((r) => r.link_confidence === mode).map((r) => [scopeKey(r), r]));
    const medium = by('medium');
    const low = by('low');
    for (const [k, m] of medium) {
      if (m.bucket === 'attributed') assert.equal(low.get(k).unit_key, m.unit_key, k);
    }
    const callsOf = (mode) => new Set(queryDb(derivedOf(ctx.home), `
SELECT c.call_key FROM api_call c JOIN scope_attribution sa ON sa.session_id = c.owner_session_id AND sa.agent_id = c.owner_agent_id
 WHERE sa.link_confidence = ? AND sa.bucket = 'attributed' AND c.token_label = 'transcript'`, [mode]).map((r) => r.call_key));
    const lowCalls = callsOf('low');
    for (const c of callsOf('medium')) assert.ok(lowCalls.has(c), c);
    const db = new DatabaseSync(derivedOf(ctx.home), { readOnly: true });
    try {
      assert.equal(loadAttributionTotals(db, { mode: 'low' }).attributed.widened_calls, E.scopes.S5.calls.length + E.scopes.S8.calls.length);
      assert.equal(loadAttributionTotals(db, { mode: 'low' }).check, 'ok');
    } finally {
      db.close();
    }
  });

  it('the links: line follows the units: line with the hand-computed counts', () => {
    const lines = linesOf(text);
    // the last `units:` line is the reconstructed stratum's; its coverage line comes next, then links and attribution
    const unitsAt = lines.map((l, i) => (l.startsWith('units: ') ? i : -1)).filter((i) => i >= 0).pop() + 1;
    assert.ok(lines[unitsAt].startsWith('coverage: reconstructed '));
    assert.ok(lines[unitsAt + 1].startsWith('window: '), 'the window line follows the last coverage line');
    assert.ok(lines[unitsAt + 2].startsWith('  attribution unit is session + agent: '));
    const m = E.methodCounts;
    const c = E.counters;
    assert.equal(lines[unitsAt + 3], `links: whole store, both populations (not a stratum figure) scopes=${c.scopes} refs_unknown=0 tool-path=${m['tool-path']} `
      + `slash-command=${m['slash-command']} interval=${m.interval} lowered=${c.lowered} dir_name=${c.dir_name} `
      + `unmatched=${c.unmatched} ambiguous=${c.ambiguous} phase_dropped=${c.phase_dropped} slash_ambiguous=${c.slash_ambiguous} `
      + `no_interval_units=${c.no_interval_units} shared_end_units=${c.shared_end_units}`);
    assert.ok(lines[unitsAt + 4].startsWith('attribution: '));
    const state = queryDb(derivedOf(ctx.home), 'SELECT link_refs, link_refs_unmatched, link_refs_ambiguous FROM derive_state')[0];
    assert.deepEqual(state, { link_refs: c.refs, link_refs_unmatched: c.unmatched, link_refs_ambiguous: c.ambiguous });
  });

  it('the units table links column holds the hand-computed high/medium/low scope counts', () => {
    const lines = linesOf(text);
    const ids = { q1a: '261001-q1a', q2b: '261001-q2b', d1d: '261003-d1d', z9z: '261009-z9z', p1: '03-01', p2: '03-02', u1c: '261007-u1c' };
    for (const [k, id] of Object.entries(ids)) {
      const row = lines.find((l) => l.trim().split(/\s+/)[2] === id).trim().split(/\s+/);
      assert.equal(row[row.length - 3], E.linkCells[k], id);
    }
  });

  it('repo fallback: S12 (a Write link from outside any repo) takes alpha with rule unit-link, S8 (a low dir-name link) stays unresolved, cost --by repo shows S12 under alpha', () => {
    const calls = queryDb(derivedOf(ctx.home), "SELECT owner_session_id AS s, repo, repo_rule FROM api_call WHERE token_label = 'transcript' ORDER BY call_key");
    for (const c of calls) {
      const label = Object.entries(LINK_SESSIONS).find(([, v]) => v === c.s)[0];
      const want = {
        S12: ['alpha', 'unit-link'], S8: [null, 'none'], S6: ['beta', 'git'], S9: [null, 'none'], S11: [null, 'none'],
      }[label] ?? ['alpha', 'git'];
      assert.deepEqual([c.repo, c.repo_rule], want, label);
    }
    assert.equal(queryDb(derivedOf(ctx.home), 'SELECT repo_fallback_calls AS n FROM derive_state')[0].n, E.scopes.S12.calls.length);
    const r = cli(ctx.home, ['cost', '--by', 'repo', '--since', '2026-10-01', '--until', '2026-10-10']);
    assert.equal(r.status, 0, r.stderr);
    const alpha = linesOf(r.stdout).find((l) => l.startsWith('alpha ')).trim().split(/\s+/);
    const alphaInput = ['S1', 'S1/A1', 'S2', 'S2/A2', 'S3', 'S4', 'S5', 'S7', 'S10', 'S12'].reduce((n, l) => n + E.scopes[l].input, 0);
    assert.equal(Number(alpha[2]), alphaInput, 'alpha input includes S12 and not S8');
  });

  it('link evidence: S3 lists its phase-level tool-path ref, both modes and both intervals', () => {
    const id = linkId(E.units.p2, LINK_SESSIONS.S3, '');
    const r = cli(ctx.home, ['evidence', id]);
    assert.equal(r.status, 0, r.stderr);
    const lines = linesOf(r.stdout);
    assert.ok(lines.includes(`evidence: link ${id}`));
    assert.ok(lines.some((l) => l.startsWith('method tool-path/medium ') && l.includes('phase_level=yes')), r.stdout);
    assert.ok(lines.some((l) => /^ {2}ref message msg_link_s3_1 \S+ \.planning\/phases\/03-links\/03-CONTEXT\.md Read n=1$/.test(l)), r.stdout);
    assert.ok(lines.some((l) => l.startsWith('scope ') && l.includes('medium=attributed/one-unit') && l.includes('low=attributed/one-unit')), r.stdout);
    assert.ok(lines.some((l) => l.startsWith('scope ') && l.includes('first=2026-10-05T14:00:00.000Z')), r.stdout);
    assert.ok(lines.some((l) => l.startsWith('unit ') && l.includes('start=2026-10-05T13:00:00.000Z') && l.includes('end=2026-10-05T15:00:00.000Z')), r.stdout);
    assert.ok(!r.stdout.includes(ctx.home), 'no absolute path');
  });

  it('link evidence: S7 lists the slash-command row with the command name and its time; a subagent id resolves to that scope only', () => {
    const r = cli(ctx.home, ['evidence', linkId(E.units.q2b, LINK_SESSIONS.S7, '')]);
    assert.equal(r.status, 0, r.stderr);
    const lines = linesOf(r.stdout);
    assert.ok(lines.some((l) => l.startsWith('method slash-command/medium ')), r.stdout);
    assert.ok(lines.some((l) => l === `  command ${E.command.uuid} ${E.command.name} at ${E.command.ts}`), r.stdout);
    const sub = cli(ctx.home, ['evidence', linkId(E.units.q1a, LINK_SESSIONS.S1, LINK_SESSIONS.A1)]);
    assert.equal(sub.status, 0, sub.stderr);
    assert.ok(sub.stdout.includes('msg_link_s1a_1'));
    assert.ok(!sub.stdout.includes('msg_link_s1_1'), 'the main-thread scope is not listed');
    const none = cli(ctx.home, ['evidence', linkId(E.units.z9z, LINK_SESSIONS.S9, '')]);
    assert.equal(none.status, 0, none.stderr);
    assert.ok(/methods=0/.test(none.stdout), none.stdout);
  });

  it('link evidence totals equal the unit_link counts for every non-interval link of the fixture (review WR-02)', () => {
    const rows = queryDb(derivedOf(ctx.home), `SELECT session_id, agent_id, unit_key, method, refs, instants FROM unit_link
 WHERE method <> 'interval' ORDER BY session_id, agent_id, unit_key, method`);
    assert.equal(rows.length, E.links.filter((l) => l.method !== 'interval').length);
    for (const r of rows) {
      const j = cli(ctx.home, ['evidence', linkId(r.unit_key, r.session_id, r.agent_id), '--json']);
      assert.equal(j.status, 0, j.stderr);
      const t = JSON.parse(j.stdout).totals;
      if (r.method === 'tool-path') assert.equal(t.refs, r.refs, `${r.unit_key} ${r.session_id} ${r.agent_id}`);
      else assert.equal(t.commands + t.skills, r.instants, `${r.unit_key} ${r.session_id} ${r.agent_id}`);
    }
  });

  it('ordering: two units --json runs print byte-identical stdout', () => {
    const a = cli(ctx.home, ['units', '--json']).stdout;
    const b = cli(ctx.home, ['units', '--json']).stdout;
    assert.equal(a, b);
  });

  it('ordering: shuffled transcript lines and reversed file order give byte-equal link and attribution tables', () => {
    const other = makeHome();
    try {
      buildLinkHome({
        home: other.home, root: other.root, reverse: true, shuffleSeed: 7,
      });
      assert.equal(cli(other.home, ['ingest']).status, 0);
      assert.equal(cli(other.home, ['units']).status, 0);
      assert.equal(tableDigest(other.home), tableDigest(ctx.home));
    } finally {
      other.cleanup();
    }
  });
});

describe('refs unknown, adjacency and the empty case (02-07 Task 2)', () => {
  it('a scope whose file lost its head hash, or whose reread stopped mid-file (state reading), has refs unknown and keeps its known links', async () => {
    const ctx = makeHome();
    try {
      buildLinkHome({ home: ctx.home, root: ctx.root });
      assert.equal(cli(ctx.home, ['ingest']).status, 0);
      const w = new DatabaseSync(join(stateDirOf(ctx.home), 'store.db'));
      try {
        const files = 'SELECT file_id FROM cc_message_file WHERE session_id = ?';
        w.prepare(`UPDATE source_file SET head_hash = NULL WHERE file_id IN (${files})`).run(LINK_SESSIONS.S10);
        w.prepare(`UPDATE source_file SET state = 'reading' WHERE file_id IN (${files})`).run(LINK_SESSIONS.S11);
      } finally {
        w.close();
      }
      const { rebuildDerived } = await import('../../src/derive/rebuild.mjs');
      rebuildDerived({ home: ctx.home });
      const unknown = new Set([LINK_SESSIONS.S10, LINK_SESSIONS.S11]);
      for (const r of queryDb(derivedOf(ctx.home), 'SELECT session_id, refs_known FROM link_scope')) {
        assert.equal(r.refs_known, unknown.has(r.session_id) ? 0 : 1, r.session_id);
      }
      assert.deepEqual(attrRows(ctx.home), expectedAttribution((label) => (label === 'S10' || label === 'S11' ? 0 : 1)));
      const { loadAttributionTotals } = await import('../../src/report/unit-cost.mjs');
      const db = new DatabaseSync(derivedOf(ctx.home), { readOnly: true });
      try {
        const a = loadAttributionTotals(db, { mode: 'medium' });
        assert.equal(a.attributed.refs_unknown_calls, E.scopes.S10.calls.length);
        assert.equal(a.unlinked.refs_unknown_calls, E.scopes.S11.calls.length);
      } finally {
        db.close();
      }
      const t = cli(ctx.home, ['units']);
      assert.ok(linesOf(t.stdout).some((l) => l.startsWith('links: ') && l.includes(' refs_unknown=2 ')), t.stdout);
    } finally {
      ctx.cleanup();
    }
  });

  it("adjacency: S5's call exactly at d1d's end links it by interval; one millisecond later links nothing", async () => {
    const { ingestHome } = await import('../fixtures/build.mjs');
    const { rebuildDerived } = await import('../../src/derive/rebuild.mjs');
    for (const [ts, want] of [['2026-10-03T11:00:00.000Z', [[E.units.d1d, 'interval', 'low']]], ['2026-10-03T11:00:00.001Z', []]]) {
      const ctx = makeHome();
      try {
        buildLinkHome({ home: ctx.home, root: ctx.root, s5Ts: ts });
        await ingestHome(ctx.home, envOf(ctx.home));
        rebuildDerived({ home: ctx.home });
        const rows = queryDb(derivedOf(ctx.home), 'SELECT unit_key, method, confidence FROM unit_link WHERE session_id = ? ORDER BY unit_key, method', [LINK_SESSIONS.S5]);
        assert.deepEqual(rows.map((r) => [r.unit_key, r.method, r.confidence]), want, ts);
      } finally {
        ctx.cleanup();
      }
    }
  });

  it('a HOME with no units: no link, every main-section call unlinked no-link, zero counts on the links: line', async () => {
    const ctx = makeHome();
    try {
      const { buildTranscriptTree } = await import('../fixtures/build.mjs');
      buildTranscriptTree(ctx.root);
      assert.equal(cli(ctx.home, ['ingest']).status, 0);
      const t = cli(ctx.home, ['units']);
      assert.equal(queryDb(derivedOf(ctx.home), 'SELECT count(*) AS n FROM unit_link')[0].n, 0);
      const rows = queryDb(derivedOf(ctx.home), 'SELECT DISTINCT bucket, reason FROM scope_attribution');
      assert.deepEqual(rows, [{ bucket: 'unlinked', reason: 'no-link' }]);
      const n = queryDb(derivedOf(ctx.home), 'SELECT count(*) AS n FROM link_scope')[0].n;
      assert.ok(n > 0);
      assert.ok(linesOf(t.stdout).some((l) => l.startsWith(`links: whole store, both populations (not a stratum figure) scopes=${n} refs_unknown=0 tool-path=0/0/0 slash-command=0/0/0 interval=0/0/0 `)), t.stdout);
    } finally {
      ctx.cleanup();
    }
  });
});

// ---- Task 3: per-unit confounders, env fields and runtime ----------------------------------------------------------
const confRows = (home, unitKey, mode = 'medium') => queryDb(derivedOf(home), `
SELECT name, role, value, unknown_calls, source, label FROM unit_confounder
 WHERE unit_key = ? AND link_confidence = ? ORDER BY name, role`, [unitKey, mode]);
const confOf = (rows, name, role = '') => rows.find((r) => r.name === name && r.role === role);
const ENV_NAMES = ['gsd_version', 'base_sha', 'local_mods_head', 'hooks_sha', 'hook_events', 'model_default', 'advisor_model'];

describe('per-unit confounders and runtime (02-07 Task 3)', () => {
  let ctx;
  let doc;
  before(() => {
    ctx = makeHome();
    buildLinkHome({ home: ctx.home, root: ctx.root });
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
    const j = cli(ctx.home, ['units', '--json']);
    assert.equal(j.status, 0, j.stderr);
    doc = JSON.parse(j.stdout);
  });
  after(() => ctx.cleanup());

  it("q1a in mode medium: S1's model, effort and speed per role, its Claude Code version, inline with no worker", () => {
    const rows = confRows(ctx.home, E.units.q1a);
    assert.ok(rows.length > 0, 'q1a has confounder rows');
    const t = (name, role, value) => assert.deepEqual(confOf(rows, name, role), {
      name, role, value, unknown_calls: 0, source: 'transcript', label: 'transcript',
    }, `${name}/${role}`);
    t('model', 'main', JSON.stringify([E.models.main]));
    t('effort', 'main', '["high"]');
    t('speed', 'main', '["standard"]');
    t('cc_version', '', '["2.1.309"]');
    assert.equal(confOf(rows, 'model', E.roles.sub), undefined, 'the overlapping subagent scope is not attributed to q1a');
    const w = (name, value) => assert.deepEqual(confOf(rows, name), {
      name, role: '', value, unknown_calls: null, source: 'rule:worktree-cwd@1', label: 'reconstructed',
    }, name);
    w('worker_mode', 'inline');
    w('worker_count', '0');
    w('subagents', '0');
    assert.deepEqual(confOf(rows, 'repo'), {
      name: 'repo', role: '', value: 'alpha', unknown_calls: null, source: 'git-common-dir', label: 'reconstructed',
    });
    const size = queryDb(derivedOf(ctx.home), 'SELECT size_commits, size_files, size_added, size_deleted FROM unit WHERE unit_key = ?', [E.units.q1a])[0];
    assert.equal(confOf(rows, 'unit_size').value, JSON.stringify({
      commits: size.size_commits, files: size.size_files, added: size.size_added, deleted: size.size_deleted,
    }));
  });

  it('03-01: worktree mode (S2 ran in the worktree), two workers (one worktree session and one subagent scope), one subagent', () => {
    const rows = confRows(ctx.home, E.units.p1);
    assert.equal(confOf(rows, 'worker_mode').value, 'worktree');
    assert.equal(confOf(rows, 'worker_count').value, '2');
    assert.equal(confOf(rows, 'subagents').value, '1');
    assert.equal(confOf(rows, 'model', E.roles.sub).value, JSON.stringify([E.models.sub]));
    assert.equal(confOf(rows, 'model', 'main').value, JSON.stringify([E.models.main]));
  });

  it("u1c: every transcript row holds S6's values", () => {
    const rows = confRows(ctx.home, E.units.u1c);
    assert.equal(confOf(rows, 'effort', 'main').value, '["medium"]');
    assert.equal(confOf(rows, 'cc_version').value, '["2.1.400"]');
    assert.equal(confOf(rows, 'model', 'main').value, JSON.stringify([E.models.main]));
  });

  it('z9z (no attributed call in either mode): every transcript and worker row is NULL with source no-attributed-call', () => {
    for (const mode of ['medium', 'low']) {
      const rows = confRows(ctx.home, E.units.z9z, mode);
      for (const name of ['model', 'effort', 'speed', 'cc_version', 'worker_mode', 'worker_count', 'subagents']) {
        assert.deepEqual(confOf(rows, name), {
          name, role: '', value: null, unknown_calls: null, source: 'no-attributed-call', label: 'unavailable',
        }, `${mode} ${name}`);
      }
    }
  });

  it('runtime: claude-code from a high or medium link, else null and unavailable; units --json shows each confounder', () => {
    for (const u of doc.units) {
      if (u.key === E.units.z9z) assert.deepEqual(u.runtime, { value: null, source: null, label: 'unavailable' });
      else assert.deepEqual(u.runtime, { value: 'claude-code', source: 'rule:linked-transcript@1', label: 'reconstructed' }, u.key);
    }
    const q = doc.units.find((u) => u.key === E.units.q1a).confounders;
    assert.deepEqual(Object.keys(q), ['unit_size', 'model', 'effort', 'fast_mode', 'cc_version', 'worker', 'env']);
    assert.deepEqual(q.model.by_role.main, {
      value: [E.models.main], unknown_calls: 0, source: 'transcript', label: 'transcript',
    });
    assert.deepEqual(q.worker, {
      mode: 'inline', count: 0, subagents: 0, source: 'rule:worktree-cwd@1', label: 'reconstructed',
    });
    assert.deepEqual(Object.keys(q.env), ENV_NAMES);
  });

  it('env fields: the latest snapshot at or before the unit start; before the first snapshot every env field is NULL', async () => {
    const other = makeHome();
    try {
      buildLinkHome({ home: other.home, root: other.root });
      assert.equal(cli(other.home, ['ingest']).status, 0);
      const w = new DatabaseSync(join(stateDirOf(other.home), 'store.db'));
      try {
        const run = w.prepare("INSERT INTO ingest_run (run_id, started_utc, ended_utc, trigger) VALUES (?, ?, ?, 'test')");
        const snap = w.prepare(`INSERT INTO env_snapshot (run_id, taken_utc, gsd_version, gsd_version_source, local_mods_head)
          VALUES (?, ?, ?, 'version-file', ?)`);
        run.run(101, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:01.000Z');
        run.run(102, '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:01.000Z');
        snap.run(101, '2026-10-02T00:00:00.000Z', '9.9.1', 'a'.repeat(40));
        snap.run(102, '2026-10-06T00:00:00.000Z', '9.9.2', null);
      } finally {
        w.close();
      }
      const { rebuildDerived } = await import('../../src/derive/rebuild.mjs');
      rebuildDerived({ home: other.home });
      for (const name of ENV_NAMES) {
        assert.deepEqual(confOf(confRows(other.home, E.units.q1a), name), {
          name, role: '', value: null, unknown_calls: null, source: 'before-first-snapshot', label: 'unavailable',
        }, name);
      }
      assert.deepEqual(confOf(confRows(other.home, E.units.d1d), 'gsd_version'), {
        name: 'gsd_version', role: '', value: '9.9.1', unknown_calls: null, source: 'env-snapshot', label: 'reconstructed',
      });
      const u1c = confRows(other.home, E.units.u1c);
      assert.equal(confOf(u1c, 'gsd_version').value, '9.9.2');
      assert.deepEqual(confOf(u1c, 'local_mods_head'), {
        name: 'local_mods_head', role: '', value: null, unknown_calls: null, source: 'env-snapshot', label: 'unavailable',
      });
    } finally {
      other.cleanup();
    }
  });
});

// Plan 03.1-03 Task 2 (ADPT-05, D-19, R1 W4): ref linking through the former live path of an archived unit, and the
// reset-numbering rule. The pure rows call refTarget and scopeLinks; the end-to-end rows build a repo whose v1.0 phase dir
// `01-setup` is archived (unit 01-01 is chosen from the archive) while a v1.1 phase `01-auth` is live and holds a reused
// `01-01` plus `01-03`, and spawn the CLI over two transcripts.
describe('refs link a unit first seen archived through its former live path (plan 03.1-03)', () => {
  const links = () => import('../../src/derive/link-fill.mjs');
  const R1 = '~/r1/.git';
  const R2 = '~/r2/.git';
  const D = (day, hour = 0) => Date.UTC(2026, 0, day, hour);
  const mk = (repo, id, dir, start, end) => ({
    unit_key: `gsd-core:${repo}:plan:${id}`, repo_key: repo, kind: 'plan', native_id: id, dir_rel: dir, start_ms: start, end_ms: end,
    date_source: 'git', end_source: 'git', git_evidence: 1, commits_bounded: 1, interval_trusted: 1,
  });
  const ARCH = '.planning/milestones/v1.0-phases/01-setup';
  const U1 = mk(R1, '01-01', ARCH, D(1, 9), D(1, 12));
  const U3 = mk(R1, '01-03', '.planning/phases/01-auth', D(5, 8), D(5, 11));
  const ctx = (units = [U1, U3]) => ({ repoOfDir: new Map([['~/r1', R1], ['~/r2', R2], ['~/gone', null]]), units });
  const ref = (dir, rel, tool = 'Read', ts = D(1, 10)) => ({
    ref_dir: dir, rel_path: rel, ref_kind: 'phase', tool_name: tool, ts_ms: ts,
  });

  it('a ref carrying the live path links the archived unit directly, like a live unit', async () => {
    const { refTarget } = await links();
    assert.deepEqual(refTarget(ref('~/r1', '.planning/phases/01-setup/01-01-SUMMARY.md'), ctx()), { unitKey: U1.unit_key, direct: true, match: 'repo' });
    assert.deepEqual(refTarget(ref('~/r1', '.planning/phases/01-auth/01-03-PLAN.md'), ctx()), { unitKey: U3.unit_key, direct: true, match: 'repo' });
  });

  it('a phase-level ref of the live path names the unit through the former path, and scopeLinks links it medium', async () => {
    const { refTarget, scopeLinks } = await links();
    const r = ref('~/r1', '.planning/phases/01-setup/01-CONTEXT.md');
    assert.deepEqual(refTarget(r, ctx()), { phaseDir: { repoKey: R1, dirRel: '.planning/phases/01-setup' }, match: 'repo' });
    const out = scopeLinks({
      first_ms: D(1, 10), last_ms: D(1, 11), repos: [R1], refs: [r], instants: [],
    }, ctx());
    const tool = out.links.filter((l) => l.method === 'tool-path');
    assert.deepEqual(tool.map((l) => [l.unit_key, l.confidence, l.phase_level]), [[U1.unit_key, 'medium', 1]]);
  });

  it('the dir-name fallback finds an archived unit by its live path, capped low, and stays ambiguous across repos', async () => {
    const { refTarget } = await links();
    const rel = '.planning/phases/01-setup/01-01-PLAN.md';
    assert.deepEqual(refTarget(ref('~/gone', rel), ctx()), { unitKey: U1.unit_key, direct: true, match: 'dir-name' });
    const other = mk(R2, '01-01', ARCH, D(1, 9), D(1, 12));
    assert.deepEqual(refTarget(ref('~/gone', rel), ctx([U1, U3, other])), { miss: 'ambiguous' });
  });

  it('a reused plan id does not link to a sibling plan: the id belongs to a unit of the same repo in another dir (R1 W4)', async () => {
    const { refTarget, scopeLinks } = await links();
    const r = ref('~/r1', '.planning/phases/01-auth/01-01-PLAN.md', 'Edit', D(5, 9));
    assert.deepEqual(refTarget(r, ctx()), { miss: 'ambiguous' });
    const out = scopeLinks({
      first_ms: D(5, 9), last_ms: D(5, 10), repos: [R1], refs: [r], instants: [],
    }, ctx());
    assert.equal(out.counts.ambiguous, 1);
    assert.deepEqual(out.links.filter((l) => l.method === 'tool-path'), [], 'no tool-path link to the sibling 01-03');
  });

  it('a reused plan id found only by dir name does not link to a sibling plan either (review WR-02)', async () => {
    const { refTarget, scopeLinks } = await links();
    const r = ref('~/gone', '.planning/phases/01-auth/01-01-PLAN.md', 'Edit', D(5, 9));
    assert.deepEqual(refTarget(r, ctx()), { miss: 'ambiguous' }, 'the dir holds plans of one repo, and that repo holds 01-01 in another dir');
    const out = scopeLinks({
      first_ms: D(5, 9), last_ms: D(5, 10), repos: [R1], refs: [r], instants: [],
    }, ctx());
    assert.equal(out.counts.ambiguous, 1);
    assert.deepEqual(out.links.filter((l) => l.method === 'tool-path'), [], 'no low link to the sibling 01-03');
  });

  it('by dir name, an id held only by another repo (or by no unit) keeps the phase-level rule (review WR-02)', async () => {
    const { refTarget } = await links();
    const want = { phaseDir: { repoKey: R1, dirRel: '.planning/phases/01-auth' }, match: 'dir-name' };
    assert.deepEqual(refTarget(ref('~/gone', '.planning/phases/01-auth/01-09-PLAN.md'), ctx()), want);
    const elsewhere = mk(R2, '01-09', '.planning/phases/01-z', D(1, 9), D(1, 12));
    assert.deepEqual(refTarget(ref('~/gone', '.planning/phases/01-auth/01-09-PLAN.md'), ctx([U1, U3, elsewhere])), want);
  });

  it('a plan id that belongs to no unit of the repo keeps the phase-level rule, and so does an id held only by another repo', async () => {
    const { refTarget } = await links();
    const want = { phaseDir: { repoKey: R1, dirRel: '.planning/phases/01-auth' }, match: 'repo' };
    assert.deepEqual(refTarget(ref('~/r1', '.planning/phases/01-auth/01-09-PLAN.md'), ctx()), want);
    const elsewhere = mk(R2, '01-09', '.planning/phases/01-z', D(1, 9), D(1, 12));
    assert.deepEqual(refTarget(ref('~/r1', '.planning/phases/01-auth/01-09-PLAN.md'), ctx([U1, U3, elsewhere])), want);
  });
});

describe('the reset-numbering fixture end to end (plan 03.1-03, R1 W4)', () => {
  const T = {
    plan: '2026-01-01T09:00:00Z', code: '2026-01-01T12:00:00Z', archive: '2026-03-01T10:00:00Z', v11: '2026-10-05T08:00:00Z', auth: '2026-10-05T11:00:00Z',
  };
  let ctx;
  let doc;
  let derived;
  const key = (id) => `gsd-core:~/repos/reset/.git:plan:${id}`;
  before(() => {
    ctx = makeHome();
    const { home } = ctx;
    const repo = join(home, 'repos', 'reset');
    makeRepo(repo, { home, files: { 'README.md': 'reset\n' } });
    writePlanningDir(repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'A' }) } });
    commitAt(repo, { home, date: T.plan, message: 'chore: add planning' });
    writeFileAt(repo, 'src/old.mjs', 'export const old = 1;\n');
    commitAt(repo, { home, date: T.code, message: 'feat(01-01): v1.0 code' });
    archiveDir(repo, { home, name: '01-setup', label: 'v1.0' });
    commitAt(repo, { home, date: T.archive, message: 'chore: archive v1.0' });
    writePlanningDir(repo, {
      under: 'phases', name: '01-auth', files: { '01-01-PLAN.md': planText({ tier: 'C' }), '01-03-PLAN.md': planText({ tier: 'B' }) },
    });
    commitAt(repo, { home, date: T.v11, message: 'chore: start v1.1' });
    writeFileAt(repo, 'src/auth.mjs', 'export const auth = 1;\n');
    commitAt(repo, { home, date: T.auth, message: 'feat(01-03): auth' });
    const call = (session, ts, id, path, name) => {
      const line = makeAssistant({
        session,
        ts,
        id,
        model: 'claude-sonnet-5-5',
        cwd: repo,
        use: makeUsage({ input: 10, output: 20, read: 30, creation: 40, c5: 40, c1: 0 }),
        content: [{ type: 'tool_use', id: `toolu_${id}`, name, input: { file_path: path } }, { type: 'text', text: 'ok' }],
      });
      writeJsonl(join(ctx.root, 'projects', mangleHome(repo), `${session}.jsonl`), [JSON.stringify(line)]);
    };
    // SA: a v1.1 session edits the live 01-auth/01-01-PLAN.md at a time only 01-03 covers. SB: a v1.0-era session edits the
    // live path of the archived unit 01-01.
    call('1a000101-0000-4000-8000-000000000101', '2026-10-05T09:30:00.000Z', 'msg_reset_a', join(repo, '.planning/phases/01-auth/01-01-PLAN.md'), 'Edit');
    call('1a000102-0000-4000-8000-000000000102', '2026-01-01T10:00:00.000Z', 'msg_reset_b', join(repo, '.planning/phases/01-setup/01-01-PLAN.md'), 'Edit');
    const env = cliEnv(home, { TZ: 'UTC', RIGORSCOPE_NOW: '2026-11-01T00:00:00Z', RIGORSCOPE_REPO_ROOTS: repo });
    const ing = runCli(['ingest'], { home, env });
    assert.equal(ing.status, 0, ing.stderr);
    const j = runCli(['units', '--json'], { home, env });
    assert.equal(j.status, 0, j.stderr);
    doc = JSON.parse(j.stdout);
    derived = (sql, params = []) => queryDb(join(stateDirOf(home), 'derived.db'), sql, params);
  });
  after(() => ctx.cleanup());

  const unit = (id) => doc.units.find((u) => u.key === key(id));

  it('the units: 01-01 sits in the archive dir, 01-03 is live', () => {
    assert.equal(unit('01-01').dir, '.planning/milestones/v1.0-phases/01-setup');
    assert.equal(unit('01-03').dir, '.planning/phases/01-auth');
  });

  it('a ref carrying the live path links the unit first seen archived: tool-path, high (an Edit), one attributed call', () => {
    const u = unit('01-01');
    const tool = u.links.flatMap((l) => l.methods).filter((m) => m.method === 'tool-path');
    assert.deepEqual(tool.map((m) => [m.confidence, m.match]), [['high', 'repo']]);
    assert.equal(u.cost.calls, 1);
  });

  it('a reused plan id does not link to a sibling plan: the 01-03 unit gets no tool-path link and no cost from the reset session', () => {
    const u = unit('01-03');
    assert.deepEqual(u.links.flatMap((l) => l.methods).filter((m) => m.method === 'tool-path'), []);
    assert.equal(u.cost.calls, 0, 'the neighbour unit cost is not increased');
    assert.equal(derived('SELECT link_refs_ambiguous AS n FROM derive_state')[0].n, 1);
  });
});
