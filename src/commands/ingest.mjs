// rigorscope ingest [--root DIR ...]: read Claude Code transcripts into the local store.
// With no --root every Claude config directory is discovered (D-03); --root replaces discovery.
// Plan 02-02: the line before the final `ingest: files=...` summary is the unit post-step's `units:` line (counts only:
// git state, dirs resolved by method, deferred dirs, repos scanned, quick units, duplicate ids, skipped entries; plan
// 02-05 adds phase plans, artifacts recorded, the git facts state, the units scanned and deferred for git facts, the
// configured repo roots added and skipped, and the working trees scanned; its review adds facts_dropped, the commit
// paths left out of the stored facts, CR-01, and trees_dropped, the listed working trees not scanned, WR-04).
// Plan 02-04: the line before `units:` is the environment snapshot's `env:` line (each value `?` when unknown).
// Plan 03.1-01: the line before `env:` is the `locations:` line (the number of repos scanned, then each location counter
// of layout.mjs LOCATION_KINDS in list order, summed over those repos; `?` for every counter when no repo was scanned).
// Plan 03.1-04: the line after `locations:` is the `classes:` line (the artifact files recognized by roster class F, E and S
// and the files not in the roster, summed over the repos scanned, with the first 12 characters of the roster ref).
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { UsageError } from '../cli.mjs';
import { runIngest } from '../ingest/run.mjs';
import { windowsUsersDirFromEnv } from '../sources/transcript/roots.mjs';
import { locationsLine } from '../adapters/gsd-core/layout.mjs';
import { classesLine } from '../adapters/gsd-core/roster.mjs';

export const description = 'Read Claude Code transcripts into the local store (every config directory, or each --root)';
export const options = { root: { type: 'string', multiple: true } };

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const pairs = (obj) => Object.entries(obj).map(([k, n]) => `${k}:${n}`).join(',');

// The eight most frequent skipped types, then everything else as "other".
function skippedTypes(byType) {
  const sorted = Object.entries(byType).sort(([a, x], [b, y]) => (y - x) || (a < b ? -1 : a > b ? 1 : 0));
  const top = sorted.slice(0, 8);
  const other = sorted.slice(8).reduce((acc, [, n]) => acc + n, 0);
  return `${[...top.map(([k, n]) => `${k}:${n}`), `other:${other}`].join(',')}`;
}

export async function run(args, ctx) {
  const explicit = (args.root ?? []).map((r) => resolve(r));
  for (const p of explicit) if (!isDirectory(p)) throw new UsageError('--root is not a directory');
  const env = ctx.env ?? {};
  const windowsUsersDir = windowsUsersDirFromEnv(env);
  const s = await runIngest({
    home: ctx.home, roots: explicit.length > 0 ? explicit : undefined, env, windowsUsersDir, now: ctx.now,
  });
  if (s.skipped === 'lock_held') {
    const h = s.holder ?? {};
    ctx.stdout.write(`ingest: skipped, another ingest holds the lock (pid ${h.pid ?? 'unknown'} since ${h.started_utc ?? 'unknown'})\n`);
    return 0;
  }
  const names = Object.keys(s.sources);
  const out = [`ingest: roots=${s.roots} sources=${names.join(',')}`];
  for (const name of names) {
    const p = s.sources[name];
    out.push(
      `${name}: files=${p.files} new=${p.new} reread=${p.reread} unchanged=${p.unchanged} skipped=${p.skipped} bytes=${p.bytes} ` +
        `lines=${p.lines} assistant=${p.assistant} kept=${p.kept} unparseable=${p.unparseable} oversized=${p.oversized} ` +
        `dropped=${pairs(p.dropped)} unknown_token_bearing=${p.unknown_token_bearing} ` +
        `deferred_token_bearing=${p.deferred_token_bearing} pending_tail_bytes=${p.pending_tail_bytes}`,
    );
    out.push(`${name}: skipped_types=${skippedTypes(p.skippedTypes)}`);
  }
  const rejected = Object.entries(s.rejected)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, count]) => `${name}:${count}`)
    .join(',');
  const e = s.env ?? {};
  const q = (v) => (v === null || v === undefined ? '?' : v);
  out.push(locationsLine(s.units.locations, s.units.locations_repos));
  out.push(classesLine(s.units.classes, s.units.classes_repos));
  out.push(
    `env: gsd_version=${q(e.gsd_version)} gsd_version_source=${q(e.gsd_version_source)} base_sha=${q(e.base_sha)} `
      + `local_mods_head=${q(e.local_mods_head)} hook_events=${q(e.hook_events)} hooks=${q(e.hooks)} `
      + `model_default=${q(e.model_default)} advisor_model=${q(e.advisor_model)}`,
  );
  const u = s.units;
  out.push(
    `units: git=${u.git} dirs=${u.dirs} resolved=${u.resolved} ancestor=${u.ancestor} none=${u.none} deferred=${u.deferred} ` +
      `repos=${u.repos} scanned=${u.scanned} quick=${u.quick} dup_ids=${u.dup_ids} skipped=${u.skipped} ` +
      `plan=${u.plan} artifacts=${u.artifacts} facts=${u.facts} facts_units=${u.facts_units} facts_deferred=${u.facts_deferred} ` +
      `facts_dropped=${u.facts_dropped} roots=${u.roots} root_skipped=${u.root_skipped} trees=${u.trees} trees_dropped=${u.trees_dropped}`,
  );
  out.push(
    `ingest: files=${s.files} lines=${s.candidates} assistant=${s.assistant} kept=${s.kept} ` +
      `unparseable=${s.unparseable} rejected=${rejected || 'none'}`,
  );
  ctx.stdout.write(`${out.join('\n')}\n`);
  // Loud, never fatal (RR-01): unknown token-bearing records are reported on stderr and the run exits 0.
  for (const name of names) {
    const p = s.sources[name];
    if (p.unknown_token_bearing > 0) {
      const top = Object.entries(p.unknownTokens).sort(([, a], [, b]) => b - a).slice(0, 5).map(([k, n]) => `${k}:${n}`).join(',');
      ctx.stderr.write(
        `WARNING: ${name}: unknown_token_bearing=${p.unknown_token_bearing} (${top}); these records carry token counts rigorscope does not read\n`,
      );
    }
  }
  return 0;
}
