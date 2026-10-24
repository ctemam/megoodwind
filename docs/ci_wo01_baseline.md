# WO-01 baseline — CI program repo audit (2026-10-24)

## Component map (verified by file inspection)
| Piece | Location | State |
|---|---|---|
| Cycle detector (mev-inspect rules) | scripts/competitor_scan.ts:74-96 | works; script-level, needs module split for WO-02..07 |
| Swap decode v2/v3 + pool meta | :37-71 | works; chunked getLogs; decimals not cached |
| Receipt verification (status=1) | :104 | works — WO-03 partial credit |
| Pricing | TOKEN_USD + on-chain decimals :110-116 | works; most tokens unpriced → raw-labeled |
| Entity classes | :130-150 | v1 shipped fee9320 conflated EOA w/ artifact; FIXED to signer/executor pair model |
| Pipeline join | :142-152 | registry-presence only; WO-07 needs stage-level attribution |
| Ledger | data/speed/competitors.jsonl | append-only; no schema version, no dedupe/idempotent ingest (WO-03) |
| Pipeline counters | src/runner/arbRunner.ts stage timers + rejection counters | real stages: detect→zone→project→replay→qualify→preflight→submit→settle maps WO-14 nine-stage |
| Regime/variants/learner | src/engine/*, WO-13 Thompson | exist; not yet joined to CI (WO-08) |

## Defects fixed this pass
- blk+undefined ROOT CAUSE: rc.index doesn't exist on ethers receipts → rc.transactionIndex. Verified live: blk=26264138 txidx=177.
- Entity model corrected per Principal: verified_active_eoa_signer added; "contract+2arbs" no longer sole verified rule; tx.to captured as executor.

## Defects open
- No dedupe/idempotent ingest (re-runs double-count rows).
- No classification history/versioning (WO-03).
- profitUsd coverage low (TOKEN_USD majors only).
- Join is coverage-only — WO-07 needs per-stage loss attribution vs solver registry/projection.
- No rankings module (WO-06), no triggers (WO-09), no quarantine store (WO-03).

## Verified run (100 blk, eth, shadow)
29 arbs, 27 senders, 1 liq | classes: 2 verified_active_contract, 1 verified_active_eoa_signer, 6 provisional_contract, 17 provisional_eoa_signer, 1 decode_artifact | join: 1 in / 15 partial / 13 not_in (registry=207)
