// Prohibition (plan 01-11, DATA-04, T-01-14): the ingest lock MUST NOT go to two holders. A stale-lock takeover
// must re-check, under the takeover guard, that the lock is still the stale one before it unlinks anything.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names the lock module under test, resolved against process.cwd();
// unset means src/ingest/lock.mjs. test/prohibitions/fixtures/blind-unlink-lock.mjs (the pre-fix algorithm)
// must fail this test; test/prohibitions/fixtures/current-lock.mjs (re-exports the real module) must pass it.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeHome, stateDirOf } from '../fixtures/build.mjs';

const DEFAULT_SUBJECT = fileURLToPath(new URL('../../src/ingest/lock.mjs', import.meta.url));
const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : DEFAULT_SUBJECT;
const record = (pid, started) => `${JSON.stringify({ pid, started_utc: started, proc_start: '' })}\n`;

it('a rival takeover completed between the stale judgment and the takeover is never undone', async () => {
  const { acquireLock } = await import(pathToFileURL(subject).href);
  const ctx = makeHome();
  try {
    const lock = join(stateDirOf(ctx.home), 'ingest.lock');
    mkdirSync(stateDirOf(ctx.home), { recursive: true, mode: 0o700 });
    writeFileSync(lock, record(777, '2026-10-27T00:00:00.000Z'), { mode: 0o600 });
    const rival = record(4242, '2026-10-28T00:00:00.000Z');
    const r = acquireLock({
      home: ctx.home,
      isAlive: (pid) => pid === 4242,
      onJudgedStale: ({ path }) => { rmSync(path, { force: true }); writeFileSync(path, rival, { mode: 0o600 }); },
    });
    assert.equal(r.acquired, false, 'the lock went to a second holder');
    assert.equal(readFileSync(lock, 'utf8'), rival, 'the rival lock was replaced');
  } finally {
    ctx.cleanup();
  }
});
