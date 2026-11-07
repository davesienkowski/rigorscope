// Plan 01-09 contract for the schedule modules (DATA-04, DATA-01, RR-03): unit lint, the node check through the unit's
// own PATH, the systemctl runner, the timer evaluation, the line diff and the install planner and applier. Written
// before the code (RED); every expected value is a hand-written literal. Results are read with ?. so a missing
// implementation fails an assertion and never a TypeError. Temporary directories are removed by their exact path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_UNIT_SERVICE, REPO_UNIT_TIMER, unitDirOf } from '../fixtures/doctor-rows.mjs';
import { makeFakeRun, plantFakeNode } from '../fixtures/fake-bin.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const text = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const SERVICE = text(REPO_UNIT_SERVICE);
const TIMER = text(REPO_UNIT_TIMER);
const tmp = () => mkdtempSync(join(tmpdir(), 'rigorscope sched #'));
const withTmp = async (fn) => {
  const d = tmp();
  try {
    return await fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};
const NOW = Date.parse('2026-10-28T12:00:00.000Z');

describe('unit files and lint', () => {
  it('the repo unit files carry the keys of the plan and nothing else the lint forbids', async () => {
    const { lintUnits } = await mod('schedule/units.mjs');
    assert.deepEqual(lintUnits({ service: SERVICE, timer: TIMER }), []);
  });

  it('the service text holds each fixed key once', () => {
    for (const line of [
      'Type=oneshot', 'Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin', 'UMask=0077', 'NoNewPrivileges=yes', 'Nice=10',
      'TimeoutStartSec=6h', 'ExecStart=/usr/bin/env node %h/repos/rigorscope/bin/rigorscope.mjs ingest',
      'ConditionPathExists=%h/repos/rigorscope/bin/rigorscope.mjs',
    ]) assert.equal(SERVICE.split('\n').filter((l) => l === line).length, 1, line);
  });

  it('the timer text holds each fixed key once', () => {
    for (const line of [
      'OnCalendar=*-*-* 04:10:00', 'Persistent=true', 'RandomizedDelaySec=15min', 'FixedRandomDelay=true',
      'Unit=rigorscope-ingest.service', 'WantedBy=timers.target',
    ]) assert.equal(TIMER.split('\n').filter((l) => l === line).length, 1, line);
  });

  it('INGEST_TIMEOUT_HOURS equals the hours in TimeoutStartSec of the service file', async () => {
    const { INGEST_TIMEOUT_HOURS } = await mod('schedule/units.mjs');
    assert.equal(INGEST_TIMEOUT_HOURS, 6);
    assert.equal(`TimeoutStartSec=${INGEST_TIMEOUT_HOURS}h`, SERVICE.split('\n').find((l) => l.startsWith('TimeoutStartSec=')));
  });

  it('the unit files are plain ASCII with LF endings and one trailing newline', () => {
    for (const t of [SERVICE, TIMER]) {
      assert.ok(t.length > 0);
      assert.ok(!/[^\x00-\x7f]/.test(t));
      assert.ok(!t.includes('\r'));
      assert.ok(t.endsWith('\n') && !t.endsWith('\n\n'));
      assert.ok(!/^User=/m.test(t));
    }
  });

  // [title, which file, mutation, expected violation code]
  const MUTATIONS = [
    ['a missing Persistent line', 'timer', (t) => t.replace('Persistent=true\n', ''), 'timer_persistent'],
    ['PATH entries swapped so %h/.local/bin is not first', 'service', (t) => t.replace('%h/.local/bin:/usr/local/bin', '/usr/local/bin:%h/.local/bin'), 'service_path_first'],
    ['Type=simple', 'service', (t) => t.replace('Type=oneshot', 'Type=simple'), 'service_type'],
    ['a missing UMask', 'service', (t) => t.replace('UMask=0077\n', ''), 'service_umask'],
    ['a missing NoNewPrivileges', 'service', (t) => t.replace('NoNewPrivileges=yes\n', ''), 'service_no_new_privileges'],
    ['a missing Nice', 'service', (t) => t.replace('Nice=10\n', ''), 'service_nice'],
    ['TimeoutStartSec different from INGEST_TIMEOUT_HOURS', 'service', (t) => t.replace('TimeoutStartSec=6h', 'TimeoutStartSec=5h'), 'service_timeout'],
    ['another ExecStart', 'service', (t) => t.replace('ingest\n', 'cost\n'), 'service_execstart'],
    ['a missing ConditionPathExists', 'service', (t) => t.replace(/ConditionPathExists=.*\n/, ''), 'service_condition'],
    ['Unit= naming another service', 'timer', (t) => t.replace('Unit=rigorscope-ingest.service', 'Unit=other.service'), 'timer_unit'],
    ['a missing WantedBy', 'timer', (t) => t.replace('WantedBy=timers.target\n', ''), 'timer_wantedby'],
    ['an OnCalendar hour below 4', 'timer', (t) => t.replace('04:10:00', '03:10:00'), 'timer_hour'],
    ['an OnCalendar hour above 22', 'timer', (t) => t.replace('04:10:00', '23:10:00'), 'timer_hour'],
    ['a missing RandomizedDelaySec', 'timer', (t) => t.replace('RandomizedDelaySec=15min\n', ''), 'timer_delay'],
    ['a missing FixedRandomDelay', 'timer', (t) => t.replace('FixedRandomDelay=true\n', ''), 'timer_fixed_delay'],
    ['a non-ASCII byte', 'service', (t) => `${t}# café\n`, 'non_ascii'],
    ['a User= line', 'service', (t) => t.replace('UMask=0077', 'UMask=0077\nUser=someone'), 'user_line'],
  ];
  for (const [title, which, mutate, code] of MUTATIONS) {
    it(`lint flags ${title} with ${code}`, async () => {
      const { lintUnits } = await mod('schedule/units.mjs');
      const input = { service: SERVICE, timer: TIMER };
      input[which] = mutate(input[which]);
      assert.ok(input[which] !== (which === 'service' ? SERVICE : TIMER), 'the mutation changed the text');
      assert.ok(lintUnits(input)?.includes(code), `expected ${code}`);
    });
  }

  it('unitDir honors an absolute XDG_CONFIG_HOME, ignores a relative one, and falls back to HOME/.config/systemd/user', async () => {
    const { unitDir } = await mod('schedule/units.mjs');
    assert.equal(unitDir({ home: '/h', env: { XDG_CONFIG_HOME: '/x/cfg' } }), '/x/cfg/systemd/user');
    assert.equal(unitDir({ home: '/h', env: { XDG_CONFIG_HOME: 'rel' } }), '/h/.config/systemd/user');
    assert.equal(unitDir({ home: '/h', env: {} }), '/h/.config/systemd/user');
  });

  const analyze = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
  const hasAnalyze = analyze.status === 0;
  it('systemd-analyze calendar normalizes OnCalendar to *-*-* 04:10:00', { skip: hasAnalyze ? false : 'systemd-analyze is not installed' }, () => {
    const r = spawnSync('systemd-analyze', ['calendar', '*-*-* 04:10:00'], { encoding: 'utf8' });
    assert.match(r.stdout, /Normalized form: \*-\*-\* 04:10:00/);
  });

  const verify = (dir, serviceText, timerText) => {
    writeFileSync(join(dir, 'rigorscope-ingest.service'), serviceText);
    writeFileSync(join(dir, 'rigorscope-ingest.timer'), timerText);
    return spawnSync('systemd-analyze', ['--user', 'verify', join(dir, 'rigorscope-ingest.service'), join(dir, 'rigorscope-ingest.timer')], { encoding: 'utf8' });
  };
  it('systemd-analyze --user verify prints nothing on stderr for the repo files, and a misspelled key prints a warning', async (t) => {
    if (!hasAnalyze) { t.skip('systemd-analyze is not installed'); return; }
    await withTmp((d) => {
      const good = verify(d, SERVICE, TIMER);
      if (/Failed to initialize manager/.test(good.stderr)) { t.skip('systemd-analyze --user cannot initialize a manager here'); return; }
      assert.equal(good.stderr, '');
      assert.ok(SERVICE.length > 0, 'the repo service file exists');
      const bad = verify(d, SERVICE.replace('UMask=0077', 'UMaskk=0077'), TIMER);
      assert.notEqual(bad.stderr, '', 'the check can fail');
    });
  });
});

describe('node check through the unit PATH', () => {
  it('parseUnitPath splits the PATH literal on colons and expands %h per entry', async () => {
    const { parseUnitPath } = await mod('schedule/node-check.mjs');
    assert.deepEqual(parseUnitPath(SERVICE, '/home x'), ['/home x/.local/bin', '/usr/local/bin', '/usr/bin', '/bin']);
  });

  it('parseUnitPath keeps four entries when HOME holds a colon, a space and a hash', async () => {
    const { parseUnitPath } = await mod('schedule/node-check.mjs');
    assert.deepEqual(parseUnitPath('Environment=PATH=%h/.local/bin:/usr/bin:/bin\n', '/t/a:b c#d'), ['/t/a:b c#d/.local/bin', '/usr/bin', '/bin']);
  });

  it('parseUnitPath returns an empty list when there is no PATH line', async () => {
    const { parseUnitPath } = await mod('schedule/node-check.mjs');
    assert.deepEqual(parseUnitPath('[Service]\nType=oneshot\n', '/h'), []);
  });

  const fakeFs = (table) => ({
    statSync: (p) => table[p],
    accessSync: (p) => { if (!table[p]?.exec) throw new Error('not executable'); },
  });
  const file = (exec) => ({ isFile: () => true, exec });
  it('resolveUnitNode returns the first entry holding an executable regular file named node, in order', async () => {
    const { resolveUnitNode } = await mod('schedule/node-check.mjs');
    const fsOps = fakeFs({ '/a/node': file(true), '/b/node': file(true) });
    assert.equal(resolveUnitNode({ dirs: ['/a', '/b'], fsOps }), '/a/node');
  });

  it('resolveUnitNode skips a directory named node, a non-executable file and a missing entry', async () => {
    const { resolveUnitNode } = await mod('schedule/node-check.mjs');
    const fsOps = fakeFs({ '/a/node': { isFile: () => false, exec: true }, '/b/node': file(false), '/d/node': file(true) });
    assert.equal(resolveUnitNode({ dirs: ['/a', '/b', '/c', '/d'], fsOps }), '/d/node');
  });

  it('resolveUnitNode returns null when no entry holds a node', async () => {
    const { resolveUnitNode } = await mod('schedule/node-check.mjs');
    assert.equal(resolveUnitNode({ dirs: ['/a', '/b'], fsOps: fakeFs({}) }), null);
  });

  it('resolveUnitNode uses the execute bit of real files', async () => {
    const { resolveUnitNode } = await mod('schedule/node-check.mjs');
    await withTmp((d) => {
      mkdirSync(join(d, 'a')); mkdirSync(join(d, 'b'));
      writeFileSync(join(d, 'a', 'node'), '#!/bin/sh\n', { mode: 0o644 });
      writeFileSync(join(d, 'b', 'node'), '#!/bin/sh\n', { mode: 0o755 });
      chmodSync(join(d, 'b', 'node'), 0o755);
      assert.equal(resolveUnitNode({ dirs: [join(d, 'a'), join(d, 'b')] }), join(d, 'b', 'node'));
    });
  });

  // [version text, sqlite, expected status]
  const VERSIONS = [
    ['v24.14.9\n', true, 'below_floor'], ['v24.15.0\n', true, 'ok'], ['v24.22.1\n', true, 'ok'], ['v24.100.0\n', true, 'ok'],
    ['v25.0.0\n', true, 'ok'], ['v22.22.3\n', true, 'below_floor'], ['v24.22.1\n', false, 'no_sqlite'],
    ['', true, 'unusable'], ['v24.22.1\nv24.22.2\n', true, 'unusable'], ['24\n', true, 'unusable'], ['garbage\n', true, 'unusable'],
    ['v24.22\n', true, 'unusable'],
  ];
  for (const [version, sqlite, status] of VERSIONS) {
    it(`checkUnitNode: version output ${JSON.stringify(version)} with sqlite ${sqlite} is ${status}`, async () => {
      const { checkUnitNode } = await mod('schedule/node-check.mjs');
      const home = '/h';
      const path = '/h/.local/bin/node';
      const run = makeFakeRun('active', { [path]: { version, sqlite } });
      const fsOps = fakeFs({ [path]: file(true) });
      const r = checkUnitNode({ home, serviceText: SERVICE, run, fsOps });
      assert.equal(r?.status, status);
      assert.equal(r?.floor, '24.15.0');
    });
  }

  it('checkUnitNode prints the node path home-normalized and returns the version text', async () => {
    const { checkUnitNode } = await mod('schedule/node-check.mjs');
    const path = '/h/.local/bin/node';
    const r = checkUnitNode({ home: '/h', serviceText: SERVICE, run: makeFakeRun('active', { [path]: { version: 'v24.22.1\n' } }), fsOps: fakeFs({ [path]: file(true) }) });
    assert.equal(r?.display, '~/.local/bin/node');
    assert.equal(r?.version, 'v24.22.1');
  });

  it('checkUnitNode reports not_found when no entry holds a node, and unusable on a run error or timeout', async () => {
    const { checkUnitNode } = await mod('schedule/node-check.mjs');
    const none = checkUnitNode({ home: '/h', serviceText: SERVICE, run: makeFakeRun('active', {}), fsOps: fakeFs({}) });
    assert.equal(none?.status, 'not_found');
    const path = '/h/.local/bin/node';
    for (const entry of [{ timeout: true }, undefined]) {
      const r = checkUnitNode({ home: '/h', serviceText: SERVICE, run: makeFakeRun('active', entry ? { [path]: entry } : {}), fsOps: fakeFs({ [path]: file(true) }) });
      assert.equal(r?.status, 'unusable');
    }
  });

  it('the floor comes from src/preflight.mjs: no second version literal in node-check.mjs', () => {
    const src = text(new URL('../../src/schedule/node-check.mjs', import.meta.url).pathname);
    assert.ok(src.includes('checkRuntime') && src.includes('NODE_FLOOR'));
    assert.ok(!/24\.15/.test(src.replace(/\/\/.*$/gm, '')), 'no 24.15 literal outside comments');
  });
});

describe('systemctl runner', () => {
  it('runSystemctl prepends --user and calls systemctl through the injected run', async () => {
    const { runSystemctl } = await mod('schedule/systemctl.mjs');
    const run = makeFakeRun('active');
    runSystemctl(run, ['show', 'rigorscope-ingest.timer', '--property=LoadState']);
    assert.deepEqual(run.calls(), [{ file: 'systemctl', args: ['--user', 'show', 'rigorscope-ingest.timer', '--property=LoadState'] }]);
  });

  it('PROBE_TIMEOUT_MS is 10000', async () => {
    assert.equal((await mod('schedule/systemctl.mjs')).PROBE_TIMEOUT_MS, 10000);
  });

  it('defaultRun returns stdout and the exit code through an argument array', async () => {
    const { defaultRun } = await mod('schedule/systemctl.mjs');
    const r = defaultRun(process.execPath, ['-e', 'process.stdout.write("a b;c")'], { env: { PATH: process.env.PATH } });
    assert.equal(r?.code, 0);
    assert.equal(r?.stdout, 'a b;c');
  });

  it('defaultRun gives the child only PATH, HOME, LANG, XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS from the given env', async () => {
    const { defaultRun } = await mod('schedule/systemctl.mjs');
    const env = { PATH: process.env.PATH, HOME: '/h', LANG: 'C', XDG_RUNTIME_DIR: '/r', DBUS_SESSION_BUS_ADDRESS: 'u', SECRET_TOKEN: 'x', RIGORSCOPE_NOW: 'y' };
    const r = defaultRun(process.execPath, ['-e', 'process.stdout.write(Object.keys(process.env).sort().join(","))'], { env });
    const seen = String(r?.stdout ?? '').split(',').filter((k) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k));
    assert.ok(!seen.includes('SECRET_TOKEN') && !seen.includes('RIGORSCOPE_NOW'));
    assert.ok(seen.includes('HOME') && seen.includes('PATH'));
  });

  it('defaultRun returns code null and an error code for a missing binary, and never throws', async () => {
    const { defaultRun } = await mod('schedule/systemctl.mjs');
    const r = defaultRun('/nonexistent/binary-xyz', [], { env: {} });
    assert.equal(r?.code, null);
    assert.equal(r?.error, 'ENOENT');
  });

  it('defaultRun kills a hung child at the timeout and returns ETIMEDOUT', async () => {
    const { defaultRun } = await mod('schedule/systemctl.mjs');
    const r = defaultRun(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { env: { PATH: process.env.PATH }, timeoutMs: 300 });
    assert.equal(r?.code, null);
    assert.equal(r?.error, 'ETIMEDOUT');
  });

  it('systemctl.mjs spawns with an argument array, a kill signal and no shell', () => {
    const src = text(new URL('../../src/schedule/systemctl.mjs', import.meta.url).pathname);
    assert.ok(src.includes('spawnSync') && src.includes('killSignal'));
    assert.ok(!/shell\s*:/.test(src) && !/\bexec(Sync)?\s*\(/.test(src));
  });
});

describe('timer status', () => {
  it('TIMER_PROPERTIES and SERVICE_PROPERTIES are the allowlists of the plan', async () => {
    const { TIMER_PROPERTIES, SERVICE_PROPERTIES } = await mod('schedule/status.mjs');
    assert.deepEqual(TIMER_PROPERTIES, ['LoadState', 'ActiveState', 'UnitFileState', 'Persistent', 'NextElapseUSecRealtime', 'LastTriggerUSec']);
    assert.deepEqual(SERVICE_PROPERTIES, ['LoadState', 'ActiveState', 'Result', 'ExecMainStatus', 'ExecMainExitTimestamp']);
  });

  it('parseShowOutput keeps only allowlisted keys, the last value wins, and a line without = is ignored', async () => {
    const { parseShowOutput } = await mod('schedule/status.mjs');
    const out = parseShowOutput('LoadState=masked\nBogus=1\nnoequals\nLoadState=loaded\nActiveState=active\n', ['LoadState', 'ActiveState']);
    assert.deepEqual({ ...out }, { LoadState: 'loaded', ActiveState: 'active' });
  });

  it('parseShowOutput turns a value that fails its shape check into null', async () => {
    const { parseShowOutput } = await mod('schedule/status.mjs');
    const out = parseShowOutput('ActiveState=active; touch x\nResult=success$(x)\nExecMainStatus=12x\nUnitFileState=weird\n', ['ActiveState', 'Result', 'ExecMainStatus', 'UnitFileState']);
    assert.deepEqual({ ...out }, { ActiveState: null, Result: null, ExecMainStatus: null, UnitFileState: null });
  });

  it('parseShowOutput passes a timestamp only in the display shape; n/a, empty and anything else become null', async () => {
    const { parseShowOutput } = await mod('schedule/status.mjs');
    const keys = ['NextElapseUSecRealtime', 'LastTriggerUSec', 'ExecMainExitTimestamp'];
    const ok = parseShowOutput('NextElapseUSecRealtime=Mon 2026-11-02 04:12:03 EST\nLastTriggerUSec=n/a\nExecMainExitTimestamp=\n', keys);
    assert.deepEqual({ ...ok }, { NextElapseUSecRealtime: 'Mon 2026-11-02 04:12:03 EST', LastTriggerUSec: null, ExecMainExitTimestamp: null });
    const bad = parseShowOutput('NextElapseUSecRealtime=Mon 2026-11-02 04:12:03 EST CANARYuser\n', keys);
    assert.equal(bad?.NextElapseUSecRealtime, null);
  });

  const T = (o = {}) => ({ LoadState: 'loaded', ActiveState: 'active', UnitFileState: 'enabled', Persistent: 'yes', NextElapseUSecRealtime: 'Mon 2026-11-02 04:12:03 EST', LastTriggerUSec: 'Sun 2026-11-01 04:11:40 EDT', ...o });
  const S = (o = {}) => ({ LoadState: 'loaded', ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0', ExecMainExitTimestamp: 'Sun 2026-11-01 04:11:55 EDT', ...o });
  const same = { service: 'same', timer: 'same' };
  it('evaluateTimer: the active case returns the exact result object', async () => {
    const { evaluateTimer } = await mod('schedule/status.mjs');
    const r = evaluateTimer({ files: same, reachable: true, timer: T(), service: S() });
    assert.deepEqual(r && { ...r, serviceFacts: { ...r.serviceFacts }, timerFacts: { ...r.timerFacts } }, {
      state: 'active', serviceOk: true, drift: false,
      serviceFacts: { result: 'success', exitStatus: 0, lastExit: 'Sun 2026-11-01 04:11:55 EDT' },
      timerFacts: { persistent: 'yes', active: 'active', enabled: 'enabled', next: 'Mon 2026-11-02 04:12:03 EST', last: 'Sun 2026-11-01 04:11:40 EDT' },
    });
  });

  // [title, raw, expected state]
  const STATES = [
    ['a unit file absent from the user unit directory is missing', { files: { service: 'same', timer: 'absent' }, reachable: null, timer: null, service: null }, 'missing'],
    ['systemctl not reachable is unavailable', { files: same, reachable: false, timer: null, service: null }, 'unavailable'],
    ['LoadState not-found is missing', { files: same, reachable: true, timer: T({ LoadState: 'not-found', UnitFileState: '' }), service: S() }, 'missing'],
    ['LoadState masked is missing', { files: same, reachable: true, timer: T({ LoadState: 'masked' }), service: S() }, 'missing'],
    ['ActiveState inactive is inactive', { files: same, reachable: true, timer: T({ ActiveState: 'inactive' }), service: S() }, 'inactive'],
    ['UnitFileState disabled is not_enabled', { files: same, reachable: true, timer: T({ UnitFileState: 'disabled' }), service: S() }, 'not_enabled'],
    ['UnitFileState static is not_enabled', { files: same, reachable: true, timer: T({ UnitFileState: 'static' }), service: S() }, 'not_enabled'],
    ['an empty UnitFileState is not_enabled', { files: same, reachable: true, timer: T({ UnitFileState: '' }), service: S() }, 'not_enabled'],
    ['UnitFileState enabled-runtime is active', { files: same, reachable: true, timer: T({ UnitFileState: 'enabled-runtime' }), service: S() }, 'active'],
    ['UnitFileState linked is active', { files: same, reachable: true, timer: T({ UnitFileState: 'linked' }), service: S() }, 'active'],
    ['UnitFileState linked-runtime is active', { files: same, reachable: true, timer: T({ UnitFileState: 'linked-runtime' }), service: S() }, 'active'],
    ['a null ActiveState (failed shape check) is unavailable', { files: same, reachable: true, timer: T({ ActiveState: null }), service: S() }, 'unavailable'],
  ];
  for (const [title, raw, state] of STATES) {
    it(`evaluateTimer: ${title}`, async () => {
      const { evaluateTimer } = await mod('schedule/status.mjs');
      assert.equal(evaluateTimer(raw)?.state, state);
    });
  }

  // [title, service properties, expected serviceOk]
  const SERVICES = [
    ['Result exit-code with status 1 is a failure', S({ Result: 'exit-code', ExecMainStatus: '1' }), false],
    ['Result success with a non-zero exit status is a failure', S({ ExecMainStatus: '3' }), false],
    ['Result success with status 0 is ok', S(), true],
    ['an unknown Result is unknown, never ok', S({ Result: null }), null],
  ];
  for (const [title, service, ok] of SERVICES) {
    it(`evaluateTimer: ${title}`, async () => {
      const { evaluateTimer } = await mod('schedule/status.mjs');
      assert.equal(evaluateTimer({ files: same, reachable: true, timer: T(), service })?.serviceOk, ok);
    });
  }

  it('evaluateTimer: installed text that differs from the repo text sets drift', async () => {
    const { evaluateTimer } = await mod('schedule/status.mjs');
    assert.equal(evaluateTimer({ files: { service: 'differs', timer: 'same' }, reachable: true, timer: T(), service: S() })?.drift, true);
  });

  it('readTimerStatus queries no unit property when a unit file is absent, only whether a user manager exists', async () => {
    const { readTimerStatus } = await mod('schedule/status.mjs');
    await withTmp((home) => {
      const run = makeFakeRun('active');
      const raw = readTimerStatus({ home, env: {}, run, repoUnits: { service: SERVICE, timer: TIMER } });
      assert.equal(raw?.files?.timer, 'absent');
      assert.deepEqual(run.calls().map((c) => c.args.join(' ')), ['--user show-environment']);
      assert.equal(raw.noSystemd, false);
    });
  });

  it('readTimerStatus compares installed bytes with the repo text and queries both units once', async () => {
    const { readTimerStatus } = await mod('schedule/status.mjs');
    await withTmp((home) => {
      const dir = unitDirOf(home);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'rigorscope-ingest.service'), SERVICE);
      writeFileSync(join(dir, 'rigorscope-ingest.timer'), `${TIMER}# local edit\n`);
      const run = makeFakeRun('active');
      const raw = readTimerStatus({ home, env: {}, run, repoUnits: { service: SERVICE, timer: TIMER } });
      assert.deepEqual({ ...raw?.files }, { service: 'same', timer: 'differs' });
      assert.equal(raw?.reachable, true);
      assert.equal(raw?.timer?.LoadState, 'loaded');
      assert.equal(run.calls().length, 2);
    });
  });

  it('readTimerStatus treats a failing systemctl as unreachable', async () => {
    const { readTimerStatus } = await mod('schedule/status.mjs');
    await withTmp((home) => {
      const dir = unitDirOf(home);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'rigorscope-ingest.service'), SERVICE);
      writeFileSync(join(dir, 'rigorscope-ingest.timer'), TIMER);
      const raw = readTimerStatus({ home, env: {}, run: makeFakeRun('no-bus'), repoUnits: { service: SERVICE, timer: TIMER } });
      assert.equal(raw?.reachable, false);
    });
  });
});

