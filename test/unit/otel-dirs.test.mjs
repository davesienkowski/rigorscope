// OTel directory resolution and listing (plan 01-03, D-03, T-01-27). Everything is a parameter (home, env);
// the module never reads process.env or os.homedir, and never opens a file for reading.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome } from '../fixtures/build.mjs';

let D;
const ready = async () => {
  D = await import('../../src/sources/otel/dirs.mjs');
};

const touch = (p, text = '{}\n') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };

describe('file name rule', () => {
  it('OTEL_FILE_RE matches only events-YYYY-MM-DD.jsonl and metrics-YYYY-MM-DD.jsonl', async () => {
    await ready();
    for (const n of ['events-2026-10-27.jsonl', 'metrics-2026-01-01.jsonl']) assert.ok(D.OTEL_FILE_RE.test(n), n);
    for (const n of ['events-2026-10-27.jsonl.bak', 'logs-2026-10-27.jsonl', 'events-2026-1-27.jsonl', 'events-2026-10-27.json',
      '.events-2026-10-27.jsonl', 'events-2026-10-27.jsonl\n', 'reports', '../events-2026-10-27.jsonl']) {
      assert.equal(D.OTEL_FILE_RE.test(n), false, n);
    }
  });
});

describe('directory resolution', () => {
  it('liveDir is HOOK_TELEMETRY_DIR when absolute and the home default otherwise', async () => {
    await ready();
    assert.equal(D.liveDir('/h', { HOOK_TELEMETRY_DIR: '/alt/dir' }), '/alt/dir');
    assert.equal(D.liveDir('/h', {}), join('/h', '.local', 'share', 'hook-telemetry'));
    assert.equal(D.liveDir('/h', { HOOK_TELEMETRY_DIR: 'relative/dir' }), join('/h', '.local', 'share', 'hook-telemetry'));
    assert.equal(D.liveDir('/h', { HOOK_TELEMETRY_DIR: '' }), join('/h', '.local', 'share', 'hook-telemetry'));
    assert.equal(D.liveDir('/h', undefined), join('/h', '.local', 'share', 'hook-telemetry'));
  });

  it('preserveDir is fixed below the home', async () => {
    await ready();
    assert.equal(D.preserveDir('/h'), join('/h', '.local', 'share', 'rigorscope', 'preserve', 'hook-telemetry'));
  });
});

