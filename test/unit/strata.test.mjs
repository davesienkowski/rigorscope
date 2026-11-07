// Plan 03-04 (LEDG-03, LEDG-05, LEDG-08, D-14 to D-17): the pure per-population figures and their text. Units are stubs in the
// shape of src/report/units.mjs toUnit; every expectation is computed by hand.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASELINE_MIN_FORWARD, INCOMPLETE_LIST_CAP, coverageShares, incompleteList, stratumSummary, unrecordedShare, windowSplit,
} from '../../src/report/strata.mjs';
import { ageText, coverageLine, unrecordedLine, windowLines } from '../../src/report/render-text.mjs';
import { FORBIDDEN_WORDS } from '../prohibitions/no-score.test.mjs';

const NOW = Date.parse('2026-11-01T00:00:00Z');
const unit = (over = {}) => ({
  key: 'k', kind: 'quick', nativeId: 'n', repo: { key: 'r', display: 'alpha' }, population: 'reconstructed',
  tier: { value: null, signal: 'none', timing: null, comparable: false, conflict: false },
  cost: { calls: 0, tokens: null }, ledger: null, recordedAtUtc: null, hasRecon: true, reconStartMs: null, present: true,
  risk: { value: null }, gitEvidence: false, commitsBounded: null, endSource: 'git', ...over,
});
const fwd = (id, at, over = {}) => unit({
  key: `k-${id}`, nativeId: id, population: 'forward', recordedAtUtc: at, hasRecon: false,
  ledger: { lines: 1, status: 'incomplete' }, ...over,
});

describe('stratumSummary', () => {
  it('an empty stratum is n 0 costed 0 and low evidence, never omitted', () => {
    const s = stratumSummary([]);
    assert.deepEqual([s.n, s.costed, s.low_evidence, s.min_n], [0, 0, true, 10]);
    assert.equal(s.counts.units, 0);
  });
  it('costed is an attributed call and known tokens; ten costed units are not low evidence', () => {
    const costed = (i) => unit({ key: `c${i}`, cost: { calls: 2, tokens: 100 } });
    assert.equal(stratumSummary(Array.from({ length: 9 }, (_, i) => costed(i))).low_evidence, true);
    assert.equal(stratumSummary(Array.from({ length: 10 }, (_, i) => costed(i))).low_evidence, false);
    assert.equal(stratumSummary([unit({ cost: { calls: 2, tokens: null } })]).costed, 0, 'unknown tokens are not costed');
  });
  it('declared_at_close counts only a forward unit with a ledger tier declared at the close and keeps it in n', () => {
    const closeUnit = fwd('a', '2026-10-30T00:00:00Z', { tier: { value: 'B', signal: 'ledger', timing: 'declared-at-close', comparable: false } });
    const reconClose = unit({ tier: { value: 'A', signal: 'frontmatter', timing: 'declared-at-close', comparable: true } });
    const s = stratumSummary([closeUnit, reconClose]);
    assert.equal(s.n, 2);
    assert.deepEqual(s.declared_at_close, { n: 1, A: 0, B: 1, C: 0, '?': 0 });
  });
});

