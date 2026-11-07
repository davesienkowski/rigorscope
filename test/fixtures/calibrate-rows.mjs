// Plain derived `unit` rows for the pure calibrate and sheet tests (plan 03-05). A helper, not a test: no database, no CLI.
let seq = 0;
export const pairRow = (over = {}) => {
  seq += 1;
  return {
    unit_key: `gsd-core:~/r/.git:quick:26110${seq}-aaa`,
    ledger_lines: 1, has_recon: 1, tier: 'B', tier_signal: 'ledger', recon_tier: 'A', tier_conflict: 0,
    ledger_start_ms: null, ledger_end_ms: null, recon_start_ms: null, recon_end_ms: null, end_source: 'git',
    recon_date_source: 'git', recon_end_source: 'git', ledger_session_id: null,
    ...over,
  };
};