describe('line diff', () => {
  const ops = (r) => (r ?? []).map((x) => `${x.op}${x.text}`);
  it('identical texts give only context lines', async () => {
    const { diffLines } = await mod('schedule/diff.mjs');
    assert.deepEqual(ops(diffLines('a\nb\n', 'a\nb\n')), [' a', ' b']);
  });
  it('a null old text means a new file: every line is added', async () => {
    const { diffLines } = await mod('schedule/diff.mjs');
    assert.deepEqual(ops(diffLines(null, 'a\nb\n')), ['+a', '+b']);
  });
  it('added, removed and changed lines get +, - and a space in order', async () => {
    const { diffLines } = await mod('schedule/diff.mjs');
    assert.deepEqual(ops(diffLines('a\nb\nc\n', 'a\nB\nc\nd\n')), [' a', '-b', '+B', ' c', '+d']);
  });
  it('a removed line is shown with -', async () => {
    const { diffLines } = await mod('schedule/diff.mjs');
    assert.deepEqual(ops(diffLines('a\nb\n', 'a\n')), [' a', '-b']);
  });
  it('a missing trailing newline is a difference', async () => {
    const { diffLines } = await mod('schedule/diff.mjs');
    assert.deepEqual(ops(diffLines('a\nb', 'a\nb\n')), [' a', '-b [no newline at end]', '+b']);
  });
  it('two empty texts give no lines', async () => {
    const { diffLines } = await mod('schedule/diff.mjs');
    assert.deepEqual(diffLines('', ''), []);
  });
  it('more than 400 lines throws a RangeError so a wrong file cannot hang the diff', async () => {
    const { diffLines } = await mod('schedule/diff.mjs');
    assert.throws(() => diffLines('x\n'.repeat(401), 'y\n'), RangeError);
  });
});

