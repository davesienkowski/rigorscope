// Fake `node` and `systemctl` binaries for the doctor and schedule tests (plan 01-09). A helper, not a test.
//
// plantFakeNode writes an executable shell script at HOME/.local/bin/node. plantFakeSystemctl writes one at
// BINDIR/systemctl with the scenario and the log path baked in as single-quoted literals at plant time (the
// production runner passes the child no test variables). makeFakeRun is the in-process twin built from the same
// scenario table, so the two cannot drift.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLANTS } from './build.mjs';

const TIMER_ACTIVE = {
  LoadState: 'loaded', ActiveState: 'active', UnitFileState: 'enabled', Persistent: 'yes',
  NextElapseUSecRealtime: 'Mon 2026-11-02 04:12:03 EST', LastTriggerUSec: 'Sun 2026-11-01 04:11:40 EDT',
};
const SERVICE_OK = {
  LoadState: 'loaded', ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0',
  ExecMainExitTimestamp: 'Sun 2026-11-01 04:11:55 EDT',
};

// scenario -> { timer, service } property tables, { fail } for a scenario where systemctl cannot reach a bus, and
// { enableFails } for a scenario where `enable` exits 1.
export const SYSTEMCTL_SCENARIOS = Object.freeze({
  active: { timer: TIMER_ACTIVE, service: SERVICE_OK },
  inactive: { timer: { ...TIMER_ACTIVE, ActiveState: 'inactive' }, service: SERVICE_OK },
  'not-found': {
    timer: { LoadState: 'not-found', ActiveState: 'inactive', UnitFileState: '', Persistent: 'no', NextElapseUSecRealtime: '', LastTriggerUSec: 'n/a' },
    service: { LoadState: 'not-found', ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0', ExecMainExitTimestamp: '' },
  },
  'not-enabled': { timer: { ...TIMER_ACTIVE, UnitFileState: 'disabled' }, service: SERVICE_OK },
  'service-failed': { timer: TIMER_ACTIVE, service: { ...SERVICE_OK, ActiveState: 'failed', Result: 'exit-code', ExecMainStatus: '1' } },
  masked: { timer: { ...TIMER_ACTIVE, LoadState: 'masked', ActiveState: 'inactive', UnitFileState: 'masked' }, service: SERVICE_OK },
  'no-bus': { fail: true },
  hostile: {
    timer: {
      LoadState: 'loaded', ActiveState: 'active; touch x', UnitFileState: 'enabled', Persistent: 'yes',
      NextElapseUSecRealtime: `Mon 2026-11-02 04:12:03 EST ${PLANTS.osUser}`, LastTriggerUSec: `${PLANTS.osUser} 2026-11-01`,
    },
    service: { LoadState: 'loaded', ActiveState: 'inactive', Result: 'success$(touch x)', ExecMainStatus: '0', ExecMainExitTimestamp: PLANTS.osUser },
  },
  'enable-fails': { timer: TIMER_ACTIVE, service: SERVICE_OK, enableFails: true },
});

export const UNIT_TIMER_NAME = 'rigorscope-ingest.timer';
export const UNIT_SERVICE_NAME = 'rigorscope-ingest.service';

// The `Key=Value` lines `systemctl --user show UNIT --property=A,B` prints for the requested keys that the table has.
export function showLines(scenario, unit, props) {
  const sc = SYSTEMCTL_SCENARIOS[scenario];
  const table = unit === UNIT_TIMER_NAME ? sc.timer : sc.service;
  return props.filter((p) => Object.hasOwn(table, p)).map((p) => `${p}=${table[p]}`);
}

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

// Executable script at HOME/.local/bin/node. `version` is the literal text printed for --version (default
// "v24.22.1\n"); `sqlite` decides the exit status of every other argument list.
export function plantFakeNode(home, { version = 'v24.22.1\n', sqlite = true } = {}) {
  const dir = join(home, '.local', 'bin');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'node');
  const body = `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s' ${quote(version)}; exit 0; fi\nexit ${sqlite ? 0 : 1}\n`;
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

export function plantFakeSystemctl(binDir, { scenario = 'active', logPath } = {}) {
  const sc = SYSTEMCTL_SCENARIOS[scenario];
  if (!sc) throw new Error('unknown systemctl scenario');
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, 'systemctl');
  const block = (unit) => (sc.fail ? '' : showLines(scenario, unit, Object.keys(unit === UNIT_TIMER_NAME ? sc.timer : sc.service)).join('\n'));
  const lines = [
    '#!/bin/sh',
    `echo "$*" >> ${quote(logPath)}`,
    ...(sc.fail ? ["echo 'Failed to connect to bus' >&2", 'exit 1'] : []),
    'if [ "$2" = "show" ]; then',
    '  unit="$3"; props=$(echo "$4" | sed "s/^--property=//; s/,/ /g")',
    `  if [ "$unit" = ${quote(UNIT_TIMER_NAME)} ]; then table=$(cat <<'RS_TIMER_EOF'`,
    block(UNIT_TIMER_NAME),
    'RS_TIMER_EOF',
    '); else table=$(cat <<\'RS_SERVICE_EOF\'',
    block(UNIT_SERVICE_NAME),
    'RS_SERVICE_EOF',
    '); fi',
    '  for k in $props; do printf \'%s\\n\' "$table" | while IFS= read -r line; do case "$line" in "$k="*) printf \'%s\\n\' "$line";; esac; done; done',
    '  exit 0',
    'fi',
    ...(sc.enableFails ? ['if [ "$2" = "enable" ]; then exit 1; fi'] : []),
    'exit 0',
    '',
  ];
  writeFileSync(file, lines.join('\n'), { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

export function readFakeLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
}

// nodes: { [path]: { version, sqlite, timeout } }. Returns run(file, args) -> { code, stdout, stderr }, with
// run.calls() listing { file, args } in call order.
// The scenario NO_SYSTEMCTL is a machine with no systemctl binary at all (macOS, native Windows): the runner reports ENOENT.
export const NO_SYSTEMCTL = 'no-systemctl';
// A systemctl that hangs: the runner reports { code: null, error: 'ETIMEDOUT' }.
export const SYSTEMCTL_TIMEOUT = 'systemctl-timeout';

export function makeFakeRun(scenario, nodes = {}) {
  const calls = [];
  const run = (file, args = []) => {
    calls.push({ file, args: [...args] });
    if (file === 'systemctl' && scenario === NO_SYSTEMCTL) return { code: null, error: 'ENOENT' };
    if (file === 'systemctl' && scenario === SYSTEMCTL_TIMEOUT) return { code: null, error: 'ETIMEDOUT' };
    if (file === 'systemctl') {
      const sc = SYSTEMCTL_SCENARIOS[scenario];
      if (sc.fail) return { code: 1, stdout: '', stderr: 'Failed to connect to bus\n' };
      if (args[1] === 'show') {
        const props = String(args[3] ?? '').replace(/^--property=/, '').split(',');
        const lines = showLines(scenario, args[2], props);
        return { code: 0, stdout: lines.length ? `${lines.join('\n')}\n` : '', stderr: '' };
      }
      if (args[1] === 'enable' && sc.enableFails) return { code: 1, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }
    const node = Object.hasOwn(nodes, file) ? nodes[file] : null;
    if (!node) return { code: null, error: 'ENOENT' };
    if (node.timeout) return { code: null, error: 'ETIMEDOUT' };
    if (args[0] === '--version') return { code: 0, stdout: node.version ?? 'v24.22.1\n', stderr: '' };
    return { code: node.sqlite === false ? 1 : 0, stdout: '', stderr: '' };
  };
  run.calls = () => calls;
  return run;
}
