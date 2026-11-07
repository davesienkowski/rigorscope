// Plan 01-04 Task 2: role precedence from transcript data (COST-02). Written before src/derive/role.mjs.
// resolveRole({ attribution, metaType, agentId }) -> { role, rule, source, meta, conflict }
//   attribution (non-empty) > meta agent_type (non-empty, for a non-empty agent id) > main (agent id '') > unknown
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { resolveRole } = await import(new URL('../../src/derive/role.mjs', import.meta.url).href);
const role = (attribution, metaType, agentId) => ({ ...resolveRole({ attribution, metaType, agentId }) });
const R = (r, rule, source, meta, conflict) => ({ role: r, rule, source, meta, conflict });

describe('resolveRole precedence', () => {
  it('resolveRole: attribution beats meta and flags the conflict when they differ', () => {
    assert.deepEqual(role('fork', 'general-purpose', 'agent1'), R('fork', 'attribution', 'transcript', 'general-purpose', 1));
  });

  it('attribution equal to meta is not a conflict (conflict 0)', () => {
    assert.deepEqual(role('gsd-verifier', 'gsd-verifier', 'agent1'), R('gsd-verifier', 'attribution', 'transcript', 'gsd-verifier', 0));
  });

  it('attribution without a meta row leaves meta and conflict null', () => {
    assert.deepEqual(role('gsd-executor', null, 'agent1'), R('gsd-executor', 'attribution', 'transcript', null, null));
  });

  it('meta agent type is used when the line has no attribution', () => {
    assert.deepEqual(role(null, 'Explore', 'agent1'), R('Explore', 'meta', 'transcript', 'Explore', null));
  });

  it('a main-thread line (agent id empty) with no attribution is main, derived', () => {
    assert.deepEqual(role(null, null, ''), R('main', 'main', 'derived', null, null));
  });

  it('a main-thread line with an attribution still takes the attribution', () => {
    assert.deepEqual(role('custom-agent', null, ''), R('custom-agent', 'attribution', 'transcript', null, null));
  });

  it('a sub-agent with neither attribution nor meta is unknown, unavailable', () => {
    assert.deepEqual(role(null, null, 'agent1'), R('unknown', 'none', 'unavailable', null, null));
  });

  it('an empty-string attribution counts as absent, so meta wins', () => {
    assert.deepEqual(role('', 'Explore', 'agent1'), R('Explore', 'meta', 'transcript', 'Explore', null));
  });

  it('an empty-string meta type counts as absent', () => {
    assert.deepEqual(role(null, '', 'agent1'), R('unknown', 'none', 'unavailable', null, null));
  });

  it('meta is not used for a main-thread line', () => {
    assert.deepEqual(role(null, 'Explore', ''), R('main', 'main', 'derived', 'Explore', null));
  });
});

describe('resolveRole edge values', () => {
  for (const agentId of [undefined, null]) {
    it(`an agent id of ${agentId} is never main`, () => {
      assert.deepEqual(role(null, null, agentId), R('unknown', 'none', 'unavailable', null, null));
      assert.deepEqual(role(null, 'Explore', agentId), R('unknown', 'none', 'unavailable', 'Explore', null));
    });
  }

  it('compares names byte-exactly: Explore and explore conflict, with no case folding', () => {
    assert.deepEqual(role('Explore', 'explore', 'agent1'), R('Explore', 'attribution', 'transcript', 'explore', 1));
  });

  it('applies no trimming: a padded name is kept as given and differs from the bare one', () => {
    assert.deepEqual(role(' fork', 'fork', 'agent1'), R(' fork', 'attribution', 'transcript', 'fork', 1));
  });

  it('returns a fresh plain object and never reads anything but its three inputs', () => {
    const a = resolveRole({ attribution: 'x', metaType: null, agentId: 'a' });
    const b = resolveRole({ attribution: 'x', metaType: null, agentId: 'a' });
    assert.notEqual(a, b);
    assert.deepEqual(Object.keys(a).sort(), ['conflict', 'meta', 'role', 'rule', 'source']);
    assert.deepEqual({ ...resolveRole({}) }, R('unknown', 'none', 'unavailable', null, null));
  });
});
