// Plan 02-05 tracer (UNIT-03, UNIT-04, UNIT-05, TIER-02; D-01..D-07, D-10, D-17, D-23): the golden fixture repos of
// plan 02-03 travel through phase-plan discovery, the stored git facts of migration 007 (unit_path, unit_commit,
// unit_commit_file, unit_module_dir, unit_git_scan, unit_artifact_time) and derive into `units --json`, and every
// derived attribute equals what 02-03's scored rules compute over 02-03's own collector. Written before the code
// (RED).
//
// The CLI is spawned on a temporary HOME from makeHome(); every git repository is created by
// test/fixtures/golden-repo.mjs inside it. The modules this plan creates (artifacts.mjs, facts.mjs) are never imported
// here; the 02-03 collector and rules are imported (they exist), and the store is read with queryDb only.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import {
  cliEnv, makeAssistant, makeHome, makeUsage, mangleHome, queryDb, runCli, writeJsonl,
} from '../fixtures/build.mjs';
import { buildGoldenRepo, goldenMs } from '../fixtures/golden-repo.mjs';
import { predict } from '../golden/score.mjs';
import { collectUnitSignals, noveltyInputs, unitCommits } from '../../src/adapters/gsd-core/signals.mjs';
import { loadRiskRules } from '../../src/units/risk-rules.mjs';
import { noveltyOf } from '../../src/units/novelty.mjs';
import { derivedPath, storePath } from '../../src/db.mjs';

const KEYS = Object.freeze({
  ccc: 'gsd-core:~/src/delta/.git:quick:261022-ccc',
  p0301: 'gsd-core:~/src/gamma/.git:plan:03-01',
  aaa: 'gsd-core:~/src/gamma/.git:quick:261020-aaa',
  bbb: 'gsd-core:~/src/gamma/.git:quick:261021-bbb',
});
const ORDER = [KEYS.ccc, KEYS.p0301, KEYS.aaa, KEYS.bbb];
const UNITS = Object.freeze({
  [KEYS.ccc]: { repo: 'delta', kind: 'quick', nativeId: '261022-ccc' },
  [KEYS.p0301]: { repo: 'gamma', kind: 'plan', nativeId: '03-01' },
  [KEYS.aaa]: { repo: 'gamma', kind: 'quick', nativeId: '261020-aaa' },
  [KEYS.bbb]: { repo: 'gamma', kind: 'quick', nativeId: '261021-bbb' },
});
// The delta PLAN's fixed mtime: its end date when no git time exists.
const CCC_PLAN_MTIME = '2026-10-23T08:00:00.000Z';
const CCC_PLAN = '.planning/quick/261022-ccc-untracked/261022-ccc-PLAN.md';
const iso = (name) => new Date(goldenMs(name)).toISOString();
const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const tokens = (line) => line.trim().split(/\s+/);
const lineCount = (text) => text.split('\n').length - 1;
const HEX64 = /^[0-9a-f]{64}$/;

function writeSession(root, cwd, session, sec) {
  const line = makeAssistant({
    session, ts: `2026-10-27T15:00:0${sec}.000Z`, id: `msg_facts_${sec}`, model: 'claude-opus-5-5', cwd,
    use: makeUsage({ input: 3, output: 2, read: 0, creation: 0 }),
  });
  writeJsonl(join(root, 'projects', mangleHome(cwd), `${session}.jsonl`), [JSON.stringify(line)]);
}

