// Plan 02-04 (D-15, ADR-0009 "The D-15 reread", T-02-38): migration 007's `transcript-reread` section sets head_hash
// to NULL on the transcript session and subagent files, so the first ingest after the apply rereads every such file
// still on disk once and fills cc_message_ref and cc_command; a session whose file aged out keeps zero rows (unknown,
// never "no refs") and its head_hash stays NULL. Written before the code (RED).
//
// The store is built at the latest version by an ingest, then downgraded to version 6 by hand: every table and index
// the latest store has and a version-6 store lacks is dropped and user_version is set to 6. That downgrade is exact
// only while migration 007 adds whole tables and indexes; the first test checks it and names the table when a later
// section alters a table created before 007 (then this downgrade must be extended). The versions are computed from
// the migration files, never written down. Everything runs on a temporary HOME.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_STORE_VERSION, loadMigrations, openStore, storePath } from '../../src/db.mjs';
import {
  buildFixtureTree, cliEnv, ingestHome, makeAssistant, makeHome, makeUsage, mangleHome, queryDb, runCli, sha256, windowsUsersDirFor,
  writeJsonl,
} from '../fixtures/build.mjs';
import { A85, S85 } from '../fixtures/cases/85-planning-refs.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../src/store/migrations/', import.meta.url));
const PRE_007 = 6;
const GONE = 'sess-gone';

const objects = (db) => db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
  .all().map((r) => ({ type: r.type, name: r.name }));
const tableInfo = (db, t) => JSON.stringify(db.prepare(`PRAGMA table_info("${t}")`).all().map((r) => ({ ...r })));
const userVersion = (file) => queryDb(file, 'PRAGMA user_version')[0].user_version;

function rowsOf(home) {
  const q = (sql) => queryDb(storePath(home), sql);
  return {
    refs: q('SELECT * FROM cc_message_ref ORDER BY session_id, agent_id, message_id, ref_dir, rel_path'),
    commands: q('SELECT * FROM cc_command ORDER BY session_id, agent_id, uuid'),
  };
}
const digestOf = (rows) => sha256(JSON.stringify(rows));
const withoutGone = (rows) => ({
  refs: rows.refs.filter((r) => r.session_id !== GONE), commands: rows.commands.filter((r) => r.session_id !== GONE),
});
const transcriptFiles = (home) => queryDb(storePath(home), `SELECT f.rel_path, f.kind, f.head_hash, f.tail_hash, f.offset, f.size, f.state
  FROM source_file f JOIN source_root r ON r.root_id = f.root_id WHERE r.source = 'transcript' ORDER BY f.rel_path`);
const isReread = (f) => f.kind === 'session' || f.kind === 'subagent';

describe('migration 007: the downgrade this test uses is exact', () => {
  it('a latest store and a version-6 store differ only by whole tables and indexes', async () => {
    const latest = makeHome();
    const six = makeHome();
    try {
      const all = await loadMigrations(MIGRATIONS);
      openStore({ home: latest.home }).close();
      openStore({ home: six.home, migrations: all.filter((m) => m.version <= PRE_007) }).close();
      const a = new DatabaseSync(storePath(latest.home), { readOnly: true });
      const b = new DatabaseSync(storePath(six.home), { readOnly: true });
      try {
        const sixTables = objects(b).filter((o) => o.type === 'table').map((o) => o.name);
        for (const t of sixTables) {
          assert.equal(tableInfo(a, t), tableInfo(b, t), `table ${t} differs between the latest and the version-6 store; `
            + 'a later 007 section altered a table created before 007, so extend the downgrade of test/integration/reread-007.test.mjs');
        }
        const sixNames = new Set(objects(b).map((o) => `${o.type}:${o.name}`));
        assert.ok(objects(a).some((o) => !sixNames.has(`${o.type}:${o.name}`)), 'migration 007 adds tables');
      } finally {
        a.close();
        b.close();
      }
    } finally {
      latest.cleanup();
      six.cleanup();
    }
  });
});

