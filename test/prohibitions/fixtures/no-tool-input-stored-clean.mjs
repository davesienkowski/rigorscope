// CLEAN fixture for test/prohibitions/no-tool-input-stored.test.mjs: re-exports the real extractor and command picker,
// so the prohibition test passes on it and a failure on the violation fixture is caused by that fixture's content.
export { normalizeRefs, normalizeCommandLine } from '../../../src/sources/transcript/refs.mjs';
