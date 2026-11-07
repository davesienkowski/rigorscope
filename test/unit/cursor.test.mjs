// Cursor identity and the start-offset decision (DATA-03, TRUST-05). Written before
// src/ingest/cursor.mjs. Large values are fed through stubbed stat results.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const load = () => import(new URL('../../src/ingest/cursor.mjs', import.meta.url).href);
const scratch = () => mkdtempSync(join(tmpdir(), 'rigorscope-cursor-'));
const stat = (o) => () => ({
  isFile: () => true, isSymbolicLink: () => false, dev: 7n, ino: 9n, size: 10n, mtimeNs: 5_000_000_000n, ...o,
});
const stored = (o = {}) => ({
  dev: '7', ino: '9', size: 100, offset: 100, head_hash: 'H', tail_hash: 'T', state: 'ok', ...o,
});
const cur = (o = {}) => ({ dev: '7', ino: '9', size: 100, mtimeMs: 1, ...o });
const same = { head: 'H', tail: 'T' };

describe('statIdentity', () => {
  it('reads device and inode as BigInt-derived text, size as a number and mtime truncated to whole milliseconds', async () => {
    const { statIdentity } = await load();
    const r = statIdentity('ignored', { lstat: stat({ dev: 2n ** 40n + 1n, ino: 2n ** 60n + 1n, size: 2n ** 33n + 5n, mtimeNs: 1_234_567_890_123_456_789n }) });
    assert.equal(r.dev, String(2n ** 40n + 1n));
    assert.equal(r.ino, '1152921504606846977');
    assert.equal(r.size, 2 ** 33 + 5);
    assert.equal(r.mtimeMs, 1_234_567_890_123);
    assert.equal(typeof r.dev, 'string');
  });

  it('rejects a directory and a symlink with a typed error', async () => {
    const { statIdentity } = await load();
    const d = scratch();
    try {
      writeFileSync(join(d, 'f'), 'x');
      symlinkSync(join(d, 'f'), join(d, 'l'));
      mkdirSync(join(d, 'sub'));
      for (const name of ['sub', 'l']) {
        assert.throws(() => statIdentity(join(d, name)), (err) => err.code === 'ERR_NOT_REGULAR', name);
      }
      assert.equal(statIdentity(join(d, 'f')).size, 1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('agrees with an independent BigInt stat of a real file', async () => {
    const { statIdentity } = await load();
    const d = scratch();
    try {
      const f = join(d, 'f');
      writeFileSync(f, 'hello world');
      const mine = statIdentity(f);
      const ref = lstatSync(f, { bigint: true });
      assert.equal(mine.ino, String(ref.ino));
      assert.equal(mine.dev, String(ref.dev));
      assert.equal(mine.size, 11);
      assert.equal(mine.mtimeMs, Number(ref.mtimeNs / 1_000_000n));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('propagates ENOENT for a vanished file', async () => {
    const { statIdentity } = await load();
    assert.throws(() => statIdentity(join(tmpdir(), 'rigorscope-no-such-file-xyz')), (err) => err.code === 'ENOENT');
  });
});

describe('windowHash', () => {
  it('is the first 32 hex characters of the sha256 of the bytes in [start, end)', async () => {
    const { windowHash, HASH_WINDOW } = await load();
    assert.equal(HASH_WINDOW, 4096);
    const d = scratch();
    try {
      const f = join(d, 'f');
      writeFileSync(f, 'abcdefghij');
      const want = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);
      assert.equal(windowHash(f, 0, 10), want('abcdefghij'));
      assert.equal(windowHash(f, 2, 5), want('cde'));
      assert.equal(windowHash(f, 0, 0), want(''));
      assert.equal(windowHash(f, 8, 50), want('ij'), 'a window past the end hashes the available bytes');
      assert.match(windowHash(f, 0, 3), /^[0-9a-f]{32}$/);
      assert.notEqual(windowHash(f, 0, 3), windowHash(f, 1, 4));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('decideStart', () => {
  it('starts a file with no stored cursor at 0 as new', async () => {
    const { decideStart } = await load();
    assert.deepEqual({ ...decideStart(null, cur(), same) }, { start: 0, reason: 'new' });
  });

  it('keeps the stored offset when nothing changed', async () => {
    const { decideStart } = await load();
    assert.deepEqual({ ...decideStart(stored(), cur(), same) }, { start: 100, reason: 'unchanged' });
  });

  it('keeps the stored offset and reads on when the file grew', async () => {
    const { decideStart } = await load();
    assert.deepEqual({ ...decideStart(stored(), cur({ size: 150 }), same) }, { start: 100, reason: 'appended' });
  });

  it('re-reads from 0 when the size fell below the stored offset', async () => {
    const { decideStart } = await load();
    assert.deepEqual({ ...decideStart(stored(), cur({ size: 40 }), same) }, { start: 0, reason: 'truncated' });
  });

  it('re-reads from 0 when the device or the inode changed', async () => {
    const { decideStart } = await load();
    assert.deepEqual({ ...decideStart(stored(), cur({ ino: '10' }), same) }, { start: 0, reason: 'replaced' });
    assert.deepEqual({ ...decideStart(stored(), cur({ dev: '8' }), same) }, { start: 0, reason: 'replaced' });
  });

  it('re-reads from 0 when the head hash or the tail hash differs', async () => {
    const { decideStart } = await load();
    assert.deepEqual({ ...decideStart(stored(), cur(), { head: 'X', tail: 'T' }) }, { start: 0, reason: 'rewritten' });
    assert.deepEqual({ ...decideStart(stored(), cur(), { head: 'H', tail: 'X' }) }, { start: 0, reason: 'rewritten' });
  });

  it('resumes a file whose last run stopped mid-way even when the size is unchanged', async () => {
    const { decideStart } = await load();
    const r = decideStart(stored({ offset: 60, state: 'reading' }), cur(), same);
    assert.deepEqual({ ...r }, { start: 60, reason: 'appended' });
  });

  it('accepts lazy hash functions and does not call them when the answer is already known', async () => {
    const { decideStart } = await load();
    let calls = 0;
    const lazy = { head: () => { calls += 1; return 'H'; }, tail: () => { calls += 1; return 'T'; } };
    assert.equal(decideStart(null, cur(), lazy).reason, 'new');
    assert.equal(decideStart(stored(), cur({ ino: '1' }), lazy).reason, 'replaced');
    assert.equal(decideStart(stored(), cur({ size: 1 }), lazy).reason, 'truncated');
    assert.equal(calls, 0);
    assert.equal(decideStart(stored(), cur(), lazy).reason, 'unchanged');
    assert.equal(calls, 2);
  });

  it('round-trips an offset above 2^32 and compares an inode above 2^53 as text', async () => {
    const { decideStart } = await load();
    const big = 2 ** 33 + 12345;
    const ino = String(2n ** 60n + 1n);
    const s = stored({ size: big, offset: big, ino });
    assert.deepEqual({ ...decideStart(s, cur({ size: big, ino }), same) }, { start: big, reason: 'unchanged' });
    assert.deepEqual({ ...decideStart(s, cur({ size: big + 7, ino }), same) }, { start: big, reason: 'appended' });
    assert.equal(decideStart(s, cur({ size: big, ino: String(2n ** 60n + 2n) }), same).reason, 'replaced');
  });

  it('treats a stored cursor without a state field as complete', async () => {
    const { decideStart } = await load();
    const { state: _s, ...bare } = stored();
    assert.equal(decideStart(bare, cur(), same).reason, 'unchanged');
  });

  it('an empty stored file (offset 0, size 0) that stays empty is unchanged', async () => {
    const { decideStart } = await load();
    const r = decideStart(stored({ size: 0, offset: 0 }), cur({ size: 0 }), same);
    assert.deepEqual({ ...r }, { start: 0, reason: 'unchanged' });
  });
});

describe('readLinesFrom (the line framing the cursor advances over)', () => {
  const loadLines = () => import(new URL('../../src/ingest/lines.mjs', import.meta.url).href);
  async function collect(file, start, opts) {
    const { readLinesFrom } = await loadLines();
    const out = [];
    for (const it of readLinesFrom(file, start, opts)) out.push(it);
    return out;
  }
  const withFile = async (content, fn) => {
    const d = scratch();
    try {
      const f = join(d, 'f.jsonl');
      writeFileSync(f, content);
      return await fn(f);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };

  it('yields complete lines with end offsets that include the newline, and reports the partial tail', async () => {
    await withFile('one\ntwo\npart', async (f) => {
      const stats = {};
      const got = await collect(f, 0, { stats });
      assert.deepEqual(got.map((g) => [g.buf.toString(), g.end]), [['one', 4], ['two', 8]]);
      assert.equal(stats.pendingTailBytes, 4);
    });
  });

  it('strips CR, so CRLF and LF files give identical lines', async () => {
    await withFile('a\r\nb\r\n', async (f) => {
      assert.deepEqual((await collect(f, 0)).map((g) => g.buf.toString()), ['a', 'b']);
    });
  });

  it('strips a UTF-8 BOM at offset 0 only', async () => {
    await withFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\ny\n')]), async (f) => {
      assert.equal((await collect(f, 0))[0].buf.toString(), 'x');
      assert.equal((await collect(f, 5))[0].buf.toString(), 'y');
    });
  });

  it('starts at the given offset and finds a line that spans chunk boundaries (chunkBytes 7)', async () => {
    await withFile('aaaaaaaaaaaaaaaaaaaa\nbb\n', async (f) => {
      const got = await collect(f, 0, { chunkBytes: 7 });
      assert.deepEqual(got.map((g) => g.buf.toString()), ['aaaaaaaaaaaaaaaaaaaa', 'bb']);
      assert.deepEqual((await collect(f, 21, { chunkBytes: 7 })).map((g) => g.buf.toString()), ['bb']);
    });
  });

  it('yields an oversized marker with the head bytes and the size, never the whole line', async () => {
    await withFile(`${'A'.repeat(5000)}\nok\n`, async (f) => {
      const got = await collect(f, 0, { maxLineBytes: 1000, chunkBytes: 300 });
      assert.equal(got[0].oversized, true);
      assert.equal(got[0].size, 5000);
      assert.ok(got[0].head.length <= 512);
      assert.equal(got[1].buf.toString(), 'ok');
    });
  });

  it('reads the bytes appended after a first pass when called again from the stored offset', async () => {
    await withFile('first\n', async (f) => {
      const a = await collect(f, 0);
      writeFileSync(f, 'first\nsecond\n');
      const b = await collect(f, a[a.length - 1].end);
      assert.deepEqual(b.map((g) => g.buf.toString()), ['second']);
    });
  });
});