describe('migration 007: the D-15 reread of transcripts still on disk', () => {
  let ctx;
  let recorded;
  let beforeFiles;
  let gonePath;
  let migrated;
  let ingest1;
  before(async () => {
    ctx = makeHome();
    await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['planning-refs'] });
    const cwd = `${ctx.home}/work/gone`;
    gonePath = join(ctx.root, 'projects', mangleHome(cwd), `${GONE}.jsonl`);
    writeJsonl(gonePath, [
      JSON.stringify({
        type: 'user', uuid: 'uuid-gone-1', sessionId: GONE, timestamp: '2026-10-27T17:00:00.000Z', cwd,
        message: { role: 'user', content: '<command-name>/gsd-fast</command-name>' },
      }),
      JSON.stringify(makeAssistant({
        session: GONE, ts: '2026-10-27T17:00:01.000Z', id: 'msg_gone', model: 'claude-opus-5-5', cwd,
        use: makeUsage({ input: 1, output: 1, read: 0, creation: 0 }),
        content: [{ type: 'tool_use', id: 'toolu_g', name: 'Read', input: { file_path: `${ctx.home}/repos/alpha/.planning/quick/261030-a1b-first-task/261030-a1b-PLAN.md` } }],
      })),
    ]);
    // A meta file: a transcript file of another kind, which the reread must leave alone.
    const metaDir = join(ctx.root, 'projects', `${mangleHome(ctx.home)}-work-beta`, S85, 'subagents');
    writeFileSync(join(metaDir, `agent-${A85}.meta.json`), JSON.stringify({ agentType: 'gsd-executor', spawnDepth: 1 }));
    await ingestHome(ctx.home);
    recorded = rowsOf(ctx.home);
    beforeFiles = transcriptFiles(ctx.home);

    // Downgrade to version 6: drop every table and index the version-6 store does not have.
    const six = makeHome();
    let keep;
    try {
      const all = await loadMigrations(MIGRATIONS);
      openStore({ home: six.home, migrations: all.filter((m) => m.version <= PRE_007) }).close();
      const b = new DatabaseSync(storePath(six.home), { readOnly: true });
      keep = new Set(objects(b).map((o) => `${o.type}:${o.name}`));
      b.close();
    } finally {
      six.cleanup();
    }
    const raw = new DatabaseSync(storePath(ctx.home));
    raw.exec('PRAGMA foreign_keys = OFF');
    const extra = objects(raw).filter((o) => !keep.has(`${o.type}:${o.name}`));
    for (const o of extra.filter((x) => x.type === 'index')) raw.exec(`DROP INDEX IF EXISTS "${o.name}"`);
    for (const o of extra.filter((x) => x.type === 'table')) raw.exec(`DROP TABLE IF EXISTS "${o.name}"`);
    raw.exec(`PRAGMA user_version = ${PRE_007}`);
    raw.close();
    rmSync(gonePath);

    const env = cliEnv(ctx.home);
    migrated = runCli(['migrate', '--apply'], { home: ctx.home, env });
    ingest1 = { files: transcriptFiles(ctx.home), version: userVersion(storePath(ctx.home)) };
    ingest1.run = runCli(['ingest'], { home: ctx.home, env });
  });
  after(() => ctx.cleanup());

  it('the fixture recorded refs and commands of both sessions before the downgrade', () => {
    assert.ok(recorded.refs.some((r) => r.session_id === GONE) && recorded.commands.some((r) => r.session_id === GONE));
    assert.ok(withoutGone(recorded).refs.length > 0 && withoutGone(recorded).commands.length > 0);
  });

  it('migrate --apply reaches the latest version and NULLs head_hash on exactly the transcript session and subagent files', () => {
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.equal(ingest1.version, LATEST_STORE_VERSION);
    assert.ok(ingest1.files.some(isReread) && ingest1.files.some((f) => !isReread(f)), 'the fixture has both kinds of file');
    const before1 = new Map(beforeFiles.map((f) => [f.rel_path, f]));
    for (const f of ingest1.files) {
      const was = before1.get(f.rel_path);
      if (isReread(f)) assert.deepEqual({ ...f, head_hash: 'x' }, { ...was, head_hash: 'x' }, 'only head_hash changes');
      if (isReread(f)) assert.equal(f.head_hash, null, `head_hash of a ${f.kind} file is NULL`);
      else assert.deepEqual(f, was, `a ${f.kind} file keeps every value`);
    }
  });

  it('the next ingest rereads exactly the session and subagent files still on disk', () => {
    assert.equal(ingest1.run.status, 0, ingest1.run.stderr);
    const onDisk = beforeFiles.filter((f) => isReread(f) && !f.rel_path.endsWith(`${GONE}.jsonl`)).length;
    assert.ok(onDisk >= 2);
    assert.match(ingest1.run.stdout, new RegExp(`^transcript: files=\\d+ new=0 reread=${onDisk} `, 'm'));
  });

  it('refills the refs and commands of every file on disk; the gone session keeps zero rows and a NULL head_hash', () => {
    const now = rowsOf(ctx.home);
    assert.equal(digestOf(now), digestOf(withoutGone(recorded)));
    assert.equal(now.refs.filter((r) => r.session_id === GONE).length, 0);
    assert.equal(now.commands.filter((r) => r.session_id === GONE).length, 0);
    for (const f of transcriptFiles(ctx.home).filter(isReread)) {
      if (f.rel_path.endsWith(`${GONE}.jsonl`)) assert.equal(f.head_hash, null, 'the gone session stays unknown');
      else assert.notEqual(f.head_hash, null, `${f.kind} file reread`);
    }
  });

  it('a second ingest rereads 0 files and leaves both tables unchanged', () => {
    const d = digestOf(rowsOf(ctx.home));
    const again = runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home) });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^transcript: files=\d+ new=0 reread=0 /m);
    assert.equal(digestOf(rowsOf(ctx.home)), d);
  });
});

