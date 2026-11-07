// The injectable runner over spawnSync (plan 01-09, RR-03, T-01-83, T-01-88). Argument arrays only, no shell, a fixed
// timeout with SIGKILL and a 1 MiB output cap, and a child environment built from an allowlist of the given env. It
// never throws: a missing binary or a timeout yields { code: null, error }.
import { spawnSync } from 'node:child_process';

export const PROBE_TIMEOUT_MS = 10000;
const MAX_BUFFER = 1024 * 1024;
const ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];

// opts: { env, timeoutMs } -> { code, stdout, stderr } | { code: null, error }
export function defaultRun(file, args, opts = {}) {
  const src = opts.env ?? {};
  const env = {};
  for (const k of ENV_ALLOW) if (typeof src[k] === 'string') env[k] = src[k];
  let r;
  try {
    r = spawnSync(file, args, {
      env, encoding: 'utf8', timeout: opts.timeoutMs ?? PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER, windowsHide: true,
    });
  } catch (err) {
    return { code: null, error: typeof err?.code === 'string' ? err.code : 'ESPAWN' };
  }
  if (r.error) return { code: null, error: typeof r.error.code === 'string' ? r.error.code : 'ESPAWN' };
  if (r.status === null) return { code: null, error: r.signal ? 'ETIMEDOUT' : 'ESPAWN' };
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function runSystemctl(run, args) {
  return run('systemctl', ['--user', ...args]);
}
