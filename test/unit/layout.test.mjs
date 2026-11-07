// Unit tests of the pure stock-layout rules (plan 03.1-01, ADPT-05, D-04, D-05): the archive root grammar, the natural
// label order, the location of a unit dir path, the frozen counter list and the `locations:` line. No I/O.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCATION_KINDS, archiveRootKind, canonicalDir, compareLabels, dirAcceptsPlan, formerLivePath, linkDirOf, locationOf,
  locationsLine, phaseDirForm, planFileForm,
} from '../../src/adapters/gsd-core/layout.mjs';

describe('archiveRootKind: the writer label grammar plus -phases or -quick', () => {
  it('accepts stock and legal labels', () => {
    assert.equal(archiveRootKind('v1.0-phases'), 'phases');
    assert.equal(archiveRootKind('v1.0-quick'), 'quick');
    assert.equal(archiveRootKind('3.1-phases'), 'phases');
    assert.equal(archiveRootKind('archived-20261106-phases'), 'phases');
  });

  it('rejects siblings, files, an empty or over-long label and a near miss', () => {
    assert.equal(archiveRootKind('milestones-v1-03-alpha'), null);
    assert.equal(archiveRootKind('v1.0-ROADMAP.md'), null);
    assert.equal(archiveRootKind('-phases'), null);
    assert.equal(archiveRootKind('v1.0-phase'), null);
    assert.equal(archiveRootKind(`${'a'.repeat(64)}-phases`), 'phases', 'a 64-character label is the longest legal one');
    assert.equal(archiveRootKind(`${'a'.repeat(65)}-phases`), null, 'a 65-character label is outside the grammar');
    assert.equal(archiveRootKind('.hidden-phases'), null, 'a label starts with a letter or digit');
    assert.equal(archiveRootKind(undefined), null);
  });
});

describe('compareLabels: natural numeric order of digit runs, then bytewise', () => {
  it('orders v1.2 before v1.10 and 3.1 before v10', () => {
    assert.ok(compareLabels('v1.2', 'v1.10') < 0);
    assert.ok(compareLabels('v1.10', 'v1.2') > 0);
    assert.ok(compareLabels('3.1', 'v10') < 0);
    assert.equal(compareLabels('v1.0', 'v1.0'), 0);
  });

  it('sorts a list into the oldest-first order', () => {
    const sorted = ['v1.10', 'v1.2', 'v1.1', 'v2.0', 'v1.2.1'].sort(compareLabels);
    assert.deepEqual(sorted, ['v1.1', 'v1.2', 'v1.2.1', 'v1.10', 'v2.0']);
  });

  it('is total on equal-value digit runs with different padding', () => {
    assert.notEqual(compareLabels('v01', 'v1'), 0, 'two distinct labels never compare equal');
    assert.equal(Math.sign(compareLabels('v01', 'v1')), -Math.sign(compareLabels('v1', 'v01')));
  });
});

describe('locationOf: the class and root of a unit dir path', () => {
  it('maps the three classes', () => {
    assert.deepEqual(locationOf('.planning/phases/01-x'), { cls: 'live', root: '.planning/phases', label: null });
    assert.deepEqual(locationOf('.planning/quick/260101-abc-t'), { cls: 'live', root: '.planning/quick', label: null });
    assert.deepEqual(locationOf('.planning/milestones/v1.0-phases/01-setup'), {
      cls: 'archive-phases', root: '.planning/milestones/v1.0-phases', label: 'v1.0',
    });
    assert.deepEqual(locationOf('.planning/milestones/v1.10-quick/260101-abc-t'), {
      cls: 'archive-quick', root: '.planning/milestones/v1.10-quick', label: 'v1.10',
    });
  });

  it('answers null for any other path', () => {
    assert.equal(locationOf('.planning/foo/x'), null);
    assert.equal(locationOf('.planning/milestones/notes/x'), null);
    assert.equal(locationOf('.planning/phases'), null);
    assert.equal(locationOf('.planning/phases/01-x/extra'), null);
    assert.equal(locationOf('.planning/milestones/v1.0-phases'), null);
    assert.equal(locationOf('src/x'), null);
    assert.equal(locationOf(undefined), null);
  });
});

