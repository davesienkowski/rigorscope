// Regression tests of the plan 02-07 review findings (02-07-REVIEW.md WR-01 .. WR-05) and of the fix plan's revision
// rows, written before each fix (RED). Pure rules only; the end-to-end rows are in test/integration/link-review.test.mjs.
// The modules are imported dynamically inside each test so a missing export fails the assertion, not the load.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const links = () => import('../../src/derive/link-fill.mjs');
const renderJson = () => import('../../src/report/render-json.mjs');

const D = (day, hour = 0, min = 0) => Date.UTC(2026, 9, day, hour, min);
const R1 = '~/r1/.git';
const R2 = '~/r2/.git';
const unit = (repo, kind, id, dir, start, end, extra = {}) => ({
  unit_key: `gsd-core:${repo}:${kind}:${id}`,
  repo_key: repo,
  kind,
  native_id: id,
  dir_rel: dir,
  start_ms: start,
  end_ms: end,
  date_source: start === null ? 'none' : 'git',
  end_source: end === null ? 'none' : 'git',
  git_evidence: 1,
  commits_bounded: kind === 'plan' ? 1 : null,
  interval_trusted: 1,
  ...extra,
});
const quick = (repo, n, start, end, extra = {}) => unit(repo, 'quick', `2610${String(n).padStart(2, '0')}-q${n}`, `.planning/quick/2610${String(n).padStart(2, '0')}-q${n}-x`, start, end, extra);
const ctxOf = (units) => ({ repoOfDir: new Map([['~/r1', R1], ['~/r2', R2], ['~/gone', null]]), units });
const scope = (over = {}) => ({
  first_ms: null, last_ms: null, repos: [R1], refs: [], instants: [], ...over,
});
const ref = (dir, rel, tool = 'Read', ts = D(1, 10)) => ({
  ref_dir: dir, rel_path: rel, ref_kind: rel.startsWith('.planning/quick/') ? 'quick' : 'phase', tool_name: tool, ts_ms: ts,
});
const pick = (rows) => rows.map((l) => [l.unit_key, l.method, l.confidence, l.base_confidence, l.lowered_by, l.match, l.phase_level]);