describe('incompleteList', () => {
  it('incomplete is listed and counted: oldest first, 20 rows at most, the rest counted; reconstructed and closed units are not listed', () => {
    const many = Array.from({ length: 21 }, (_, i) => fwd(`id${String(i).padStart(2, '0')}`, new Date(NOW - (i + 1) * 3600000 * 5).toISOString()));
    const closed = fwd('closed', '2026-10-01T00:00:00Z', { ledger: { lines: 2, status: 'complete' } });
    const recon = unit({ nativeId: 'recon' });
    const inc = incompleteList([...many, closed, recon], NOW);
    assert.equal(inc.n, 21);
    assert.equal(inc.listed.length, INCOMPLETE_LIST_CAP);
    assert.equal(inc.omitted, 1);
    assert.equal(inc.listed[0].id, 'id20', 'oldest first');
    assert.equal(inc.listed[0].age_ms, 21 * 5 * 3600000);
    assert.ok(inc.listed.every((r) => r.id !== 'closed' && r.id !== 'recon'));
    assert.deepEqual(Object.keys(inc.listed[0]), ['repo', 'kind', 'id', 'age_ms'], 'repo, kind, id and age only');
    assert.equal(inc.oldest_age_ms, 21 * 5 * 3600000);
  });
  it('an unknown time gives an unknown age, and ageText prints d/h, <1h and ?', () => {
    const inc = incompleteList([fwd('x', null)], NOW);
    assert.equal(inc.listed[0].age_ms, null);
    assert.equal(inc.oldest_age_ms, null);
    assert.equal(ageText(null), '?');
    assert.equal(ageText(59 * 60000), '<1h');
    assert.equal(ageText(2 * 86400000 + 5 * 3600000 + 59 * 60000), '2d5h');
  });
});

describe('unrecordedShare', () => {
  const recon = (id, startIso, over = {}) => unit({ key: `r-${id}`, nativeId: id, reconStartMs: startIso === null ? null : Date.parse(startIso), ...over });
  const line = (id, at) => fwd(id, at, { hasRecon: true, reconStartMs: Date.parse(at) - 60000 });
  it('unrecorded excludes pre-cutoff: units first seen before the cutoff day, ledger-only units and unknown first-seen are out of n', () => {
    const units = [
      line('l1', '2026-10-29T12:00:00Z'),
      recon('on1', '2026-10-29T00:00:00Z'), recon('on2', '2026-10-30T10:00:00Z'), recon('on3', '2026-10-31T10:00:00Z'),
      recon('pre', '2026-10-28T23:59:59Z'),
      recon('unk', null),
      fwd('ledgeronly', '2026-10-30T00:00:00Z'),
    ];
    const u = unrecordedShare(units, { tz: 'UTC' });
    assert.deepEqual(u, { cutoff_day: '2026-10-29', n: 4, k: 3, first_seen_unknown: 1 });
    assert.match(unrecordedLine(u), /^unrecorded: 3\/4 \(75\.00%\) cutoff_day=2026-10-29 n=4 first_seen_unknown=1 /);
  });
  it('with no ledger line the share is ? and the cutoff is none', () => {
    const u = unrecordedShare([recon('a', '2026-10-29T00:00:00Z')], { tz: 'UTC' });
    assert.deepEqual(u, { cutoff_day: null, n: 0, k: 0, first_seen_unknown: 0 });
    assert.match(unrecordedLine(u), /^unrecorded: \? cutoff_day=none n=0 /);
  });
  it('the day compare uses the report zone across a DST change (America/Los_Angeles, fall back on 2026-11-01)', () => {
    const cutoff = line('l', '2026-11-01T08:30:00Z'); // 01:30 PDT on 11-01
    const units = [
      cutoff,
      recon('late', '2026-11-02T07:30:00Z'), // 23:30 PST on 11-01: the cutoff day
      recon('early', '2026-11-01T07:00:00Z'), // 00:00 PDT on 11-01: the cutoff day
      recon('before', '2026-11-01T06:59:59Z'), // 23:59 PDT on 10-31: before
    ];
    const la = unrecordedShare(units, { tz: 'America/Los_Angeles' });
    assert.deepEqual([la.cutoff_day, la.n], ['2026-11-01', 3]);
    const utc = unrecordedShare(units, { tz: 'UTC' });
    assert.deepEqual([utc.cutoff_day, utc.n], ['2026-11-01', 4], 'in UTC the "before" unit is also on 11-01, so the zone changes the count');
    assert.equal(la.n - la.k, 1, 'only the line unit has a ledger line');
  });
});

