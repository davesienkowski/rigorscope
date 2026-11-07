// Plan 03-01 (LEDG-02, D-01..D-07): the forward ledger writer, `unit-start` and `unit-close`, through the real CLI on
// temporary HOMEs only. The tracer (Task 1) is written first and fails until the commands exist; Task 2 adds the rule
// and file-safety cases to this file. Every run uses a HOME from makeHome(); the real ~/.rigorscope is never touched.
// Environment variables reach the child only through cliEnv's `extra` (cliEnv never inherits the running session's).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  cliEnv, ingestHome, makeAssistant, makeHome, makeUsage, mangleHome, queryDb, runCli, runCliAsync, stateDirOf, writeJsonl,
} from '../fixtures/build.mjs';
import { FIXTURE_NOW } from '../fixtures/clock.mjs';
import {
  commitAll, makeRepo, writePhaseDir, writeQuickDir,
} from '../fixtures/git-repo.mjs';
import { buildUnitsHome } from '../fixtures/units-home.mjs';
import { REJECT_REASONS } from '../../src/ledger/line.mjs';

const KEY = 'gsd-core:~/repos/alpha/.git:quick:261030-a1b';
const ledgerOf = (home) => join(stateDirOf(home), 'ledger', 'units.jsonl');
const linesOf = (text) => text.split('\n').filter((l) => l !== '');
const parsed = (home) => linesOf(readFileSync(ledgerOf(home), 'utf8')).map((l) => JSON.parse(l));

describe('tracer: unit-start then unit-close for one quick unit (03-01 Task 1)', () => {
  let ctx;
  let built;
  before(async () => {
    ctx = makeHome();
    built = buildUnitsHome({ home: ctx.home, root: ctx.root });
    await ingestHome(ctx.home);
  });
  after(() => ctx.cleanup());

  const call = (cwd, name, extra = []) => runCli(
    [name, '--kind', 'quick', '--id', '261030-a1b', ...extra], { home: ctx.home, env: cliEnv(ctx.home), cwd },
  );

  it('from the linked worktree both calls print one line, write two lines and the key equals the reconstruction key', () => {
    const s = call(built.worktree, 'unit-start', ['--tier-source', 'plan-at-start']);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.stdout, `ledger: start ${KEY}\n`);
    const c = call(built.worktree, 'unit-close', ['--status', 'complete']);
    assert.equal(c.status, 0, c.stderr);
    assert.equal(c.stdout, `ledger: close ${KEY}\n`);

    const text = readFileSync(ledgerOf(ctx.home), 'utf8');
    const lines = parsed(ctx.home);
    assert.equal(lines.length, 2);
    assert.equal(text.split('\n').length, 3, 'two LF-terminated lines');
    for (const l of lines) assert.equal(l.unit_key, KEY);

    const unit = queryDb(join(stateDirOf(ctx.home), 'store.db'), "SELECT unit_key FROM unit_obs WHERE native_id = '261030-a1b'");
    assert.deepEqual(unit.map((r) => r.unit_key), [KEY], 'the ledger key is the key ingest reconstructs');

    const [start, close] = lines;
    assert.equal(start.v, 1);
    assert.equal(start.record, 'start');
    assert.equal(start.tier, 'A');
    assert.equal(start.tier_source, 'plan-at-start');
    assert.equal(start.start, FIXTURE_NOW);
    assert.equal(start.model_hint, null);
    assert.equal(close.record, 'close');
    assert.equal(close.status, 'complete');
    assert.equal(close.start, null);
    assert.equal(close.end, FIXTURE_NOW);

    for (const blob of [s.stdout, c.stdout, text]) assert.ok(!blob.includes(ctx.home), 'no HOME path anywhere');
  });

  it('the same call from the main checkout gives the same key', () => {
    const r = call(built.alpha, 'unit-start', ['--tier-source', 'plan-at-start']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `ledger: start ${KEY}\n`);
    assert.equal(parsed(ctx.home).at(-1).unit_key, KEY);
    assert.ok(existsSync(ledgerOf(ctx.home)) && statSync(ledgerOf(ctx.home)).isFile());
  });
});

