# D7 — Gate A false-pass probability (written check, thresholds unchanged)

Gate A as committed: N ≥ 12 distinct-block candidates, settle ratio ≥ 20%
(≥3 at N=12, ≥4 at N=20, ≥6 at N=30), mean model error ≤ 5%.

## Binomial false-pass under stated nulls

| Null settle rate p0 | Rationale | N=12 (≥3) | N=20 (≥4) | N=30 (≥6) |
|---|---|---|---|---|
| **p0 = 0.02** | phantom-edge lane — measured baseline: WO-6 0/26k probe rows, WO-9 replay 0/3 | 0.15% | 0.06% | <0.01% |
| **p0 = 0.05** | real-but-rare edge surviving the corrected in-tick model | 1.96% | 1.59% | 0.33% |
| **p0 = 0.10** | generous null — genuine thin edge mostly eaten by gas | 11.1% | 13.3% | 7.3% |

## Reading

- Under the measured baseline (p0 ≈ 0.02 — what the replay actually
  showed), Gate A is **conservative**: ~0.15% chance a dead lane passes
  at N=12.
- Under a generous null (p0 = 0.10), the N=12 gate is weak: **11%
  false-pass**. The N=30 requirement tightens it to 7.3% but still weak.
- The model-error criterion (≤5%) does independent work — a phantom
  edge can luck through settle rate only if real executions happen to
  land; the model check catches systematic over-prediction separately.

## Written proposal (for Principal Architect decision — NOT applied)

- **Option 1 (recommended):** require N ≥ 20 (≥4 settles) — at p0=0.10
  false-pass falls to 13.3%, and N=20 is feasible in a single
  observation window.
- **Option 2:** keep N=12 but require the settles to include ≥2
  distinct paths — kills the "one lucky path repeated" pass.
- **Option 3:** keep as-is — under the measured p0 the gate is already
  conservative; the weak case only matters if the true settle rate is
  ~10%, which the replay says it isn't.
- Thresholds are unchanged pending your written decision.
