// Integration tests of the moved-unit rule (plan 03.1-02, ADPT-05, D-01, D-02, D-18, D-22, D-23): a unit whose dir moves into
// a milestone archive keeps its key, its first dir_rel, its tier, its artifacts and its cost, and stays present. The CLI is
// spawned on a temporary HOME from makeHome(); every fixture repo is built by test/fixtures/git-repo.mjs inside that HOME and
// reached through RIGORSCOPE_REPO_ROOTS; the stores are read with queryDb only. No literal for the latest store version.
// Expectations are written by hand from the plan (the case table of 03.1-02-PLAN.md), never from the adapter.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  cliEnv, makeHome, queryDb, runCli, stateDirOf,
} from '../fixtures/build.mjs';
import {
  addWorktree, archiveDir, commitAll, commitAt, makeRepo, planText, writePlanningDir,
} from '../fixtures/git-repo.mjs';
import { LINK_EXPECTED, LINK_TIMES, buildLinkHome } from '../fixtures/link-home.mjs';
import { STOCK_LAYOUTS } from '../fixtures/stock-layouts.mjs';
import { storePath } from '../../src/db.mjs';
import { memberArtifacts } from '../../src/derive/unit-fill.mjs';
import { unitKeyOf } from '../../src/units/unit-key.mjs';
import { LOCATION_KINDS } from '../../src/adapters/gsd-core/layout.mjs';

const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const SHOWN = LOCATION_KINDS.filter((k) => k !== 'trees_scanned');
const LIVE = '.planning/phases/01-setup';
const ARCHIVE = '.planning/milestones/v1.0-phases/01-setup';
const QLIVE = '.planning/quick/260101-abc-task';
const QARCHIVE = '.planning/milestones/v1.0-quick/260101-abc-task';

