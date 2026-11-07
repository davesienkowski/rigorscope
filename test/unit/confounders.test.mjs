// Plan 02-07 (UNIT-04, D-16, D-17, DATA-07, TRUST-06): the pure confounder rules. Written before the code (RED); the
// module is imported dynamically inside each test so the file loads before it exists.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import('../../src/derive/confounders.mjs');

describe('valueSetOf', () => {
  it('gives the JSON text of the sorted distinct non-null values and counts the NULL members, never dropping them', async () => {
    const { valueSetOf } = await mod();
    assert.deepEqual(valueSetOf([{ value: 'b', calls: 2 }, { value: 'a', calls: 1 }, { value: null, calls: 3 }, { value: 'b', calls: 1 }]),
      { value: '["a","b"]', unknown_calls: 3 });
    assert.deepEqual(valueSetOf([{ value: 'x', calls: 4 }]), { value: '["x"]', unknown_calls: 0 });
  });
  it('is NULL when no member is known, and unknown_calls is NULL when there is no row', async () => {
    const { valueSetOf } = await mod();
    assert.deepEqual(valueSetOf([{ value: null, calls: 2 }]), { value: null, unknown_calls: 2 });
    assert.deepEqual(valueSetOf([]), { value: null, unknown_calls: null });
  });
});

describe('workerModeOf', () => {
  const S = (session, worktree, subagent) => ({ session_id: session, worktree, subagent });
  it('worktree when a scope ran in a linked worktree; the count is worktree sessions plus subagent scopes', async () => {
    const { workerModeOf } = await mod();
    assert.deepEqual(workerModeOf([S('s1', 1, 0), S('s1', 1, 1)]), { mode: 'worktree', count: 2, subagents: 1 });
    assert.deepEqual(workerModeOf([S('s1', 1, 0), S('s2', 1, 0), S('s3', 0, 0)]), { mode: 'worktree', count: 2, subagents: 0 });
  });
  it('a subagent spawned with a worktree is a worktree scope (link_scope.worktree is 1 for it)', async () => {
    const { workerModeOf } = await mod();
    assert.deepEqual(workerModeOf([S('s1', 0, 0), S('s1', 1, 1)]), { mode: 'worktree', count: 2, subagents: 1 });
  });
  it('subagent when no worktree is seen but a subagent scope is attributed', async () => {
    const { workerModeOf } = await mod();
    assert.deepEqual(workerModeOf([S('s1', 0, 1)]), { mode: 'subagent', count: 1, subagents: 1 });
    assert.deepEqual(workerModeOf([S('s1', null, 1)]), { mode: 'subagent', count: 1, subagents: 1 });
  });
  it('inline when every scope resolved outside a linked worktree', async () => {
    const { workerModeOf } = await mod();
    assert.deepEqual(workerModeOf([S('s1', 0, 0), S('s2', 0, 0)]), { mode: 'inline', count: 0, subagents: 0 });
  });
  it('NULL (count NULL) with an unresolved cwd and no worktree seen; a worktree still wins over an unresolved cwd', async () => {
    const { workerModeOf } = await mod();
    assert.deepEqual(workerModeOf([S('s1', null, 0), S('s2', 0, 0)]), { mode: null, count: null, subagents: 0 });
    assert.deepEqual(workerModeOf([S('s1', null, 0), S('s2', 1, 0)]), { mode: 'worktree', count: 1, subagents: 0 });
  });
  it('no scope gives every value NULL', async () => {
    const { workerModeOf } = await mod();
    assert.deepEqual(workerModeOf([]), { mode: null, count: null, subagents: null });
  });
});

describe('envAt', () => {
  const snap = (run, taken, v) => ({ run_id: run, taken_utc: taken, gsd_version: v });
  const SNAPS = [snap(1, '2026-10-02T00:00:00.000Z', '9.9.1'), snap(3, '2026-10-06T00:00:00.000Z', '9.9.3'), snap(2, '2026-10-06T00:00:00.000Z', '9.9.2')];
  it('picks the latest snapshot taken at or before the start, ties by run id', async () => {
    const { envAt } = await mod();
    assert.equal(envAt(SNAPS, Date.parse('2026-10-03T00:00:00Z')).snapshot.gsd_version, '9.9.1');
    assert.equal(envAt(SNAPS, Date.parse('2026-10-02T00:00:00Z')).snapshot.gsd_version, '9.9.1', 'at counts');
    assert.equal(envAt(SNAPS, Date.parse('2026-10-07T00:00:00Z')).snapshot.gsd_version, '9.9.3', 'tie: the larger run id');
    assert.equal(envAt(SNAPS, Date.parse('2026-10-07T00:00:00Z')).source, 'env-snapshot');
  });
  it('never uses a later snapshot: before-first-snapshot and no-start', async () => {
    const { envAt } = await mod();
    assert.deepEqual(envAt(SNAPS, Date.parse('2026-10-01T00:00:00Z')), { snapshot: null, source: 'before-first-snapshot' });
    assert.deepEqual(envAt([], Date.parse('2026-10-01T00:00:00Z')), { snapshot: null, source: 'before-first-snapshot' });
    assert.deepEqual(envAt(SNAPS, null), { snapshot: null, source: 'no-start' });
  });
});

describe('CONFOUNDER_NAMES', () => {
  it("equals the names of schema's CONFOUNDER_NAME_SQL, in order", async () => {
    const { CONFOUNDER_NAMES } = await mod();
    const { CONFOUNDER_NAME_SQL } = await import('../../src/derive/schema.mjs');
    assert.deepEqual([...CONFOUNDER_NAMES], CONFOUNDER_NAME_SQL.split(',').map((x) => x.trim().replace(/'/g, '')));
  });
});
