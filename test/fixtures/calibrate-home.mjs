// The calibrate fixture of plan 03-05 (LEDG-06, RPT-06): five reconstructed quick units (the units home with sameName) and, per
// pair, forward ledger lines whose tier, start, end and session sit at KNOWN offsets from what reconstruction found for the same
// unit. A helper, not a test. It runs ingest once, reads the reconstructed values from derived.db of the TEMPORARY HOME (a test
// reading its own throwaway database, never the real store), appends the ledger lines and runs ingest again. Expectations are
// computed by the tests from the pair specs and the returned `recon` values, never from calibrate output.
//
// Units (by short name): a1b (recon tier A), c2d (recon tier NULL), e3f (recon tier C but tier_conflict 1), p1a (recon tier B),
// p1b (recon tier NULL). Pair spec: { id, tier, startMin, endMin, session }
//   tier      ledger tier letter or null (no tier: tier_source unknown)
//   startMin  minutes after the reconstructed start (negative: before), null for no recorded start
//   endMin    minutes after the reconstructed end (after the reconstructed start when it has none), null for no close line
//   session   the ledger session id, or null
import { join } from 'node:path';
import { appendLine } from '../../src/ledger/append.mjs';
import {
  cliEnv, ingestHome, queryDb, runCli, stateDirOf,
} from './build.mjs';
import { lineText } from './strata-home.mjs';
import { buildUnitsHome } from './units-home.mjs';

export const CAL_NOW = '2026-11-01T00:00:00Z';
export const CAL_UNITS = Object.freeze({
  a1b: { repoKey: '~/repos/alpha/.git', nativeId: '261030-a1b' },
  c2d: { repoKey: '~/repos/alpha/.git', nativeId: '261029-c2d' },
  e3f: { repoKey: '~/work/beta/.git', nativeId: '261028-e3f' },
  p1a: { repoKey: '~/a/proj/.git', nativeId: '261027-p1a' },
  p1b: { repoKey: '~/b/proj/.git', nativeId: '261027-p1b' },
});
export const calKey = (name) => `gsd-core:${CAL_UNITS[name].repoKey}:quick:${CAL_UNITS[name].nativeId}`;
export const calEnv = (home, extra = {}) => cliEnv(home, { TZ: 'UTC', RIGORSCOPE_NOW: CAL_NOW, ...extra });
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

// -> { recon: { name: { unit_key, recon_tier, tier_conflict, recon_start_ms, recon_end_ms } }, built } after the second ingest.
export async function buildCalibrateHome({ home, root, pairs = [] }) {
  const built = buildUnitsHome({ home, root, sameName: true });
  const env = calEnv(home);
  await ingestHome(home, env);
  const first = runCli(['units', '--json'], { home, env });
  if (first.status !== 0) throw new Error(`calibrate fixture: units failed: ${first.stderr}`);
  const rows = queryDb(join(stateDirOf(home), 'derived.db'),
    'SELECT unit_key, recon_tier, tier_conflict, recon_start_ms, recon_end_ms FROM unit');
  const recon = {};
  for (const name of Object.keys(CAL_UNITS)) {
    recon[name] = rows.find((r) => r.unit_key === calKey(name));
    if (!recon[name]) throw new Error(`calibrate fixture: no reconstructed unit ${name}`);
  }
  for (const p of pairs) {
    const u = CAL_UNITS[p.id];
    const r = recon[p.id];
    const startMs = p.startMin === null || p.startMin === undefined ? null : r.recon_start_ms + p.startMin * MIN;
    const endBase = r.recon_end_ms ?? r.recon_start_ms;
    const endMs = p.endMin === null || p.endMin === undefined ? null : endBase + p.endMin * MIN;
    const latest = Math.max(startMs ?? 0, endMs ?? 0, r.recon_start_ms) + MIN;
    const common = { repo_key: u.repoKey, native_id: u.nativeId, session_id: p.session ?? null };
    appendLine(home, lineText({
      ...common,
      record: 'start',
      ts: iso(latest),
      tier: p.tier ?? null,
      tier_source: p.tier ? 'declared-at-start' : 'unknown',
      start: startMs === null ? null : iso(startMs),
    }));
    if (endMs !== null) {
      appendLine(home, lineText({
        ...common, record: 'close', ts: iso(latest), tier: null, tier_source: 'unknown', end: iso(endMs), status: 'complete',
      }));
    }
  }
  if (pairs.length > 0) await ingestHome(home, env);
  return { recon, built };
}
