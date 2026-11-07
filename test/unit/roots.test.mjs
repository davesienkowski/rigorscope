// Root discovery (D-03), unit level. Written before src/sources/transcript/roots.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome } from '../fixtures/build.mjs';

const load = () => import(new URL('../../src/sources/transcript/roots.mjs', import.meta.url).href);
const withProjects = (dir) => mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
const aliases = (res) => res.roots.map((r) => r.alias);

describe('roots module surface', () => {
  it('exports the environment variable name, a default Windows users directory and compareBytes', async () => {
    const m = await load();
    assert.equal(m.WINDOWS_USERS_ENV, 'RIGORSCOPE_WINDOWS_USERS_DIR');
    assert.equal(typeof m.DEFAULT_WINDOWS_USERS_DIR, 'string');
    assert.ok(m.DEFAULT_WINDOWS_USERS_DIR.startsWith('/'));
    assert.equal(typeof m.compareBytes, 'function');
    assert.equal(typeof m.discoverRoots, 'function');
  });

  it('compareBytes orders by UTF-8 bytes: uppercase before lowercase, and an astral name after a BMP name above U+E000', async () => {
    const { compareBytes } = await load();
    assert.ok(compareBytes('B', 'a') < 0);
    assert.ok(compareBytes('a', 'a') === 0);
    const bmp = '\uE000';
    const astral = '\u{1F600}';
    assert.ok(bmp > astral, 'UTF-16 unit order puts the astral name first');
    assert.ok(compareBytes(bmp, astral) < 0, 'byte order puts the astral name last');
  });
});

