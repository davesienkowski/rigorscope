// Unit tests of scanRepo over the stock locations (plan 03.1-01, ADPT-05, D-01, D-04, D-05, D-06): archived phase and
// quick dirs, and (Task 3) the prefixed, counted-only and repeated forms. scanRepo is exported with the `known` seam and
// had no direct test before this file. Every tree is a plain temporary directory built by the fixture helpers (no git
// repository is needed to scan), created and removed here; the expectations come from test/fixtures/stock-layouts.mjs,
// written by hand from the plan, never from the adapter.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUnitAt, scanRepo } from '../../src/adapters/gsd-core/index.mjs';
import { LOCATION_KINDS } from '../../src/adapters/gsd-core/layout.mjs';
import { buildAdapterHome } from '../fixtures/adapter-home.mjs';
import { makeHome } from '../fixtures/build.mjs';
import { planText, writePlanningDir } from '../fixtures/git-repo.mjs';
import { STOCK_LAYOUTS, emptyPlanning } from '../fixtures/stock-layouts.mjs';

const made = [];
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), `rigorscope-${prefix}-`));
  made.push(d);
  return d;
};
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const countOf = (res, kind) => (res.notRead?.[kind] ?? []).length;
const unitIds = (res) => res.units.map((u) => `${u.kind}:${u.nativeId}`).sort();

describe('scanRepo: an archived phase dir is a plan unit (tracer)', () => {
  let res;
  before(() => {
    const top = tmp('scan-trace');
    const home = tmp('scan-trace-home');
    emptyPlanning(top);
    writePlanningDir(top, {
      under: 'milestones/v1.0-phases',
      name: '01-setup',
      files: { '01-01-PLAN.md': planText({ tier: 'A' }), '01-01-SUMMARY.md': planText({ tier: 'A' }) },
    });
    res = scanRepo({ top, home });
  });

  it('returns one plan unit with the archive dirRel, two artifacts and the tier letter of the PLAN', () => {
    assert.equal(res.units.length, 1);
    const [u] = res.units;
    assert.equal(u.kind, 'plan');
    assert.equal(u.nativeId, '01-01');
    assert.equal(u.dirRel, '.planning/milestones/v1.0-phases/01-setup');
    assert.deepEqual(u.artifacts.map((a) => a.role).sort(), ['plan', 'summary']);
    assert.equal(u.artifacts.find((a) => a.role === 'plan').tierLetter, 'A');
    assert.equal(res.plan, 1);
    assert.equal(res.archived, 1);
    assert.equal(res.dupIds, 0);
  });
});

describe('scanRepo: the archived layout (live, archived phase, archived quick, milestone file and other dir)', () => {
  let res;
  before(() => {
    const top = tmp('scan-archived');
    STOCK_LAYOUTS.archived.build(top, { home: top });
    res = scanRepo({ top, home: tmp('scan-archived-home') });
  });

  it('returns the expected units with their dirs, tiers and artifact counts', () => {
    const want = STOCK_LAYOUTS.archived.expect.units;
    assert.deepEqual(unitIds(res), want.map((u) => `${u.kind}:${u.nativeId}`).sort());
    for (const w of want) {
      const u = res.units.find((x) => x.kind === w.kind && x.nativeId === w.nativeId);
      assert.equal(u.dirRel, w.dirRel);
      assert.equal(u.artifacts.length, w.artifacts);
      assert.equal(u.artifacts.find((a) => a.role === 'plan').tierLetter, w.tier);
    }
  });

  it('counts the archived units and the directory under milestones/ that is no archive root, and nothing else', () => {
    assert.equal(res.archived, STOCK_LAYOUTS.archived.expect.counters.units_archived);
    assert.equal(countOf(res, 'not_read_milestones_other_dir'), 1);
    assert.deepEqual(Object.keys(res.notRead ?? {}), ['not_read_milestones_other_dir']);
    assert.equal(res.skipped, 0);
    assert.equal(res.dupIds, 0);
  });
});

