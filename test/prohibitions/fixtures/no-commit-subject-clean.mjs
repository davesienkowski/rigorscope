// CLEAN fixture for test/prohibitions/no-commit-subject.test.mjs: re-exports the real git fact collector, so the
// prohibition test passes on it and a failure on the violation fixture is caused by that fixture's content.
export * from '../../../src/adapters/gsd-core/facts.mjs';
