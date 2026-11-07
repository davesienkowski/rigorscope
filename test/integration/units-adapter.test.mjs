// Plan 02-02 tracer (UNIT-01, UNIT-02, UNIT-05, ADPT-01, RPT-01; D-08, D-11, D-19, D-23, amendments Q2 and Q5):
// a quick unit in a fixture repo reached only through a linked worktree is resolved at ingest to the repo's git
// common dir, stored in migration 007's tables, derived into the unit record and listed by `rigorscope units` and
// `units --json`. Written before the code (RED).
//
// Every run spawns the CLI on a temporary HOME from makeHome() (its name holds the planted OS user name, a space and
// a hash character); every git repository is created by test/fixtures/git-repo.mjs inside that HOME. Nothing under
// src/units, src/adapters or migration 007 is imported here: the store is read with queryDb only, so this file loads
// and fails on its assertions before the code exists. The latest store version is never written as a literal.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMigrations, openStore, storePath } from '../../src/db.mjs';
import { FIXTURE_NOW } from '../fixtures/clock.mjs';
import {
  cliEnv, makeAssistant, makeHome, makeUsage, mangleHome, queryDb, runCli, sha256File, writeJsonl,
} from '../fixtures/build.mjs';
import { commitAll, makeRepo, writeQuickDir } from '../fixtures/git-repo.mjs';
import { UNITS_EXPECTED, buildUnitsHome } from '../fixtures/units-home.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../src/store/migrations/', import.meta.url));
const NY = 'America/New_York';
const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const tokens = (line) => line.trim().split(/\s+/);
// Plan 02-07: cost is derived from the session-to-unit links.
const LABELS_TEXT = 'labels: repo=reconstructed tier=reconstructed start=reconstructed end=reconstructed risk_class=reconstructed '
  + 'novelty=reconstructed unit_size=reconstructed cost=derived links=derived runtime=reconstructed '
  + 'confounders=transcript+reconstructed (units --json); branch, catch, escape and rework=unavailable; ? means unknown, never zero'
  + '; forward units: tier, start and end=recorded where the ledger gave them (agent-reported, not git-corroborated), reconstructed otherwise';
// Plan 02-07: no session of the units home names a planning file or overlaps a unit, so no unit has an attributed call.
const NO_COST = {
  link_confidence: 'medium', calls: 0, scopes: 0, input: null, output: null, cache_read: null, cache_write: null, tokens: null,
  usd_nano: null, usd_floor: null, window_5h: null, window_7d: null, label: 'unavailable',
};
const ROLES = ['plan', 'summary', 'context', 'verification', 'review', 'windows', 'rigor-tier', 'probes-skipped', 'probe', 'refute-pass'];
const roleCounts = (counts) => Object.fromEntries(ROLES.map((r) => [r, counts[r] ?? 0]));

// Plan 02-07: a unit with no attributed call has its transcript and worker confounders unknown with the reason
// no-attributed-call. The env fields come from the one snapshot of the ingest, taken at FIXTURE_NOW, after the starts
// of a1b and c2d and before e3f's (its quick-id day starts before it in America/New_York), and that hermetic HOME has no
// GSD install or settings, so every env value is unknown.
function noCallConfounders(envSource) {
  const perRole = { by_role: {}, source: 'no-attributed-call', label: 'unavailable' };
  const env = (name) => [name, { value: null, source: envSource, label: 'unavailable' }];
  return {
    model: perRole,
    effort: perRole,
    fast_mode: perRole,
    cc_version: {
      value: null, unknown_calls: null, source: 'no-attributed-call', label: 'unavailable',
    },
    worker: {
      mode: null, count: null, subagents: null, source: 'no-attributed-call', label: 'unavailable',
    },
    env: Object.fromEntries(['gsd_version', 'base_sha', 'local_mods_head', 'hooks_sha', 'hook_events', 'model_default',
      'advisor_model'].map(env)),
  };
}