describe('coverage', () => {
  const fixedUnits = (n, over = {}) => Array.from({ length: n }, (_, i) => fwd(`f${i}`, '2026-10-30T00:00:00Z', {
    tier: { value: 'C', signal: 'ledger', timing: 'declared-at-start', comparable: true }, ...over,
  }));
  it('unknown is a question mark: a zero denominator and a NULL dollar sum print ?, never 0 or a percent', () => {
    const empty = coverageShares('forward', [], { attributed_nano: null, total_nano: null, since_ms: null });
    const text = coverageLine(empty, 'UTC');
    assert.match(text, /^coverage: forward tiered=0\/0 \(\?\) target 90% comparable_source=0\/0 \(\?\) attributed_usd=\? /);
    const known = coverageShares('reconstructed', [unit()], { attributed_nano: 5e9, total_nano: 0, since_ms: null });
    assert.match(coverageLine(known, 'UTC'), /attributed_usd=5\.000000\/0\.000000 \(\?\)/);
  });
  it('the forward attribution target is baseline pending under 10 forward units and none set at 10; no verdict word ever', () => {
    const nine = coverageLine(coverageShares('forward', fixedUnits(9), { attributed_nano: 1e9, total_nano: 4e9, since_ms: null }), 'UTC');
    assert.match(nine, /attribution target baseline pending \(forward units 9 of 10\)$/);
    const ten = coverageLine(coverageShares('forward', fixedUnits(BASELINE_MIN_FORWARD), { attributed_nano: 1e9, total_nano: 4e9, since_ms: null }), 'UTC');
    assert.match(ten, /attribution target none set$/);
    assert.match(ten, /attributed_usd=1\.000000\/4\.000000 \(25\.00%\)/);
    for (const text of [nine, ten, coverageLine(coverageShares('reconstructed', [unit()], null), 'UTC')]) {
      for (const w of text.toLowerCase().split(/[^a-z]+/)) assert.ok(!FORBIDDEN_WORDS.includes(w), `${w} in ${text}`);
      assert.ok(!/\bmet\b|\bmissed\b|\bnot met\b/.test(text));
    }
  });
  it('the comparable-source share is on the forward line only', () => {
    assert.equal(coverageShares('reconstructed', [unit()], null).comparable_source, null);
    assert.deepEqual(coverageShares('forward', fixedUnits(3), null).comparable_source, { n: 3, d: 3 });
  });
});

