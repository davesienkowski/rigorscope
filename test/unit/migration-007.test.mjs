// Plan 02-02 (D-14, ADR-0009): migration 007, the durable repo and unit tables. Written before the code (RED).
// 007 is built from ordered sections: this plan writes `repos` and `units`; plans 02-04 and 02-05 append sections and
// never edit or reorder an earlier one, and 02-05 pins the sha256 of `sql`. Every test selects migrations by version
// (m.version < 7, m.version <= 7), never by list length, and never writes the latest store version as a literal.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LATEST_STORE_VERSION, loadMigrations, openStore } from '../../src/db.mjs';
import { makeHome } from '../fixtures/build.mjs';
import { privateRef, skipUnlessPrivate } from '../helpers/tree-kind.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../src/store/migrations/', import.meta.url));
const FILE = fileURLToPath(new URL('../../src/store/migrations/007-reconstructed-units.mjs', import.meta.url));
// ADR-0009 is a private document: null in a public tree, where the tests that read it skip (test/helpers/tree-kind.mjs).
const ADR = privateRef('adr-0009');
const ADR_SKIP = skipUnlessPrivate('adr-0009');

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});
function home() {
  const ctx = makeHome();
  cleanups.push(ctx.cleanup);
  return ctx.home;
}
const userVersion = (db) => db.prepare('PRAGMA user_version').get().user_version;
const columns = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const select = async (pred) => (await loadMigrations(MIGRATIONS)).filter(pred);

const COLUMNS = {
  repo: ['repo_key', 'repo_name', 'first_seen_run', 'last_seen_run', 'last_scanned_run'],
  dir_repo: ['dir', 'repo_key', 'method', 'is_worktree', 'resolved_run'],
  unit_obs: ['unit_key', 'framework', 'repo_key', 'kind', 'native_id', 'dir_rel', 'id_date', 'id_offset_min', 'first_seen_run', 'last_seen_run'],
  unit_artifact: ['unit_key', 'rel_path', 'role', 'mtime_ms', 'first_mtime_ms', 'first_commit_ms', 'tier_letter', 'tier_place', 'first_seen_run', 'last_seen_run'],
};

describe('migration 007: the module', () => {
  it('exports version 7, frozen ordered SECTIONS beginning with repos then units, and sql equal to the joined sections', async () => {
    const mod = await import(pathToFileURL(FILE).href);
    assert.equal(mod.version, 7);
    assert.ok(Object.isFrozen(mod.SECTIONS));
    assert.deepEqual(mod.SECTIONS.slice(0, 2).map((s) => [s.id, s.plan]), [['repos', '02-02'], ['units', '02-02']]);
    for (const s of mod.SECTIONS) {
      assert.ok(Object.isFrozen(s));
      assert.equal(typeof s.sql, 'string');
    }
    assert.equal(mod.sql, mod.SECTIONS.map((s) => s.sql).join('\n'));
    assert.ok(!/\bgit_branch\b/i.test(mod.sql), 'no branch column (amendment Q5)');
    assert.ok(!/\b(DELETE|DROP)\b/i.test(mod.sql), 'no row is deleted and no table dropped');
  });

  it('is part of the default migration list', async () => {
    assert.ok(LATEST_STORE_VERSION >= 7);
    assert.equal((await select((m) => m.version === 7)).length, 1);
  });
});

