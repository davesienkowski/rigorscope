// Tree kind of this checkout (plan 09-03, decisions 1 and 2). The private marker is the file `.planning/private-refs.json`:
// present in the maintainer's checkout, absent from every export and from a user's own GSD clone of the public tree. It maps
// an id to a repo-relative path of a file that exists only in the maintainer's checkout. A shipped test asks for the path
// through privateRef(id) instead of naming it. Without the marker the tree is public: privateRef returns null and the
// caller skips with skipUnlessPrivate's reason. With the marker, a malformed body, an unknown id or a missing target throws,
// so a broken private tree fails instead of skipping (a private guard test checks the real file).
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const MARKER = ['.planning', 'private-refs.json'];

const markerPath = (root) => join(root, ...MARKER);

export function isPrivateTree(root = REPO) {
  return existsSync(markerPath(root));
}

function readRefs(root) {
  let refs;
  try {
    refs = JSON.parse(readFileSync(markerPath(root), 'utf8'));
  } catch {
    throw new Error('private refs malformed');
  }
  if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) throw new Error('private refs malformed');
  for (const v of Object.values(refs)) {
    if (typeof v !== 'string' || v === '' || isAbsolute(v) || v.split(/[\\/]/).includes('..')) throw new Error('private refs malformed');
  }
  return refs;
}

// -> the absolute path of the private file named by `id`, or null in a public tree.
export function privateRef(id, root = REPO) {
  if (!isPrivateTree(root)) return null;
  const refs = readRefs(root);
  if (!Object.hasOwn(refs, id)) throw new Error('private ref unknown');
  const path = join(root, refs[id]);
  if (!existsSync(path)) throw new Error('private ref target missing');
  return path;
}

// -> false in a private tree, else the visible skip reason (the value of a node:test `skip` option).
export function skipUnlessPrivate(id, root = REPO) {
  return isPrivateTree(root) ? false : `private tree only: ${id}`;
}
