# WO-11 — private order flow + learned bidding verdict

**Status: capability built, shadow-mode only. No sends without Commander arming (WO-11's own rule + the standing arm gate).**

## Built

- `src/exec/flashbots.ts` + `mevSendBundle` — MEV-Share bundle with user body + max ONE backrun tx (spec `body` ordering; builders preference list supported).
- `src/private/hintStream.ts` — MEV-Share SSE reader (`mev-share.flashbots.net`): tx hash, `to`, fn selector, gas fields, **log metadata** — deduped, persisted to `data/private/mev_hints.jsonl`.
- `src/private/backrun.ts` — hint → touched-pool map via Swap-event topics ∩ registry → **ONE merged Multicall3 refresh** (post-hint state) → 2-leg peer-gap signal → `bundle_ledger.jsonl` (hintHash, path, gross, bid, callBundleOk, sent, included, blockDelta, realizedNet, refund).
- `src/bidding/bidModel.ts` — learned bid: `argmax_b p_win(b)·(gross−gas−premium−b)` over a grid; online logistic fit on (bidFrac, gap) → win; **CUSUM freeze** at cumulative over-prediction > 5 (auto-freezes the model, no silent decay).

## Measured reality

- MEV-Share exists on Ethereum mainnet only — the private-flow lane is eth-only by design (matches WO-11 spec).
- eth_callBundle gate is already live in `privateRoute.ts` — the backrun lane inherits it: **revert/OOG aborts before spending a slot**.
- The unsourced 50/80% bribe is retired on the private lane (still present in the public path — flagged, not hidden: `bidModel` replaces it as data accumulates).

## Honesty flags

- Hint volume is real but the stream needs ≥24h of `mev_hints.jsonl` before the logistic model has enough (bidFrac, win) pairs — cold-start fallback is a conservative Beta prior, not a made-up number.
- `mevSendBundle` is wired but unreachable without `WO11_LIVE_SEND` + the arm gate — consistent with "no live sends without approval."

## Gate assessment

- Capability: **built + shadow-validated path** (callBundle gate proven in WO-4/5 lineage).
- Live send: **GATED** (Commander).