describe('migration 007: applied', () => {
  it('a v6 store reaches 7 through the migrate option and keeps its cc_message rows', async () => {
    const h = home();
    const db6 = openStore({ home: h, migrations: await select((m) => m.version < 7) });
    db6.exec("INSERT INTO cc_message (session_id, agent_id, message_id, cwd) VALUES ('s', '', 'a', '~/x'), ('s', '', 'b', NULL)");
    assert.equal(userVersion(db6), 6);
    db6.close();
    const db7 = openStore({ home: h, migrations: await select((m) => m.version <= 7), migrate: true });
    try {
      assert.equal(userVersion(db7), 7);
      assert.equal(db7.prepare('SELECT count(*) AS n FROM cc_message').get().n, 2);
    } finally {
      db7.close();
    }
  });

  it('a fresh store reaches the latest version with no option and has the four tables with their columns', () => {
    const db = openStore({ home: home() });
    try {
      assert.equal(userVersion(db), LATEST_STORE_VERSION);
      for (const [t, cols] of Object.entries(COLUMNS)) assert.deepEqual(columns(db, t), cols, t);
    } finally {
      db.close();
    }
  });

  it('rejects rows that break a CHECK or a foreign key', () => {
    const db = openStore({ home: home() });
    try {
      db.exec("INSERT INTO repo (repo_key, repo_name, first_seen_run, last_seen_run) VALUES ('~/r/.git', 'r', 1, 1)");
      db.exec("INSERT INTO unit_obs (unit_key, framework, repo_key, kind, native_id, dir_rel, first_seen_run, last_seen_run) "
        + "VALUES ('gsd-core:~/r/.git:quick:261030-a1b', 'gsd-core', '~/r/.git', 'quick', '261030-a1b', '.planning/quick/261030-a1b-x', 1, 1)");
      const bad = [
        ['dir_repo method none with a repo_key', "INSERT INTO dir_repo (dir, repo_key, method, is_worktree, resolved_run) VALUES ('~/d', '~/r/.git', 'none', NULL, 1)"],
        ['dir_repo method git without a repo_key', "INSERT INTO dir_repo (dir, repo_key, method, is_worktree, resolved_run) VALUES ('~/d', NULL, 'git', 0, 1)"],
        ['dir_repo with an unknown method', "INSERT INTO dir_repo (dir, repo_key, method, is_worktree, resolved_run) VALUES ('~/d', NULL, 'layout', NULL, 1)"],
        ['unit_obs key not equal to its parts', "INSERT INTO unit_obs (unit_key, framework, repo_key, kind, native_id, dir_rel, first_seen_run, last_seen_run) "
          + "VALUES ('wrong', 'gsd-core', '~/r/.git', 'quick', '261030-b2c', '.planning/quick/261030-b2c-x', 1, 1)"],
        ['unit_obs with an unknown repo_key', "INSERT INTO unit_obs (unit_key, framework, repo_key, kind, native_id, dir_rel, first_seen_run, last_seen_run) "
          + "VALUES ('gsd-core:~/nope/.git:quick:261030-b2c', 'gsd-core', '~/nope/.git', 'quick', '261030-b2c', '.planning/quick/261030-b2c-x', 1, 1)"],
        ['unit_obs dir outside .planning', "INSERT INTO unit_obs (unit_key, framework, repo_key, kind, native_id, dir_rel, first_seen_run, last_seen_run) "
          + "VALUES ('gsd-core:~/r/.git:quick:261030-b2c', 'gsd-core', '~/r/.git', 'quick', '261030-b2c', 'src/x', 1, 1)"],
        ['unit_obs only one of id_date and id_offset_min', "INSERT INTO unit_obs (unit_key, framework, repo_key, kind, native_id, dir_rel, id_date, first_seen_run, last_seen_run) "
          + "VALUES ('gsd-core:~/r/.git:quick:261030-b2c', 'gsd-core', '~/r/.git', 'quick', '261030-b2c', '.planning/quick/261030-b2c-x', '2026-10-30', 1, 1)"],
        ['unit_artifact role other', "INSERT INTO unit_artifact (unit_key, rel_path, role, first_seen_run, last_seen_run) "
          + "VALUES ('gsd-core:~/r/.git:quick:261030-a1b', '.planning/quick/261030-a1b-x/261030-a1b-PLAN.md', 'other', 1, 1)"],
        ['unit_artifact rel_path with ..', "INSERT INTO unit_artifact (unit_key, rel_path, role, first_seen_run, last_seen_run) "
          + "VALUES ('gsd-core:~/r/.git:quick:261030-a1b', '.planning/quick/../../etc/x', 'plan', 1, 1)"],
        ['unit_artifact a letter without a place', "INSERT INTO unit_artifact (unit_key, rel_path, role, tier_letter, first_seen_run, last_seen_run) "
          + "VALUES ('gsd-core:~/r/.git:quick:261030-a1b', '.planning/quick/261030-a1b-x/261030-a1b-PLAN.md', 'plan', 'A', 1, 1)"],
        ['unit_artifact of an unknown unit', "INSERT INTO unit_artifact (unit_key, rel_path, role, first_seen_run, last_seen_run) "
          + "VALUES ('gsd-core:~/r/.git:quick:999999-zzz', '.planning/quick/999999-zzz-x/999999-zzz-PLAN.md', 'plan', 1, 1)"],
      ];
      for (const [label, sql] of bad) assert.throws(() => db.exec(sql), /constraint/i, label);
      db.exec("INSERT INTO unit_artifact (unit_key, rel_path, role, tier_letter, tier_place, first_seen_run, last_seen_run) "
        + "VALUES ('gsd-core:~/r/.git:quick:261030-a1b', '.planning/quick/261030-a1b-x/261030-a1b-PLAN.md', 'plan', 'A', 'frontmatter', 1, 1)");
    } finally {
      db.close();
    }
  });
});

