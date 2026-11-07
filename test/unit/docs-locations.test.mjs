// Plan 03.1-06, Task 3 (D-14): the docs agree with the code of phase 03.1. Every name a reader needs is in the file that is
// supposed to carry it: the location kinds and the class kinds in docs/sources.md, the counters printed on the `locations:` and
// `classes:` ingest lines in docs/cli.md, the new doctor keys, the `roster_drift` finding and the drift variable in docs/cli.md
// and docs/operations.md, the two derived names in docs/data-model.md, and the sentence on what `units --json` `dir` shows for a
// moved unit in docs/units.md. checkDocs is pure (it takes the file texts), so the mutation rows run on in-memory copies with one
// name removed and must report exactly that name.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCATION_KINDS, SENTINEL_KIND } from '../../src/adapters/gsd-core/layout.mjs';
import {
  CLASS_KINDS, REPO_CLASS_KINDS, STEM_KIND, STEM_OTHER_KIND,
} from '../../src/adapters/gsd-core/roster.mjs';
import { CHECKOUT_ENV } from '../../src/report/roster.mjs';

const DOCS = Object.freeze(['docs/sources.md', 'docs/cli.md', 'docs/operations.md', 'docs/data-model.md', 'docs/units.md', 'docs/privacy.md', 'README.md']);
const readDoc = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const loadDocs = () => Object.fromEntries(DOCS.map((d) => [d, readDoc(d)]));

// The doctor keys and the finding id this phase added (src/measure/doctor.mjs DOCTOR_KEYS, the catalog entry roster_drift).
const NEW_DOCTOR_KEYS = Object.freeze(['unit-locations', 'roster', 'unclassified']);
const NEW_FINDING = 'roster_drift';
const CLASS_LINE_FIELDS = Object.freeze([...REPO_CLASS_KINDS, 'roster_ref']);

// -> the list of `file: name` misses, in a fixed order.
export function checkDocs(docs) {
  const miss = [];
  // A name counts as documented when it stands alone in code font or opens a `name=value` field in code font.
  const need = (file, name) => {
    if (!docs[file].includes(`\`${name}\``) && !docs[file].includes(`\`${name}=`)) miss.push(`${file}: ${name}`);
  };
  for (const k of LOCATION_KINDS) need('docs/sources.md', k);
  for (const k of CLASS_KINDS) need('docs/sources.md', k);
  for (const k of LOCATION_KINDS.filter((x) => x !== SENTINEL_KIND)) need('docs/cli.md', k);
  for (const k of CLASS_LINE_FIELDS) need('docs/cli.md', k);
  for (const f of ['docs/cli.md', 'docs/operations.md']) {
    for (const k of NEW_DOCTOR_KEYS) need(f, k);
    need(f, NEW_FINDING);
    need(f, CHECKOUT_ENV);
  }
  need('docs/data-model.md', 'repo_scan_count');
  need('docs/data-model.md', 'id_repeats');
  // The privacy page names what is stored for the counters and stems, the README the archive locations and the roster check.
  for (const k of [STEM_KIND, STEM_OTHER_KIND, 'ingest_count']) need('docs/privacy.md', k);
  for (const k of ['.planning/milestones', 'roster', 'roster_drift']) {
    if (!docs['README.md'].includes(k)) miss.push(`README.md: ${k}`);
  }
  // docs/units.md states what `units --json` `dir` shows for a moved unit: the stored first dir.
  if (!/`units --json` `dir` shows: the stored first dir/.test(docs['docs/units.md'])) miss.push('docs/units.md: dir of a moved unit is the stored first dir');
  return miss;
}

// Sentences that said what the code no longer does (D-14): archived milestone phase dirs are not scanned, a renamed archived dir
// is never read, only the quick and phases roots are listed. A historical note that says the old behavior and then names the plan
// that changed it is allowed (the sentence must carry "plan 03.1" or "since plan 03.1" in the same paragraph).
const STALE = Object.freeze([
  { name: 'archived phase dirs are not scanned', re: /archived milestone phase (?:directories|dirs)[^.\n]*\b(?:are|is|were) (?:not scanned|never read|not read)\b/i },
  { name: 'a renamed archived dir is never read', re: /renamed archived (?:directory|dir)[^.\n]*\bnever read\b/i },
  { name: 'only quick and phases are listed', re: /\bonly `\.planning\/quick` and `\.planning\/phases`/i },
  { name: 'only the quick root is a unit dir_rel', re: /`unit\.dir_rel`\s*\n?\s*\(`\.planning\/quick\/<dir>`\)/ },
]);

export function staleIn(docs) {
  const out = [];
  for (const [file, text] of Object.entries(docs)) {
    for (const para of text.split(/\n\s*\n/)) {
      for (const s of STALE) {
        if (s.re.test(para) && !/plan 03\.1|since plan 03\.1/.test(para)) out.push(`${file}: ${s.name}`);
      }
    }
  }
  return out;
}

describe('the docs agree with the code of phase 03.1 (D-14)', () => {
  const docs = loadDocs();

  it('every name of LOCATION_KINDS and CLASS_KINDS, every counter of the two ingest lines, the doctor keys, the drift finding and variable, the derived names and the moved-unit dir sentence are in the docs', () => {
    assert.deepEqual(checkDocs(docs), []);
  });

  it('no D-14 sentence still says archived dirs are not scanned, a renamed archived dir is never read, or only the quick and phases roots are listed', () => {
    assert.deepEqual(staleIn(docs), []);
  });

  it('mutation: removing one name from the file that must carry it is reported, one name at a time', () => {
    const cases = [
      ['docs/sources.md', LOCATION_KINDS[0]],
      ['docs/sources.md', CLASS_KINDS[CLASS_KINDS.length - 1]],
      ['docs/cli.md', 'not_read_milestones_other_dir'],
      ['docs/cli.md', 'roster_ref'],
      ['docs/operations.md', NEW_FINDING],
      ['docs/operations.md', CHECKOUT_ENV],
      ['docs/cli.md', 'unit-locations'],
      ['docs/data-model.md', 'repo_scan_count'],
      ['docs/data-model.md', 'id_repeats'],
    ];
    for (const [file, name] of cases) {
      const copy = { ...docs, [file]: docs[file].split(`\`${name}\``).join('(removed)').split(`\`${name}=`).join('(removed)=') };
      const miss = checkDocs(copy);
      assert.ok(miss.includes(`${file}: ${name}`), `removing ${name} from ${file} is reported`);
    }
  });

  it('mutation: the moved-unit dir sentence removed from docs/units.md is reported', () => {
    const copy = { ...docs, 'docs/units.md': docs['docs/units.md'].replace('What `units --json` `dir` shows: the stored first dir.', 'What it shows.') };
    assert.ok(checkDocs(copy).includes('docs/units.md: dir of a moved unit is the stored first dir'));
  });

  it('mutation: a stale sentence put back is reported, and a historical note naming plan 03.1 is not', () => {
    const stale = { ...docs, 'docs/sources.md': `${docs['docs/sources.md']}\n\nArchived milestone phase directories are not scanned.\n` };
    assert.ok(staleIn(stale).some((m) => m.includes('archived phase dirs are not scanned')));
    const note = { ...docs, 'docs/sources.md': `${docs['docs/sources.md']}\n\nArchived milestone phase directories were not scanned then; plan 03.1-01 reads them.\n` };
    assert.deepEqual(staleIn(note), []);
  });
});
