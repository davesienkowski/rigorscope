// The cache pick and reader (plan 01-06, D-11a, T-01-50 to T-01-54). Written before the code. A guard Proxy
// proves the pick reads only the allowlisted key paths; the reader is exercised on temporary files removed by
// exact path. No failure message holds a planted value.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CACHE_ALLOW, MS, SNAPSHOTS, USAGE_NEEDLES, cacheFileObject, guarded, writeUsageCache,
} from '../fixtures/usage-cache.mjs';
import { leakyCachePick } from '../canary/leaky-usage-pick.mjs';
import {
  CACHE_DISPLAY, CACHE_FILE_NAME, CACHE_PICK, MAX_CACHE_BYTES, pickUsageCache, readUsageCache,
} from '../../src/sources/usage/cache.mjs';

const NO_WINDOWS = { five_hour: null, seven_day: null, seven_day_opus: null, seven_day_sonnet: null };
const rejectedOf = (res) => Object.fromEntries((res.rejected ?? []).map((r) => [r.path, r.n]));
const leaked = (text) => USAGE_NEEDLES.filter((n) => text.includes(n)).length;

// A cache object built from parts (no plants needed for shape tests).
const cacheWith = (utilization, fetchedAtMs = MS.h09) => ({ cachedUsageUtilization: { fetchedAtMs, utilization } });
const win = (utilization, resets_at = '2026-10-26T13:00:00Z') => ({ utilization, resets_at });
const fhOf = (res) => res.snapshot?.windows?.five_hour ?? null;

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'rigorscope-usage-unit-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// Hand-computed snapshot E: windows 5 / 18:00, 51 / Oct 31, opus 12 / Oct 31, sonnet null; limits without severity.
const SNAPSHOT_E = {
  fetchedAtMs: MS.h17,
  windows: {
    five_hour: { pct: 5, resetsMs: MS.h18 },
    seven_day: { pct: 51, resetsMs: MS.oct31 },
    seven_day_opus: { pct: 12, resetsMs: MS.oct31 },
    seven_day_sonnet: null,
  },
  limits: [
    { kind: 'session', grp: 'all', percent: 5, resetsMs: MS.h18, severity: null, isActive: 1 },
    { kind: 'weekly_all', grp: 'all', percent: 51, resetsMs: MS.oct31, severity: null, isActive: 0 },
    { kind: 'weekly_scoped', grp: 'opus', percent: 12, resetsMs: MS.oct31, severity: null, isActive: 0 },
  ],
};