// Plan 02-04: the sections this plan appends, in order, after 02-02's repos and units. The test reads them from the
// module; nothing below hard-codes the latest store version or the total section count.
const PLAN_0204 = {
  cc_message_ref: ['session_id', 'agent_id', 'message_id', 'ref_dir', 'rel_path', 'ref_kind', 'tool_name', 'n'],
  cc_command: ['session_id', 'agent_id', 'uuid', 'ts_utc', 'command_name'],
  env_snapshot: ['run_id', 'taken_utc', 'gsd_version', 'gsd_version_source', 'base_sha', 'local_mods_head', 'hooks_sha',
    'hook_events', 'model_default', 'advisor_model'],
};

// The cells of ADR-0009's `### Tables of migration 007` row whose first cell is the backticked table name.
function adrRow(table) {
  const text = readFileSync(ADR, 'utf8');
  const start = text.indexOf('### Tables of migration 007');
  assert.ok(start >= 0, 'ADR-0009 has the table section');
  const section = text.slice(start, text.indexOf('\n### ', start + 4));
  const row = section.split('\n').find((l) => l.startsWith(`| \`${table}\` |`));
  assert.ok(row, `ADR-0009 has a row for ${table}`);
  return row;
}

describe('migration 007: the 02-04 section transcript-refs', () => {
  it('SECTIONS holds transcript-refs with plan 02-04 right after units', async () => {
    const mod = await import(pathToFileURL(FILE).href);
    const ids = mod.SECTIONS.map((s) => s.id);
    assert.deepEqual(mod.SECTIONS.slice(0, 3).map((s) => [s.id, s.plan]), [['repos', '02-02'], ['units', '02-02'], ['transcript-refs', '02-04']]);
    assert.equal(ids.indexOf('transcript-refs'), ids.indexOf('units') + 1);
  });

  it('a fresh store has cc_message_ref with its columns', () => {
    const db = openStore({ home: home() });
    try {
      assert.deepEqual(columns(db, 'cc_message_ref'), PLAN_0204.cc_message_ref);
    } finally {
      db.close();
    }
  });

  it('every column of cc_message_ref is named as a whole word in its ADR-0009 table row', { skip: ADR_SKIP }, () => {
    const row = adrRow('cc_message_ref');
    for (const c of PLAN_0204.cc_message_ref) assert.match(row, new RegExp(`\\b${c}\\b`), `ADR-0009 row names ${c}`);
  });

  it('rejects refs that break a CHECK or the foreign key to cc_message', () => {
    const db = openStore({ home: home() });
    try {
      db.exec("INSERT INTO cc_message (session_id, agent_id, message_id) VALUES ('s', '', 'm')");
      const ins = (dir, rel, kind, tool, n, msg = 'm') => `INSERT INTO cc_message_ref (session_id, agent_id, message_id, ref_dir, rel_path, ref_kind, tool_name, n) `
        + `VALUES ('s', '', '${msg}', '${dir}', '${rel}', '${kind}', '${tool}', ${n})`;
      const good = ['~/r', '.planning/quick/261030-a1b-x/261030-a1b-PLAN.md', 'quick', 'Read', 1];
      db.exec(ins(...good));
      const bad = [
        ['rel_path outside the planning dirs', ins('~/r', 'src/x.mjs', 'quick', 'Read', 1)],
        ['rel_path in .planning but not quick or phases', ins('~/r', '.planning/notes/x', 'quick', 'Read', 1)],
        ['rel_path with ..', ins('~/r', '.planning/quick/../x', 'quick', 'Read', 1)],
        ['rel_path with a space', ins('~/r', '.planning/quick/a b', 'quick', 'Read', 1)],
        ['rel_path with //', ins('~/r', '.planning/quick//x', 'quick', 'Read', 1)],
        ['ref_kind phase on a quick path', ins('~/r', '.planning/quick/261030-a1b-y', 'phase', 'Read', 1)],
        ['ref_kind quick on a phases path', ins('~/r', '.planning/phases/02-x', 'quick', 'Read', 1)],
        ['ref_kind other', ins('~/r', '.planning/quick/261030-a1b-z', 'other', 'Read', 1)],
        ['n 0', ins('~/r', '.planning/quick/261030-a1b-w', 'quick', 'Read', 0)],
        ['ref_dir relative', ins('repos/r', '.planning/quick/261030-a1b-v', 'quick', 'Read', 1)],
        ['ref_dir with ..', ins('~/r/..', '.planning/quick/261030-a1b-u', 'quick', 'Read', 1)],
        ['ref_dir with a space', ins('~/r s', '.planning/quick/261030-a1b-t', 'quick', 'Read', 1)],
        ['tool_name with a space', ins('~/r', '.planning/quick/261030-a1b-s', 'quick', 'bad name', 1)],
        ['no parent cc_message', ins('~/r', '.planning/quick/261030-a1b-r', 'quick', 'Read', 1, 'nope')],
      ];
      for (const [label, sql] of bad) assert.throws(() => db.exec(sql), /constraint/i, label);
      for (const [i, dir] of ['~', '~win/c', '~other/d', '/srv/w'].entries()) {
        db.exec(ins(dir, `.planning/phases/02-${i}`, 'phase', 'Grep', 2));
      }
    } finally {
      db.close();
    }
  });

  it('the key holds ref_dir: one message keeps one rel_path under two directories (review CR-01)', () => {
    const db = openStore({ home: home() });
    try {
      db.exec("INSERT INTO cc_message (session_id, agent_id, message_id) VALUES ('s', '', 'm')");
      const ins = (dir) => 'INSERT INTO cc_message_ref (session_id, agent_id, message_id, ref_dir, rel_path, ref_kind, tool_name, n) '
        + `VALUES ('s', '', 'm', '${dir}', '.planning/quick/261030-a1b-x', 'quick', 'Read', 1)`;
      db.exec(ins('~/repos/alpha'));
      db.exec(ins('~/repos/gamma'));
      assert.equal(db.prepare('SELECT count(*) AS n FROM cc_message_ref').get().n, 2);
      const pk = db.prepare("SELECT name FROM pragma_table_info('cc_message_ref') WHERE pk > 0 ORDER BY pk").all().map((r) => r.name);
      assert.deepEqual(pk, ['session_id', 'agent_id', 'message_id', 'ref_dir', 'rel_path']);
    } finally {
      db.close();
    }
  });
});