// The full ADR-0004 record of one expected unit (see test/fixtures/units-home.mjs). Plan 02-05: every unit has a scan
// row and no commit naming it. alpha tracks .planning/, so a1b and c2d end at the fixture commit (git), which lies
// before their quick-id start, so the end is raised to the start (D-10 clamp, the source stays git); a1b's
// frontmatter tier, set by that commit and with its SUMMARY added by it too, is declared at close; beta ignores
// .planning/, so e3f ends at the newest mtime of its files (endUtc, read from disk by the caller). No risk, novelty or
// unit size is known.
function expectedRecord(u, { name = u.repo, display = u.repo, endUtc = null } = {}) {
  const tierLabel = u.tier === null ? 'unavailable' : 'reconstructed';
  const tracked = u.repo === 'alpha';
  const roles = u.nativeId === '261029-c2d' ? { plan: 1 } : { plan: 1, summary: 1 };
  return {
    key: u.key,
    framework: 'gsd-core',
    kind: 'quick',
    native_id: u.nativeId,
    dir: u.dir,
    repo: { key: u.repoKey, name, display, label: 'reconstructed' },
    branch: { value: null, label: 'unavailable' },
    runtime: { value: null, source: null, label: 'unavailable' },
    tier: {
      value: u.tier,
      native: u.tier,
      signal: u.signal,
      timing: tracked && u.tier !== null ? 'declared-at-close' : null,
      conflict: u.conflict,
      comparable: u.tier !== null,
      label: tierLabel,
    },
    risk_class: { value: null, source: 'no-evidence', label: 'unavailable' },
    novelty: { value: null, source: 'no-evidence', label: 'unavailable' },
    start: { utc: u.startUtcNewYork, date_source: 'quick-id', precision: 'day', label: 'reconstructed' },
    end: tracked
      ? { utc: u.startUtcNewYork, date_source: 'clamped', precision: 'day', label: 'reconstructed' }
      : { utc: endUtc, date_source: 'mtime', precision: 'instant', label: 'reconstructed' },
    git_evidence: tracked,
    commits_bounded: null,
    recorded_at_utc: FIXTURE_NOW,
    population: 'reconstructed',
    present: true,
    idRepeats: 0, // plan 03.1-03: a scanned repo with nothing repeated
    ledger: null, // plan 03-03: no ledger line in this home
    artifacts: roleCounts(roles),
    cost: NO_COST,
    catch: { label: 'unavailable' },
    escape: { label: 'unavailable' },
    rework: { label: 'unavailable' },
    confounders: {
      unit_size: { value: null, source: null, label: 'unavailable' },
      ...noCallConfounders(u.nativeId === '261028-e3f' ? 'before-first-snapshot' : 'env-snapshot'),
    },
    links: [],
    attribution: {
      scopes: 0, sessions: 0, subagent_scopes: 0, calls: 0, refs_unknown_scopes: 0,
    },
    evidence_id: `u:${u.key.replace(/\//g, '%2F')}`,
  };
}

// The newest whole-millisecond mtime of the files of a unit dir, as ISO text.
function newestMtimeUtc(dir) {
  const ms = readdirSync(dir).map((f) => Math.trunc(lstatSync(join(dir, f)).mtimeMs));
  return new Date(Math.max(...ms)).toISOString();
}

// Every string in a JSON value, depth first.
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

