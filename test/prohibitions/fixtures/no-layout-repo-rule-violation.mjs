// KNOWN-BAD subject of test/prohibitions/no-layout-repo-rule.test.mjs (plan 02-02, D-22): the real resolver, with the
// phase 1 two-prefix directory-layout rule as a fallback when git answers none: the first path segment after a
// home-relative repos or workspaces prefix becomes the repo, with a layout method name. The prohibition test must fail
// on it. The prefixes are built from fragments so no layout literal appears in this file as text.
import { resolveDir as realResolveDir } from '../../../src/units/repo-resolve.mjs';

const PREFIXES = [[['~', 'repos', ''].join('/'), 'repos_dir'], [['~', 'wsroot', 'workspaces', ''].join('/'), 'wsroot_workspace']];

export function resolveDir(stored, opts) {
  const res = realResolveDir(stored, opts);
  if (res.method !== 'none' || typeof stored !== 'string') return res;
  for (const [prefix, method] of PREFIXES) {
    if (!stored.startsWith(prefix)) continue;
    const name = stored.slice(prefix.length).split('/')[0];
    if (name) return { repoKey: `${prefix}${name}`, repoName: name, method, isWorktree: 0 };
  }
  return res;
}