describe('migration 007: the 02-04 sections transcript-commands and transcript-reread', () => {
  it('SECTIONS holds transcript-commands then transcript-reread (plan 02-04) right after transcript-refs', async () => {
    const mod = await import(pathToFileURL(FILE).href);
    const ids = mod.SECTIONS.map((s) => s.id);
    const at = ids.indexOf('transcript-refs');
    assert.deepEqual(mod.SECTIONS.slice(at, at + 3).map((s) => [s.id, s.plan]),
      [['transcript-refs', '02-04'], ['transcript-commands', '02-04'], ['transcript-reread', '02-04']]);
  });

  it('the reread section only sets head_hash to NULL on transcript session and subagent files', async () => {
    const mod = await import(pathToFileURL(FILE).href);
    const sql = mod.SECTIONS.find((s) => s.id === 'transcript-reread').sql;
    assert.match(sql, /^\s*UPDATE source_file SET head_hash = NULL\s+WHERE kind IN \('session', 'subagent'\)\s+AND root_id IN \(SELECT root_id FROM source_root WHERE source = 'transcript'\);\s*$/);
  });

  it('a fresh store has cc_command with its columns', () => {
    const db = openStore({ home: home() });
    try {
      assert.deepEqual(columns(db, 'cc_command'), PLAN_0204.cc_command);
    } finally {
      db.close();
    }
  });

  it('every column of cc_command is named in its ADR-0009 table row', { skip: ADR_SKIP }, () => {
    const row = adrRow('cc_command');
    for (const c of PLAN_0204.cc_command) assert.match(row, new RegExp(`\\b${c}\\b`), `ADR-0009 row names ${c}`);
  });

  it('rejects command rows that break a CHECK', () => {
    const db = openStore({ home: home() });
    try {
      const ins = (name, ts = '2026-10-27T16:00:01.000Z', uuid = 'u1') => `INSERT INTO cc_command (session_id, agent_id, uuid, ts_utc, command_name) `
        + `VALUES ('s', '', '${uuid}', ${ts === null ? 'NULL' : `'${ts}'`}, '${name}')`;
      db.exec(ins('gsd-quick'));
      db.exec(ins('gsd:x_y.z-1', null, 'u2'));
      for (const [label, sql] of [
        ['a name with a space', ins('gsd quick', undefined, 'u3')],
        ['a name with a slash', ins('/gsd-quick', undefined, 'u4')],
        ['an empty name', ins('', undefined, 'u5')],
        ['a name of 65 characters', ins('a'.repeat(65), undefined, 'u6')],
        ['a time that is not UTC', ins('gsd-quick', '2026-10-27 16:00:01', 'u7')],
      ]) assert.throws(() => db.exec(sql), /constraint/i, label);
    } finally {
      db.close();
    }
  });
});

