---
name: gsd-forward-ledger-start
description: Record the start of each plan of this wave in the rigorscope forward ledger.
---
For each plan id of this wave (form NN-MM, from your context), run once, id exactly as shown (digits, hyphen, dot only), no other text:
`rigorscope unit-start --kind plan --id <plan id> --tier-source plan-at-start --command execute-phase`
Not callable: print `rigorscope not installed: unit not recorded`. Non-zero exit: continue, never retry. Run no other command. Then continue the wave.
