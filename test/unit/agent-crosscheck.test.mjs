// Plan 01-07 Task 2: the COST-06 agent-name cross-check (D-06). Written before src/derive/agent-xcheck.mjs (RED).
// classifyAgentName({ joined, agentName, transcriptRole }) checks, in order: not_joined, no_name, custom,
// no_transcript_role, agree, disagree. The OTel agent name is compared byte for byte with the transcript-derived
// role and never becomes a role. tallyXcheck(states) counts every state (0 when absent) plus compared.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { XCHECK_STATES, classifyAgentName, tallyXcheck } = await import(new URL('../../src/derive/agent-xcheck.mjs', import.meta.url).href);
const c = (joined, agentName, transcriptRole) => classifyAgentName({ joined, agentName, transcriptRole });
const ZERO = {
  agree: 0, disagree: 0, custom: 0, no_name: 0, no_transcript_role: 0, not_joined: 0, compared: 0,
};

describe('XCHECK_STATES', () => {
  it('lists the six states in print order, frozen', () => {
    assert.deepEqual([...XCHECK_STATES], ['agree', 'disagree', 'custom', 'no_name', 'no_transcript_role', 'not_joined']);
    assert.ok(Object.isFrozen(XCHECK_STATES));
  });
});

describe('classifyAgentName', () => {
  it('an equal name agrees', () => {
    assert.equal(c(true, 'Explore', 'Explore'), 'agree');
  });

  it('a different name disagrees (transcript fork, OTel general-purpose)', () => {
    assert.equal(c(true, 'general-purpose', 'fork'), 'disagree');
  });

  it('a request that joined no transcript call is not_joined, whatever the name and role', () => {
    assert.equal(c(false, 'Explore', 'Explore'), 'not_joined');
    assert.equal(c(false, null, null), 'not_joined');
    assert.equal(c(undefined, 'custom', 'x'), 'not_joined');
  });

  it('no name (null, undefined or empty) is no_name before custom and the role check', () => {
    for (const n of [null, undefined, '']) assert.equal(c(true, n, null), 'no_name');
    assert.equal(c(true, null, 'Explore'), 'no_name');
  });

  it('the literal custom is custom, even when the transcript role is missing or is custom', () => {
    assert.equal(c(true, 'custom', null), 'custom');
    assert.equal(c(true, 'custom', 'custom'), 'custom');
    assert.equal(c(true, 'Custom', 'gsd-executor'), 'disagree', 'only the exact literal');
  });

  it('a missing transcript role (null, undefined or empty) is no_transcript_role', () => {
    for (const r of [null, undefined, '']) assert.equal(c(true, 'claude-code-guide', r), 'no_transcript_role');
  });

  it('case differs: Explore and explore disagree', () => {
    assert.equal(c(true, 'explore', 'Explore'), 'disagree');
  });

  it('a trailing space disagrees: nothing is trimmed', () => {
    assert.equal(c(true, 'Explore ', 'Explore'), 'disagree');
    assert.equal(c(true, 'Explore', 'Explore '), 'disagree');
  });

  it('a decomposed and a precomposed accented name disagree: nothing is normalized', () => {
    assert.equal(c(true, 'café', 'café'), 'disagree');
    assert.equal(c(true, 'café', 'café'), 'agree');
  });

  it('a non-string name counts as no name', () => {
    assert.equal(c(true, 7, 'Explore'), 'no_name');
    assert.equal(c(true, {}, 'Explore'), 'no_name');
  });
});

describe('tallyXcheck', () => {
  it('an empty list counts every state 0 and compared 0, a real count over no requests', () => {
    assert.deepEqual({ ...tallyXcheck([]) }, ZERO);
  });

  it('the otel-join fixture tallies to compared=2 agree=1 disagree=1 custom=1 no_name=2 no_transcript_role=1 not_joined=9', () => {
    const states = ['no_name', 'agree', 'disagree', 'no_transcript_role', 'custom', 'no_name', ...Array(9).fill('not_joined')];
    assert.deepEqual({ ...tallyXcheck(states) }, {
      agree: 1, disagree: 1, custom: 1, no_name: 2, no_transcript_role: 1, not_joined: 9, compared: 2,
    });
  });

  it('compared is agree plus disagree and never counts custom, no_name or not_joined', () => {
    const t = tallyXcheck(['custom', 'no_name', 'not_joined', 'no_transcript_role']);
    assert.equal(t.compared, 0);
    assert.equal(tallyXcheck(['agree', 'agree', 'disagree']).compared, 3);
  });

  it('an unknown state throws instead of being counted', () => {
    assert.throws(() => tallyXcheck(['agree', 'maybe']), RangeError);
    assert.throws(() => tallyXcheck([null]), RangeError);
  });

  it('the tally does not depend on the order of the states', () => {
    const s = ['agree', 'not_joined', 'disagree', 'custom', 'not_joined'];
    assert.deepEqual({ ...tallyXcheck(s) }, { ...tallyXcheck([...s].reverse()) });
  });
});