describe('WR-01: a unit interval is trusted only when its end is a git time that is not shared', () => {
  it('SHARED_END_MIN is 5: four units with one end_ms are not shared, five are (boundary)', async () => {
    const { intervalTrust, SHARED_END_MIN } = await links();
    assert.equal(SHARED_END_MIN, 5);
    const four = [1, 2, 3, 4].map((n) => quick(R1, n, D(n), D(20)));
    const five = [1, 2, 3, 4, 5].map((n) => quick(R1, n, D(n), D(20)));
    assert.deepEqual([...intervalTrust(four).trusted.values()], [1, 1, 1, 1]);
    assert.equal(intervalTrust(four).shared, 0);
    assert.deepEqual([...intervalTrust(five).trusted.values()], [0, 0, 0, 0, 0]);
    assert.equal(intervalTrust(five).shared, 5, 'the count is over same-repo git-end units, self included');
  });
  it('the same end_ms in another repo does not count', async () => {
    const { intervalTrust } = await links();
    const units = [1, 2, 3].map((n) => quick(R1, n, D(n), D(20))).concat([4, 5, 6].map((n) => quick(R2, n, D(n), D(20))));
    const r = intervalTrust(units);
    assert.deepEqual([...r.trusted.values()], [1, 1, 1, 1, 1, 1]);
    assert.equal(r.shared, 0);
  });
  it('only a git end counts toward sharing and only a git end is trusted: clamped, mtime and frontmatter ends are not', async () => {
    const { intervalTrust } = await links();
    const git = [1, 2, 3, 4].map((n) => quick(R1, n, D(n), D(20)));
    const other = ['clamped', 'mtime', 'frontmatter'].map((s, i) => quick(R1, 10 + i, D(10 + i), D(20), { end_source: s }));
    const r = intervalTrust([...git, ...other]);
    assert.deepEqual([...r.trusted.values()], [1, 1, 1, 1, 0, 0, 0], 'the three non-git ends add nothing to the shared count');
    assert.equal(r.shared, 0);
  });
  it('the flag is null exactly when intervalOf is null (no end, an unbounded plan with git dates)', async () => {
    const { intervalTrust, intervalOf } = await links();
    const none = unit(R1, 'quick', '261008-fff', '.planning/quick/261008-fff-open', D(8), null);
    const unbounded = unit(R2, 'plan', '05-01', '.planning/phases/05-y', D(9, 9), D(9, 11), { commits_bounded: 0 });
    const ok = quick(R1, 1, D(1), D(2));
    const r = intervalTrust([none, unbounded, ok]);
    assert.equal(intervalOf(none), null);
    assert.equal(intervalOf(unbounded), null);
    assert.equal(r.trusted.get(none.unit_key), null);
    assert.equal(r.trusted.get(unbounded.unit_key), null);
    assert.equal(r.trusted.get(ok.unit_key), 1);
  });
  it('slash-command (reviewer shape): an instant inside exactly one UNTRUSTED unit links nothing, and no ambiguity or drop is counted', async () => {
    const { scopeLinks } = await links();
    const bulk = [1, 2, 3, 4, 5, 6].map((n) => quick(R1, n, D(n), D(20), { interval_trusted: 0 }));
    const r = scopeLinks(scope({ instants: [{ name: 'gsd-quick', repos: [R1], ts_ms: D(1, 12) }] }), ctxOf(bulk));
    assert.deepEqual(r.links, []);
    assert.equal(r.counts.slash_ambiguous, 0);
    assert.equal(r.counts.phase_dropped, 0);
  });
  it('slash-command: one trusted unit plus five shared-end units all containing the instant is ambiguous over ALL usable intervals, so no link', async () => {
    const { scopeLinks } = await links();
    const trusted = quick(R1, 1, D(1), D(3));
    const shared = [2, 3, 4, 5, 6].map((n) => quick(R1, n, D(1), D(20), { interval_trusted: 0 }));
    const r = scopeLinks(scope({ instants: [{ name: 'gsd-quick', repos: [R1], ts_ms: D(2) }] }), ctxOf([trusted, ...shared]));
    assert.deepEqual(r.links, []);
    assert.equal(r.counts.slash_ambiguous, 1);
  });
  it('slash-command: a trusted unit that is the only hit still links medium', async () => {
    const { scopeLinks } = await links();
    const trusted = quick(R1, 1, D(1), D(3));
    const far = quick(R1, 2, D(10), D(20), { interval_trusted: 0 });
    const r = scopeLinks(scope({ instants: [{ name: 'gsd-quick', repos: [R1], ts_ms: D(2) }] }), ctxOf([trusted, far]));
    assert.deepEqual(pick(r.links), [[trusted.unit_key, 'slash-command', 'medium', 'medium', null, null, 0]]);
  });
  it('phase-level: a single overlapping plan whose interval is untrusted is not picked (no link, phase_dropped not bumped)', async () => {
    const { scopeLinks } = await links();
    const p1 = unit(R1, 'plan', '03-01', '.planning/phases/03-x', D(5, 9), D(5, 11), { interval_trusted: 0 });
    const p2 = unit(R1, 'plan', '03-02', '.planning/phases/03-x', D(5, 13), D(5, 15));
    const s = scope({ first_ms: D(5, 10), last_ms: D(5, 10), refs: [ref('~/r1', '.planning/phases/03-x/03-CONTEXT.md', 'Read', D(5, 10))] });
    const r = scopeLinks(s, ctxOf([p1, p2]));
    assert.deepEqual(r.links.filter((l) => l.method === 'tool-path'), []);
    assert.equal(r.counts.phase_dropped, 0);
    const ok = scopeLinks({ ...s, first_ms: D(5, 14), last_ms: D(5, 14) }, ctxOf([p1, p2]));
    assert.deepEqual(pick(ok.links.filter((l) => l.method === 'tool-path')), [[p2.unit_key, 'tool-path', 'medium', 'medium', null, 'repo', 1]]);
  });
  it('the low interval method still uses untrusted intervals (accepted: it never counts in the strict mode)', async () => {
    const { scopeLinks } = await links();
    const bulk = [1, 2, 3, 4, 5, 6].map((n) => quick(R1, n, D(n), D(20), { interval_trusted: 0 }));
    const r = scopeLinks(scope({ first_ms: D(1, 12), last_ms: D(1, 13) }), ctxOf(bulk));
    assert.deepEqual(pick(r.links), [[bulk[0].unit_key, 'interval', 'low', 'low', null, null, 0]]);
  });
  it('a direct tool-path ref still links an untrusted unit (a ref is its own evidence)', async () => {
    const { scopeLinks } = await links();
    const u = quick(R1, 1, D(1), D(20), { interval_trusted: 0 });
    const r = scopeLinks(scope({ refs: [ref('~/r1', `${u.dir_rel}/a.md`, 'Write')] }), ctxOf([u]));
    assert.deepEqual(pick(r.links), [[u.unit_key, 'tool-path', 'high', 'high', null, 'repo', 0]]);
  });
});