describe('discoverRoots', () => {
  it('returns no roots and an absent note for each default candidate on an empty HOME', async () => {
    const { discoverRoots } = await load();
    const ctx = makeHome();
    try {
      const res = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: '' });
      assert.deepEqual(res.roots, []);
      assert.deepEqual(res.skipped.map((s) => s.reason), ['absent', 'absent']);
    } finally {
      ctx.cleanup();
    }
  });

  it('ignores an empty or relative CLAUDE_CONFIG_DIR', async () => {
    const { discoverRoots } = await load();
    const ctx = makeHome();
    try {
      for (const v of ['', 'relative/dir']) {
        const res = await discoverRoots({ home: ctx.home, env: { CLAUDE_CONFIG_DIR: v }, windowsUsersDir: '' });
        assert.ok(!aliases(res).includes('env'), `value ${JSON.stringify(v)}`);
      }
    } finally {
      ctx.cleanup();
    }
  });

  it('never reads process.env: the env parameter is the only source', async () => {
    const { discoverRoots } = await load();
    const ctx = makeHome();
    const saved = process.env.CLAUDE_CONFIG_DIR;
    try {
      withProjects(join(ctx.home, 'sneaky'));
      process.env.CLAUDE_CONFIG_DIR = join(ctx.home, 'sneaky');
      const res = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: '' });
      assert.deepEqual(aliases(res), []);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
      ctx.cleanup();
    }
  });

  it('resolves a symlinked root once with realpath and drops the duplicate reached by another name', async () => {
    const { discoverRoots } = await load();
    const ctx = makeHome();
    try {
      withProjects(join(ctx.home, 'real'));
      symlinkSync(join(ctx.home, 'real'), join(ctx.home, '.claude'));
      const res = await discoverRoots({ home: ctx.home, env: { CLAUDE_CONFIG_DIR: join(ctx.home, 'real') }, windowsUsersDir: '' });
      assert.deepEqual(aliases(res), ['claude']);
      assert.ok(res.skipped.some((s) => s.reason === 'duplicate'));
    } finally {
      ctx.cleanup();
    }
  });

  it('numbers Windows profiles win, win-2, win-3 in bytewise order of the user directory name', async () => {
    const { discoverRoots } = await load();
    const ctx = makeHome();
    try {
      const win = join(ctx.home, 'w');
      for (const u of ['zed', 'Amy', 'bob']) withProjects(join(win, u, '.claude'));
      const res = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: win });
      assert.deepEqual(res.windowsUsers.map((w) => `${w.alias}:${w.user}`), ['win:Amy', 'win-2:bob', 'win-3:zed']);
      assert.deepEqual(res.roots.map((r) => r.display), ['~win/.claude', '~win-2/.claude', '~win-3/.claude']);
    } finally {
      ctx.cleanup();
    }
  });

  it('skips Windows entries that are symlinks or have no .claude/projects, without an error', async () => {
    const { discoverRoots } = await load();
    const ctx = makeHome();
    try {
      const win = join(ctx.home, 'w');
      withProjects(join(win, 'real', '.claude'));
      mkdirSync(join(win, 'Public'), { recursive: true });
      mkdirSync(join(win, 'noprojects', '.claude'), { recursive: true });
      mkdirSync(join(ctx.home, 'linktarget', '.claude', 'projects', 'p'), { recursive: true });
      symlinkSync(join(ctx.home, 'linktarget'), join(win, 'linked'));
      const res = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: win });
      assert.deepEqual(res.windowsUsers.map((w) => w.user), ['real']);
    } finally {
      ctx.cleanup();
    }
  });

  it('shows the env root as a fixed token and never an absolute path in any display string', async () => {
    const { discoverRoots } = await load();
    const ctx = makeHome();
    try {
      withProjects(join(ctx.home, 'cfg'));
      const res = await discoverRoots({ home: ctx.home, env: { CLAUDE_CONFIG_DIR: join(ctx.home, 'cfg') }, windowsUsersDir: '' });
      assert.equal(res.roots[0].display, '$CLAUDE_CONFIG_DIR');
      assert.equal(res.roots[0].alias, 'env');
    } finally {
      ctx.cleanup();
    }
  });

  it('derives aliases from position only, never from a user name', async () => {
    const { discoverRoots } = await load();
    const ctx = makeHome();
    try {
      const win = join(ctx.home, 'w');
      withProjects(join(win, 'alice', '.claude'));
      const res = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: win });
      assert.deepEqual(aliases(res), ['win']);
      assert.ok(!JSON.stringify(res.roots.map(({ alias, display, kind }) => ({ alias, display, kind }))).includes('alice'));
    } finally {
      ctx.cleanup();
    }
  });

  it('a candidate that is a file, not a directory, is skipped as no_projects', async () => {
    const { discoverRoots } = await load();
    const ctx = makeHome();
    try {
      writeFileSync(join(ctx.home, '.claude'), 'x');
      const res = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: '' });
      assert.deepEqual(res.roots, []);
      assert.ok(res.skipped.some((s) => s.display === '~/.claude' && ['no_projects', 'unreadable'].includes(s.reason)));
    } finally {
      ctx.cleanup();
    }
  });

  it('an absent Windows users directory is noted as skipped, not an error', async () => {
    const { discoverRoots } = await load();
    const ctx = makeHome();
    try {
      const res = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: join(ctx.home, 'nowhere') });
      assert.ok(res.skipped.some((s) => s.reason === 'absent' && s.display.startsWith('~win')));
    } finally {
      ctx.cleanup();
    }
  });

  it('an absent default Windows users directory (no env override) adds no skipped note; an explicit one still does', async () => {
    const { discoverRoots, WINDOWS_USERS_ENV } = await load();
    const ctx = makeHome();
    try {
      // The default is injected, so the result does not depend on whether the host has the default users directory.
      const absent = join(ctx.home, 'no-such-users-dir');
      const quiet = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: absent, defaultWindowsUsersDir: absent });
      assert.ok(!quiet.skipped.some((s) => s.display.startsWith('~win')));
      const loud = await discoverRoots({ home: ctx.home, env: { [WINDOWS_USERS_ENV]: absent }, windowsUsersDir: absent, defaultWindowsUsersDir: absent });
      assert.ok(loud.skipped.some((s) => s.reason === 'absent' && s.display.startsWith('~win')));
    } finally {
      ctx.cleanup();
    }
  });

  it('explicit roots replace discovery entirely', async () => {
    const { discoverRoots } = await load();
    const ctx = makeHome();
    try {
      withProjects(join(ctx.home, '.claude'));
      withProjects(join(ctx.home, 'mine'));
      const res = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: '', explicit: [join(ctx.home, 'mine')] });
      assert.deepEqual(aliases(res), ['extra-1']);
      assert.equal(res.roots[0].kind, 'explicit');
    } finally {
      ctx.cleanup();
    }
  });

  it('lists the backups directory of a root and HOME/.claude-backup only when present', async () => {
    const { discoverRoots } = await load();
    const ctx = makeHome();
    try {
      withProjects(join(ctx.home, '.claude'));
      const none = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: '' });
      assert.deepEqual(none.ignored, []);
      mkdirSync(join(ctx.home, '.claude', 'backups'));
      const one = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: '' });
      assert.deepEqual(one.ignored.map((i) => i.display), ['~/.claude/backups']);
    } finally {
      ctx.cleanup();
    }
  });
});
