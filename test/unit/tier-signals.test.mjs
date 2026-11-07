// Plan 02-03 (D-01..D-04, amendments Q1 and Q6, TIER-02): the pure tier precedence, conflict, timing and
// comparability rules of src/units/tier.mjs, and the text readers of the gsd-core collector (tier-file line,
// probes-skipped line, files_modified list, touched-path normalization). Written before the code (RED): the modules
// under test are loaded inside each test. Review CR-01 (02-03 code review) adds the frontmatter tier commit time cases.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TIER_SIGNAL_SQL, TIER_TIMING_SQL } from '../../src/derive/schema.mjs';

const tierMod = () => import('../../src/units/tier.mjs');
const signalsMod = () => import('../../src/adapters/gsd-core/signals.mjs');
const fmMod = () => import('../../src/adapters/gsd-core/frontmatter.mjs');

const art = (role, place, letter, relPath = `${role}.md`, extra = {}) => ({
  role, rel_path: relPath, tier_letter: letter, tier_place: letter === null ? null : place, first_commit_ms: null, tier_commit_ms: null, ...extra,
});
const PLACES = {
  plan: ['plan', 'frontmatter'],
  summary: ['summary', 'frontmatter'],
  tierFile: ['rigor-tier', 'tier-line'],
  probes: ['probes-skipped', 'probes-line'],
};
const SIGNAL = { plan: 'frontmatter', summary: 'frontmatter', tierFile: 'tier-file', probes: 'probes-skipped' };
const quoted = (sql) => [...sql.matchAll(/'([^']*)'/g)].map((m) => m[1]);

describe('tier precedence (D-01, D-02, D-04, Q6)', () => {
  it('the higher place wins for every ordered pair of the four places, whatever the input order', async () => {
    const { tierOf } = await tierMod();
    const order = ['plan', 'summary', 'tierFile', 'probes'];
    const letters = { plan: 'A', summary: 'C', tierFile: 'B', probes: 'C' };
    for (let i = 0; i < order.length; i += 1) {
      for (let j = i + 1; j < order.length; j += 1) {
        const hi = order[i];
        const lo = order[j];
        const loLetter = letters[hi] === 'B' ? 'C' : 'B';
        const a = art(...PLACES[hi], letters[hi]);
        const b = art(...PLACES[lo], loLetter);
        for (const input of [[a, b], [b, a]]) {
          const t = tierOf(input);
          assert.equal(t.tier, letters[hi], `${hi} over ${lo}`);
          assert.equal(t.tier_native, letters[hi]);
          assert.equal(t.tier_signal, SIGNAL[hi], `${hi} over ${lo}`);
          assert.equal(t.tier_conflict, true, `${hi} and ${lo} disagree`);
          assert.equal(t.winner, a);
        }
      }
    }
  });

  it('within one place the bytewise-first rel_path wins', async () => {
    const { tierOf } = await tierMod();
    const x = art('rigor-tier', 'tier-line', 'C', 'q/RIGOR-TIERS.txt');
    const y = art('rigor-tier', 'tier-line', 'B', 'q/RIGOR-TIER.md');
    assert.equal(tierOf([x, y]).tier, 'B');
    assert.equal(tierOf([y, x]).tier, 'B');
  });

  it('observations from any other role or place are ignored (a CONTEXT section, a SUMMARY body line, a flag mention)', async () => {
    const { tierOf } = await tierMod();
    const ignored = [
      art('context', 'section', 'A'),
      art('summary', 'body', 'A'),
      art('plan', 'mention', 'A'),
      art('plan', 'tier-line', 'A'),
      art('probes-skipped', 'frontmatter', 'B'),
      art('plan', 'frontmatter', 'D'),
      art('plan', 'frontmatter', 'a'),
    ];
    const t = tierOf(ignored);
    assert.deepEqual({ tier: t.tier, tier_native: t.tier_native, tier_signal: t.tier_signal, tier_conflict: t.tier_conflict, winner: t.winner },
      { tier: null, tier_native: null, tier_signal: 'none', tier_conflict: false, winner: null });
    const withOne = tierOf([...ignored, art('summary', 'frontmatter', 'C')]);
    assert.equal(withOne.tier, 'C');
    assert.equal(withOne.tier_conflict, false, 'ignored letters never make a conflict');
  });

  it('no observation gives tier null, signal none, conflict false; null and non-array inputs too', async () => {
    const { tierOf } = await tierMod();
    for (const input of [[], null, undefined, [art('plan', 'frontmatter', null)]]) {
      const t = tierOf(input);
      assert.equal(t.tier, null);
      assert.equal(t.tier_signal, 'none');
      assert.equal(t.tier_conflict, false);
    }
  });

  it('conflict is true exactly when the accepted letters differ', async () => {
    const { tierOf } = await tierMod();
    assert.equal(tierOf([art('plan', 'frontmatter', 'B'), art('summary', 'frontmatter', 'B')]).tier_conflict, false);
    const t = tierOf([art('plan', 'frontmatter', 'A'), art('summary', 'frontmatter', 'C'), art('probes-skipped', 'probes-line', 'C')]);
    assert.equal(t.tier, 'A');
    assert.equal(t.tier_signal, 'frontmatter');
    assert.equal(t.tier_conflict, true);
  });

  it('TIER_PRECEDENCE lists the four D-01 places in order', async () => {
    const { TIER_PRECEDENCE, TIER_LETTERS } = await tierMod();
    assert.deepEqual(TIER_PRECEDENCE.map((p) => [p.role, p.place, p.signal]), [
      ['plan', 'frontmatter', 'frontmatter'],
      ['summary', 'frontmatter', 'frontmatter'],
      ['rigor-tier', 'tier-line', 'tier-file'],
      ['probes-skipped', 'probes-line', 'probes-skipped'],
    ]);
    assert.deepEqual([...TIER_LETTERS], ['A', 'B', 'C']);
    assert.ok(Object.isFrozen(TIER_PRECEDENCE));
  });
});