describe('scanRepo: archive roots are read oldest first and a sibling or file is not a root', () => {
  it('reads v1.2-phases before v1.10-phases for a new id (natural label order); the live dir comes last', () => {
    const top = tmp('scan-order');
    const mk = (under, name) => writePlanningDir(top, { under, name, files: { '01-01-PLAN.md': planText({ tier: 'B' }) } });
    mk('milestones/v1.10-phases', '01-ten');
    mk('milestones/v1.2-phases', '01-two');
    mk('phases', '01-live');
    const res = scanRepo({ top, home: tmp('scan-order-home') });
    assert.equal(res.units.length, 1);
    assert.equal(res.units[0].dirRel, '.planning/milestones/v1.2-phases/01-two');
  });

  it('does not read a sibling such as .planning/milestones-v1-03-alpha or a v1.0-ROADMAP.md file', () => {
    const top = tmp('scan-sibling');
    writePlanningDir(top, { under: '', name: 'milestones-v1-03-alpha', files: { '01-01-PLAN.md': planText({ tier: 'B' }) } });
    writePlanningDir(top, { under: 'milestones', name: 'v1.0-ROADMAP.md.d', files: { '01-01-PLAN.md': planText({ tier: 'B' }) } });
    const res = scanRepo({ top, home: tmp('scan-sibling-home') });
    assert.equal(res.units.length, 0);
  });

  it('keeps the stored-dir rule when the archive dir sorts bytewise first (milestones < phases)', () => {
    const top = tmp('scan-stored');
    const mk = (under, name) => writePlanningDir(top, { under, name, files: { '01-01-PLAN.md': planText({ tier: 'B' }) } });
    mk('milestones/v1.0-phases', '01-setup');
    mk('phases', '01-new');
    const known = new Map([['01-01', '.planning/phases/01-new']]);
    const res = scanRepo({ top, knownPlans: known, home: tmp('scan-stored-home') });
    assert.equal(res.units.length, 1);
    assert.equal(res.units[0].dirRel, '.planning/phases/01-new', 'the stored dir wins over an archive dir that sorts first');
    assert.ok(!res.units[0].artifacts.some((a) => a.relPath.includes('milestones')), 'the archive copy is never merged');
  });

  it('keeps the stored dir for a known quick unit: a later live dir and an archive copy are repeats (review WR-03)', () => {
    const top = tmp('scan-stored-quick');
    const mk = (under, name) => writePlanningDir(top, { under, name, files: { '260101-abc-PLAN.md': planText({ tier: 'C' }) } });
    mk('milestones/v1.0-quick', '260101-abc-old');
    mk('quick', '260101-abc-new');
    const known = new Map([['260101-abc', '.planning/quick/260101-abc-new']]);
    const res = scanRepo({ top, known, home: tmp('scan-stored-quick-home') });
    assert.equal(res.units.length, 1);
    assert.equal(res.units[0].dirRel, '.planning/quick/260101-abc-new', 'the stored dir wins over an archive dir that is read first');
    assert.ok(!res.units[0].artifacts.some((a) => a.relPath.includes('milestones')), 'the archive copy is never merged');
    assert.deepEqual(res.repeatIds.map((r) => r.dirRel), ['.planning/milestones/v1.0-quick/260101-abc-old']);
  });
});


// The location counters of one scan, the non-zero ones, in the shape of STOCK_LAYOUTS expect.counters.
function counters(res) {
  const out = {};
  const add = (kind, n) => { if (n > 0) out[kind] = n; };
  add('units_archived', res.archived);
  add('repeat_id', res.repeatIds.length);
  for (const k of LOCATION_KINDS) if (k.startsWith('not_read_')) add(k, countOf(res, k));
  return out;
}
const pathsOf = (res) => Object.values(res.notRead ?? {}).flat();