describe('root discovery', () => {
  it('returns the existing directories as roots, live first, with kinds and tilde display strings', async () => {
    await ready();
    const ctx = makeHome();
    try {
      mkdirSync(D.liveDir(ctx.home, {}), { recursive: true });
      mkdirSync(D.preserveDir(ctx.home), { recursive: true });
      const res = D.discoverOtelRoots({ home: ctx.home, env: {} });
      assert.deepEqual(res.roots.map((r) => [r.alias, r.kind, r.display]), [
        ['live', 'live', '~/.local/share/hook-telemetry'],
        ['preserve', 'preserve', '~/.local/share/rigorscope/preserve/hook-telemetry'],
      ]);
      for (const r of res.roots) assert.ok(!r.display.includes(ctx.home));
      assert.deepEqual(res.skipped, []);
    } finally {
      ctx.cleanup();
    }
  });

  it('an absent default live directory is not_configured; an absent HOOK_TELEMETRY_DIR override stays absent', async () => {
    await ready();
    const ctx = makeHome();
    try {
      const dflt = D.discoverOtelRoots({ home: ctx.home, env: {} });
      assert.equal(dflt.skipped.find((s) => s.alias === 'live').reason, 'not_configured');
      const over = D.discoverOtelRoots({ home: ctx.home, env: { HOOK_TELEMETRY_DIR: join(ctx.home, 'nowhere') } });
      assert.equal(over.skipped.find((s) => s.alias === 'live').reason, 'absent');
    } finally {
      ctx.cleanup();
    }
  });

  it('a missing directory goes to skipped with reason absent', async () => {
    await ready();
    const ctx = makeHome();
    try {
      const res = D.discoverOtelRoots({ home: ctx.home, env: {} });
      assert.deepEqual(res.roots, []);
      assert.deepEqual(res.skipped.map((s) => [s.alias, s.reason]), [['live', 'not_configured'], ['preserve', 'absent']]);
    } finally {
      ctx.cleanup();
    }
  });

  it('an absolute HOOK_TELEMETRY_DIR replaces the live default and is displayed as the literal $HOOK_TELEMETRY_DIR', async () => {
    await ready();
    const ctx = makeHome();
    try {
      const alt = join(ctx.home, 'elsewhere');
      mkdirSync(alt, { recursive: true });
      const res = D.discoverOtelRoots({ home: ctx.home, env: { HOOK_TELEMETRY_DIR: alt } });
      assert.equal(res.roots.length, 1);
      assert.equal(res.roots[0].display, '$HOOK_TELEMETRY_DIR');
      assert.ok(res.roots[0].path.endsWith('elsewhere'));
    } finally {
      ctx.cleanup();
    }
  });

  it('a symlinked root is resolved once with realpath and still discovered', async () => {
    await ready();
    const ctx = makeHome();
    try {
      const real = join(ctx.home, 'real-live');
      mkdirSync(real, { recursive: true });
      mkdirSync(join(ctx.home, '.local', 'share'), { recursive: true });
      symlinkSync(real, D.liveDir(ctx.home, {}));
      const res = D.discoverOtelRoots({ home: ctx.home, env: {} });
      assert.equal(res.roots.length, 1);
      assert.ok(res.roots[0].path.endsWith('real-live'));
      assert.equal(res.roots[0].display, '~/.local/share/hook-telemetry');
    } finally {
      ctx.cleanup();
    }
  });

  it('a path that is a file is skipped, not a root', async () => {
    await ready();
    const ctx = makeHome();
    try {
      touch(D.liveDir(ctx.home, {}), 'x');
      const res = D.discoverOtelRoots({ home: ctx.home, env: {} });
      assert.deepEqual(res.roots, []);
      assert.ok(res.skipped.some((s) => s.alias === 'live' && s.reason !== 'absent'));
    } finally {
      ctx.cleanup();
    }
  });
});

describe('file listing', () => {
  it('lists regular matching files in bytewise order and reports skips by reason: name, symlink, not_regular', async () => {
    await ready();
    const ctx = makeHome();
    try {
      const dir = join(ctx.home, 'dir');
      for (const n of ['metrics-2026-10-27.jsonl', 'events-2026-10-27.jsonl', 'events-2026-10-09.jsonl']) touch(join(dir, n));
      touch(join(dir, 'notes.txt'));
      touch(join(dir, 'reports', 'events-2026-10-01.jsonl'));
      symlinkSync(join(dir, 'events-2026-10-27.jsonl'), join(dir, 'events-2026-10-28.jsonl'));
      mkdirSync(join(dir, 'metrics-2026-10-26.jsonl'));
      const res = D.listOtelFiles(dir);
      assert.deepEqual(res.files.map((f) => f.name), ['events-2026-10-09.jsonl', 'events-2026-10-27.jsonl', 'metrics-2026-10-27.jsonl']);
      assert.deepEqual(res.skipped, { name: 2, symlink: 1, not_regular: 1 });
      for (const f of res.files) assert.equal(f.abs, join(dir, f.name));
    } finally {
      ctx.cleanup();
    }
  });

  it('never reads file contents: an unreadable file is still listed', async () => {
    await ready();
    const ctx = makeHome();
    try {
      const f = join(ctx.home, 'd', 'events-2026-10-27.jsonl');
      touch(f);
      chmodSync(f, 0o000);
      assert.deepEqual(D.listOtelFiles(join(ctx.home, 'd')).files.map((x) => x.name), ['events-2026-10-27.jsonl']);
      chmodSync(f, 0o600);
    } finally {
      ctx.cleanup();
    }
  });

  it('an empty directory lists nothing and a missing directory lists nothing without throwing', async () => {
    await ready();
    const ctx = makeHome();
    try {
      mkdirSync(join(ctx.home, 'empty'));
      assert.deepEqual(D.listOtelFiles(join(ctx.home, 'empty')), { files: [], skipped: {} });
      assert.deepEqual(D.listOtelFiles(join(ctx.home, 'nope')), { files: [], skipped: {} });
    } finally {
      ctx.cleanup();
    }
  });
});
