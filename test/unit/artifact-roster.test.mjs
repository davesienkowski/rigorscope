// Contract of the gsd-core artifact roster and its classifier (plan 03.1-04, ADPT-04, D-08, D-21): the roster is one data
// file (src/adapters/gsd-core/roster.json) that the adapter and the drift check both read; a file name is classified by name
// only, once, and a name the roster does not know is counted unclassified. Expectations are written by hand from
// the upstream workflows and templates and the plan's tables, never from the output of the classifier.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { makeHome } from '../fixtures/build.mjs';
import { privateRef } from '../helpers/tree-kind.mjs';
import { commitAll, git, makeRepo, writeFileAt } from '../fixtures/git-repo.mjs';
import { defaultGitRun } from '../../src/adapters/gsd-core/signals.mjs';
import {
  CLASS_KINDS, CLASSES, ROSTER_ERROR, SCOPES, STEM_KIND, STEM_OTHER_KIND, classifyFile, loadRoster, notLookedFor, pickStems,
  rosterRef12, safeStem, stemOf, validateRoster,
} from '../../src/adapters/gsd-core/roster.mjs';

const FILE = new URL('../../src/adapters/gsd-core/roster.json', import.meta.url);
const shipped = () => JSON.parse(readFileSync(FILE, 'utf8'));
const copy = () => structuredClone(shipped());

