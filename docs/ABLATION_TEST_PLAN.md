# Ablation plan — test whether reduced set preserves decisions
A=full | B=CORE+GUARDRAIL | C=B minus one CORE metric each.
Metric: does the benchmark verdict change? does discovery-priority output change? does CMMC gate still pass?
Baseline: current 78-entity corpus, pinned store snapshot.
Acceptance: B must produce identical winner-verdict + identical discovery-priority set.
Cost measured: render ms, RPC calls (none for pure-data ablation).
