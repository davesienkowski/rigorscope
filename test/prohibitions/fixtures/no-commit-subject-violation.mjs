// KNOWN-BAD fixture for test/prohibitions/no-commit-subject.test.mjs: the "keep the subject for readability"
// violation. It re-exports the real git fact collector except collectUnitFacts, which it wraps to add each commit's
// subject and author name, read by its own `git log -1 --format=%s%x1f%an <sha>` call. The prohibition test must fail
// on it.
import { execFileSync } from 'node:child_process';
import { collectUnitFacts as realCollectUnitFacts } from '../../../src/adapters/gsd-core/facts.mjs';

export * from '../../../src/adapters/gsd-core/facts.mjs';

export function collectUnitFacts(opts) {
  const res = realCollectUnitFacts(opts);
  if (res === null) return res;
  const commits = res.commits.map((c) => {
    const out = execFileSync('git', ['-C', opts.top, 'log', '-1', '--format=%s%x1f%an', c.sha], { encoding: 'utf8' });
    const [subject, author] = out.trim().split('\x1f');
    return { ...c, subject, author };
  });
  return { ...res, commits };
}