describe('the shipped roster file', () => {
  it('records a full 40-hex gsd-core ref, a version, a date and the roster document', () => {
    const doc = shipped();
    assert.match(doc.ref, /^[0-9a-f]{40}$/);
    assert.match(doc.version, /^\d+\.\d+\.\d+$/);
    assert.match(doc.taken, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(doc.source, 'src/adapters/gsd-core/ROSTER-PROVENANCE.md');
    const prov = readFileSync(new URL('../../src/adapters/gsd-core/ROSTER-PROVENANCE.md', import.meta.url), 'utf8');
    assert.ok(prov.includes(doc.ref.slice(0, 12)), 'provenance states the ref prefix');
    assert.ok(prov.includes(doc.version), 'provenance states the version');
    assert.ok(prov.includes(doc.taken), 'provenance states the date');
    assert.ok(doc.entries.length >= 6);
  });

  it('no cite or provenance sentence calls a private survey upstream; cites without a file say what is true', () => {
    const OLD = 'upstream artifact survey';
    const prov = readFileSync(new URL('../../src/adapters/gsd-core/ROSTER-PROVENANCE.md', import.meta.url), 'utf8');
    assert.ok(!prov.replace(/\s+/g, ' ').includes(OLD), 'the provenance page does not name the survey');
    const raw = readFileSync(new URL('../../src/adapters/gsd-core/roster.json', import.meta.url), 'utf8');
    assert.ok(!raw.includes(OLD), 'roster.json does not name the survey');
    const PUBLIC = 'derived from gsd-core workflows and templates at the pinned ref; no upstream file cited';
    const derived = shipped().entries.filter((e) => e.cite.startsWith(PUBLIC));
    assert.equal(derived.length, 85, 'the 85 cites that had no upstream file say so');
    assert.ok(prov.replace(/\s+/g, ' ').includes(PUBLIC), 'the provenance page states the same wording');
  });

  it('loadRoster accepts it and rosterRef12 is the first 12 characters of the ref', () => {
    const r = loadRoster();
    assert.equal(r.ref, shipped().ref);
    assert.equal(rosterRef12(), shipped().ref.slice(0, 12));
    assert.equal(rosterRef12().length, 12);
  });
});

describe('validateRoster rejects a malformed roster with a fixed message', () => {
  const BAD = [
    ['a ref of 39 characters', (d) => { d.ref = d.ref.slice(0, 39); }, 'ref'],
    ['a ref with an upper-case letter', (d) => { d.ref = d.ref.toUpperCase(); }, 'ref'],
    ['an unknown class letter', (d) => { d.entries[0].class = 'X'; }, 'class'],
    ['an entry with neither stem nor re nor path_glob', (d) => { delete d.entries[0].stem; }, 'shape'],
    ['an entry with both stem and re', (d) => { d.entries[0].re = '^A$'; }, 'shape'],
    ['a regex that does not compile', (d) => { delete d.entries[0].stem; d.entries[0].re = '^(unclosed'; }, 'regex'],
    ['a scope outside the closed list', (d) => { d.entries[0].scopes = ['phase', 'attic']; }, 'scope'],
    ['an empty cite', (d) => { d.entries[0].cite = ''; }, 'shape'],
    ['no entries', (d) => { d.entries = []; }, 'shape'],
    ['a version that is not x.y.z', (d) => { d.version = 'latest'; }, 'shape'],
  ];
  for (const [title, mutate, reason] of BAD) {
    it(title, () => {
      const d = copy();
      mutate(d);
      assert.throws(() => validateRoster(d), (err) => err.message === ROSTER_ERROR && err.reason === reason, title);
    });
  }

  it('accepts the untouched copy', () => {
    assert.doesNotThrow(() => validateRoster(copy()));
  });

  it('the closed scope list and the class letters are the ones the plan names', () => {
    assert.deepEqual([...SCOPES], ['phase', 'quick', 'phases-root', 'quick-root', 'milestones', 'root']);
    assert.deepEqual([...CLASSES], ['F', 'E', 'S', 'O']);
  });
});

describe('classifyFile maps a name to its roster class', () => {
  it('PLAN and RESEARCH are step evidence (E), SUMMARY is finding-bearing (F), in a phase dir', () => {
    assert.equal(classifyFile('01-01-PLAN.md', { scope: 'phase' })?.class, 'E');
    assert.equal(classifyFile('01-01-SUMMARY.md', { scope: 'phase' })?.class, 'F');
    assert.equal(classifyFile('01-RESEARCH.md', { scope: 'phase' })?.class, 'E');
  });

  it('a name the roster does not hold is null', () => {
    assert.equal(classifyFile('weird-note.md', { scope: 'phase' }), null);
    assert.equal(classifyFile('weird-note.md', { scope: 'quick' }), null);
  });

  it('a quick id, a project code that a plan id follows, and a phase or plan id are stripped in that order', () => {
    assert.equal(classifyFile('260101-abc-PLAN.md', { scope: 'quick' })?.class, 'E');
    assert.equal(classifyFile('260101-abc-SUMMARY.md', { scope: 'quick' })?.class, 'F');
    assert.equal(classifyFile('RSX-02-01-PLAN.md', { scope: 'phase', coded: true })?.class, 'E');
    assert.equal(classifyFile('RSX-02-RESEARCH.md', { scope: 'phase', coded: true })?.class, 'E');
    assert.equal(classifyFile('02-01-SUMMARY.md', { scope: 'phase' })?.class, 'F');
  });

  it('a project code is stripped only inside a coded phase dir: a leading word before an id is not a code elsewhere (WR-04)', () => {
    for (const name of ['old-03-REVIEW.md', 'draft-01-PLAN.md', 'SUMMARY-03-01-PLAN.md', 'RSX-02-01-PLAN.md', 'RSX-02-RESEARCH.md']) {
      assert.equal(classifyFile(name, { scope: 'phase' }), null, `${name} in a standard dir`);
      assert.equal(classifyFile(name, { scope: 'phase', coded: false }), null, `${name} coded:false`);
      assert.equal(classifyFile(name, { scope: 'quick', coded: true }), null, `${name} quick scope never strips a code`);
    }
    // The documented trade-off: inside a coded dir the leading word is taken as the code, whatever it is.
    assert.equal(classifyFile('old-03-REVIEW.md', { scope: 'phase', coded: true })?.class, 'F');
    assert.equal(classifyFile('draft-01-PLAN.md', { scope: 'phase', coded: true })?.class, 'E');
    // A quick id and a phase or plan id still strip everywhere.
    assert.equal(classifyFile('260101-abc-PLAN.md', { scope: 'quick' })?.class, 'E');
    assert.equal(classifyFile('02-01-PLAN.md', { scope: 'phase' })?.class, 'E');
  });

  it('a project code is stripped only when a phase or plan id follows it', () => {
    // REVIEW-FIX has no id after REVIEW-: not stripped (and is not in this tracer roster, so it must not match PLAN-like names).
    assert.equal(classifyFile('x-123.log', { scope: 'phase' }), null);
    assert.equal(classifyFile('REVIEW.md', { scope: 'phase' })?.class, 'F');
  });

  it('an unknown scope is null and a scope outside the entry is null', () => {
    assert.equal(classifyFile('01-01-PLAN.md', { scope: 'attic' }), null);
    assert.equal(classifyFile('01-01-PLAN.md', { scope: 'milestones' }), null);
  });
});

describe('stemOf', () => {
  const CASES = [
    ['weird-note.md', 'weird-note.md'],
    ['x-123.log', 'x-N.log'],
    ['260101-abc-PROBES-SKIPPED.md', 'PROBES-SKIPPED.md'],
    ['RIGOR-TIER.md', 'RIGOR-TIER.md'],
    ['01-01-PLAN.md', 'PLAN.md'],
    ['RSX-02-01-PLAN.md', 'RSX-N-N-PLAN.md'],
    ['REVIEW-FIX.md', 'REVIEW-FIX.md'],
    ['gate-2026-10-30.json', 'gate-N-N-N.json'],
    ['12345.txt', 'N.txt'],
  ];
  for (const [name, want] of CASES) {
    it(`${name} -> ${want}`, () => assert.equal(stemOf(name), want));
  }
  it('inside a coded phase dir the project code is stripped; elsewhere the leading word stays in the stem (WR-04)', () => {
    assert.equal(stemOf('RSX-02-01-PLAN.md', { coded: true }), 'PLAN.md');
    assert.equal(stemOf('RSX-02-RESEARCH.md', { coded: true }), 'RESEARCH.md');
    assert.equal(stemOf('old-03-REVIEW.md'), 'old-N-REVIEW.md');
    assert.equal(stemOf('draft-01-PLAN.md', { coded: false }), 'draft-N-PLAN.md');
    assert.equal(safeStem('old-03-REVIEW.md', []), 'old-N-REVIEW.md');
    assert.equal(safeStem('old-03-REVIEW.md', [], { coded: true }), 'REVIEW.md');
  });
});

describe('the stem filter (T-03.1-11): shape, owner word, top 50 with a remainder row', () => {
  it('safeStem keeps a plain stem and returns null for an owner word, a long stem and a double dot', () => {
    assert.equal(safeStem('weird-note.md', ['ownername']), 'weird-note.md');
    assert.equal(safeStem('notes-for-OwnerName.md', ['ownername']), null, 'an owner word, any case, as a word');
    assert.equal(safeStem('ownername.md', ['ownername']), null);
    assert.equal(safeStem(`${'a'.repeat(70)}.md`, []), null, 'over 64 characters');
    assert.equal(safeStem('a..b.md', []), null);
    assert.equal(safeStem('has space.md', []), null);
    // an owner name that is only a part of a longer word is not a word
    assert.equal(safeStem('ownernames-list.md', ['ownername']), 'ownernames-list.md');
  });

  it('safeStem checks the owner word on the raw name too (a digit fold could hide it)', () => {
    assert.equal(safeStem('team7.md', ['team7']), null);
  });

  it('pickStems lists at most 50, most frequent first, ties bytewise, and the rest is the other count', () => {
    const tally = new Map();
    for (let i = 0; i < 60; i += 1) tally.set(`s${String(i).padStart(2, '0')}.md`, i < 10 ? 2 : 1);
    const got = pickStems(tally, 3);
    assert.equal(got.listed.length, 50);
    assert.deepEqual(got.listed.slice(0, 3), [{ stem: 's00.md', n: 2 }, { stem: 's01.md', n: 2 }, { stem: 's02.md', n: 2 }]);
    assert.deepEqual(got.listed[10], { stem: 's10.md', n: 1 });
    assert.equal(got.listed[49].stem, 's49.md');
    // 10 stems of 1 file are past the cap (s50..s59) plus 3 files whose stem failed the filter
    assert.equal(got.other, 10 + 3);
    const total = [...tally.values()].reduce((a, b) => a + b, 0) + 3;
    assert.equal(got.listed.reduce((a, s) => a + s.n, 0) + got.other, total);
  });

  it('pickStems with fewer than 50 stems lists them all', () => {
    const got = pickStems(new Map([['a.md', 1], ['b.md', 4]]), 0);
    assert.deepEqual(got.listed, [{ stem: 'b.md', n: 4 }, { stem: 'a.md', n: 1 }]);
    assert.equal(got.other, 0);
  });
});

describe('CLASS_KINDS', () => {
  it('is the frozen, ordered list of the plan', () => {
    assert.deepEqual([...CLASS_KINDS], [
      'recognized_f', 'recognized_e', 'recognized_s', 'unclassified', STEM_KIND, STEM_OTHER_KIND,
    ]);
    assert.equal(STEM_KIND, 'unclassified_stem');
    assert.equal(STEM_OTHER_KIND, 'unclassified_stem_other');
    assert.ok(Object.isFrozen(CLASS_KINDS));
  });
});

// ---- Task 2: the full roster, checked against the roster document and the plan's hand-computed table ----------------------

// The roster document is private: null in a public tree, where the two tests that read it skip (test/helpers/tree-kind.mjs).
const DOC = privateRef('roster-doc');
const HAVE_DOC = DOC !== null && existsSync(DOC);
const entriesOf = () => shipped().entries;
const nameOf = (e) => e.stem ?? e.re ?? e.path_glob;
const scanned = SCOPES.filter((x) => x !== 'root');

// The F table of the roster document: one array of artifact names per row, read by this test, never by the classifier.
function fTableNames() {
  const text = readFileSync(DOC, 'utf8');
  const start = text.indexOf('## F: finding-bearing');
  const end = text.indexOf('\n## ', start + 5);
  const rows = text.slice(start, end).split('\n').filter((l) => l.startsWith('| ')).slice(2);
  return rows.map((l) => l.split('|')[1].trim()).flatMap((cell) => cell.split(',').map((x) => x.trim()));
}

describe('roster completeness against the roster document', () => {
  it('the F table names rows (guards the parser itself)', { skip: !HAVE_DOC && 'private tree only: roster-doc' }, () => {
    const names = fTableNames();
    assert.ok(names.length >= 24, `parsed ${names.length} names`);
    assert.ok(names.includes('REVIEW-FIX') && names.includes('vX.Y-MILESTONE-AUDIT') && names.includes('debug/knowledge-base.md'));
  });

  it('every artifact of the F table has a class F entry', { skip: !HAVE_DOC && 'private tree only: roster-doc' }, () => {
    const missing = [];
    for (const name of fTableNames()) {
      let ok;
      if (name.includes('/') || name.includes('*')) {
        ok = entriesOf().some((e) => e.class === 'F' && e.path_glob === name);
      } else if (name.includes('X.Y')) {
        const sample = name.replace('X.Y', '1.0');
        ok = entriesOf().some((e) => e.class === 'F' && e.re && new RegExp(e.re).test(sample));
      } else {
        const m = /^(.*?)(\.json|\.md|\.html)?$/.exec(name);
        const ext = m[2] ?? '.md';
        ok = entriesOf().some((e) => e.class === 'F' && e.stem === m[1] && e.ext === ext);
      }
      if (!ok) missing.push(name);
    }
    assert.deepEqual(missing, []);
  });

  it('every step evidence name of the phase or quick list has a class E entry in both scopes', () => {
    const E = ['CONTEXT', 'DISCUSSION-LOG', 'RESEARCH', 'PATTERNS', 'PLAN-OUTLINE', 'PLAN', 'UI-SPEC', 'AI-SPEC', 'SPEC', 'SKELETON',
      'LEARNINGS', 'MEMORY-RECALL', 'DISCOVERY'];
    for (const stem of E) {
      assert.equal(classifyFile(`01-${stem}.md`, { scope: 'phase' })?.class, 'E', stem);
      assert.equal(classifyFile(`260101-abc-${stem}.md`, { scope: 'quick' })?.class, 'E', stem);
    }
    for (const name of ['QUESTIONS.json', 'QUESTIONS.html', 'DISCUSS-CHECKPOINT.json']) {
      assert.equal(classifyFile(`01-${name}`, { scope: 'phase' })?.class, 'E', name);
    }
  });

  it('every state name of the root list is an entry with scope root (never listed)', () => {
    const S = ['PROJECT', 'ROADMAP', 'REQUIREMENTS', 'STATE', 'STATE.md.bak-1', 'state.json', 'config.json', 'HANDOFF.json', '.continue-here.md',
      'milestone.lock', '.lock', 'WAITING.json', 'skill-manifest.json', 'estimation-calibration.json', 'complexity-baseline.json',
      'active-workstream', '.gsd-trace.jsonl', '.mempalace-stage', '.WINDOWS.lock', 'STATE.md.lock', '.consent.lock', 'current-agent-id.txt',
      'agent-history.json', '.review-fix-recovery-pending.json'];
    const roots = entriesOf().filter((e) => e.scopes.length === 1 && e.scopes[0] === 'root');
    for (const raw of S) {
      const name = raw.includes('.') || raw.includes('-') || raw === 'active-workstream' ? raw : `${raw}.md`;
      const hit = roots.some((e) => {
        const ext = e.ext ?? '';
        if (!name.endsWith(ext)) return false;
        const base = ext === '' ? name : name.slice(0, -ext.length);
        return e.stem !== undefined ? e.stem === base : new RegExp(e.re).test(base);
      });
      assert.ok(hit, `a root entry for ${name}`);
    }
  });

  it('every entry has a cite, a valid class and closed-list scopes; class O and path globs have no scope and no example', () => {
    for (const e of entriesOf()) {
      assert.ok(typeof e.cite === 'string' && e.cite.trim() !== '', nameOf(e));
      assert.ok(CLASSES.includes(e.class), nameOf(e));
      assert.ok(e.scopes.every((x) => SCOPES.includes(x)), nameOf(e));
      if (e.class === 'O' || e.path_glob !== undefined) {
        assert.deepEqual(e.scopes, [], `${nameOf(e)} classifies no name`);
        assert.ok(!e.example || e.example.length === 0, `${nameOf(e)} has no example`);
      }
      if (e.cite_path === null) assert.ok(typeof e.cite_note === 'string' && e.cite_note !== '', `${nameOf(e)} explains its null cite_path`);
    }
  });

  it('every example is classified into the class of its entry, by that entry, in each of its scopes', () => {
    let checked = 0;
    for (const e of entriesOf()) {
      for (const scope of e.scopes.filter((x) => x !== 'root')) {
        for (const ex of e.example ?? []) {
          const hit = classifyFile(ex, { scope });
          assert.ok(hit, `${ex} in ${scope}`);
          assert.equal(hit.class, e.class, `${ex} in ${scope}`);
          assert.equal(nameOf(hit.entry), nameOf(e), `${ex} in ${scope} is matched by its own entry`);
          checked += 1;
        }
      }
    }
    assert.ok(checked >= 60, `${checked} example checks`);
  });

  it('a root entry never classifies a listed name, a path glob and a class O entry match nothing', () => {
    for (const e of entriesOf()) {
      if (e.scopes.length === 1 && e.scopes[0] === 'root') {
        for (const ex of e.example ?? []) {
          for (const scope of scanned) {
            const hit = classifyFile(ex, { scope });
            assert.ok(hit === null || hit.entry.scopes.includes(scope), `${ex} in ${scope}`);
            if (hit) assert.notEqual(hit.entry.scopes[0], 'root');
          }
        }
      }
      if (e.scopes.length === 0) {
        const last = nameOf(e).split('/').pop();
        for (const scope of scanned) {
          const hit = classifyFile(last, { scope });
          assert.ok(hit === null || hit.entry.scopes.length > 0, `${last} in ${scope}`);
          if (hit) assert.notEqual(nameOf(hit.entry), nameOf(e));
        }
      }
    }
  });

  it('names that exist only in a local layout are not in the roster: they classify as unclassified (R1 B1)', () => {
    for (const bad of ['RIGOR-TIER', 'PROBES-SKIPPED']) {
      assert.ok(!entriesOf().some((e) => nameOf(e).includes(bad)), `${bad} is not an entry`);
    }
    assert.equal(classifyFile('RIGOR-TIER.md', { scope: 'quick' }), null);
    assert.equal(classifyFile('260101-abc-PROBES-SKIPPED.md', { scope: 'quick' }), null);
  });
});

describe('the hand-computed table of the plan, at classifyFile', () => {
  it('quick: PLAN E, SUMMARY F, REVIEW F, and three names in no entry (REVIEW-FIX is a phase artifact)', () => {
    const q = (n) => classifyFile(n, { scope: 'quick' })?.class ?? null;
    assert.deepEqual(
      ['260101-abc-PLAN.md', '260101-abc-SUMMARY.md', 'REVIEW.md', 'RIGOR-TIER.md', '260101-abc-PROBES-SKIPPED.md', 'x-123.log'].map(q),
      ['E', 'F', 'F', null, null, null],
    );
    // The document lists REVIEW-FIX under phase only; the same unstripped name is F in a phase dir (no id follows REVIEW-).
    assert.equal(q('REVIEW-FIX.md'), null);
    assert.equal(classifyFile('REVIEW-FIX.md', { scope: 'phase' })?.class, 'F');
  });

  it('milestones: the roadmap archive S, the audit F, a note unclassified (the milestones glob classifies nothing)', () => {
    const m = (n) => classifyFile(n, { scope: 'milestones' })?.class ?? null;
    assert.deepEqual(['v1.0-ROADMAP.md', 'v1.0-MILESTONE-AUDIT.md', 'notes.txt', 'v1.0-RELEASE-MAP.json'].map(m), ['S', 'F', null, 'E']);
  });

  it('milestones: the requirements archive S and every archive name takes any label of the writer grammar, not only a leading v (WR-01)', () => {
    const m = (n) => classifyFile(n, { scope: 'milestones' })?.class ?? null;
    assert.equal(m('v1.0-REQUIREMENTS.md'), 'S');
    for (const label of ['v1.0', 'v2', '1.0', 'beta', 'release_2026.1-rc1']) {
      assert.deepEqual(
        [`${label}-ROADMAP.md`, `${label}-REQUIREMENTS.md`, `${label}-MILESTONE-AUDIT.md`, `${label}-RELEASE-MAP.json`].map(m),
        ['S', 'S', 'F', 'E'],
        label,
      );
    }
    // A label of the grammar: a letter or digit first, at most 64 characters, no path separator.
    assert.equal(m('-ROADMAP.md'), null);
    assert.equal(m('.x-ROADMAP.md'), null);
    assert.equal(m(`${'a'.repeat(65)}-ROADMAP.md`), null);
    assert.equal(m('v1.0-REQUIREMENTS.json'), null, 'the extension is part of the entry');
    assert.equal(m('REQUIREMENTS.md'), null, 'no label, not an archive name');
    // Only the milestones listing knows these names.
    assert.equal(classifyFile('v1.0-REQUIREMENTS.md', { scope: 'phase' }), null);
  });

  it('the quick archive index README.md is S in a quick root, written only with --archive-quick; the roster notes it also covers the live quick root (WR-01)', () => {
    assert.equal(classifyFile('README.md', { scope: 'quick-root' })?.class, 'S');
    for (const scope of ['phase', 'quick', 'phases-root', 'milestones']) assert.equal(classifyFile('README.md', { scope }), null, scope);
    const e = classifyFile('README.md', { scope: 'quick-root' }).entry;
    assert.equal(e.cite_path, 'gsd-core/workflows/complete-milestone.md');
    assert.match(e.cite, /complete-milestone\.md:296/);
    assert.match(e.cite_note, /--archive-quick/);
    assert.match(e.cite_note, /\.planning\/quick/, 'the acceptance that the live quick root is covered too');
  });

  it('the archive ROADMAP and REQUIREMENTS state their class and why it differs from the document glob milestones/** (WR-01)', () => {
    const roadmap = classifyFile('v1.0-ROADMAP.md', { scope: 'milestones' }).entry;
    const reqs = classifyFile('v1.0-REQUIREMENTS.md', { scope: 'milestones' }).entry;
    for (const e of [roadmap, reqs]) {
      assert.equal(e.class, 'S');
      assert.match(e.cite_note, /class S/);
      assert.match(e.cite_note, /milestones\/\*\*/);
      assert.equal(e.cite_path, 'gsd-core/workflows/complete-milestone.md');
    }
    assert.match(reqs.cite, /complete-milestone\.md:22/);
    assert.match(reqs.cite, /:292/);
  });

  it('strip: a project code is removed only when a plan or phase id follows', () => {
    const p = (n) => classifyFile(n, { scope: 'phase', coded: true })?.class ?? null;
    assert.deepEqual(['RSX-02-01-PLAN.md', 'RSX-02-RESEARCH.md', '02-01-SUMMARY.md', 'REVIEW-FIX.md'].map(p), ['E', 'E', 'F', 'F']);
  });

  it('ephemeral: .gitkeep is S in every listed dir, the state backup is a root name', () => {
    for (const scope of ['phase', 'quick', 'phases-root', 'quick-root']) assert.equal(classifyFile('.gitkeep', { scope })?.class, 'S', scope);
    assert.equal(classifyFile('STATE.md.bak-1', { scope: 'phase' }), null);
  });

  it('root: notLookedFor lists the root entries, the path globs and the entries with no scanned scope, from the shipped roster', () => {
    const nl = notLookedFor();
    const rootNames = entriesOf().filter((e) => e.scopes.length === 1 && e.scopes[0] === 'root').map(nameOf);
    const globNames = entriesOf().filter((e) => e.path_glob !== undefined).map(nameOf);
    assert.deepEqual(nl.root.map((i) => i.name), rootNames);
    assert.deepEqual(nl.path_glob.map((i) => i.name), globNames);
    assert.ok(nl.root.some((i) => i.name === 'STATE') && nl.root.some((i) => i.name === 'ROADMAP'));
    assert.ok(nl.path_glob.some((i) => i.name === 'debug/*.md') && nl.path_glob.some((i) => i.name === 'milestones/**'));
    assert.ok(nl.path_glob.some((i) => i.class === 'O'));
    assert.deepEqual(nl.no_scanned_scope, [], 'every scope-less entry is a path glob in this roster');
    for (const i of [...nl.root, ...nl.path_glob]) assert.ok(i.cite && i.class);
  });
});

describe('drift reads git only: the cited paths exist at the roster ref', () => {
  const checkout = process.env.RIGORSCOPE_GSD_CORE_CHECKOUT;
  it('every non-null cite_path exists at the roster ref (git cat-file -e, args array)', { skip: !checkout && 'RIGORSCOPE_GSD_CORE_CHECKOUT is not set' }, () => {
    const ref = shipped().ref;
    const paths = [...new Set(entriesOf().map((e) => e.cite_path).filter((x) => x !== null))].sort();
    assert.ok(paths.length >= 40, `${paths.length} distinct cited paths`);
    const missing = [];
    for (const p of paths) {
      try {
        execFileSync('git', ['-C', checkout, 'cat-file', '-e', `${ref}:${p}`], { stdio: 'ignore', timeout: 20_000 });
      } catch {
        missing.push(p);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('the roster never carries a content hash or a local path', () => {
    const text = readFileSync(new URL('../../src/adapters/gsd-core/roster.json', import.meta.url), 'utf8');
    assert.ok(!/\b[0-9a-f]{40}\b/.test(text.replace(shipped().ref, '')), 'no hash other than the ref');
    assert.ok(!/(?:^|[\s"'(=:])(?:\/home\/|\/Users\/|[A-Za-z]:[\\/])/.test(text), 'no absolute path');
  });
});

// ---- Task 3: the drift check (src/report/roster.mjs), checked with a fake git runner ------------------------------------------

const driftMod = () => import('../../src/report/roster.mjs');
const REF = shipped().ref;
const CITED = [...new Set(shipped().entries.map((e) => e.cite_path).filter((x) => x !== null))].sort();
const FAKE_DIR = '/opt/gsd-core-fixture';
const fakeDb = (version) => ({ prepare: () => ({ get: () => (version === undefined ? undefined : { v: version }) }) });
// A fake runner: answers by git subcommand; records every args array.
function runner(answers) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    const rest = [...args];
    while (rest[0] === '-C' || rest[0] === '-c') rest.splice(0, 2);
    const answer = answers[rest[0]];
    return typeof answer === 'function' ? answer(rest) : (answer ?? { status: 0, stdout: '', errorCode: null });
  };
  fn.calls = calls;
  return fn;
}
const OK = (stdout = '') => ({ status: 0, stdout, errorCode: null });
const FAIL = { status: 128, stdout: '', errorCode: null };

describe('checkRoster: a checkout named by the environment variable (drift reads git only)', () => {
  it('a checkout answer with two cited paths is drift=changed with the sorted paths; only a read-only diff with cited paths is asked', async () => {
    const { checkRoster } = await driftMod();
    const run = runner({ diff: OK('gsd-core/workflows/review.md\nagents/gsd-executor.md\nnot/cited/path.md\n') });
    const r = checkRoster({ env: { RIGORSCOPE_GSD_CORE_CHECKOUT: FAKE_DIR }, db: null, run });
    assert.equal(r.ref, REF.slice(0, 12));
    assert.equal(r.version, shipped().version);
    assert.equal(r.entries, shipped().entries.length);
    assert.equal(r.drift.state, 'changed');
    assert.deepEqual(r.drift.changed, ['agents/gsd-executor.md', 'gsd-core/workflows/review.md'], 'sorted, and only paths the roster cites');
    assert.equal(r.drift.reason, null);
    assert.equal(run.calls.length, 1, 'one call when git answers');
    const args = run.calls[0];
    assert.deepEqual(args.slice(0, 2), ['-C', FAKE_DIR]);
    const rest = [...args];
    while (rest[0] === '-C' || rest[0] === '-c') rest.splice(0, 2);
    assert.deepEqual(rest.slice(0, 6), ['diff', '--no-renames', '--name-only', REF, 'HEAD', '--'], 'no rename detection (WR-02): the user diff.renames setting never applies');
    assert.deepEqual(rest.slice(6), CITED.map((p) => `:(top,literal)${p}`), 'the pathspecs are the roster cite paths, sorted and unique, each anchored at the work-tree top (CR-01)');
    assert.ok(Array.isArray(args), 'an args array, never a shell string');
  });

  it('a checkout directory that is a subdirectory of a work tree answers like the top, never a silent changed:0 (CR-01)', async () => {
    const { checkRoster } = await driftMod();
    const ctx = makeHome();
    try {
      const repo = `${ctx.home}/clone`;
      makeRepo(repo, { home: ctx.home, files: { 'a.txt': 'a\n', 'agents/gsd-executor.md': 'one\n' } });
      const first = git(repo, ['rev-parse', 'HEAD'], { home: ctx.home }).trim();
      writeFileAt(repo, 'agents/gsd-executor.md', 'two\n');
      commitAll(repo, { home: ctx.home });
      // The temp repo cannot hold the roster ref: the runner asks about its first commit instead, through the real git.
      const swap = (args) => defaultGitRun(args.map((a) => (a === REF ? first : a)));
      const at = (dir) => checkRoster({ env: { RIGORSCOPE_GSD_CORE_CHECKOUT: dir }, db: null, run: swap }).drift;
      const top = at(repo);
      assert.equal(top.state, 'changed');
      assert.deepEqual(top.changed, ['agents/gsd-executor.md']);
      for (const sub of [`${repo}/agents`, `${repo}/agents/`]) {
        const d = at(sub);
        assert.ok(d.state === 'unknown' || (d.state === 'changed' && d.changed.length === 1), `${sub}: ${JSON.stringify(d)}`);
        assert.notDeepEqual({ state: d.state, changed: d.changed }, { state: 'changed', changed: [] }, 'a path set that was not evaluated is never changed:0');
      }
      assert.deepEqual(at(`${repo}/agents`).changed, ['agents/gsd-executor.md']);
    } finally {
      ctx.cleanup();
    }
  });

  it('a checkout with no changed cited path is changed:0 (a count, not a finding input)', async () => {
    const { checkRoster } = await driftMod();
    const r = checkRoster({ env: { RIGORSCOPE_GSD_CORE_CHECKOUT: FAKE_DIR }, db: null, run: runner({ diff: OK('') }) });
    assert.equal(r.drift.state, 'changed');
    assert.deepEqual(r.drift.changed, []);
  });

  const UNUSABLE = [
    ['git fails and the directory is no repository', { diff: FAIL, 'rev-parse': FAIL }, 'checkout_unusable'],
    ['git fails, the repository answers, the ref is missing', { diff: FAIL, 'rev-parse': OK('.git\n'), 'cat-file': FAIL }, 'ref_not_in_checkout'],
    ['git fails, the repository answers, the ref is there', { diff: FAIL, 'rev-parse': OK('.git\n'), 'cat-file': OK() }, 'checkout_unusable'],
    ['git times out', { diff: { status: null, stdout: '', errorCode: 'ETIMEDOUT' }, 'rev-parse': { status: null, stdout: '', errorCode: 'ETIMEDOUT' } }, 'checkout_unusable'],
    ['git cannot start', { diff: { status: null, stdout: '', errorCode: 'ENOENT' }, 'rev-parse': { status: null, stdout: '', errorCode: 'ENOENT' } }, 'checkout_unusable'],
  ];
  for (const [title, answers, reason] of UNUSABLE) {
    it(`${title}: drift=unknown reason=${reason}`, async () => {
      const { checkRoster } = await driftMod();
      const r = checkRoster({ env: { RIGORSCOPE_GSD_CORE_CHECKOUT: FAKE_DIR }, db: fakeDb('1.20.1'), run: runner(answers) });
      assert.equal(r.drift.state, 'unknown');
      assert.equal(r.drift.reason, reason);
      assert.equal(r.drift.changed, null);
    });
  }

  it('the installed version is not consulted when a checkout is named and fails (an explicit request is never answered by a fallback)', async () => {
    const { checkRoster } = await driftMod();
    const r = checkRoster({ env: { RIGORSCOPE_GSD_CORE_CHECKOUT: FAKE_DIR }, db: fakeDb('1.19.0'), run: runner({ diff: FAIL, 'rev-parse': FAIL }) });
    assert.equal(r.drift.state, 'unknown');
  });

  for (const [title, value] of [['a relative path', 'rel/dir'], ['a path with a control character', '/opt/x\ny'], ['a path with a NUL', '/opt/x\u0000y'], ['a path of 2000 characters', `/${'a'.repeat(2000)}`]]) {
    it(`${title}: drift=unknown reason=env_invalid and git is never asked`, async () => {
      const { checkRoster } = await driftMod();
      const run = runner({});
      const r = checkRoster({ env: { RIGORSCOPE_GSD_CORE_CHECKOUT: value }, db: null, run });
      assert.equal(r.drift.state, 'unknown');
      assert.equal(r.drift.reason, 'env_invalid');
      assert.equal(run.calls.length, 0);
    });
  }

  it('the checkout value check follows the host path rules; a native Windows absolute path is valid where the host is Windows (WR-05)', async () => {
    const { isCheckoutValue } = await driftMod();
    const win = path.win32.isAbsolute;
    for (const v of [['C:', 'src', 'gsd-core'].join('\\'), ['C:', 'src', 'gsd-core'].join('/'), '\\\\host\\share\\gsd-core']) assert.equal(isCheckoutValue(v, win), true, v);
    for (const v of ['rel\\dir', 'src/gsd-core', '..\\x']) assert.equal(isCheckoutValue(v, win), false, v);
    assert.equal(isCheckoutValue(['C:', 'src', 'x\ny'].join('/'), win), false, 'a control character');
    assert.equal(isCheckoutValue(['C:', 'a'.repeat(2000)].join('/'), win), false, 'over the length cap');
    assert.equal(isCheckoutValue('/opt/gsd-core'), true, 'the host default accepts a posix absolute path on posix');
    assert.equal(isCheckoutValue('rel/dir'), false);
    assert.equal(isCheckoutValue(42), false);
  });

  it('an empty value is the same as unset', async () => {
    const { checkRoster } = await driftMod();
    const run = runner({});
    const r = checkRoster({ env: { RIGORSCOPE_GSD_CORE_CHECKOUT: '' }, db: null, run });
    assert.equal(r.drift.reason, 'no_store');
    assert.equal(run.calls.length, 0);
  });
});

describe('checkRoster: the installed version of the latest environment snapshot', () => {
  const RV = shipped().version;
  it('a different version is version_differs with both versions', async () => {
    const { checkRoster } = await driftMod();
    const r = checkRoster({ env: {}, db: fakeDb('1.20.1'), run: runner({}) });
    assert.equal(r.drift.state, 'version_differs');
    assert.equal(r.drift.installed_version, '1.20.1');
    assert.equal(r.version, RV);
    assert.equal(r.drift.changed, null);
  });

  it('an equal version (with or without a leading v) is same_version', async () => {
    const { checkRoster } = await driftMod();
    for (const v of [RV, `v${RV}`]) {
      const r = checkRoster({ env: {}, db: fakeDb(v), run: runner({}) });
      assert.equal(r.drift.state, 'same_version', v);
      assert.equal(r.drift.installed_version, RV);
    }
  });

  it('no version recorded is unknown with the reason, never same', async () => {
    const { checkRoster } = await driftMod();
    for (const db of [fakeDb(null), fakeDb(undefined), { prepare: () => { throw new Error('no such table'); } }]) {
      const r = checkRoster({ env: {}, db, run: runner({}) });
      assert.equal(r.drift.state, 'unknown');
      assert.equal(r.drift.reason, 'no_installed_version');
    }
  });

  it('a version that is not x.y.z is unknown with its own reason', async () => {
    const { checkRoster } = await driftMod();
    const r = checkRoster({ env: {}, db: fakeDb('weird build!'), run: runner({}) });
    assert.equal(r.drift.state, 'unknown');
    assert.equal(r.drift.reason, 'installed_version_unreadable');
  });

  it('no store is unknown with the reason no_store', async () => {
    const { checkRoster } = await driftMod();
    const r = checkRoster({ env: {}, db: null, run: runner({}) });
    assert.equal(r.drift.state, 'unknown');
    assert.equal(r.drift.reason, 'no_store');
  });

  it('the not-looked-for counts come from the shipped roster', async () => {
    const { checkRoster } = await driftMod();
    const nl = notLookedFor();
    const r = checkRoster({ env: {}, db: null, run: runner({}) });
    assert.deepEqual(r.not_looked_for, { root: nl.root.length, path_glob: nl.path_glob.length, no_scanned_scope: nl.no_scanned_scope.length });
  });
});

describe('drift reads git only: no hash compare, no hardcoded path, nothing executed from the checkout', () => {
  it('the drift module has no hashing, no file read and no process start of its own', () => {
    const src = readFileSync(new URL('../../src/report/roster.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/createHash|sha256|readFileSync|readdirSync|statSync|execFileSync|spawn|(?<![.\w])exec\(/.test(src), 'only the injected runner touches the checkout');
    assert.ok(!/(?:\/home\/|\/Users\/|\/mnt\/)/.test(src), 'no path');
  });

  it('the default runner strips the repository-location variables: a bogus GIT_DIR in the environment does not break a real checkout read', async () => {
    const { checkRoster } = await driftMod();
    const ctx = makeHome();
    const saved = process.env.GIT_DIR;
    try {
      const repo = `${ctx.home}/clone`;
      makeRepo(repo, { home: ctx.home, files: { 'a.txt': 'a\n' } });
      process.env.GIT_DIR = '/nonexistent-git-dir';
      const r = checkRoster({ env: { RIGORSCOPE_GSD_CORE_CHECKOUT: repo }, db: null });
      // The repository answers (rev-parse works), the roster ref is not in it: a leaked GIT_DIR would give checkout_unusable.
      assert.equal(r.drift.reason, 'ref_not_in_checkout');
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
      ctx.cleanup();
    }
  });

  it('a real gsd-core checkout (environment variable set) answers with changed paths that the roster cites', { skip: !process.env.RIGORSCOPE_GSD_CORE_CHECKOUT && 'RIGORSCOPE_GSD_CORE_CHECKOUT is not set' }, async (t) => {
    const { checkRoster } = await driftMod();
    const r = checkRoster({ env: { RIGORSCOPE_GSD_CORE_CHECKOUT: process.env.RIGORSCOPE_GSD_CORE_CHECKOUT }, db: null });
    t.diagnostic(`changed cited paths against HEAD of the checkout: ${r.drift.changed === null ? r.drift.reason : r.drift.changed.length}`);
    assert.equal(r.drift.state, 'changed');
    assert.ok(r.drift.changed.every((p) => CITED.includes(p)));
  });
});

describe('the docs name every persisted class kind', () => {
  it('docs/sources.md and docs/cli.md name each kind of CLASS_KINDS and the environment variable', () => {
    const sources = readFileSync(new URL('../../docs/sources.md', import.meta.url), 'utf8');
    const cli = readFileSync(new URL('../../docs/cli.md', import.meta.url), 'utf8');
    for (const kind of CLASS_KINDS) assert.ok(sources.includes(`\`${kind}\``), `sources.md names ${kind}`);
    for (const kind of CLASS_KINDS.slice(0, 4)) assert.ok(cli.includes(`\`${kind}\``), `cli.md names ${kind}`);
    assert.ok(cli.includes('`RIGORSCOPE_GSD_CORE_CHECKOUT`') && sources.includes('`RIGORSCOPE_GSD_CORE_CHECKOUT`'));
    for (const word of ['roster_drift', 'unit-locations', 'unclassified', 'roster:']) assert.ok(cli.includes(word), `cli.md names ${word}`);
  });
});
