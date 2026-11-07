// Plan 03-04 review fix (HIGH-1, MEDIUM-1 to MEDIUM-3, LOW-2; D-15, D-17, D-24): the `units` report keeps its whole-store
// attribution and links lines apart from the strata (labeled), prints the window split by bucket since the first ledger line
// (forward-attributed, reconstructed-attributed, overlap, unlinked), says the attribution unit once, shows the instant the
// forward dollar share starts from, and says when a figure ignores the unit filters. Temporary HOMEs only. The tier fixture
// has 36 units with attributed calls; the forward unit is ga0 (calls 2026-10-02 08:00 and 08:05) with a ledger line at 08:02,
// so its first call is before the first ledger line and its second after. Expectations are counted from the fixture.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  cliEnv, ingestHome, makeHome, queryDb, runCli, stateDirOf,
} from '../fixtures/build.mjs';
import { STRATA_NOW, buildStrataHome, lineText } from '../fixtures/strata-home.mjs';
import { MODEL_M1, REPO_KEY as TIERS_REPO_KEY, TIER_SPEC } from '../fixtures/tier-home.mjs';

const CUTOFF = '2026-10-02T08:02:00.000Z';
const GA0 = TIER_SPEC.find((s) => s.id === 'ga0');
const COSTED = TIER_SPEC.filter((s) => s.costed).length;
const env = (home) => cliEnv(home, { TZ: 'UTC', RIGORSCOPE_NOW: STRATA_NOW });
const NOTE = 'attribution unit is session + agent: a main session that touched 2 or more units goes to overlap; no improvement is claimed for main sessions';
const WHOLE = 'whole store, both populations (not a stratum figure)';