describe('migration 007: the 02-04 section env-snapshot', () => {
  it('SECTIONS holds repos, units, then the four 02-04 sections ending with env-snapshot', async () => {
    const mod = await import(pathToFileURL(FILE).href);
    const ids = mod.SECTIONS.map((s) => s.id);
    const at = ids.indexOf('transcript-refs');
    assert.deepEqual(mod.SECTIONS.slice(at, at + 4).map((s) => [s.id, s.plan]), [['transcript-refs', '02-04'],
      ['transcript-commands', '02-04'], ['transcript-reread', '02-04'], ['env-snapshot', '02-04']]);
  });

  it('a fresh store has env_snapshot with its columns', () => {
    const db = openStore({ home: home() });
    try {
      assert.deepEqual(columns(db, 'env_snapshot'), PLAN_0204.env_snapshot);
    } finally {
      db.close();
    }
  });

  it('every column of env_snapshot is named in its ADR-0009 table row', { skip: ADR_SKIP }, () => {
    const row = adrRow('env_snapshot');
    for (const c of PLAN_0204.env_snapshot) assert.match(row, new RegExp(`\\b${c}\\b`), `ADR-0009 row names ${c}`);
  });

  it('rejects snapshot rows that break a CHECK or the foreign key to ingest_run', () => {
    const db = openStore({ home: home() });
    try {
      db.exec("INSERT INTO ingest_run (run_id, started_utc, trigger, status) VALUES (1, '2026-10-28T12:00:00.000Z', 'manual', 'ok')");
      const sha = 'a'.repeat(40);
      const ins = (cols) => {
        const row = { run_id: 1, taken_utc: '2026-10-28T12:00:00.000Z', ...cols };
        const keys = Object.keys(row);
        return `INSERT INTO env_snapshot (${keys.join(', ')}) VALUES (${keys.map((k) => (row[k] === null ? 'NULL' : typeof row[k] === 'number' ? row[k] : `'${row[k]}'`)).join(', ')})`;
      };
      for (const [label, cols] of [
        ['no parent run', { run_id: 9 }],
        ['a version without its source', { gsd_version: '1.0.0' }],
        ['an unknown version source', { gsd_version: '1.0.0', gsd_version_source: 'guess' }],
        ['a version of 33 characters', { gsd_version: '1'.repeat(33), gsd_version_source: 'manifest' }],
        ['an upper-case base sha', { base_sha: sha.toUpperCase() }],
        ['a 39-character local-mods head', { local_mods_head: sha.slice(1) }],
        ['a hooks hash without event counts', { hooks_sha: 'b'.repeat(64) }],
        ['event counts that are not an object', { hooks_sha: 'b'.repeat(64), hook_events: '[1]' }],
        ['event counts that are not JSON', { hooks_sha: 'b'.repeat(64), hook_events: '{bad' }],
        ['a model of 119 characters', { model_default: 'm'.repeat(119) }],
        ['a local time', { taken_utc: '2026-10-28 12:00:00' }],
      ]) assert.throws(() => db.exec(ins(cols)), /constraint|malformed/i, label);
      db.exec(ins({
        gsd_version: '1.19.0', gsd_version_source: 'version-file', base_sha: sha, local_mods_head: 'c'.repeat(64),
        hooks_sha: 'b'.repeat(64), hook_events: '{"Stop":1}', model_default: 'opus[1m]', advisor_model: 'haiku',
      }));
    } finally {
      db.close();
    }
  });
});

