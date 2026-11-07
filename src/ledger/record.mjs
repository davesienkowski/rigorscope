// recordUnit: derive, validate and append one ledger line (plan 03-01, D-02..D-07). Shared by `unit-start` and
// `unit-close`. It derives what is derivable (repository key from the working directory with the pair ingest uses, time
// from the clock, GSD version from the installed copy, runtime from CLAUDECODE, session id from CLAUDE_CODE_SESSION_ID)
// and takes the rest from flags; an unknown field stays null (D-04, D-05). Any rejection is a UsageError with one fixed
// message from REJECT_REASONS that never echoes a value (exit 2), raised before the ledger is opened.
import { join } from 'node:path';
import { UsageError } from '../cli.mjs';
import { configDirOf, readGsdVersion } from '../env/snapshot.mjs';
import { checkShape } from '../redact/shapes.mjs';
import { frontmatterLines, readHead, tierLetter } from '../adapters/gsd-core/frontmatter.mjs';
import { locateUnitDir } from '../adapters/gsd-core/signals.mjs';
import { childEnv, defaultRun, resolveDir } from '../units/repo-resolve.mjs';
import { appendLine } from './append.mjs';
import { REJECT_REASONS, buildLine } from './line.mjs';

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_SOURCE = Object.freeze({ start: 'declared-at-start', close: 'declared-at-close' });

const reject = (reason) => new UsageError(REJECT_REASONS[reason]);
const str = (v) => (typeof v === 'string' ? v : null);

// The work-tree top of cwd, or null (git answered no or could not run).
function topOf(cwd, run) {
  const r = run(['-C', cwd, '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], { env: childEnv({}) });
  if (r.errorCode || r.status !== 0) return null;
  const top = String(r.stdout).split('\n')[0];
  return top.startsWith('/') ? top : null;
}

// The tier letter in the unit's PLAN frontmatter under the work-tree top, or null. Reads the leading frontmatter only.
function planTier(top, kind, nativeId) {
  if (top === null) return null;
  const dirRel = locateUnitDir({ top, kind, nativeId });
  if (dirRel === null) return null;
  try {
    return tierLetter(frontmatterLines(readHead(join(top, dirRel, `${nativeId}-PLAN.md`)))) ?? null;
  } catch {
    return null;
  }
}

export function sessionIdOf(env, flag) {
  if (flag !== undefined) return flag;
  const e = env?.CLAUDE_CODE_SESSION_ID;
  return typeof e === 'string' && SESSION_UUID_RE.test(e) ? e : null;
}

export function recordUnit(record, args, ctx) {
  const run = ctx.run ?? defaultRun;
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? {};
  const resolved = resolveDir(cwd, { home: ctx.home, run });
  if (resolved.deferred) throw reject('git_unavailable');
  if (resolved.repoKey === null) throw reject('not_a_repo');

  const kind = str(args.kind);
  const nativeId = str(args.id);
  let tier = args.tier === undefined ? null : args.tier;
  let source = args['tier-source'] === undefined ? null : args['tier-source'];
  if (source === 'plan-at-start') {
    if (tier !== null) throw reject('plan_source_with_tier');
    tier = planTier(topOf(cwd, run), kind, nativeId);
    if (tier === null) source = 'unknown';
  } else if (source === null) {
    source = tier === null ? 'unknown' : DEFAULT_SOURCE[record];
  }

  const ts = ctx.now().toISOString();
  const command = typeof args.command === 'string' && args.command.startsWith('/') ? args.command.slice(1) : args.command;
  const gsd = readGsdVersion(configDirOf({ home: ctx.home, env })).value;
  const built = buildLine({
    record,
    ts,
    repo_key: resolved.repoKey,
    kind,
    native_id: nativeId,
    tier,
    tier_source: source,
    command,
    runtime: args.runtime !== undefined ? args.runtime : (typeof env.CLAUDECODE === 'string' && env.CLAUDECODE !== '' ? 'claude-code' : null),
    session_id: sessionIdOf(env, args['session-id']),
    start: record === 'start' ? (args.start ?? ts) : (args.start ?? null),
    end: record === 'close' ? (args.end ?? ts) : null,
    status: record === 'close' ? (args.status ?? null) : null,
    gsd_version: gsd !== null && checkShape('version', gsd) !== undefined ? gsd : null,
  });
  if (!built.ok) throw reject(built.reason);
  appendLine(ctx.home, built.text);
  ctx.stdout.write(`ledger: ${record} ${built.line.unit_key}\n`);
  return 0;
}
