// Per-source progress, the loud unknown token-bearing warning, dropped counts, the lock-held skip
// line and the exit codes (D-04, RR-01).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadSources } from '../../src/ingest/sources.mjs';
import { buildFixtureTree, cliEnv, makeHome, queryDb, runCli, stateDirOf, REPO } from '../fixtures/build.mjs';

const STORE = (home) => join(stateDirOf(home), 'store.db');
const LOCK_MODULE = fileURLToPath(new URL('../../src/ingest/lock.mjs', import.meta.url));

async function ingested(cases = 'all') {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases });
  const r = runCli(['ingest'], { home: ctx.home });
  return { ctx, r };
}

const sourceLine = (out) => out.split('\n').find((l) => /^transcript: files=/.test(l));

// The sources line lists every registered source, so it is derived from the registry (plan 01-03 added otel).
const SOURCES = (await loadSources()).map((s) => s.name).join(',');

describe('ingest output', () => {
  it('prints a header, one line per source with every progress field, and the 01-01 summary line last', async () => {
    const { ctx, r } = await ingested();
    try {
      assert.equal(r.status, 0, r.stderr);
      const lines = r.stdout.trimEnd().split('\n');
      assert.match(lines[0], new RegExp(`^ingest: roots=\\d+ sources=${SOURCES}$`));
      // Plan 01-06: the cursorless usage source prints its own line; case usage-window writes the cache file.
      assert.match(r.stdout, /^usage: files=1 new=1 reread=0 unchanged=0 skipped=0 bytes=\d+ lines=1 /m);
      const fields = ['files', 'new', 'reread', 'unchanged', 'skipped', 'bytes', 'lines', 'assistant', 'kept', 'unparseable',
        'oversized', 'dropped', 'unknown_token_bearing', 'deferred_token_bearing', 'pending_tail_bytes'];
      const line = sourceLine(r.stdout);
      assert.ok(line, 'a transcript progress line');
      let at = 0;
      for (const f of fields) {
        const i = line.indexOf(` ${f}=`, at);
        assert.ok(i >= at, `field ${f} in order`);
        at = i + 1;
      }
      assert.match(lines[lines.length - 1], /^ingest: files=\d+ lines=\d+ assistant=\d+ kept=\d+ unparseable=\d+ rejected=\S+$/);
      // Plan 02-04: the env line is printed once, immediately before the units line (the line before the last).
      const envAt = lines.findIndex((l) => l.startsWith('env: '));
      assert.equal(lines.filter((l) => l.startsWith('env: ')).length, 1, 'one env line');
      assert.ok(envAt > 0 && lines[envAt + 1].startsWith('units: '), 'the env line is right before the units line');
      assert.equal(envAt + 2, lines.length - 1, 'the units line stays the line before the last');
      assert.match(lines[envAt], /^env: gsd_version=\S+ gsd_version_source=\S+ base_sha=\S+ local_mods_head=\S+ hook_events=\S+ hooks=\S+ model_default=\S+ advisor_model=\S+$/);
    } finally {
      ctx.cleanup();
    }
  });

  it('reports a non-zero unknown token-bearing count loudly on stderr while exiting 0', async () => {
    const { ctx, r } = await ingested(['hostile']);
    try {
      assert.equal(r.status, 0);
      assert.match(r.stderr, /^WARNING: transcript: unknown_token_bearing=1 \(mystery-usage\|2\.9\.9:1\)/m);
      assert.match(sourceLine(r.stdout), /\bunknown_token_bearing=1\b/);
      assert.match(sourceLine(r.stdout), /\bdeferred_token_bearing=1\b/);
    } finally {
      ctx.cleanup();
    }
  });

  it('prints dropped counts by reason and the skipped-types line', async () => {
    const { ctx, r } = await ingested(['hostile']);
    try {
      // Through the CLI the default line cap is 32 MiB, so the 300000-byte filler line of the case is parsed
      // as an assistant line without usage: usage:2 (the oversized path is covered in fixture-cases).
      assert.match(sourceLine(r.stdout), /\bdropped=session_id:1,message_id:1,usage:2\b/);
      const types = r.stdout.split('\n').find((l) => l.startsWith('transcript: skipped_types='));
      assert.ok(types, 'skipped-types line');
      assert.match(types, /\buser:1\b/);
      assert.match(types, /\bother:\d+$/);
    } finally {
      ctx.cleanup();
    }
  });

  it('prints no WARNING when nothing is unknown, and a second run shows every file unchanged with 0 bytes', async () => {
    const { ctx, r } = await ingested(['tracer-base', 'subagents']);
    try {
      assert.equal(r.stderr, '');
      const second = runCli(['ingest'], { home: ctx.home });
      assert.match(sourceLine(second.stdout), /\bnew=0\b.*\bunchanged=\d+\b.*\bbytes=0\b.*\blines=0\b/);
    } finally {
      ctx.cleanup();
    }
  });

  it('records the run, the per-source row and name-keyed counts that doctor will read', async () => {
    const { ctx } = await ingested(['hostile']);
    try {
      const [run] = queryDb(STORE(ctx.home), 'SELECT * FROM ingest_run');
      assert.equal(run.status, 'ok');
      assert.equal(run.unknown_token_bearing, 1);
      assert.ok(run.roots >= 1);
      const [src] = queryDb(STORE(ctx.home), 'SELECT * FROM ingest_source_run WHERE source = \'transcript\'');
      assert.equal(src.source, 'transcript');
      assert.equal(src.unknown_token_bearing, 1);
      assert.equal(typeof src.newest_record_utc, 'string');
      const names = queryDb(STORE(ctx.home), "SELECT name FROM ingest_count WHERE kind = 'unknown_token'").map((x) => x.name);
      assert.deepEqual(names, ['mystery-usage|2.9.9']);
      const [file] = queryDb(STORE(ctx.home), 'SELECT * FROM source_file WHERE kind = \'session\' AND size > 0 ORDER BY rel_path LIMIT 1');
      assert.ok(file.first_record_utc && file.last_record_utc, 'first and last record time kept');
    } finally {
      ctx.cleanup();
    }
  });

  it('on a HOME with no config directory prints roots=0 and a final line, exit 0', () => {
    const ctx = makeHome();
    try {
      const r = runCli(['ingest'], { home: ctx.home });
      assert.equal(r.status, 0);
      assert.match(r.stdout, new RegExp(`^ingest: roots=0 sources=${SOURCES}$`, 'm'));
      assert.match(r.stdout, /^ingest: files=0 lines=0 assistant=0 kept=0 unparseable=0 rejected=none$/m);
      const [run] = queryDb(STORE(ctx.home), 'SELECT status, roots FROM ingest_run');
      assert.deepEqual({ ...run }, { status: 'ok', roots: 0 });
    } finally {
      ctx.cleanup();
    }
  });

  it('an explicit --root keeps working, may repeat, and a non-directory root is a usage error (exit 2)', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['tracer-base'] });
      const one = runCli(['ingest', '--root', ctx.root], { home: ctx.home });
      assert.equal(one.status, 0, one.stderr);
      assert.match(one.stdout, new RegExp(`^ingest: roots=1 sources=${SOURCES}$`, 'm'));
      const two = runCli(['ingest', '--root', ctx.root, '--root', ctx.root], { home: ctx.home });
      assert.equal(two.status, 0, two.stderr);
      assert.equal(runCli(['ingest', '--root', join(ctx.home, 'no-such-dir')], { home: ctx.home }).status, 2);
    } finally {
      ctx.cleanup();
    }
  });

  it('a live lock holder makes the run print one skip line and exit 0 without touching the store', async () => {
    const ctx = makeHome();
    try {
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['tracer-base'] });
      const script = `import(${JSON.stringify(LOCK_MODULE)}).then(async (m) => { await m.withLock({ home: ${JSON.stringify(ctx.home)} }, () => { process.stdout.write('held\\n'); return new Promise(() => setInterval(() => {}, 1000)); }); });`;
      const child = spawn(process.execPath, ['-e', script], { cwd: REPO, env: cliEnv(ctx.home) });
      await new Promise((resolve, reject) => {
        child.stdout.on('data', (d) => { if (String(d).includes('held')) resolve(); });
        child.on('error', reject);
        child.on('exit', () => reject(new Error('lock holder exited early')));
      });
      try {
        const r = runCli(['ingest'], { home: ctx.home });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /^ingest: skipped, another ingest holds the lock \(pid \d+ since \S+\)\n$/);
        assert.equal(existsSync(STORE(ctx.home)), false, 'a skipped run does not create or open the store');
      } finally {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.on('exit', resolve));
      }
    } finally {
      ctx.cleanup();
    }
  });
});