describe('install planner and applier', () => {
  it('homeDisplay maps a path under HOME to ~/..., keeps system paths, and prints anything else as <other>/BASENAME', async () => {
    const { homeDisplay } = await mod('schedule/install.mjs');
    assert.equal(homeDisplay('/h/.local/bin/node', '/h'), '~/.local/bin/node');
    assert.equal(homeDisplay('/h', '/h'), '~');
    assert.equal(homeDisplay('/usr/bin/node', '/h'), '/usr/bin/node');
    assert.equal(homeDisplay('/opt/x/node', '/h'), '/opt/x/node');
    assert.equal(homeDisplay('/hx/.local/bin/node', '/h'), '<other>/node', 'a sibling directory sharing the prefix is not under HOME');
    assert.equal(homeDisplay('/srv/data/rigorscope', '/h'), '<other>/rigorscope');
  });

  it('checkoutCheck compares real paths: a symlink to the same checkout is ok, another checkout or an absent link is a mismatch', async () => {
    const { checkoutCheck } = await mod('schedule/install.mjs');
    await withTmp((home) => {
      const checkout = join(home, 'real-checkout');
      mkdirSync(checkout);
      mkdirSync(join(home, 'repos'));
      assert.equal(checkoutCheck({ home, checkoutRoot: checkout })?.ok, false, 'absent HOME/repos/rigorscope');
      symlinkSync(checkout, join(home, 'repos', 'rigorscope'));
      assert.equal(checkoutCheck({ home, checkoutRoot: checkout })?.ok, true);
      assert.equal(checkoutCheck({ home, checkoutRoot: join(home, 'repos') })?.ok, false);
    });
  });

  // A temporary HOME with a fake node file (so the real fs finds it) and a fake run answering for that path.
  const prepare = (home, { version = 'v24.22.1\n', sqlite = true } = {}) => {
    const nodePath = plantFakeNode(home);
    const checkout = join(home, 'checkout');
    mkdirSync(checkout);
    mkdirSync(join(home, 'repos'), { recursive: true });
    symlinkSync(checkout, join(home, 'repos', 'rigorscope'));
    return { checkout, run: makeFakeRun('active', { [nodePath]: { version, sqlite } }) };
  };

  it('planInstall reads only: new files, no refusals, and nothing is created', async () => {
    const { planInstall } = await mod('schedule/install.mjs');
    await withTmp((home) => {
      const { checkout, run } = prepare(home);
      const plan = planInstall({ home, env: {}, checkoutRoot: checkout, run, nowMs: NOW });
      assert.deepEqual((plan?.units ?? []).map((u) => `${u.name}:${u.status}`), ['rigorscope-ingest.service:new', 'rigorscope-ingest.timer:new']);
      assert.deepEqual(plan?.refusals, []);
      assert.equal(plan?.node?.status, 'ok');
      assert.equal(existsSync(join(home, '.config')), false);
    });
  });

  // [title, prepare options, expected refusal code]
  const REFUSALS = [
    ['a node below the floor', { version: 'v24.14.9\n' }, 'node_below_floor'],
    ['a node without sqlite', { sqlite: false }, 'node_no_sqlite'],
    ['an unreadable node version', { version: 'garbage\n' }, 'node_unusable'],
  ];
  for (const [title, opts, code] of REFUSALS) {
    it(`planInstall refuses ${title} with ${code}`, async () => {
      const { planInstall } = await mod('schedule/install.mjs');
      await withTmp((home) => {
        const { checkout, run } = prepare(home, opts);
        const plan = planInstall({ home, env: {}, checkoutRoot: checkout, run, nowMs: NOW });
        assert.deepEqual((plan?.refusals ?? []).map((r) => r.code), [code]);
      });
    });
  }

  it('planInstall refuses a checkout mismatch, a symlinked destination and a non-regular destination', async () => {
    const { planInstall } = await mod('schedule/install.mjs');
    await withTmp((home) => {
      const { run } = prepare(home);
      const dir = unitDirOf(home);
      mkdirSync(dir, { recursive: true });
      symlinkSync(join(home, 'repos'), join(dir, 'rigorscope-ingest.service'));
      mkdirSync(join(dir, 'rigorscope-ingest.timer'));
      const plan = planInstall({ home, env: {}, checkoutRoot: join(home, 'repos'), run, nowMs: NOW });
      assert.deepEqual((plan?.refusals ?? []).map((r) => r.code).sort(), ['checkout_mismatch', 'destination_not_file', 'destination_symlink']);
    });
  });

  it('applyInstall writes both files at mode 0644, creates the directory, runs the two systemctl calls in order, and a rerun is unchanged', async () => {
    const { planInstall, applyInstall } = await mod('schedule/install.mjs');
    await withTmp((home) => {
      const { checkout, run } = prepare(home);
      const plan = () => planInstall({ home, env: {}, checkoutRoot: checkout, run, nowMs: NOW });
      const res = applyInstall(plan(), { run, noSystemctl: false, nowMs: NOW });
      assert.deepEqual(res?.written, ['rigorscope-ingest.service', 'rigorscope-ingest.timer']);
      assert.deepEqual(res?.backups, []);
      const dir = unitDirOf(home);
      assert.equal(readFileSync(join(dir, 'rigorscope-ingest.service'), 'utf8'), SERVICE);
      assert.equal(statSync(join(dir, 'rigorscope-ingest.timer')).mode & 0o777, 0o644);
      const sys = run.calls().filter((c) => c.file === 'systemctl').map((c) => c.args.join(' '));
      assert.deepEqual(sys, ['--user daemon-reload', '--user enable --now rigorscope-ingest.timer']);
      assert.deepEqual((plan()?.units ?? []).map((u) => u.status), ['unchanged', 'unchanged']);
    });
  });

  it('planInstall follows a unit directory that is a symlink to a directory (only a destination file may not be a symlink)', async () => {
    const { planInstall, applyInstall } = await mod('schedule/install.mjs');
    await withTmp((home) => {
      const { checkout, run } = prepare(home);
      mkdirSync(join(home, '.config', 'systemd'), { recursive: true });
      mkdirSync(join(home, 'dotfiles-units'));
      symlinkSync(join(home, 'dotfiles-units'), unitDirOf(home));
      const plan = planInstall({ home, env: {}, checkoutRoot: checkout, run, nowMs: NOW });
      assert.deepEqual(plan?.refusals, []);
      applyInstall(plan, { run, noSystemctl: true, nowMs: NOW });
      assert.equal(readFileSync(join(home, 'dotfiles-units', 'rigorscope-ingest.timer'), 'utf8'), TIMER);
    });
  });

  it('applyInstall with noSystemctl makes no systemctl call and says so', async () => {
    const { planInstall, applyInstall } = await mod('schedule/install.mjs');
    await withTmp((home) => {
      const { checkout, run } = prepare(home);
      const res = applyInstall(planInstall({ home, env: {}, checkoutRoot: checkout, run, nowMs: NOW }), { run, noSystemctl: true, nowMs: NOW });
      assert.equal(run.calls().filter((c) => c.file === 'systemctl').length, 0);
      assert.deepEqual((res?.steps ?? []).map((s) => s.status), ['skipped', 'skipped']);
    });
  });

  it('applyInstall moves a differing file aside as NAME.bak-STAMP, with -1 when that name exists', async () => {
    const { planInstall, applyInstall } = await mod('schedule/install.mjs');
    await withTmp((home) => {
      const { checkout, run } = prepare(home);
      const dir = unitDirOf(home);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'rigorscope-ingest.timer'), 'old\n');
      writeFileSync(join(dir, 'rigorscope-ingest.timer.bak-20261028T120000Z'), 'older\n');
      const res = applyInstall(planInstall({ home, env: {}, checkoutRoot: checkout, run, nowMs: NOW }), { run, noSystemctl: true, nowMs: NOW });
      assert.deepEqual(res?.backups, ['rigorscope-ingest.timer.bak-20261028T120000Z-1']);
      assert.equal(readFileSync(join(dir, 'rigorscope-ingest.timer.bak-20261028T120000Z-1'), 'utf8'), 'old\n');
      assert.equal(readFileSync(join(dir, 'rigorscope-ingest.timer'), 'utf8'), TIMER);
    });
  });

  it('a throw in beforeRename before the first rename leaves both files as they were and no temp file', async () => {
    const { planInstall, applyInstall } = await mod('schedule/install.mjs');
    await withTmp((home) => {
      const { checkout, run } = prepare(home);
      const dir = unitDirOf(home);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'rigorscope-ingest.service'), 'old service\n');
      const plan = planInstall({ home, env: {}, checkoutRoot: checkout, run, nowMs: NOW });
      assert.throws(() => applyInstall(plan, { run, noSystemctl: true, nowMs: NOW, beforeRename: () => { throw new Error('stop'); } }), /stop/);
      assert.equal(readFileSync(join(dir, 'rigorscope-ingest.service'), 'utf8'), 'old service\n');
      assert.deepEqual(readdirSync(dir), ['rigorscope-ingest.service']);
    });
  });

  it('a throw before the second rename leaves the first file complete and new, the second absent, and a rerun completes', async () => {
    const { planInstall, applyInstall } = await mod('schedule/install.mjs');
    await withTmp((home) => {
      const { checkout, run } = prepare(home);
      const plan = () => planInstall({ home, env: {}, checkoutRoot: checkout, run, nowMs: NOW });
      let n = 0;
      assert.throws(() => applyInstall(plan(), { run, noSystemctl: true, nowMs: NOW, beforeRename: () => { n += 1; if (n === 2) throw new Error('stop'); } }), /stop/);
      const dir = unitDirOf(home);
      assert.deepEqual(readdirSync(dir), ['rigorscope-ingest.service']);
      assert.equal(readFileSync(join(dir, 'rigorscope-ingest.service'), 'utf8'), SERVICE);
      applyInstall(plan(), { run, noSystemctl: true, nowMs: NOW });
      assert.deepEqual(readdirSync(dir).sort(), ['rigorscope-ingest.service', 'rigorscope-ingest.timer']);
    });
  });

  it('a failing systemctl call becomes an InstallError naming the step and the exit code', async () => {
    const { planInstall, applyInstall, InstallError } = await mod('schedule/install.mjs');
    await withTmp((home) => {
      const { checkout } = prepare(home);
      const nodePath = join(home, '.local', 'bin', 'node');
      const run = makeFakeRun('enable-fails', { [nodePath]: { version: 'v24.22.1\n' } });
      const plan = planInstall({ home, env: {}, checkoutRoot: checkout, run, nowMs: NOW });
      let caught;
      try { applyInstall(plan, { run, noSystemctl: false, nowMs: NOW }); } catch (err) { caught = err; }
      assert.ok(caught instanceof InstallError);
      assert.match(String(caught?.message), /systemctl --user enable --now rigorscope-ingest.timer/);
      assert.equal(caught?.code, 1);
    });
  });

  it('applyInstall refuses a plan that holds refusals and writes nothing', async () => {
    const { planInstall, applyInstall } = await mod('schedule/install.mjs');
    await withTmp((home) => {
      const { checkout, run } = prepare(home, { version: 'v24.14.9\n' });
      const plan = planInstall({ home, env: {}, checkoutRoot: checkout, run, nowMs: NOW });
      assert.throws(() => applyInstall(plan, { run, noSystemctl: true, nowMs: NOW }));
      assert.equal(existsSync(join(home, '.config')), false);
    });
  });
});