// ---------------------------------------------------------------------------------------------
// Task 2: rules, rejected calls and file safety. A cheap one-repo HOME per case that needs isolation.
// ---------------------------------------------------------------------------------------------
const UUID = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const bytesOf = (home) => (existsSync(ledgerOf(home)) ? readFileSync(ledgerOf(home)) : null);
const oneLine = (stderr) => {
  const lines = stderr.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1, `stderr is one line: ${lines.length}`);
  return lines[0];
};

function repoHome() {
  const ctx = makeHome();
  const repo = makeRepo(join(ctx.home, 'repos', 'alpha'), { home: ctx.home, files: { 'README.md': 'x\n' } });
  writeQuickDir(repo, { id: '261030-a1b', slug: 'first-task', plan: { tier: 'B words after', body: 'Plan.' } });
  commitAll(repo, { home: ctx.home });
  return { ...ctx, repo };
}

const run = (h, name, extra = [], { env = {}, cwd } = {}) => runCli(
  [name, '--kind', 'quick', '--id', '261030-a1b', ...extra], { home: h.home, env: cliEnv(h.home, env), cwd: cwd ?? h.repo },
);

describe('unit-start and unit-close rules (03-01 Task 2)', () => {
  let h;
  before(() => { h = repoHome(); });
  after(() => h.cleanup());

  it('unknown stays null: no tier, no session id and no --start give null fields, never a default', () => {
    const s = run(h, 'unit-start');
    assert.equal(s.status, 0, s.stderr);
    const c = run(h, 'unit-close');
    assert.equal(c.status, 0, c.stderr);
    const [start, close] = parsed(h.home);
    for (const l of [start, close]) {
      assert.equal(l.tier, null);
      assert.equal(l.tier_source, 'unknown');
      assert.equal(l.session_id, null);
      assert.equal(l.runtime, null);
      assert.equal(l.command, null);
      assert.equal(l.model_hint, null);
      assert.equal(l.gsd_version, null, 'a HOME with no GSD install has no version');
    }
    assert.equal(close.start, null);
    assert.equal(close.status, null);
    assert.equal(start.end, null);
    // a declaration that is absent is never claimed, and a tier needs a source other than unknown
    const before = bytesOf(h.home);
    assert.equal(run(h, 'unit-start', ['--tier-source', 'declared-at-start']).status, 2);
    assert.equal(run(h, 'unit-start', ['--tier', 'A', '--tier-source', 'unknown']).status, 2);
    assert.deepEqual(bytesOf(h.home), before);
  });

  it('tier defaults: --tier alone is declared-at-start on a start and declared-at-close on a close', () => {
    assert.equal(run(h, 'unit-start', ['--tier', 'C']).status, 0);
    assert.equal(run(h, 'unit-close', ['--tier', 'B']).status, 0);
    const [close, start] = parsed(h.home).reverse();
    assert.deepEqual([start.tier, start.tier_source], ['C', 'declared-at-start']);
    assert.deepEqual([close.tier, close.tier_source], ['B', 'declared-at-close']);
  });

  it('plan-at-start reads the tier letter from the PLAN under the work-tree top and degrades to unknown, never a default', () => {
    assert.equal(run(h, 'unit-start', ['--tier-source', 'plan-at-start']).status, 0);
    assert.deepEqual(parsed(h.home).at(-1).tier, 'B');
    // unit with no plan on disk, and a unit whose plan has no tier key
    const noPlan = runCli(['unit-start', '--kind', 'quick', '--id', '261001-zzz', '--tier-source', 'plan-at-start'], {
      home: h.home, env: cliEnv(h.home), cwd: h.repo,
    });
    assert.equal(noPlan.status, 0, noPlan.stderr);
    const l = parsed(h.home).at(-1);
    assert.deepEqual([l.tier, l.tier_source], [null, 'unknown']);
    // plan-at-start with --tier is refused; plan-at-start on a close is refused
    assert.equal(run(h, 'unit-start', ['--tier-source', 'plan-at-start', '--tier', 'A']).status, 2);
    assert.equal(run(h, 'unit-close', ['--tier-source', 'plan-at-start']).status, 2);
  });

  it('session id source: only a lowercase uuid in CLAUDE_CODE_SESSION_ID is taken; --session-id overrides; nothing else is read', () => {
    const cases = [
      [{ CLAUDE_CODE_SESSION_ID: UUID }, UUID],
      [{ CLAUDE_CODE_SESSION_ID: 'someone@example.invalid' }, null],
      [{ CLAUDE_CODE_SESSION_ID: '' }, null],
      [{ CLAUDE_CODE_SESSION_ID: UUID.toUpperCase() }, null],
      [{ CLAUDE_CODE_SESSION_ID: 'not a uuid' }, null],
      [{ CLAUDE_CODE_BRIDGE_SESSION_ID: UUID }, null],
      [{ CLAUDE_CODE_CHILD_SESSION: '1', SESSION_ID: UUID }, null],
    ];
    for (const [env, want] of cases) {
      const r = run(h, 'unit-start', [], { env });
      assert.equal(r.status, 0, `${JSON.stringify(Object.keys(env))}: ${r.stderr}`);
      assert.equal(parsed(h.home).at(-1).session_id, want, JSON.stringify(env));
    }
    assert.equal(run(h, 'unit-start', ['--session-id', 'ide:worker-7'], { env: { CLAUDE_CODE_SESSION_ID: UUID } }).status, 0);
    assert.equal(parsed(h.home).at(-1).session_id, 'ide:worker-7');
    const before = bytesOf(h.home);
    assert.equal(run(h, 'unit-start', ['--session-id', 'has space']).status, 2);
    assert.equal(run(h, 'unit-start', ['--session-id', 'a@b.invalid']).status, 2);
    assert.deepEqual(bytesOf(h.home), before);
  });

  it('runtime is claude-code only when CLAUDECODE is set; a leading slash is cut from --command', () => {
    assert.equal(run(h, 'unit-start', ['--command', '/gsd-quick'], { env: { CLAUDECODE: '1' } }).status, 0);
    const l = parsed(h.home).at(-1);
    assert.equal(l.runtime, 'claude-code');
    assert.equal(l.command, 'gsd-quick');
    assert.equal(run(h, 'unit-start', ['--runtime', 'codex']).status, 0);
    assert.equal(parsed(h.home).at(-1).runtime, 'codex');
  });

  it('a close with no start line is valid; a duplicate start appends; identical calls under the fixed clock repeat the line_id', () => {
    const h2 = repoHome();
    try {
      assert.equal(run(h2, 'unit-close', ['--status', 'failed']).status, 0);
      assert.equal(run(h2, 'unit-start').status, 0);
      assert.equal(run(h2, 'unit-start').status, 0);
      const ls = parsed(h2.home);
      assert.equal(ls.length, 3);
      assert.equal(ls[0].start, null);
      assert.equal(ls[0].status, 'failed');
      assert.equal(ls[1].line_id, ls[2].line_id, 'identical calls under a fixed clock collide');
      assert.notEqual(ls[0].line_id, ls[1].line_id);
    } finally {
      h2.cleanup();
    }
  });

  it('end before start is rejected; a close may carry --start', () => {
    const before = bytesOf(h.home);
    assert.equal(run(h, 'unit-close', ['--start', '2026-10-28T13:00:00Z', '--end', '2026-10-28T12:00:00Z']).status, 2);
    assert.deepEqual(bytesOf(h.home), before);
    assert.equal(run(h, 'unit-close', ['--start', '2026-10-28T11:00:00Z']).status, 0);
    assert.equal(parsed(h.home).at(-1).start, '2026-10-28T11:00:00.000Z', 'stored in one UTC form with milliseconds');
  });

  it('append only: after each accepted call the earlier bytes are a byte-identical prefix', () => {
    let prev = bytesOf(h.home);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(run(h, 'unit-start', ['--start', `2026-10-28T10:0${i}:00Z`]).status, 0);
      const now = bytesOf(h.home);
      assert.deepEqual(now.subarray(0, prev.length), prev);
      assert.ok(now.length > prev.length);
      prev = now;
    }
  });

  it('start does not accept the close-only flags', () => {
    const before = bytesOf(h.home);
    assert.equal(run(h, 'unit-start', ['--status', 'complete']).status, 2);
    assert.equal(run(h, 'unit-start', ['--end', '2026-10-28T12:00:00Z']).status, 2);
    assert.deepEqual(bytesOf(h.home), before);
  });
});

