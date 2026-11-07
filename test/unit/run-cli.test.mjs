// The spawned-CLI guard of test/fixtures/build.mjs (plan 01-11, WR-06). runCli has a default timeout and throws
// a diagnostic (status, signal, error code, stderr tail; never the argument list) whenever the child ended by
// a signal or the spawn reported an error, unless the caller passes allowSignal. runCliAsync is guarded the
// same way. So a killed or hung child can never yield a passing spawned-CLI test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../fixtures/build.mjs';

describe('runCli and runCliAsync guard', () => {
  it('a child killed by the timeout throws, and the message names the signal', () => {
    const ctx = B.makeHome();
    try {
      assert.throws(() => B.runCli(['ingest'], { home: ctx.home, timeoutMs: 1 }), (err) => /SIGKILL/.test(err.message));
    } finally {
      ctx.cleanup();
    }
  });

  it('with allowSignal the killed child returns a result that shows the kill', () => {
    const ctx = B.makeHome();
    try {
      const r = B.runCli(['ingest'], { home: ctx.home, timeoutMs: 1, allowSignal: true });
      assert.ok(r.signal === 'SIGKILL' || r.error?.code === 'ETIMEDOUT', 'the result shows the kill');
    } finally {
      ctx.cleanup();
    }
  });

  it('describeCliFailure builds the text from status, signal, error code and a truncated stderr tail', () => {
    assert.equal(typeof B.DEFAULT_CLI_TIMEOUT_MS, 'number');
    const long = `${'x'.repeat(5000)}TAIL`;
    const text = B.describeCliFailure({ status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' }, stderr: long });
    assert.match(text, /status=null/);
    assert.match(text, /signal=SIGKILL/);
    assert.match(text, /error=ETIMEDOUT/);
    assert.ok(text.endsWith('TAIL'), 'the stderr tail is kept');
    assert.ok(text.length < 2500, 'a long stderr is truncated');
    const plain = B.describeCliFailure({ status: 3, signal: null, stderr: 'boom\n' });
    assert.match(plain, /status=3/);
    assert.match(plain, /boom/);
  });

  it('a normal call returns the unchanged spawnSync result', () => {
    const ctx = B.makeHome();
    try {
      const r = B.runCli(['--help'], { home: ctx.home });
      assert.equal(r.status, 0);
      assert.equal(r.signal, null);
      assert.match(r.stdout, /usage: rigorscope/);
    } finally {
      ctx.cleanup();
    }
  });

  it('runCliAsync rejects when its child is killed, unless allowSignal is passed', async () => {
    const ctx = B.makeHome();
    try {
      await assert.rejects(
        B.runCliAsync(['ingest'], { home: ctx.home, onChild: (c) => c.kill('SIGKILL') }),
        (err) => /SIGKILL/.test(err.message),
      );
      const r = await B.runCliAsync(['ingest'], { home: ctx.home, allowSignal: true, onChild: (c) => c.kill('SIGKILL') });
      assert.equal(r.signal, 'SIGKILL');
      const ok = await B.runCliAsync(['--help'], { home: ctx.home });
      assert.equal(ok.status, 0);
    } finally {
      ctx.cleanup();
    }
  });
});
