// The one unit-key builder and id-shape validator (plan 03-01, D-03). The gsd-core adapter, its collectors and the
// forward ledger all build and test unit keys here, so a ledger key cannot diverge from a reconstructed key. Pure: no
// state, no filesystem.
export const FRAMEWORK = 'gsd-core';
export const UNIT_KINDS = Object.freeze(['quick', 'plan']);
// A quick id is YYMMDD-xxx; a plan id is NN-MM, NNN-MM or a decimal phase NN.M-MM. PLAN_ID_RE captures the phase part.
export const QUICK_ID_RE = /^\d{6}-[a-z0-9]{3}$/;
export const PLAN_ID_RE = /^(\d{2,3}(?:\.\d{1,3})?)-\d{2,3}$/;
const REPO_KEY_MAX = 1024;

export const idShapeOk = (kind, nativeId) => typeof nativeId === 'string'
  && ((kind === 'quick' && QUICK_ID_RE.test(nativeId)) || (kind === 'plan' && PLAN_ID_RE.test(nativeId)));

// -> `framework:repo_key:kind:native_id`. Throws RangeError (fixed text, no value) for a bad kind, a bad id or an empty or
// oversized repo key, so a half-valid key can never be built.
export function unitKeyOf(repoKey, kind, nativeId) {
  if (typeof repoKey !== 'string' || repoKey === '' || repoKey.length > REPO_KEY_MAX) throw new RangeError('unit key: bad repo key');
  if (!UNIT_KINDS.includes(kind)) throw new RangeError('unit key: bad kind');
  if (!idShapeOk(kind, nativeId)) throw new RangeError('unit key: bad native id');
  return `${FRAMEWORK}:${repoKey}:${kind}:${nativeId}`;
}
