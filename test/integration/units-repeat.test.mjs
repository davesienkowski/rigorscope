// Integration tests of the derived repeat data (plan 03.1-02 Task 2, ADPT-05, D-01, D-03, D-22): `unit.id_repeats` and
// `repo_scan_count` in derived.db, and the reset-numbers layout, where a plan id is reused by a later milestone and the two
// dirs of the id must never merge (D-22). The display of the marker is plan 03.1-03, so these tests read derived.db with
// queryDb. The CLI is spawned on a temporary HOME; the fixture repo is built inside that HOME. Expectations by hand.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  cliEnv, makeHome, queryDb, runCli, stateDirOf,
} from '../fixtures/build.mjs';
import {
  archiveDir, commitAll, makeRepo, planText, writePlanningDir,
} from '../fixtures/git-repo.mjs';
import { STOCK_LAYOUTS } from '../fixtures/stock-layouts.mjs';
import { storePath } from '../../src/db.mjs';
import { appendLine } from '../../src/ledger/append.mjs';
import { buildLine } from '../../src/ledger/line.mjs';
import { unitKeyOf } from '../../src/units/unit-key.mjs';
import { LOCATION_KINDS } from '../../src/adapters/gsd-core/layout.mjs';

// The counters a repo_scan_count row exists for: every location counter except the per-unit repeat_id and the sentinel.
const SCAN_KINDS = LOCATION_KINDS.filter((k) => k !== 'repeat_id' && k !== 'trees_scanned').sort();
const made = [];
afterEach(() => { while (made.length > 0) made.pop().cleanup(); });

