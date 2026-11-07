// Plant module for the usage source (plan 01-06, D-11a). It writes the hostile main Claude Code config file
// HOME/.claude.json (snapshot E) with a plant in every position the allowlist pick must never touch:
//   - the account id inside cachedUsageUtilization and in the oauth account block, an email-shaped value,
//     an organization id, a user id, the fake OS user name inside a projects key path
//   - money: limit_dollars, used_dollars and remaining_dollars on every window, spend, extra_usage (numbers
//     and a money string)
//   - two hostile key names (email shape; one holding the account-id plant) at top level and inside
//     utilization, a scope object on a limit entry, severity values, locked_reason text, non-ASCII text
// and two decoys that must never be read:
//   - HOME/.claude.json.bak, an unparseable copy holding the plants
//   - HOME/.claude-contrib/.claude.json, a valid cache file with its own plants inside the fixture's second
//     config directory (only HOME/.claude.json is ever opened)
// Case 95 (test/fixtures/cases/95-usage-window.mjs) already writes the same hostile object for snapshot A and
// a usageReport line whose session totals, extra_usage, scope and rendered content carry the plants.
// plant(ctx) returns every USAGE_PLANTS string, the money numbers in decimal text and the decoy plants.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SNAPSHOTS, USAGE_NEEDLES, USAGE_PLANTS, cacheFileObject, writeUsageCache } from '../../fixtures/usage-cache.mjs';

export const id = 'usage';
export const source = 'usage';

export const DECOY = Object.freeze({
  bak: 'CANARY-decoy-bak-unparseable-text',
  contribAccount: 'CANARY-decoy-contrib-acct-9d8e',
  contribScope: 'CANARY-decoy-contrib-scope',
});
// fetchedAtMs of the decoy cache file: 2026-10-26T20:00:00Z (DAY0 + 20 h), stored by no correct reader.
export const DECOY_FETCHED_MS = 1793044800000;

export function plant(ctx) {
  const { home } = ctx;
  writeUsageCache(home, SNAPSHOTS.E);
  writeFileSync(
    join(home, '.claude.json.bak'),
    `{"cachedUsageUtilization":{"accountUuid":"${USAGE_PLANTS.accountId}","note":"${DECOY.bak}","x":"${USAGE_PLANTS.email}"`,
  );
  const contrib = join(home, '.claude-contrib');
  mkdirSync(contrib, { recursive: true });
  const decoy = cacheFileObject(SNAPSHOTS.E, { fetchedAtMs: DECOY_FETCHED_MS });
  decoy.cachedUsageUtilization.accountUuid = DECOY.contribAccount;
  decoy.cachedUsageUtilization.utilization.weekly_scoped_shares = { opus: DECOY.contribScope };
  writeFileSync(join(contrib, '.claude.json'), JSON.stringify(decoy));
  return { needles: [...USAGE_NEEDLES, ...Object.values(DECOY)] };
}
