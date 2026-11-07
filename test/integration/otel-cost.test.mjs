// The OTel join in the spawned `cost` report (plan 01-07, COST-02, COST-03, COST-05, COST-06, TRUST-01, TRUST-02,
// D-06, D-07, D-09, D-12). Written before the code (RED). Every expected value is hand-computed in
// test/fixtures/cases/97-otel-join.mjs (expectedJoin) or beside the case below, never by the code under test.
// Cells are selected by header name; a missing heading, column or footer line fails an assertion, never a
// TypeError. No planted value is ever printed in a failure message.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFixtureTree, cliEnv, isDataRow, makeHome, runCli, runCliAsync, sha256File, stateDirOf,
} from '../fixtures/build.mjs';
import { liveDirFor } from '../fixtures/otel.mjs';
import { Db } from '../../src/db.mjs';
import { OTEL_FILE, expectedJoin } from '../fixtures/cases/97-otel-join.mjs';

const J = expectedJoin;
const F = J.footer;
const DERIVED = (home) => join(stateDirOf(home), 'derived.db');
export const HEAD_OTEL = 'otel-only calls (no transcript row; role from query_source; tokens executor-only; cost measured by OTel):';
export const HEAD_HARNESS = 'harness calls (query_source is a harness source, never a role; tokens and cost from OTel):';
const COLS = ['role', 'model', 'calls', 'input', 'output', 'cache_read', 'cache_write', 'notional_usd'];

const cli = (home, args) => runCli(args, { home, env: cliEnv(home) });

// Splits the cost output into the table sections and the footer. The header is the first line holding both a
// calls and a notional_usd column; the body runs to the labels: line and is cut at the two heading lines.
function sections(stdout, names = COLS) {
  const lines = stdout.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const at = lines.findIndex((l) => { const t = l.trim().split(/\s+/); return t.includes('calls') && t.includes('notional_usd'); });
  const labelsAt = lines.findIndex((l) => l.startsWith('labels:'));
  const header = at >= 0 ? lines[at].trim().split(/\s+/) : [];
  const idx = names.map((n) => header.indexOf(n));
  const body = at >= 0 ? lines.slice(at + 1, labelsAt >= 0 ? labelsAt : undefined).filter(isDataRow) : []; // plan 01-08: no =total rows or totals check line
  const out = { lines, header, main: [], otel: [], harness: [], headings: [], footer: labelsAt >= 0 ? lines.slice(labelsAt) : [] };
  let cur = out.main;
  for (const l of body) {
    if (l === HEAD_OTEL) { out.headings.push('otel'); cur = out.otel; continue; }
    if (l === HEAD_HARNESS) { out.headings.push('harness'); cur = out.harness; continue; }
    const cells = l.trim().split(/\s+/);
    cur.push(idx.map((i) => (i >= 0 ? cells[i] : undefined)));
  }
  return out;
}
const lineStarting = (stdout, prefix) => stdout.split('\n').find((l) => l.startsWith(prefix)) ?? null;
// Footer line names in print order (labels (otel rows) keeps its whole prefix).
const footerNames = (footer) => footer.map((l) => (l.startsWith('labels (otel rows):') ? 'labels (otel rows)' : l.split(/[: ]/)[0]))
  .filter((n) => n !== '');

async function caseHome(cases = ['otel-join']) {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases });
  return ctx;
}

