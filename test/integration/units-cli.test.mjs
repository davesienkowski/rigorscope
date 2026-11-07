// Plan 02-07 (RPT-01, D-19, D-02, D-13, CONTEXT Q2): the `units` filters, --link-confidence and --evidence, and unit
// evidence in mode low. Written before the code (RED). Every run spawns the CLI on a temporary HOME from makeHome()
// built by test/fixtures/link-home.mjs or test/fixtures/units-home.mjs, under a fixed clock and TZ=UTC.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  cliEnv, makeHome, runCli,
} from '../fixtures/build.mjs';
import { LINK_EXPECTED, LINK_SESSIONS, LINK_TIMES, buildLinkHome } from '../fixtures/link-home.mjs';
import { buildUnitsHome } from '../fixtures/units-home.mjs';

const E = LINK_EXPECTED;
const envOf = (home) => cliEnv(home, { TZ: 'UTC', RIGORSCOPE_NOW: LINK_TIMES.now });
const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const enc = (v) => {
  let out = '';
  for (const byte of new TextEncoder().encode(v)) {
    const ch = String.fromCharCode(byte);
    out += byte < 128 && /[A-Za-z0-9._:~-]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
};
const cli = (home, args) => runCli(args, { home, env: envOf(home) });
const json = (home, args) => {
  const r = cli(home, [...args, '--json']);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const ids = (doc) => doc.units.map((u) => u.native_id);

describe('units filters and flags on the link home (02-07 Task 3)', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildLinkHome({ home: ctx.home, root: ctx.root });
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
  });
  after(() => ctx.cleanup());

  it('--repo, --tier, --framework and --runtime select units', () => {
    assert.deepEqual(ids(json(ctx.home, ['units', '--repo', 'alpha'])), E.alphaIds);
    assert.deepEqual(ids(json(ctx.home, ['units', '--tier', 'A,?'])), ['261001-q1a', '261009-z9z', '261007-u1c']);
    assert.deepEqual(ids(json(ctx.home, ['units', '--tier', '?'])), ['261009-z9z']);
    assert.deepEqual(ids(json(ctx.home, ['units', '--framework', 'gsd-core'])), [...E.alphaIds, ...E.betaIds]);
    assert.deepEqual(ids(json(ctx.home, ['units', '--runtime', '?'])), ['261009-z9z']);
    assert.deepEqual(ids(json(ctx.home, ['units', '--runtime', 'claude-code'])).length, 6);
  });

  it('--role selects calls: a unit is listed when it has an attributed call of that role and its cost counts only those calls', () => {
    const doc = json(ctx.home, ['units', '--role', E.roles.sub]);
    assert.deepEqual(ids(doc), ['03-01']);
    const s = E.scopes['S2/A2'];
    assert.equal(doc.units[0].cost.calls, s.calls.length);
    assert.equal(doc.units[0].cost.tokens, s.tokens);
    const main = json(ctx.home, ['units', '--role', 'main']);
    assert.equal(main.units.find((u) => u.native_id === '03-01').cost.tokens, E.scopes.S2.tokens);
    assert.ok(!ids(main).includes('261009-z9z'));
    const a = main.attribution;
    assert.equal(a.attributed.calls + a.unattributed_overlap.calls + a.unlinked.calls, a.total.calls);
    assert.equal(a.check, 'ok');
    const t = cli(ctx.home, ['units', '--role', 'main']);
    const scope = linesOf(t.stdout).find((l) => l.startsWith('scope: '));
    assert.equal(scope, 'scope: link_confidence=medium unit_filters=none call_filters=role=main (cost columns count matching calls only)');
  });

  it('--model with a model no call has lists no unit', () => {
    const t = cli(ctx.home, ['units', '--model', 'claude-none-0-0']);
    assert.equal(t.status, 0, t.stderr);
    assert.ok(linesOf(t.stdout).includes('no units'));
  });

  it("--link-confidence low adds S5's and S8's cost to d1d (S12 is already there) and says widened on the scope line", () => {
    const doc = json(ctx.home, ['units', '--link-confidence', 'low']);
    assert.equal(doc.link_confidence, 'low');
    const d1d = doc.units.find((u) => u.native_id === '261003-d1d');
    assert.equal(d1d.cost.calls, E.scopes.S5.calls.length + E.scopes.S8.calls.length + E.scopes.S12.calls.length);
    assert.equal(d1d.cost.tokens, E.scopes.S5.tokens + E.scopes.S8.tokens + E.scopes.S12.tokens);
    assert.equal(d1d.cost.link_confidence, 'low');
    const t = cli(ctx.home, ['units', '--link-confidence', 'low']);
    const scope = linesOf(t.stdout).find((l) => l.startsWith('scope: '));
    assert.ok(scope.startsWith('scope: link_confidence=low unit_filters=none call_filters=none (widened'), scope);
    const attr = linesOf(t.stdout).find((l) => l.startsWith('attribution: '));
    assert.ok(attr.includes(` widened=${E.scopes.S5.calls.length + E.scopes.S8.calls.length} `), attr);
  });

  it('a bad value exits 2 before any state with one fixed line that never echoes the value; stdout stays empty', () => {
    const many = Array.from({ length: 17 }, (_, i) => `m${i}`).join(',');
    const bad = [['--tier', ''], ['--tier', 'A,A'], ['--model', many], ['--tier', 'Q;x'], ['--role', 'ab\u0001cd'],
      ['--link-confidence', 'high'], ['--framework', '?'], ['--tier', 'A,']];
    for (const [flag, value] of bad) {
      const r = cli(ctx.home, ['units', flag, value]);
      assert.equal(r.status, 2, `${flag} ${JSON.stringify(value)}`);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr.trim().split('\n').length, 1);
      if (value.length > 2) assert.ok(!r.stderr.includes(value), 'the value is never echoed');
    }
  });

  it('--json carries filters with ? as null and absent filters as null; two runs are byte-identical', () => {
    const doc = json(ctx.home, ['units', '--tier', 'A,?', '--role', 'main']);
    assert.deepEqual(doc.filters, { unit: { repo: null, tier: ['A', null], framework: null, runtime: null }, call: { model: null, role: ['main'] } });
    const a = cli(ctx.home, ['units', '--json', '--tier', 'A,?']).stdout;
    assert.equal(cli(ctx.home, ['units', '--json', '--tier', 'A,?']).stdout, a);
  });

  it('--evidence lists each unit id and its link ids after the summary lines', () => {
    const t = cli(ctx.home, ['units', '--evidence']);
    assert.equal(t.status, 0, t.stderr);
    const lines = linesOf(t.stdout);
    const at = lines.indexOf('evidence (links per unit; run rigorscope evidence ID for the calls):');
    assert.ok(at > 0 && lines.slice(0, at).some((l) => l.startsWith('labels: ')), 'after the summary lines');
    const q1a = `u:${enc(E.units.q1a)}`;
    const i = lines.indexOf(`  unit ${q1a}`);
    assert.ok(i > at, 'the q1a unit line');
    assert.ok(lines[i + 1].startsWith(`    link l:${enc(E.units.q1a)}/${enc(LINK_SESSIONS.S1)} `), lines[i + 1]);
  });

  it('evidence u: --link-confidence low lists the widened calls; with a row key or a link id it is a usage error', () => {
    const id = `u:${enc(E.units.d1d)}`;
    const low = cli(ctx.home, ['evidence', id, '--link-confidence', 'low']);
    assert.equal(low.status, 0, low.stderr);
    assert.ok(low.stdout.includes('call m:msg_link_s5_1'));
    assert.ok(!cli(ctx.home, ['evidence', id]).stdout.includes('call m:msg_link_s5_1'));
    assert.equal(cli(ctx.home, ['evidence', 'main/total', '--link-confidence', 'low']).status, 2);
    assert.equal(cli(ctx.home, ['evidence', `l:${enc(E.units.d1d)}/${enc(LINK_SESSIONS.S5)}`, '--link-confidence', 'low']).status, 2);
  });
});

