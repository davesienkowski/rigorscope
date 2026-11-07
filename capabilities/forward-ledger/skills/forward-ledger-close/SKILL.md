---
name: gsd-forward-ledger-close
description: Record finished plans in the rigorscope forward ledger.
---
Plans of the wave that just finished only: each plan id NN-MM (digits, hyphen, dot only, exactly as shown) of that wave that has a SUMMARY.md. Run once per plan, no other text:
`rigorscope unit-close --kind plan --id <plan id> --status complete --command execute-phase`
For a plan of an earlier wave, run nothing. Not callable: print `rigorscope not installed: unit not recorded`. Non-zero exit: continue, never retry. No other command.
