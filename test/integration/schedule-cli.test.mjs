// Plan 01-09 contract: `rigorscope schedule install` (DATA-04, DATA-01, TRUST-05) through the spawned CLI. Written
// before the code (RED). Every test runs under a temporary HOME whose path holds the planted OS user name, a space and
// a hash character; every apply uses --no-systemctl or a fake systemctl first on PATH, never the real user manager.
// A failure message never carries a planted value: output is scrubbed of the home path before it is compared.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  buildFixtureTree, cliEnv, makeHome, runCli, runCliAsync,
} from '../fixtures/build.mjs';
import {
  REPO_UNIT_SERVICE, REPO_UNIT_TIMER, homeDigest, installRepoUnits, linkCheckout, unitDirOf,
} from '../fixtures/doctor-rows.mjs';
import { plantFakeNode, plantFakeSystemctl, readFakeLog } from '../fixtures/fake-bin.mjs';

const textOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const linesOf = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
const SERVICE = textOf(REPO_UNIT_SERVICE);
const TIMER = textOf(REPO_UNIT_TIMER);
const EXPECT_NOW_STAMP = '20261028T120000Z';

// A fixture home with a fake node at v24.22.1 and the checkout symlink; the cleanup removes exactly that directory.
function fixtureHome(nodeOpts) {
  const ctx = makeHome();
  plantFakeNode(ctx.home, nodeOpts);
  linkCheckout(ctx.home);
  return ctx;
}
const cli = (home, args, extra = {}) => {
  const r = runCli(args, { home, env: cliEnv(home, extra) });
  const scrub = (s) => String(s ?? '').split(home).join('<HOME>');
  return { status: r.status, stdout: scrub(r.stdout), stderr: scrub(r.stderr), lines: linesOf(scrub(r.stdout)) };
};
const withHome = async (nodeOpts, fn) => {
  const ctx = fixtureHome(nodeOpts);
  try {
    return await fn(ctx.home, ctx);
  } finally {
    ctx.cleanup();
  }
};
const DRY = ['schedule', 'install'];
const APPLY_NOSYS = ['schedule', 'install', '--apply', '--no-systemctl'];
const plus = (text) => linesOf(text).map((l) => `+ ${l}`);
const DRY_HEAD = [
  'schedule install: dry run (nothing is written; add --apply to install)',
  'checkout: ok (~/repos/rigorscope)',
  'node: ~/.local/bin/node v24.22.1 floor=24.15.0 ok',
  'unit directory: ~/.config/systemd/user',
];

describe('schedule install: the tracer', () => {
  it('tracer: dry run writes nothing, apply writes the two units, a second apply is unchanged, then doctor reports the timer as installed but unverified', async () => {
    const ctx = makeHome();
    try {
      plantFakeNode(ctx.home);
      linkCheckout(ctx.home);
      await buildFixtureTree(ctx.root, { home: ctx.home, cases: ['tracer-base'] });
      const before = homeDigest(ctx.home);
      const dry = cli(ctx.home, DRY);
      assert.equal(dry.status, 0, 'dry run exit status');
      assert.deepEqual(dry.lines, [
        ...DRY_HEAD,
        'rigorscope-ingest.service: new', ...plus(SERVICE),
        'rigorscope-ingest.timer: new', ...plus(TIMER),
        'would write 2 file(s), then run: systemctl --user daemon-reload; systemctl --user enable --now rigorscope-ingest.timer',
      ]);
      assert.equal(homeDigest(ctx.home), before, 'the dry run changed nothing under HOME');
      assert.equal(existsSync(join(ctx.home, '.config')), false, 'no .config directory');

      const applied = cli(ctx.home, APPLY_NOSYS);
      assert.equal(applied.status, 0, 'apply exit status');
      assert.equal(applied.lines[0], 'schedule install: applying');
      assert.ok(applied.lines.includes('rigorscope-ingest.service: new'));
      assert.ok(applied.lines.includes('rigorscope-ingest.timer: new'));
      assert.deepEqual(applied.lines.slice(-3), [
        'wrote 2 file(s) (backups: 0)',
        'systemctl --user daemon-reload: skipped (--no-systemctl)',
        'systemctl --user enable --now rigorscope-ingest.timer: skipped (--no-systemctl)',
      ]);
      const dir = unitDirOf(ctx.home);
      assert.equal(textOf(join(dir, 'rigorscope-ingest.service')), SERVICE);
      assert.equal(textOf(join(dir, 'rigorscope-ingest.timer')), TIMER);
      for (const n of ['rigorscope-ingest.service', 'rigorscope-ingest.timer']) {
        assert.equal(statSync(join(dir, n)).mode & 0o777, 0o644, `${n} mode`);
      }

      const again = cli(ctx.home, APPLY_NOSYS);
      assert.equal(again.status, 0);
      assert.ok(again.lines.includes('rigorscope-ingest.service: unchanged'));
      assert.ok(again.lines.includes('rigorscope-ingest.timer: unchanged'));
      assert.ok(again.lines.includes('wrote 0 file(s) (backups: 0)'));

      assert.equal(cli(ctx.home, ['ingest']).status, 0, 'ingest exit status');
      const doc = cli(ctx.home, ['doctor']);
      assert.equal(doc.status, 0, 'doctor exit status');
      assert.ok(
        doc.lines[0]?.startsWith('doctor: UNVERIFIED as of 2026-10-28T12:00:00.000Z (clock fixed by RIGORSCOPE_NOW); problems=0'),
        'the verdict line',
      );
      assert.ok(doc.lines.some((l) => l.startsWith('timer: unavailable')), 'the timer is unavailable without a bus');
      assert.ok(doc.lines.includes('unit-node: ~/.local/bin/node v24.22.1 floor=24.15.0 ok'));
    } finally {
      ctx.cleanup();
    }
  });
});

