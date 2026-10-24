# Master Engineering Program: Competitive Intelligence, Adversarial Verification & Autonomous Learning
Baseline: commit fee9320 (adversarial layer) + 300-block eth run (3 verified_active / 25 provisional_eoa / 3 provisional_contract)

## Work orders (one coordinated program, dependency-aware, no approval stops between routine WOs)
- WO-01 repo audit + baseline map — GATE: every change maps to verified req/defect
- WO-02 canonical identity model: sender/signer, tx.to contract, internal calls, operator clusters w/ confidence, strategy fingerprints. EOA ≠ fake; contract ≠ legit
- WO-03 adversarial verification + evidence provenance: 8 classes, tiered evidence, receipt verification, dedupe/idempotent ingest, decimal/valuation checks, quarantine+release, versioned classification history. GATE: corrupted fixtures can't become verified facts
- WO-04 tx metadata + econ reconstruction: FIX blk+undefined via authoritative sources; distinguish exec success / flows / gross / costs / net / unknown; unpriced ≠ zero
- WO-05 cross-chain ingestion + data quality: coverage, decode, receipts, dedupe, pricing coverage, endpoint health; L2 ordering kept separate
- WO-06 verified discovery + TWO rankings (performance vs threat), confidence-aware, min evidence, recency, sample sizes
- WO-07 competitor→pipeline loss attribution: reconcile in_registry=3/partial=16/not_in=35 against real dataset; not-found ≠ was-profitable
- WO-08 strategy/variant/regime intelligence: gap→hypothesis→baseline→acceptance→validation→rollback
- WO-09 autonomous triggers + self-learning: detect→verify→classify→benchmark→attribute→diagnose→propose→evaluate→validate→record→monitor; no trigger storms; hypothesis≠validated≠deployed
- WO-10 security/autonomy boundaries: L1-3 auto, L4 Commander-held; negative tests required
- WO-11 integration + observability + reporting with denominators; unknown≠zero
- WO-12 e2e + adversarial test fixtures (EOA searchers, contract exec, dups, reverts, missing metadata, unpriced tokens, misattribution, conflicting sources, RPC failure, unauthorized live-change attempts)
- WO-13 final audit + docs + release decision; implemented vs tested vs verified vs unverified separated
- WO-14 (ADDENDUM, mandatory): nine-stage opportunity→execution diagnostics + controlled self-correction. Stages: detect/validate/project/simulate/generate/qualify/preflight/submit/settle. Correlation-id lifecycle records, 12 root-cause families, self-correction lifecycle detect→diagnose→evidence→component→propose→replay-eval→baseline-compare→validate→integrate→monitor. Never auto-loosen thresholds. Integrates WO-07/08/09/10/12.

## Standing rules
- Evidence before expansion; verified/shadow/fork/live labels preserved
- No live changes, arming, redeploy, spend, or gate-threshold edits without Commander
- 5-min test cycles; report window/denominator/source/evidence class
- Unknown stays unknown; fabricated results forbidden; live blocker register
- Current branch: feat/direct-swap-exec

## Known defects entering program
- blk+undefined on arb rows (WO-04)
- in_registry join not yet reconciled to dataset (WO-07)
- EOA misclass risk — "contract+2arbs" is provisional only, not permanent verified rule (WO-02)
- Most competitor profitRaw unpriced (WO-04)
- blk+undefined → position mapping unverified (WO-04)