describe('units --repo on two repos named alike (02-07 Task 3, CONTEXT Q2)', () => {
  let ctx;
  let all;
  before(() => {
    ctx = makeHome();
    buildUnitsHome({ home: ctx.home, root: ctx.root, sameName: true });
    assert.equal(cli(ctx.home, ['ingest']).status, 0);
    all = json(ctx.home, ['units']);
  });
  after(() => ctx.cleanup());
  const keysOf = (doc) => doc.units.map((u) => u.key);

  it('both proj repos have a unit and are displayed by their keys', () => {
    const displays = new Set(all.units.map((u) => u.repo.display));
    assert.ok(displays.has('~/a/proj/.git') && displays.has('~/b/proj/.git'));
  });

  it('every display selects at least one unit and only units with that display', () => {
    for (const display of new Set(all.units.map((u) => u.repo.display))) {
      const value = display.replace(/%/g, '%25').replace(/,/g, '%2C');
      const doc = json(ctx.home, ['units', '--repo', value]);
      assert.ok(doc.units.length >= 1, display);
      assert.ok(doc.units.every((u) => u.repo.display === display), display);
    }
  });

  it('a name selects both keys that carry it; a key, also as an absolute path under HOME, selects one', () => {
    const proj = all.units.filter((u) => u.repo.name === 'proj').map((u) => u.key);
    assert.equal(new Set(all.units.filter((u) => u.repo.name === 'proj').map((u) => u.repo.key)).size, 2);
    assert.deepEqual(keysOf(json(ctx.home, ['units', '--repo', 'proj'])), proj);
    const a = keysOf(json(ctx.home, ['units', '--repo', '~/a/proj/.git']));
    assert.ok(a.length >= 1 && a.every((k) => k.includes(':~/a/proj/.git:')));
    assert.deepEqual(keysOf(json(ctx.home, ['units', '--repo', `${ctx.home}/a/proj/.git`])), a);
  });

  it('? selects a NULL repo key, so it lists no unit', () => {
    const t = cli(ctx.home, ['units', '--repo', '?']);
    assert.equal(t.status, 0, t.stderr);
    assert.ok(linesOf(t.stdout).includes('no units'));
  });

  it('%2C inside a key stands for a comma; a bad escape, an over-long key and a control character exit 2 unechoed', () => {
    const doc = json(ctx.home, ['units', '--repo', '~/x%2Cy/.git']);
    assert.deepEqual(doc.filters.unit.repo, ['~/x,y/.git']);
    for (const value of ['~/x%zz', `~/${'k'.repeat(1030)}`, '~/a\u0002b']) {
      const r = cli(ctx.home, ['units', '--repo', value]);
      assert.equal(r.status, 2);
      assert.equal(r.stdout, '');
      assert.ok(!r.stderr.includes(value) && !r.stderr.includes('kkkk') && !r.stderr.includes('%zz'));
    }
  });
});
