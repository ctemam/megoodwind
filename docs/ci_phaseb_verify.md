# Phase B-a verification (commit 6f26bcd, read-only audit)
## Call path verified
discoveryPriority() reads CiStore.trusted() → filter(chain+receiptVerified+attribution.visibility_failure) → priorityPools/priorityTokens. discovery.ts Phase-0: import+verdict check→missing vs registry→eth_getCode→token0/token1→registry.upsert(source:'comptool_priority'). Wrap: try/catch — COMPTOOL absent → normal boot.
## Evidence table
| check | result | evidence |
|---|---|---|
| causal consumption | PASS | T2: 2→4 pools as records grow |
| unrelated attrs excluded | PASS | T3: lost_to_state/indeterminate → 1 pool |
| unverified excluded | PASS | T4: receiptVerified=false → 0 |
| empty→fallback | PASS | T5: fallback_empty verdict |
| malformed record | PASS | `pools??[]` — no crash, 0 pools |
| stale>24h → fallback | UNVERIFIED | code sets stale flag (line 26) but test file has no stale case — GAP |
| on-chain verify before register | PASS | getCode+token0/token1 decode pre-upsert |
| COMPTOOL absent → normal boot | PASS | outer try/catch (line 65) |
| baseline frozen | PASS | in-memory registry hash unaffected — upserts additive, source-tagged |
| no live exec | PASS | registry writes only; no signer/tx paths touched |
## Defect found
D-B1 (LOW): stale-path declared but untested — add stale-store fixture to ci_discovery_pri_test (one-line case, maxAgeMs=0 forces stale).
## Verdict: PASS with 1 test-coverage gap (D-B1)
