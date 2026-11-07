// `cost --by effort` prints an advisor part under effort `?` (an advisor iteration carries no effort of its own),
// while a message part keeps the effort of its call. Fixture: case `iterations` (test/fixtures/cases/30-iterations.mjs),
// where every line has effort high, msg_m41 has a message part (opus) and an advisor part (fable), msg_m42 only a
// message part (sonnet). Expected figures are hand-computed from that case: m41 message 100/40/1000/50, advisor
// 30/20/0/0, m42 9/9/9/9, so the high row is 109/49/1009/59 over 2 calls and the `?` row 30/20/0/0 over 1 call.
// The advisor model (fable) has no table price, so the `?` row's dollars are unknown; the high row is opus + sonnet.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildFixtureTree, isDataRow, makeHome, runCli } from '../fixtures/build.mjs';
import { buildRowKey } from '../../src/measure/rowkey.mjs';

// The table rows: the lines after the header (which follows the optional window usage line) up to labels:.
function split(stdout) {
  const lines = stdout.split('\n');
  const p0 = lines.findIndex((l) => l.startsWith('period:'));
  const w = lines[p0 + 1].startsWith('window usage:') ? 1 : 0;
  const labelsAt = lines.findIndex((l) => l.startsWith('labels:'));
  return lines.slice(p0 + 2 + w, labelsAt).filter(isDataRow).map((l) => l.trim().split(/\s+/));
}
const NUMS = (calls, i, o, r, w, usd) => [calls, i, o, r, w, usd, '?', '?'];
let ctx;

before(async () => {
  ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['iterations'] });
  assert.equal(runCli(['ingest'], { home: ctx.home }).status, 0);
});
after(() => ctx.cleanup());

const cost = (...args) => {
  const r = runCli(['cost', ...args], { home: ctx.home });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

describe('cost --by effort with an advisor part', () => {
  it('prints the advisor tokens under effort ? and the message tokens under the call effort', () => {
    const rows = split(cost('--by', 'effort'));
    assert.deepEqual(rows, [
      ['high', ...NUMS('2', '109', '49', '1009', '59', '>=0.001781')],
      ['?', ...NUMS('1', '30', '20', '0', '0', '?')],
    ]);
  });

  it('keeps conservation and the totals check green and the total row equal to the rows', () => {
    const out = cost('--by', 'effort');
    assert.match(out, /^conservation: OK /m);
    assert.match(out, /^totals check: .*\bOK\b/m, out);
    assert.doesNotMatch(out, /VIOLATED|MISMATCH/);
    assert.match(out, /^totals: input=139 output=69 cache_read=1009 cache_write=59 /m);
  });

  it('splits by role and model as well: the advisor part is the ? effort row on the advisor model', () => {
    assert.deepEqual(split(cost('--by', 'role,effort')), [
      ['main', 'high', ...NUMS('2', '109', '49', '1009', '59', '>=0.001781')],
      ['main', '?', ...NUMS('1', '30', '20', '0', '0', '?')],
    ]);
    assert.deepEqual(split(cost('--by', 'effort,model')), [
      ['high', 'claude-opus-5-5', ...NUMS('1', '100', '40', '1000', '50', '0.001650')],
      ['high', 'claude-sonnet-5-5', ...NUMS('1', '9', '9', '9', '9', '>=0.000131')],
      ['?', 'claude-fable-5-0', ...NUMS('1', '30', '20', '0', '0', '?')],
    ]);
  });

  it('--json prints the same value: a null effort on the advisor row', () => {
    const doc = JSON.parse(cost('--by', 'effort', '--json'));
    const rows = doc.sections.main.rows;
    assert.deepEqual(rows.map((r) => [r.dims.effort.value, r.calls]), [['high', 2], [null, 1]]);
    assert.equal(rows[1].input.value, 30);
    assert.equal(rows[1].output.value, 20);
  });

  it('evidence of the effort=? row selects the call with the advisor part, with and without a call-level dimension', () => {
    const ev = (key) => {
      const r = runCli(['evidence', key, '--json'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const unknown = ev(buildRowKey('main', [['effort', null]]));
    assert.deepEqual([unknown.calls, unknown.items.map((i) => i.message_id)], [1, ['msg_m41']]);
    const withRole = ev(buildRowKey('main', [['role', 'main'], ['effort', null]]));
    assert.deepEqual([withRole.calls, withRole.items.map((i) => i.message_id)], [1, ['msg_m41']]);
    const high = ev(buildRowKey('main', [['effort', 'high']]));
    assert.deepEqual(high.items.map((i) => i.message_id).sort(), ['msg_m41', 'msg_m42']);
  });
});