describe('pickUsageCache: the allowlist pick', () => {
  it('reads only the allowlisted paths of the hostile file E (guard proxy) and returns the hand-computed snapshot', () => {
    const { proxy, violations } = guarded(cacheFileObject(SNAPSHOTS.E), CACHE_ALLOW);
    const res = pickUsageCache(proxy);
    assert.deepEqual(violations, []);
    assert.equal(res.status, 'ok');
    assert.deepEqual(res.snapshot, SNAPSHOT_E);
    assert.deepEqual(res.rejected, []);
  });

  it('passes the guard on file A too (null per-model windows, empty limits)', () => {
    const { proxy, violations } = guarded(cacheFileObject(SNAPSHOTS.A), CACHE_ALLOW);
    const res = pickUsageCache(proxy);
    assert.deepEqual(violations, []);
    assert.deepEqual(res.snapshot, {
      fetchedAtMs: MS.h09,
      windows: { ...NO_WINDOWS, five_hour: { pct: 10, resetsMs: MS.h13 }, seven_day: { pct: 40, resetsMs: MS.oct31 } },
      limits: [],
    });
  });

  it('the guard has teeth: the leaking stub trips it', () => {
    const { proxy, violations } = guarded(cacheFileObject(SNAPSHOTS.E), CACHE_ALLOW);
    let threw = false;
    try { leakyCachePick(proxy); } catch { threw = true; }
    assert.ok(threw || violations.length > 0);
    assert.ok(violations.length > 0, 'a forbidden read or enumeration was recorded');
  });

  it('the leaking stub, unguarded, would carry the plants into a stored column', () => {
    const res = leakyCachePick(cacheFileObject(SNAPSHOTS.E));
    assert.ok(leaked(res.snapshot.limits[0].kind) > 0);
  });

  for (const [title, value, ok] of [
    ['0', 0, true], ['100', 100, true], ['12.5', 12.5, true], ['101', 101, false], ['-1', -1, false],
    ['-0.0001', -0.0001, false], ['the string 12', '12', false], ['NaN', Number.NaN, false], ['Infinity', Number.POSITIVE_INFINITY, false],
    ['true', true, false],
  ]) {
    it(`percent ${title} is ${ok ? 'kept' : 'rejected with its path'}`, () => {
      const res = pickUsageCache(cacheWith({ five_hour: win(value) }));
      assert.equal(res.status, 'ok');
      if (ok) assert.deepEqual(fhOf(res), { pct: value, resetsMs: MS.h13 });
      else {
        assert.equal(fhOf(res), null);
        assert.deepEqual(rejectedOf(res), { 'utilization.five_hour.utilization': 1 });
      }
    });
  }

  it('Z, +00:00 and +05:30 spellings of one instant normalize to the same epoch milliseconds; fractions are kept', () => {
    for (const s of ['2026-10-26T13:00:00Z', '2026-10-26T13:00:00+00:00', '2026-10-26T18:30:00+05:30', '2026-10-26T08:00:00-05:00']) {
      assert.deepEqual(fhOf(pickUsageCache(cacheWith({ five_hour: win(1, s) }))), { pct: 1, resetsMs: MS.h13 }, s);
    }
    assert.equal(fhOf(pickUsageCache(cacheWith({ five_hour: win(1, '2026-10-26T13:00:00.250Z') }))).resetsMs, MS.h13 + 250);
  });

  for (const bad of ['not a date', '2026-10-26T25:00:00Z', '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-10-26T13:00:00',
    '1999-12-31T23:59:59Z', '2101-01-01T00:00:00Z', '2026-10-26 13:00:00Z', '2026-10-26T13:00:00+24:00', 1793019600000]) {
    it(`resets_at ${JSON.stringify(bad)} is rejected with its path`, () => {
      const res = pickUsageCache(cacheWith({ five_hour: win(10, bad) }));
      assert.equal(fhOf(res), null);
      assert.deepEqual(rejectedOf(res), { 'utilization.five_hour.resets_at': 1 });
    });
  }

  it('a JSON null window is absent and not rejected; a non-object window is rejected', () => {
    const a = pickUsageCache(cacheWith({ five_hour: null, seven_day: win(4, '2026-10-31T00:00:00Z') }));
    assert.deepEqual(a.rejected, []);
    assert.deepEqual(a.snapshot.windows, { ...NO_WINDOWS, seven_day: { pct: 4, resetsMs: MS.oct31 } });
    const b = pickUsageCache(cacheWith({ five_hour: 7 }));
    assert.equal(fhOf(b), null);
    assert.ok(b.rejected.length >= 1);
  });

  it('per-model windows are picked when non-null', () => {
    const res = pickUsageCache(cacheWith({ seven_day_opus: win(12, '2026-10-31T00:00:00Z'), seven_day_sonnet: win(3, '2026-10-31T00:00:00Z') }));
    assert.deepEqual(res.snapshot.windows, {
      ...NO_WINDOWS, seven_day_opus: { pct: 12, resetsMs: MS.oct31 }, seven_day_sonnet: { pct: 3, resetsMs: MS.oct31 },
    });
  });

  it('limits: at most 16 entries kept, the overflow counted under utilization.limits', () => {
    const limits = Array.from({ length: 20 }, (_, i) => ({ kind: `k${i}`, percent: i, resets_at: '2026-10-31T00:00:00Z', is_active: false }));
    const res = pickUsageCache(cacheWith({ limits }));
    assert.equal(res.snapshot.limits.length, 16);
    assert.equal(res.snapshot.limits[15].kind, 'k15');
    assert.deepEqual(rejectedOf(res), { 'utilization.limits': 4 });
  });

  it('limit kind: an email shape, upper case and 49 characters are dropped and counted; 48 characters are kept', () => {
    const k48 = `a${'b'.repeat(47)}`;
    const mk = (kind) => ({ kind, percent: 1, resets_at: '2026-10-31T00:00:00Z' });
    const res = pickUsageCache(cacheWith({ limits: [mk('x@y.invalid'), mk('Session'), mk(`${k48}c`), mk(k48), mk(7)] }));
    assert.deepEqual(res.snapshot.limits.map((l) => l.kind), [k48]);
    assert.deepEqual(rejectedOf(res), { 'utilization.limits[].kind': 4 });
  });

  it('limit group: a failing group is NULL and counted, an absent group is NULL and not counted; is_active non-boolean NULL', () => {
    const base = { kind: 'session', percent: 1, resets_at: '2026-10-31T00:00:00Z' };
    const res = pickUsageCache(cacheWith({ limits: [{ ...base, group: 'Bad Group' }, { ...base }, { ...base, group: 'all', is_active: 'yes' }] }));
    assert.deepEqual(res.snapshot.limits.map((l) => [l.grp, l.isActive]), [[null, null], [null, null], ['all', null]]);
    assert.deepEqual(rejectedOf(res), { 'utilization.limits[].group': 1, 'utilization.limits[].is_active': 1 });
  });

  it('limit percent and resets_at are required: a bad one drops the entry with its path', () => {
    const res = pickUsageCache(cacheWith({ limits: [{ kind: 'a', percent: 101, resets_at: '2026-10-31T00:00:00Z' }, { kind: 'b', percent: 1, resets_at: 'x' }] }));
    assert.deepEqual(res.snapshot.limits, []);
    assert.deepEqual(rejectedOf(res), { 'utilization.limits[].percent': 1, 'utilization.limits[].resets_at': 1 });
  });

  it('a non-array limits value is rejected and an empty array stores no limit', () => {
    assert.deepEqual(rejectedOf(pickUsageCache(cacheWith({ limits: { 0: 1 } }))), { 'utilization.limits': 1 });
    const empty = pickUsageCache(cacheWith({ limits: [] }));
    assert.deepEqual(empty.snapshot.limits, []);
    assert.deepEqual(empty.rejected, []);
  });

  for (const [title, v, ok] of [
    ['the lower bound 946684800000', 946684800000, true], ['the upper bound 4102444800000', 4102444800000, true],
    ['946684799999', 946684799999, false], ['4102444800001', 4102444800001, false], ['a float', 1793005200000.5, false],
    ['a string', '1793005200000', false], ['null', null, false],
  ]) {
    it(`fetchedAtMs ${title} is ${ok ? 'accepted' : 'rejected with status rejected'}`, () => {
      const res = pickUsageCache(cacheWith({}, v));
      if (ok) {
        assert.equal(res.status, 'ok');
        assert.equal(res.snapshot.fetchedAtMs, v);
      } else {
        assert.equal(res.status, 'rejected');
        assert.equal(res.snapshot, null);
        assert.deepEqual(rejectedOf(res), { fetchedAtMs: 1 });
      }
    });
  }

  it('no_cache for a missing, null, array or scalar cache and for a non-object root', () => {
    for (const root of [{}, { cachedUsageUtilization: null }, { cachedUsageUtilization: [1] }, { cachedUsageUtilization: 3 }, [], null, 7, 'x']) {
      const res = pickUsageCache(root);
      assert.equal(res.status, 'no_cache');
      assert.equal(res.snapshot, null);
    }
  });

  it('CACHE_PICK names only the D-11a paths, each with a table and column, and is frozen', () => {
    assert.ok(Object.isFrozen(CACHE_PICK));
    for (const e of CACHE_PICK) {
      assert.ok(typeof e.path === 'string' && typeof e.table === 'string' && typeof e.column === 'string');
      assert.ok(!/severity|scope|dollar|spend|extra_usage|account|email/.test(e.path), e.path);
      assert.ok(e.path === 'fetchedAtMs' || e.path.startsWith('utilization.'), e.path);
    }
    assert.ok(CACHE_PICK.some((e) => e.path === 'utilization.limits[].kind'));
    assert.equal(CACHE_FILE_NAME, '.claude.json');
    assert.equal(CACHE_DISPLAY, '~/.claude.json');
    assert.equal(MAX_CACHE_BYTES, 16 * 1024 * 1024);
  });
});

