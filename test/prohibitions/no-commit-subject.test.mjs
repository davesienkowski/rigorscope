// Prohibition (plan 02-05, UNIT-04, ADR-0002, ADR-0009 (f), T-02-40): MUST NOT collect or store a commit subject, body,
// author or committer name or email. The git fact collector yields only shas, author times, file paths with status and
// line counts, and module-dir existence answers.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a module exporting collectUnitFacts, resolved against process.cwd();
// unset means src/adapters/gsd-core/facts.mjs. test/prohibitions/fixtures/no-commit-subject-violation.mjs (it adds each
// commit's subject and author name "for readability") must fail this test;
// test/prohibitions/fixtures/no-commit-subject-clean.mjs (re-exports the real module) must pass it.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeHome } from '../fixtures/build.mjs';
import { commitWith, makeRepo, writeFileAt } from '../fixtures/git-repo.mjs';

const DEFAULT_SUBJECT = fileURLToPath(new URL('../../src/adapters/gsd-core/facts.mjs', import.meta.url));
const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : DEFAULT_SUBJECT;

const COMMIT_KEYS = new Set(['sha', 'author_ms', 'files', 'files_n', 'added', 'deleted', 'touches_code']);
const FILE_KEYS = new Set(['path', 'status', 'added', 'deleted']);

it('the collected unit facts hold no commit subject, body or author identity', async () => {
  const { collectUnitFacts } = await import(pathToFileURL(subject).href);
  const ctx = makeHome();
  try {
    // The email is assembled at run time, so no email shape appears in this source.
    const local = ['prohib', 'author', 'mail'].join('-');
    const domain = ['prohib-example', 'invalid'].join('.');
    const email = `${local}${String.fromCharCode(64)}${domain}`;
    const repo = join(ctx.home, 'repos', 'pi');
    makeRepo(repo, { home: ctx.home, files: { 'README.md': 'pi\n' } });
    writeFileAt(repo, 'src/pi/x.mjs', 'export const x = 1;\n');
    commitWith(repo, {
      home: ctx.home,
      date: '2026-10-30T10:00:00Z',
      message: 'feat(261030-p1x): PROHIB-subject-text\n\nPROHIB-body-text',
      name: 'PROHIB-author-name',
      email,
    });
    const res = collectUnitFacts({
      top: join(repo, '.git'), kind: 'quick', nativeId: '261030-p1x', home: ctx.home,
    });
    assert.ok(res && Array.isArray(res.commits) && res.commits.length >= 1, 'the planted commit is collected');
    const text = JSON.stringify(res);
    assert.ok(!text.includes('PROHIB-'), 'a commit subject, body or author name was collected');
    for (const part of [local, domain]) assert.ok(!text.includes(part), 'a part of the author email was collected');
    assert.ok(!text.includes(String.fromCharCode(64)), 'an email shape was collected');
    for (const c of res.commits) {
      for (const k of Object.keys(c)) assert.ok(COMMIT_KEYS.has(k), 'a commit carries a key outside the fact set');
      for (const f of c.files) for (const k of Object.keys(f)) assert.ok(FILE_KEYS.has(k), 'a file carries a key outside the fact set');
    }
  } finally {
    ctx.cleanup();
  }
});