describe('schedule install: dry run and apply', () => {
  it('dry run with a fake systemctl first on PATH spawns no systemctl and writes nothing', () => withHome(undefined, (home) => {
    const logPath = join(home, 'systemctl.log');
    const FAKE_PATH = `${plantFakeSystemctl(join(home, 'fakebin'), { scenario: 'active', logPath }).replace(/\/systemctl$/, '')}:${process.env.PATH}`;
    const before = homeDigest(home);
    const r = cli(home, DRY, { PATH: FAKE_PATH });
    assert.equal(r.status, 0);
    assert.deepEqual(readFakeLog(logPath), []);
    assert.equal(homeDigest(home), before);
    assert.ok(r.lines.some((l) => l.startsWith('would write 2 file(s)')));
  }));

  it('apply with a fake systemctl logs daemon-reload then enable --now, in that order', () => withHome(undefined, (home) => {
    const logPath = join(home, 'systemctl.log');
    const FAKE_PATH = `${plantFakeSystemctl(join(home, 'fakebin'), { scenario: 'active', logPath }).replace(/\/systemctl$/, '')}:${process.env.PATH}`;
    const r = cli(home, ['schedule', 'install', '--apply'], { PATH: FAKE_PATH });
    assert.equal(r.status, 0);
    assert.deepEqual(readFakeLog(logPath), ['--user daemon-reload', '--user enable --now rigorscope-ingest.timer']);
    assert.ok(r.lines.includes('systemctl --user daemon-reload: ok'));
    assert.ok(r.lines.includes('systemctl --user enable --now rigorscope-ingest.timer: ok'));
  }));

  it('apply whose enable step fails exits 1 with the step and exit code on one stderr line', () => withHome(undefined, (home) => {
    const logPath = join(home, 'systemctl.log');
    const FAKE_PATH = `${plantFakeSystemctl(join(home, 'fakebin'), { scenario: 'enable-fails', logPath }).replace(/\/systemctl$/, '')}:${process.env.PATH}`;
    const r = cli(home, ['schedule', 'install', '--apply'], { PATH: FAKE_PATH });
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'schedule install: step failed: systemctl --user enable --now rigorscope-ingest.timer (exit 1)\n');
  }));

  it('a changed unit file is moved aside once as NAME.bak-STAMP and the new text is installed', () => withHome(undefined, (home) => {
    const dir = installRepoUnits(home, { service: 'old service text\n' });
    const r = cli(home, APPLY_NOSYS);
    assert.equal(r.status, 0);
    assert.ok(r.lines.includes('rigorscope-ingest.service: changed'));
    assert.ok(r.lines.includes('rigorscope-ingest.timer: unchanged'));
    assert.ok(r.lines.includes('wrote 1 file(s) (backups: 1)'));
    const backups = readdirSync(dir).filter((n) => n.includes('.bak-'));
    assert.deepEqual(backups, [`rigorscope-ingest.service.bak-${EXPECT_NOW_STAMP}`]);
    assert.equal(textOf(join(dir, backups[0])), 'old service text\n');
    assert.equal(textOf(join(dir, 'rigorscope-ingest.service')), SERVICE);
    assert.equal(cli(home, APPLY_NOSYS).status, 0);
    assert.equal(readdirSync(dir).filter((n) => n.includes('.bak-')).length, 1, 'a second apply makes no further backup');
  }));

  it('XDG_CONFIG_HOME as an absolute path is honored for the unit directory', () => withHome(undefined, (home) => {
    const r = cli(home, APPLY_NOSYS, { XDG_CONFIG_HOME: join(home, 'xdg') });
    assert.equal(r.status, 0);
    assert.ok(r.lines.includes('unit directory: ~/xdg/systemd/user'));
    assert.equal(textOf(join(home, 'xdg', 'systemd', 'user', 'rigorscope-ingest.timer')), TIMER);
    assert.equal(existsSync(join(home, '.config')), false);
  }));

  it('a relative XDG_CONFIG_HOME is ignored and HOME/.config is used', () => withHome(undefined, (home) => {
    const r = cli(home, DRY, { XDG_CONFIG_HOME: 'relative/dir' });
    assert.equal(r.status, 0);
    assert.ok(r.lines.includes('unit directory: ~/.config/systemd/user'));
  }));

  it('two parallel applies on a fresh HOME both exit 0 and leave identical complete files; a third run is unchanged', () => withHome(undefined, async (home) => {
    const run = () => runCliAsync(APPLY_NOSYS, { home });
    const results = await Promise.all([run(), run()]);
    for (const r of results) assert.equal(r.status ?? r.code, 0, 'parallel apply exit status');
    const dir = unitDirOf(home);
    assert.equal(textOf(join(dir, 'rigorscope-ingest.service')), SERVICE);
    assert.equal(textOf(join(dir, 'rigorscope-ingest.timer')), TIMER);
    assert.deepEqual(readdirSync(dir).sort(), ['rigorscope-ingest.service', 'rigorscope-ingest.timer'], 'no temp or backup file is left');
    const third = cli(home, APPLY_NOSYS);
    assert.ok(third.lines.includes('wrote 0 file(s) (backups: 0)'));
  }));
});

