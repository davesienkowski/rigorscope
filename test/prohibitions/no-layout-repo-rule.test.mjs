// Prohibition (plan 02-02, D-22, D-09, D-24, UNIT-02): no directory-layout rule (a home-relative repos or workspaces
// prefix) may decide a repo or its name. An existing directory that is not inside a git repository resolves to method
// none and repo_key NULL whatever its path looks like; only git decides.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a module exporting resolveDir, resolved against process.cwd(); unset
// means src/units/repo-resolve.mjs. test/prohibitions/fixtures/no-layout-repo-rule-violation.mjs (the resolver with
// the phase 1 two-prefix layout rule as a fallback) must fail this test; test/prohibitions/fixtures/
// no-layout-repo-rule-clean.mjs (a re-export of the real function) must pass it. Every directory and repository is
// created inside a temporary HOME from makeHome().
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeHome } from '../fixtures/build.mjs';
import { makeRepo } from '../fixtures/git-repo.mjs';

const DEFAULT_SUBJECT = fileURLToPath(new URL('../../src/units/repo-resolve.mjs', import.meta.url));
const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : DEFAULT_SUBJECT;

it('plain directories at layout-shaped paths resolve to none; only a real repository resolves, by git', async () => {
  const { resolveDir } = await import(pathToFileURL(subject).href);
  const ctx = makeHome();
  try {
    mkdirSync(join(ctx.home, 'repos', 'plainrepo'), { recursive: true });
    mkdirSync(join(ctx.home, 'wsroot', 'workspaces', 'plainrepo', 'tree'), { recursive: true });
    makeRepo(join(ctx.home, 'somewhere', 'else', 'proj'), { home: ctx.home, files: { 'README.md': 'p\n' } });
    for (const stored of ['~/repos/plainrepo', '~/wsroot/workspaces/plainrepo/tree']) {
      const res = resolveDir(stored, { home: ctx.home });
      assert.equal(res.method, 'none', 'a layout-shaped path decided a repo');
      assert.equal(res.repoKey, null, 'a layout-shaped path produced a repo key');
    }
    const real = resolveDir('~/somewhere/else/proj', { home: ctx.home });
    assert.equal(real.method, 'git');
    assert.equal(real.repoKey, '~/somewhere/else/proj/.git');
  } finally {
    ctx.cleanup();
  }
});