describe('rejected calls (03-01 Task 2)', () => {
  const MARK = 'ZZmark';
  // [name, args, reject code]: the code names the one fixed message the call must print (never an "unknown command").
  const REJECTS = [
    ['slug-suffixed quick id', ['--kind', 'quick', '--id', '261030-a1b-first-task'], 'bad_id'],
    ['short plan id', ['--kind', 'plan', '--id', '2-01'], 'bad_id'],
    ['over-dotted plan id', ['--kind', 'plan', '--id', '02.1.1-01'], 'bad_id'],
    ['plan id with kind quick', ['--kind', 'quick', '--id', '03-01'], 'bad_id'],
    ['unknown kind', ['--kind', `epic${MARK}`, '--id', '261030-a1b'], 'bad_kind'],
    ['missing kind', ['--id', '261030-a1b'], 'bad_kind'],
    ['missing id', ['--kind', 'quick'], 'bad_id'],
    ['empty id', ['--kind', 'quick', '--id', ''], 'bad_id'],
    ['newline-bearing id', ['--kind', 'quick', '--id', `261030-a1b\n${MARK}`], 'bad_id'],
    ['lowercase tier', ['--kind', 'quick', '--id', '261030-a1b', '--tier', `a${MARK}`], 'bad_tier'],
    ['unknown tier source', ['--kind', 'quick', '--id', '261030-a1b', '--tier', 'A', '--tier-source', `guess${MARK}`], 'bad_tier_source'],
    ['bad command', ['--kind', 'quick', '--id', '261030-a1b', '--command', `a b ${MARK}`], 'bad_command'],
    ['bad runtime', ['--kind', 'quick', '--id', '261030-a1b', '--runtime', `Bad${MARK}`], 'bad_runtime'],
    ['bad start time', ['--kind', 'quick', '--id', '261030-a1b', '--start', `2026-13-45T00:00:00Z${MARK}`], 'bad_start'],
    ['bad session id', ['--kind', 'quick', '--id', '261030-a1b', '--session-id', `a b${MARK}`], 'bad_session_id'],
  ];

  let h;
  before(() => { h = repoHome(); });
  after(() => h.cleanup());

  it('rejected call leaves the ledger byte-identical: absent stays absent, present is unchanged, exit 2', () => {
    for (const [name, args, code] of REJECTS) {
      const r = runCli(['unit-start', ...args], { home: h.home, env: cliEnv(h.home), cwd: h.repo });
      assert.equal(r.status, 2, name);
      assert.equal(r.stdout, '', name);
      assert.equal(r.stderr, `rigorscope: ${REJECT_REASONS[code]}\n`, `${name}: the specific reject reason ${code}`);
      assert.ok(!existsSync(stateDirOf(h.home)), `${name}: no state directory was created`);
    }
    const badStatus = runCli(['unit-close', '--kind', 'quick', '--id', '261030-a1b', '--status', 'done'], {
      home: h.home, env: cliEnv(h.home), cwd: h.repo,
    });
    assert.equal(badStatus.status, 2);
    assert.equal(badStatus.stderr, `rigorscope: ${REJECT_REASONS.bad_status}\n`);
    assert.ok(!existsSync(stateDirOf(h.home)));
    // now with a ledger present
    assert.equal(run(h, 'unit-start').status, 0);
    const before = bytesOf(h.home);
    for (const [name, args, code] of REJECTS) {
      const r = runCli(['unit-close', ...args], { home: h.home, env: cliEnv(h.home), cwd: h.repo });
      assert.equal(r.status, 2, name);
      assert.equal(r.stderr, `rigorscope: ${REJECT_REASONS[code]}\n`, `${name}: the specific reject reason ${code}`);
      assert.deepEqual(bytesOf(h.home), before, name);
    }
  });

  it('a cwd that is not in a git repository exits 2 and writes nothing', () => {
    const plain = join(h.home, 'plain');
    mkdirSync(plain, { recursive: true });
    const before = bytesOf(h.home);
    const r = run(h, 'unit-start', [], { cwd: plain });
    assert.equal(r.status, 2);
    assert.deepEqual(bytesOf(h.home), before);
    oneLine(r.stderr);
  });

  it('fixed messages echo no value: one stderr line without the supplied value, the HOME path or the key', () => {
    const seen = new Set();
    for (const [name, args] of REJECTS) {
      const r = runCli(['unit-start', ...args], { home: h.home, env: cliEnv(h.home), cwd: h.repo });
      const line = oneLine(r.stderr);
      assert.match(line, /^rigorscope: /, name);
      assert.ok(!line.includes(MARK), `${name}: the value is not echoed`);
      assert.ok(!line.includes(h.home) && !line.includes('gsd-core:') && !line.includes('261030'), name);
      seen.add(line);
    }
    assert.ok(seen.size > 5, 'distinct fixed messages, not one catch-all');
    const flagErr = runCli(['unit-start', '--kind', 'quick', '--id', '261030-a1b', '--nope', MARK], { home: h.home, env: cliEnv(h.home), cwd: h.repo });
    assert.equal(flagErr.status, 2);
  });
});

