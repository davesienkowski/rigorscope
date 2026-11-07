// Timer and service state from `systemctl --user show` PROPERTIES, never from an exit status (plan 01-09, DATA-04,
// T-01-89): `show` exits 0 for a missing unit with LoadState=not-found. Every value is allowlisted by key and shape
// checked (null on failure); timestamps are display-only strings (show ignores --timestamp=utc) and are never parsed.
// No systemd output line is echoed.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNIT_SERVICE, UNIT_TIMER, unitDir } from './units.mjs';
import { runSystemctl } from './systemctl.mjs';

export const TIMER_PROPERTIES = Object.freeze(['LoadState', 'ActiveState', 'UnitFileState', 'Persistent', 'NextElapseUSecRealtime', 'LastTriggerUSec']);
export const SERVICE_PROPERTIES = Object.freeze(['LoadState', 'ActiveState', 'Result', 'ExecMainStatus', 'ExecMainExitTimestamp']);

const word = (...values) => (v) => (values.includes(v) ? v : null);
const STAMP = /^[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,5}$/;
const SHAPES = {
  LoadState: word('loaded', 'not-found', 'masked', 'error', 'bad-setting', 'stub'),
  ActiveState: word('active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading', 'maintenance'),
  UnitFileState: word('enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias', 'masked', 'masked-runtime', 'static', 'disabled', 'indirect', 'generated', 'transient', 'bad', ''),
  Persistent: word('yes', 'no'),
  Result: word('success', 'exit-code', 'signal', 'core-dump', 'watchdog', 'start-limit-hit', 'timeout', 'resources', 'protocol', 'oom-kill', 'skipped'),
  ExecMainStatus: (v) => (/^\d{1,3}$/.test(v) ? v : null),
  NextElapseUSecRealtime: (v) => (STAMP.test(v) ? v : null),
  LastTriggerUSec: (v) => (STAMP.test(v) ? v : null),
  ExecMainExitTimestamp: (v) => (STAMP.test(v) ? v : null),
};

// -> { KEY: value | null } for the allowlisted keys that appear; the last value wins; a line without = is ignored.
export function parseShowOutput(textValue, allowed) {
  const out = {};
  for (const line of String(textValue).split('\n')) {
    const at = line.indexOf('=');
    if (at < 0) continue;
    const key = line.slice(0, at);
    if (!allowed.includes(key) || !Object.hasOwn(SHAPES, key)) continue;
    out[key] = SHAPES[key](line.slice(at + 1));
  }
  return out;
}

function fileState(dir, name, repoText) {
  const p = join(dir, name);
  try {
    lstatSync(p);
    return readFileSync(p, 'utf8') === repoText ? 'same' : 'differs';
  } catch (err) {
    return err?.code === 'ENOENT' ? 'absent' : 'differs';
  }
}

// -> { files: { service, timer } (absent | same | differs), reachable: true | false | null, timer, service, noSystemd }
// When a unit file is absent, `systemctl --user show-environment` tells the cases apart:
//   cannot run (no systemctl binary)              noSystemd true  (macOS, native Windows)
//   fails and systemd is not running              noSystemd true  (WSL without systemd)
//   fails while systemd is running (no user bus)  busUnreachable true: unverified, not "no systemd"
//   succeeds                                      neither: the units are simply not installed
// systemdRunning is injectable so tests do not depend on the host; the default is sd_booted's own check.
export const systemdBooted = () => existsSync('/run/systemd/system');

export function readTimerStatus({ home, env, run, repoUnits, systemdRunning = systemdBooted }) {
  const dir = unitDir({ home, env });
  const files = { service: fileState(dir, UNIT_SERVICE, repoUnits.service), timer: fileState(dir, UNIT_TIMER, repoUnits.timer) };
  if (files.service === 'absent' || files.timer === 'absent') {
    const probe = runSystemctl(run, ['show-environment']);
    const failed = !probe || probe.code !== 0;
    const noBinary = !probe || (probe.code === null && probe.error === 'ENOENT');
    const running = failed && !noBinary && systemdRunning() === true;
    return { files, reachable: null, timer: null, service: null, noSystemd: failed && !running, busUnreachable: running };
  }
  const query = (unit, props) => {
    const r = runSystemctl(run, ['show', unit, `--property=${props.join(',')}`]);
    if (!r || r.code !== 0 || typeof r.stdout !== 'string') return null;
    const parsed = parseShowOutput(r.stdout, props);
    return Object.keys(parsed).length === 0 ? null : parsed;
  };
  const timer = query(UNIT_TIMER, TIMER_PROPERTIES);
  const service = query(UNIT_SERVICE, SERVICE_PROPERTIES);
  return { files, reachable: timer !== null && service !== null, timer, service };
}

const ENABLED = new Set(['enabled', 'enabled-runtime', 'linked', 'linked-runtime']);

// raw -> { state, serviceOk, serviceFacts, timerFacts, drift }. states: missing, not_configured, unavailable, inactive, not_enabled, active.
export function evaluateTimer(raw) {
  const drift = raw.files.service === 'differs' || raw.files.timer === 'differs';
  const empty = { result: null, exitStatus: null, lastExit: null };
  const noTimer = { persistent: null, active: null, enabled: null, next: null, last: null };
  if (raw.files.service === 'absent' || raw.files.timer === 'absent') return { state: raw.noSystemd === true ? 'not_configured' : (raw.busUnreachable === true ? 'unavailable' : 'missing'), serviceOk: null, serviceFacts: empty, timerFacts: noTimer, drift };
  if (!raw.reachable || !raw.timer || !raw.service) return { state: 'unavailable', serviceOk: null, serviceFacts: empty, timerFacts: noTimer, drift };
  const t = raw.timer;
  const sv = raw.service;
  const timerFacts = {
    persistent: t.Persistent ?? null, active: t.ActiveState ?? null, enabled: t.UnitFileState ?? null,
    next: t.NextElapseUSecRealtime ?? null, last: t.LastTriggerUSec ?? null,
  };
  const exitStatus = typeof sv.ExecMainStatus === 'string' ? Number(sv.ExecMainStatus) : null;
  const serviceFacts = { result: sv.Result ?? null, exitStatus, lastExit: sv.ExecMainExitTimestamp ?? null };
  let serviceOk = null;
  if (serviceFacts.result !== null && exitStatus !== null) serviceOk = serviceFacts.result === 'success' && exitStatus === 0;
  let state;
  if (t.LoadState === null || t.LoadState === undefined || t.ActiveState === null || t.ActiveState === undefined || t.UnitFileState === null || t.UnitFileState === undefined) state = 'unavailable';
  else if (t.LoadState !== 'loaded') state = 'missing';
  else if (t.ActiveState !== 'active') state = 'inactive';
  else if (!ENABLED.has(t.UnitFileState)) state = 'not_enabled';
  else state = 'active';
  return { state, serviceOk, serviceFacts, timerFacts, drift };
}
