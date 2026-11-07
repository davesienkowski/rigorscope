// Helper of plan 03.1-05: the independent census of a `.planning` tree and the two roster list files. A helper, not a test.
// The census walker lists files with readdirSync and applies its own regexes; it never imports the adapter's layout or
// classifier. Only the roster list computation imports the roster (classifyFile, notLookedFor), to name the two list files.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { classifyFile, loadRoster, notLookedFor } from '../../src/adapters/gsd-core/roster.mjs';

const NAME = /^[A-Za-z0-9._-]+$/;
const PHASE_DIR = /^(?:[A-Za-z][A-Za-z0-9_.]*(?:-[A-Za-z][A-Za-z0-9_.]*)*-)?\d{2,3}(?:\.\d{1,3})?(?:-\d{2,3})?-[A-Za-z0-9._-]+$/;
const CODED_DIR = /^[A-Za-z][A-Za-z0-9_.]*(?:-[A-Za-z][A-Za-z0-9_.]*)*-\d{2,3}/;
const QUICK_DIR = /^\d{6}-[a-z0-9]{3}-[A-Za-z0-9._-]+$/;
const PLAN_FILE = /(?:^|-)PLAN\.md$/;

const subdirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
const filesIn = (dir) => (existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && NAME.test(e.name)).map((e) => e.name) : []);

// -> { listings: [{ dir, scope, coded, files }], plans, files, repeated } for one .planning tree. The listings are the
// directories whose files the adapter classifies by name: the phases and quick roots, phase dirs, quick dirs, the milestone
// files and every archive dir.
export function census(planning) {
  const listings = [];
  const add = (dir, scope, files, coded = false) => listings.push({ dir, scope, coded, files });
  add('phases', 'phases-root', filesIn(join(planning, 'phases')));
  add('quick', 'quick-root', filesIn(join(planning, 'quick')));
  add('milestones', 'milestones', filesIn(join(planning, 'milestones')));
  for (const d of subdirs(join(planning, 'phases'))) {
    if (PHASE_DIR.test(d)) add(`phases/${d}`, 'phase', filesIn(join(planning, 'phases', d)), CODED_DIR.test(d));
  }
  for (const d of subdirs(join(planning, 'quick'))) {
    if (QUICK_DIR.test(d)) add(`quick/${d}`, 'quick', filesIn(join(planning, 'quick', d)));
  }
  for (const a of subdirs(join(planning, 'milestones'))) {
    const m = /-(phases|quick)$/.exec(a);
    if (!m) continue;
    for (const d of subdirs(join(planning, 'milestones', a))) {
      add(`milestones/${a}/${d}`, m[1] === 'quick' ? 'quick' : 'phase', filesIn(join(planning, 'milestones', a, d)), m[1] === 'phases' && CODED_DIR.test(d));
    }
  }
  const plans = listings.filter((l) => l.scope === 'phase').flatMap((l) => l.files.filter((f) => PLAN_FILE.test(f)).map((f) => `${l.dir}/${f}`));
  const ids = new Map();
  for (const p of plans) {
    const m = /(\d{2,3}(?:\.\d{1,3})?-\d{2,3})-PLAN\.md$/.exec(p);
    if (m) ids.set(m[1], (ids.get(m[1]) ?? 0) + 1);
  }
  return {
    listings, plans, files: listings.reduce((n, l) => n + l.files.length, 0), repeated: [...ids.values()].filter((n) => n > 1).length,
  };
}

const SCANNED = ['phase', 'quick', 'milestones'];
const label = (e) => `${e.class} ${e.scopes.join(',')} ${e.stem ?? e.re ?? e.path_glob}${e.ext ?? ''}`;

// censuses: the census() results of the committed stages. -> { gaps, notScanned }: the roster-order lines of the entries of class
// F, E or S in a scanned scope that no file of any stage matched, and the entries rigorscope does not look for by design.
export function rosterLists(censuses) {
  const hit = new Set();
  for (const c of censuses) {
    for (const l of c.listings) {
      const scope = l.scope === 'phases-root' ? 'phases-root' : l.scope;
      if (!['phase', 'quick', 'milestones'].includes(scope)) continue;
      for (const f of l.files) {
        const r = classifyFile(f, { scope, coded: l.coded });
        if (r) hit.add(r.entry);
      }
    }
  }
  const gaps = loadRoster().entries
    .filter((e) => ['F', 'E', 'S'].includes(e.class) && e.scopes.some((s) => SCANNED.includes(s)) && !hit.has(e))
    .map(label);
  const nl = notLookedFor();
  const notScanned = [...nl.root, ...nl.path_glob, ...nl.no_scanned_scope].map((i) => `${i.class} ${i.name}${i.ext ?? ''}`);
  return { gaps, notScanned };
}
