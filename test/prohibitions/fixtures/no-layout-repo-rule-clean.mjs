// Clean subject of test/prohibitions/no-layout-repo-rule.test.mjs: a re-export of the real resolver. It must pass,
// so the violation fixture's failure is caused by its content, not by the harness.
export { resolveDir } from '../../../src/units/repo-resolve.mjs';