describe('cost --by role,model on case otel-join', () => {
  let ctx;
  let out;
  before(async () => {
    ctx = await caseHome();
    const ing = cli(ctx.home, ['ingest']);
    assert.equal(ing.status, 0);
    out = cli(ctx.home, ['cost', '--by', 'role,model']);
  });
  after(() => ctx.cleanup());

  it('tracer: cost --by role,model joins OTel on request_id, separates harness rows and prints the join and error-band lines', () => {
    assert.ok(out.stdout.split('\n').includes(HEAD_OTEL), 'the otel-only heading line is printed');
    assert.equal(out.status, 0);
    const s = sections(out.stdout);
    assert.deepEqual(s.main, J.mainRows, 'main rows (transcript-sourced calls)');
    assert.deepEqual(s.otel, J.otelRows, 'otel-only rows');
    assert.deepEqual(s.harness, J.harnessRows, 'harness rows');
    assert.equal(lineStarting(out.stdout, 'join:'), F.join);
    assert.equal(lineStarting(out.stdout, 'error-band:'), F.errorBand);
  });

  it('prints the main rows, then the otel-only heading and rows, then the harness heading and rows', () => {
    const s = sections(out.stdout);
    assert.deepEqual(s.headings, ['otel', 'harness'], 'each heading once, otel first');
    assert.equal(s.main.length, 6);
    assert.equal(s.otel.length, 4);
    assert.equal(s.harness.length, 2);
    for (const r of s.main) assert.ok(!r[0].startsWith('harness:'), 'no harness role in the main section');
    for (const r of s.otel) assert.ok(!r[0].startsWith('harness:'), 'no harness role in the otel section');
    for (const r of s.harness) assert.ok(r[0].startsWith('harness:'), 'only harness roles in the harness section');
  });

  it('every block uses the column widths of the whole table: each row line is as wide as its widest cell allows', () => {
    const lines = out.stdout.split('\n');
    const at = lines.findIndex((l) => l.trim().split(/\s+/).includes('notional_usd'));
    assert.ok(at >= 0, 'a header is printed');
    const end = lines.findIndex((l) => l.startsWith('labels:'));
    // Plan 01-08: each of the three blocks ends with an =total row, which is aligned like every other row.
    const rows = lines.slice(at + 1, end).filter((l) => l !== HEAD_OTEL && l !== HEAD_HARNESS && !l.startsWith('totals check:'));
    assert.equal(rows.length, 15);
    // The numeric columns are right-aligned to one width, so every row ends at the header's last column.
    for (const r of rows) assert.equal(r.length, lines[at].length, 'row width equals the header width');
  });

  it('keeps the labels: line unchanged and adds the labels (otel rows): line after it', () => {
    const lines = out.stdout.split('\n');
    const i = lines.indexOf(F.labels);
    assert.ok(i >= 0, 'the labels: line is unchanged');
    assert.equal(lines[i + 1], F.labelsOtel);
  });

  it('prints the join: line with every count and the three counted rates', () => {
    assert.equal(lineStarting(out.stdout, 'join:'), F.join);
  });

  it('prints the roles: line with the rule counts in precedence order', () => {
    assert.equal(lineStarting(out.stdout, 'roles:'), F.roles);
  });

  it('prints the otel-only: line with the OTel tokens and measured cost labeled otel and executor-only', () => {
    assert.equal(lineStarting(out.stdout, 'otel-only:'), F.otelOnly);
  });

  it('prints the crosscheck: line and one disagree line per transcript role and OTel name pair', () => {
    const lines = out.stdout.split('\n');
    const i = lines.indexOf(F.crosscheck);
    assert.ok(i >= 0, 'the crosscheck: line');
    assert.deepEqual(lines.slice(i + 1, i + 1 + F.disagree.length), F.disagree);
    assert.ok(lines[i + 1 + F.disagree.length].startsWith('error-band:'), 'error-band: follows the disagree lines');
  });

  it('prints the error-band: line on the joined set and the four non-zero outliers, largest error first', () => {
    const lines = out.stdout.split('\n');
    const i = lines.indexOf(F.errorBand);
    assert.ok(i >= 0, 'the error-band: line');
    assert.deepEqual(lines.slice(i + 1, i + 5), F.outliers);
    assert.ok(lines[i + 5].startsWith('rules:'), 'rules: follows the outlier lines');
  });

  it('prints the rules: line last with the harness sources and the sdk rule', () => {
    const lines = out.stdout.trimEnd().split('\n');
    assert.equal(lines[lines.length - 1], F.rules);
  });

  it('prints the footer lines in the fixed order', () => {
    const s = sections(out.stdout);
    const names = footerNames(s.footer.filter((l) => !l.startsWith('  ')));
    // Plan 01-08: scope: follows the labels lines (the default period is bounded).
    assert.deepEqual(names, J.footerOrder.flatMap((n) => (n === 'conservation' ? ['scope', n] : [n])));
  });

  it('counts, totals, pricing and notional describe the transcript calls only, as before the join', () => {
    assert.equal(lineStarting(out.stdout, 'counts:'), F.counts);
    assert.equal(lineStarting(out.stdout, 'totals:'), F.totals);
    const pricing = lineStarting(out.stdout, 'pricing:') ?? '';
    assert.equal(Number(/ priced_parts=(\d+)/.exec(pricing)?.[1]), F.pricingParts.priced_parts);
    assert.equal(Number(/ unpriced_parts=(\d+)/.exec(pricing)?.[1]), F.pricingParts.unpriced_parts);
    assert.match(pricing, / cost_conservation=OK$/);
    assert.equal(lineStarting(out.stdout, 'notional:'), F.notional);
  });

  it('the window: line counts the OTel-only parts too (17 parts, none in a window)', () => {
    assert.equal(lineStarting(out.stdout, 'window:'), F.window);
  });

  it('prints conservation: OK over the three sections', () => {
    assert.equal(lineStarting(out.stdout, 'conservation:'), F.conservation);
  });

  it('two parallel cost runs print identical output and leave derived.db unchanged; stderr stays empty', async () => {
    const before = sha256File(DERIVED(ctx.home));
    const [a, b] = await Promise.all([
      runCliAsync(['cost', '--by', 'role,model'], { home: ctx.home }),
      runCliAsync(['cost', '--by', 'role,model'], { home: ctx.home }),
    ]);
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    assert.equal(a.stdout, b.stdout);
    assert.equal(a.stdout.split('\n').slice(1).join('\n'), out.stdout.split('\n').slice(1).join('\n'), 'same report as the first run');
    assert.equal(a.stderr, '');
    assert.equal(out.stderr, '');
    assert.equal(sha256File(DERIVED(ctx.home)), before);
  });

  it('--by model groups each section by model with the hand-computed rows', () => {
    const r = cli(ctx.home, ['cost', '--by', 'model']);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    const cols = ['model', 'calls', 'input', 'output', 'cache_read', 'cache_write', 'notional_usd'];
    const s = sections(r.stdout, cols);
    assert.deepEqual(s.main, [
      ['claude-haiku-5-5', '5', '1090', '260', '5000', '0', '0.000289'], //  B D F G H: 1000+50+10+20+10, 200+20+10+20+10; 250,000+15,000+6,000+12,000+6,000
      ['claude-opus-5-5', '1', '100', '10', '0', '0', '0.000600'], //        A
      ['claude-sonnet-5-5', '2', '210', '60', '1000', '400', '0.002120'], // C E: 2,000,000 + 120,000
    ]);
    assert.deepEqual(s.otel, [
      ['claude-haiku-5-5', '3', '115', '115', '200', '0', '0.000071'], //   O5 O8 O9: 100+5+10, 100+5+10; 62,000+3,000+6,000
      ['claude-opus-5-5', '1', '20', '30', '0', '0', '0.000680'], //        O6
      ['claude-sonnet-5-5', '3', '47', '17', '0', '0', '0.000264'], //      O4 O7 O10
    ]);
    assert.deepEqual(s.harness, [['claude-haiku-5-5', '2', '310', '105', '0', '0', '0.000084']]); // O1 + O2: 80,000 + 4,000
  });

  it('--by role groups each section by role with the hand-computed rows', () => {
    const r = cli(ctx.home, ['cost', '--by', 'role']);
    assert.equal(r.status, 0);
    const cols = ['role', 'calls', 'input', 'output', 'cache_read', 'cache_write', 'notional_usd'];
    const s = sections(r.stdout, cols);
    assert.deepEqual(s.main, [
      ['Explore', '1', '1000', '200', '5000', '0', '0.000250'],
      ['claude-code-guide', '1', '50', '20', '0', '0', '0.000015'],
      ['fork', '1', '200', '50', '1000', '400', '0.002000'],
      ['gsd-executor', '1', '10', '10', '0', '0', '0.000120'],
      ['main', '4', '140', '50', '0', '0', '0.000624'], // A F G H: 100+10+20+10, 10+10+20+10; 600,000+6,000+12,000+6,000
    ]);
    assert.deepEqual(s.otel, [
      ['Explore', '1', '100', '100', '200', '0', '0.000062'],
      ['main', '3', '35', '45', '0', '0', '0.000689'], // O6 O8 O9: 20+5+10, 30+5+10; 680,000+3,000+6,000
      ['unknown', '3', '47', '17', '0', '0', '0.000264'],
    ]);
    assert.deepEqual(s.harness, J.harnessRows.map((row) => [row[0], ...row.slice(2)]));
  });

  it('a tampered transcript part prints conservation: VIOLATED naming the class with sections=, and the exit status stays 0', () => {
    const w = new Db(DERIVED(ctx.home));
    try {
      w.exec("UPDATE api_call_part SET output_tokens = output_tokens + 1 WHERE call_key = 'm:msg_oj_f'");
    } finally {
      w.close();
    }
    const r = cli(ctx.home, ['cost', '--by', 'role,model']);
    assert.equal(r.status, 0);
    const line = lineStarting(r.stdout, 'conservation:') ?? '';
    assert.match(line, /^conservation: VIOLATED output\(/);
    assert.match(line, /output\([^)]* sections=\d+\)/);
  });
});