describe('readUsageCache: the read-only reader', () => {
  const read = (home, opts = {}) => readUsageCache({ home, ...opts });
  const check = (home, res) => {
    const text = JSON.stringify(res);
    assert.equal(leaked(text), 0, 'no plant in the result');
    assert.ok(!text.includes(home), 'no path in the result');
  };

  it('reads the file A into an ok snapshot and reports the bytes read', () => {
    const t = tempHome();
    try {
      const file = writeUsageCache(t.home, SNAPSHOTS.A);
      const res = read(t.home);
      assert.equal(res.status, 'ok');
      assert.equal(res.opened, true);
      assert.equal(res.snapshot.fetchedAtMs, MS.h09);
      assert.ok(res.bytes > 0 && res.bytes === Buffer.byteLength(JSON.stringify(cacheFileObject(SNAPSHOTS.A))), file && 'bytes');
      check(t.home, res);
    } finally {
      t.cleanup();
    }
  });

  it('an absent file is absent and not opened', () => {
    const t = tempHome();
    try {
      const res = read(t.home);
      assert.deepEqual([res.status, res.opened, res.bytes, res.snapshot], ['absent', false, 0, null]);
    } finally {
      t.cleanup();
    }
  });

  it('a directory and a symlink at the path are not_regular', () => {
    const t = tempHome();
    try {
      mkdirSync(join(t.home, '.claude.json'));
      assert.equal(read(t.home).status, 'not_regular');
      rmSync(join(t.home, '.claude.json'), { recursive: true });
      writeFileSync(join(t.home, 'target.json'), JSON.stringify(cacheFileObject(SNAPSHOTS.A)));
      symlinkSync(join(t.home, 'target.json'), join(t.home, '.claude.json'));
      const res = read(t.home);
      assert.equal(res.status, 'not_regular');
      assert.equal(res.snapshot, null);
      check(t.home, res);
    } finally {
      t.cleanup();
    }
  });

  it('a file over the cap is oversized with nothing read', () => {
    const t = tempHome();
    try {
      writeUsageCache(t.home, SNAPSHOTS.A);
      const res = read(t.home, { maxBytes: 64 });
      assert.deepEqual([res.status, res.opened, res.bytes, res.snapshot], ['oversized', true, 0, null]);
    } finally {
      t.cleanup();
    }
  });

  it('an unreadable file is unreadable', { skip: process.getuid?.() === 0 }, () => {
    const t = tempHome();
    try {
      const file = writeUsageCache(t.home, SNAPSHOTS.A);
      chmodSync(file, 0o000);
      const res = read(t.home);
      chmodSync(file, 0o644);
      assert.equal(res.status, 'unreadable');
      check(t.home, res);
    } finally {
      t.cleanup();
    }
  });

  it('unparseable text holding the plants is unparseable and the result holds no byte of it', () => {
    const t = tempHome();
    try {
      writeUsageCache(t.home, null, { raw: `{"a":"${USAGE_NEEDLES[0]}","b":"${USAGE_NEEDLES[1]}"` });
      const res = read(t.home);
      assert.equal(res.status, 'unparseable');
      assert.ok(res.bytes > 0);
      check(t.home, res);
    } finally {
      t.cleanup();
    }
  });

  it('a UTF-8 BOM is stripped before parsing', () => {
    const t = tempHome();
    try {
      writeUsageCache(t.home, SNAPSHOTS.A, { bom: true });
      assert.equal(read(t.home).status, 'ok');
    } finally {
      t.cleanup();
    }
  });

  it('the pick seam replaces pickUsageCache', () => {
    const t = tempHome();
    try {
      writeUsageCache(t.home, SNAPSHOTS.A);
      const res = read(t.home, { pick: () => ({ status: 'ok', snapshot: { fetchedAtMs: 1, windows: NO_WINDOWS, limits: [] }, rejected: [] }) });
      assert.equal(res.snapshot.fetchedAtMs, 1);
    } finally {
      t.cleanup();
    }
  });

  it('every reader result serializes without a plant, a path or a system error text', () => {
    const t = tempHome();
    try {
      const results = [read(t.home)];
      writeUsageCache(t.home, SNAPSHOTS.E);
      results.push(read(t.home), read(t.home, { maxBytes: 10 }));
      writeUsageCache(t.home, null, { raw: `[${USAGE_NEEDLES.map((n) => JSON.stringify(n)).join(',')}` });
      results.push(read(t.home));
      for (const r of results) {
        check(t.home, r);
        assert.ok(!/ENOENT|EACCES|ELOOP|Unexpected|JSON/.test(JSON.stringify(r)));
      }
    } finally {
      t.cleanup();
    }
  });
});