describe('counted forms are never units', () => {
  for (const name of ['prefixed', 'workstreams', 'forms']) {
    it(`the ${name} layout gives exactly its units and counters, and no counted path is a unit or an artifact`, () => {
      const layout = STOCK_LAYOUTS[name];
      const top = tmp(`scan-${name}`);
      layout.build(top, { home: top });
      const res = scanRepo({ top, home: tmp(`scan-${name}-home`) });
      assert.deepEqual(unitIds(res), layout.expect.units.map((u) => `${u.kind}:${u.nativeId}`).sort());
      for (const w of layout.expect.units) {
        const u = res.units.find((x) => x.nativeId === w.nativeId);
        assert.equal(u.dirRel, w.dirRel);
        assert.equal(u.artifacts.length, w.artifacts);
      }
      assert.deepEqual(counters(res), layout.expect.counters);
      assert.deepEqual([...res.skippedPaths].sort(), layout.expect.skippedPlans ?? []);
      assert.equal(res.dupIds, 0);
      const counted = pathsOf(res);
      for (const u of res.units) {
        assert.ok(!counted.includes(u.dirRel), `${u.dirRel} is both a unit and counted`);
        for (const a of u.artifacts) assert.ok(!counted.includes(a.relPath), `${a.relPath} is both an artifact and counted`);
      }
    });
  }

  it('a code-prefixed phase dir keeps the plain id: the key and native id carry no code', () => {
    const top = tmp('scan-code');
    STOCK_LAYOUTS.prefixed.build(top, { home: top });
    const res = scanRepo({ top, home: tmp('scan-code-home') });
    assert.deepEqual(res.units.map((u) => u.nativeId), ['03-01']);
    assert.ok(!res.units[0].nativeId.includes('ABC'));
  });
});

describe('a repeat is counted and never read', () => {
  it('reset, a new id: the oldest archive dir is the unit, the live dir is repeat_id, dup_ids stays 0', () => {
    const { expect: want } = STOCK_LAYOUTS.reset;
    const top = tmp('scan-reset');
    STOCK_LAYOUTS.reset.build(top, { home: top });
    // The live dir also holds a SUMMARY: it is the second dir's file and must reach no artifact of the unit.
    writePlanningDir(top, { under: 'phases', name: '01-new', files: { '01-01-SUMMARY.md': planText({ tier: 'B' }) } });
    const res = scanRepo({ top, home: tmp('scan-reset-home') });
    assert.equal(res.units.length, 1);
    assert.equal(res.units[0].dirRel, want.units[0].dirRel);
    assert.deepEqual(res.units[0].artifacts.map((a) => a.relPath), ['.planning/milestones/v1.0-phases/01-setup/01-01-PLAN.md']);
    assert.equal(res.dupIds, 0);
    assert.deepEqual(res.repeatDirs, want.repeatDirs);
    assert.deepEqual(res.repeatIds, [{ kind: 'plan', nativeId: '01-01', dirRel: '.planning/phases/01-new' }]);
    assert.equal(counters(res).repeat_id, 1);
  });

  it('reset, a known id: the stored live dir is the unit and the archive dir is the repeat', () => {
    const { expect: want } = STOCK_LAYOUTS.reset;
    const top = tmp('scan-reset-known');
    STOCK_LAYOUTS.reset.build(top, { home: top });
    const res = scanRepo({ top, knownPlans: new Map(Object.entries(want.knownPlans)), home: tmp('scan-reset-known-home') });
    assert.equal(res.units.length, 1);
    assert.equal(res.units[0].dirRel, want.known.units[0].dirRel);
    assert.equal(res.units[0].artifacts.find((a) => a.role === 'plan').tierLetter, 'B');
    assert.deepEqual(res.repeatDirs, want.known.repeatDirs);
    assert.equal(res.dupIds, 0);
  });

  it('two archive roots: v1.2 is chosen, v1.10 is the repeat (natural order, not bytewise)', () => {
    const top = tmp('scan-two-roots');
    const mk = (under, name) => writePlanningDir(top, { under, name, files: { '01-01-PLAN.md': planText({ tier: 'B' }) } });
    mk('milestones/v1.10-phases', '01-ten');
    mk('milestones/v1.2-phases', '01-two');
    const res = scanRepo({ top, home: tmp('scan-two-roots-home') });
    assert.equal(res.units[0].dirRel, '.planning/milestones/v1.2-phases/01-two');
    assert.deepEqual(res.repeatDirs, ['.planning/milestones/v1.10-phases/01-ten']);
    assert.equal(res.dupIds, 0);
  });

  it('a second dir in the same root stays dup_ids, with no repeat', () => {
    const top = tmp('scan-dup');
    const mk = (name) => writePlanningDir(top, { under: 'phases', name, files: { '01-01-PLAN.md': planText({ tier: 'B' }) } });
    mk('01-setup');
    mk('01-setup-copy');
    const res = scanRepo({ top, home: tmp('scan-dup-home') });
    assert.equal(res.units[0].dirRel, '.planning/phases/01-setup');
    assert.equal(res.dupIds, 1);
    assert.deepEqual(res.repeatDirs, []);
    assert.deepEqual(res.repeatIds, []);
  });

  it('the same rules hold for a quick id repeated in an archive quick root', () => {
    const top = tmp('scan-quick-repeat');
    const mk = (under, name) => writePlanningDir(top, { under, name, files: { '260101-abc-PLAN.md': planText({ tier: 'C' }) } });
    mk('milestones/v1.0-quick', '260101-abc-old');
    mk('quick', '260101-abc-new');
    const res = scanRepo({ top, home: tmp('scan-quick-repeat-home') });
    assert.equal(res.units[0].dirRel, '.planning/milestones/v1.0-quick/260101-abc-old');
    assert.deepEqual(res.repeatIds, [{ kind: 'quick', nativeId: '260101-abc', dirRel: '.planning/quick/260101-abc-new' }]);
    assert.equal(res.dupIds, 0);
  });
});