describe('cost with only one of the two sources', () => {
  it('a HOME with transcripts and no OTel prints the short join: line, the roles: line, and no heading or OTel line', async () => {
    const ctx = await caseHome(['subagents']);
    try {
      assert.equal(cli(ctx.home, ['ingest']).status, 0);
      const r = cli(ctx.home, ['cost', '--by', 'role,model']);
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      // case subagents: four calls (msg_m31 to msg_m34)
      assert.equal(lineStarting(r.stdout, 'join:'), 'join: otel_requests=0 transcript_calls=4');
      assert.equal(lineStarting(r.stdout, 'roles:'),
        'roles: harness=0 attribution=2 meta=0 transcript_main=2 query_source=0 query_source_main=0 unknown=0 '
        + 'conflict_attr_meta=0 conflict_query_source=0 harness_joined=0');
      for (const p of ['otel-only:', 'crosscheck:', 'error-band:', 'rules:', 'labels (otel rows):']) {
        assert.equal(lineStarting(r.stdout, p), null, `no ${p} line`);
      }
      const lines = r.stdout.split('\n');
      assert.ok(!lines.includes(HEAD_OTEL) && !lines.includes(HEAD_HARNESS), 'no heading');
      const names = footerNames(sections(r.stdout).footer);
      assert.deepEqual(names, ['labels', 'scope', 'conservation', 'counts', 'totals', 'pricing', 'notional', 'window', 'join', 'roles']);
    } finally {
      ctx.cleanup();
    }
  });

  it('a HOME with OTel and no transcripts prints the header, both headings and their rows, exit 0', async () => {
    const ctx = await caseHome();
    try {
      rmSync(join(ctx.root, 'projects'), { recursive: true, force: true });
      assert.equal(cli(ctx.home, ['ingest']).status, 0);
      const r = cli(ctx.home, ['cost', '--by', 'role,model']);
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      const s = sections(r.stdout);
      assert.ok(s.header.includes('notional_usd'), 'a header is printed');
      assert.deepEqual(s.main, [], 'no transcript row');
      assert.deepEqual(s.headings, ['otel', 'harness']);
      // All 15 requests are OTel-only now: the six formerly joined ones join the otel block.
      //   Explore haiku: oB + O5 (2 calls, 1000+100, 200+100, 5000+200; 250,000+62,000)
      //   claude-code-guide haiku: oD (15,600); main haiku: O8 O9 (2); main opus: oA (owner, 600,000) + O6 (680,000)
      //   unknown haiku: oG (sdk, 12,100); unknown sonnet: oE (agent:custom, 125,000) + O4 O7 O10;
      //   general-purpose sonnet: oC (2,100,000)
      assert.deepEqual(s.otel, [
        ['Explore', 'claude-haiku-5-5', '2', '1100', '300', '5200', '0', '0.000312'],
        ['claude-code-guide', 'claude-haiku-5-5', '1', '50', '20', '0', '0', '0.000016'],
        ['general-purpose', 'claude-sonnet-5-5', '1', '200', '50', '1000', '400', '0.002100'],
        ['main', 'claude-haiku-5-5', '2', '15', '15', '0', '0', '0.000009'],
        ['main', 'claude-opus-5-5', '2', '120', '40', '0', '0', '0.001280'],
        ['unknown', 'claude-haiku-5-5', '1', '20', '20', '0', '0', '0.000012'],
        ['unknown', 'claude-sonnet-5-5', '4', '57', '27', '0', '0', '0.000389'], // 10+40+2+5, 10+10+2+5; 125,000+180,000+24,000+60,000
      ]);
      assert.deepEqual(s.harness, J.harnessRows);
      assert.match(lineStarting(r.stdout, 'join:') ?? '', /^join: otel_requests=15 joined=0 raw=0\/15 \(0\.00%\) joinable=0\/13 \(0\.00%\) excl_sdk=0\/10 \(0\.00%\) transcript_calls=0 /);
      assert.match(lineStarting(r.stdout, 'error-band:') ?? '', /^error-band: joined n=0 median_abs_err=\? p99_abs_err=\? max_abs_err=\? sum_derived=\? sum_measured=\? diff=\? \(\?\) /);
    } finally {
      ctx.cleanup();
    }
  });

  it('removing the OTel file after a joined build and re-ingesting keeps the OTel rows (the store keeps them)', async () => {
    const ctx = await caseHome();
    try {
      assert.equal(cli(ctx.home, ['ingest']).status, 0);
      const first = cli(ctx.home, ['cost', '--by', 'role,model']);
      rmSync(join(liveDirFor(ctx.home), OTEL_FILE));
      assert.ok(!existsSync(join(liveDirFor(ctx.home), OTEL_FILE)));
      assert.equal(cli(ctx.home, ['ingest']).status, 0);
      const second = cli(ctx.home, ['cost', '--by', 'role,model']);
      assert.equal(second.status, 0);
      assert.deepEqual(sections(second.stdout).otel, sections(first.stdout).otel);
      assert.equal(lineStarting(second.stdout, 'join:'), F.join);
      assert.ok(readFileSync(DERIVED(ctx.home)).length > 0);
    } finally {
      ctx.cleanup();
    }
  });
});