// Plan 02-05: the two sections this plan appends after 02-04's env-snapshot. The four artifact time columns live in
// the sibling table unit_artifact_time (an ALTER TABLE ADD COLUMN cannot run twice, and the 005/006 rewind tests run
// 007 again on a store that has its tables).
const PLAN_0205 = {
  unit_path: ['unit_key', 'rel_path', 'path_source', 'first_seen_run'],
  unit_commit: ['unit_key', 'sha', 'author_ms', 'files', 'added', 'deleted', 'touches_code', 'first_seen_run', 'last_seen_run'],
  unit_commit_file: ['unit_key', 'sha', 'rel_path', 'status', 'added', 'deleted'],
  unit_module_dir: ['unit_key', 'module_dir', 'existed', 'first_seen_run'],
  unit_git_scan: ['unit_key', 'refs_sha', 'commits', 'scanned_run'],
  unit_artifact_time: ['unit_key', 'rel_path', 'tier_commit_ms', 'last_commit_ms', 'fm_date', 'fm_offset_min'],
};

describe('migration 007: the 02-05 sections unit-facts and artifact-times', () => {
  it('SECTIONS holds unit-facts then artifact-times (plan 02-05) right after env-snapshot', async () => {
    const mod = await import(pathToFileURL(FILE).href);
    const ids = mod.SECTIONS.map((s) => s.id);
    const at = ids.indexOf('env-snapshot');
    assert.ok(at >= 0);
    assert.deepEqual(mod.SECTIONS.slice(at + 1, at + 3).map((s) => [s.id, s.plan]), [['unit-facts', '02-05'], ['artifact-times', '02-05']]);
    for (const s of mod.SECTIONS.filter((x) => x.plan === '02-05')) {
      assert.ok(!/\bALTER\b/i.test(s.sql), `${s.id} holds no ALTER (not idempotent)`);
    }
  });

  it('a fresh store has the six 02-05 tables with their columns', () => {
    const db = openStore({ home: home() });
    try {
      for (const [t, cols] of Object.entries(PLAN_0205)) assert.deepEqual(columns(db, t), cols, t);
    } finally {
      db.close();
    }
  });

  it('running the 007 sql a second time on a store that has its tables changes nothing and throws nothing', async () => {
    const mod = await import(pathToFileURL(FILE).href);
    const db = openStore({ home: home() });
    try {
      db.exec(mod.sql);
      for (const [t, cols] of Object.entries(PLAN_0205)) assert.deepEqual(columns(db, t), cols, t);
    } finally {
      db.close();
    }
  });

  it('rejects fact rows that break a CHECK or a foreign key', () => {
    const db = openStore({ home: home() });
    const U = 'gsd-core:~/r/.git:quick:261030-a1b';
    const ART = '.planning/quick/261030-a1b-x/261030-a1b-PLAN.md';
    const sha = 'a'.repeat(40);
    try {
      db.exec("INSERT INTO repo (repo_key, repo_name, first_seen_run, last_seen_run) VALUES ('~/r/.git', 'r', 1, 1)");
      db.exec("INSERT INTO unit_obs (unit_key, framework, repo_key, kind, native_id, dir_rel, first_seen_run, last_seen_run) "
        + `VALUES ('${U}', 'gsd-core', '~/r/.git', 'quick', '261030-a1b', '.planning/quick/261030-a1b-x', 1, 1)`);
      db.exec(`INSERT INTO unit_artifact (unit_key, rel_path, role, first_seen_run, last_seen_run) VALUES ('${U}', '${ART}', 'plan', 1, 1)`);
      const commit = (s) => `INSERT INTO unit_commit (unit_key, sha, author_ms, files, added, deleted, touches_code, first_seen_run, last_seen_run) VALUES ('${U}', '${s}', 1, 1, 1, 0, 1, 1, 1)`;
      const file = (cols) => {
        const row = {
          unit_key: U, sha, rel_path: 'src/a.mjs', status: 'A', added: 1, deleted: 0, ...cols,
        };
        const keys = Object.keys(row);
        return `INSERT INTO unit_commit_file (${keys.join(', ')}) VALUES (${keys.map((k) => (row[k] === null ? 'NULL' : typeof row[k] === 'number' ? row[k] : `'${row[k]}'`)).join(', ')})`;
      };
      const path = (p, src = 'files_modified') => `INSERT INTO unit_path (unit_key, rel_path, path_source, first_seen_run) VALUES ('${U}', '${p}', '${src}', 1)`;
      const time = (d, off) => `INSERT INTO unit_artifact_time (unit_key, rel_path, fm_date, fm_offset_min) VALUES ('${U}', '${ART}', ${d === null ? 'NULL' : `'${d}'`}, ${off === null ? 'NULL' : off})`;
      const bad = [
        ['a 39-character sha', commit(sha.slice(1))],
        ['an upper-case sha', commit(sha.toUpperCase())],
        ['a commit of an unknown unit', commit(sha).replace(U, 'gsd-core:~/r/.git:quick:999999-zzz')],
        ['touches_code 2', commit(sha).replace(', 0, 1, 1, 1)', ', 0, 2, 1, 1)')],
        ['a commit file with no parent commit', file({})],
      ];
      for (const [label, sql] of bad) assert.throws(() => db.exec(sql), /constraint/i, label);
      db.exec(commit(sha));
      const bad2 = [
        ['status X', file({ status: 'X' })],
        ['a negative added count', file({ added: -1 })],
        ['a commit file path with a .. segment', file({ rel_path: 'src/../x' })],
        ['a commit file path with a leading /', file({ rel_path: '/etc/x' })],
        ['a unit_path with a .. segment', path('../x')],
        ['a unit_path ending in ..', path('a/..')],
        ['a unit_path that is ..', path('..')],
        ['a unit_path with a leading /', path('/srv/x')],
        ['a unit_path from commits', path('src/b.mjs', 'commit')],
        ['a module dir with a leading /', `INSERT INTO unit_module_dir (unit_key, module_dir, existed, first_seen_run) VALUES ('${U}', '/x', 1, 1)`],
        ['a module dir existed 2', `INSERT INTO unit_module_dir (unit_key, module_dir, existed, first_seen_run) VALUES ('${U}', 'src', 2, 1)`],
        ['a refs_sha that is not 64 hex', `INSERT INTO unit_git_scan (unit_key, refs_sha, commits, scanned_run) VALUES ('${U}', '${sha}', 0, 1)`],
        ['a scan of an unknown unit', `INSERT INTO unit_git_scan (unit_key, refs_sha, commits, scanned_run) VALUES ('gsd-core:~/r/.git:quick:999999-zzz', '${'b'.repeat(64)}', 0, 1)`],
        ['an fm_date of 2026-1-5', time('2026-1-5', 0)],
        ['an fm_date without its offset', time('2026-01-05', null)],
        ['an offset of 901', time('2026-01-05', 901)],
        ['an artifact time of an unknown artifact', time('2026-01-05', 0).replace(ART, '.planning/quick/261030-a1b-x/other.md')],
      ];
      for (const [label, sql] of bad2) assert.throws(() => db.exec(sql), /constraint/i, label);
      db.exec(file({}));
      db.exec(file({ rel_path: 'docs/b.md', status: 'M', added: null, deleted: null }));
      db.exec(path('~/.claude/settings.json'));
      db.exec(`INSERT INTO unit_module_dir (unit_key, module_dir, existed, first_seen_run) VALUES ('${U}', '', NULL, 1)`);
      db.exec(`INSERT INTO unit_git_scan (unit_key, refs_sha, commits, scanned_run) VALUES ('${U}', '${'b'.repeat(64)}', 1, 1)`);
      db.exec(time('2026-01-05', -300));
    } finally {
      db.close();
    }
  });
});