describe('ledger file safety (03-01 Task 2)', () => {
  it('file mode 0600, ledger directory 0700, and a wider existing mode is narrowed', () => {
    const h = repoHome();
    try {
      assert.equal(run(h, 'unit-start').status, 0);
      const dir = join(stateDirOf(h.home), 'ledger');
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(ledgerOf(h.home)).mode & 0o777, 0o600);
      chmodSync(dir, 0o755);
      chmodSync(ledgerOf(h.home), 0o644);
      assert.equal(run(h, 'unit-start').status, 0);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(ledgerOf(h.home)).mode & 0o777, 0o600);
    } finally {
      h.cleanup();
    }
  });

  it('a symlinked ledger directory exits 1 and writes nothing through it', () => {
    const h = repoHome();
    try {
      const target = join(h.home, 'elsewhere');
      mkdirSync(target, { recursive: true });
      mkdirSync(stateDirOf(h.home), { mode: 0o700 });
      symlinkSync(target, join(stateDirOf(h.home), 'ledger'));
      const r = run(h, 'unit-start');
      assert.equal(r.status, 1);
      assert.deepEqual(readdirSync(target), []);
      assert.ok(!r.stderr.includes(h.home), 'the message holds no path');
    } finally {
      h.cleanup();
    }
  });

  it('a symlinked units.jsonl exits 1 and the target is untouched', () => {
    const h = repoHome();
    try {
      const victim = join(h.home, 'victim.txt');
      writeFileSync(victim, 'untouched');
      mkdirSync(join(stateDirOf(h.home), 'ledger'), { recursive: true, mode: 0o700 });
      symlinkSync(victim, ledgerOf(h.home));
      const r = run(h, 'unit-start');
      assert.equal(r.status, 1);
      assert.equal(readFileSync(victim, 'utf8'), 'untouched');
      assert.ok(!r.stderr.includes(h.home));
      // a dangling link is refused too, and nothing is created at its target
      rmSync(ledgerOf(h.home));
      const gone = join(h.home, 'gone.txt');
      symlinkSync(gone, ledgerOf(h.home));
      assert.equal(run(h, 'unit-start').status, 1);
      assert.ok(!existsSync(gone));
    } finally {
      h.cleanup();
    }
  });

  it('a ledger that is a regular file, and a units.jsonl that is a directory, each exit 1', () => {
    const h = repoHome();
    try {
      mkdirSync(stateDirOf(h.home), { mode: 0o700 });
      writeFileSync(join(stateDirOf(h.home), 'ledger'), 'x');
      const r = run(h, 'unit-start');
      assert.equal(r.status, 1);
      assert.ok(!r.stderr.includes(h.home));
      rmSync(join(stateDirOf(h.home), 'ledger'));
      mkdirSync(ledgerOf(h.home), { recursive: true });
      assert.equal(run(h, 'unit-start').status, 1);
    } finally {
      h.cleanup();
    }
  });

  it('eight concurrent starts give eight whole parseable lines', async () => {
    const h = repoHome();
    try {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runCliAsync(
        ['unit-start', '--kind', 'quick', '--id', '261030-a1b', '--start', `2026-10-28T10:00:0${i}Z`],
        { home: h.home, env: cliEnv(h.home), cwd: h.repo },
      )));
      for (const r of results) assert.equal(r.status, 0, r.stderr);
      const text = readFileSync(ledgerOf(h.home), 'utf8');
      assert.ok(text.endsWith('\n'));
      const lines = text.split('\n').slice(0, -1);
      assert.equal(lines.length, 8);
      const parsedLines = lines.map((l) => JSON.parse(l));
      assert.equal(new Set(parsedLines.map((l) => l.start)).size, 8);
      for (const l of parsedLines) assert.equal(l.unit_key, KEY);
    } finally {
      h.cleanup();
    }
  });
});

