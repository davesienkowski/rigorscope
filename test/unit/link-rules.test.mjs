// Plan 02-07 (UNIT-06, D-10, D-12, D-13): the pure link and attribution rules. Written before the code (RED). The modules
// are imported dynamically inside each test so the file loads before the rules exist.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const links = () => import('../../src/derive/link-fill.mjs');
const attribution = () => import('../../src/derive/attribution.mjs');

const H = 3600000;
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
const Q1 = unit(R1, 'quick', '261001-aaa', '.planning/quick/261001-aaa-one', D(1), D(1, 12));
const Q2 = unit(R1, 'quick', '261001-bbb', '.planning/quick/261001-bbb-two', D(1), D(1, 16));
const P1 = unit(R1, 'plan', '03-01', '.planning/phases/03-x', D(5, 9), D(5, 11));
const P2 = unit(R1, 'plan', '03-02', '.planning/phases/03-x', D(5, 13), D(5, 15));
const NOGIT = unit(R2, 'quick', '261007-ccc', '.planning/quick/261007-ccc-u', D(7), D(7, 18), {
  git_evidence: 0, date_source: 'quick-id', end_source: 'mtime', interval_trusted: 0,
});
const DUP_A = unit(R1, 'quick', '261003-ddd', '.planning/quick/261003-ddd-same', D(3), D(3, 11));
const DUP_B = unit(R2, 'quick', '261003-ddd', '.planning/quick/261003-ddd-same', D(3), D(3, 11));
const SOLO = unit(R1, 'quick', '261004-eee', '.planning/quick/261004-eee-solo', D(4), D(4, 11));
const NONE_END = unit(R1, 'quick', '261008-fff', '.planning/quick/261008-fff-open', D(8), null, { interval_trusted: null });
const UNBOUNDED = unit(R2, 'plan', '05-01', '.planning/phases/05-y', D(9, 9), D(9, 11), { commits_bounded: 0, interval_trusted: null });
const UNITS = [Q1, Q2, P1, P2, NOGIT, DUP_A, DUP_B, SOLO, NONE_END, UNBOUNDED];
const ctx = (units = UNITS) => ({
  repoOfDir: new Map([['~/r1', R1], ['~/r1-wt', R1], ['~/r2', R2], ['~/gone', null]]),
  units,
});
const ref = (dir, rel, tool = 'Read', ts = D(1, 10)) => ({
  ref_dir: dir, rel_path: rel, ref_kind: rel.startsWith('.planning/quick/') ? 'quick' : 'phase', tool_name: tool, ts_ms: ts,
});
const scope = (over = {}) => ({
  first_ms: D(1, 10), last_ms: D(1, 10, 5), repos: [R1], refs: [], instants: [], ...over,
});
const pick = (rows) => rows.map((l) => [l.unit_key, l.method, l.confidence, l.base_confidence, l.lowered_by, l.match, l.phase_level]);

describe('lowerConfidence and overlaps', () => {
  it('lowers high to medium, medium to low, and keeps low', async () => {
    const { lowerConfidence } = await links();
    assert.deepEqual(['high', 'medium', 'low'].map(lowerConfidence), ['medium', 'low', 'low']);
    assert.throws(() => lowerConfidence('top'), RangeError);
  });
  it('treats intervals as closed: touching overlaps, one millisecond apart does not, a null bound never overlaps', async () => {
    const { overlaps } = await links();
    assert.equal(overlaps({ first: 0, last: 10 }, { first: 10, last: 20 }), true);
    assert.equal(overlaps({ first: 20, last: 30 }, { first: 10, last: 20 }), true);
    assert.equal(overlaps({ first: 0, last: 10 }, { first: 11, last: 20 }), false);
    assert.equal(overlaps({ first: 21, last: 30 }, { first: 10, last: 20 }), false);
    assert.equal(overlaps({ first: 5, last: 5 }, { first: 0, last: 10 }), true);
    assert.equal(overlaps({ first: null, last: 10 }, { first: 0, last: 10 }), false);
    assert.equal(overlaps({ first: 0, last: 10 }, null), false);
  });
});