describe('stored git facts and derived unit attributes on the golden fixture (tracer)', () => {
  let ctx;
  let built;
  let env;
  const r = {};
  const expected = {};
  let riskTable;
  before(() => {
    ctx = makeHome();
    built = buildGoldenRepo({ home: ctx.home });
    utimesSync(join(built.delta, CCC_PLAN), new Date(CCC_PLAN_MTIME), new Date(CCC_PLAN_MTIME));
    writeSession(ctx.root, built.gamma, 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1', 1);
    writeSession(ctx.root, built.delta, 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2', 2);
    env = cliEnv(ctx.home, { TZ: 'UTC' });
    r.ingest1 = runCli(['ingest'], { home: ctx.home, env });
    r.json1 = runCli(['units', '--json'], { home: ctx.home, env });
    r.text1 = runCli(['units'], { home: ctx.home, env });
    r.ingest2 = runCli(['ingest'], { home: ctx.home, env });
    r.json2 = runCli(['units', '--json'], { home: ctx.home, env });
    riskTable = loadRiskRules();
    for (const key of ORDER) {
      const u = UNITS[key];
      const top = u.repo === 'gamma' ? built.gamma : built.delta;
      const row = collectUnitSignals({ top, kind: u.kind, nativeId: u.nativeId, home: ctx.home });
      const full = {
        schema_version: 1, repo: u.repo, kind: u.kind, native_id: u.nativeId, ...row,
      };
      const newDirs = noveltyInputs({ top, commits: row.commits });
      expected[key] = {
        row,
        top,
        pred: predict(full, { riskTable }),
        novelty: noveltyOf({ commits: row.commits, newDirs }),
        newDirs,
        commits: unitCommits({ top, kind: u.kind, nativeId: u.nativeId })?.commits ?? null,
      };
    }
  });
  after(() => ctx.cleanup());

  const docOf = (res) => {
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };
  const unitOf = (doc, key) => doc.units.find((u) => u.key === key);
  const q = (sql) => queryDb(storePath(ctx.home), sql);

  it('ingest exits 0 and its units: line carries plan, artifacts and the facts fields in order', () => {
    assert.equal(r.ingest1.status, 0, r.ingest1.stderr);
    const lines = linesOf(r.ingest1.stdout);
    assert.match(lines[lines.length - 1], /^ingest: files=/);
    const u = lines[lines.length - 2];
    assert.match(u, /^units: git=ok dirs=2 resolved=2 ancestor=0 none=0 deferred=0 repos=2 scanned=2 quick=3 dup_ids=0 skipped=0 /);
    assert.match(u, / plan=1 artifacts=\d+ facts=ok facts_units=4 facts_deferred=0(?: |$)/);
  });

  it('units --json lists the phase plan and the quick units of both repos in order', () => {
    const doc = docOf(r.json1);
    assert.deepEqual(doc.units.map((u) => u.key), ORDER);
  });

  it('tier, risk and novelty of every unit equal predict() and noveltyOf over the 02-03 collector', () => {
    const doc = docOf(r.json1);
    for (const key of ORDER) {
      const u = unitOf(doc, key);
      const e = expected[key];
      assert.ok(u, key);
      assert.deepEqual(
        [u.tier.value, u.tier.native, u.tier.signal, u.tier.timing, u.tier.conflict],
        [e.pred.tier, e.pred.tier_native, e.pred.tier_signal, e.pred.tier_timing, e.pred.tier_conflict],
        `${key} tier`,
      );
      assert.deepEqual([u.risk_class.value, u.risk_class.source], [e.pred.risk_class, e.pred.risk_source], `${key} risk`);
      assert.equal(u.risk_class.label, e.pred.risk_class === null ? 'unavailable' : 'reconstructed');
      assert.deepEqual([u.novelty.value, u.novelty.source], [e.novelty.novelty, e.novelty.novelty_source], `${key} novelty`);
      assert.equal(u.novelty.label, e.novelty.novelty === null ? 'unavailable' : 'reconstructed');
      assert.equal(u.tier.comparable, true, `${key} comparable`);
    }
  });

  it('the hand-checked values of the tracer truth hold', () => {
    const doc = docOf(r.json1);
    const pick = (key) => {
      const u = unitOf(doc, key);
      return [u.tier.value, u.tier.signal, u.tier.timing, u.tier.conflict, u.novelty.value, u.novelty.source];
    };
    assert.deepEqual(pick(KEYS.aaa), ['B', 'tier-file', 'declared-at-start', false, 'incremental', 'rule:incremental@1']);
    assert.deepEqual(pick(KEYS.bbb), ['A', 'frontmatter', 'declared-at-close', true, 'first-of-kind', 'rule:new-dir@1']);
    assert.deepEqual(pick(KEYS.p0301), ['A', 'frontmatter', 'declared-at-start', false, 'first-of-kind', 'rule:new-command@1']);
    assert.deepEqual(pick(KEYS.ccc), ['B', 'frontmatter', null, false, null, 'no-evidence']);
  });

  it('03-01 has git dates, git evidence and a unit size counted outside .planning/', () => {
    const doc = docOf(r.json1);
    const u = unitOf(doc, KEYS.p0301);
    const zapLines = lineCount(readFileSync(join(built.gamma, 'src/commands/zap.mjs'), 'utf8'));
    assert.deepEqual(u.start, { utc: iso('P0'), date_source: 'git', precision: 'instant', label: 'reconstructed' });
    assert.deepEqual(u.end, { utc: iso('P1'), date_source: 'git', precision: 'instant', label: 'reconstructed' });
    assert.equal(u.git_evidence, true);
    // Plan 02-07 adds the transcript, worker and env confounders next to unit_size (asserted in unit-links.test.mjs).
    assert.deepEqual(u.confounders.unit_size, {
      value: {
        commits: 2, files: 1, added: zapLines, deleted: 0,
      },
      source: 'git',
      label: 'reconstructed',
    });
  });

  it('the untracked delta unit has no git evidence, quick-id and mtime dates and an unknown unit size', () => {
    const doc = docOf(r.json1);
    const u = unitOf(doc, KEYS.ccc);
    assert.equal(u.git_evidence, false);
    assert.deepEqual(u.start, {
      utc: '2026-10-22T00:00:00.000Z', date_source: 'quick-id', precision: 'day', label: 'reconstructed',
    });
    assert.deepEqual(u.end, {
      utc: CCC_PLAN_MTIME, date_source: 'mtime', precision: 'instant', label: 'reconstructed',
    });
    assert.deepEqual(u.confounders.unit_size, { value: null, source: null, label: 'unavailable' });
  });

  it('counts carry comparable, git_evidence and risk_known', () => {
    const doc = docOf(r.json1);
    const riskKnown = ORDER.filter((k) => expected[k].pred.risk_class !== null).length;
    assert.equal(doc.strata[1].counts.comparable, 4);
    assert.equal(doc.strata[1].counts.git_evidence, 3);
    assert.equal(doc.strata[1].counts.risk_known, riskKnown);
  });

  it('units (text) prints the new header, the 03-01 row, the ccc row ending and the counts', () => {
    assert.equal(r.text1.status, 0, r.text1.stderr);
    const lines = linesOf(r.text1.stdout);
    const head = lines.findIndex((l) => tokens(l)[0] === 'repo' && tokens(l)[1] === 'kind');
    assert.ok(head > 0, 'header line');
    assert.equal(tokens(lines[head]).join(' '), 'repo kind id tier signal timing conflict risk novelty start end dates files lines links tokens usd');
    const p = expected[KEYS.p0301].pred;
    const risk = p.risk_class === null ? '?' : (p.risk_class.length === 0 ? 'none' : p.risk_class.join(','));
    const zapLines = lineCount(readFileSync(join(built.gamma, 'src/commands/zap.mjs'), 'utf8'));
    assert.ok(lines.some((l) => tokens(l).join(' ')
      === `gamma plan 03-01 A frontmatter declared-at-start no ${risk} first-of-kind 2026-10-20 2026-10-20 git/git 1 ${zapLines} 0/0/0 ? ?`),
    r.text1.stdout);
    const ccc = lines.find((l) => tokens(l)[0] === 'delta' && tokens(l)[2] === '261022-ccc');
    assert.ok(ccc, 'ccc row');
    assert.match(tokens(ccc).join(' '), / quick-id\/mtime \? \? 0\/0\/0 \? \?$/);
    const riskKnown = ORDER.filter((k) => expected[k].pred.risk_class !== null).length;
    const countLine = lines.filter((l) => l.startsWith('units: n=')).pop();
    assert.ok(countLine?.endsWith(` comparable=4 git_evidence=3 risk_known=${riskKnown} plan_unbounded=0 end_clamped=1 declared_at_close=0`), countLine);
  });

  it('store.db holds one scan row per unit and the commits, files, module dirs and paths of the collector', () => {
    const scans = q('SELECT unit_key, refs_sha, commits FROM unit_git_scan ORDER BY unit_key');
    assert.deepEqual(scans.map((s) => s.unit_key), [...ORDER].sort());
    for (const s of scans) assert.match(s.refs_sha, HEX64);
    for (const key of ORDER) {
      const want = expected[key].commits;
      const got = q(`SELECT sha FROM unit_commit WHERE unit_key = '${key}' ORDER BY author_ms, sha`).map((c) => c.sha);
      assert.deepEqual(got, want.map((c) => c.sha), `${key} commits`);
      const files = q(`SELECT sha, rel_path, status, added, deleted FROM unit_commit_file WHERE unit_key = '${key}'
                        ORDER BY sha, rel_path`);
      const wantFiles = want.flatMap((c) => c.files.map((f) => [c.sha, f.path, f.status]))
        .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
      assert.deepEqual(files.map((f) => [f.sha, f.rel_path, f.status]).sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1)), wantFiles, `${key} files`);
      for (const f of files) {
        assert.ok(['A', 'M', 'D'].includes(f.status));
        for (const n of [f.added, f.deleted]) assert.ok(n === null || (Number.isInteger(n) && n >= 0));
      }
      const dirs = q(`SELECT module_dir, existed FROM unit_module_dir WHERE unit_key = '${key}' ORDER BY module_dir`);
      const nd = expected[key].newDirs;
      const wantDirs = nd === null ? [] : [...nd.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([d, e]) => ({ module_dir: d, existed: e === null ? null : (e ? 1 : 0) }));
      assert.deepEqual(dirs, wantDirs, `${key} module dirs`);
    }
    assert.deepEqual(q(`SELECT module_dir, existed FROM unit_module_dir WHERE unit_key = '${KEYS.bbb}'`), [{ module_dir: 'src/new', existed: 0 }]);
    assert.deepEqual(q(`SELECT count(*) AS n FROM unit_commit WHERE unit_key = '${KEYS.ccc}'`), [{ n: 0 }]);
    const zap = q(`SELECT status, added, deleted FROM unit_commit_file WHERE unit_key = '${KEYS.p0301}' AND rel_path = 'src/commands/zap.mjs'`);
    const zapLines = lineCount(readFileSync(join(built.gamma, 'src/commands/zap.mjs'), 'utf8'));
    assert.deepEqual(zap, [{ status: 'A', added: zapLines, deleted: 0 }]);
    assert.deepEqual(q(`SELECT rel_path, path_source FROM unit_path WHERE unit_key = '${KEYS.aaa}' ORDER BY rel_path`), [
      { rel_path: 'hooks/gate.mjs', path_source: 'files_modified' },
      { rel_path: 'scripts/tool.sh', path_source: 'files_modified' },
      { rel_path: '~/.claude/settings.json', path_source: 'files_modified' },
    ]);
  });

  it('tier_commit_ms is stored exactly for the frontmatter artifacts with a letter in tracked repos', () => {
    const got = q('SELECT rel_path, tier_commit_ms FROM unit_artifact_time WHERE tier_commit_ms IS NOT NULL ORDER BY rel_path');
    const want = ORDER.flatMap((k) => expected[k].row.artifacts)
      .filter((a) => a.tier_commit_ms !== null)
      .map((a) => ({ rel_path: a.rel_path, tier_commit_ms: a.tier_commit_ms }))
      .sort((a, b) => (a.rel_path < b.rel_path ? -1 : 1));
    assert.ok(want.length >= 2);
    assert.deepEqual(got, want);
  });

  it('derive_state records the risk table file, version and sha', () => {
    const st = queryDb(derivedPath(ctx.home), 'SELECT risk_rules_file, risk_rules_version, risk_rules_sha FROM derive_state');
    assert.deepEqual(st, [{ risk_rules_file: riskTable.file, risk_rules_version: '2026-10-30', risk_rules_sha: riskTable.sha }]);
  });

  it('a second ingest on unchanged refs scans no unit and units --json prints byte-identical stdout', () => {
    assert.equal(r.ingest2.status, 0, r.ingest2.stderr);
    const lines = linesOf(r.ingest2.stdout);
    assert.match(lines[lines.length - 2], / facts=not_needed facts_units=0 /);
    assert.equal(r.json2.status, 0, r.json2.stderr);
    assert.equal(r.json2.stdout, r.json1.stdout);
  });

});
