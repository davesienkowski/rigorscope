// Integration tests of the artifact classification (plan 03.1-04, ADPT-04, D-08, D-21): the CLI is spawned on a temporary HOME,
// the fixture repo is built inside it and reached through RIGORSCOPE_REPO_ROOTS, and the store is read with queryDb only.
// Expectations are computed by hand from the roster file and the plan's tables, never from the adapter. The shipped roster
// file is read here as plain JSON, only for the ref.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  cliEnv, makeHome, queryDb, runCli,
} from '../fixtures/build.mjs';
import {
  addWorktree, archiveDir, commitAll, makeRepo, planText, writeFileAt, writePlanningDir,
} from '../fixtures/git-repo.mjs';
import { STOCK_LAYOUTS } from '../fixtures/stock-layouts.mjs';
import { openStore, storePath } from '../../src/db.mjs';

const REF12 = JSON.parse(readFileSync(new URL('../../src/adapters/gsd-core/roster.json', import.meta.url), 'utf8')).ref.slice(0, 12);
const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const NOTE = '# note\n';

function setup(name, build) {
  const ctx = makeHome();
  const repo = join(ctx.home, 'src', name);
  makeRepo(repo, { home: ctx.home, files: { 'README.md': `${name}\n` } });
  build(repo, ctx.home);
  const env = cliEnv(ctx.home, { TZ: 'UTC', RIGORSCOPE_REPO_ROOTS: repo });
  return {
    ctx, repo, env, repoKey: `~/src/${name}/.git`,
  };
}
const run = (s, args) => {
  const r = runCli(args, { home: s.ctx.home, env: s.env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const ingest = (s) => linesOf(run(s, ['ingest']));
const rows = (s, sql, params = []) => queryDb(storePath(s.ctx.home), sql, params);
const classesOf = (lines) => {
  const line = lines.find((l) => l.startsWith('classes: '));
  assert.ok(line, 'a classes line');
  return Object.fromEntries(line.slice('classes: '.length).split(' ').map((t) => t.split('=')));
};

// The tracer table row of the plan: SUMMARY is finding-bearing, PLAN and RESEARCH are step evidence, the note is in no entry.
const tracerBuild = (repo) => {
  writePlanningDir(repo, {
    under: 'phases',
    name: '01-a',
    files: {
      '01-01-PLAN.md': planText({ tier: 'B' }),
      '01-01-SUMMARY.md': planText({ tier: 'B' }),
      '01-RESEARCH.md': NOTE,
      'weird-note.md': NOTE,
    },
  });
};

describe('tracer: one live phase dir classified end to end', () => {
  let s;
  let lines;
  before(() => {
    s = setup('trace', tracerBuild);
    lines = ingest(s);
  });
  after(() => s.ctx.cleanup());

  it('prints a classes line directly after locations and before env, with the hand-computed counts and the ref', () => {
    const at = lines.findIndex((l) => l.startsWith('classes: '));
    assert.ok(at > 0, 'the line is printed');
    assert.equal(lines.filter((l) => l.startsWith('classes: ')).length, 1);
    assert.ok(lines[at - 1].startsWith('locations: '), 'directly after locations');
    assert.ok(lines[at + 1].startsWith('env: '), 'directly before env');
    assert.equal(lines[at], `classes: repos=1 recognized_f=1 recognized_e=2 recognized_s=0 unclassified=1 roster_ref=${REF12}`);
    const got = classesOf(lines);
    assert.deepEqual(Object.keys(got), ['repos', 'recognized_f', 'recognized_e', 'recognized_s', 'unclassified', 'roster_ref']);
  });

  it('stores one row per class kind for the repo (zero rows too) and the stem rows of the run', () => {
    const got = rows(s, "SELECT kind, name, n FROM ingest_count WHERE source = 'units' AND kind IN ('recognized_f','recognized_e','recognized_s','unclassified','unclassified_stem','unclassified_stem_other') ORDER BY kind, name");
    assert.deepEqual(got, [
      { kind: 'recognized_e', name: s.repoKey, n: 2 },
      { kind: 'recognized_f', name: s.repoKey, n: 1 },
      { kind: 'recognized_s', name: s.repoKey, n: 0 },
      { kind: 'unclassified', name: s.repoKey, n: 1 },
      { kind: 'unclassified_stem', name: 'weird-note.md', n: 1 },
      { kind: 'unclassified_stem_other', name: '*', n: 0 },
    ]);
  });

  it('doctor prints an unclassified section naming the stem, worded as not in the roster at the ref', () => {
    const out = run(s, ['doctor']);
    const text = linesOf(out);
    const at = text.findIndex((l) => l.startsWith('unclassified: '));
    assert.ok(at >= 0, 'the unclassified section is printed');
    assert.match(text[at], new RegExp(`^unclassified: files=1 repos=1 not_in_roster_at_ref=${REF12}$`));
    const detail = [];
    for (let i = at + 1; i < text.length && text[i].startsWith('  '); i += 1) detail.push(text[i]);
    assert.ok(detail.includes('  stem weird-note.md n=1'), detail.join('|'));
    assert.ok(detail.includes('  other n=0'), detail.join('|'));
  });

  it('doctor --json carries the same section', () => {
    const doc = JSON.parse(run(s, ['doctor', '--json']));
    assert.equal(doc.unclassified.files, 1);
    assert.equal(doc.unclassified.repos, 1);
    assert.equal(doc.unclassified.roster_ref, REF12);
    assert.deepEqual(doc.unclassified.stems, [{ stem: 'weird-note.md', n: 1 }]);
    assert.equal(doc.unclassified.other, 0);
  });
});

describe('unknown is never shown as zero', () => {
  it('a HOME with no scanned repo prints repos=0 and ? for every count, and doctor says unavailable or unknown', () => {
    const ctx = makeHome();
    try {
      const env = cliEnv(ctx.home, { TZ: 'UTC' });
      const r = runCli(['ingest'], { home: ctx.home, env });
      assert.equal(r.status, 0, r.stderr);
      const got = classesOf(linesOf(r.stdout));
      assert.equal(got.repos, '0');
      for (const k of ['recognized_f', 'recognized_e', 'recognized_s', 'unclassified']) assert.equal(got[k], '?', k);
      assert.equal(got.roster_ref, REF12);
      const d = runCli(['doctor'], { home: ctx.home, env });
      assert.equal(d.status, 0, d.stderr);
      const line = linesOf(d.stdout).find((l) => l.startsWith('unclassified: '));
      assert.ok(line, 'the key line is always printed');
      assert.doesNotMatch(line, /files=0/);
    } finally {
      ctx.cleanup();
    }
  });

  it('a repo whose latest scan predates classification shows ?, not 0', () => {
    const s = setup('older', tracerBuild);
    try {
      ingest(s);
      // Simulate the store of an earlier release: the sentinel exists, the class rows do not.
      const db = openStore({ home: s.ctx.home });
      try {
        db.exec("DELETE FROM ingest_count WHERE source = 'units' AND kind IN ('recognized_f','recognized_e','recognized_s','unclassified','unclassified_stem','unclassified_stem_other')");
      } finally {
        db.close();
      }
      const doc = JSON.parse(run(s, ['doctor', '--json']));
      assert.equal(doc.unclassified.files, null);
      assert.equal(doc.unclassified.unknown_repos, 1);
      const text = run(s, ['doctor']);
      assert.match(text, /^unclassified: files=\? repos=0 unknown_repos=1 /m);
    } finally {
      s.ctx.cleanup();
    }
  });
});

describe('the stem filter through the CLI (T-03.1-11)', () => {
  it('a name over 64 characters is counted unclassified but its stem goes to the remainder row', () => {
    const long = `${'long'.repeat(20)}.md`; // 83 characters: inside the 128 name shape, outside the 64 stem shape
    const s = setup('longstem', (repo) => {
      writePlanningDir(repo, {
        under: 'phases', name: '01-a', files: { '01-01-PLAN.md': planText({ tier: 'B' }), [long]: NOTE, 'ok-note.md': NOTE },
      });
    });
    try {
      const lines = ingest(s);
      assert.equal(classesOf(lines).unclassified, '2');
      const stems = rows(s, "SELECT name, n FROM ingest_count WHERE source = 'units' AND kind = 'unclassified_stem' ORDER BY name");
      assert.deepEqual(stems, [{ name: 'ok-note.md', n: 1 }]);
      const other = rows(s, "SELECT n FROM ingest_count WHERE source = 'units' AND kind = 'unclassified_stem_other'");
      assert.deepEqual(other, [{ n: 1 }]);
      const everything = JSON.stringify(rows(s, 'SELECT name FROM ingest_count'));
      assert.ok(!everything.includes(long), 'the long name is stored nowhere');
    } finally {
      s.ctx.cleanup();
    }
  });
});

// ---- Task 2: the cases of the plan's hand-computed table, through the CLI --------------------------------------------------

const countsOf = (lines) => {
  const c = classesOf(lines);
  return {
    f: c.recognized_f, e: c.recognized_e, s: c.recognized_s, u: c.unclassified,
  };
};
const stemRows = (s, run = null) => rows(
  s,
  `SELECT name, n FROM ingest_count WHERE source = 'units' AND kind = 'unclassified_stem'${run === null ? '' : ' AND run_id = ?'} ORDER BY name`,
  run === null ? [] : [run],
);

describe('quick dir, milestones files and a coded phase dir', () => {
  it('quick: PLAN E, SUMMARY F, REVIEW F and three unclassified names with their stems', () => {
    const s = setup('quick', (repo) => {
      writePlanningDir(repo, {
        under: 'quick',
        name: '260101-abc-t',
        files: {
          '260101-abc-PLAN.md': planText({ tier: 'B' }),
          '260101-abc-SUMMARY.md': planText({ tier: 'B' }),
          'REVIEW.md': NOTE,
          'RIGOR-TIER.md': 'Tier: B\n',
          '260101-abc-PROBES-SKIPPED.md': 'Tier B skip\n',
          'x-123.log': NOTE,
        },
      });
    });
    try {
      assert.deepEqual(countsOf(ingest(s)), {
        f: '2', e: '1', s: '0', u: '3',
      });
      assert.deepEqual(stemRows(s), [
        { name: 'PROBES-SKIPPED.md', n: 1 }, { name: 'RIGOR-TIER.md', n: 1 }, { name: 'x-N.log', n: 1 },
      ]);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('milestones: the roadmap and requirements archives S, the audit F, a label without a v, notes.txt unclassified (files directly under the milestones dir)', () => {
    const s = setup('miles', (repo) => {
      writeFileAt(repo, '.planning/milestones/v1.0-ROADMAP.md', NOTE);
      writeFileAt(repo, '.planning/milestones/v1.0-REQUIREMENTS.md', NOTE);
      writeFileAt(repo, '.planning/milestones/v1.0-MILESTONE-AUDIT.md', NOTE);
      writeFileAt(repo, '.planning/milestones/1.1-ROADMAP.md', NOTE);
      writeFileAt(repo, '.planning/milestones/beta-MILESTONE-AUDIT.md', NOTE);
      writeFileAt(repo, '.planning/milestones/notes.txt', NOTE);
    });
    try {
      assert.deepEqual(countsOf(ingest(s)), {
        f: '2', e: '0', s: '3', u: '1',
      });
      assert.deepEqual(stemRows(s), [{ name: 'notes.txt', n: 1 }]);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('the quick archive index (milestones/<label>-quick/README.md) is S, a stray note beside it is unclassified (WR-01)', () => {
    const s = setup('quickidx', (repo) => {
      writeFileAt(repo, '.planning/milestones/v1.0-quick/README.md', NOTE);
      writeFileAt(repo, '.planning/milestones/v1.0-quick/notes.txt', NOTE);
      // The accepted overlap: the quick-root scope also covers the live root, so a README.md there is S too.
      writeFileAt(repo, '.planning/quick/README.md', NOTE);
    });
    try {
      assert.deepEqual(countsOf(ingest(s)), {
        f: '0', e: '0', s: '2', u: '1',
      });
      assert.deepEqual(stemRows(s), [{ name: 'notes.txt', n: 1 }]);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('strip: a project code is removed only when a plan or phase id follows (coded phase dir)', () => {
    const s = setup('strip', (repo) => {
      writePlanningDir(repo, {
        under: 'phases',
        name: 'RSX-02-alpha',
        files: {
          'RSX-02-01-PLAN.md': planText({ tier: 'B' }),
          'RSX-02-RESEARCH.md': NOTE,
          '02-01-PLAN.md': planText({ tier: 'B' }),
          '02-01-SUMMARY.md': planText({ tier: 'B' }),
        },
      });
    });
    try {
      // RSX-02-01-PLAN.md (a coded plan file: counted as not read, still recognized by name), RSX-02-RESEARCH.md, 02-01-PLAN.md = E 3.
      assert.deepEqual(countsOf(ingest(s)), {
        f: '1', e: '3', s: '0', u: '0',
      });
    } finally {
      s.ctx.cleanup();
    }
  });

  it('a leading word before an id is a project code only in a coded phase dir: old-03-REVIEW.md and draft-01-PLAN.md are unclassified in a standard dir (WR-04)', () => {
    const s = setup('wordid', (repo) => {
      writePlanningDir(repo, {
        under: 'phases',
        name: '02-alpha',
        files: {
          '02-01-PLAN.md': planText({ tier: 'B' }), 'old-03-REVIEW.md': NOTE, 'draft-01-PLAN.md': NOTE, 'SUMMARY-03-01-PLAN.md': NOTE,
        },
      });
    });
    try {
      assert.deepEqual(countsOf(ingest(s)), {
        f: '0', e: '1', s: '0', u: '3',
      });
      assert.deepEqual(stemRows(s), [
        { name: 'SUMMARY-N-N-PLAN.md', n: 1 }, { name: 'draft-N-PLAN.md', n: 1 }, { name: 'old-N-REVIEW.md', n: 1 },
      ]);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('the same leading words in a coded phase dir are taken as the project code (the recorded trade-off)', () => {
    const s = setup('wordcoded', (repo) => {
      writePlanningDir(repo, {
        under: 'phases', name: 'RSX-02-alpha', files: { 'old-03-REVIEW.md': NOTE, 'zzz.md': NOTE },
      });
    });
    try {
      assert.deepEqual(countsOf(ingest(s)), {
        f: '1', e: '0', s: '0', u: '1',
      });
      assert.deepEqual(stemRows(s), [{ name: 'zzz.md', n: 1 }]);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('loose files of the roots and ephemeral names: .gitkeep is S, a state backup name and a stray file are unclassified', () => {
    const s = setup('loose', (repo) => {
      writeFileAt(repo, '.planning/phases/.gitkeep', '');
      writeFileAt(repo, '.planning/phases/stray.txt', NOTE);
      writeFileAt(repo, '.planning/quick/.gitkeep', '');
      writePlanningDir(repo, {
        under: 'phases', name: '01-a', files: { '01-01-PLAN.md': planText({ tier: 'B' }), '.gitkeep': '', 'STATE.md.bak-1': NOTE },
      });
    });
    try {
      assert.deepEqual(countsOf(ingest(s)), {
        f: '0', e: '1', s: '3', u: '2',
      });
      assert.deepEqual(stemRows(s), [{ name: 'STATE.md.bak-N', n: 1 }, { name: 'stray.txt', n: 1 }]);
    } finally {
      s.ctx.cleanup();
    }
  });
});

describe('what is never classified: not-read dirs, second dirs, names failing the checks', () => {
  it('workstream, custom and bracket dirs hold files that are classified nowhere (counted as not read by locations)', () => {
    const s = setup('notread', (repo) => {
      writePlanningDir(repo, { under: 'workstreams/api/phases', name: '01-x', files: { '01-01-PLAN.md': planText({ tier: 'A' }), 'a.md': NOTE } });
      writePlanningDir(repo, { under: 'phases', name: 'auth-setup', files: { 'notes.md': NOTE } });
      writePlanningDir(repo, { under: 'phases', name: 'GSD.02-05-delta', files: { 'b.md': NOTE } });
    });
    try {
      assert.deepEqual(countsOf(ingest(s)), {
        f: '0', e: '0', s: '0', u: '0',
      });
      assert.deepEqual(rows(s, "SELECT n FROM ingest_count WHERE source = 'units' AND kind = 'unclassified'"), [{ n: 0 }]);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('a second dir of an id (repeat in another root, duplicate in the same root) is never opened or classified', () => {
    const s = setup('seconds', (repo) => {
      STOCK_LAYOUTS.reset.build(repo, {});
      writeFileAt(repo, '.planning/milestones/v1.0-phases/01-setup/kept-note.md', NOTE);
      writeFileAt(repo, '.planning/phases/01-new/never-seen.md', NOTE);
      writePlanningDir(repo, { under: 'phases', name: '02-a', files: { '02-01-PLAN.md': planText({ tier: 'A' }) } });
      writePlanningDir(repo, { under: 'phases', name: '02-b', files: { '02-01-PLAN.md': planText({ tier: 'A' }), 'dup-never-seen.md': NOTE } });
    });
    try {
      const lines = ingest(s);
      // 01-setup (read, archived): PLAN E, kept-note unclassified; 02-a (read): PLAN E; 01-new and 02-b are second dirs.
      assert.deepEqual(countsOf(lines), {
        f: '0', e: '2', s: '0', u: '1',
      });
      assert.deepEqual(stemRows(s), [{ name: 'kept-note.md', n: 1 }]);
      const loc = lines.find((l) => l.startsWith('locations: '));
      assert.match(loc, /repeat_id=1 /);
    } finally {
      s.ctx.cleanup();
    }
  });

  it('a symlink, a name with a space and a name with a double dot are skipped, not unclassified', () => {
    const s = setup('names', (repo) => {
      const dir = writePlanningDir(repo, { under: 'phases', name: '01-a', files: { '01-01-PLAN.md': planText({ tier: 'A' }), 'fine-note.md': NOTE } });
      writeFileSync(join(dir, 'has space.md'), NOTE);
      writeFileSync(join(dir, 'dots..x.md'), NOTE);
      symlinkSync(join(dir, 'fine-note.md'), join(dir, 'link-note.md'));
      // A phase dir that holds no plan is classified too; a symlink in it is skipped there as well (not a unit dir's own rule).
      const bare = writePlanningDir(repo, { under: 'phases', name: '02-noplan', files: { 'bare-note.md': NOTE } });
      symlinkSync(join(bare, 'bare-note.md'), join(bare, 'link-bare.md'));
    });
    try {
      const lines = ingest(s);
      assert.deepEqual(countsOf(lines), {
        f: '0', e: '1', s: '0', u: '2',
      });
      assert.equal(lines.find((l) => l.startsWith('units: ')).match(/ skipped=(\d+) /)[1], '4');
    } finally {
      s.ctx.cleanup();
    }
  });

  it('the same file in two linked worktrees is counted once per repo', () => {
    const s = setup('twotrees', (repo, home) => {
      writePlanningDir(repo, { under: 'phases', name: '01-a', files: { '01-01-PLAN.md': planText({ tier: 'A' }), 'shared-note.md': NOTE } });
      commitAll(repo, { home });
      addWorktree(repo, join(home, 'src', 'twotrees-wt'), 'wt-branch', { home });
    });
    try {
      assert.deepEqual(countsOf(ingest(s)), {
        f: '0', e: '1', s: '0', u: '1',
      });
    } finally {
      s.ctx.cleanup();
    }
  });
});

describe('a moved unit: the archived dir is classified when the move is read', () => {
  it('classes follow the unit into the archive and a third ingest counts the same', () => {
    const s = setup('moved', (repo) => {
      writePlanningDir(repo, { under: 'phases', name: '01-a', files: { '01-01-PLAN.md': planText({ tier: 'A' }), 'moved-note.md': NOTE } });
    });
    try {
      assert.deepEqual(countsOf(ingest(s)), {
        f: '0', e: '1', s: '0', u: '1',
      });
      archiveDir(s.repo, {
        home: s.ctx.home, name: '01-a', label: 'v1.0', kind: 'phases', track: false,
      });
      const second = ingest(s);
      assert.match(second.find((l) => l.startsWith('locations: ')), / moved=1 /);
      assert.deepEqual(countsOf(second), {
        f: '0', e: '1', s: '0', u: '1',
      });
      assert.deepEqual(countsOf(ingest(s)), {
        f: '0', e: '1', s: '0', u: '1',
      });
    } finally {
      s.ctx.cleanup();
    }
  });
});

describe('the stem list: 60 names, an owner word, an over-long name; ties bytewise; every run writes its own rows', () => {
  it('lists 50 stems, most frequent first, and everything else in the remainder row; listed plus other equals the total', () => {
    const ctx = makeHome();
    // A HOME whose own name is a plain word of at least four letters, so the adapter treats it as an owner name.
    const home = join(ctx.home, 'zqxowner');
    mkdirSync(home, { recursive: true });
    const repo = join(home, 'src', 'stems');
    makeRepo(repo, { home, files: { 'README.md': 'stems\n' } });
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const names = [];
    for (const a of 'abc') for (const b of letters) names.push(`memo-${a}${b}.md`);
    const plain = names.slice(0, 58);
    const files = { '01-01-PLAN.md': planText({ tier: 'A' }), 'log-1.txt': NOTE, 'log-2.txt': NOTE, 'log-33.txt': NOTE };
    for (const n of plain) files[n] = NOTE;
    files['notes-zqxowner.md'] = NOTE;
    files[`${'long'.repeat(20)}.md`] = NOTE;
    writePlanningDir(repo, { under: 'phases', name: '01-a', files });
    const env = cliEnv(home, { TZ: 'UTC', RIGORSCOPE_REPO_ROOTS: repo });
    const sx = { ctx: { home, cleanup: ctx.cleanup }, env };
    try {
      const first = linesOf(run(sx, ['ingest']));
      const total = 3 + 58 + 2;
      assert.equal(classesOf(first).unclassified, String(total));
      const stems = rows(sx, "SELECT name, n, run_id FROM ingest_count WHERE source = 'units' AND kind = 'unclassified_stem' ORDER BY n DESC, name");
      assert.equal(stems.length, 50);
      assert.deepEqual(stems[0], { name: 'log-N.txt', n: 3, run_id: stems[0].run_id });
      // ties are bytewise: memo-aa .. memo-aw are the first 49 of the 58 single names (a-z is 26, then b-w is 23 more).
      assert.deepEqual(stems.slice(1).map((r) => r.name), plain.slice(0, 49));
      const other = rows(sx, "SELECT n FROM ingest_count WHERE source = 'units' AND kind = 'unclassified_stem_other' AND name = '*'");
      // 9 single names past the cap, plus the owner-word name and the over-long name.
      assert.deepEqual(other, [{ n: 9 + 2 }]);
      assert.equal(stems.reduce((a, r) => a + r.n, 0) + other[0].n, total);
      const everything = JSON.stringify(rows(sx, 'SELECT name FROM ingest_count'));
      assert.ok(!everything.toLowerCase().includes('zqxowner'), 'the owner word is stored nowhere in the counters');
      assert.ok(!everything.includes('longlong'), 'the long name is stored nowhere');
      // A second ingest writes its own run's rows with equal counts.
      run(sx, ['ingest']);
      const runs = [...new Set(rows(sx, "SELECT run_id FROM ingest_count WHERE source = 'units' AND kind = 'unclassified_stem_other'").map((r) => r.run_id))];
      assert.equal(runs.length, 2);
      const per = runs.map((r) => rows(sx, "SELECT name, n FROM ingest_count WHERE source = 'units' AND kind = 'unclassified_stem' AND run_id = ? ORDER BY name", [r]));
      assert.deepEqual(per[0], per[1]);
    } finally {
      ctx.cleanup();
    }
  });
});