describe('units on the units home (tracer)', () => {
  let ctx;
  let env;
  let built;
  const r = {};
  const store = {};
  before(() => {
    ctx = makeHome();
    built = buildUnitsHome({ home: ctx.home, root: ctx.root });
    env = cliEnv(ctx.home, { TZ: NY });
    r.ingest1 = runCli(['ingest'], { home: ctx.home, env });
    r.json1 = runCli(['units', '--json'], { home: ctx.home, env });
    r.text1 = runCli(['units'], { home: ctx.home, env });
    const q = (sql) => {
      try { return queryDb(storePath(ctx.home), sql); } catch { return null; }
    };
    store.dirRepo = q('SELECT dir, repo_key, method, is_worktree FROM dir_repo ORDER BY dir');
    store.repo = q('SELECT repo_key, repo_name FROM repo ORDER BY repo_key');
    store.unitObs = q('SELECT unit_key, native_id, id_date, id_offset_min FROM unit_obs ORDER BY native_id');
    store.artifacts = q(`SELECT o.native_id, a.rel_path, a.role, a.tier_letter, a.tier_place
                           FROM unit_artifact a JOIN unit_obs o ON o.unit_key = a.unit_key ORDER BY a.rel_path`);
    r.ingest2 = runCli(['ingest'], { home: ctx.home, env });
    r.json2 = runCli(['units', '--json'], { home: ctx.home, env });
  });
  after(() => ctx.cleanup());

  it('units --json exits 0 with the rigorscope.units/1 document and the three units in order', () => {
    assert.equal(r.json1.status, 0, r.json1.stderr);
    const doc = JSON.parse(r.json1.stdout);
    assert.deepEqual(Object.keys(doc), ['schema', 'as_of_utc', 'clock_fixed', 'freshness', 'tz', 'population', 'strata', 'window', 'incomplete', 'unrecorded', 'overhead', 'units',
      'link_confidence', 'filters', 'attribution', 'links', 'locations']);
    assert.equal(doc.schema, 'rigorscope.units/2');
    assert.equal(doc.population, 'all');
    assert.equal(doc.tz, NY);
    assert.deepEqual(doc.units.map((u) => u.key), UNITS_EXPECTED.units.map((u) => u.key));
  });

  it('every units --json record has the full ADR-0004 shape with unknown fields null and labeled unavailable', () => {
    assert.equal(r.json1.status, 0, r.json1.stderr);
    const doc = JSON.parse(r.json1.stdout);
    const endUtc = newestMtimeUtc(join(built.beta, '.planning', 'quick', '261028-e3f-third'));
    assert.deepEqual(doc.units, UNITS_EXPECTED.units.map((u) => expectedRecord(u, { endUtc })));
  });

  it('units --json counts the units, tiers, conflicts, repos and present units', () => {
    assert.equal(r.json1.status, 0, r.json1.stderr);
    assert.deepEqual(JSON.parse(r.json1.stdout).strata[1].counts, UNITS_EXPECTED.counts);
  });

  it('no string of the document holds the worktree directory name, the HOME path or an absolute path', () => {
    assert.equal(r.json1.status, 0, r.json1.stderr);
    for (const s of strings(JSON.parse(r.json1.stdout))) {
      assert.ok(!s.includes('alpha-fix'), 'no worktree directory name');
      assert.ok(!s.includes(ctx.home), 'no HOME path');
    }
    for (const u of JSON.parse(r.json1.stdout).units) {
      for (const s of strings(u)) assert.ok(!s.startsWith('/'), 'no absolute path in a unit record');
    }
  });

  it('ingest keeps its first and last lines and prints the units line just before the last', () => {
    assert.equal(r.ingest1.status, 0, r.ingest1.stderr);
    const lines = linesOf(r.ingest1.stdout);
    assert.match(lines[0], /^ingest: roots=\d+ sources=/);
    assert.match(lines[lines.length - 1], /^ingest: files=/);
    assert.equal(lines[lines.length - 2], UNITS_EXPECTED.ingestLine);
  });

  it('units (text) prints freshness, population, the table, the units line and the labels line', () => {
    assert.equal(r.text1.status, 0, r.text1.stderr);
    const lines = linesOf(r.text1.stdout);
    assert.match(lines[0], /^freshness: /);
    const pop = lines.findIndex((l) => l.startsWith('population: reconstructed n='));
    assert.ok(pop > 0, 'population line');
    assert.ok(lines.includes('scope: link_confidence=medium unit_filters=none call_filters=none'));
    assert.deepEqual(tokens(lines[pop + 1]), ['repo', 'kind', 'id', 'tier', 'signal', 'timing', 'conflict', 'risk', 'novelty',
      'start', 'end', 'dates', 'files', 'lines', 'links', 'tokens', 'usd']);
    const betaEnd = newestMtimeUtc(join(built.beta, '.planning', 'quick', '261028-e3f-third'));
    const betaDay = new Date(Date.parse(betaEnd)).toLocaleDateString('en-CA', { timeZone: NY });
    assert.deepEqual(lines.slice(pop + 2, pop + 5).map(tokens), [
      ['alpha', 'quick', '261029-c2d', '?', 'none', '?', 'no', '?', '?', '2026-10-29', '2026-10-29', 'quick-id/clamped', '?', '?',
        '0/0/0', '?', '?'],
      ['alpha', 'quick', '261030-a1b', 'A', 'frontmatter', 'declared-at-close', 'no', '?', '?', '2026-10-30', '2026-10-30',
        'quick-id/clamped', '?', '?', '0/0/0', '?', '?'],
      ['beta', 'quick', '261028-e3f', 'C', 'frontmatter', '?', 'yes', '?', '?', '2026-10-28', betaDay, 'quick-id/mtime', '?', '?',
        '0/0/0', '?', '?'],
    ]);
    assert.equal(lines[pop + 5], 'units: n=3 quick=3 plan=0 tiered=2 untiered=1 conflicts=1 repos=2 present=3 comparable=2 '
      + 'git_evidence=2 risk_known=0 plan_unbounded=0 end_clamped=2 declared_at_close=0');
    assert.ok(lines[pop + 6].startsWith('coverage: reconstructed tiered=2/3 '), lines[pop + 6]);
    assert.ok(lines[pop + 7].startsWith('window: since none (no ledger line yet) '), lines[pop + 7]);
    assert.ok(lines[pop + 8].startsWith('  attribution unit is session + agent: '), lines[pop + 8]);
    assert.ok(lines[pop + 9].startsWith('links: whole store, both populations (not a stratum figure) scopes='), lines[pop + 9]);
    assert.ok(lines[pop + 10].startsWith('attribution: whole store, both populations (not a stratum figure) link_confidence=medium section=main attributed=0/0/'), lines[pop + 10]);
    assert.ok(lines[pop + 10].endsWith(' check=ok (otel and harness calls are outside attribution)'), lines[pop + 10]);
    assert.equal(lines[pop + 11], 'incomplete: n=0 listed=0 oldest=?');
    assert.ok(lines[pop + 12].startsWith('unrecorded: ? cutoff_day=none n=0 '), lines[pop + 12]);
    assert.ok(lines[pop + 13].startsWith('overhead: estimate (chars/4) '), lines[pop + 13]);
    // Plan 03.1-03: the locations and repeats lines sit between the overhead line and the labels line.
    assert.ok(lines[pop + 14].startsWith('locations: repos=2 units_archived=0 '), lines[pop + 14]);
    assert.equal(lines[pop + 15].split(' (')[0], 'repeats: units=0');
    assert.equal(lines[pop + 16], LABELS_TEXT);
    assert.equal(lines.length, pop + 17);
  });

  it('store.db holds the resolved dirs, both repos, three unit observations and five artifacts', () => {
    assert.deepEqual(store.dirRepo, UNITS_EXPECTED.dirRepo);
    assert.deepEqual(store.repo, UNITS_EXPECTED.repos);
    assert.deepEqual(store.unitObs?.map((u) => [u.native_id, u.id_date, u.id_offset_min]), [
      ['261028-e3f', '2026-10-28', -240], ['261029-c2d', '2026-10-29', -240], ['261030-a1b', '2026-10-30', -240],
    ]);
    assert.deepEqual(
      store.artifacts?.map((a) => [a.native_id, a.rel_path, a.role, a.tier_letter, a.tier_place]),
      UNITS_EXPECTED.artifacts.map(([id, rel, role, letter]) => [id, rel, role, letter, letter === null ? null : 'frontmatter']),
    );
    assert.ok(!(store.artifacts ?? []).some((a) => a.rel_path.includes('zz-copy')), 'the duplicate dir is never read');
  });

  it('a second ingest resolves no dir and units --json prints byte-identical stdout', () => {
    assert.equal(r.ingest2.status, 0, r.ingest2.stderr);
    const lines = linesOf(r.ingest2.stdout);
    assert.equal(lines[lines.length - 2],
      'units: git=not_needed dirs=0 resolved=0 ancestor=0 none=0 deferred=0 repos=2 scanned=2 quick=3 dup_ids=1 skipped=0 '
      + 'plan=0 artifacts=5 facts=not_needed facts_units=0 facts_deferred=0 facts_dropped=0 roots=0 root_skipped=0 trees=3 trees_dropped=0');
    assert.equal(r.json2.status, 0, r.json2.stderr);
    assert.equal(r.json2.stdout, r.json1.stdout);
  });
});