// An independent walk of the phase roots: every regular file whose name ends PLAN.md, counted without the adapter's rules.
function planFilesUnder(top, relDirs) {
  let n = 0;
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(join(top, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('PLAN.md')) n += 1;
      else if (e.isDirectory()) walk(`${rel}/${e.name}`);
    }
  };
  for (const rel of relDirs) walk(rel);
  return n;
}
const phaseRootsOf = (top) => {
  const roots = ['.planning/phases'];
  let kids = [];
  try { kids = readdirSync(join(top, '.planning', 'milestones'), { withFileTypes: true }); } catch { /* no milestones */ }
  for (const k of kids) if (k.isDirectory() && k.name.endsWith('-phases')) roots.push(`.planning/milestones/${k.name}`);
  return roots;
};
const isPhaseDir = (rel) => /^\.planning\/(phases|milestones\/[^/]+-phases)\//.test(rel);

describe('no PLAN-named file is dropped silently (conservation)', () => {
  // units read + the plan files of the dup and repeat second dirs + skipped plan files + the not_read plan-form counters
  const accounted = (top, res) => res.plan
    + planFilesUnder(top, [...res.dupDirs, ...res.repeatDirs].filter(isPhaseDir))
    + res.skippedPaths.filter((p) => p.endsWith('PLAN.md')).length
    + ['not_read_bare_plan', 'not_read_plan_id_1seg', 'not_read_plan_id_3seg', 'not_read_plan_file_other',
      'not_read_plan_file_coded'].reduce((n, k) => n + countOf(res, k), 0);

  for (const name of Object.keys(STOCK_LAYOUTS)) {
    it(`the ${name} layout`, () => {
      const top = tmp(`scan-cons-${name}`);
      STOCK_LAYOUTS[name].build(top, { home: top });
      const res = scanRepo({ top, home: tmp(`scan-cons-${name}-home`) });
      const walked = planFilesUnder(top, phaseRootsOf(top));
      assert.equal(accounted(top, res), walked, JSON.stringify({ walked, plan: res.plan }));
    });
  }

  it('the adapter-home fixture (duplicate dir, misplaced plan id)', () => {
    const ctx = makeHome();
    try {
      const built = buildAdapterHome({ home: ctx.home, root: ctx.root });
      const res = scanRepo({ top: built.omega, home: ctx.home });
      assert.equal(accounted(built.omega, res), planFilesUnder(built.omega, phaseRootsOf(built.omega)));
      assert.ok(res.dupDirs.length > 0 && res.skippedPaths.some((p) => p.endsWith('PLAN.md')), 'the fixture exercises both branches');
    } finally {
      ctx.cleanup();
    }
  });

  it('workstream plan files are counted by their own walk', () => {
    const top = tmp('scan-cons-ws');
    STOCK_LAYOUTS.workstreams.build(top, { home: top });
    const res = scanRepo({ top, home: tmp('scan-cons-ws-home') });
    assert.equal(countOf(res, 'not_read_workstream_plan_files'), planFilesUnder(top, ['.planning/workstreams']));
  });
});