describe('WR-02: scopeLinkParts reports the refs and instants that created each link, by the same rules as scopeLinks', () => {
  const P1 = unit(R1, 'plan', '03-01', '.planning/phases/03-x', D(5, 9), D(5, 11));
  const P2 = unit(R1, 'plan', '03-02', '.planning/phases/03-x', D(5, 13), D(5, 15));
  it('plans A and B in one phase dir: A holds only its direct Write, the phase-level CONTEXT read belongs to B alone', async () => {
    const { scopeLinkParts, scopeLinks } = await links();
    const write = { ...ref('~/r1', '.planning/phases/03-x/03-01-PLAN.md', 'Write', D(5, 14)), message_id: 'm1' };
    const read = { ...ref('~/r1', '.planning/phases/03-x/03-CONTEXT.md', 'Read', D(5, 14)), message_id: 'm2' };
    const s = scope({ first_ms: D(5, 14), last_ms: D(5, 14), refs: [write, read] });
    const parts = scopeLinkParts(s, ctxOf([P1, P2]));
    assert.deepEqual(parts.links, scopeLinks(s, ctxOf([P1, P2])).links, 'scopeLinks is the same rule set');
    const of = (u, m) => parts.parts.get(`${u.unit_key}\0${m}`);
    assert.deepEqual(of(P1, 'tool-path').refs.map((r) => r.message_id), ['m1']);
    assert.deepEqual(of(P2, 'tool-path').refs.map((r) => r.message_id), ['m2']);
    assert.equal(parts.links.find((l) => l.unit_key === P1.unit_key && l.method === 'tool-path').refs, 1);
  });
  it('a slash instant that was ambiguous or outside the unit repo is no instant of any link', async () => {
    const { scopeLinkParts } = await links();
    const X = quick(R1, 1, D(1), D(3));
    const Y = quick(R1, 2, D(1), D(3));
    const Z = quick(R2, 3, D(1), D(3));
    const inst = (name, repos, ts, uuid) => ({ name, repos, ts_ms: ts, uuid });
    const s = scope({ instants: [inst('gsd-quick', [R1], D(2), 'ambiguous')] });
    assert.equal(scopeLinkParts(s, ctxOf([X, Y])).parts.size, 0);
    const other = scope({ instants: [inst('gsd-quick', [R1], D(2), 'wrong-repo')] });
    assert.equal(scopeLinkParts(other, ctxOf([Z])).parts.size, 0);
    const one = scopeLinkParts(scope({ instants: [inst('gsd-quick', [R2], D(2), 'ok')] }), ctxOf([Z]));
    assert.deepEqual(one.parts.get(`${Z.unit_key}\0slash-command`).instants.map((i) => i.uuid), ['ok']);
  });
});


describe('WR-03: a dir-name-only match is capped at low', () => {
  const PLAN = unit(R1, 'plan', '01-01', '.planning/phases/01-foundation', D(5, 9), D(5, 11));
  it('reviewer shape: a Write of a phase PLAN file with no resolvable repo and one scanned unit of that id is low, never strong', async () => {
    const { scopeLinks } = await links();
    const r = scopeLinks(scope({ repos: [], refs: [ref('~/gone', '.planning/phases/01-foundation/01-01-PLAN.md', 'Write', null)] }), ctxOf([PLAN]));
    assert.deepEqual(pick(r.links), [[PLAN.unit_key, 'tool-path', 'low', 'high', 'dir-name', 'dir-name', 0]]);
  });
  it('a quick-dir Edit, an untracked (no-git) unit and a phase-level dir-name ref are low as well', async () => {
    const { scopeLinks } = await links();
    const Q = quick(R1, 4, D(4), D(4, 11));
    const q = scopeLinks(scope({ repos: [], refs: [ref('~/gone', `${Q.dir_rel}/p.md`, 'Edit', null)] }), ctxOf([Q]));
    assert.deepEqual(pick(q.links), [[Q.unit_key, 'tool-path', 'low', 'high', 'dir-name', 'dir-name', 0]]);
    const NG = quick(R2, 7, D(7), D(7, 18), { git_evidence: 0, date_source: 'quick-id', end_source: 'mtime', interval_trusted: 0 });
    const both = scopeLinks(scope({ repos: [], refs: [ref('~/gone', `${NG.dir_rel}/p.md`, 'Edit', null)] }), ctxOf([NG]));
    assert.deepEqual(pick(both.links), [[NG.unit_key, 'tool-path', 'low', 'high', 'dir-name+no-git-dates', 'dir-name', 0]]);
    const ph = scopeLinks(scope({
      repos: [], first_ms: D(5, 10), last_ms: D(5, 10), refs: [ref('~/gone', '.planning/phases/01-foundation/01-CONTEXT.md', 'Read', D(5, 10))],
    }), ctxOf([PLAN]));
    assert.deepEqual(pick(ph.links), [[PLAN.unit_key, 'tool-path', 'low', 'medium', 'dir-name', 'dir-name', 1]]);
  });
  it('a repo-matched ref to the same unit still wins and keeps its confidence', async () => {
    const { scopeLinks } = await links();
    const r = scopeLinks(scope({
      repos: [], refs: [ref('~/gone', '.planning/phases/01-foundation/01-01-PLAN.md', 'Write', null), ref('~/r1', '.planning/phases/01-foundation/01-01-SUMMARY.md', 'Write', null)],
    }), ctxOf([PLAN]));
    assert.deepEqual(pick(r.links), [[PLAN.unit_key, 'tool-path', 'high', 'high', null, 'repo', 0]]);
  });
});


