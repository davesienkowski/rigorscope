// derived.db is disposable: it is rebuilt from store.db into a per-process temp file and renamed into
// place, so a reader never sees a partial file (DATA-02). A failure before the rename leaves the previous
// derived.db untouched, and the temp file (and any journal beside it) is always removed.
//
// The whole fill runs in ONE BEGIN IMMEDIATE transaction on the derived connection, with store.db
// attached read-only as schema s. The attach takes a read transaction on the store at BEGIN, so every
// statement of the pass reads the same snapshot: a run that commits to the store meanwhile is neither
// waited for nor seen, and the next ensureDerived picks it up through the store fingerprint. The store
// fingerprint and user_version are read first, inside that transaction.
import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  derivedPath, ensureStateDir, openDerivedForBuild, openStore,
} from '../db.mjs';
import { DERIVED_SQL, PASS_VERSION, fingerprintOf, fingerprintSql } from './schema.mjs';
import { DEFAULT_OWNER_RULE, ownerOrderBy } from './owner.mjs';
import { fillDerived } from './build.mjs';
import { fillOtel } from './otel-fill.mjs';
import { DEFAULT_OTEL_OWNER_RULE, otelOwnerOrderBy } from './otel-owner.mjs';
import { fillWindows } from './window-fill.mjs';
import { fillDimensions, fillRepoFallback } from './dimensions-fill.mjs';
import { fillRepoLabels, fillUnits } from './unit-fill.mjs';
import { fillLinks } from './link-fill.mjs';
import { fillAttribution } from './attribution.mjs';
import { fillConfounders } from './confounders.mjs';
import { PriceTableError, loadPrices } from './price-table.mjs';
import { RiskRulesError, loadRiskRules } from '../units/risk-rules.mjs';

// prices: an object from loadPrices, null for no table, or undefined to load the shipped table (falling
// back to null when it is unusable; the cost command loads it itself so it can print the warning).
export function resolvePrices(prices) {
  if (prices !== undefined) return prices;
  try {
    return loadPrices();
  } catch (err) {
    if (err instanceof PriceTableError) return null;
    throw err;
  }
}

// riskRules (plan 02-05): an object from loadRiskRules, null for no table, or undefined to load the shipped table
// (falling back to null when it is unusable: every unit's risk_class is then NULL with risk_source no-rules).
export function resolveRiskRules(riskRules) {
  if (riskRules !== undefined) return riskRules;
  try {
    return loadRiskRules();
  } catch (err) {
    if (err instanceof RiskRulesError) return null;
    throw err;
  }
}

// beforeRename is a test seam: a throw there proves the old derived.db survives. ownerRule and
// passVersion select the owner rule by name and record the pass version (tests raise it to prove a
// version change triggers a rebuild). prices: see resolvePrices. otelRule selects the OTel request owner
// ordering by name (plan 01-07; `latest` exists to prove the ordering). riskRules: see resolveRiskRules.
export function rebuildDerived({
  home, now = () => new Date(), beforeRename, ownerRule = DEFAULT_OWNER_RULE, passVersion = PASS_VERSION, prices,
  otelRule = DEFAULT_OTEL_OWNER_RULE, riskRules,
} = {}) {
  ownerOrderBy(ownerRule); // an unknown rule name throws before any file is touched
  otelOwnerOrderBy(otelRule);
  const usePrices = resolvePrices(prices);
  const useRiskRules = resolveRiskRules(riskRules);
  // A schema-only store.db must exist before the read-only attach (a fresh HOME has none).
  openStore({ home }).close();
  const tmpPath = join(ensureStateDir(home), `derived.db.${process.pid}.tmp`);
  let db = null;
  try {
    db = openDerivedForBuild({ tmpPath, home });
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec(DERIVED_SQL);
    db.exec('BEGIN IMMEDIATE');
    const storeFingerprint = fingerprintOf(db.prepare(fingerprintSql('s')).get());
    const storeUserVersion = db.prepare('PRAGMA s.user_version').get().user_version;
    fillDerived({
      db, ownerRule, passVersion, builtUtc: now().toISOString(), storeFingerprint, storeUserVersion, prices: usePrices,
    });
    // OTel join (plan 01-07): same transaction and store snapshot, after the transcript calls are priced and before
    // the window pass, so the otel_only parts are weighted by the window estimator too.
    fillOtel({ db, otelRule });
    // Repo displays (plan 02-02): one repo_label row per store repo, before the dimensions read them.
    fillRepoLabels({ db });
    // Report dimensions (plan 01-08): ts_ms, repo and repo_rule, after the OTel calls exist and before the window pass.
    fillDimensions({ db });
    // Units (plans 02-02 and 02-05): the unit record from the store's migration 007 tables and repo_label, with the
    // risk-rule table.
    fillUnits({ db, riskRules: useRiskRules });
    // Links and attribution (plan 02-07): same transaction and store snapshot; links read the derived unit rows and the
    // main-section calls with their repos, so they run after fillUnits and fillDimensions.
    fillLinks({ db });
    fillAttribution({ db });
    // The Q2 repo fallback (plan 02-07): after attribution, so the links read the repos resolved from cwds only.
    fillRepoFallback({ db });
    // Per-unit confounders and runtime (plan 02-07): from the attributed scopes and the stored env snapshots.
    fillConfounders({ db });
    // Window share (plan 01-06): same transaction and store snapshot, after the parts and prices exist.
    fillWindows({ db });
    db.exec('COMMIT');
    db.close();
    db = null;
    if (beforeRename) beforeRename();
    renameSync(tmpPath, derivedPath(home));
  } finally {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
    rmSync(tmpPath, { force: true });
    rmSync(`${tmpPath}-journal`, { force: true });
  }
}
