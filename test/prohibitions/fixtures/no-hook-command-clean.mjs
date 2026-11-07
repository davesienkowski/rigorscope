// CLEAN fixture for test/prohibitions/no-hook-command.test.mjs: re-exports the real snapshotter, so the prohibition
// test passes on it and a failure on the violation fixture is caused by that fixture's content.
export * from '../../../src/env/snapshot.mjs';
