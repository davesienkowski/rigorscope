// ensureDerived: the lazy rebuild decision, run before every report (DATA-02, T-01-37). derived.db is
// rebuilt only for a named reason, checked in this order:
//   missing             no derived.db
//   unreadable          derived.db cannot be opened or has no derive_state row (corrupt, foreign file)
//   pass_version        built by another derivation pass (PASS_VERSION changed)
//   owner_rule          built under another owner rule than the one asked for
//   store_user_version  the store schema changed since the build
//   store_fingerprint   an ingest run started or ended since the build (or store.db is gone)
//   price_table         the price table's sha differs from the one recorded (including table to none and
//                       none to table; plan 01-05)
//   risk_rules          the risk-rule table's sha differs from the one recorded (including table to none and none
//                       to table; plan 02-05, the 02-03 handoff)
//   forced              the caller asked for a rebuild
// When nothing is stale it opens both files read-only and writes nothing, so a second call on
// unchanged inputs leaves derived.db byte-identical. A missing store.db is not an error: rebuildDerived
// creates the schema-only store.
import { existsSync } from 'node:fs';
import {
  derivedPath, openDerivedReadOnly, openStoreReadOnly, storePath,
} from '../db.mjs';
import { PASS_VERSION, fingerprintOf, fingerprintSql } from './schema.mjs';
import { DEFAULT_OWNER_RULE, ownerOrderBy } from './owner.mjs';
import { rebuildDerived, resolvePrices, resolveRiskRules } from './rebuild.mjs';

// db: store.db opened directly (its tables in schema main).
export function storeFingerprint(db) {
  return fingerprintOf(db.prepare(fingerprintSql('main')).get());
}

function readState(home) {
  try {
    const db = openDerivedReadOnly({ home });
    try {
      // SELECT * so a file from an older pass (without the price columns) still reports pass_version.
      const row = db.prepare('SELECT * FROM derive_state WHERE id = 1').get();
      if (!row) return null;
      return {
        pass_version: row.pass_version,
        owner_rule: row.owner_rule,
        store_user_version: row.store_user_version,
        store_fingerprint: row.store_fingerprint,
        price_sha: row.price_sha ?? null,
        risk_rules_sha: row.risk_rules_sha ?? null,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readStore(home) {
  if (!existsSync(storePath(home))) return null;
  const db = openStoreReadOnly({ home });
  try {
    return { userVersion: db.prepare('PRAGMA user_version').get().user_version, fingerprint: storeFingerprint(db) };
  } finally {
    db.close();
  }
}

function staleReason({
  home, passVersion, ownerRule, priceSha, riskSha,
}) {
  if (!existsSync(derivedPath(home))) return 'missing';
  const state = readState(home);
  if (!state) return 'unreadable';
  if (state.pass_version !== passVersion) return 'pass_version';
  if (state.owner_rule !== ownerRule) return 'owner_rule';
  const store = readStore(home);
  if (!store) return 'store_fingerprint';
  if (state.store_user_version !== store.userVersion) return 'store_user_version';
  if (state.store_fingerprint !== store.fingerprint) return 'store_fingerprint';
  if (state.price_sha !== priceSha) return 'price_table';
  if (state.risk_rules_sha !== riskSha) return 'risk_rules';
  return null;
}

// prices: an object from loadPrices, null for no table, or undefined to load the shipped table. riskRules (plan
// 02-05): an object from loadRiskRules, null for no table, or undefined to load the shipped table.
export function ensureDerived({
  home, now, passVersion = PASS_VERSION, ownerRule = DEFAULT_OWNER_RULE, force = false, prices, riskRules,
} = {}) {
  ownerOrderBy(ownerRule); // unknown rule names throw before anything is read
  const usePrices = resolvePrices(prices);
  const priceSha = usePrices ? usePrices.sha : null;
  const useRiskRules = resolveRiskRules(riskRules);
  const riskSha = useRiskRules ? useRiskRules.sha : null;
  const reason = force ? 'forced' : staleReason({
    home, passVersion, ownerRule, priceSha, riskSha,
  });
  if (reason === null) return { rebuilt: false, reason: null };
  rebuildDerived({
    home, now, ownerRule, passVersion, prices: usePrices, riskRules: useRiskRules,
  });
  return { rebuilt: true, reason };
}