function setup(name, build) {
  const ctx = makeHome();
  made.push(ctx);
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
};
const unitsDoc = (s) => {
  const r = runCli(['units', '--json'], { home: s.home, env: s.env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const derivedRows = (s, sql, params = []) => queryDb(join(stateDirOf(s.home), 'derived.db'), sql, params);
const storeRows = (s, sql, params = []) => queryDb(storePath(s.home), sql, params);
const idRepeats = (s, key) => {
  unitsDoc(s);
  return derivedRows(s, 'SELECT id_repeats FROM unit WHERE unit_key = ?', [key])[0].id_repeats;
};
const scanCounts = (s) => derivedRows(s, 'SELECT repo_key, kind, n FROM repo_scan_count ORDER BY repo_key, kind');
const roles = (s, key) => derivedRows(s, 'SELECT role, n FROM unit_role WHERE unit_key = ? ORDER BY role', [key]);
const planFiles = { '01-01-PLAN.md': planText({ tier: 'A' }), '01-01-SUMMARY.md': planText({ tier: 'A' }) };

describe('the reset layout never merges, in both directions of the stored dir (D-22)', () => {
  it('stored from 01-setup: the move is read, 01-new is a repeat, id_repeats is 1 and one forward ledger line joins the one unit', () => {
    const s = setup('reset-a', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    ingest(s);
    const key = unitKeyOf(s.repoKey, 'plan', '01-01');
    archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.0' });
    writePlanningDir(s.repo, {
      under: 'phases', name: '01-new', files: { '01-01-PLAN.md': planText({ tier: 'C' }), '01-01-SUMMARY.md': planText({ tier: 'C' }) },
    });
    commitAll(s.repo, { home: s.home });
    ingest(s);
    assert.equal(idRepeats(s, key), 1);
    assert.deepEqual(roles(s, key), [{ role: 'plan', n: 1 }, { role: 'summary', n: 1 }], 'only the files of the moved dir');
    assert.equal(derivedRows(s, 'SELECT tier FROM unit WHERE unit_key = ?', [key])[0].tier, 'A');
    assert.equal(storeRows(s, "SELECT count(*) AS n FROM unit_artifact WHERE rel_path LIKE '%01-new%'")[0].n, 0, 'no 01-new file is stored');
    // One forward ledger line for 01-01 joins the same single unit_key.
    const line = buildLine({
      record: 'start', ts: '2026-10-28T12:00:00.000Z', repo_key: s.repoKey, kind: 'plan', native_id: '01-01', tier: 'A', tier_source: 'plan-at-start',
      start: '2026-10-28T12:00:00.000Z',
    });
    assert.equal(line.ok, true, line.reason);
    appendLine(s.home, line.text);
    ingest(s);
    const doc = unitsDoc(s);
    assert.deepEqual(doc.units.filter((u) => u.nativeId === '01-01' || u.key === key).map((u) => u.key), [key], 'one unit');
    const u = doc.units.find((x) => x.key === key);
    assert.equal(u.ledger.lines, 1);
    assert.equal(u.population, 'forward');
    assert.equal(idRepeats(s, key), 1, 'the marker survives the ledger line');
  });

  it('stored from 01-new: the archive dir is a repeat, the unit is read from 01-new only, id_repeats is 1', () => {
    const s = setup('reset-b', (repo) => STOCK_LAYOUTS.reset.build(repo, {}));
    const key = unitKeyOf(s.repoKey, 'plan', '01-01');
    const archived = join(s.repo, '.planning/milestones');
    const parked = join(s.home, 'parked-milestones');
    renameSync(archived, parked);
    ingest(s);
    renameSync(parked, archived);
    ingest(s);
    assert.equal(idRepeats(s, key), 1);
    assert.deepEqual(roles(s, key), [{ role: 'plan', n: 1 }]);
    assert.equal(derivedRows(s, 'SELECT tier FROM unit WHERE unit_key = ?', [key])[0].tier, 'B');
    assert.equal(storeRows(s, "SELECT count(*) AS n FROM unit_artifact WHERE rel_path LIKE '%01-setup%'")[0].n, 0, 'no archive file is stored');
  });

  it('a reused dir name reads as an in-place edit: the first tier letter is kept and the archive copy is the repeat (J4 residual)', () => {
    const s = setup('reused', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    ingest(s);
    const key = unitKeyOf(s.repoKey, 'plan', '01-01');
    archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.0' });
    writePlanningDir(s.repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'C' }) } });
    commitAll(s.repo, { home: s.home });
    ingest(s);
    assert.equal(idRepeats(s, key), 1);
    assert.equal(derivedRows(s, 'SELECT tier FROM unit WHERE unit_key = ?', [key])[0].tier, 'A', 'the first non-NULL letter wins');
    assert.equal(unitsDoc(s).units.find((u) => u.key === key).present, true);
  });
});

describe('unknown repeats are not zero', () => {
  it('a unit of a repo with no sentinel row has id_repeats NULL and the repo has no repo_scan_count row', () => {
    const s = setup('nosentinel', (repo) => {
      STOCK_LAYOUTS.archived.build(repo, {});
    });
    ingest(s);
    const key = unitKeyOf(s.repoKey, 'plan', '02-01');
    const db = new DatabaseSync(storePath(s.home));
    try {
      db.exec("DELETE FROM ingest_count WHERE source = 'units'");
    } finally {
      db.close();
    }
    rmSync(join(stateDirOf(s.home), 'derived.db'), { force: true });
    assert.equal(idRepeats(s, key), null);
    assert.deepEqual(scanCounts(s), []);
    assert.equal(derivedRows(s, 'SELECT count(*) AS n FROM unit WHERE id_repeats IS NOT NULL')[0].n, 0, 'no unit shows a count');
  });

  it('a scanned repo with nothing counted has id_repeats 0 and a repo_scan_count row of 0 for every counter (CR-03)', () => {
    const s = setup('plain', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    ingest(s);
    const key = unitKeyOf(s.repoKey, 'plan', '01-01');
    assert.equal(idRepeats(s, key), 0);
    assert.ok(SCAN_KINDS.length >= 10, 'the counter list is not trivially short');
    assert.deepEqual(
      scanCounts(s),
      SCAN_KINDS.map((kind) => ({ repo_key: s.repoKey, kind, n: 0 })),
      'scanned and nothing counted is 0 per counter, not an absent row',
    );
  });

  it('a counter that was counted keeps its n and every other counter of the scanned repo is 0 (CR-03)', () => {
    const s = setup('partial', (repo) => writePlanningDir(repo, { under: 'milestones/v1.0-phases', name: '01-setup', files: planFiles }));
    ingest(s);
    unitsDoc(s);
    const rows = scanCounts(s);
    assert.deepEqual(rows.map((r) => r.kind), SCAN_KINDS, 'one row per counter');
    assert.deepEqual(rows.filter((r) => r.n !== 0).map((r) => [r.kind, r.n]), [['units_archived', 1]]);
  });

  it('a ledger-only unit has id_repeats NULL', () => {
    const s = setup('ledgeronly', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    const line = buildLine({
      record: 'start', ts: '2026-10-28T12:00:00.000Z', repo_key: s.repoKey, kind: 'plan', native_id: '09-09', tier: 'B', tier_source: 'plan-at-start',
      start: '2026-10-28T12:00:00.000Z',
    });
    assert.equal(line.ok, true, line.reason);
    appendLine(s.home, line.text);
    ingest(s);
    const key = unitKeyOf(s.repoKey, 'plan', '09-09');
    assert.equal(idRepeats(s, key), null);
    assert.equal(idRepeats(s, unitKeyOf(s.repoKey, 'plan', '01-01')), 0);
  });
});

describe('repo_scan_count is filled from the sentinel repo rows of the latest scan', () => {
  it('holds every counter except repeat_id and the sentinel (0 where nothing was counted), with the run id of the latest scan', () => {
    const s = setup('counts', (repo) => {
      STOCK_LAYOUTS.archived.build(repo, {});
      STOCK_LAYOUTS.reset.build(repo, {});
    });
    ingest(s);
    ingest(s);
    unitsDoc(s);
    const latest = storeRows(s, 'SELECT last_scanned_run AS r FROM repo WHERE repo_key = ?', [s.repoKey])[0].r;
    const stored = storeRows(
      s,
      `SELECT kind, n FROM ingest_count
        WHERE source = 'units' AND run_id = ? AND name = ? AND kind NOT IN ('repeat_id', 'trees_scanned') ORDER BY kind`,
      [latest, s.repoKey],
    );
    assert.ok(stored.length >= 1, 'the layout has counted kinds');
    const got = new Map(stored.map((r) => [r.kind, r.n]));
    const want = SCAN_KINDS.map((kind) => ({
      repo_key: s.repoKey, kind, n: got.get(kind) ?? 0, run_id: latest,
    }));
    assert.deepEqual(derivedRows(s, 'SELECT repo_key, kind, n, run_id FROM repo_scan_count ORDER BY kind'), want);
    assert.ok(derivedRows(s, 'SELECT run_id FROM repo_scan_count').every((r) => r.run_id === latest));
  });

  it('a store scanned in two runs shows only the latest run, not both', () => {
    const s = setup('twice', (repo) => STOCK_LAYOUTS.archived.build(repo, {}));
    ingest(s);
    ingest(s);
    unitsDoc(s);
    const runs = derivedRows(s, 'SELECT DISTINCT run_id FROM repo_scan_count');
    assert.equal(runs.length, 1);
  });
});

// Plan 03.1-03 Task 3 (ADPT-05, D-01, D-03; J3, J5, J6): `units` shows the location counters and the repeated-id marker. The
// lines are built from the derived repo_scan_count and unit.id_repeats, so `units` never opens the store. Unknown is `?`, never 0.
describe('units shows the location counters and the repeated-id marker', () => {
  const unitsText = (s) => {
    const r = runCli(['units'], { home: s.home, env: s.env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n');
  };
  const lineOf = (lines, prefix) => lines.find((l) => l.startsWith(prefix));
  const fieldsOf = (line) => Object.fromEntries(line.split(' ').filter((t) => t.includes('=')).map((t) => t.split('=')));
  const shown = LOCATION_KINDS.filter((k) => k !== 'trees_scanned');
  const withoutSentinel = (s) => {
    const db = new DatabaseSync(storePath(s.home));
    try { db.exec("DELETE FROM ingest_count WHERE source = 'units'"); } finally { db.close(); }
    rmSync(join(stateDirOf(s.home), 'derived.db'), { force: true });
  };

  it('reset layout end to end: one unit with idRepeats 1, the locations line shows repeat_id=1, repeats names the unit evidence id', () => {
    const s = setup('shown', (repo) => STOCK_LAYOUTS.reset.build(repo, {}));
    ingest(s);
    const key = unitKeyOf(s.repoKey, 'plan', '01-01');
    const doc = unitsDoc(s);
    const u = doc.units.find((x) => x.key === key);
    assert.ok(u);
    assert.equal(u.idRepeats, 1);
    assert.equal(doc.units.filter((x) => x.native_id === '01-01').length, 1, 'one unit for 01-01');
    const lines = unitsText(s);
    const loc = lineOf(lines, 'locations: ');
    assert.ok(loc, 'a locations line');
    assert.match(loc, /^locations: repos=1 /);
    assert.equal(fieldsOf(loc).repeat_id, '1');
    assert.deepEqual(Object.keys(fieldsOf(loc)), ['repos', ...shown], 'the field order of the ingest line');
    const rep = lineOf(lines, 'repeats: ');
    assert.ok(rep, 'a repeats line');
    assert.match(rep, /^repeats: units=1 /);
    assert.ok(rep.includes(u.evidence_id), 'the unit evidence id is named');
    assert.ok(rep.includes("may include another milestone's activity"), 'the J3 sentence');
  });

  it('the locations and repeats lines sit after links and attribution and before labels, and carry no percentage figure', () => {
    const s = setup('placed', (repo) => STOCK_LAYOUTS.reset.build(repo, {}));
    ingest(s);
    const lines = unitsText(s);
    const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix));
    assert.ok(at('links: ') >= 0 && at('attribution: ') >= 0 && at('labels: ') >= 0);
    for (const k of ['locations: ', 'repeats: ']) {
      assert.ok(at(k) > at('links: ') && at(k) > at('attribution: '), `${k} after links and attribution`);
      assert.ok(at(k) < at('labels: '), `${k} before labels`);
      // An evidence id is percent-encoded (u:...%3A...); the check is for a percentage figure, so ids are left out.
      assert.ok(!lines[at(k)].replace(/u[:]\S+/g, '').includes('%'), `${k} has no percent sign`);
    }
    assert.ok(at('locations: ') < at('repeats: '));
  });

  it('a reused dir name reads as an in-place edit: the archive dir is the repeat and idRepeats is 1 (J3 residual)', () => {
    const s = setup('reusedname', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    ingest(s);
    archiveDir(s.repo, { home: s.home, name: '01-setup', label: 'v1.0' });
    writePlanningDir(s.repo, { under: 'phases', name: '01-setup', files: { '01-01-PLAN.md': planText({ tier: 'C' }) } });
    commitAll(s.repo, { home: s.home });
    ingest(s);
    const key = unitKeyOf(s.repoKey, 'plan', '01-01');
    assert.equal(unitsDoc(s).units.find((u) => u.key === key).idRepeats, 1);
    assert.equal(fieldsOf(lineOf(unitsText(s), 'locations: ')).repeat_id, '1');
  });

  it('units shows unknown counts as unknown: no sentinel gives idRepeats null, ? for every counter and units=?', () => {
    const s = setup('unknown', (repo) => STOCK_LAYOUTS.archived.build(repo, {}));
    ingest(s);
    withoutSentinel(s);
    const doc = unitsDoc(s);
    assert.ok(doc.units.length > 0);
    for (const u of doc.units) assert.equal(u.idRepeats, null, u.key);
    assert.equal(doc.locations.repos, 0);
    assert.equal(doc.locations.counters, null, 'unknown counters are null, never an object of zeros');
    const lines = unitsText(s);
    const loc = lineOf(lines, 'locations: ');
    assert.match(loc, /^locations: repos=0 /);
    const f = fieldsOf(loc);
    for (const k of shown) assert.equal(f[k], '?', k);
    assert.match(lineOf(lines, 'repeats: '), /^repeats: units=\? /);
    assert.ok(!lineOf(lines, 'repeats: ').includes('u:'), 'no evidence ids for an unknown count');
  });

  it('a scanned repo with nothing counted prints 0 for every counter with repos=1, and repeats units=0 with no ids', () => {
    const s = setup('zeros', (repo) => writePlanningDir(repo, { under: 'phases', name: '01-setup', files: planFiles }));
    ingest(s);
    const doc = unitsDoc(s);
    assert.equal(doc.locations.repos, 1);
    assert.deepEqual(Object.keys(doc.locations.counters), shown);
    for (const k of shown) assert.equal(doc.locations.counters[k], 0, k);
    assert.equal(doc.units[0].idRepeats, 0);
    const lines = unitsText(s);
    const f = fieldsOf(lineOf(lines, 'locations: '));
    assert.equal(f.repos, '1');
    for (const k of shown) assert.equal(f[k], '0', k);
    const rep = lineOf(lines, 'repeats: ');
    assert.match(rep, /^repeats: units=0 /);
    assert.ok(!rep.includes('u:') && !rep.includes('may include'), 'no ids and no sentence when the count is 0');
  });

  it('the lines are scoped per repo and say so, and the json locations key carries the same scope text', () => {
    const s = setup('scoped', (repo) => STOCK_LAYOUTS.reset.build(repo, {}));
    ingest(s);
    const lines = unitsText(s);
    assert.match(lineOf(lines, 'locations: '), /per repo/);
    assert.match(lineOf(lines, 'repeats: '), /per repo/);
    const doc = unitsDoc(s);
    assert.match(doc.locations.scope, /per repo/);
  });
});