describe('tier timing (Q1)', () => {
  it('strictly before the first implementation commit is declared-at-start; equal is not', async () => {
    const { tierTiming } = await tierMod();
    assert.equal(tierTiming({ signalMs: 10, implMs: [20, 30], summaryFirstMs: 40 }), 'declared-at-start');
    assert.equal(tierTiming({ signalMs: 20, implMs: [20, 30], summaryFirstMs: 40 }), 'declared-mid-unit');
  });

  it('at or after the SUMMARY first commit is declared-at-close', async () => {
    const { tierTiming } = await tierMod();
    assert.equal(tierTiming({ signalMs: 40, implMs: [20], summaryFirstMs: 40 }), 'declared-at-close');
    assert.equal(tierTiming({ signalMs: 50, implMs: [20], summaryFirstMs: 40 }), 'declared-at-close');
    assert.equal(tierTiming({ signalMs: 40, implMs: [40], summaryFirstMs: 40 }), 'declared-at-close');
    assert.equal(tierTiming({ signalMs: 40, implMs: [], summaryFirstMs: 40 }), 'declared-at-close');
  });

  it('between the first implementation commit and the SUMMARY is declared-mid-unit', async () => {
    const { tierTiming } = await tierMod();
    assert.equal(tierTiming({ signalMs: 25, implMs: [20, 30], summaryFirstMs: 40 }), 'declared-mid-unit');
    assert.equal(tierTiming({ signalMs: 25, implMs: [20], summaryFirstMs: null }), 'declared-mid-unit');
  });

  it('no implementation commit and no SUMMARY, or no signal time, gives null; inferred is never produced', async () => {
    const { tierTiming } = await tierMod();
    assert.equal(tierTiming({ signalMs: 25, implMs: [], summaryFirstMs: null }), null);
    assert.equal(tierTiming({ signalMs: 25, implMs: null, summaryFirstMs: null }), null);
    assert.equal(tierTiming({ signalMs: null, implMs: [20], summaryFirstMs: 40 }), null);
    assert.equal(tierTiming({ signalMs: undefined, implMs: [20], summaryFirstMs: 40 }), null);
  });

  it('implementationTimes keeps commits with a file outside .planning/, sorted; null stays null', async () => {
    const { implementationTimes } = await tierMod();
    const c = (ms, ...paths) => ({ sha: `s${ms}`, author_ms: ms, files: paths.map((path) => ({ path, status: 'M' })) });
    assert.deepEqual(implementationTimes([c(30, 'src/a.mjs'), c(10, '.planning/x/PLAN.md'), c(20, '.planning/y.md', 'hooks/h.mjs'), c(5)]), [20, 30]);
    assert.equal(implementationTimes(null), null);
    assert.deepEqual(implementationTimes([]), []);
  });

  it('unitTier uses tier_commit_ms for frontmatter and first_commit_ms otherwise, with no fallback between them', async () => {
    const { unitTier } = await tierMod();
    const commits = [{ sha: 'a', author_ms: 20, files: [{ path: 'src/a.mjs', status: 'A' }] }];
    const fm = art('plan', 'frontmatter', 'A', 'p.md', { first_commit_ms: 10, tier_commit_ms: 30 });
    assert.equal(unitTier({ artifacts: [fm], commits }).tier_timing, 'declared-mid-unit');
    const fmNoTier = art('plan', 'frontmatter', 'A', 'p.md', { first_commit_ms: 10, tier_commit_ms: null });
    assert.equal(unitTier({ artifacts: [fmNoTier], commits }).tier_timing, null, 'no fallback to first_commit_ms');
    const file = art('rigor-tier', 'tier-line', 'B', 'RIGOR-TIER.md', { first_commit_ms: 10, tier_commit_ms: 99 });
    const sum = art('summary', 'frontmatter', null, 's.md', { first_commit_ms: 40 });
    assert.equal(unitTier({ artifacts: [file, sum], commits }).tier_timing, 'declared-at-start');
    const none = unitTier({ artifacts: [sum], commits });
    assert.deepEqual(none, { tier: null, tier_native: null, tier_signal: 'none', tier_timing: null, tier_conflict: false });
    assert.equal(unitTier({ artifacts: [file, sum], commits: null }).tier_timing, null);
  });
});