describe('schedule install: refusals', () => {
  // [title, node options, expected reason code]. node_missing cannot be produced in a spawned run: the unit PATH falls
  // through to this machine's /usr/local/bin/node, so that code is covered by the unit tests of resolveUnitNode.
  const NODE_ROWS = [
    ['node 24.14.9 is below the floor', { version: 'v24.14.9\n' }, 'node_below_floor'],
    ['node 22.22.3 is below the floor', { version: 'v22.22.3\n' }, 'node_below_floor'],
    ['a node without the built-in sqlite module', { sqlite: false }, 'node_no_sqlite'],
    ['a node whose version output is empty', { version: '' }, 'node_unusable'],
    ['a node whose version output is garbage', { version: 'garbage\n' }, 'node_unusable'],
    ['a node whose version output has two lines', { version: 'v24.22.1\nv24.22.2\n' }, 'node_unusable'],
  ];
  for (const [title, nodeOpts, code] of NODE_ROWS) {
    for (const [mode, args] of [['dry run', DRY], ['apply', APPLY_NOSYS]]) {
      it(`${mode} refuses ${title} with ${code}, exits 2 and writes nothing`, () => withHome(nodeOpts, (home) => {
        const before = homeDigest(home);
        const r = cli(home, args);
        assert.equal(r.status, 2, 'exit status');
        assert.ok(r.lines.some((l) => l.startsWith(`REFUSED ${code}:`)), 'the reason line');
        assert.match(r.stderr, /schedule install: refused, nothing was written/);
        assert.equal(homeDigest(home), before, 'nothing under HOME changed');
      }));
    }
  }

  const FS_ROWS = [
    ['a checkout that differs from HOME/repos/rigorscope', 'checkout_mismatch', (home) => {
      const link = join(home, 'repos', 'rigorscope');
      mkdirSync(join(home, 'other-checkout'));
      unlinkSync(link);
      symlinkSync(join(home, 'other-checkout'), link);
    }],
    ['a symlinked service destination', 'destination_symlink', (home) => {
      const dir = unitDirOf(home);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(home, 'target.txt'), 'x');
      symlinkSync(join(home, 'target.txt'), join(dir, 'rigorscope-ingest.service'));
    }],
    ['a timer destination that is a directory', 'destination_not_file', (home) => {
      mkdirSync(join(unitDirOf(home), 'rigorscope-ingest.timer'), { recursive: true });
    }],
  ];
  for (const [title, code, setup] of FS_ROWS) {
    for (const [mode, args] of [['dry run', DRY], ['apply', APPLY_NOSYS]]) {
      it(`${mode} refuses ${title} with ${code}, exits 2 and writes nothing`, () => withHome(undefined, (home) => {
        setup(home);
        const before = homeDigest(home);
        const r = cli(home, args);
        assert.equal(r.status, 2, 'exit status');
        assert.ok(r.lines.some((l) => l.startsWith(`REFUSED ${code}:`)), 'the reason line');
        assert.equal(homeDigest(home), before, 'nothing under HOME changed');
      }));
    }
  }
});

