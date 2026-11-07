// Root discovery and the nested walk, against real directory trees under temporary HOMEs. Imports
// only the fixtures and the walk, roots and home modules; the tracer test at the end runs the CLI.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLANTS, buildFixtureTree, makeHome, mangleHome, queryDb, runCli, stateDirOf, windowsUsersDirFor, writeJsonl,
} from '../fixtures/build.mjs';

import { loadSources } from '../../src/ingest/sources.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
// The sources line lists every registered source (plan 01-03 added otel), so it is derived from the registry.
const SOURCES = (await loadSources()).map((s) => s.name).join(',');
const S3 = '33333333-3333-4333-8333-333333333333';

async function walkCase(caseId) {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases: [caseId] });
  const { walkRoot } = await mod('sources/transcript/walk.mjs');
  const { buildHomeSet } = await mod('sources/transcript/home.mjs');
  const homeSet = buildHomeSet({ home: ctx.home, windowsUsers: [] });
  const res = await walkRoot({ alias: 'claude', path: ctx.root }, { homeSet });
  return { ctx, res };
}

const projectsWith = (root, names) => {
  for (const n of names) mkdirSync(join(root, 'projects', n), { recursive: true });
};

describe('walkRoot', () => {
  it('finds the session, sub-agent, nested workflow sub-agent files and their metas, with normalized relative paths', async () => {
    const { ctx, res } = await walkCase('subagents');
    try {
      const rows = res.units.map((u) => `${u.kind}:${u.rel}`);
      assert.deepEqual(rows, [
        `session:~-repos-agents/${S3}.jsonl`,
        `subagent:~-repos-agents/${S3}/subagents/agent-agentaaaa00000001.jsonl`,
        `meta:~-repos-agents/${S3}/subagents/agent-agentaaaa00000001.meta.json`,
        `subagent:~-repos-agents/${S3}/subagents/workflows/wf_0001/agent-agentbbbb00000002.jsonl`,
        `meta:~-repos-agents/${S3}/subagents/workflows/wf_0001/agent-agentbbbb00000002.meta.json`,
      ]);
      const sub = res.units.find((u) => u.kind === 'subagent' && u.agentId === 'agentbbbb00000002');
      assert.equal(sub.sessionId, S3);
      assert.equal(sub.rootAlias, 'claude');
    } finally {
      ctx.cleanup();
    }
  });

  it('skips the journal, non-agent names and symlinks and counts them by reason; nothing outside projects is read', async () => {
    const { ctx, res } = await walkCase('subagents');
    try {
      assert.deepEqual({ ...res.skipped }, { journal: 1, name: 1, symlink: 2 });
      const all = JSON.stringify(res.units);
      for (const leak of ['leak', 'credentials', 'backups', 'tool-results', 'stray', 'notes', 'journal']) {
        assert.ok(!all.includes(leak), `unit list mentions ${leak}`);
      }
    } finally {
      ctx.cleanup();
    }
  });

  it('counts a path deeper than the cap under depth and does not list it; an empty file is still a session unit', async () => {
    const { ctx, res } = await walkCase('hostile');
    try {
      assert.deepEqual({ ...res.skipped }, { depth: 1 });
      assert.deepEqual(res.units.map((u) => u.rel).sort(), [
        '~-repos-hostile/66666666-6666-4666-8666-666666666666.jsonl', '~-repos-hostile/empty.jsonl',
      ]);
      const { MAX_WALK_DEPTH } = await mod('sources/transcript/walk.mjs');
      assert.equal(MAX_WALK_DEPTH, 8);
    } finally {
      ctx.cleanup();
    }
  });

  it('visits entries in bytewise order whatever the creation order, so the unit order is total', async () => {
    const ctx = makeHome();
    try {
      for (const name of ['p-b', 'p-a', 'p-B', 'p-_']) {
        writeJsonl(join(ctx.root, 'projects', name, 'z.jsonl'), []);
        writeJsonl(join(ctx.root, 'projects', name, 'a.jsonl'), []);
      }
      const { walkRoot, } = await mod('sources/transcript/walk.mjs');
      const { buildHomeSet } = await mod('sources/transcript/home.mjs');
      const res = await walkRoot({ alias: 'claude', path: ctx.root }, { homeSet: buildHomeSet({ home: ctx.home, windowsUsers: [] }) });
      const rels = res.units.map((u) => u.rel);
      const sorted = [...rels].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      assert.deepEqual(rels, sorted);
      assert.equal(new Set(rels).size, rels.length, 'a relative path is unique within a root');
      assert.equal(rels[0], 'p-B/a.jsonl', 'uppercase sorts before lowercase and underscore');
    } finally {
      ctx.cleanup();
    }
  });

  it('treats a symlinked projects directory as no projects and a root without projects as nothing to walk', async () => {
    const ctx = makeHome();
    try {
      mkdirSync(join(ctx.home, 'elsewhere', 'real-proj'), { recursive: true });
      writeJsonl(join(ctx.home, 'elsewhere', 'real-proj', 's.jsonl'), []);
      mkdirSync(ctx.root, { recursive: true });
      symlinkSync(join(ctx.home, 'elsewhere'), join(ctx.root, 'projects'));
      const { walkRoot } = await mod('sources/transcript/walk.mjs');
      const { buildHomeSet } = await mod('sources/transcript/home.mjs');
      const res = await walkRoot({ alias: 'claude', path: ctx.root }, { homeSet: buildHomeSet({ home: ctx.home, windowsUsers: [] }) });
      assert.deepEqual(res.units, []);
      assert.equal(res.noProjects, true);
    } finally {
      ctx.cleanup();
    }
  });

  it('never puts an absolute path or the OS user name in a unit relative path', async () => {
    const { ctx, res } = await walkCase('cwd-forms');
    try {
      for (const u of res.units) {
        assert.ok(!u.rel.includes(PLANTS.osUser), 'user name in rel');
        assert.ok(!u.rel.startsWith('/'), 'absolute rel');
      }
      assert.equal(res.units[0].rel, '~-repos-cwd/77777777-7777-4777-8777-777777777777.jsonl');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('discoverRoots', () => {
  const setup = (names) => {
    const ctx = makeHome();
    for (const n of names) projectsWith(join(ctx.home, n), ['p']);
    return ctx;
  };

  it('lists roots in alias order: claude, claude-contrib, env, then Windows profiles win, win-2', async () => {
    const ctx = setup(['.claude', '.claude-contrib', 'envdir']);
    try {
      const win = windowsUsersDirFor(ctx.home);
      projectsWith(join(win, 'u2', '.claude'), ['p']);
      projectsWith(join(win, 'u1', '.claude'), ['p']);
      const { discoverRoots } = await mod('sources/transcript/roots.mjs');
      const res = await discoverRoots({
        home: ctx.home, env: { CLAUDE_CONFIG_DIR: join(ctx.home, 'envdir') }, windowsUsersDir: win,
      });
      assert.deepEqual(res.roots.map((r) => r.alias), ['claude', 'claude-contrib', 'env', 'win', 'win-2']);
      assert.deepEqual(res.windowsUsers.map((w) => `${w.alias}:${w.user}`), ['win:u1', 'win-2:u2']);
      for (const r of res.roots) {
        assert.ok(!r.display.includes(ctx.home), `display of ${r.alias} holds an absolute path`);
        assert.ok(!r.display.includes(PLANTS.osUser), `display of ${r.alias} holds the user name`);
      }
    } finally {
      ctx.cleanup();
    }
  });

  it('drops a CLAUDE_CONFIG_DIR that is a duplicate of an existing root and notes it', async () => {
    const ctx = setup(['.claude']);
    try {
      const { discoverRoots } = await mod('sources/transcript/roots.mjs');
      const res = await discoverRoots({
        home: ctx.home, env: { CLAUDE_CONFIG_DIR: join(ctx.home, '.claude') }, windowsUsersDir: '',
      });
      assert.deepEqual(res.roots.map((r) => r.alias), ['claude']);
      assert.ok(res.skipped.some((s) => s.reason === 'duplicate'));
    } finally {
      ctx.cleanup();
    }
  });

  it('skips a candidate without a projects directory and a missing one, with a reason each', async () => {
    const ctx = makeHome();
    try {
      mkdirSync(join(ctx.home, '.claude'), { recursive: true });
      const { discoverRoots } = await mod('sources/transcript/roots.mjs');
      const res = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: '' });
      assert.deepEqual(res.roots, []);
      const reasons = Object.fromEntries(res.skipped.map((s) => [s.display, s.reason]));
      assert.equal(reasons['~/.claude'], 'no_projects');
      assert.equal(reasons['~/.claude-contrib'], 'absent');
    } finally {
      ctx.cleanup();
    }
  });

  it('lists the ignored backup directories of each root without reading them', async () => {
    const ctx = setup(['.claude']);
    try {
      mkdirSync(join(ctx.home, '.claude', 'backups'), { recursive: true });
      mkdirSync(join(ctx.home, '.claude-backup'), { recursive: true });
      const { discoverRoots } = await mod('sources/transcript/roots.mjs');
      const res = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: '' });
      const shown = res.ignored.map((i) => i.display).sort();
      assert.deepEqual(shown, ['~/.claude-backup', '~/.claude/backups']);
    } finally {
      ctx.cleanup();
    }
  });

  it('skips an unreadable Windows users directory and treats the empty string as disabled', async () => {
    const ctx = setup(['.claude']);
    try {
      const notADir = join(ctx.home, 'a-file');
      writeFileSync(notADir, 'x');
      const { discoverRoots } = await mod('sources/transcript/roots.mjs');
      const res = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: notADir });
      assert.deepEqual(res.roots.map((r) => r.alias), ['claude']);
      assert.ok(res.skipped.some((s) => s.reason === 'unreadable'));
      const off = await discoverRoots({ home: ctx.home, env: {}, windowsUsersDir: '' });
      assert.ok(!off.skipped.some((s) => s.display.startsWith('~win')));
    } finally {
      ctx.cleanup();
    }
  });

  it('explicit roots replace discovery and take the alias of a matching discovered root or extra-N', async () => {
    const ctx = setup(['.claude', 'other']);
    try {
      const { discoverRoots } = await mod('sources/transcript/roots.mjs');
      const res = await discoverRoots({
        home: ctx.home, env: {}, windowsUsersDir: '', explicit: [join(ctx.home, 'other'), join(ctx.home, '.claude')],
      });
      assert.deepEqual(res.roots.map((r) => r.alias).sort(), ['claude', 'extra-1']);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('discovery tracer (CLI, no flags)', () => {
  it('ingests every root, the nested files and metas, and a second run reads 0 bytes and changes nothing but the run log', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['tracer-base', 'subagents', 'backup-root', 'cwd-forms'] });
      const first = runCli(['ingest'], { home: ctx.home });
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, new RegExp(`^ingest: roots=3 sources=${SOURCES}$`, 'm'));
      const db = join(stateDirOf(ctx.home), 'store.db');
      const keys = (sql) => queryDb(db, sql);
      const before = keys('SELECT count(*) AS n FROM cc_message')[0].n;
      assert.ok(before > 10);
      const mid = keys('SELECT count(*) AS n FROM source_file WHERE kind = \'meta\'')[0].n;
      assert.equal(mid, 2);
      const second = runCli(['ingest'], { home: ctx.home });
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /^transcript: .*\bnew=0\b.*\bbytes=0\b.*\blines=0\b/m);
      assert.equal(keys('SELECT count(*) AS n FROM cc_message')[0].n, before);
      assert.equal(keys('SELECT count(*) AS n FROM ingest_run')[0].n, 2);
      assert.equal(mangleHome(ctx.home).length > 0, true);
    } finally {
      ctx.cleanup();
    }
  });
});