describe('comparability and the value lists (D-03, TIER-02)', () => {
  it('inTierComparison excludes null, none and, by default, probes-skipped', async () => {
    const { inTierComparison } = await tierMod();
    assert.equal(inTierComparison({ tier: null, tier_signal: 'none' }), false);
    assert.equal(inTierComparison({ tier: 'A', tier_signal: 'none' }), false);
    assert.equal(inTierComparison({ tier: null, tier_signal: 'frontmatter' }), false);
    assert.equal(inTierComparison({ tier: 'A', tier_signal: 'frontmatter' }), true);
    assert.equal(inTierComparison({ tier: 'B', tier_signal: 'tier-file' }), true);
    assert.equal(inTierComparison({ tier: 'C', tier_signal: 'probes-skipped' }), false);
    assert.equal(inTierComparison({ tier: 'C', tier_signal: 'probes-skipped' }, { includeInferred: true }), true);
    assert.equal(inTierComparison({ tier: null, tier_signal: 'none' }, { includeInferred: true }), false);
  });

  it('a ledger tier is comparable only when declared at the start (plan 03-03, D-04)', async () => {
    const { inTierComparison } = await tierMod();
    assert.equal(inTierComparison({ tier: 'A', tier_signal: 'ledger', tier_timing: 'declared-at-start' }), true);
    assert.equal(inTierComparison({ tier: 'A', tier_signal: 'ledger', tier_timing: 'declared-at-close' }), false);
    assert.equal(inTierComparison({ tier: 'A', tier_signal: 'ledger', tier_timing: null }), false);
    assert.equal(inTierComparison({ tier: 'A', tier_signal: 'ledger' }), false);
    assert.equal(inTierComparison({ tier: 'A', tier_signal: 'ledger', tier_timing: 'declared-at-close' }, { includeInferred: true }), false);
    assert.equal(inTierComparison({ tier: null, tier_signal: 'ledger', tier_timing: 'declared-at-start' }), false);
  });

  it('TIER_SIGNALS and TIER_TIMINGS equal the derived schema CHECK value lists', async () => {
    const { TIER_SIGNALS, TIER_TIMINGS } = await tierMod();
    assert.deepEqual([...TIER_SIGNALS], quoted(TIER_SIGNAL_SQL));
    assert.deepEqual([...TIER_TIMINGS], quoted(TIER_TIMING_SQL));
  });
});