describe('window split, whole-store labels and filters (03-04 review fix)', () => {
  let ctx;
  const cli = (args) => runCli(args, { home: ctx.home, env: env(ctx.home) });
  const json = (args = []) => {
    const r = cli(['units', '--json', ...args]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const text = (args = []) => {
    const r = cli(['units', ...args]);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n');
  };
  const derived = () => join(stateDirOf(ctx.home), 'derived.db');
  before(async () => {
    ctx = makeHome();
    buildStrataHome({
      home: ctx.home,
      root: ctx.root,
      base: 'tier',
      texts: [lineText({
        record: 'start', ts: CUTOFF, native_id: GA0.idFull, repo_key: TIERS_REPO_KEY, tier: 'C', tier_source: 'plan-at-start',
      })],
    });
    await ingestHome(ctx.home, env(ctx.home));
  });
  after(() => ctx.cleanup());

  it('the whole-store attribution and links lines carry the label, in every population selection', () => {
    for (const sel of [[], ['--population', 'forward'], ['--population', 'reconstructed']]) {
      const lines = text(sel);
      const attr = lines.filter((l) => l.startsWith('attribution: '));
      const links = lines.filter((l) => l.startsWith('links: '));
      assert.equal(attr.length, 1);
      assert.equal(links.length, 1);
      assert.ok(attr[0].startsWith(`attribution: ${WHOLE} link_confidence=medium section=main `), attr[0]);
      assert.ok(links[0].startsWith(`links: ${WHOLE} scopes=`), links[0]);
    }
    const doc = json(['--population', 'forward']);
    assert.equal(doc.attribution.scope, WHOLE);
    assert.equal(doc.links.scope, WHOLE);
    const tier = JSON.parse(cli(['tier', '--json', '--population', 'forward']).stdout);
    assert.equal(tier.attribution.scope, WHOLE);
    assert.ok(cli(['tier', '--population', 'forward']).stdout.split('\n').some((l) => l.startsWith(`attribution: ${WHOLE} `)));
  });

  it('window: calls since the first ledger line instant split by bucket, summing to the total, with the exact hand counts', () => {
    const w = json().window;
    assert.equal(w.since_utc, CUTOFF);
    const b = w.buckets;
    // ga0's 08:05 call only (its 08:00 call is before the cutoff); gb4 (2 calls, 10-01) and the low-only scope L (10-01) are before it.
    assert.equal(b.attributed_forward.calls, 1);
    assert.equal(b.attributed_reconstructed.calls, 2 * (COSTED - 1) - 2);
    assert.equal(b.unattributed_overlap.calls, 2, 'the two calls of the multi-unit scope O (10-03)');
    assert.equal(b.unlinked.calls, 1, 'the one call of the scope N (10-04)');
    assert.equal(w.total.calls, 1 + (2 * (COSTED - 1) - 2) + 2 + 1);
    assert.equal(Object.values(b).reduce((n, x) => n + x.calls, 0), w.total.calls);
    assert.equal(w.check.calls, 'ok');
    // the forward dollars are the 08:05 call alone, counted by a direct query on its instant (not through the attribution join)
    const [{ n }] = queryDb(derived(), `SELECT sum(p.cost_nano) AS n FROM api_call c JOIN api_call_part p ON p.call_key = c.call_key
      WHERE c.token_label = 'transcript' AND c.ts_utc = '2026-10-02T08:05:00.000Z' AND c.model = ?`, [MODEL_M1]);
    assert.ok(n > 0);
    assert.equal(b.attributed_forward.usd_nano, n);
    assert.equal(w.ignores_unit_filters, false);
    assert.equal(w.attribution_unit_note, NOTE);
  });

  it('window dollars: an unpriced model makes the reconstructed bucket and the total unknown (null, never a partial sum)', () => {
    const w = json().window;
    assert.equal(w.buckets.attributed_reconstructed.usd_nano, null);
    assert.equal(w.total.usd_nano, null);
    assert.equal(w.check.usd, 'unknown');
    const line = text().find((l) => l.startsWith('window: '));
    assert.match(line, /attributed_reconstructed=\d+\/\? /);
    assert.match(line, /total=\d+\/\? /);
  });

  it('window dollars with a model filter that drops the unpriced model: every bucket known and the buckets sum to the total', () => {
    const w = json(['--model', MODEL_M1]).window;
    const sum = Object.values(w.buckets).reduce((n, x) => n + x.usd_nano, 0);
    assert.ok(w.total.usd_nano > 0);
    assert.equal(sum, w.total.usd_nano);
    assert.deepEqual(w.check, { calls: 'ok', usd: 'ok' });
    assert.equal(w.total.calls, Object.values(w.buckets).reduce((n, x) => n + x.calls, 0));
    const line = text(['--model', MODEL_M1]).find((l) => l.startsWith('window: '));
    assert.ok(line.endsWith(' check=ok'), line);
  });

  it('the window line and the attribution-unit sentence print once, beside each other, whatever --population selects', () => {
    for (const sel of [[], ['--population', 'forward'], ['--population', 'reconstructed']]) {
      const lines = text(sel);
      const at = lines.findIndex((l) => l.startsWith('window: '));
      assert.ok(at >= 0);
      assert.equal(lines.filter((l) => l.startsWith('window: ')).length, 1);
      assert.match(lines[at], new RegExp(`^window: since ${CUTOFF.replaceAll('.', '\\.')} .* by bucket, not a stratum figure: attributed_forward=1/`));
      assert.equal(lines[at + 1], `  ${NOTE}`);
      assert.equal(lines.filter((l) => l.includes(NOTE)).length, 1);
    }
  });

  it('the forward coverage line says since <instant>, not a day, and its numerator and denominator are the window figures', () => {
    const f = text().find((l) => l.startsWith('coverage: forward '));
    assert.ok(f.includes(` since ${CUTOFF} `) || f.endsWith(` since ${CUTOFF}`), f);
    assert.ok(!/ from \d{4}-\d{2}-\d{2}/.test(f), f);
    const plain = json();
    assert.equal(plain.strata[0].coverage.attributed_usd_since_utc, CUTOFF);
    assert.deepEqual(plain.strata[0].coverage.attributed_usd_nano, { n: null, d: null }, 'an unpriced model makes the share unknown');
    const doc = json(['--model', MODEL_M1]);
    const cov = doc.strata[0].coverage;
    assert.equal(cov.attributed_usd_since_utc, CUTOFF);
    assert.equal(cov.attributed_usd_nano.n, doc.window.buckets.attributed_forward.usd_nano, 'numerator = forward-attributed dollars since the cutoff');
    assert.equal(cov.attributed_usd_nano.d, doc.window.total.usd_nano);
  });

  it('unit filters: the dollar shares, the window line and the baseline count ignore them and say so', () => {
    const plain = json();
    const filtered = json(['--tier', 'A']);
    assert.equal(filtered.strata[0].n, 0, 'the population n follows the filter (forward unit ga0 is tier C)');
    assert.equal(filtered.strata[0].coverage.attribution_baseline.forward_units, 1, 'the baseline count is the unfiltered forward count');
    assert.deepEqual(filtered.window.buckets, plain.window.buckets);
    assert.equal(filtered.window.since_utc, CUTOFF, 'the cutoff does not move with a unit filter');
    assert.equal(filtered.window.ignores_unit_filters, true);
    assert.deepEqual(filtered.strata[0].coverage.attributed_usd_nano, plain.strata[0].coverage.attributed_usd_nano);
    assert.equal(filtered.strata[0].coverage.dollars_ignore_unit_filters, true);
    assert.equal(plain.strata[0].coverage.dollars_ignore_unit_filters, false);
    const lines = text(['--tier', 'A']);
    assert.ok(lines.find((l) => l.startsWith('window: ')).includes('(ignores unit filters)'));
    const cov = lines.find((l) => l.startsWith('coverage: forward '));
    assert.ok(cov.includes('(ignores unit filters)'), cov);
    assert.match(cov, /tiered=0\/0 /, 'tiered follows the filter');
    assert.match(cov, /\(forward units 1 of 10/);
    assert.ok(!text().find((l) => l.startsWith('window: ')).includes('ignores unit filters'));
  });

  it('incomplete follows unit filters only: a call filter that matches no call of the started unit does not drop it', () => {
    const plain = json();
    assert.equal(plain.incomplete.n, 1);
    const withCallFilter = json(['--model', 'claude-sonnet-5-5']);
    assert.equal(withCallFilter.incomplete.n, 1, 'ga0 runs on the other model, yet it is still listed');
    assert.equal(withCallFilter.incomplete.listed.length, 1);
    const unitFilter = json(['--tier', 'A']);
    assert.equal(unitFilter.incomplete.n, 0, 'a unit filter still applies');
  });
});

describe('no ledger line: the window is unknown, the sentence still prints once (03-04 review fix)', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    buildStrataHome({ home: ctx.home, root: ctx.root, base: 'tier' });
    await ingestHome(ctx.home, env(ctx.home));
  });
  after(() => ctx.cleanup());
  it('prints window since none with ? buckets, and JSON since_utc null with null buckets', () => {
    const r = runCli(['units'], { home: ctx.home, env: env(ctx.home) });
    const lines = r.stdout.split('\n');
    const w = lines.find((l) => l.startsWith('window: '));
    assert.match(w, /^window: since none \(no ledger line yet\) .* by bucket, not a stratum figure: attributed_forward=\? attributed_reconstructed=\? unattributed_overlap=\? unlinked=\? total=\?/);
    assert.equal(lines.filter((l) => l.includes(NOTE)).length, 1);
    const doc = JSON.parse(runCli(['units', '--json'], { home: ctx.home, env: env(ctx.home) }).stdout);
    assert.equal(doc.window.since_utc, null);
    assert.equal(doc.window.buckets, null);
    assert.equal(doc.window.total, null);
    assert.equal(doc.window.attribution_unit_note, NOTE);
  });
});