describe('symlinks and bad names in the new roots', () => {
  // A directory outside the tree that holds a valid layout; a link to it must never be followed.
  const outside = (build) => {
    const dir = tmp('scan-outside');
    build(dir);
    return dir;
  };
  const planFiles = { '01-01-PLAN.md': planText({ tier: 'B' }) };

  it('a symlinked .planning/milestones is skipped, not followed', () => {
    const top = tmp('scan-sym-milestones');
    const target = outside((d) => writePlanningDir(d, { under: 'v1.0-phases', name: '01-setup', files: planFiles }));
    mkdirSync(join(top, '.planning'), { recursive: true });
    symlinkSync(join(target, '.planning'), join(top, '.planning', 'milestones'));
    const res = scanRepo({ top, home: tmp('scan-sym-milestones-home') });
    assert.equal(res.units.length, 0);
    assert.ok(res.skippedPaths.includes('.planning/milestones'));
  });

  it('a symlinked archive root is skipped, not followed', () => {
    const top = tmp('scan-sym-root');
    const target = outside((d) => writePlanningDir(d, { under: '', name: '01-setup', files: planFiles }));
    mkdirSync(join(top, '.planning', 'milestones'), { recursive: true });
    symlinkSync(join(target, '.planning', '01-setup'), join(top, '.planning', 'milestones', 'v1.0-phases'));
    const res = scanRepo({ top, home: tmp('scan-sym-root-home') });
    assert.equal(res.units.length, 0);
    assert.ok(res.skippedPaths.includes('.planning/milestones/v1.0-phases'));
  });

  it('a symlinked phase dir in an archive root and in the live root is skipped', () => {
    const top = tmp('scan-sym-phase');
    const target = outside((d) => writePlanningDir(d, { under: '', name: '01-setup', files: planFiles }));
    const real = join(target, '.planning', '01-setup');
    mkdirSync(join(top, '.planning', 'milestones', 'v1.0-phases'), { recursive: true });
    mkdirSync(join(top, '.planning', 'phases'), { recursive: true });
    symlinkSync(real, join(top, '.planning', 'milestones', 'v1.0-phases', '01-setup'));
    symlinkSync(real, join(top, '.planning', 'phases', '01-live'));
    const res = scanRepo({ top, home: tmp('scan-sym-phase-home') });
    assert.equal(res.units.length, 0);
    assert.deepEqual([...res.skippedPaths].sort(), ['.planning/milestones/v1.0-phases/01-setup', '.planning/phases/01-live']);
  });

  it('a symlinked workstream dir and a symlinked workstream phases dir are skipped and read for nothing', () => {
    const top = tmp('scan-sym-ws');
    const target = outside((d) => writePlanningDir(d, { under: 'phases', name: '01-x', files: planFiles }));
    mkdirSync(join(top, '.planning', 'workstreams', 'real'), { recursive: true });
    symlinkSync(join(target, '.planning'), join(top, '.planning', 'workstreams', 'linked'));
    symlinkSync(join(target, '.planning', 'phases'), join(top, '.planning', 'workstreams', 'real', 'phases'));
    const res = scanRepo({ top, home: tmp('scan-sym-ws-home') });
    assert.equal(res.units.length, 0);
    assert.ok(res.skippedPaths.includes('.planning/workstreams/linked'));
    assert.ok(res.skippedPaths.includes('.planning/workstreams/real/phases'));
    assert.equal(countOf(res, 'not_read_workstream_plan_files'), 0);
  });

  it('a name outside the shape or holding .. is skipped in every new root, never read', () => {
    const top = tmp('scan-badname');
    writePlanningDir(top, { under: 'milestones', name: 'v1..0-phases', files: {} });
    writePlanningDir(top, { under: 'milestones/v1.0-phases', name: '01 bad', files: planFiles });
    writePlanningDir(top, { under: 'milestones/v1.0-phases', name: '01-a..b', files: planFiles });
    writePlanningDir(top, { under: 'milestones/v1.0-quick', name: '260101-abc-x..y', files: {} });
    writePlanningDir(top, { under: 'workstreams', name: 'bad ws', files: {} });
    const res = scanRepo({ top, home: tmp('scan-badname-home') });
    assert.equal(res.units.length, 0);
    assert.deepEqual([...res.skippedPaths].sort(), [
      '.planning/milestones/v1..0-phases',
      '.planning/milestones/v1.0-phases/01 bad',
      '.planning/milestones/v1.0-phases/01-a..b',
      '.planning/milestones/v1.0-quick/260101-abc-x..y',
      '.planning/workstreams/bad ws',
    ]);
    assert.equal(countOf(res, 'not_read_workstream_dir'), 0);
  });

  it('an archive root with a 65-character label is not a root and is counted under milestones_other_dir', () => {
    const top = tmp('scan-longlabel');
    writePlanningDir(top, { under: `milestones/${'a'.repeat(65)}-phases`, name: '01-setup', files: planFiles });
    const res = scanRepo({ top, home: tmp('scan-longlabel-home') });
    assert.equal(res.units.length, 0);
    assert.equal(countOf(res, 'not_read_milestones_other_dir'), 1);
  });

  it('a quick id in an archive quick root is read exactly like the live quick rule', () => {
    const top = tmp('scan-quick-archive');
    writePlanningDir(top, { under: 'milestones/v1.0-quick', name: '260101-abc-task', files: { '260101-abc-PLAN.md': planText({ tier: 'C' }) } });
    writePlanningDir(top, { under: 'milestones/v1.0-quick', name: 'no-quick-id', files: {} });
    const res = scanRepo({ top, home: tmp('scan-quick-archive-home') });
    assert.deepEqual(res.units.map((u) => [u.kind, u.nativeId, u.idDate]), [['quick', '260101-abc', '2026-01-01']]);
    assert.equal(countOf(res, 'not_read_quick_dir_name'), 1);
  });
});

