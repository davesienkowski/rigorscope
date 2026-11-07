// Source auto-discovery. A source is a directory src/sources/NAME/index.mjs exporting its descriptor:
//   name           equals the directory name and matches /^[a-z][a-z0-9-]{0,31}$/
//   freshness      { live: boolean, staleAfterHours: number }
//   discover(ctx)  -> { roots: [{ alias, display, kind }], units: [{ rootAlias, rel, abs, kind, whole? }] }
//   read(unit, start, opts)  -> iterable of items { ..., end }, end = offset just past the item
//   normalize(item, unit, ctx) -> { records: [...], ts? }
//   createWriter(db) -> { write(record, fileId, runId) -> number of primary rows written }
//   cursorless     optional boolean (default false, plan 01-06): the runner keeps no cursor for the units of
//                  such a source (no source_root or source_file row, no stat, no window hash) and reads each
//                  unit in full on every run; fileId is then null. An item may carry `opened: false` (the unit
//                  was not opened, so it is not counted in files). For a unit that produced records, new or
//                  unchanged follow the rows its writer reports as newly inserted.
// Adding a source is adding a directory: no shared file is edited.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCES_DIR = fileURLToPath(new URL('../sources/', import.meta.url));
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

export function validateDescriptor(desc, dirName) {
  const bad = (why) => { throw new Error(`source "${String(dirName).slice(0, 40)}": ${why}`); };
  if (!desc || typeof desc !== 'object') bad('no descriptor');
  if (typeof desc.name !== 'string' || !NAME.test(desc.name)) bad('name must match the source name pattern');
  if (desc.name !== dirName) bad('name must equal the directory name');
  const f = desc.freshness;
  if (!f || typeof f.live !== 'boolean' || typeof f.staleAfterHours !== 'number' || !(f.staleAfterHours > 0)) {
    bad('freshness must be { live: boolean, staleAfterHours: number }');
  }
  if (desc.cursorless !== undefined && typeof desc.cursorless !== 'boolean') bad('cursorless must be a boolean');
  for (const fn of ['discover', 'read', 'normalize', 'createWriter']) {
    if (typeof desc[fn] !== 'function') bad(`${fn} must be a function`);
  }
}

export async function loadSources({ dir = SOURCES_DIR } = {}) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'index.mjs')))
    .map((e) => e.name)
    .sort();
  const out = [];
  for (const name of names) {
    const mod = await import(pathToFileURL(join(dir, name, 'index.mjs')).href);
    validateDescriptor(mod, name);
    out.push(mod);
  }
  return out;
}