describe('collector text readers', () => {
  it('tierFileLetter finds a Tier line on any line and ignores lower case and other letters', async () => {
    const { tierFileLetter } = await signalsMod();
    assert.equal(tierFileLetter('# Rigor tier\n\nTier: B\nreason\n'), 'B');
    assert.equal(tierFileLetter('Tier: A (guard gate)\n'), 'A');
    assert.equal(tierFileLetter('tier: b\n'), null);
    assert.equal(tierFileLetter('Tier: D\n'), null);
    assert.equal(tierFileLetter('Tier: Bx\n'), null);
    assert.equal(tierFileLetter('  Tier: B\n'), null);
    assert.equal(tierFileLetter(null), null);
  });

  it('probesSkippedTier reads only the first non-empty line and accepts B or C, never A', async () => {
    const { probesSkippedTier } = await signalsMod();
    assert.equal(probesSkippedTier('Tier C advisory script; two parse tests\n'), 'C');
    assert.equal(probesSkippedTier('\n\n  Tier B: docs only\n'), 'B');
    assert.equal(probesSkippedTier('Tier A guard\n'), null);
    assert.equal(probesSkippedTier('reason first\nTier B\n'), null);
    assert.equal(probesSkippedTier('Tier Bravo\n'), null);
    assert.equal(probesSkippedTier(''), null);
    assert.equal(probesSkippedTier(null), null);
  });

  it('the file name patterns', async () => {
    const { TIER_FILE_RE, PROBES_FILE_RE, TIER_ROLES, TIER_PLACES } = await signalsMod();
    for (const n of ['RIGOR-TIER.md', 'RIGOR-TIERS.txt']) assert.ok(TIER_FILE_RE.test(n), n);
    for (const n of ['RIGOR-TIER.txt', 'rigor-tier.md', 'X-RIGOR-TIER.md']) assert.ok(!TIER_FILE_RE.test(n), n);
    assert.ok(PROBES_FILE_RE.test('261021-bbb-PROBES-SKIPPED.md'));
    assert.ok(!PROBES_FILE_RE.test('261021-bbb-PROBE-GATE.json'));
    assert.deepEqual([...TIER_ROLES], ['plan', 'summary', 'rigor-tier', 'probes-skipped']);
    assert.deepEqual([...TIER_PLACES], ['frontmatter', 'tier-line', 'probes-line']);
  });
});

describe('filesModified', () => {
  const fm = async (text) => {
    const { frontmatterLines, filesModified } = await fmMod();
    return filesModified(frontmatterLines(text));
  };

  it('an absent key gives null, an inline empty list gives []', async () => {
    assert.equal(await fm('---\ntier: A\n---\n'), null);
    assert.deepEqual(await fm('---\nfiles_modified: []\n---\n'), []);
    assert.deepEqual(await fm('---\nfiles_modified: [ ]\n---\n'), []);
    const { filesModified } = await fmMod();
    assert.equal(filesModified(null), null);
  });

  it('only a top-level key counts', async () => {
    assert.equal(await fm('---\nmeta:\n  files_modified:\n    - a.mjs\n---\n'), null);
  });

  it('an inline list with quotes and a trailing comment', async () => {
    assert.deepEqual(await fm('---\nfiles_modified: [a.mjs, "b c.mjs", \'d.sh\']  # three\n---\n'), ['a.mjs', 'b c.mjs', 'd.sh']);
  });

  it('a block list, indented or not, with quotes, comments and blank lines, stopping at the next key', async () => {
    const text = [
      '---',
      'files_modified:',
      '  - src/a.mjs',
      '  - "src/b #1.mjs"  # quoted hash kept',
      '',
      '  - \'src/c.mjs\'',
      '  - src/d.mjs # comment',
      'autonomous: true',
      '  - not/an/item.mjs',
      '---',
    ].join('\n');
    assert.deepEqual(await fm(text), ['src/a.mjs', 'src/b #1.mjs', 'src/c.mjs', 'src/d.mjs']);
    assert.deepEqual(await fm('---\nfiles_modified:\n- x.mjs\n- y.mjs\n---\n'), ['x.mjs', 'y.mjs']);
    assert.deepEqual(await fm('---\nfiles_modified:\n---\n'), []);
  });

  // Review WR-05 (02-03 code review): a YAML comment line between block items is legal and does not end the list.
  it('a comment line or a blank line inside a block list does not end it (review WR-05)', async () => {
    const text = [
      '---',
      'files_modified:',
      '  - a.mjs',
      '  # hooks',
      '  - hooks/g.mjs',
      '# a column-0 comment',
      '',
      '  - scripts/s.sh  # trailing',
      'autonomous: true',
      '---',
    ].join('\n');
    assert.deepEqual(await fm(text), ['a.mjs', 'hooks/g.mjs', 'scripts/s.sh']);
    assert.deepEqual(await fm('---\nfiles_modified:\n  # none yet\n---\n'), []);
    assert.deepEqual(await fm('---\nfiles_modified:  # the list\n  # first\n  - x.mjs\ntier: A\n---\n'), ['x.mjs']);
  });

  it('keeps at most 500 items of at most 512 characters', async () => {
    const { filesModified, FILES_MODIFIED_MAX_ITEMS, FILES_MODIFIED_MAX_CHARS } = await fmMod();
    assert.equal(FILES_MODIFIED_MAX_ITEMS, 500);
    assert.equal(FILES_MODIFIED_MAX_CHARS, 512);
    const lines = ['files_modified:', ...Array.from({ length: 600 }, (_, i) => `  - f${i}.mjs`)];
    const got = filesModified(lines);
    assert.equal(got.length, 500);
    assert.equal(got[499], 'f499.mjs');
    const long = `${'x'.repeat(513)}.mjs`;
    assert.deepEqual(filesModified(['files_modified:', `  - ${long}`, '  - ok.mjs']), ['ok.mjs']);
  });
});

