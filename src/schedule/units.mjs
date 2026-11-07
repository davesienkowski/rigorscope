// Unit names, the unit directory, the repo unit texts and the text lint (plan 01-09, D-13, DATA-04). Built-ins only.
// The two files under units/ are the only source of what `schedule install` writes and of the PATH the node check walks.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNIT_SERVICE = 'rigorscope-ingest.service';
export const UNIT_TIMER = 'rigorscope-ingest.timer';
export const UNIT_NAMES = Object.freeze([UNIT_SERVICE, UNIT_TIMER]);
// Must equal the hours in TimeoutStartSec of the service file (the lint and a test check it). Doctor's lock_old uses it.
export const INGEST_TIMEOUT_HOURS = 6;
// The unit hard-codes %h/repos/rigorscope (D-01), so install refuses any other checkout.
export const CHECKOUT_SUBPATH = 'repos/rigorscope';

const UNITS_DIR = fileURLToPath(new URL('../../units/', import.meta.url));

// $XDG_CONFIG_HOME/systemd/user when that variable is an absolute path, else HOME/.config/systemd/user.
export function unitDir({ home, env = {} }) {
  const x = env?.XDG_CONFIG_HOME;
  const base = typeof x === 'string' && x !== '' && isAbsolute(x) ? x : join(home, '.config');
  return join(base, 'systemd', 'user');
}

export function readRepoUnits() {
  return {
    service: readFileSync(join(UNITS_DIR, UNIT_SERVICE), 'utf8'),
    timer: readFileSync(join(UNITS_DIR, UNIT_TIMER), 'utf8'),
  };
}

// Text -> { section: { key: [values] } }. Comment and blank lines are skipped; a line outside a section is ignored.
function parseUnit(textValue) {
  const out = {};
  let section = null;
  for (const raw of String(textValue).split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const s = /^\[([A-Za-z]+)\]$/.exec(line);
    if (s) { section = s[1]; out[section] ??= {}; continue; }
    const kv = /^([A-Za-z0-9]+)=(.*)$/.exec(line);
    if (kv && section) (out[section][kv[1]] ??= []).push(kv[2]);
  }
  return out;
}
const one = (u, section, key) => {
  const v = u[section]?.[key];
  return v && v.length === 1 ? v[0] : null;
};

// -> violation codes (empty when clean), by parsing Key=Value lines per section, not by substring search.
export function lintUnits({ service, timer }) {
  const v = [];
  for (const t of [service, timer]) if (/[^\x00-\x7f]/.test(t)) { v.push('non_ascii'); break; }
  const s = parseUnit(service);
  const t = parseUnit(timer);
  if (one(s, 'Service', 'Type') !== 'oneshot') v.push('service_type');
  const pathEntries = (one(s, 'Service', 'Environment') ?? '').replace(/^PATH=/, '').split(':');
  if (!(one(s, 'Service', 'Environment') ?? '').startsWith('PATH=') || pathEntries[0] !== '%h/.local/bin') v.push('service_path_first');
  if (one(s, 'Service', 'UMask') !== '0077') v.push('service_umask');
  if (one(s, 'Service', 'NoNewPrivileges') !== 'yes') v.push('service_no_new_privileges');
  if (one(s, 'Service', 'Nice') !== '10') v.push('service_nice');
  if (one(s, 'Service', 'TimeoutStartSec') !== `${INGEST_TIMEOUT_HOURS}h`) v.push('service_timeout');
  if (one(s, 'Service', 'ExecStart') !== '/usr/bin/env node %h/repos/rigorscope/bin/rigorscope.mjs ingest') v.push('service_execstart');
  if (one(s, 'Unit', 'ConditionPathExists') !== '%h/repos/rigorscope/bin/rigorscope.mjs') v.push('service_condition');
  for (const u of [s, t]) if (Object.values(u).some((sec) => Object.hasOwn(sec, 'User'))) { v.push('user_line'); break; }
  const cal = /^\*-\*-\* (\d{2}):(\d{2}):(\d{2})$/.exec(one(t, 'Timer', 'OnCalendar') ?? '');
  if (!cal || Number(cal[1]) < 4 || Number(cal[1]) > 22) v.push('timer_hour');
  if (one(t, 'Timer', 'Persistent') !== 'true') v.push('timer_persistent');
  if (one(t, 'Timer', 'RandomizedDelaySec') !== '15min') v.push('timer_delay');
  if (one(t, 'Timer', 'FixedRandomDelay') !== 'true') v.push('timer_fixed_delay');
  if (one(t, 'Timer', 'Unit') !== UNIT_SERVICE) v.push('timer_unit');
  if (one(t, 'Install', 'WantedBy') !== 'timers.target') v.push('timer_wantedby');
  return v;
}