describe('LOCATION_KINDS and the locations line', () => {
  it('is a frozen closed list in the documented order', () => {
    assert.ok(Object.isFrozen(LOCATION_KINDS));
    assert.deepEqual([...LOCATION_KINDS], [
      'units_archived', 'repeat_id', 'moved', 'move_ambiguous', 'not_read_workstream_dir', 'not_read_workstream_plan_files', 'not_read_bare_plan',
      'not_read_plan_id_1seg', 'not_read_plan_id_3seg', 'not_read_plan_file_other', 'not_read_plan_file_coded',
      'not_read_bracket_phase_dir', 'not_read_custom_phase_dir', 'not_read_quick_dir_name', 'not_read_milestones_other_dir',
      'trees_scanned',
    ]);
  });

  it('prints every kind but trees_scanned in list order, ? for all when nothing was scanned', () => {
    const shown = LOCATION_KINDS.filter((k) => k !== 'trees_scanned');
    assert.equal(locationsLine(null, 0), `locations: repos=0 ${shown.map((k) => `${k}=?`).join(' ')}`);
    const map = Object.fromEntries(shown.map((k, i) => [k, i]));
    assert.equal(locationsLine(map, 2), `locations: repos=2 ${shown.map((k, i) => `${k}=${i}`).join(' ')}`);
    assert.ok(!locationsLine(map, 2).includes('trees_scanned'));
  });

  it('is driven by the list: a kind appended to a copy of it grows the line by that kind', () => {
    const grown = [...LOCATION_KINDS, 'probe_kind'];
    const base = locationsLine({}, 1);
    const line = locationsLine({ probe_kind: 3 }, 1, grown);
    assert.ok(line.startsWith(`${base} `), 'the existing fields keep their order');
    assert.ok(line.endsWith(' probe_kind=3'), line);
    assert.equal(line.split(' ').length, base.split(' ').length + 1);
    assert.ok(locationsLine(null, 0, grown).endsWith(' probe_kind=?'));
  });

  it('prints a missing counter of a scanned repo as 0, never ?', () => {
    assert.ok(locationsLine({}, 1).split(' ').slice(2).every((f) => f.endsWith('=0')));
  });
});

describe('phaseDirForm: how a phases-root directory name starts', () => {
  it('classifies the documented examples', () => {
    assert.deepEqual(phaseDirForm('03-gamma'), { form: 'standard', code: null });
    assert.deepEqual(phaseDirForm('02.1-hotfix'), { form: 'standard', code: null });
    assert.deepEqual(phaseDirForm('ABC-03-gamma'), { form: 'coded', code: 'ABC' });
    assert.deepEqual(phaseDirForm('MY-APP-03-name'), { form: 'coded', code: 'MY-APP' });
    assert.deepEqual(phaseDirForm('GSD.02-05-delta'), { form: 'bracket', code: 'GSD.02' });
    assert.equal(phaseDirForm('auth-setup').form, 'custom');
    assert.equal(phaseDirForm('PROJ-123-x').form, 'custom');
    assert.equal(phaseDirForm('7-short').form, 'custom', 'a one-digit phase part is not a phase part');
  });

  it('a code of 32 characters is a code, a 33-character one is not', () => {
    assert.equal(phaseDirForm(`${'a'.repeat(32)}-03-x`).form, 'coded');
    assert.equal(phaseDirForm(`${'a'.repeat(33)}-03-x`).form, 'custom');
  });

  it('a code starts with a letter', () => {
    assert.equal(phaseDirForm('_AB-03-x').form, 'custom');
    assert.equal(phaseDirForm('1AB-03-x').form, 'custom');
  });
});

describe('dirAcceptsPlan: whether a phases-root directory carries the phase part of a plan id', () => {
  it('accepts the standard and coded forms and nothing else', () => {
    assert.equal(dirAcceptsPlan('ABC-03-gamma', '03-01'), true);
    assert.equal(dirAcceptsPlan('ABC-03-gamma', '04-01'), false);
    assert.equal(dirAcceptsPlan('03-gamma', '03-01'), true);
    assert.equal(dirAcceptsPlan('03-gamma-copy', '03-01'), true);
    assert.equal(dirAcceptsPlan('02.1-hotfix', '02.1-01'), true);
    assert.equal(dirAcceptsPlan('02.1-hotfix', '02-01'), false);
    assert.equal(dirAcceptsPlan('GSD.02-05-delta', '05-01'), false, 'the bracket form is not read');
    assert.equal(dirAcceptsPlan('auth-setup', '03-01'), false);
  });
});

