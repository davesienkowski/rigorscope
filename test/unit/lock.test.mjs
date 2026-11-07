// The ingest lock file (D-13, DATA-04). Written before src/ingest/lock.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeHome, stateDirOf, cliEnv, REPO } from '../fixtures/build.mjs';

const LOCK = fileURLToPath(new URL('../../src/ingest/lock.mjs', import.meta.url));
const load = () => import(new URL('../../src/ingest/lock.mjs', import.meta.url).href);
const lockFile = (home) => join(stateDirOf(home), 'ingest.lock');
const plant = (home, content, ageSec = 0) => {
  mkdirSync(stateDirOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(lockFile(home), content, { mode: 0o600 });
  if (ageSec) {
    const t = new Date(Date.now() - ageSec * 1000);
    utimesSync(lockFile(home), t, t);
  }
};
const holder = (pid, extra = {}) => `${JSON.stringify({ pid, started_utc: '2026-10-27T00:00:00.000Z', proc_start: '', ...extra })}\n`;

describe('acquireLock and releaseLock', () => {
  it('lockPath is HOME/.rigorscope/ingest.lock', async () => {
    const { lockPath } = await load();
    assert.equal(lockPath('/x/h'), join('/x/h', '.rigorscope', 'ingest.lock'));
  });

  it('creates the lock exclusively with mode 0600 holding only pid, start time and process start token', async () => {
    const { acquireLock, releaseLock } = await load();
    const ctx = makeHome();
    try {
      const r = acquireLock({ home: ctx.home, now: () => new Date('2026-10-28T01:02:03.000Z') });
      assert.equal(r.acquired, true);
      assert.equal(lstatSync(lockFile(ctx.home)).mode & 0o777, 0o600);
      const body = JSON.parse(readFileSync(lockFile(ctx.home), 'utf8'));
      assert.deepEqual(Object.keys(body).sort(), ['pid', 'proc_start', 'started_utc']);
      assert.equal(body.pid, process.pid);
      assert.equal(body.started_utc, '2026-10-28T01:02:03.000Z');
      releaseLock(r.handle);
      assert.equal(existsSync(lockFile(ctx.home)), false);
    } finally {
      ctx.cleanup();
    }
  });

  it('refuses a live holder: acquired false, the holder named, the file untouched', async () => {
    const { acquireLock } = await load();
    const ctx = makeHome();
    try {
      plant(ctx.home, holder(4242));
      const before = readFileSync(lockFile(ctx.home), 'utf8');
      const r = acquireLock({ home: ctx.home, isAlive: (pid) => pid === 4242 });
      assert.equal(r.acquired, false);
      assert.equal(r.holder.pid, 4242);
      assert.equal(r.holder.started_utc, '2026-10-27T00:00:00.000Z');
      assert.equal(readFileSync(lockFile(ctx.home), 'utf8'), before);
    } finally {
      ctx.cleanup();
    }
  });

  it('takes over the lock of a dead process', async () => {
    const { acquireLock } = await load();
    const ctx = makeHome();
    try {
      plant(ctx.home, holder(4242));
      const r = acquireLock({ home: ctx.home, isAlive: () => false });
      assert.equal(r.acquired, true);
      assert.equal(JSON.parse(readFileSync(lockFile(ctx.home), 'utf8')).pid, process.pid);
    } finally {
      ctx.cleanup();
    }
  });

  it('takes over when the pid is alive but its process start token differs (pid reuse)', async () => {
    const { acquireLock } = await load();
    const ctx = makeHome();
    try {
      plant(ctx.home, holder(4242, { proc_start: 'OLD' }));
      const r = acquireLock({ home: ctx.home, isAlive: () => true, startToken: (pid) => (pid === 4242 ? 'NEW' : 'mine') });
      assert.equal(r.acquired, true);
      const held = acquireLock({ home: ctx.home, isAlive: () => true, startToken: () => 'mine' });
      assert.equal(held.acquired, false, 'now a live holder with a matching token');
    } finally {
      ctx.cleanup();
    }
  });

  it('treats empty or unparseable content as held when younger than 60 seconds and stale after', async () => {
    const { acquireLock } = await load();
    const ctx = makeHome();
    try {
      for (const junk of ['', 'not json at all']) {
        plant(ctx.home, junk, 5);
        assert.equal(acquireLock({ home: ctx.home, isAlive: () => false }).acquired, false, `young ${JSON.stringify(junk)}`);
        plant(ctx.home, junk, 120);
        const r = acquireLock({ home: ctx.home, isAlive: () => false });
        assert.equal(r.acquired, true, `old ${JSON.stringify(junk)}`);
        rmSync(lockFile(ctx.home), { force: true });
      }
    } finally {
      ctx.cleanup();
    }
  });

  it('releases only when the file carries the caller\'s pid', async () => {
    const { acquireLock, releaseLock } = await load();
    const ctx = makeHome();
    try {
      const r = acquireLock({ home: ctx.home });
      writeFileSync(lockFile(ctx.home), holder(31337));
      releaseLock(r.handle);
      assert.equal(existsSync(lockFile(ctx.home)), true, 'someone else\'s lock stays');
    } finally {
      ctx.cleanup();
    }
  });

  it('refuses a symlink at the lock path without writing through it', async () => {
    const { acquireLock } = await load();
    const ctx = makeHome();
    try {
      mkdirSync(stateDirOf(ctx.home), { recursive: true, mode: 0o700 });
      const victim = join(ctx.home, 'victim');
      writeFileSync(victim, 'untouched');
      symlinkSync(victim, lockFile(ctx.home));
      assert.throws(() => acquireLock({ home: ctx.home }), (err) => err.name === 'LockError');
      assert.equal(readFileSync(victim, 'utf8'), 'untouched');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('withLock', () => {
  it('runs the function with the lock held and releases it on success and on throw', async () => {
    const { withLock } = await load();
    const ctx = makeHome();
    try {
      const r = await withLock({ home: ctx.home }, async () => {
        assert.equal(existsSync(lockFile(ctx.home)), true);
        return 42;
      });
      assert.equal(r.acquired, true);
      assert.equal(r.value, 42);
      assert.equal(typeof r.waitedMs, 'number');
      assert.equal(existsSync(lockFile(ctx.home)), false);
      await assert.rejects(withLock({ home: ctx.home }, async () => { throw new Error('boom'); }), /boom/);
      assert.equal(existsSync(lockFile(ctx.home)), false);
    } finally {
      ctx.cleanup();
    }
  });

  it('does not run the function when a live holder has the lock', async () => {
    const { withLock } = await load();
    const ctx = makeHome();
    try {
      plant(ctx.home, holder(4242));
      let ran = false;
      const r = await withLock({ home: ctx.home, isAlive: () => true }, async () => { ran = true; });
      assert.equal(r.acquired, false);
      assert.equal(r.holder.pid, 4242);
      assert.equal(ran, false);
    } finally {
      ctx.cleanup();
    }
  });

  it('a child killed with SIGTERM while holding the lock releases it and exits 143', async () => {
    const ctx = makeHome();
    try {
      const script = `import(${JSON.stringify(LOCK)}).then(async (m) => { await m.withLock({ home: ${JSON.stringify(ctx.home)} }, () => { process.stdout.write('ready\\n'); return new Promise(() => setInterval(() => {}, 1000)); }); });`;
      const child = spawn(process.execPath, ['-e', script], { cwd: REPO, env: cliEnv(ctx.home) });
      await new Promise((resolve, reject) => {
        child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); });
        child.on('error', reject);
        child.on('exit', () => reject(new Error('lock holder exited before it was ready')));
      });
      assert.equal(existsSync(lockFile(ctx.home)), true);
      child.removeAllListeners('exit');
      const code = await new Promise((resolve) => { child.on('exit', (c) => resolve(c)); child.kill('SIGTERM'); });
      assert.equal(code, 143);
      assert.equal(existsSync(lockFile(ctx.home)), false);
    } finally {
      ctx.cleanup();
    }
  });
});

// Plan 01-11 (WR-04, T-01-14): a stale lock is taken over under a takeover guard that re-reads and re-judges
// the lock, so two processes that judged the same stale lock never both acquire it.
describe('stale-lock takeover under a guard', () => {
  const guardFile = (home) => `${lockFile(home)}.takeover`;
  const plantGuard = (home, content, ageMs = 0) => {
    mkdirSync(stateDirOf(home), { recursive: true, mode: 0o700 });
    writeFileSync(guardFile(home), content, { mode: 0o600 });
    if (ageMs) {
      const t = new Date(Date.now() - ageMs);
      utimesSync(guardFile(home), t, t);
    }
  };

  it('a rival that completes its takeover between the judgment and the guard wins; the caller does not touch its lock', async () => {
    const { acquireLock } = await load();
    const ctx = makeHome();
    try {
      plant(ctx.home, holder(777));
      const rival = holder(4242, { started_utc: '2026-10-28T00:00:00.000Z' });
      let seamCalls = 0;
      const r = acquireLock({
        home: ctx.home,
        isAlive: (pid) => pid === 4242,
        onJudgedStale: ({ path }) => { seamCalls += 1; rmSync(path, { force: true }); writeFileSync(path, rival, { mode: 0o600 }); },
      });
      assert.equal(seamCalls, 1);
      assert.equal(r.acquired, false);
      assert.equal(r.holder.pid, 4242);
      assert.equal(readFileSync(lockFile(ctx.home), 'utf8'), rival);
      assert.equal(existsSync(guardFile(ctx.home)), false, 'no guard left behind');
    } finally {
      ctx.cleanup();
    }
  });

  it('a plain stale lock, a reused pid and an old unparseable lock are still taken over, leaving no guard', async () => {
    const { acquireLock, releaseLock } = await load();
    const ctx = makeHome();
    try {
      const cases = [
        { content: holder(777), age: 0, opts: { isAlive: () => false } },
        { content: holder(4242, { proc_start: 'OLD' }), age: 0, opts: { isAlive: () => true, startToken: (pid) => (pid === 4242 ? 'NEW' : 'mine') } },
        { content: 'not json at all', age: 120, opts: { isAlive: () => false } },
      ];
      for (const [i, c] of cases.entries()) {
        plant(ctx.home, c.content, c.age);
        const r = acquireLock({ home: ctx.home, ...c.opts });
        assert.equal(r.acquired, true, `case ${i}`);
        assert.equal(existsSync(guardFile(ctx.home)), false, `case ${i}: no guard left behind`);
        releaseLock(r.handle);
      }
      plant(ctx.home, holder(4242));
      assert.equal(acquireLock({ home: ctx.home, isAlive: () => true }).acquired, false, 'a live holder still refuses');
      plant(ctx.home, '', 5);
      assert.equal(acquireLock({ home: ctx.home, isAlive: () => false }).acquired, false, 'a young unparseable lock still refuses');
      assert.equal(existsSync(guardFile(ctx.home)), false, 'no guard left behind after a refusal');
    } finally {
      ctx.cleanup();
    }
  });

  it('a leftover guard older than TAKEOVER_GUARD_MAX_AGE_MS is removed and the takeover proceeds', async () => {
    const { acquireLock, TAKEOVER_GUARD_MAX_AGE_MS } = await load();
    assert.equal(typeof TAKEOVER_GUARD_MAX_AGE_MS, 'number');
    const ctx = makeHome();
    try {
      plant(ctx.home, holder(777));
      plantGuard(ctx.home, '4242\n', TAKEOVER_GUARD_MAX_AGE_MS + 1000);
      const r = acquireLock({ home: ctx.home, isAlive: (pid) => pid === 4242 });
      assert.equal(r.acquired, true);
      assert.equal(JSON.parse(readFileSync(lockFile(ctx.home), 'utf8')).pid, process.pid);
      assert.equal(existsSync(guardFile(ctx.home)), false, 'no guard left behind');
    } finally {
      ctx.cleanup();
    }
  });

  it('a leftover guard held by a dead pid is removed and the takeover proceeds', async () => {
    const { acquireLock } = await load();
    const ctx = makeHome();
    try {
      plant(ctx.home, holder(777));
      plantGuard(ctx.home, '5151\n');
      const r = acquireLock({ home: ctx.home, isAlive: () => false });
      assert.equal(r.acquired, true);
      assert.equal(existsSync(guardFile(ctx.home)), false, 'no guard left behind');
    } finally {
      ctx.cleanup();
    }
  });

  it('a young guard of a live pid makes the caller back off without touching the lock or the guard', async () => {
    const { acquireLock } = await load();
    const ctx = makeHome();
    try {
      plant(ctx.home, holder(777));
      plantGuard(ctx.home, '4242\n');
      const lockBefore = readFileSync(lockFile(ctx.home), 'utf8');
      const r = acquireLock({ home: ctx.home, isAlive: (pid) => pid === 4242 });
      assert.equal(r.acquired, false);
      assert.equal(readFileSync(lockFile(ctx.home), 'utf8'), lockBefore);
      assert.equal(readFileSync(guardFile(ctx.home), 'utf8'), '4242\n', 'the rival guard is not ours to remove');
      rmSync(guardFile(ctx.home));
      assert.equal(existsSync(guardFile(ctx.home)), false);
    } finally {
      ctx.cleanup();
    }
  });

  it('eight processes contending for one stale lock, over 6 rounds, give exactly one ACQUIRED per round', async () => {
    const ROUNDS = 6;
    const CONTENDERS = 8;
    const GO_LEAD_MS = 100;
    const ctx = makeHome();
    const all = [];
    try {
      // A genuinely dead pid: a child that has already exited.
      const dead = spawn(process.execPath, ['-e', '0']);
      const deadPid = dead.pid;
      await new Promise((resolve) => { dead.on('exit', resolve); });
      // Handshake instead of sleeps, so load cannot reorder a round: each contender prints READY once its imports
      // are done, waits for "go <epoch-ms>" and attempts the lock at that instant, prints its verdict, and a winner
      // keeps the lock until stdin closes (the parent closes it only after all verdicts are in).
      const script = `
        import { createInterface } from 'node:readline';
        const m = await import(${JSON.stringify(LOCK)});
        const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
        process.stdout.write('READY\\n');
        const go = (await lines.next()).value;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(go.split(' ')[1]) - Date.now()));
        const r = m.acquireLock({ home: ${JSON.stringify(ctx.home)} });
        process.stdout.write(r.acquired ? 'ACQUIRED\\n' : 'HELD\\n');
        if (r.acquired) {
          await lines.next();
          m.releaseLock(r.handle);
        }
        process.exit(0);`;
      const contender = () => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO, env: cliEnv(ctx.home) });
        const lines = [];
        const waiters = [];
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            lines.push(buf.slice(0, i));
            buf = buf.slice(i + 1);
            while (waiters.length && lines.length >= waiters[0].n) waiters.shift().resolve();
          }
        });
        child.stdin.on('error', () => {});
        const exited = new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`contender exited ${code}`))));
        });
        const line = (n) => (lines.length >= n ? Promise.resolve(lines[n - 1]) : Promise.race([
          new Promise((resolve) => { waiters.push({ n, resolve: () => resolve(lines[n - 1]) }); }),
          exited.then(() => { throw new Error(`contender ended before line ${n}`); }),
        ]));
        exited.catch(() => {}); // a rejection nobody awaits yet is not an unhandled one
        all.push(child);
        return { child, line, exited };
      };
      for (let round = 0; round < ROUNDS; round += 1) {
        plant(ctx.home, holder(deadPid));
        const cs = Array.from({ length: CONTENDERS }, contender);
        await Promise.all(cs.map((c) => c.line(1)));
        const go = `go ${Date.now() + GO_LEAD_MS}\n`;
        for (const c of cs) c.child.stdin.write(go);
        const outs = await Promise.all(cs.map((c) => c.line(2)));
        for (const c of cs) c.child.stdin.end();
        await Promise.all(cs.map((c) => c.exited));
        const acquired = outs.filter((o) => o === 'ACQUIRED').length;
        assert.equal(acquired, 1, `round ${round}: ${outs.join(',')}`);
        assert.equal(outs.filter((o) => o === 'HELD').length, CONTENDERS - 1, `round ${round}`);
        assert.equal(existsSync(lockFile(ctx.home)), false, `round ${round}: the winner released the lock`);
        assert.equal(existsSync(guardFile(ctx.home)), false, `round ${round}: no guard left behind`);
      }
    } finally {
      for (const child of all) { child.stdin.destroy(); child.kill('SIGKILL'); } // a failed round must not strand children
      ctx.cleanup();
    }
  });
});
