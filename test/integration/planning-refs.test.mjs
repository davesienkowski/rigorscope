// Plan 02-04 tracer (UNIT-06 input, D-12 with amendment Q4, D-14, D-24): a planning-file ref read by a structured
// tool_use field travels from the transcript through the ref extractor, the writer and migration 007's
// `transcript-refs` section into the repo resolver and the gsd-core adapter, so the referenced repo's quick unit is
// listed by `rigorscope units --json` although that repo was never a session cwd. A Bash tool_use in the same session
// names another planning path inside its command string; it is never stored (amendment Q4). Written before the code
// (RED).
//
// Every run spawns the CLI on a temporary HOME from makeHome(); the git repository is created by
// test/fixtures/git-repo.mjs inside that HOME. The `units --json` listing is its own test and runs first; no shared
// setup queries a table that does not exist before the code.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cliEnv, makeAssistant, makeHome, makeUsage, mangleHome, queryDb, runCli, sha256, stateDirOf, writeJsonl,
} from '../fixtures/build.mjs';
import {
  assertOutsideWorkTree, commitAll, makeRepo, writeQuickDir,
} from '../fixtures/git-repo.mjs';

const SESSION = 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4';
const UNIT_KEY = 'gsd-core:~/repos/alpha/.git:quick:261030-a1b';
const READ_REL = '.planning/quick/261030-a1b-first-task/261030-a1b-PLAN.md';
const BASH_SLUG = '261031-cnb-bash-only';
const STORE = (home) => join(stateDirOf(home), 'store.db');

function buildHome(home, root) {
  assertOutsideWorkTree(join(home, '..'));
  const alpha = join(home, 'repos', 'alpha');
  makeRepo(alpha, { home, files: { 'README.md': 'alpha fixture\n' } });
  writeQuickDir(alpha, {
    id: '261030-a1b', slug: 'first-task', plan: { tier: 'A', body: 'Plan body.' }, summary: null,
  });
  commitAll(alpha, { home });
  const beta = join(home, 'work', 'beta');
  mkdirSync(beta, { recursive: true });
  const readPath = join(alpha, READ_REL);
  const bashPath = join(alpha, '.planning', 'quick', BASH_SLUG, '261031-cnb-PLAN.md');
  const use = makeUsage({ input: 10, output: 5, read: 0, creation: 0 });
  const rt1 = makeAssistant({
    session: SESSION, ts: '2026-10-27T15:00:01.000Z', id: 'msg_rt1', model: 'claude-opus-5-5', cwd: beta, use,
    content: [{ type: 'tool_use', id: 'toolu_rt1', name: 'Read', input: { file_path: readPath } }],
  });
  const rt2 = makeAssistant({
    session: SESSION, ts: '2026-10-27T15:00:02.000Z', id: 'msg_rt2', model: 'claude-opus-5-5', cwd: beta, use,
    content: [{
      type: 'tool_use', id: 'toolu_rt2', name: 'Bash', input: { command: `cat ${bashPath}`, description: `Show ${bashPath}` },
    }],
  });
  writeJsonl(join(root, 'projects', mangleHome(beta), `${SESSION}.jsonl`), [JSON.stringify(rt1), JSON.stringify(rt2)]);
}

const refRows = (home) => queryDb(
  STORE(home),
  `SELECT session_id, agent_id, message_id, ref_dir, rel_path, ref_kind, tool_name, n FROM cc_message_ref
    ORDER BY session_id, agent_id, message_id, ref_dir, rel_path`,
);

describe('planning-file refs (tracer)', () => {
  let ctx;
  let env;
  let ingest1;
  before(() => {
    ctx = makeHome();
    buildHome(ctx.home, ctx.root);
    env = cliEnv(ctx.home, { TZ: 'America/New_York' });
    ingest1 = runCli(['ingest'], { home: ctx.home, env });
  });
  after(() => ctx.cleanup());

  it('units --json lists the quick unit of a repo reached only through a Read tool_use ref', () => {
    assert.equal(ingest1.status, 0, ingest1.stderr);
    const r = runCli(['units', '--json'], { home: ctx.home, env });
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    const unit = doc.units.find((u) => u.key === UNIT_KEY);
    assert.ok(unit, `units --json lists ${UNIT_KEY}; listed: ${doc.units.length}`);
    assert.equal(unit.tier.value, 'A');
  });

  it('cc_message_ref holds exactly the Read ref, home-normalized, and nothing of the Bash string', () => {
    assert.deepEqual(refRows(ctx.home), [{
      session_id: SESSION,
      agent_id: '',
      message_id: 'msg_rt1',
      ref_dir: '~/repos/alpha',
      rel_path: READ_REL,
      ref_kind: 'quick',
      tool_name: 'Read',
      n: 1,
    }]);
  });

  it('dir_repo resolves the ref dir by git although alpha was never a cwd, and the plain cwd to none', () => {
    const rows = queryDb(STORE(ctx.home), 'SELECT dir, repo_key, method FROM dir_repo ORDER BY dir');
    assert.deepEqual(rows, [
      { dir: '~/repos/alpha', repo_key: '~/repos/alpha/.git', method: 'git' },
      { dir: '~/work/beta', repo_key: null, method: 'none' },
    ]);
  });

  it('no byte of store.db, its WAL or shm file holds the Bash-only path or the command text', async () => {
    const { checkpointStore } = await import('../../src/db.mjs');
    checkpointStore({ home: ctx.home });
    for (const name of ['store.db', 'store.db-wal', 'store.db-shm']) {
      const file = join(stateDirOf(ctx.home), name);
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file).toString('latin1');
      assert.ok(!bytes.includes(BASH_SLUG), `${name} holds the Bash-only slug`);
      assert.ok(!bytes.includes('cat '), `${name} holds the command text`);
    }
  });

  it('a second ingest leaves cc_message_ref byte-equal', () => {
    const before1 = sha256(JSON.stringify(refRows(ctx.home)));
    const again = runCli(['ingest'], { home: ctx.home, env });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(sha256(JSON.stringify(refRows(ctx.home))), before1);
  });
});