describe('normalizeTouchedPath (D-24)', () => {
  const top = '/work/repo';
  const home = '/u/someone';
  it('strips ./, makes repo paths relative and home paths ~, and drops everything else', async () => {
    const { normalizeTouchedPath } = await signalsMod();
    const { buildHomeSet } = await import('../../src/sources/transcript/home.mjs');
    const homeSet = buildHomeSet({ home });
    const n = (raw) => normalizeTouchedPath(raw, { top, homeSet });
    assert.deepEqual(n('./scripts/a.sh'), { path: 'scripts/a.sh' });
    assert.deepEqual(n('src/a.mjs'), { path: 'src/a.mjs' });
    assert.deepEqual(n('/work/repo/src/a.mjs'), { path: 'src/a.mjs' });
    assert.deepEqual(n('/u/someone/.claude/settings.json'), { path: '~/.claude/settings.json' });
    assert.deepEqual(n('~/.claude/settings.json'), { path: '~/.claude/settings.json' });
    assert.deepEqual(n('$HOME/.gsd/x.sh'), { path: '$HOME/.gsd/x.sh' }, 'a $HOME path is kept as written');
    for (const bad of ['/srv/shared/tool.mjs', '/work/repo', '/work/repository/x.mjs', 'src/../x.mjs', '../x.mjs', 'a\u0001b.mjs',
      'x'.repeat(513), '', '   ', '~someone/x', ['C:', 'Users', 'x', 'a.mjs'].join('\\'), ['c:', 'x', 'a.mjs'].join('/'), null, 42, './']) {
      assert.deepEqual(n(bad), { dropped: true }, JSON.stringify(bad)?.slice(0, 40));
    }
    assert.deepEqual(n('x'.repeat(512)), { path: 'x'.repeat(512) });
  });

  it('drops a path holding whitespace or a denied user name as a word, and keeps a name inside a longer word', async () => {
    const { normalizeTouchedPath } = await signalsMod();
    const n = (raw) => normalizeTouchedPath(raw, { top, denyNames: ['exampleuser'] });
    for (const bad of ['a b.mjs', 'capabilities/kit/  (bundle regen)', 'src/x\ty.mjs', '.planning/quick/261002-jm2-with-exampleuser-notes/x.md',
      'ExampleUser/a.mjs', 'docs/exampleuser.md']) {
      assert.deepEqual(n(bad), { dropped: true }, bad);
    }
    assert.deepEqual(n('docs/exampleusers.md'), { path: 'docs/exampleusers.md' });
    assert.deepEqual(n('docs/myexampleuser.md'), { path: 'docs/myexampleuser.md' });
  });

  it('ownerNamesOf takes the HOME basename only when it is a plain name of at least four characters', async () => {
    const { ownerNamesOf } = await signalsMod();
    assert.ok(ownerNamesOf('/u/exampleuser').includes('exampleuser'));
    assert.ok(!ownerNamesOf('/u/tmp/rigorscope-x #home-1').includes('rigorscope-x #home-1'));
    assert.ok(!ownerNamesOf('/u/abc').includes('abc'));
    assert.ok(!ownerNamesOf('/u/runner').includes('runner'));
  });
});