// Plan 02-05 Task 3: migration 007 is frozen. Plan 02-06 applies exactly this sql to the live store and checks
// FROZEN_007_SQL_SHA256 against the module first; a change to 007 after this point is a new migration (008), never an
// edit here. Both literals were copied from command output (a node -e import of the module), never typed. The one
// reopen before the live apply (review of plan 02-05, ADR-0009's amendment of that review) re-pinned the sha once.
const FROZEN_007_SECTIONS = ['repos', 'units', 'transcript-refs', 'transcript-commands', 'transcript-reread', 'env-snapshot', 'unit-facts', 'artifact-times'];
const FROZEN_007_SQL_SHA256 = '03e3d929bf509c987c93f47f3853cb2c9e05d138e033714fd42bd7a9bbc55730';

// The rows of ADR-0009 whose first cell is one backticked name, inside `### Tables of migration 007` and inside every
// section whose heading starts `## Amendment`: Map name -> the joined text of its rows.
function adrTableRows() {
  const text = readFileSync(ADR, 'utf8');
  const lines = text.split('\n');
  const rows = new Map();
  let inScope = false;
  let level = 0;
  for (const line of lines) {
    const h = /^(#{2,6}) (.*)$/.exec(line);
    if (h) {
      const depth = h[1].length;
      if (depth === 3 && h[2].startsWith('Tables of migration 007')) { inScope = true; level = 3; continue; }
      if (depth === 2 && h[2].startsWith('Amendment')) { inScope = true; level = 2; continue; }
      if (inScope && depth <= level) inScope = false;
      continue;
    }
    if (!inScope) continue;
    const m = /^\| `([A-Za-z0-9_]+)` \|/.exec(line);
    if (m) rows.set(m[1], `${rows.get(m[1]) ?? ''}\n${line}`);
  }
  return rows;
}

describe('migration 007 is frozen and agrees with ADR-0009 both ways (plan 02-05)', () => {
  it('the ordered section ids equal the pinned list, and every 02-05 section is unit-facts or artifact-times', async () => {
    const mod = await import(pathToFileURL(FILE).href);
    assert.deepEqual(mod.SECTIONS.map((s) => s.id), FROZEN_007_SECTIONS);
    for (const s of mod.SECTIONS.filter((x) => x.plan === '02-05')) assert.ok(['unit-facts', 'artifact-times'].includes(s.id), s.id);
  });

  it('the sha256 of sql equals the pinned value', async () => {
    const mod = await import(pathToFileURL(FILE).href);
    const { createHash } = await import('node:crypto');
    assert.match(FROZEN_007_SQL_SHA256, /^[0-9a-f]{64}$/, 'the pin is a sha256 hex');
    assert.equal(createHash('sha256').update(mod.sql).digest('hex'), FROZEN_007_SQL_SHA256);
  });

  it('the tables 007 adds are exactly the backticked table rows of ADR-0009, and every column is named in its rows', { skip: ADR_SKIP }, async () => {
    const tablesOf = async (pred) => {
      const h = home();
      const db = openStore({ home: h, migrations: await select(pred) });
      try {
        return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));
      } finally {
        db.close();
      }
    };
    const at7 = await tablesOf((m) => m.version <= 7);
    const at6 = await tablesOf((m) => m.version <= 6);
    const added = [...at7].filter((t) => !at6.has(t)).sort();
    const rows = adrTableRows();
    assert.deepEqual([...rows.keys()].sort(), added, 'ADR-0009 names exactly the tables of 007');
    const db = openStore({ home: home(), migrations: await select((m) => m.version <= 7) });
    try {
      for (const t of added) {
        for (const c of columns(db, t)) assert.match(rows.get(t), new RegExp(`\\b${c}\\b`), `ADR-0009 names ${t}.${c}`);
      }
    } finally {
      db.close();
    }
  });
});