describe('WR-04: the --role ? marker is the stored unknown, role_source unavailable', () => {
  it('callFilterSql maps ? for role to role_source = unavailable, alone and in a list; model keeps IS NULL', async () => {
    const { callFilterSql } = await import('../../src/report/filters.mjs');
    assert.deepEqual(callFilterSql({ call: { role: [null], model: null } }), { sql: "(c.role_source = 'unavailable')", params: [] });
    assert.deepEqual(callFilterSql({ call: { role: ['main', null], model: null } }), {
      sql: "(c.role IN (?) OR c.role_source = 'unavailable')", params: ['main'],
    });
    assert.deepEqual(callFilterSql({ call: { role: null, model: [null] } }), { sql: '(c.model IS NULL)', params: [] });
  });
});

describe('WR-05: the attribution JSON labels every tokens and usd_nano value', () => {
  const bucket = (calls, tokens, usd) => ({
    calls, tokens, usd_nano: usd, refs_unknown_calls: 0,
  });
  const report = (parts) => ({
    mode: 'medium',
    attributed: { ...parts.attributed, widened_calls: 0 },
    unattributed_overlap: { ...parts.unattributed_overlap, multi_unit_calls: 0, low_only_calls: 0 },
    unlinked: parts.unlinked,
    total: parts.total,
    refs_unknown_calls: 0,
    check: 'ok',
  });
  it('a bucket value is derived when known (a known zero included) and unavailable only when null; values are unchanged', async () => {
    const { attributionJson } = await renderJson();
    assert.equal(typeof attributionJson, 'function');
    const a = attributionJson(report({
      attributed: bucket(2, 10, 5), unattributed_overlap: bucket(1, 7, null), unlinked: bucket(0, 0, 0), total: bucket(3, 17, null),
    }));
    assert.deepEqual(a.attributed.labels, { tokens: 'derived', usd_nano: 'derived' });
    assert.deepEqual(a.unattributed_overlap.labels, { tokens: 'derived', usd_nano: 'unavailable' });
    assert.deepEqual(a.unlinked.labels, { tokens: 'derived', usd_nano: 'derived' });
    assert.deepEqual(a.total.labels, { tokens: 'derived', usd_nano: 'unavailable' });
    assert.equal(a.unlinked.tokens, 0, 'a known-zero empty bucket stays 0');
    assert.equal(a.unlinked.usd_nano, 0);
    assert.equal(a.unattributed_overlap.usd_nano, null);
    assert.equal(a.attributed.tokens + a.unattributed_overlap.tokens + a.unlinked.tokens, a.total.tokens, 'the buckets still sum to the total');
    const nullTokens = attributionJson(report({
      attributed: bucket(1, null, null), unattributed_overlap: bucket(0, 0, 0), unlinked: bucket(0, 0, 0), total: bucket(1, null, null),
    }));
    assert.deepEqual(nullTokens.attributed.labels, { tokens: 'unavailable', usd_nano: 'unavailable' });
  });
  it('the block keys and each bucket key list are pinned', async () => {
    const { attributionJson } = await renderJson();
    const a = attributionJson(report({
      attributed: bucket(1, 1, 1), unattributed_overlap: bucket(0, 0, 0), unlinked: bucket(0, 0, 0), total: bucket(1, 1, 1),
    }));
    assert.deepEqual(Object.keys(a), ['scope', 'link_confidence', 'section', 'attributed', 'unattributed_overlap', 'unlinked', 'total', 'refs_unknown_calls', 'check', 'outside']);
    assert.deepEqual(Object.keys(a.unlinked), ['calls', 'tokens', 'usd_nano', 'refs_unknown_calls', 'labels']);
    assert.deepEqual(Object.keys(a.attributed), ['calls', 'tokens', 'usd_nano', 'refs_unknown_calls', 'labels', 'widened_calls']);
    assert.deepEqual(Object.keys(a.unattributed_overlap), ['calls', 'tokens', 'usd_nano', 'refs_unknown_calls', 'labels', 'multi_unit_calls', 'low_only_calls']);
    assert.equal(attributionJson(null), null);
  });
});