// Review CR-01 (02-03 code review): the frontmatter signal time counts only a `tier:` line inside the leading
// frontmatter at that commit, never a column-0 `tier:` line in the body or a code fence.
describe('frontmatter tier commit time (review CR-01)', () => {
  let ctx;
  let fx;
  before(async () => {
    const { makeHome } = await import('../fixtures/build.mjs');
    const { buildFencedTierRepo } = await import('../fixtures/golden-repo.mjs');
    ctx = makeHome();
    fx = buildFencedTierRepo({ home: ctx.home });
  });
  after(() => ctx?.cleanup());

  it('a fenced body tier line does not antedate the frontmatter tier: the signal time is the closing commit', async () => {
    const { collectUnitSignals } = await signalsMod();
    const { unitTier } = await tierMod();
    const { goldenMs } = await import('../fixtures/golden-repo.mjs');
    const row = collectUnitSignals({ top: fx.eta, kind: 'quick', nativeId: fx.nativeId, home: fx.home });
    assert.equal(row.git, 'ok');
    const plan = row.artifacts.find((a) => a.role === 'plan');
    assert.equal(plan.tier_letter, 'A');
    assert.equal(plan.first_commit_ms, goldenMs('T0'));
    assert.equal(plan.tier_commit_ms, goldenMs('T2'), 'the tier commit is the one whose frontmatter carries the tier');
    const t = unitTier({ artifacts: row.artifacts, commits: row.commits });
    assert.equal(t.tier, 'A');
    assert.equal(t.tier_timing, 'declared-at-close');
  });

  it('when git cannot show a candidate commit the signal time is unknown (NULL), never the body-line commit', async () => {
    const { collectUnitSignals, defaultGitRun } = await signalsMod();
    const run = (args) => (args.includes('log') ? defaultGitRun(args) : { status: null, stdout: '', errorCode: 'ETIMEDOUT' });
    const row = collectUnitSignals({ top: fx.eta, kind: 'quick', nativeId: fx.nativeId, home: fx.home, run });
    const plan = row.artifacts.find((a) => a.role === 'plan');
    assert.equal(plan.tier_letter, 'A');
    assert.equal(plan.tier_commit_ms, null);
  });
});

// Review WR-02 (02-03 code review): a commit belongs to a unit only when the id is its conventional-commit scope;
// another unit's commit that mentions the id, a mention outside the scope and a merge commit are not the unit's.
describe('unit commits by conventional scope (review WR-02)', () => {
  let ctx;
  let fx;
  before(async () => {
    const { makeHome } = await import('../fixtures/build.mjs');
    const { buildScopeRepo } = await import('../fixtures/golden-repo.mjs');
    ctx = makeHome();
    fx = buildScopeRepo({ home: ctx.home });
  });
  after(() => ctx?.cleanup());

  const shasOf = (uc) => uc.commits.map((c) => c.sha).sort();

  it('a quick unit keeps type(<id>), type(quick-<id>) and a scope list naming it, and nothing else', async () => {
    const { unitCommits } = await signalsMod();
    const uc = unitCommits({ top: fx.iota, kind: 'quick', nativeId: fx.quickId });
    assert.deepEqual(shasOf(uc), [...fx.own.quick].sort());
    for (const sha of fx.foreign) assert.ok(!shasOf(uc).includes(sha), 'a foreign or merge commit is not the unit\'s');
    const { touchedPaths } = await import('../../src/units/risk.mjs');
    const paths = touchedPaths({ commits: uc.commits }).paths;
    assert.ok(!paths.includes('hooks/other.mjs') && !paths.includes('docs/adr.md'), 'another unit\'s files are not touched paths');
  });

  it('a phase plan keeps type(<plan id>) with or without the breaking mark, and nothing else', async () => {
    const { unitCommits } = await signalsMod();
    const uc = unitCommits({ top: fx.iota, kind: 'plan', nativeId: fx.planId });
    assert.deepEqual(shasOf(uc), [...fx.own.plan].sort());
  });
});
