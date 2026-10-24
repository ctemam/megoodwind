# COMPTOOL verification — independent reproduction findings
## Reproduced
- eligible=3 confirmed CORRECT: rank.ts groups by signer+executor; 0x0ea2bb97 has TWO entities (verified-executor pair eligible #1; provisional pair separate). Signer-only grouping (my first repro) was coarser — not a defect.
- econ reconcile FAIL 65/88 → ROOT CAUSE: competitor_scan.ts:142 narrowed persisted econ to {status,netUsd,gasCostUsd,unknowns,confidence} — dropped grossUsd/flashFeeUsd/builderPayUsd. FIXED: full decomposition now persisted (store.ts schema widened). Legacy 88 records lack gross → honestly unreconcilable forever (fields never captured).
- W3 test defect: wrong field names (gasUsd vs gasCostUsd) + 10-record coincidence pass. Corrected: only gross-present records reconcilable; missing-gross counted explicitly.
## Prioritized remediation (evidence-ranked)
1. econ decomposition persistence — DONE (scan line 142 + schema)
2. phantom-missing — DONE earlier
3. schema drift (2 econ generations) — documented; legacy unreconcilable
## Limits: corpus-bounded; no market-wide claim; baseline frozen.