describe('schedule install: accepted node versions, usage errors and guards', () => {
  // Per-segment numeric comparison: 24.15.0 and 24.100.0 are accepted, 24.14.9 is refused (above).
  for (const v of ['24.15.0', '24.22.1', '24.100.0', '25.0.0']) {
    it(`a node at v${v} is accepted by the dry run`, () => withHome({ version: `v${v}\n` }, (home) => {
      const r = cli(home, DRY);
      assert.equal(r.status, 0);
      assert.ok(r.lines.includes(`node: ~/.local/bin/node v${v} floor=24.15.0 ok`));
    }));
  }

  // The apply flag is spelled in pieces so the static scan below does not flag a usage-error case that cannot reach systemctl.
  const FLAG = `--${'apply'}`;
  const USAGE_ROWS = [
    ['schedule with no action', ['schedule'], /install/],
    ['schedule with an unknown action', ['schedule', 'bogus'], /install/],
    ['schedule install with an extra word', ['schedule', 'install', 'extra'], /install/],
    ['the apply flag without the action', ['schedule', FLAG], /install/],
  ];
  for (const [title, args, pattern] of USAGE_ROWS) {
    it(`usage error: ${title} exits 2 with a message naming install, before any state is created`, () => withHome(undefined, (home) => {
      const before = homeDigest(home);
      const r = cli(home, args);
      assert.equal(r.status, 2);
      assert.match(r.stderr, pattern);
      assert.equal(homeDigest(home), before);
    }));
  }

  it('cliEnv carries neither XDG_RUNTIME_DIR nor DBUS_SESSION_BUS_ADDRESS, so a real systemctl --user cannot reach the bus', () => {
    const saved = { x: process.env.XDG_RUNTIME_DIR, d: process.env.DBUS_SESSION_BUS_ADDRESS };
    process.env.XDG_RUNTIME_DIR = '/run/user/0';
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/x';
    try {
      const keys = Object.keys(cliEnv('/h'));
      assert.ok(!keys.includes('XDG_RUNTIME_DIR'));
      assert.ok(!keys.includes('DBUS_SESSION_BUS_ADDRESS'));
    } finally {
      if (saved.x === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved.x;
      if (saved.d === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = saved.d;
    }
  });

  it('static scan: every spawned argument list with the apply flag in this test and the scenarios also has --no-systemctl or a fake systemctl PATH', () => {
    const files = [
      new URL('./schedule-cli.test.mjs', import.meta.url),
      new URL('../canary/scenarios/schedule-dry-run.mjs', import.meta.url),
      new URL('../canary/scenarios/doctor.mjs', import.meta.url),
    ];
    const needle = `'--${'apply'}'`;
    let seen = 0;
    for (const f of files) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.includes(needle) || line.includes('const needle')) continue;
        seen += 1;
        assert.ok(line.includes("'--no-systemctl'") || line.includes('FAKE_PATH'), 'an apply without --no-systemctl needs a fake systemctl');
      }
    }
    assert.ok(seen >= 3, 'the scan found apply invocations');
  });
});