describe('start and end are bounded by the recorded time (03-01 review MEDIUM-1)', () => {
  let h;
  before(() => { h = repoHome(); });
  after(() => h.cleanup());

  const LATER = '2026-10-28T12:00:01Z'; // one second after the fixed clock
  const MSG = `rigorscope: ${REJECT_REASONS.time_after_ts}\n`;

  it('unit-start with --start later than ts exits 2 with the fixed message and leaves the file byte-identical', () => {
    assert.equal(run(h, 'unit-start').status, 0);
    const before = bytesOf(h.home);
    const r = run(h, 'unit-start', ['--start', LATER]);
    assert.equal(r.status, 2, r.stdout);
    assert.equal(r.stderr, MSG);
    assert.equal(r.stdout, '');
    assert.deepEqual(bytesOf(h.home), before);
    assert.equal(run(h, 'unit-start', ['--start', '2030-01-01T00:00:00Z']).status, 2);
    assert.deepEqual(bytesOf(h.home), before);
    // equal to ts is fine
    assert.equal(run(h, 'unit-start', ['--start', FIXTURE_NOW]).status, 0);
  });

  it('unit-close with --end later than ts, or --start later than ts, exits 2 with the fixed message and leaves the file byte-identical', () => {
    const before = bytesOf(h.home);
    const EBS = `rigorscope: ${REJECT_REASONS.end_before_start}\n`; // a lone late --start: the end defaults to ts, so it is before the start
    for (const [extra, msg] of [
      [['--end', LATER], MSG], [['--start', LATER, '--end', LATER], MSG], [['--start', LATER], EBS],
      [['--start', '2030-01-01T00:00:00Z', '--end', '2030-01-01T00:00:01Z'], MSG],
    ]) {
      const r = run(h, 'unit-close', extra);
      assert.equal(r.status, 2, extra.join(' '));
      assert.equal(r.stderr, msg, extra.join(' '));
      assert.deepEqual(bytesOf(h.home), before, extra.join(' '));
    }
    assert.equal(run(h, 'unit-close', ['--end', FIXTURE_NOW]).status, 0);
  });
});