describe('a quick-root dir with a bad name and no quick id is counted (review WR-04)', () => {
  it('.planning/quick/notes here and an archive-root twin land in not_read_quick_dir_name, never a unit', () => {
    const top = tmp('scan-quick-badname');
    writePlanningDir(top, { under: 'quick', name: 'notes here', files: {} });
    writePlanningDir(top, { under: 'quick', name: 'a..b', files: {} });
    writePlanningDir(top, { under: 'milestones/v1.0-quick', name: 'old notes', files: {} });
    const res = scanRepo({ top, home: tmp('scan-quick-badname-home') });
    assert.equal(res.units.length, 0);
    assert.deepEqual([...(res.notRead.not_read_quick_dir_name ?? [])].sort(), [
      '.planning/milestones/v1.0-quick/old notes',
      '.planning/quick/a..b',
      '.planning/quick/notes here',
    ]);
  });
});

describe('workstream listing is bounded', () => {
  it('lists at most 256 workstream dirs and counts the rest in skipped', () => {
    const top = tmp('scan-ws-bound');
    for (let i = 0; i < 258; i += 1) mkdirSync(join(top, '.planning', 'workstreams', `w${String(i).padStart(3, '0')}`), { recursive: true });
    const res = scanRepo({ top, home: tmp('scan-ws-bound-home') });
    assert.equal(countOf(res, 'not_read_workstream_dir'), 256);
    assert.equal(res.skipped, 2);
  });

  // The cap of names read under the workstreams of one tree is 4096 (MAX_WORKSTREAM_NAMES), phase dirs and files together.
  it('reads at most 4096 names in one phase dir and counts the dir in skipped (review WR-03)', () => {
    const top = tmp('scan-ws-names');
    const dir = join(top, '.planning', 'workstreams', 'w', 'phases', '01-big');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 4100; i += 1) writeFileSync(join(dir, `${String(i).padStart(4, '0')}-PLAN.md`), '');
    const res = scanRepo({ top, home: tmp('scan-ws-names-home') });
    assert.ok(countOf(res, 'not_read_workstream_plan_files') <= 4096, 'no more than the cap is counted');
    assert.ok(countOf(res, 'not_read_workstream_plan_files') > 4000, 'the names under the cap are counted');
    assert.ok(res.skippedPaths.includes('.planning/workstreams/w/phases/01-big'));
  });

  it('stops listing phase dirs at the cap, counts the phases dir in skipped and reads nothing of a later workstream (review WR-02)', () => {
    const top = tmp('scan-ws-phases');
    const phases = join(top, '.planning', 'workstreams', 'a', 'phases');
    for (let i = 0; i < 4200; i += 1) mkdirSync(join(phases, `p${String(i).padStart(4, '0')}`), { recursive: true });
    mkdirSync(join(top, '.planning', 'workstreams', 'b', 'phases', '01-late'), { recursive: true });
    writeFileSync(join(top, '.planning', 'workstreams', 'b', 'phases', '01-late', '01-01-PLAN.md'), '');
    const res = scanRepo({ top, home: tmp('scan-ws-phases-home') });
    assert.ok(res.skippedPaths.includes('.planning/workstreams/a/phases'), 'the phases dir past the cap is counted');
    assert.ok(res.skippedPaths.includes('.planning/workstreams/b'), 'a workstream after the budget is spent is counted, not read');
    assert.equal(countOf(res, 'not_read_workstream_plan_files'), 0);
    assert.equal(countOf(res, 'not_read_workstream_dir'), 2, 'both workstream dirs are still counted by name');
  });

  it('keeps at most 4096 paths per counter and counts the overflow in skipped (review WR-02)', () => {
    const top = tmp('scan-note-cap');
    for (let i = 0; i < 4100; i += 1) mkdirSync(join(top, '.planning', 'milestones', `d${String(i).padStart(4, '0')}`), { recursive: true });
    const res = scanRepo({ top, home: tmp('scan-note-cap-home') });
    assert.equal(countOf(res, 'not_read_milestones_other_dir'), 4096);
    assert.ok(res.skipped >= 1, 'the overflow is visible in skipped');
  });
});

