// Integration tests of the locations the gsd-core adapter reads and counts (plan 03.1-01, ADPT-05, D-01, D-03, D-04,
// D-21): the CLI is spawned on a temporary HOME from makeHome(), the fixture repo is built by test/fixtures/git-repo.mjs
// inside that HOME and reached through RIGORSCOPE_REPO_ROOTS, and the store is read with queryDb only. The latest store
// version is never written as a literal. Expectations come from test/fixtures/stock-layouts.mjs, by hand.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  cliEnv, makeHome, queryDb, runCli,
} from '../fixtures/build.mjs';
import { makeRepo, planText, writePlanningDir } from '../fixtures/git-repo.mjs';
import { STOCK_LAYOUTS } from '../fixtures/stock-layouts.mjs';
import { openStore, storePath } from '../../src/db.mjs';
import { collectUnits } from '../../src/adapters/gsd-core/index.mjs';
import { unitKeyOf } from '../../src/units/unit-key.mjs';
import { LOCATION_KINDS } from '../../src/adapters/gsd-core/layout.mjs';
import { CLASS_KINDS } from '../../src/adapters/gsd-core/roster.mjs';

const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const SHOWN = LOCATION_KINDS.filter((k) => k !== 'trees_scanned');
// Plan 03.1-04 writes its class rows into the same ingest_count source; these tests pin the location rows only.
const NOT_CLASS = `kind NOT IN (${CLASS_KINDS.map((k) => `'${k}'`).join(', ')})`;