describe('torn tail, unwritable state directory and a FIFO (03-01 review LOW-1, LOW-2, LOW-10)', () => {
  it('a torn tail (no trailing newline) is closed by a leading LF so the next line is never glued to it; one write still', () => {
    const h = repoHome();
    try {
      mkdirSync(join(stateDirOf(h.home), 'ledger'), { recursive: true, mode: 0o700 });
      const torn = '{"v":1,"record":"sta';
      writeFileSync(ledgerOf(h.home), torn, { mode: 0o600 });
      assert.equal(run(h, 'unit-start').status, 0);
      const text = readFileSync(ledgerOf(h.home), 'utf8');
      assert.ok(text.startsWith(`${torn}\n{`), 'the torn bytes end at an LF and the new line starts after it');
      const lines = linesOf(text);
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[1]).unit_key, KEY);
      assert.ok(text.endsWith('\n'));
      // a whole file gets no extra blank line, and an empty file gets no leading LF
      assert.equal(run(h, 'unit-close').status, 0);
      assert.equal(readFileSync(ledgerOf(h.home), 'utf8').split('\n').length, 4, 'three lines and the final LF, no blank line');
      const e = repoHome();
      try {
        mkdirSync(join(stateDirOf(e.home), 'ledger'), { recursive: true, mode: 0o700 });
        writeFileSync(ledgerOf(e.home), '', { mode: 0o600 });
        assert.equal(run(e, 'unit-start').status, 0);
        assert.ok(readFileSync(ledgerOf(e.home), 'utf8').startsWith('{'), 'no leading LF in an empty file');
      } finally {
        e.cleanup();
      }
    } finally {
      h.cleanup();
    }
  });

  it('an unwritable HOME exits 1 with a fixed state-directory message, not an internal error, and no path', (t) => {
    if (process.getuid?.() === 0) { t.skip('root ignores directory modes'); return; }
    const h = repoHome();
    try {
      chmodSync(h.home, 0o500);
      const r = run(h, 'unit-start');
      assert.equal(r.status, 1, r.stdout);
      assert.ok(!r.stderr.includes('internal error'), r.stderr);
      assert.ok(!r.stderr.includes(h.home), 'the message holds no path');
      assert.ok(!/EACCES|EPERM/.test(r.stderr), 'no raw error code');
      assert.equal(r.stderr, 'rigorscope: ledger: cannot write the state directory\n');
      assert.equal(r.stdout, '');
    } finally {
      chmodSync(h.home, 0o700);
      h.cleanup();
    }
  });

  it('a FIFO at the ledger path does not hang the call: it exits 1 within the timeout', (t) => {
    const h = repoHome();
    try {
      mkdirSync(join(stateDirOf(h.home), 'ledger'), { recursive: true, mode: 0o700 });
      try {
        execFileSync('mkfifo', [ledgerOf(h.home)]);
      } catch {
        t.skip('mkfifo is not available');
        return;
      }
      const r = runCli(
        ['unit-start', '--kind', 'quick', '--id', '261030-a1b'],
        { home: h.home, env: cliEnv(h.home), cwd: h.repo, timeoutMs: 8000, allowSignal: true },
      );
      assert.equal(r.signal, null, 'the call was not killed by the timeout (it did not hang)');
      assert.equal(r.status, 1, r.stderr);
      assert.ok(!r.stderr.includes(h.home));
      assert.ok(!r.stderr.includes('internal error'), r.stderr);
    } finally {
      h.cleanup();
    }
  });
});