// A home with one repo at <home>/src/<name>, built by build(repo, home) and committed, reached through the roots variable.
function setup(name, build) {
  const ctx = makeHome();
  const repo = join(ctx.home, 'src', name);
  makeRepo(repo, { home: ctx.home, files: { 'README.md': `${name}\n` } });
  build(repo, ctx.home);
  commitAll(repo, { home: ctx.home });
  const env = cliEnv(ctx.home, { TZ: 'UTC', RIGORSCOPE_REPO_ROOTS: repo });
  return {
    ctx, repo, env, home: ctx.home, repoKey: `~/src/${name}/.git`,
  };
}
const ingest = (s) => {
  const r = runCli(['ingest'], { home: s.home, env: s.env });
  assert.equal(r.status, 0, r.stderr);
  return linesOf(r.stdout);
};
const unitsDoc = (s) => {
  const r = runCli(['units', '--json'], { home: s.home, env: s.env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const locationsOf = (lines) => {
  const line = lines.find((l) => l.startsWith('locations: '));
  assert.ok(line, 'a locations line');
  return Object.fromEntries(line.slice('locations: '.length).split(' ').map((t) => t.split('=')));
};
const storeRows = (s, sql, params = []) => queryDb(storePath(s.home), sql, params);
const derivedRows = (s, sql, params = []) => queryDb(join(stateDirOf(s.home), 'derived.db'), sql, params);
const unitOf = (s, key) => unitsDoc(s).units.find((u) => u.key === key);
const planFiles = { '01-01-PLAN.md': planText({ tier: 'A' }), '01-01-SUMMARY.md': planText({ tier: 'A' }) };
const OBS = 'SELECT dir_rel, first_seen_run, last_seen_run FROM unit_obs WHERE unit_key = ?';
const lastScanned = (s) => storeRows(s, 'SELECT last_scanned_run AS r FROM repo WHERE repo_key = ?', [s.repoKey])[0].r;
const artifactPaths = (s, key) => storeRows(s, 'SELECT rel_path FROM unit_artifact WHERE unit_key = ? ORDER BY rel_path', [key]).map((r) => r.rel_path);

describe('tracer: a plan unit moved into the archive keeps key, tier, artifacts and stays present', () => {
  let s;
  let key;
  let firstRun;
  let first;
  let second;
  let third;
  before(() => {
    s = setup('mv', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    key = unitKeyOf(s.repoKey, 'plan', '01-01');
    first = ingest(s);
    firstRun = storeRows(s, OBS, [key])[0];
    archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.0' });
    commitAll(s.repo, { home: s.home });
    second = ingest(s);
    third = ingest(s);
  });
  after(() => s.ctx.cleanup());

  it('a moved unit keeps key and first dir_rel', () => {
    assert.equal(firstRun.dir_rel, LIVE);
    const rows = storeRows(s, 'SELECT unit_key, dir_rel, first_seen_run FROM unit_obs');
    assert.deepEqual(rows.map((r) => [r.unit_key, r.dir_rel, r.first_seen_run]), [[key, LIVE, firstRun.first_seen_run]]);
    const u = unitOf(s, key);
    assert.ok(u, 'the same key is listed');
    assert.equal(u.dir, LIVE, 'units --json dir is the stored first dir');
    assert.equal(u.present, true);
    assert.equal(u.tier.value, 'A');
  });

  it('last_seen_run advances to the last scanned run of the repo, on the move and on an unchanged run', () => {
    const run = lastScanned(s);
    assert.ok(run > firstRun.last_seen_run);
    assert.equal(storeRows(s, OBS, [key])[0].last_seen_run, run);
  });

  it('a moved file counts once: two artifacts, one plan and one summary, and no stored row is dropped', () => {
    const u = unitOf(s, key);
    assert.equal(u.artifacts.plan, 1);
    assert.equal(u.artifacts.summary, 1);
    assert.deepEqual(derivedRows(s, 'SELECT role, n FROM unit_role WHERE unit_key = ? ORDER BY role', [key]), [
      { role: 'plan', n: 1 }, { role: 'summary', n: 1 },
    ]);
    assert.deepEqual(artifactPaths(s, key), [
      `${LIVE}/01-01-PLAN.md`, `${LIVE}/01-01-SUMMARY.md`, `${ARCHIVE}/01-01-PLAN.md`, `${ARCHIVE}/01-01-SUMMARY.md`,
    ].sort());
  });

  it('prints moved=1 on the run that sees the move and moved=0 on an unchanged run, both present', () => {
    const l1 = locationsOf(first);
    assert.equal(l1.moved, '0');
    assert.equal(locationsOf(second).moved, '1');
    assert.equal(locationsOf(second).move_ambiguous, '0');
    assert.equal(locationsOf(third).moved, '0');
    assert.equal(locationsOf(second).repeat_id, '0', 'the claimed archive dir is no repeat');
    assert.equal(unitOf(s, key).present, true);
    assert.deepEqual(Object.keys(locationsOf(third)), ['repos', ...SHOWN]);
  });

  it('writes moved to ingest_count with the repo key as the name, only for the run that saw it', () => {
    const rows = storeRows(s, "SELECT run_id, name, n FROM ingest_count WHERE source = 'units' AND kind = 'moved'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, s.repoKey);
    assert.equal(rows[0].n, 1);
  });
});

describe('tracer twin: a quick unit moved into milestones/v1.0-quick', () => {
  let s;
  let key;
  before(() => {
    s = setup('mvq', (repo) => writePlanningDir(repo, {
      under: 'quick',
      name: '260101-abc-task',
      files: { '260101-abc-PLAN.md': planText({ tier: 'C' }), '260101-abc-SUMMARY.md': planText({ tier: 'C' }) },
    }));
    key = unitKeyOf(s.repoKey, 'quick', '260101-abc');
    ingest(s);
    archiveDir(s.repo, { home: s.home, name: '260101-abc-task', label: 'v1.0', kind: 'quick' });
    commitAll(s.repo, { home: s.home });
  });
  after(() => s.ctx.cleanup());

  it('a moved unit keeps key and first dir_rel, tier, two artifacts, present, moved=1 then 0', () => {
    const second = ingest(s);
    assert.equal(locationsOf(second).moved, '1');
    const u = unitOf(s, key);
    assert.equal(u.dir, QLIVE);
    assert.equal(u.present, true);
    assert.equal(u.tier.value, 'C');
    assert.equal(u.artifacts.plan, 1);
    assert.equal(u.artifacts.summary, 1);
    assert.deepEqual(storeRows(s, OBS, [key]).map((r) => r.dir_rel), [QLIVE]);
    assert.ok(artifactPaths(s, key).includes(`${QARCHIVE}/260101-abc-PLAN.md`), 'the archive copy is recorded');
    const third = ingest(s);
    assert.equal(locationsOf(third).moved, '0');
    assert.equal(unitOf(s, key).present, true);
  });
});

describe('cost and the tool-path link are identical before and after the move (D-02)', () => {
  let ctx;
  let before1;
  let after1;
  const q1a = LINK_EXPECTED.units.q1a;
  const env = (home) => cliEnv(home, { TZ: 'UTC', RIGORSCOPE_NOW: LINK_TIMES.now });
  const snapshot = (home) => {
    const r = runCli(['units', '--json'], { home, env: env(home) });
    assert.equal(r.status, 0, r.stderr);
    const u = JSON.parse(r.stdout).units.find((x) => x.key === q1a);
    const links = queryDb(
      join(stateDirOf(home), 'derived.db'),
      "SELECT session_id, agent_id, method, confidence FROM unit_link WHERE unit_key = ? AND method = 'tool-path' ORDER BY session_id, agent_id",
      [q1a],
    );
    return { cost: u.cost, links, present: u.present, dir: u.dir };
  };
  before(() => {
    ctx = makeHome();
    const built = buildLinkHome({ home: ctx.home, root: ctx.root });
    const ing = () => {
      const r = runCli(['ingest'], { home: ctx.home, env: env(ctx.home) });
      assert.equal(r.status, 0, r.stderr);
      return linesOf(r.stdout);
    };
    ing();
    before1 = snapshot(ctx.home);
    // The unit's quick dir lives in the main tree and in the linked worktree: archive it in both, as a real archive does.
    for (const top of [built.alpha, built.worktree]) {
      archiveDir(top, { home: ctx.home, name: '261001-q1a-one', label: 'v1.0', kind: 'quick' });
      commitAt(top, { home: ctx.home, date: '2026-10-09T12:00:00Z', message: 'docs: archive quick' });
    }
    ctx.second = ing();
    after1 = snapshot(ctx.home);
  });
  after(() => ctx.cleanup());

  it('the move was read', () => {
    assert.equal(locationsOf(ctx.second).moved, '1');
  });

  it('the attributed cost block is identical and non-trivial', () => {
    assert.ok(before1.cost.usd_nano > 0, 'the unit has a priced cost');
    assert.deepEqual(after1.cost, before1.cost);
  });

  it('the tool-path link rows are identical and the unit is present at its stored dir', () => {
    assert.ok(before1.links.length >= 1, 'the unit has a tool-path link');
    assert.deepEqual(after1.links, before1.links);
    assert.equal(after1.present, true);
    assert.equal(after1.dir, before1.dir);
  });
});

describe('collision and ambiguity are counted, never merged', () => {
  it('row a: a linked worktree that still holds the stored dir keeps the unit read there; the archive copy is a repeat', () => {
    const s = setup('rowa', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    try {
      const wt = join(s.home, 'wt', 'w1');
      addWorktree(s.repo, wt, 'w1', { home: s.home });
      ingest(s);
      archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.0' });
      commitAll(s.repo, { home: s.home });
      const l = locationsOf(ingest(s));
      const key = unitKeyOf(s.repoKey, 'plan', '01-01');
      assert.equal(l.moved, '0');
      assert.equal(l.repeat_id, '1');
      assert.equal(unitOf(s, key).present, true);
      assert.deepEqual(artifactPaths(s, key), [`${LIVE}/01-01-PLAN.md`, `${LIVE}/01-01-SUMMARY.md`]);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('row a: the stored dir still on disk beside an archive copy is read; the archive copy is a repeat', () => {
    const s = setup('rowa2', (repo) => {
      writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles });
      writePlanningDir(repo, { under: 'milestones/v1.0-phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'B' }) } });
    });
    try {
      const l = locationsOf(ingest(s));
      const key = unitKeyOf(s.repoKey, 'plan', '01-01');
      // A new id: the oldest archive root is read first (plan 03.1-01), so both are in one scan and the live dir is the repeat.
      assert.equal(l.moved, '0');
      assert.equal(l.repeat_id, '1');
      assert.equal(unitOf(s, key).present, true);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('row a: the stored dir still on disk with no readable unit in it (its PLAN removed) wins: the archive copy is a repeat, not a move', () => {
    const s = setup('rowa3', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    try {
      ingest(s);
      const key = unitKeyOf(s.repoKey, 'plan', '01-01');
      writePlanningDir(s.repo, { under: 'milestones/v1.0-phases', name: '01-setup', files: planFiles });
      rmSync(join(s.repo, LIVE, '01-01-PLAN.md'));
      const l = locationsOf(ingest(s));
      assert.equal(l.moved, '0');
      assert.equal(l.repeat_id, '1');
      assert.equal(unitOf(s, key).present, false, 'nothing is read for the id');
      assert.deepEqual(artifactPaths(s, key), [`${LIVE}/01-01-PLAN.md`, `${LIVE}/01-01-SUMMARY.md`]);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('row c: two archive dirs with the stored basename are move_ambiguous: nothing read, the unit not present, both repeats', () => {
    const s = setup('rowc', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    try {
      ingest(s);
      const key = unitKeyOf(s.repoKey, 'plan', '01-01');
      archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.0' });
      writePlanningDir(s.repo, { under: 'milestones/v2.0-phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'B' }) } });
      commitAll(s.repo, { home: s.home });
      const l = locationsOf(ingest(s));
      assert.equal(l.moved, '0');
      assert.equal(l.move_ambiguous, '1');
      assert.equal(l.repeat_id, '2');
      assert.equal(unitOf(s, key).present, false);
      assert.deepEqual(artifactPaths(s, key), [`${LIVE}/01-01-PLAN.md`, `${LIVE}/01-01-SUMMARY.md`], 'neither archive dir was read');
      assert.equal(unitOf(s, key).tier.value, 'A');
    } finally {
      s.ctx.cleanup();
    }
  });

  it('row d: the stored dir removed and no archive copy: not present, nothing counted', () => {
    const s = setup('rowd', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    try {
      ingest(s);
      const key = unitKeyOf(s.repoKey, 'plan', '01-01');
      rmSync(join(s.repo, LIVE), { recursive: true });
      commitAll(s.repo, { home: s.home });
      const l = locationsOf(ingest(s));
      for (const k of ['moved', 'move_ambiguous', 'repeat_id']) assert.equal(l[k], '0', k);
      assert.equal(unitOf(s, key).present, false);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('row d: a dir renamed to a new basename and then archived is not a move but a repeat', () => {
    const s = setup('rowd2', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    try {
      ingest(s);
      const key = unitKeyOf(s.repoKey, 'plan', '01-01');
      renameSync(join(s.repo, LIVE), join(s.repo, '.planning/phases/01-renamed'));
      archiveDir(s.repo, { home: s.home, name: '01-renamed', label: 'v1.0', track: false });
      commitAll(s.repo, { home: s.home });
      const l = locationsOf(ingest(s));
      assert.equal(l.moved, '0');
      assert.equal(l.move_ambiguous, '0');
      assert.equal(l.repeat_id, '1');
      assert.equal(unitOf(s, key).present, false);
      assert.deepEqual(artifactPaths(s, key), [`${LIVE}/01-01-PLAN.md`, `${LIVE}/01-01-SUMMARY.md`]);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('row e / reset: the unit stored from 01-setup is moved; the new live 01-new with the same id is a repeat and is never merged', () => {
    const s = setup('rowe', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    try {
      ingest(s);
      const key = unitKeyOf(s.repoKey, 'plan', '01-01');
      archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.0' });
      writePlanningDir(s.repo, {
        under: 'phases', name: '01-new', files: { '01-01-PLAN.md': planText({ tier: 'C' }), '01-01-SUMMARY.md': planText({ tier: 'C' }) },
      });
      commitAll(s.repo, { home: s.home });
      const lines = ingest(s);
      const l = locationsOf(lines);
      assert.equal(l.moved, '1');
      assert.equal(l.repeat_id, '1', '01-new is repeat_id, counted relative to the moved dir');
      assert.equal(lines.find((x) => x.startsWith('units: ')).match(/ dup_ids=(\d+) /)[1], '0', 'and not dup_ids');
      assert.deepEqual(
        storeRows(s, "SELECT name, n FROM ingest_count WHERE source = 'units' AND kind = 'repeat_id'"),
        [{ name: key, n: 1 }],
      );
      const u = unitOf(s, key);
      assert.equal(u.present, true);
      assert.equal(u.tier.value, 'A', 'the tier is the stored dir, not the 01-new tier C');
      assert.ok(artifactPaths(s, key).every((p) => !p.includes('01-new')), 'no file of 01-new is an artifact');
    } finally {
      s.ctx.cleanup();
    }
  });
});

describe('interleaving: a unit first seen in an archive stays present and is not a move', () => {
  it('stores the archive dir as dir_rel, reads moved=0 on two ingests and stays present', () => {
    const s = setup('first-arch', (repo) => writePlanningDir(repo, { under: 'milestones/v1.0-phases', name: '01-setup', files: planFiles }));
    try {
      const key = unitKeyOf(s.repoKey, 'plan', '01-01');
      assert.equal(locationsOf(ingest(s)).moved, '0');
      const l2 = locationsOf(ingest(s));
      assert.equal(l2.moved, '0');
      assert.equal(l2.repeat_id, '0');
      assert.deepEqual(storeRows(s, OBS, [key]).map((r) => r.dir_rel), [ARCHIVE]);
      const u = unitOf(s, key);
      assert.equal(u.dir, ARCHIVE);
      assert.equal(u.present, true);
      assert.equal(u.artifacts.plan, 1);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('a unit stored live, moved, and later seen again with its archive dir gone is not present (case d, no live fallback)', () => {
    const s = setup('arch-gone', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    try {
      ingest(s);
      const key = unitKeyOf(s.repoKey, 'plan', '01-01');
      archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.0' });
      commitAll(s.repo, { home: s.home });
      ingest(s);
      assert.equal(unitOf(s, key).present, true);
      rmSync(join(s.repo, '.planning/milestones/v1.0-phases'), { recursive: true });
      commitAll(s.repo, { home: s.home });
      ingest(s);
      assert.equal(unitOf(s, key).present, false);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('the move is read from the working tree: an ingest between git mv and its commit already sees it', () => {
    const s = setup('uncommitted', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    try {
      ingest(s);
      const key = unitKeyOf(s.repoKey, 'plan', '01-01');
      archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.0' });
      assert.equal(locationsOf(ingest(s)).moved, '1');
      assert.equal(unitOf(s, key).present, true);
    } finally {
      s.ctx.cleanup();
    }
  });
});

// Fix round for plan 03.1-02 (review CR-01, CR-02). GSD only moves live -> archive, so the move rule applies to a stored LIVE
// dir, and an archive dir is a move target only when its former live path is the stored dir.
describe('fix round CR-01: an archive-stored unit never claims another milestone archive dir', () => {
  it('the first archive dir removed, a later milestone archive of the same name stays a repeat: not present, not merged', () => {
    const s = setup('cr01', (repo) => {
      writePlanningDir(repo, { under: 'milestones/v1.0-phases', name: '01-setup', files: planFiles });
      writePlanningDir(repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'C' }) } });
    });
    try {
      const key = unitKeyOf(s.repoKey, 'plan', '01-01');
      const l1 = locationsOf(ingest(s));
      assert.equal(l1.repeat_id, '1');
      assert.deepEqual(storeRows(s, OBS, [key]).map((r) => r.dir_rel), [ARCHIVE], 'stored from the oldest archive dir');
      archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.1' });
      commitAll(s.repo, { home: s.home });
      const l2 = locationsOf(ingest(s));
      assert.equal(l2.repeat_id, '1');
      assert.equal(l2.moved, '0');
      rmSync(join(s.repo, '.planning/milestones/v1.0-phases'), { recursive: true });
      commitAll(s.repo, { home: s.home });
      const l3 = locationsOf(ingest(s));
      assert.equal(l3.moved, '0', 'an archive dir is never a move source');
      assert.equal(l3.move_ambiguous, '0');
      assert.equal(l3.repeat_id, '1', 'the v1.1 dir is a repeat of the id');
      assert.equal(unitOf(s, key).present, false, 'the stored archive dir is gone');
      assert.ok(artifactPaths(s, key).every((p) => p.startsWith(`${ARCHIVE}/`)), 'no row of the v1.1 dir is stored under the key');
      assert.ok(artifactPaths(s, key).length >= 1);
      const rep = derivedRows(s, 'SELECT id_repeats FROM unit WHERE unit_key = ?', [key])[0].id_repeats;
      assert.ok(rep >= 1, `id_repeats stays marked, got ${rep}`);
    } finally {
      s.ctx.cleanup();
    }
  });
});

describe('fix round CR-02: a recorded move stays present when a later milestone archives the same name', () => {
  function reuse(name) {
    const s = setup(name, (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    const key = unitKeyOf(s.repoKey, 'plan', '01-01');
    ingest(s);
    archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.0' });
    commitAll(s.repo, { home: s.home });
    assert.equal(locationsOf(ingest(s)).moved, '1');
    writePlanningDir(s.repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'C' }) } });
    commitAll(s.repo, { home: s.home });
    ingest(s);
    return { s, key };
  }

  it('picks the archive dir that already holds the unit rows; the other stays a repeat', () => {
    const { s, key } = reuse('cr02');
    try {
      archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.1' });
      commitAll(s.repo, { home: s.home });
      const l = locationsOf(ingest(s));
      assert.equal(l.move_ambiguous, '0');
      assert.equal(l.moved, '0', 'the move was recorded by an earlier run');
      assert.equal(l.repeat_id, '1', 'only the v1.1 dir is a repeat');
      assert.equal(unitOf(s, key).present, true);
      assert.equal(lastScanned(s), storeRows(s, OBS, [key])[0].last_seen_run);
      assert.ok(artifactPaths(s, key).every((p) => !p.includes('v1.1-phases')), 'nothing of v1.1 is stored under the key');
    } finally {
      s.ctx.cleanup();
    }
  });

  it('with no stored rows under either archive dir the id stays move_ambiguous and is not adopted', () => {
    const s = setup('cr02n', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    try {
      const key = unitKeyOf(s.repoKey, 'plan', '01-01');
      ingest(s);
      archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.0' });
      writePlanningDir(s.repo, { under: 'milestones/v2.0-phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'B' }) } });
      commitAll(s.repo, { home: s.home });
      const l = locationsOf(ingest(s));
      assert.equal(l.move_ambiguous, '1');
      assert.equal(l.moved, '0');
      assert.equal(unitOf(s, key).present, false);
    } finally {
      s.ctx.cleanup();
    }
  });
});

describe('reset layout: the two directions of the stored dir (D-22), through the scan', () => {
  it('stored from 01-new: the archive dir 01-setup stays a repeat and the unit is read from 01-new', () => {
    const s = setup('reset-new', (repo) => STOCK_LAYOUTS.reset.build(repo, {}));
    try {
      // First ingest: the oldest archive root is read first (a new id), so the unit is stored from the archive dir; flip it by
      // hand to the other direction by removing the archive dir for run 1 and restoring it for run 2.
      const archived = join(s.repo, '.planning/milestones');
      const parked = join(s.home, 'parked-milestones');
      renameSync(archived, parked);
      ingest(s);
      renameSync(parked, archived);
      const lines = ingest(s);
      const l = locationsOf(lines);
      const key = unitKeyOf(s.repoKey, 'plan', '01-01');
      assert.deepEqual(storeRows(s, OBS, [key]).map((r) => r.dir_rel), ['.planning/phases/01-new']);
      assert.equal(l.moved, '0');
      assert.equal(l.repeat_id, '1');
      assert.ok(artifactPaths(s, key).every((p) => p.startsWith('.planning/phases/01-new/')), 'only 01-new files');
      assert.equal(unitOf(s, key).tier.value, 'B');
    } finally {
      s.ctx.cleanup();
    }
  });
});

describe('memberArtifacts: canonical-path membership and merge by file name (derive, J2, J3)', () => {
  const row = (relPath, over = {}) => ({
    unit_key: 'k',
    rel_path: relPath,
    role: 'plan',
    mtime_ms: 10,
    first_mtime_ms: 10,
    first_commit_ms: null,
    tier_letter: null,
    tier_place: null,
    tier_commit_ms: null,
    last_commit_ms: null,
    fm_date: null,
    fm_offset_min: null,
    ...over,
  });

  it('a unit with no archive row sees exactly the rows under its dir, in file-name order, paths unchanged', () => {
    const rows = [
      row(`${LIVE}/01-01-SUMMARY.md`, { role: 'summary' }), row(`${LIVE}/01-01-PLAN.md`), row('.planning/phases/02-other/02-01-PLAN.md'),
    ];
    const got = memberArtifacts(rows, LIVE);
    assert.deepEqual(got.map((a) => a.rel_path), [`${LIVE}/01-01-PLAN.md`, `${LIVE}/01-01-SUMMARY.md`]);
  });

  it('a row under a nested subdir of the dir is still a member (the old prefix rule)', () => {
    assert.deepEqual(memberArtifacts([row(`${LIVE}/sub/x.md`)], LIVE).map((a) => a.rel_path), [`${LIVE}/sub/x.md`]);
  });

  it('claims the archive rows of a unit stored live, and merges the two rows of one file name into one record', () => {
    const rows = [
      row(`${ARCHIVE}/01-01-PLAN.md`, {
        mtime_ms: 50, first_mtime_ms: 40, first_commit_ms: 300, tier_commit_ms: 310, last_commit_ms: 400, tier_letter: 'B', tier_place: 'frontmatter',
        fm_date: '2026-01-02', fm_offset_min: 0,
      }),
      row(`${LIVE}/01-01-PLAN.md`, {
        mtime_ms: 20, first_mtime_ms: 5, first_commit_ms: 100, tier_commit_ms: 150, last_commit_ms: 200, tier_letter: 'A', tier_place: 'tier-line',
      }),
      row(`${ARCHIVE}/01-01-SUMMARY.md`, { role: 'summary', tier_letter: 'C', tier_place: 'frontmatter' }),
    ];
    const got = memberArtifacts(rows, LIVE);
    assert.equal(got.length, 2, 'a moved file counts once');
    const plan = got.find((a) => a.role === 'plan');
    assert.equal(plan.rel_path, `${LIVE}/01-01-PLAN.md`, 'the record carries the stored dir');
    assert.deepEqual([plan.tier_letter, plan.tier_place], ['A', 'tier-line'], 'the stored-dir row first');
    assert.equal(plan.first_commit_ms, 100, 'first times: earliest');
    assert.equal(plan.tier_commit_ms, 150);
    assert.equal(plan.first_mtime_ms, 5);
    assert.equal(plan.last_commit_ms, 400, 'last times: latest');
    assert.equal(plan.mtime_ms, 50);
    assert.deepEqual([plan.fm_date, plan.fm_offset_min], ['2026-01-02', 0], 'the date of the first row that has one');
    assert.equal(got.find((a) => a.role === 'summary').rel_path, `${LIVE}/01-01-SUMMARY.md`, 'a lone archive row is rewritten to the stored dir');
  });

  it('a unit stored in the archive claims its former live rows the same way, with the archive path as the record path', () => {
    const rows = [row(`${LIVE}/01-01-PLAN.md`, { tier_letter: 'A', tier_place: 'frontmatter' }), row(`${ARCHIVE}/01-01-PLAN.md`, { tier_letter: 'B', tier_place: 'frontmatter' })];
    const got = memberArtifacts(rows, ARCHIVE);
    assert.equal(got.length, 1);
    assert.equal(got[0].rel_path, `${ARCHIVE}/01-01-PLAN.md`);
    assert.equal(got[0].tier_letter, 'B', 'the stored-dir row (the archive row here) first');
  });

  it('does not claim the rows of a dir with another basename', () => {
    const rows = [
      row('.planning/milestones/v1.0-phases/01-setup/01-01-PLAN.md'), row('.planning/phases/01-new/01-01-PLAN.md', { tier_letter: 'B', tier_place: 'frontmatter' }),
    ];
    const got = memberArtifacts(rows, '.planning/phases/01-new');
    assert.deepEqual(got.map((a) => a.rel_path), ['.planning/phases/01-new/01-01-PLAN.md']);
    assert.equal(got[0].tier_letter, 'B');
  });

  it('does not claim a quick archive row for a phases dir of the same name, nor a milestone-level file', () => {
    const rows = [row('.planning/milestones/v1.0-quick/01-setup/x.md'), row('.planning/milestones/v1.0-ROADMAP.md')];
    assert.deepEqual(memberArtifacts(rows, LIVE), []);
  });

  it('keeps null where every row is null, and the first non-null per field otherwise', () => {
    const got = memberArtifacts([row(`${LIVE}/a.md`, { mtime_ms: null, first_mtime_ms: null }), row(`${ARCHIVE}/a.md`, { mtime_ms: null, first_mtime_ms: null })], LIVE);
    assert.equal(got.length, 1);
    assert.equal(got[0].mtime_ms, null);
    assert.equal(got[0].first_commit_ms, null);
    assert.equal(got[0].fm_date, null);
  });
});