describe('refTarget', () => {
  it('a quick-dir ref (a file or the directory) resolves directly through the repo of its directory', async () => {
    const { refTarget } = await links();
    assert.deepEqual(refTarget(ref('~/r1', `${Q1.dir_rel}/261001-aaa-PLAN.md`), ctx()), { unitKey: Q1.unit_key, direct: true, match: 'repo' });
    assert.deepEqual(refTarget(ref('~/r1-wt', Q1.dir_rel), ctx()), { unitKey: Q1.unit_key, direct: true, match: 'repo' });
  });
  it("a phase file starting with an existing plan's id and a dash is a direct ref to that plan", async () => {
    const { refTarget } = await links();
    assert.deepEqual(refTarget(ref('~/r1', '.planning/phases/03-x/03-02-SUMMARY.md'), ctx()), { unitKey: P2.unit_key, direct: true, match: 'repo' });
  });
  it('a phase file no plan id prefixes, or the phase directory, is phase-level', async () => {
    const { refTarget } = await links();
    const want = { phaseDir: { repoKey: R1, dirRel: '.planning/phases/03-x' }, match: 'repo' };
    assert.deepEqual(refTarget(ref('~/r1', '.planning/phases/03-x/03-CONTEXT.md'), ctx()), want);
    assert.deepEqual(refTarget(ref('~/r1', '.planning/phases/03-x'), ctx()), want);
    assert.deepEqual(refTarget(ref('~/r1', '.planning/phases/03-x/03-09-PLAN.md'), ctx()), want, 'an id of no existing plan');
  });
  it('a file of a directory holding no plan unit (a duplicate-id directory) is unmatched', async () => {
    const { refTarget } = await links();
    assert.deepEqual(refTarget(ref('~/r1', '.planning/phases/03-x-old/03-01-PLAN.md'), ctx()), { miss: 'unmatched' });
  });
  it('without a repo for the directory: a unique dir-name match resolves with match dir-name, several are ambiguous, none unmatched', async () => {
    const { refTarget } = await links();
    assert.deepEqual(refTarget(ref('~/gone', `${SOLO.dir_rel}/x.md`), ctx()), { unitKey: SOLO.unit_key, direct: true, match: 'dir-name' });
    assert.deepEqual(refTarget(ref('~/elsewhere', `${SOLO.dir_rel}/x.md`), ctx()), { unitKey: SOLO.unit_key, direct: true, match: 'dir-name' });
    assert.deepEqual(refTarget(ref('~/gone', `${DUP_A.dir_rel}/x.md`), ctx()), { miss: 'ambiguous' });
    assert.deepEqual(refTarget(ref('~/gone', '.planning/quick/261099-zzz-none'), ctx()), { miss: 'unmatched' });
    assert.deepEqual(refTarget(ref('~/gone', '.planning/phases/03-x/03-01-PLAN.md'), ctx()), { unitKey: P1.unit_key, direct: true, match: 'dir-name' });
    assert.deepEqual(refTarget(ref('~/gone', '.planning/phases/03-x/03-CONTEXT.md'), ctx()),
      { phaseDir: { repoKey: R1, dirRel: '.planning/phases/03-x' }, match: 'dir-name' });
  });
  it('with a repo, a quick dir that is no unit of that repo is unmatched (no dir-name fallback)', async () => {
    const { refTarget } = await links();
    assert.deepEqual(refTarget(ref('~/r2', `${SOLO.dir_rel}/x.md`), ctx()), { miss: 'unmatched' });
  });
});

