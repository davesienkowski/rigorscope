// DATA-02: ingest writes only under HOME/.rigorscope, never touches a source, and refuses a symlinked
// state directory or lock path without writing through it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { buildFixtureTree, makeHome, runCli, sha256, stateDirOf } from '../fixtures/build.mjs';
import { commitAll, makeRepo, writeQuickDir } from '../fixtures/git-repo.mjs';

// Snapshot of a whole tree without following links: type, size, mtime and (for files outside the
// state directory) content hash.
function snapshot(dir, skip = '.rigorscope') {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p);
      const st = lstatSync(p);
      const inState = rel === skip || rel.startsWith(`${skip}/`);
      out[rel] = {
        type: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file',
        size: st.size,
        mtimeMs: Math.trunc(st.mtimeMs),
        hash: !inState && st.isFile() ? sha256(readFileSync(p)) : null,
      };
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p);
    }
  };
  walk(dir);
  return out;
}

describe('state directory and sources', () => {
  it('ingest changes nothing outside HOME/.rigorscope: sources are byte-identical and mtime-identical', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: 'all' });
      const before = snapshot(ctx.home);
      const r = runCli(['ingest'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      const after = snapshot(ctx.home);
      const outside = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== '.rigorscope' && !k.startsWith('.rigorscope/')));
      const b = outside(before);
      const a = outside(after);
      assert.deepEqual(Object.keys(a), Object.keys(b), 'no path created or removed outside the state directory');
      for (const k of Object.keys(b)) {
        if (b[k].type === 'dir') continue; // a directory mtime changes only if entries change; names were compared above
        assert.deepEqual(a[k], b[k], `source changed: ${k}`);
      }
      assert.ok(Object.keys(after).some((k) => k.startsWith('.rigorscope/')), 'the state directory exists');
    } finally {
      ctx.cleanup();
    }
  });

  it('creates the state directory with mode 0700 and the database files with 0600, leaving no lock or temp file', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['tracer-base'] });
      assert.equal(runCli(['ingest'], { home: ctx.home }).status, 0);
      const dir = stateDirOf(ctx.home);
      assert.equal(lstatSync(dir).mode & 0o777, 0o700);
      for (const n of readdirSync(dir)) assert.equal(lstatSync(join(dir, n)).mode & 0o777, 0o600, n);
      assert.ok(!existsSync(join(dir, 'ingest.lock')));
      assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp') || n.endsWith('.lock')), []);
    } finally {
      ctx.cleanup();
    }
  });

  it('after a second ingest the HOME tree differs from the first only in the database files and their sidecars', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['tracer-base', 'subagents'] });
      assert.equal(runCli(['ingest'], { home: ctx.home }).status, 0);
      const first = snapshot(ctx.home);
      assert.ok(first['.rigorscope/store.db'], 'the first ingest created the store');
      runCli(['ingest'], { home: ctx.home });
      const second = snapshot(ctx.home);
      assert.deepEqual(Object.keys(second), Object.keys(first), 'same set of paths');
      const changed = Object.keys(second).filter((k) => JSON.stringify(second[k]) !== JSON.stringify(first[k]) && second[k].type === 'file');
      for (const k of changed) assert.ok(k.startsWith('.rigorscope/store.db'), `unexpected change: ${k}`);
    } finally {
      ctx.cleanup();
    }
  });

  it('refuses a symlinked state directory with exit 1 and writes nothing through it', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['tracer-base'] });
      const target = join(ctx.home, 'elsewhere');
      mkdirSync(target, { recursive: true });
      symlinkSync(target, stateDirOf(ctx.home));
      const r = runCli(['ingest'], { home: ctx.home });
      assert.equal(r.status, 1);
      assert.deepEqual(readdirSync(target), [], 'nothing written through the link');
      assert.ok(!r.stderr.includes(ctx.home), 'the message holds no path');
    } finally {
      ctx.cleanup();
    }
  });

  it('refuses a symlinked lock path without writing through it', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['tracer-base'] });
      mkdirSync(stateDirOf(ctx.home), { recursive: true, mode: 0o700 });
      const victim = join(ctx.home, 'victim.txt');
      writeFileSync(victim, 'untouched');
      symlinkSync(victim, join(stateDirOf(ctx.home), 'ingest.lock'));
      const r = runCli(['ingest'], { home: ctx.home });
      assert.equal(r.status, 1, r.stdout);
      assert.equal(readFileSync(victim, 'utf8'), 'untouched');
    } finally {
      ctx.cleanup();
    }
  });

  it('on a HOME with no Claude config directory ingest exits 0 with roots=0, one ok run and only HOME/.rigorscope created', () => {
    const ctx = makeHome();
    try {
      const before = readdirSync(ctx.home).sort();
      const r = runCli(['ingest'], { home: ctx.home });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^ingest: roots=0 /m);
      assert.deepEqual(readdirSync(ctx.home).sort(), [...before, '.rigorscope'].sort());
    } finally {
      ctx.cleanup();
    }
  });

  // Plan 03-01 (D-12 puts ingest in plan 03-03): unit-start and unit-close open no database and create no other state.
  it('ledger commands create only the ledger directory: no store.db, derived.db, lock or temp file, and no stray file in HOME', () => {
    const ctx = makeHome();
    try {
      const repo = makeRepo(join(ctx.home, 'repos', 'alpha'), { home: ctx.home, files: { 'README.md': 'x\n' } });
      writeQuickDir(repo, { id: '261030-a1b', slug: 'first-task', plan: { tier: 'A', body: 'Plan.' } });
      commitAll(repo, { home: ctx.home });
      const homeBefore = readdirSync(ctx.home).sort();
      const base = ['--kind', 'quick', '--id', '261030-a1b'];
      for (const name of ['unit-start', 'unit-close']) {
        const r = runCli([name, ...base], { home: ctx.home, cwd: repo });
        assert.equal(r.status, 0, r.stderr);
      }
      assert.deepEqual(readdirSync(stateDirOf(ctx.home)), ['ledger']);
      assert.deepEqual(readdirSync(join(stateDirOf(ctx.home), 'ledger')), ['units.jsonl']);
      assert.deepEqual(readdirSync(ctx.home).sort(), [...homeBefore, '.rigorscope'].sort());
      assert.equal(lstatSync(stateDirOf(ctx.home)).mode & 0o777, 0o700);
    } finally {
      ctx.cleanup();
    }
  });

  it('a symlinked state directory is refused by unit-start with exit 1 and nothing is written through it', () => {
    const ctx = makeHome();
    try {
      const repo = makeRepo(join(ctx.home, 'repos', 'alpha'), { home: ctx.home, files: { 'README.md': 'x\n' } });
      const target = join(ctx.home, 'elsewhere');
      mkdirSync(target, { recursive: true });
      symlinkSync(target, stateDirOf(ctx.home));
      const r = runCli(['unit-start', '--kind', 'quick', '--id', '261030-a1b'], { home: ctx.home, cwd: repo });
      assert.equal(r.status, 1);
      assert.deepEqual(readdirSync(target), []);
      assert.ok(!r.stderr.includes(ctx.home), 'the message holds no path');
    } finally {
      ctx.cleanup();
    }
  });
});