describe('plan units end to end: the ledger key equals the reconstruction key (03-01 review LOW-5)', () => {
  let ctx;
  let alpha;
  before(async () => {
    ctx = makeHome();
    alpha = makeRepo(join(ctx.home, 'repos', 'alpha'), { home: ctx.home, files: { 'README.md': 'x\n' } });
    writePhaseDir(alpha, { name: '03-links', files: { '03-01-PLAN.md': '---\ntier: B\n---\n\nPlan.\n' } });
    writePhaseDir(alpha, { name: '02.1-decimal', files: { '02.1-01-PLAN.md': '---\ntier: C\n---\n\nPlan.\n' } });
    commitAll(alpha, { home: ctx.home });
    const session = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
    const line = makeAssistant({
      session, ts: '2026-10-27T15:00:01.000Z', id: 'msg_plan_1', model: 'claude-opus-5-5', cwd: alpha,
      use: makeUsage({ input: 10, output: 5, read: 0, creation: 0 }),
    });
    writeJsonl(join(ctx.root, 'projects', mangleHome(alpha), `${session}.jsonl`), [JSON.stringify(line)]);
    await ingestHome(ctx.home);
  });
  after(() => ctx.cleanup());

  for (const [id, tier] of [['03-01', 'B'], ['02.1-01', 'C']]) {
    it(`kind plan, id ${id}: both calls write the key ingest reconstructs, and plan-at-start reads tier ${tier}`, () => {
      const call = (name, extra = []) => runCli(
        [name, '--kind', 'plan', '--id', id, ...extra], { home: ctx.home, env: cliEnv(ctx.home), cwd: alpha },
      );
      const want = `gsd-core:~/repos/alpha/.git:plan:${id}`;
      const s = call('unit-start', ['--tier-source', 'plan-at-start']);
      assert.equal(s.status, 0, s.stderr);
      assert.equal(s.stdout, `ledger: start ${want}\n`);
      const c = call('unit-close', ['--status', 'complete']);
      assert.equal(c.status, 0, c.stderr);
      assert.equal(c.stdout, `ledger: close ${want}\n`);
      const mine = parsed(ctx.home).filter((l) => l.native_id === id);
      assert.equal(mine.length, 2);
      for (const l of mine) assert.equal(l.unit_key, want);
      assert.deepEqual([mine[0].tier, mine[0].tier_source], [tier, 'plan-at-start']);
      const unit = queryDb(
        join(stateDirOf(ctx.home), 'store.db'), `SELECT unit_key FROM unit_obs WHERE native_id = '${id}'`,
      );
      assert.deepEqual(unit.map((r) => r.unit_key), [want], 'the ledger key is the key ingest reconstructs');
    });
  }
});