describe('scopeLinks', () => {
  it('write evidence over several messages: one Write row anywhere in the scope makes the tool-path link high', async () => {
    const { scopeLinks } = await links();
    const s = scope({ refs: [ref('~/r1', `${Q1.dir_rel}/a.md`, 'Read'), ref('~/r1', `${Q1.dir_rel}/b.md`, 'Write', D(1, 10, 5))] });
    const tp = scopeLinks(s, ctx()).links.filter((l) => l.method === 'tool-path');
    assert.deepEqual(pick(tp), [[Q1.unit_key, 'tool-path', 'high', 'high', null, 'repo', 0]]);
    assert.equal(tp[0].refs, 2);
    assert.equal(tp[0].write_refs, 1);
    assert.equal(tp[0].first_ms, D(1, 10));
    assert.equal(tp[0].last_ms, D(1, 10, 5));
  });
  it('a write stored under a read tool name (bytewise minimum: Write and Read give Read) stays medium', async () => {
    const { scopeLinks, WRITE_TOOLS } = await links();
    assert.deepEqual([...WRITE_TOOLS], ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
    const s = scope({ refs: [ref('~/r1', `${Q1.dir_rel}/a.md`, 'Read')] });
    assert.equal(scopeLinks(s, ctx()).links.find((l) => l.method === 'tool-path').confidence, 'medium');
  });
  it('phase-level refs pick the one plan whose interval overlaps the scope; zero, two or no scope interval drop the ref', async () => {
    const { scopeLinks } = await links();
    const ctxRef = [ref('~/r1', '.planning/phases/03-x/03-CONTEXT.md', 'Write', D(5, 14))];
    const one = scopeLinks(scope({ first_ms: D(5, 14), last_ms: D(5, 14), refs: ctxRef }), ctx());
    assert.deepEqual(pick(one.links.filter((l) => l.method === 'tool-path')), [[P2.unit_key, 'tool-path', 'medium', 'medium', null, 'repo', 1]]);
    assert.equal(one.counts.phase_dropped, 0);
    for (const [first, last] of [[D(5, 12), D(5, 12)], [D(5, 10), D(5, 14)], [null, null]]) {
      const r = scopeLinks(scope({ first_ms: first, last_ms: last, refs: ctxRef }), ctx());
      assert.equal(r.links.filter((l) => l.method === 'tool-path').length, 0);
      assert.equal(r.counts.phase_dropped, 1);
    }
  });
  it('slash instants: inside one interval links medium; inside two is ambiguous; inside none links nothing; no time is ambiguous; other names never link', async () => {
    const { scopeLinks } = await links();
    const at = (ts, name = 'gsd-quick') => scope({ first_ms: null, last_ms: null, instants: [{ name, repos: [R1], ts_ms: ts }] });
    const one = scopeLinks(at(D(1, 14)), ctx());
    assert.deepEqual(pick(one.links), [[Q2.unit_key, 'slash-command', 'medium', 'medium', null, null, 0]]);
    assert.equal(one.links[0].instants, 1);
    const two = scopeLinks(at(D(1, 10)), ctx());
    assert.deepEqual(two.links, []);
    assert.equal(two.counts.slash_ambiguous, 1);
    const none = scopeLinks(at(D(2, 10)), ctx());
    assert.deepEqual(none.links, []);
    assert.equal(none.counts.slash_ambiguous, 0);
    const noTime = scopeLinks(at(null), ctx());
    assert.deepEqual(noTime.links, []);
    assert.equal(noTime.counts.slash_ambiguous, 1);
    for (const name of ['gsd-fast', 'gsd-debug', 'gsd-explore', 'clear']) assert.deepEqual(scopeLinks(at(D(1, 14), name), ctx()).links, []);
    const plan = scopeLinks(at(D(5, 10), 'gsd:execute-phase'), ctx());
    assert.deepEqual(pick(plan.links), [[P1.unit_key, 'slash-command', 'medium', 'medium', null, null, 0]]);
  });
  it('two units whose intervals only touch at one instant are both candidates for it, so a slash instant there is ambiguous', async () => {
    const { scopeLinks } = await links();
    const X = unit(R1, 'quick', '261002-xxx', '.planning/quick/261002-xxx-a', D(2), D(2, 10));
    const Y = unit(R1, 'quick', '261002-yyy', '.planning/quick/261002-yyy-b', D(2, 10), D(2, 20));
    const r = scopeLinks(scope({ first_ms: null, last_ms: null, instants: [{ name: 'gsd-quick', repos: [R1], ts_ms: D(2, 10) }] }), ctx([X, Y]));
    assert.deepEqual(r.links, []);
    assert.equal(r.counts.slash_ambiguous, 1);
  });
  it('interval links are low for every unit of the scope repos whose closed interval overlaps; touching counts', async () => {
    const { scopeLinks } = await links();
    const r = scopeLinks(scope({ first_ms: D(1, 12), last_ms: D(1, 13) }), ctx());
    assert.deepEqual(pick(r.links), [
      [Q1.unit_key, 'interval', 'low', 'low', null, null, 0],
      [Q2.unit_key, 'interval', 'low', 'low', null, null, 0],
    ]);
    const apart = scopeLinks(scope({ first_ms: D(1, 12) + 1, last_ms: D(1, 13) }), ctx());
    assert.deepEqual(pick(apart.links), [[Q2.unit_key, 'interval', 'low', 'low', null, null, 0]]);
    assert.deepEqual(scopeLinks(scope({ repos: [] }), ctx()).links, [], 'no repo, no interval link');
  });
  it('a unit with end source none, or an unbounded plan with git dates, takes part in no interval, slash or phase-level rule', async () => {
    const { scopeLinks, intervalOf } = await links();
    assert.equal(intervalOf(NONE_END), null);
    assert.equal(intervalOf(UNBOUNDED), null);
    assert.deepEqual(intervalOf(Q1), { first: Q1.start_ms, last: Q1.end_ms });
    const iv = scopeLinks(scope({ first_ms: D(8, 10), last_ms: D(8, 10) }), ctx());
    assert.deepEqual(iv.links, []);
    const slash = scopeLinks(scope({ repos: [R2], instants: [{ name: 'gsd-execute-phase', repos: [R2], ts_ms: D(9, 10) }] }), ctx());
    assert.deepEqual(slash.links, []);
    const phase = scopeLinks(scope({
      first_ms: D(9, 10), last_ms: D(9, 10), repos: [R2], refs: [ref('~/r2', '.planning/phases/05-y/05-CONTEXT.md', 'Read', D(9, 10))],
    }), ctx());
    assert.deepEqual(phase.links, []);
    assert.equal(phase.counts.phase_dropped, 1);
    const direct = scopeLinks(scope({ repos: [], refs: [ref('~/r1', `${NONE_END.dir_rel}/x.md`, 'Edit')] }), ctx());
    assert.deepEqual(pick(direct.links), [[NONE_END.unit_key, 'tool-path', 'high', 'high', null, 'repo', 0]], 'tool-path needs no interval');
  });
  it('D-10 and dir-name lowering: no-git-dates lowers every method one level, dir-name one more, and both are recorded', async () => {
    const { scopeLinks } = await links();
    const nogit = scopeLinks(scope({ first_ms: D(7, 12), last_ms: D(7, 12), repos: [R2], refs: [ref('~/r2', `${NOGIT.dir_rel}/p.md`, 'Write', D(7, 12))] }), ctx());
    assert.deepEqual(pick(nogit.links), [
      [NOGIT.unit_key, 'interval', 'low', 'low', 'no-git-dates', null, 0],
      [NOGIT.unit_key, 'tool-path', 'medium', 'high', 'no-git-dates', 'repo', 0],
    ]);
    const both = scopeLinks(scope({ first_ms: null, last_ms: null, repos: [], refs: [ref('~/gone', `${NOGIT.dir_rel}/p.md`, 'Edit', null)] }), ctx());
    assert.deepEqual(pick(both.links), [[NOGIT.unit_key, 'tool-path', 'low', 'high', 'dir-name+no-git-dates', 'dir-name', 0]]);
    assert.equal(both.counts.dir_name, 1);
    const dirOnly = scopeLinks(scope({ repos: [], first_ms: null, last_ms: null, refs: [ref('~/gone', `${SOLO.dir_rel}/p.md`, 'Edit', null)] }), ctx());
    assert.deepEqual(pick(dirOnly.links), [[SOLO.unit_key, 'tool-path', 'low', 'high', 'dir-name', 'dir-name', 0]], 'review WR-03: capped at low');
  });
  it('a repo-matched ref wins over a dir-name ref to the same unit; misses are counted by reason', async () => {
    const { scopeLinks } = await links();
    const r = scopeLinks(scope({
      repos: [], first_ms: null, last_ms: null,
      refs: [ref('~/gone', `${SOLO.dir_rel}/p.md`, 'Edit', null), ref('~/r1', `${SOLO.dir_rel}/q.md`, 'Read', null),
        ref('~/gone', `${DUP_A.dir_rel}/x.md`), ref('~/r1', '.planning/quick/261099-zzz-none/x.md')],
    }), ctx());
    assert.deepEqual(pick(r.links), [[SOLO.unit_key, 'tool-path', 'medium', 'medium', null, 'repo', 0]]);
    assert.equal(r.counts.ambiguous, 1);
    assert.equal(r.counts.unmatched, 1);
  });
  it('the link rows come in (unit_key, method) bytewise order', async () => {
    const { scopeLinks } = await links();
    const r = scopeLinks(scope({ first_ms: D(1, 14), last_ms: D(1, 14), instants: [{ name: 'gsd-quick', repos: [R1], ts_ms: D(1, 14) }], refs: [ref('~/r1', `${Q2.dir_rel}/x`, 'Read', D(1, 14))] }), ctx());
    const keys = r.links.map((l) => `${l.unit_key}\0${l.method}`);
    assert.deepEqual(keys, [...keys].sort());
    assert.deepEqual(r.links.map((l) => l.method), ['interval', 'slash-command', 'tool-path']);
  });
});

describe('attributeScope', () => {
  const L = (unitKey, confidence) => ({ unit_key: unitKey, confidence });
  it('decides every reason in both modes', async () => {
    const { attributeScope } = await attribution();
    const cases = [
      [[L('a', 'high')], ['attributed', 'one-unit', 'a', 1], ['attributed', 'one-unit', 'a', 1]],
      [[L('a', 'medium'), L('a', 'low'), L('b', 'low')], ['attributed', 'one-unit', 'a', 1], ['attributed', 'one-unit', 'a', 1]],
      [[L('a', 'high'), L('b', 'medium')], ['unattributed_overlap', 'multi-unit', null, 2], ['unattributed_overlap', 'multi-unit', null, 2]],
      [[L('a', 'low')], ['unattributed_overlap', 'low-only', null, 0], ['attributed', 'one-low-unit', 'a', 1]],
      [[L('a', 'low'), L('b', 'low')], ['unattributed_overlap', 'low-only', null, 0], ['unattributed_overlap', 'multi-unit', null, 2]],
      [[], ['unlinked', 'no-link', null, 0], ['unlinked', 'no-link', null, 0]],
    ];
    for (const [rows, medium, low] of cases) {
      const m = attributeScope({ links: rows, mode: 'medium' });
      const w = attributeScope({ links: rows, mode: 'low' });
      assert.deepEqual(Object.keys(m), ['bucket', 'reason', 'unitKey', 'countedUnits']);
      assert.deepEqual([m.bucket, m.reason, m.unitKey, m.countedUnits], medium, JSON.stringify(rows));
      assert.deepEqual([w.bucket, w.reason, w.unitKey, w.countedUnits], low, JSON.stringify(rows));
    }
  });
  it('a unit linked by several methods counts once', async () => {
    const { attributeScope } = await attribution();
    const r = attributeScope({ links: [L('a', 'high'), L('a', 'medium'), L('a', 'low')], mode: 'medium' });
    assert.deepEqual(r, {
      bucket: 'attributed', reason: 'one-unit', unitKey: 'a', countedUnits: 1,
    });
  });
  it('widening: mode low never reverses a mode-medium attribution', async () => {
    const { attributeScope } = await attribution();
    const confs = ['high', 'medium', 'low'];
    for (const a of [null, ...confs]) {
      for (const b of [null, ...confs]) {
        for (const c of [null, ...confs]) {
          const rows = [['u1', a], ['u2', b], ['u3', c]].filter(([, x]) => x !== null).map(([k, x]) => L(k, x));
          const m = attributeScope({ links: rows, mode: 'medium' });
          const w = attributeScope({ links: rows, mode: 'low' });
          if (m.bucket === 'attributed') assert.deepEqual([w.bucket, w.unitKey], ['attributed', m.unitKey], JSON.stringify(rows));
          if (m.reason === 'multi-unit') assert.equal(w.reason, 'multi-unit');
        }
      }
    }
  });
  it('rejects an unknown mode', async () => {
    const { attributeScope } = await attribution();
    assert.throws(() => attributeScope({ links: [], mode: 'high' }), RangeError);
  });
});