describe('windowSplit (D-24, review fix HIGH-1)', () => {
  const SINCE = Date.parse('2026-10-28T12:00:00Z');
  const rows = [
    { bucket: 'attributed', population: 'forward', calls: 1, usd_nano: 10 },
    { bucket: 'attributed', population: 'reconstructed', calls: 4, usd_nano: 40 },
    { bucket: 'unattributed_overlap', population: null, calls: 2, usd_nano: 20 },
    { bucket: 'unlinked', population: null, calls: 3, usd_nano: 30 },
  ];
  it('the four buckets sum to the total since the cutoff: check ok, forward and reconstructed attributed kept apart', () => {
    const w = windowSplit(SINCE, rows, { calls: 10, usd_nano: 100 });
    assert.deepEqual(Object.keys(w.buckets), ['attributed_forward', 'attributed_reconstructed', 'unattributed_overlap', 'unlinked']);
    assert.deepEqual(w.buckets.attributed_forward, { calls: 1, usd_nano: 10 });
    assert.deepEqual(w.buckets.attributed_reconstructed, { calls: 4, usd_nano: 40 });
    assert.deepEqual(w.check, { calls: 'ok', usd: 'ok' });
    assert.equal(w.since_ms, SINCE);
  });
  it('conservation: a call lost between the buckets and the total, or dollars that do not add up, is a mismatch', () => {
    assert.deepEqual(windowSplit(SINCE, rows, { calls: 11, usd_nano: 100 }).check, { calls: 'mismatch', usd: 'ok' });
    assert.deepEqual(windowSplit(SINCE, rows, { calls: 10, usd_nano: 101 }).check, { calls: 'ok', usd: 'mismatch' });
    const other = [...rows, { bucket: 'attributed', population: 'other', calls: 1, usd_nano: 5 }];
    assert.equal(windowSplit(SINCE, other, { calls: 11, usd_nano: 105 }).check.calls, 'mismatch', 'an attributed row of another population is folded into no bucket');
  });
  it('a bucket with no call is a genuine zero; an unknown (NULL) dollar sum keeps the calls check and leaves the dollars unknown', () => {
    const w = windowSplit(SINCE, rows.slice(0, 2), { calls: 5, usd_nano: 50 });
    assert.deepEqual(w.buckets.unlinked, { calls: 0, usd_nano: 0 });
    const unk = windowSplit(SINCE, [{ ...rows[0], usd_nano: null }, ...rows.slice(1)], { calls: 10, usd_nano: null });
    assert.equal(unk.buckets.attributed_forward.usd_nano, null);
    assert.deepEqual(unk.check, { calls: 'ok', usd: 'unknown' });
  });
  it('no cutoff: nothing is computed', () => {
    const w = windowSplit(null, [], null);
    assert.deepEqual([w.since_ms, w.buckets, w.total, w.check], [null, null, null, null]);
  });
  it('the text line prints since, the bucket cells, the check and the filter note; ? for unknown; no verdict word', () => {
    const big = rows.map((r) => ({ ...r, usd_nano: r.usd_nano * 1e8 }));
    const w = windowSplit(SINCE, big, { calls: 10, usd_nano: 100 * 1e8 });
    const lines = windowLines({ ...w, ignores_unit_filters: true });
    assert.match(lines[0], /^window: since 2026-10-28T12:00:00\.000Z \(first ledger line\) link_confidence=medium section=main by bucket, not a stratum figure: attributed_forward=1\/1\.000000 attributed_reconstructed=4\/4\.000000 unattributed_overlap=2\/2\.000000 unlinked=3\/3\.000000 total=10\/10\.000000 check=ok/);
    assert.ok(lines[0].endsWith(' (ignores unit filters)'));
    assert.match(lines[1], /^ {2}attribution unit is session \+ agent: a main session that touched 2 or more units goes to overlap; no improvement is claimed for main sessions$/);
    for (const t of lines) for (const x of t.toLowerCase().split(/[^a-z]+/)) assert.ok(!FORBIDDEN_WORDS.includes(x), x);
    const none = windowLines(windowSplit(null, [], null));
    assert.ok(none[0].startsWith('window: since none (no ledger line yet) '));
    assert.ok(none[0].includes('attributed_forward=? attributed_reconstructed=? unattributed_overlap=? unlinked=? total=?'));
  });
});

describe('coverage options (review fix MEDIUM-2, MEDIUM-3)', () => {
  const some = (n) => Array.from({ length: n }, (_, i) => fwd(`g${i}`, '2026-10-30T00:00:00Z'));
  it('the baseline count is the unfiltered forward count when given, and the dollar share says since <instant>', () => {
    const c = coverageShares('forward', some(1), { attributed_nano: 1e9, total_nano: 4e9, since_ms: Date.parse('2026-10-28T12:00:00Z') },
      { baselineForward: 12, dollarsIgnoreUnitFilters: true });
    assert.deepEqual(c.attribution_baseline, { forward_units: 12, needed: 10, pending: false });
    assert.equal(c.dollars_ignore_unit_filters, true);
    const t = coverageLine(c, 'UTC');
    assert.ok(t.includes(' since 2026-10-28T12:00:00.000Z '), t);
    assert.ok(!t.includes(' from '), t);
    assert.ok(t.includes('(ignores unit filters)'), t);
    const plain = coverageShares('forward', some(1), null);
    assert.equal(plain.attribution_baseline.forward_units, 1, 'default: the stratum count');
    assert.equal(plain.dollars_ignore_unit_filters, false);
    assert.ok(!coverageLine(plain, 'UTC').includes('ignores unit filters'));
  });
});