// A home with one repo at <home>/src/<name>, built by build(repo, home), reached through the roots variable.
function setup(name, build) {
  const ctx = makeHome();
  const repo = join(ctx.home, 'src', name);
  makeRepo(repo, { home: ctx.home, files: { 'README.md': `${name}\n` }, });
  build(repo, ctx.home);
  const env = cliEnv(ctx.home, { TZ: 'UTC', RIGORSCOPE_REPO_ROOTS: repo });
  return {
    ctx, repo, env, repoKey: `~/src/${name}/.git`,
  };
}
const ingest = (s) => {
  const r = runCli(['ingest'], { home: s.ctx.home, env: s.env });
  assert.equal(r.status, 0, r.stderr);
  return linesOf(r.stdout);
};
const unitsDoc = (s) => {
  const r = runCli(['units', '--json'], { home: s.ctx.home, env: s.env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const locationsOf = (lines) => {
  const line = lines.find((l) => l.startsWith('locations: '));
  assert.ok(line, 'a locations line');
  return Object.fromEntries(line.slice('locations: '.length).split(' ').map((t) => t.split('=')));
};

describe('tracer: an archived plan unit end to end', () => {
  let s;
  let lines;
  before(() => {
    s = setup('arch', (repo) => {
      writePlanningDir(repo, {
        under: 'milestones/v1.0-phases',
        name: '01-setup',
        files: { '01-01-PLAN.md': planText({ tier: 'A' }), '01-01-SUMMARY.md': planText({ tier: 'A' }) },
      });
    });
    lines = ingest(s);
  });
  after(() => s.ctx.cleanup());

  it('lists the unit with its key, the archive dir and present true', () => {
    const key = unitKeyOf(s.repoKey, 'plan', '01-01');
    assert.equal(key, 'gsd-core:~/src/arch/.git:plan:01-01');
    const u = unitsDoc(s).units.find((x) => x.key === key);
    assert.ok(u, 'the archived unit is listed');
    assert.equal(u.dir, '.planning/milestones/v1.0-phases/01-setup');
    assert.equal(u.present, true);
    assert.equal(u.kind, 'plan');
  });

  it('prints a locations line with units_archived=1 directly before the env line; units stays second from last', () => {
    const at = lines.findIndex((l) => l.startsWith('locations: '));
    assert.ok(at > 0, 'the line is printed');
    assert.equal(lines.filter((l) => l.startsWith('locations: ')).length, 1);
    // Plan 03.1-04: the classes line sits between locations and env.
    assert.ok(lines[at + 1].startsWith('classes: '), 'the classes line follows');
    assert.ok(lines[at + 2].startsWith('env: '), 'directly before env after the classes line');
    assert.ok(lines[at + 3].startsWith('units: '), 'env stays directly before units');
    assert.equal(at + 4, lines.length - 1, 'the units line stays the line before the last');
    const got = locationsOf(lines);
    assert.equal(got.repos, '1');
    assert.equal(got.units_archived, '1');
    assert.deepEqual(Object.keys(got), ['repos', ...SHOWN]);
    for (const k of SHOWN.filter((x) => x !== 'units_archived')) assert.equal(got[k], '0', k);
  });

  it('writes the sentinel and the archived count to ingest_count with source units, keyed by the repo key', () => {
    const rows = queryDb(storePath(s.ctx.home), `SELECT kind, name, n FROM ingest_count WHERE source = 'units' AND ${NOT_CLASS} ORDER BY kind`);
    assert.deepEqual(rows, [
      { kind: 'trees_scanned', name: s.repoKey, n: 1 },
      { kind: 'units_archived', name: s.repoKey, n: 1 },
    ]);
  });
});

describe('the archived layout through the CLI', () => {
  let s;
  let lines;
  before(() => {
    s = setup('layout', (repo) => STOCK_LAYOUTS.archived.build(repo, {}));
    lines = ingest(s);
  });
  after(() => s.ctx.cleanup());

  it('lists the three units and counts the archived ones and the other milestones dir', () => {
    const doc = unitsDoc(s);
    for (const w of STOCK_LAYOUTS.archived.expect.units) {
      const u = doc.units.find((x) => x.key === unitKeyOf(s.repoKey, w.kind, w.nativeId));
      assert.ok(u, `${w.kind} ${w.nativeId}`);
      assert.equal(u.dir, w.dirRel);
      assert.equal(u.present, true);
    }
    const got = locationsOf(lines);
    const want = STOCK_LAYOUTS.archived.expect.counters;
    for (const k of SHOWN) assert.equal(got[k], String(want[k] ?? 0), k);
  });
});

describe('unknown counts print as question marks', () => {
  it('a HOME whose only repo has no working tree prints repos=0 and ? for every counter', () => {
    const ctx = makeHome();
    try {
      const env = cliEnv(ctx.home, { TZ: 'UTC' });
      const r = runCli(['ingest'], { home: ctx.home, env });
      assert.equal(r.status, 0, r.stderr);
      const lines = linesOf(r.stdout);
      const got = locationsOf(lines);
      assert.equal(got.repos, '0');
      for (const k of SHOWN) assert.equal(got[k], '?', k);
      assert.equal(queryDb(storePath(ctx.home), "SELECT count(*) AS n FROM ingest_count WHERE source = 'units'")[0].n, 0);
    } finally {
      ctx.cleanup();
    }
  });
});

const rowsOf = (home, sql, params = []) => queryDb(storePath(home), sql, params);
const COUNT_ROWS = `SELECT run_id, kind, name, n FROM ingest_count WHERE source = 'units' AND ${NOT_CLASS} ORDER BY run_id, kind`;

describe('persisted rows: the forms layout, twice', () => {
  let s;
  let first;
  let second;
  before(() => {
    s = setup('forms', (repo) => STOCK_LAYOUTS.forms.build(repo, {}));
    first = ingest(s);
    second = ingest(s);
  });
  after(() => s.ctx.cleanup());

  it('writes the sentinel and one row per counted form, named by the repo key', () => {
    const want = Object.entries(STOCK_LAYOUTS.forms.expect.counters).map(([kind, n]) => ({ kind, name: s.repoKey, n }));
    want.push({ kind: 'trees_scanned', name: s.repoKey, n: 1 });
    want.sort((a, b) => (a.kind < b.kind ? -1 : 1));
    const runs = [...new Set(rowsOf(s.ctx.home, COUNT_ROWS).map((r) => r.run_id))];
    assert.equal(runs.length, 2, 'one set of rows per run');
    for (const run of runs) {
      const got = rowsOf(s.ctx.home, COUNT_ROWS).filter((r) => r.run_id === run).map(({ kind, name, n }) => ({ kind, name, n }));
      assert.deepEqual(got, want);
    }
  });

  it('prints the same locations line on both runs with every form counted once', () => {
    assert.deepEqual(locationsOf(first), locationsOf(second));
    const got = locationsOf(first);
    for (const k of SHOWN) assert.equal(got[k], String(STOCK_LAYOUTS.forms.expect.counters[k] ?? 0), k);
  });

  it('leaves the natural-key tables unchanged by the second run and stores no unit for a counted form', () => {
    assert.equal(rowsOf(s.ctx.home, 'SELECT count(*) AS n FROM unit_obs')[0].n, 0);
    assert.equal(rowsOf(s.ctx.home, 'SELECT count(*) AS n FROM unit_artifact')[0].n, 0);
  });
});

describe('a repeated id is a row keyed by its unit key, and the second dir is never merged', () => {
  let s;
  let lines;
  before(() => {
    s = setup('reset', (repo) => {
      STOCK_LAYOUTS.reset.build(repo, {});
      writePlanningDir(repo, { under: 'phases', name: '01-new', files: { '01-01-SUMMARY.md': planText({ tier: 'B' }) } });
    });
    lines = ingest(s);
  });
  after(() => s.ctx.cleanup());

  it('archived unit key equals unitKeyOf of its parts', () => {
    const key = unitKeyOf(s.repoKey, 'plan', '01-01');
    const u = unitsDoc(s).units.find((x) => x.key === key);
    assert.ok(u);
    assert.equal(u.dir, STOCK_LAYOUTS.reset.expect.units[0].dirRel);
    assert.equal(u.present, true);
    assert.deepEqual(rowsOf(s.ctx.home, 'SELECT unit_key FROM unit_obs'), [{ unit_key: key }]);
    const rels = rowsOf(s.ctx.home, 'SELECT rel_path FROM unit_artifact WHERE unit_key = ?', [key]).map((r) => r.rel_path);
    assert.deepEqual(rels, ['.planning/milestones/v1.0-phases/01-setup/01-01-PLAN.md']);
  });

  it('writes repeat_id with the unit key as the name and prints repeat_id=1 units_archived=1', () => {
    const key = unitKeyOf(s.repoKey, 'plan', '01-01');
    const rows = rowsOf(s.ctx.home, "SELECT name, n FROM ingest_count WHERE source = 'units' AND kind = 'repeat_id'");
    assert.deepEqual(rows, [{ name: key, n: 1 }]);
    const got = locationsOf(lines);
    assert.equal(got.repeat_id, '1');
    assert.equal(got.units_archived, '1');
    assert.equal(lines.find((l) => l.startsWith('units: ')).match(/ dup_ids=(\d+) /)[1], '0');
  });
});

describe('unknown counts print as question marks', () => {
  it('a scanned repo with nothing to count prints repos=1 and zeros', () => {
    const s = setup('nothing', () => {});
    try {
      const got = locationsOf(ingest(s));
      assert.equal(got.repos, '1');
      for (const k of SHOWN) assert.equal(got[k], '0', k);
      assert.deepEqual(rowsOf(s.ctx.home, `SELECT kind, n FROM ingest_count WHERE source = 'units' AND ${NOT_CLASS}`), [{ kind: 'trees_scanned', n: 1 }]);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('a repo whose tree vanished before run 2 gets no sentinel for run 2: repos=0, ? for all, run 1 rows stay its latest', () => {
    const s = setup('vanish', (repo) => STOCK_LAYOUTS.archived.build(repo, {}));
    try {
      const run1 = ingest(s);
      assert.equal(locationsOf(run1).repos, '1');
      const last1 = rowsOf(s.ctx.home, 'SELECT last_scanned_run AS r FROM repo WHERE repo_key = ?', [s.repoKey])[0].r;
      rmSync(s.repo, { recursive: true, force: true });
      const got = locationsOf(ingest(s));
      assert.equal(got.repos, '0');
      for (const k of SHOWN) assert.equal(got[k], '?', k);
      const rows = rowsOf(s.ctx.home, "SELECT DISTINCT run_id FROM ingest_count WHERE source = 'units' AND kind = 'trees_scanned' AND name = ?", [s.repoKey]);
      assert.deepEqual(rows.map((r) => r.run_id), [last1], 'run 2 wrote no sentinel');
      assert.equal(rowsOf(s.ctx.home, 'SELECT last_scanned_run AS r FROM repo WHERE repo_key = ?', [s.repoKey])[0].r, last1);
    } finally {
      s.ctx.cleanup();
    }
  });
});

describe('a wrong run id fails loudly (review WR-01)', () => {
  it('collectUnits with a run id that has no ingest_run row throws and writes no counter row', async () => {
    const s = setup('wrongrun', (repo) => STOCK_LAYOUTS.archived.build(repo, {}));
    try {
      ingest(s);
      const db = openStore({ home: s.ctx.home });
      try {
        const before = db.prepare("SELECT count(*) AS n FROM ingest_count WHERE source = 'units'").get().n;
        const bad = db.prepare('SELECT max(run_id) + 1000 AS r FROM ingest_run').get().r;
        await assert.rejects(() => collectUnits({ db, home: s.ctx.home, runId: bad }), /FOREIGN KEY/);
        assert.equal(db.prepare("SELECT count(*) AS n FROM ingest_count WHERE source = 'units'").get().n, before);
      } finally {
        db.close();
      }
    } finally {
      s.ctx.cleanup();
    }
  });
});