// Review WR-03 (RR-04): the capture-known rule plan 02-07 reads requires a FINISHED pass. Each chunk commit of a reread
// writes a non-NULL head_hash with state 'reading', so a reread interrupted after its first chunk must not make the
// scope known: its later messages still have cc_message_file rows from the pre-007 pass but no refs yet. The rule is
// taken from docs/data-model.md as written there, so the docs and this check cannot drift apart.
describe('the capture-known rule needs a finished pass (review WR-03)', () => {
  const RULE = "head_hash IS NOT NULL AND state = 'ok'";
  const DOC = fileURLToPath(new URL('../../docs/data-model.md', import.meta.url));
  const knownSection = () => {
    const text = readFileSync(DOC, 'utf8');
    const start = text.indexOf('#### Known and unknown refs and commands');
    assert.ok(start >= 0, 'docs/data-model.md has the capture-known section');
    return text.slice(start, text.indexOf('\n#', start + 4));
  };

  it('docs/data-model.md states the rule with the finished-pass condition', () => {
    assert.ok(knownSection().includes(`\`${RULE}\``), `the capture-known rule names \`${RULE}\``);
  });

  it('a reread interrupted after its first chunk commit leaves the scope unknown; the resumed run makes it known', async () => {
    assert.ok(knownSection().includes(`\`${RULE}\``), 'the rule under test is the documented one');
    const SESSION = 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c6c6';
    const ctx = makeHome();
    try {
      const cwd = join(ctx.home, 'work', 'beta');
      const use = makeUsage({ input: 10, output: 5, read: 0, creation: 0 });
      writeJsonl(join(ctx.root, 'projects', mangleHome(cwd), `${SESSION}.jsonl`), [1, 2, 3].map((i) => JSON.stringify(makeAssistant({
        session: SESSION, ts: `2026-10-27T15:00:0${i}.000Z`, id: `msg_${i}`, model: 'claude-opus-5-5', cwd, use,
        content: [{ type: 'tool_use', id: `t${i}`, name: 'Read',
          input: { file_path: join(ctx.home, 'repos', 'alpha', `.planning/quick/26103${i}-abc-t/26103${i}-abc-PLAN.md`) } }],
      }))));
      await ingestHome(ctx.home);

      // Downgrade to version 6 (the pre-007 pass keeps its cc_message_file rows), then apply the migrations again.
      const six = makeHome();
      let keep;
      try {
        const all = await loadMigrations(MIGRATIONS);
        openStore({ home: six.home, migrations: all.filter((m) => m.version <= PRE_007) }).close();
        const b = new DatabaseSync(storePath(six.home), { readOnly: true });
        keep = new Set(objects(b).map((o) => `${o.type}:${o.name}`));
        b.close();
      } finally {
        six.cleanup();
      }
      const raw = new DatabaseSync(storePath(ctx.home));
      raw.exec('PRAGMA foreign_keys = OFF');
      const extra = objects(raw).filter((o) => !keep.has(`${o.type}:${o.name}`));
      for (const o of extra.filter((x) => x.type === 'index')) raw.exec(`DROP INDEX IF EXISTS "${o.name}"`);
      for (const o of extra.filter((x) => x.type === 'table')) raw.exec(`DROP TABLE IF EXISTS "${o.name}"`);
      raw.exec(`PRAGMA user_version = ${PRE_007}`);
      raw.close();
      const env = cliEnv(ctx.home);
      const mig = runCli(['migrate', '--apply'], { home: ctx.home, env });
      assert.equal(mig.status, 0, mig.stderr);

      const { runIngest } = await import('../../src/ingest/run.mjs');
      let flushed = false;
      const cut = await runIngest({
        home: ctx.home, env, windowsUsersDir: windowsUsersDirFor(ctx.home), chunkLines: 1, lock: false,
        beforeCommit: ({ final }) => { if (!final) flushed = true; },
        stop: () => (flushed ? 'SIGTERM' : null),
      }).then(() => 'completed', (err) => err?.name ?? 'error');
      assert.notEqual(cut, 'completed', 'the reread was interrupted');
      const db = storePath(ctx.home);
      const file = queryDb(db, "SELECT state, head_hash IS NOT NULL AS hh FROM source_file WHERE kind = 'session'");
      assert.deepEqual(file.map((r) => [r.state, r.hh]), [['reading', 1]], 'one chunk committed: head_hash set, state reading');
      assert.equal(queryDb(db, 'SELECT count(*) AS n FROM cc_message_ref')[0].n, 1, 'only the first chunk refs exist');
      const known = (cond) => queryDb(db, `SELECT EXISTS (SELECT 1 FROM cc_message_file mf JOIN source_file f ON f.file_id = mf.file_id
        WHERE mf.session_id = ? AND mf.agent_id = '' AND (${cond})) AS k`, [SESSION])[0].k;
      assert.equal(known('head_hash IS NOT NULL'), 1, 'head_hash alone would call the partial scope known');
      assert.equal(known(RULE), 0, 'the documented rule calls it unknown');

      await ingestHome(ctx.home);
      assert.equal(queryDb(db, 'SELECT count(*) AS n FROM cc_message_ref')[0].n, 3, 'the resumed run finishes the reread');
      assert.equal(known(RULE), 1, 'a finished pass makes the scope known');
    } finally {
      ctx.cleanup();
    }
  });
});
