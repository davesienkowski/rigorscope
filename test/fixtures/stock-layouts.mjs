// Named stock gsd-core `.planning/` layouts with hand-computed expectations (plan 03.1-01, ADPT-05; reused by plans
// 03.1-02 to 03.1-05). A generator module, not a test: every layout is built into a directory the caller owns, and no
// tree is committed. The expectations are written from the layout tables of the plan (03.1-01-PLAN.md "Layout fixtures
// and hand-computed expectations"), never from the output of the adapter.
//
// Each entry is { build(top, { home }), expect }:
//   expect.units        the units a scan of the tree must return, { kind, nativeId, dirRel, tier, artifacts } (tier is the
//                       tier letter of the unit's own PLAN file, artifacts the number of artifact rows)
//   expect.counters     the non-zero location counters (kinds of LOCATION_KINDS except trees_scanned); every other kind
//                       is 0
//   expect.dupIds       distinct second dirs of one id in the same root (default 0)
//   expect.repeatDirs   the second dirs of an id in another root (default [])
//   expect.skippedPlans PLAN-named files the scan counts in `skipped` (default [])
//   expect.known        (reset only) the same expectation when the scan is given the stored dirs below
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { planText, writeFileAt, writePlanningDir } from './git-repo.mjs';

const plan = (tier) => planText({ tier });
const NOTE = '# note\n';

export const STOCK_LAYOUTS = Object.freeze({
  // A live phase, an archived phase dir and an archived quick dir, a milestone-level file (not an archive root, not
  // counted) and a directory under milestones/ that is no archive root (counted).
  archived: {
    build(top) {
      writePlanningDir(top, { under: 'phases', name: '02-beta', files: { '02-01-PLAN.md': plan('B') } });
      writePlanningDir(top, {
        under: 'milestones/v1.0-phases',
        name: '01-setup',
        files: { '01-01-PLAN.md': plan('A'), '01-01-SUMMARY.md': plan('A') },
      });
      writePlanningDir(top, {
        under: 'milestones/v1.0-quick',
        name: '260101-abc-task',
        files: { '260101-abc-PLAN.md': plan('C') },
      });
      writeFileAt(top, '.planning/milestones/v1.0-ROADMAP.md', NOTE);
      writePlanningDir(top, { under: 'milestones', name: 'notes', files: { 'x.md': NOTE } });
    },
    expect: {
      units: [
        {
          kind: 'plan', nativeId: '02-01', dirRel: '.planning/phases/02-beta', tier: 'B', artifacts: 1,
        },
        {
          kind: 'plan', nativeId: '01-01', dirRel: '.planning/milestones/v1.0-phases/01-setup', tier: 'A', artifacts: 2,
        },
        {
          kind: 'quick', nativeId: '260101-abc', dirRel: '.planning/milestones/v1.0-quick/260101-abc-task', tier: 'C', artifacts: 1,
        },
      ],
      counters: { units_archived: 2, not_read_milestones_other_dir: 1 },
    },
  },
  // A code-prefixed phase dir (a unit, id without the code), a bracket-form dir (counted) and a coded plan file name
  // (counted). The bracket dir's plan file sits in a dir of another phase part, so the scan also counts it in `skipped`
  // as it always counted a PLAN file in a dir that does not carry its phase part.
  prefixed: {
    build(top) {
      writePlanningDir(top, { under: 'phases', name: 'ABC-03-gamma', files: { '03-01-PLAN.md': plan('B') } });
      writePlanningDir(top, { under: 'phases', name: 'GSD.02-05-delta', files: { '05-01-PLAN.md': plan('C') } });
      writePlanningDir(top, { under: 'phases', name: 'ABC-04-eps', files: { 'ABC-04-01-PLAN.md': plan('C') } });
    },
    expect: {
      units: [{
        kind: 'plan', nativeId: '03-01', dirRel: '.planning/phases/ABC-03-gamma', tier: 'B', artifacts: 1,
      }],
      counters: { not_read_bracket_phase_dir: 1, not_read_plan_file_coded: 1 },
      skippedPlans: ['.planning/phases/GSD.02-05-delta/05-01-PLAN.md'],
    },
  },
  // Two workstreams with independent numbering: never units, counted by dir and by plan file.
  workstreams: {
    build(top) {
      writePlanningDir(top, {
        under: 'workstreams/api/phases',
        name: '01-x',
        files: { '01-01-PLAN.md': plan('A'), '01-02-PLAN.md': plan('A') },
      });
      writePlanningDir(top, { under: 'workstreams/web/phases', name: '01-y', files: { '01-01-PLAN.md': plan('B') } });
    },
    expect: {
      units: [],
      counters: { not_read_workstream_dir: 2, not_read_workstream_plan_files: 3 },
    },
  },
  // Every counted-only name form, once.
  forms: {
    build(top) {
      writePlanningDir(top, { under: 'phases', name: '07-bare', files: { 'PLAN.md': plan('A') } });
      writePlanningDir(top, { under: 'phases', name: '08-one', files: { '08-PLAN.md': plan('A') } });
      writePlanningDir(top, { under: 'phases', name: '09-three', files: { '09-01-02-PLAN.md': plan('A') } });
      writePlanningDir(top, { under: 'phases', name: '10-slug', files: { '10-01-extra-PLAN.md': plan('A') } });
      writePlanningDir(top, { under: 'phases', name: 'auth-setup', files: { 'notes.md': NOTE } });
      writePlanningDir(top, { under: 'quick', name: 'notes', files: { 'n.md': NOTE } });
    },
    expect: {
      units: [],
      counters: {
        not_read_bare_plan: 1,
        not_read_plan_id_1seg: 1,
        not_read_plan_id_3seg: 1,
        not_read_plan_file_other: 1,
        not_read_custom_phase_dir: 1,
        not_read_quick_dir_name: 1,
      },
    },
  },
  // --reset-phase-numbers: the old milestone's dir is archived and a new `01-*` dir holds the same plan id.
  reset: {
    build(top) {
      writePlanningDir(top, {
        under: 'milestones/v1.0-phases', name: '01-setup', files: { '01-01-PLAN.md': plan('A') },
      });
      writePlanningDir(top, { under: 'phases', name: '01-new', files: { '01-01-PLAN.md': plan('B') } });
    },
    expect: {
      // A new id: the oldest archive root first; the live dir is a second dir in another root.
      units: [{
        kind: 'plan', nativeId: '01-01', dirRel: '.planning/milestones/v1.0-phases/01-setup', tier: 'A', artifacts: 1,
      }],
      counters: { units_archived: 1, repeat_id: 1 },
      dupIds: 0,
      repeatDirs: ['.planning/phases/01-new'],
      // The stored dir of the id is the live one: it is read, the archive dir is the repeat.
      knownPlans: { '01-01': '.planning/phases/01-new' },
      known: {
        units: [{
          kind: 'plan', nativeId: '01-01', dirRel: '.planning/phases/01-new', tier: 'B', artifacts: 1,
        }],
        counters: { repeat_id: 1 },
        dupIds: 0,
        repeatDirs: ['.planning/milestones/v1.0-phases/01-setup'],
      },
    },
  },
});

// Creates the empty live roots a scan lists, for a test that builds a layout by hand.
export function emptyPlanning(top) {
  mkdirSync(join(top, '.planning', 'phases'), { recursive: true });
  mkdirSync(join(top, '.planning', 'quick'), { recursive: true });
}