describe('units on empty and sparse homes', () => {
  it('units and units --json on a HOME with no store exit 0 with no units', () => {
    const ctx = makeHome();
    try {
      const text = runCli(['units'], { home: ctx.home });
      assert.equal(text.status, 0, text.stderr);
      const lines = linesOf(text.stdout);
      assert.ok(lines.some((l) => l.startsWith('population: reconstructed n=0 ')), 'population line');
      assert.ok(lines.includes('no units'));
      assert.ok(lines.includes('units: n=0 quick=0 plan=0 tiered=0 untiered=0 conflicts=0 repos=0 present=0 comparable=0 '
        + 'git_evidence=0 risk_known=0 plan_unbounded=0 end_clamped=0 declared_at_close=0'));
      const json = runCli(['units', '--json'], { home: ctx.home });
      assert.equal(json.status, 0, json.stderr);
      const doc = JSON.parse(json.stdout);
      assert.deepEqual(doc.units, []);
      assert.equal(doc.strata[1].counts.units, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it('a repo with .planning/ but no quick/ gives no unit; a quick dir with neither PLAN nor SUMMARY has tier ?', () => {
    const ctx = makeHome();
    try {
      const bare = join(ctx.home, 'repos', 'noquick');
      makeRepo(bare, { home: ctx.home, files: { '.planning/STATE.md': 'state\n' } });
      const empty = join(ctx.home, 'repos', 'emptyquick');
      makeRepo(empty, { home: ctx.home, files: { 'README.md': 'x\n' } });
      mkdirSync(join(empty, '.planning', 'quick', '261027-e0e-nothing'), { recursive: true });
      writeSessionAt(ctx, bare, 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', 1);
      writeSessionAt(ctx, empty, 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2', 2);
      const ing = runCli(['ingest'], { home: ctx.home });
      assert.equal(ing.status, 0, ing.stderr);
      const doc = JSON.parse(runCli(['units', '--json'], { home: ctx.home }).stdout);
      assert.deepEqual(doc.units.map((u) => [u.native_id, u.tier.value, u.tier.signal]), [['261027-e0e', null, 'none']]);
    } finally {
      ctx.cleanup();
    }
  });
});

function writeSessionAt(ctx, cwd, session, sec) {
  const line = makeAssistant({
    session, ts: `2026-10-27T16:00:0${sec}.000Z`, id: `msg_sparse_${sec}`, model: 'claude-opus-5-5', cwd,
    use: makeUsage({ input: 1, output: 1, read: 0, creation: 0 }),
  });
  writeJsonl(join(ctx.root, 'projects', mangleHome(cwd), `${session}.jsonl`), [JSON.stringify(line)]);
}

describe('units edge cases: symlinks, shapes and impossible dates', () => {
  it('skips and counts symlinked quick dirs, symlinked artifacts and bad dir names; keeps impossible dates as NULL', () => {
    const ctx = makeHome();
    try {
      const top = join(ctx.home, 'repos', 'edge');
      makeRepo(top, { home: ctx.home, files: { 'README.md': 'edge\n' } });
      const real = writeQuickDir(top, { id: '261031-s1y', slug: 'real', plan: { tier: 'B', body: 'b' } });
      const quick = join(top, '.planning', 'quick');
      symlinkSync(real, join(quick, '261031-t2z-link'));
      const art = join(quick, '261031-q9z-artlink');
      mkdirSync(art);
      symlinkSync(join(real, '261031-s1y-PLAN.md'), join(art, '261031-q9z-PLAN.md'));
      mkdirSync(join(quick, '261031-bad-name with space'));
      writeQuickDir(top, { id: '261331-m13', slug: 'month', plan: { tier: 'A', body: 'b' } });
      writeQuickDir(top, { id: '260231-f31', slug: 'feb', plan: { body: 'b' } });
      mkdirSync(join(quick, 'random-dir'));
      writeFileSync(join(quick, 'notes.md'), 'n\n');
      commitAll(top, { home: ctx.home });
      writeSessionAt(ctx, top, 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3', 3);
      const env = cliEnv(ctx.home, { TZ: NY });
      const ing = runCli(['ingest'], { home: ctx.home, env });
      assert.equal(ing.status, 0, ing.stderr);
      const lines = linesOf(ing.stdout);
      assert.equal(lines[lines.length - 2],
        'units: git=ok dirs=1 resolved=1 ancestor=0 none=0 deferred=0 repos=1 scanned=1 quick=4 dup_ids=0 skipped=3 '
        + 'plan=0 artifacts=3 facts=ok facts_units=4 facts_deferred=0 facts_dropped=0 roots=0 root_skipped=0 trees=1 trees_dropped=0');
      const doc = JSON.parse(runCli(['units', '--json'], { home: ctx.home, env }).stdout);
      // Plan 02-05 (D-10): an impossible quick-id date is never used; such a unit's start falls back to its earliest git
      // time (here the fixture commit that added its PLAN), and its id_date stays NULL in the store.
      assert.deepEqual(doc.units.map((u) => [u.native_id, u.tier.value, u.start.utc, u.start.date_source, u.start.precision]), [
        ['260231-f31', null, '2026-10-27T12:00:00.000Z', 'git', 'instant'],
        ['261031-q9z', null, '2026-10-31T04:00:00.000Z', 'quick-id', 'day'],
        ['261031-s1y', 'B', '2026-10-31T04:00:00.000Z', 'quick-id', 'day'],
        ['261331-m13', 'A', '2026-10-27T12:00:00.000Z', 'git', 'instant'],
      ]);
      assert.deepEqual(queryDb(storePath(ctx.home), "SELECT native_id FROM unit_obs WHERE id_date IS NULL ORDER BY native_id")
        .map((x) => x.native_id), ['260231-f31', '261331-m13']);
      const text = linesOf(runCli(['units'], { home: ctx.home, env }).stdout);
      assert.ok(text.some((l) => tokens(l).join(' ') === 'edge quick 261331-m13 A frontmatter ? no ? ? 2026-10-27 2026-10-27 git/git ? ? 0/0/0 ? ?'),
        'an unknown timing, risk, novelty and size print ?');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('units and decaying facts', () => {
  it('with no git on PATH ingest says git=unavailable, writes no row for a dir that needs git, and retries next run', () => {
    const ctx = makeHome();
    try {
      buildUnitsHome({ home: ctx.home, root: ctx.root });
      const noGit = join(ctx.home, 'empty-bin');
      mkdirSync(noGit);
      const first = runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home, { TZ: NY, PATH: noGit }) });
      assert.equal(first.status, 0, first.stderr);
      const l1 = linesOf(first.stdout);
      assert.equal(l1[l1.length - 2],
        'units: git=unavailable dirs=3 resolved=0 ancestor=0 none=1 deferred=2 repos=0 scanned=0 quick=0 dup_ids=0 skipped=0 '
        + 'plan=0 artifacts=0 facts=not_needed facts_units=0 facts_deferred=0 facts_dropped=0 roots=0 root_skipped=0 trees=0 trees_dropped=0');
      assert.deepEqual(queryDb(storePath(ctx.home), 'SELECT dir, method FROM dir_repo ORDER BY dir'), [{ dir: '~/gone/place', method: 'none' }]);
      const second = runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home, { TZ: NY }) });
      assert.equal(second.status, 0, second.stderr);
      const l2 = linesOf(second.stdout);
      assert.equal(l2[l2.length - 2],
        'units: git=ok dirs=2 resolved=2 ancestor=0 none=0 deferred=0 repos=2 scanned=2 quick=3 dup_ids=1 skipped=0 '
        + 'plan=0 artifacts=5 facts=ok facts_units=3 facts_deferred=0 facts_dropped=0 roots=0 root_skipped=0 trees=3 trees_dropped=0');
    } finally {
      ctx.cleanup();
    }
  });
});

// Review 02-02 CR-02: a unit reads its tier and artifacts only from the dir stored when it was first seen
// (unit_obs.dir_rel keeps its first value, ADR-0009). A second dir with the same id, seen on a later run and sorting
// first, is counted in dup_ids and never read; a renamed stored dir is such a second dir and the unit stays with its
// stored dir, tier and artifacts (present no while the stored dir is gone); an in-place tier edit is never picked up
// (the first non-NULL letter per artifact is kept). Derive also reads only artifacts under the stored dir, so a store
// that already holds rows of another dir does not change the tier.
describe('a later duplicate, rename or edit never changes a unit (review CR-02)', () => {
  const A1B = '261030-a1b';
  const FIRST = '.planning/quick/261030-a1b-first-task';
  const unitOf = (doc, id) => doc.units.find((u) => u.native_id === id);
  const a1bArtifacts = (home) => queryDb(storePath(home), `SELECT a.rel_path, a.tier_letter FROM unit_artifact a
      JOIN unit_obs o ON o.unit_key = a.unit_key WHERE o.native_id = '${A1B}' ORDER BY a.rel_path`);
  const a1bDir = (home) => queryDb(storePath(home), `SELECT dir_rel FROM unit_obs WHERE native_id = '${A1B}'`)[0]?.dir_rel;
  const FIRST_ARTIFACTS = [
    { rel_path: `${FIRST}/${A1B}-PLAN.md`, tier_letter: 'A' },
    { rel_path: `${FIRST}/${A1B}-SUMMARY.md`, tier_letter: 'A' },
  ];
  const tierB = (body) => `---\ntier: B\n---\n\n${body}\n`;

  function twoRuns(change) {
    const ctx = makeHome();
    const built = buildUnitsHome({ home: ctx.home, root: ctx.root });
    const env = cliEnv(ctx.home, { TZ: NY });
    const first = runCli(['ingest'], { home: ctx.home, env });
    assert.equal(first.status, 0, first.stderr);
    change(built);
    const second = runCli(['ingest'], { home: ctx.home, env });
    assert.equal(second.status, 0, second.stderr);
    const json = runCli(['units', '--json'], { home: ctx.home, env });
    assert.equal(json.status, 0, json.stderr);
    const l2 = linesOf(second.stdout);
    return { ctx, unitsLine: l2[l2.length - 2], doc: JSON.parse(json.stdout) };
  }

  it('an earlier-sorting duplicate dir added after the first ingest is counted, never read, and changes nothing', () => {
    const { ctx, unitsLine, doc } = twoRuns(({ alpha }) => {
      const dup = join(alpha, '.planning', 'quick', `${A1B}-aaa-copy`);
      mkdirSync(dup);
      writeFileSync(join(dup, `${A1B}-PLAN.md`), tierB('A later duplicate.'));
      writeFileSync(join(dup, `${A1B}-SUMMARY.md`), tierB('A later duplicate.'));
    });
    try {
      assert.equal(unitsLine,
        'units: git=not_needed dirs=0 resolved=0 ancestor=0 none=0 deferred=0 repos=2 scanned=2 quick=3 dup_ids=2 skipped=0 '
        + 'plan=0 artifacts=5 facts=not_needed facts_units=0 facts_deferred=0 facts_dropped=0 roots=0 root_skipped=0 trees=3 trees_dropped=0');
      const u = unitOf(doc, A1B);
      assert.deepEqual([u.tier.value, u.tier.conflict, u.dir, u.present], ['A', false, FIRST, true]);
      assert.equal(a1bDir(ctx.home), FIRST);
      assert.deepEqual(a1bArtifacts(ctx.home), FIRST_ARTIFACTS);
    } finally {
      ctx.cleanup();
    }
  });

  it('a renamed stored dir is a duplicate: the unit keeps its dir, tier and artifacts and is no longer present', () => {
    // Plan 02-05: every live working tree is scanned, so the stored dir is renamed in alpha's linked worktree too;
    // while any tree still holds it, the unit is read from there and stays present.
    const { ctx, unitsLine, doc } = twoRuns(({ alpha, worktree }) => {
      for (const top of [alpha, worktree]) {
        const quick = join(top, '.planning', 'quick');
        renameSync(join(quick, `${A1B}-first-task`), join(quick, `${A1B}-renamed`));
      }
      writeFileSync(join(alpha, '.planning', 'quick', `${A1B}-renamed`, `${A1B}-PLAN.md`), tierB('Renamed and retiered.'));
    });
    try {
      assert.equal(unitsLine,
        'units: git=not_needed dirs=0 resolved=0 ancestor=0 none=0 deferred=0 repos=2 scanned=2 quick=2 dup_ids=2 skipped=0 '
        + 'plan=0 artifacts=3 facts=not_needed facts_units=0 facts_deferred=0 facts_dropped=0 roots=0 root_skipped=0 trees=3 trees_dropped=0');
      const u = unitOf(doc, A1B);
      assert.deepEqual([u.tier.value, u.tier.conflict, u.dir, u.present], ['A', false, FIRST, false]);
      assert.equal(a1bDir(ctx.home), FIRST);
      assert.deepEqual(a1bArtifacts(ctx.home), FIRST_ARTIFACTS);
    } finally {
      ctx.cleanup();
    }
  });

  it('an in-place tier edit of the stored PLAN keeps the first letter', () => {
    const { ctx, doc } = twoRuns(({ alpha }) => {
      writeFileSync(join(alpha, FIRST, `${A1B}-PLAN.md`), tierB('Edited in place.'));
    });
    try {
      const u = unitOf(doc, A1B);
      assert.deepEqual([u.tier.value, u.tier.conflict, u.dir, u.present], ['A', false, FIRST, true]);
      assert.deepEqual(a1bArtifacts(ctx.home), FIRST_ARTIFACTS);
    } finally {
      ctx.cleanup();
    }
  });

  it('derive reads a unit\'s tier only from artifacts under its stored dir', () => {
    const ctx = makeHome();
    try {
      buildUnitsHome({ home: ctx.home, root: ctx.root });
      const env = cliEnv(ctx.home, { TZ: NY });
      assert.equal(runCli(['ingest'], { home: ctx.home, env }).status, 0);
      const db = openStore({ home: ctx.home });
      try {
        db.prepare(`INSERT INTO unit_artifact (unit_key, rel_path, role, mtime_ms, first_commit_ms, tier_letter, tier_place,
                      first_seen_run, last_seen_run)
                    SELECT unit_key, '.planning/quick/261030-a1b-aaa/261030-a1b-PLAN.md', 'plan', NULL, NULL, 'B',
                           'frontmatter', first_seen_run, last_seen_run
                      FROM unit_obs WHERE native_id = ?`).run(A1B);
      } finally {
        db.close();
      }
      const doc = JSON.parse(runCli(['units', '--json'], { home: ctx.home, env }).stdout);
      const u = unitOf(doc, A1B);
      assert.deepEqual([u.tier.value, u.tier.native, u.tier.conflict], ['A', 'A', false]);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('units and a pending store migration (D-23)', () => {
  it('units exits 1 with the one-line pending message and changes no byte of store.db', async () => {
    const ctx = makeHome();
    try {
      const all = await loadMigrations(MIGRATIONS);
      openStore({ home: ctx.home, migrations: all.filter((m) => m.version < 7) }).close();
      const before = sha256File(storePath(ctx.home));
      const res = runCli(['units'], { home: ctx.home });
      assert.equal(res.status, 1);
      const err = linesOf(res.stderr);
      assert.equal(err.length, 1);
      assert.match(err[0], /migration pending, back up first/);
      assert.equal(res.stdout, '');
      assert.equal(sha256File(storePath(ctx.home)), before);
    } finally {
      ctx.cleanup();
    }
  });
});

// Plan 02-05 Task 2 (ADPT-01, UNIT-05, D-09, D-10): every artifact role, phase plans with phase-level files, D-10
// dates, every live working tree and configured roots, on the adapter fixture (test/fixtures/adapter-home.mjs).
// Modules this plan creates are imported inside each case.
describe('the adapter home: roles, phase plans, worktrees and dates (plan 02-05)', () => {
  let ctx;
  let built;
  let env;
  const r = {};
  before(async () => {
    const { buildAdapterHome } = await import('../fixtures/adapter-home.mjs');
    ctx = makeHome();
    built = buildAdapterHome({ home: ctx.home, root: ctx.root });
    env = cliEnv(ctx.home, { TZ: 'UTC' });
    r.ingest = runCli(['ingest'], { home: ctx.home, env });
    r.json = runCli(['units', '--json'], { home: ctx.home, env });
    r.text = runCli(['units'], { home: ctx.home, env });
  });
  after(() => ctx.cleanup());
  const docOf = () => {
    assert.equal(r.json.status, 0, r.json.stderr);
    return JSON.parse(r.json.stdout);
  };

  it('units --json lists the worktree-only unit of the untracked repo', () => {
    const doc = docOf();
    assert.ok(doc.units.some((u) => u.key === built.expected.worktreeOnly), `${built.expected.worktreeOnly} listed`);
  });

  it('units --json lists exactly the omega and sigma units in order', () => {
    assert.deepEqual(docOf().units.map((u) => u.key), built.expected.units);
  });

  it('the units: line counts the duplicate and the skipped entries and ends with roots and trees', () => {
    assert.equal(r.ingest.status, 0, r.ingest.stderr);
    const lines = linesOf(r.ingest.stdout);
    const u = lines[lines.length - 2];
    assert.match(u, new RegExp(` dup_ids=${built.expected.dupIds} skipped=${built.expected.skipped} `));
    assert.ok(u.endsWith(' roots=0 root_skipped=0 trees=3 trees_dropped=0'), u);
  });

  it('artifact counts per role follow the file-name rules and the phase-level rule', () => {
    const doc = docOf();
    for (const [key, counts] of Object.entries(built.expected.artifacts)) {
      assert.deepEqual(doc.units.find((u) => u.key === key)?.artifacts, counts, key);
    }
  });

  it('tiers: the CONTEXT letter is never a signal and a probes-skipped tier is not comparable', () => {
    const doc = docOf();
    for (const [key, [value, signal, conflict, comparable]] of Object.entries(built.expected.tiers)) {
      const u = doc.units.find((x) => x.key === key);
      assert.deepEqual([u?.tier.value, u?.tier.signal, u?.tier.conflict, u?.tier.comparable], [value, signal, conflict, comparable], key);
    }
    const comparable = doc.units.filter((u) => u.tier.value !== null && u.tier.signal !== 'probes-skipped').length;
    assert.equal(doc.strata[1].counts.comparable, comparable);
  });

  it('D-10 dates: quick-id, frontmatter, mtime and git with their sources, precision and git evidence', () => {
    const doc = docOf();
    for (const [key, d] of Object.entries(built.expected.dates)) {
      const u = doc.units.find((x) => x.key === key);
      assert.deepEqual([u?.start.utc, u?.start.date_source, u?.start.precision], d.start, `${key} start`);
      assert.deepEqual([u?.end.utc, u?.end.date_source, u?.end.precision], d.end, `${key} end`);
      assert.equal(u?.git_evidence, d.git, `${key} git_evidence`);
    }
    assert.ok(linesOf(r.text.stdout).some((l) => tokens(l)[2] === '261025-s1a' && tokens(l)[11] === 'quick-id/frontmatter'));
  });

  it('no output or database byte holds the worktree directory name or a planted phrase', async () => {
    const { ADAPTER_PLANT } = await import('../fixtures/adapter-home.mjs');
    const { readFileSync, existsSync } = await import('node:fs');
    const outs = [r.ingest.stdout, r.ingest.stderr, r.json.stdout, r.text.stdout];
    const state = join(ctx.home, '.rigorscope');
    const files = ['store.db', 'store.db-wal', 'store.db-shm', 'derived.db'].map((f) => join(state, f)).filter((f) => existsSync(f));
    for (const needle of ['sigma-wip', ADAPTER_PLANT]) {
      for (const o of outs) assert.ok(!o.includes(needle), `output holds ${needle}`);
      for (const f of files) assert.ok(!readFileSync(f).includes(Buffer.from(needle)), `a database file holds ${needle}`);
    }
  });
});

describe('configured repo roots (D-09)', () => {
  it('RIGORSCOPE_REPO_ROOTS adds a repo no session reached, counts skipped entries and prints no path', async () => {
    const { buildAdapterHome } = await import('../fixtures/adapter-home.mjs');
    const ctx = makeHome();
    try {
      const built = buildAdapterHome({ home: ctx.home, root: ctx.root });
      const roots = [built.tau, built.plainDir, 'relative/x'].join(':');
      const env = cliEnv(ctx.home, { TZ: 'UTC', RIGORSCOPE_REPO_ROOTS: roots });
      const ing = runCli(['ingest'], { home: ctx.home, env });
      assert.equal(ing.status, 0, ing.stderr);
      const lines = linesOf(ing.stdout);
      assert.ok(lines[lines.length - 2].endsWith(' roots=1 root_skipped=2 trees=4 trees_dropped=0'), lines[lines.length - 2]);
      for (const part of ['elsewhere', 'plain-dir', 'relative/x']) {
        assert.ok(!ing.stdout.includes(part) && !ing.stderr.includes(part), `ingest prints no part of ${part}`);
      }
      const doc = JSON.parse(runCli(['units', '--json'], { home: ctx.home, env }).stdout);
      assert.ok(doc.units.some((u) => u.key === built.expected.rootOnly), 'the root-only unit is listed');
    } finally {
      ctx.cleanup();
    }
  });

  it('with the variable unset the root-only repo yields no unit', async () => {
    const { buildAdapterHome } = await import('../fixtures/adapter-home.mjs');
    const ctx = makeHome();
    try {
      const built = buildAdapterHome({ home: ctx.home, root: ctx.root });
      const env = cliEnv(ctx.home, { TZ: 'UTC' });
      assert.equal(runCli(['ingest'], { home: ctx.home, env }).status, 0);
      const doc = JSON.parse(runCli(['units', '--json'], { home: ctx.home, env }).stdout);
      assert.ok(!doc.units.some((u) => u.key === built.expected.rootOnly));
    } finally {
      ctx.cleanup();
    }
  });

  it('parseRepoRoots keeps absolute, bounded, control-free entries, at most MAX_REPO_ROOTS', async () => {
    const { parseRepoRoots, MAX_REPO_ROOTS, REPO_ROOTS_ENV } = await import('../../src/units/roots.mjs');
    assert.equal(REPO_ROOTS_ENV, 'RIGORSCOPE_REPO_ROOTS');
    assert.deepEqual(parseRepoRoots({}), { roots: [], skipped: 0 });
    assert.deepEqual(parseRepoRoots({ RIGORSCOPE_REPO_ROOTS: '' }), { roots: [], skipped: 0 });
    const long = `/${'a'.repeat(1024)}`;
    const got = parseRepoRoots({ RIGORSCOPE_REPO_ROOTS: ['/srv/a', '', 'rel/b', '/x\u0001y', long, '/srv/c', '::'].join(':') });
    assert.deepEqual(got, { roots: ['/srv/a', '/srv/c'], skipped: 3 });
    const many = Array.from({ length: MAX_REPO_ROOTS + 3 }, (_, i) => `/r${i}`).join(':');
    const m = parseRepoRoots({ RIGORSCOPE_REPO_ROOTS: many });
    assert.equal(m.roots.length, MAX_REPO_ROOTS);
    assert.equal(m.skipped, 3);
  });
});

describe('worktree scanning falls back to the main tree when git cannot list worktrees', () => {
  it('an injected runner failing worktree list scans the main tree only; the default lists the linked worktree too', async () => {
    const { buildAdapterHome, ADAPTER_EXPECTED } = await import('../fixtures/adapter-home.mjs');
    const { collectUnits } = await import('../../src/adapters/gsd-core/index.mjs');
    const { defaultGitRun } = await import('../../src/adapters/gsd-core/signals.mjs');
    const ctx = makeHome();
    try {
      buildAdapterHome({ home: ctx.home, root: ctx.root });
      const keysWith = async (run) => {
        const db = openStore({ home: ctx.home });
        try {
          db.exec('DELETE FROM unit_artifact_time; DELETE FROM unit_artifact; DELETE FROM unit_path; DELETE FROM unit_obs; DELETE FROM repo');
          db.exec("INSERT OR IGNORE INTO ingest_run (run_id, started_utc, trigger, status) VALUES (1, '2026-01-01T00:00:00.000Z', 'test', 'running')");
          db.prepare('INSERT INTO repo (repo_key, repo_name, first_seen_run, last_seen_run) VALUES (?, ?, 1, 1)').run(ADAPTER_EXPECTED.keys.sigma, 'sigma');
          const res = await collectUnits({ db, home: ctx.home, runId: 1, ...(run ? { run } : {}) });
          return { res, keys: db.prepare('SELECT unit_key FROM unit_obs ORDER BY unit_key').all().map((x) => x.unit_key) };
        } finally {
          db.close();
        }
      };
      const failing = (args) => (args.includes('worktree') ? { status: null, stdout: '', errorCode: 'ETIMEDOUT' } : defaultGitRun(args));
      const main = await keysWith(failing);
      assert.ok(!main.keys.includes(ADAPTER_EXPECTED.worktreeOnly));
      assert.ok(main.keys.includes(`gsd-core:${ADAPTER_EXPECTED.keys.sigma}:quick:261025-s1a`));
      assert.equal(main.res.trees, 1);
      const all = await keysWith(undefined);
      assert.ok(all.keys.includes(ADAPTER_EXPECTED.worktreeOnly));
      assert.equal(all.res.trees, 2);
    } finally {
      ctx.cleanup();
    }
  });
});