describe('planFileForm: the form of a file name that ends PLAN.md', () => {
  it('classifies each documented name', () => {
    assert.equal(planFileForm('03-01-PLAN.md'), 'plan');
    assert.equal(planFileForm('PLAN.md'), 'bare');
    assert.equal(planFileForm('08-PLAN.md'), 'id1');
    assert.equal(planFileForm('2.1-PLAN.md'), 'id1');
    assert.equal(planFileForm('02.1-PLAN.md'), 'id1');
    assert.equal(planFileForm('09-01-02-PLAN.md'), 'id3');
    assert.equal(planFileForm('ABC-04-01-PLAN.md'), 'coded');
    assert.equal(planFileForm('10-01-extra-PLAN.md'), 'other');
    assert.equal(planFileForm('3.1-1-PLAN.md'), 'other');
    assert.equal(planFileForm('notes.md'), null);
    assert.equal(planFileForm('PLAN.md.bak'), null);
    assert.equal(planFileForm('03-01-SUMMARY.md'), null);
  });
});

describe('the docs name every counter', () => {
  it('docs/sources.md names every kind of LOCATION_KINDS and docs/cli.md every counter of the line', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
    const sources = read('docs/sources.md');
    const cli = read('docs/cli.md');
    for (const k of LOCATION_KINDS) assert.ok(sources.includes(`\`${k}\``), `docs/sources.md names ${k}`);
    for (const k of LOCATION_KINDS.filter((x) => x !== 'trees_scanned')) assert.ok(cli.includes(`\`${k}\``), `docs/cli.md names ${k}`);
  });
});

describe('formerLivePath, canonicalDir and linkDirOf: the pure archive-to-live path rewrite (plan 03.1-02, D-02, D-19)', () => {
  it('rewrites a path below a phases or quick archive root to its former live path', () => {
    assert.equal(formerLivePath('.planning/milestones/v1.0-phases/01-x/f'), '.planning/phases/01-x/f');
    assert.equal(formerLivePath('.planning/milestones/3.1-phases/02-y/02-01-PLAN.md'), '.planning/phases/02-y/02-01-PLAN.md');
    assert.equal(formerLivePath('.planning/milestones/archived-20261106-quick/260101-abc-t/x.md'), '.planning/quick/260101-abc-t/x.md');
    assert.equal(formerLivePath('.planning/milestones/v1.0-phases/01-x'), '.planning/phases/01-x');
  });

  it('leaves every other path unchanged', () => {
    for (const p of [
      '.planning/milestones/v1.0-ROADMAP.md',
      '.planning/milestones-v1-03-alpha/x',
      `.planning/milestones/${'a'.repeat(65)}-phases/01-x/f`,
      '.planning/milestones/v1.0-phases',
      '.planning/milestones/v1.0-phases/',
      '.planning/milestones/v1.0-phases/../x',
      '.planning/milestones/v1.0-phases/01-x//f',
      '.planning/milestones/notes/01-x',
      '.planning/phases/x',
      '.planning/quick/260101-abc-t',
      'src/x',
      '',
    ]) assert.equal(formerLivePath(p), p, p);
  });

  it('is idempotent and canonicalDir is the same rewrite applied to a dir path', () => {
    for (const p of ['.planning/milestones/v1.0-phases/01-x', '.planning/phases/01-x', '.planning/milestones/v2-quick/260101-abc-t']) {
      assert.equal(canonicalDir(canonicalDir(p)), canonicalDir(p));
      assert.equal(canonicalDir(p), formerLivePath(p));
    }
    assert.equal(canonicalDir('.planning/milestones/v1.0-quick/260101-abc-t'), '.planning/quick/260101-abc-t');
  });

  it('linkDirOf is null-safe', () => {
    assert.equal(linkDirOf(null), null);
    assert.equal(linkDirOf(undefined), null);
    assert.equal(linkDirOf('.planning/milestones/v1.0-phases/01-x'), '.planning/phases/01-x');
    assert.equal(linkDirOf('.planning/phases/01-x'), '.planning/phases/01-x');
  });
});

describe('PLANNING_PATHSPECS: the planning dirs every git log of the adapter asks about (plan 03.1-03, D-07)', () => {
  it('is the frozen list quick, phases, milestones', async () => {
    const mod = await import('../../src/adapters/gsd-core/layout.mjs');
    assert.deepEqual([...(mod.PLANNING_PATHSPECS ?? [])], ['.planning/quick', '.planning/phases', '.planning/milestones']);
    assert.ok(Object.isFrozen(mod.PLANNING_PATHSPECS));
  });
});
