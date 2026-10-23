# WO-9 step 1 — semantic bytecode diff: deployed 0x6614… vs source

Method: eth_getCode on eth + PUSH4 selector-surface extraction, both sides.

- deployed (eth/base/arb, CREATE2-identical): 11,060 bytes
- current source (out/…/AllBrightExecutor.json): 9,016 bytes
- selector surface overlap: only 6 PUSH4 constants shared
  (1b11d0ff 23e30c8b 31f57072 43000818 8da5cb5b f04f2707 ffffffff)
- deployed LACKS: venue getters (balancerVault/aavePool/morpho/erc3156Lender),
  current exec() selector surface, panic codes — consistent with a build that
  predates the multi-venue layout (slots 2–5) and venue-ladder routing.
- Conclusion: deployed executor ≠ current source semantics — stale build
  confirmed at selector level, not just length. Redeploy required for the
  WO-9 leg kinds; pending Commander go.