describe('scanRepo: move candidates and dup entries (plan 03.1-02, D-02, D-18)', () => {
  it('lists an archive dir of a known id as a candidate with its basename and tree, and reads nothing for it', () => {
    const top = tmp('scan-cand');
    writePlanningDir(top, { under: 'milestones/v1.0-phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'A' }) } });
    const res = scanRepo({ top, knownPlans: new Map([['01-01', '.planning/phases/01-setup']]), home: tmp('scan-cand-home') });
    assert.deepEqual(res.units, []);
    assert.deepEqual(res.moveCandidates, [{
      kind: 'plan', nativeId: '01-01', dirRel: '.planning/milestones/v1.0-phases/01-setup', basename: '01-setup', top,
    }]);
    assert.deepEqual(res.repeatDirs, ['.planning/milestones/v1.0-phases/01-setup']);
  });

  it('a live repeat of a new id is no candidate, and a quick archive dir of a known quick id is', () => {
    const top = tmp('scan-cand-live');
    STOCK_LAYOUTS.reset.build(top, { home: top });
    const res = scanRepo({ top, home: tmp('scan-cand-live-home') });
    assert.deepEqual(res.moveCandidates, []);
    const top2 = tmp('scan-cand-quick');
    writePlanningDir(top2, { under: 'milestones/v1.0-quick', name: '260101-abc-task', files: { '260101-abc-PLAN.md': planText({ tier: 'C' }) } });
    const res2 = scanRepo({ top: top2, known: new Map([['260101-abc', '.planning/quick/260101-abc-task']]), home: tmp('scan-cand-quick-home') });
    assert.deepEqual(res2.moveCandidates.map((c) => [c.kind, c.nativeId, c.basename]), [['quick', '260101-abc', '260101-abc-task']]);
  });

  it('a second dir in the stored root is reported as a dup entry with its id, an archive dir is not', () => {
    const top = tmp('scan-dupentry');
    writePlanningDir(top, { under: 'phases', name: '01-new', files: { '01-01-PLAN.md': planText({ tier: 'B' }) } });
    const res = scanRepo({ top, knownPlans: new Map([['01-01', '.planning/phases/01-setup']]), home: tmp('scan-dupentry-home') });
    assert.deepEqual(res.dupEntries, [{ kind: 'plan', nativeId: '01-01', dirRel: '.planning/phases/01-new' }]);
    assert.equal(res.dupIds, 1);
    assert.deepEqual(res.moveCandidates, []);
  });
});

describe('readUnitAt: the unit row of one dir', () => {
  it('returns the artifacts and files_modified of an archive plan dir, with the dir given', () => {
    const top = tmp('readat');
    writePlanningDir(top, {
      under: 'milestones/v1.0-phases',
      name: '01-setup',
      files: {
        '01-01-PLAN.md': planText({ tier: 'A', extra: ['files_modified:', '  - src/a.mjs'] }),
        '01-01-SUMMARY.md': planText({ tier: 'A' }),
      },
    });
    const u = readUnitAt({
      top, kind: 'plan', nativeId: '01-01', dirRel: '.planning/milestones/v1.0-phases/01-setup', home: tmp('readat-home'),
    });
    assert.equal(u.kind, 'plan');
    assert.equal(u.nativeId, '01-01');
    assert.equal(u.dirRel, '.planning/milestones/v1.0-phases/01-setup');
    assert.deepEqual(u.artifacts.map((a) => a.relPath), [
      '.planning/milestones/v1.0-phases/01-setup/01-01-PLAN.md',
      '.planning/milestones/v1.0-phases/01-setup/01-01-SUMMARY.md',
    ]);
    assert.equal(u.artifacts[0].tierLetter, 'A');
    assert.deepEqual(u.filesModified, ['src/a.mjs']);
    assert.equal(u.idDate, null);
  });

  it('reads the id date of a quick dir and answers no artifacts for a dir that is gone', () => {
    const top = tmp('readat-quick');
    writePlanningDir(top, { under: 'milestones/v1.0-quick', name: '260101-abc-task', files: { '260101-abc-PLAN.md': planText({ tier: 'C' }) } });
    const u = readUnitAt({
      top, kind: 'quick', nativeId: '260101-abc', dirRel: '.planning/milestones/v1.0-quick/260101-abc-task', home: tmp('readat-quick-home'),
    });
    assert.equal(u.idDate, '2026-01-01');
    assert.equal(u.artifacts.length, 1);
    const gone = readUnitAt({
      top, kind: 'quick', nativeId: '260101-abc', dirRel: '.planning/milestones/v1.0-quick/260101-abc-gone', home: tmp('readat-quick-home2'),
    });
    assert.deepEqual(gone.artifacts, []);
  });
});
