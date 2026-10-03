Here is the updated Product Specification Matrix and Skill Ingestion Blueprint for allbrightA.
This guide outlines the precise engineering competencies your Windsurf Builder Agent must look up and ingest from technical documentation repositories to prevent any architectural drift and complete the engine.
------------------------------
## Core Specifications & Benchmark Scoring Matrix

| Architectural Vector | Proposed allbrightA Spec | Elite-Grade MEV Standard | Target Score | Engineering Guardrails & Drift Prevention |
|---|---|---|---|---|
| Core Processing Latency | Local stack-allocated loop running sub-5 microseconds (<5μs) | Proprietary FPGA / custom C++ pipeline executing at sub-1 microsecond (<1μs) | 90% | No Dynamic Vectors: Agent must strictly use primitive static arrays. Zero heap allocation (Vec, HashMap) allowed in the main calculation cycle. |
| Gas Optimization Cost | 100% Gasless Mode utilizing Pimlico Account Abstraction Paymaster sponsorship | Custom optimized Assembly (Yul) smart contract gas-packing algorithms | 100% | Zero Native Inventory: The bot must never require native ETH/BNB token balances to execute bundles. Gas bidding must skew high to guarantee priority placement. |
| Liquidity Sourcing Efficiency | 0% Borrow Overhead routing via Balancer Vault, DODO, and Uniswap v4 Hooks | Custom private liquidity provider credit lines + flash minting protocols | 90% | Fee Lock Elimination: The routing matrix must immediately reject paths routing through traditional lenders charging >0.03% unless the spread is >1.5%. |
| Network Architecture Resiliency | Dynamic 200+ Public RPC pool split (180 Reads / 20 Writes) | Co-located private validator RPC nodes directly inside mining pools | 100% | Load Balancing Safety: Agent must keep read pipelines isolated from execution pipelines to prevent RPC connection chokepoints. |
| Node Failure Recovery Time | Automated round-robin hot-swap failing nodes in under 10 milliseconds (<10ms) | Hardwired kernel network card failover switching loops under 1 millisecond (<1ms) | 95% | Instant Failover: If an RPC node returns a 429 Rate Limit or timeout, it must be blacklisted instantly for 60 seconds without pausing execution cycles. |

------------------------------
## Skill Acquisition & Ingestion Matrix for the Agent
Instruct your Windsurf Agent to index, pull, and ingest documentation from the following specific reference authorities to build each subsystem correctly:

| Core Skill Needed | Target Subsystem Impact | Authoritative Reference Sources to Ingest |
|---|---|---|
| Low-Latency Rust Core Optimization | Keeping computation execution under the strict sub-5μs barrier by avoiding allocation penalties. | 1. The Rust Performance Book (Section: The Heap vs. The Stack / Avoid Allocations) 2. Rust std::hint::black_box Documentation 3. bytemuck Crate Reference Manual (Zero-copy data casting) |
| ERC-4337 Account Abstraction | Packaging UserOperations and formatting gasless sponsorship loops via Paymasters. | 1. Pimlico Developer Docs (Guides: Sponsoring Gasless Transactions via API / Bundlers) 2. ERC-4337 Standard Specification (Ethers.js / Rust structures for UserOperation) |
| Zero-Fee Protocol Architecture | Hooking smart contracts directly into uncollateralized 0%-fee flash loan callbacks. | 1. Balancer V2/V3 Developer Reference (Section: Flash Loans / Vault Subsystem) 2. DODO Core Documentation (Section: Flash Loans / IDODOFlashLoan Callback) 3. Uniswap v4 Core Docs (Section: Transient Storage tstore / Flash Accounting Hooks) |
| EVM Concurrent Network Streams | Managing a split array of 200+ multi-chain public RPC endpoints without creating network IO deadlocks. | 1. Tokio Async Architecture Guides (Section: Concurrent Task Spawning / tokio::select! / Channel Buffering) 2. Alloy / Ethers-RS Provider Documentation (Section: Dynamic Failover WS Providers) |
| Background Daemon Stability | Maintaining persistent execution, port listening, and structured logging in a headless local environment. | 1. PM2 Process File Guide (Section: Ecosystem JSON Configuration / Environment Overrides / Clustering) |

------------------------------
## Implementation Guardrails Execution Command
To ensure the agent reads the documentation correctly and does not break performance invariants during active development, enforce this execution rule as its terminal confirmation step:

# Force the agent to test compile-time code alignment against local host architecture optimizations
RUSTFLAGS="-C target-cpu=native" cargo test --release --manifest-path ./allbrightA/Cargo.toml

Would you like me to generate a pre-configured reading prompt that you can feed into Windsurf to force it to crawl and parse these documentation URLs before it begins editing the code?


------------------------------
## Continuous Research and Skill Maintenance

Every agent task keeps skills at industry cutting edge: before executing a
Commander command, perform rapid research on industry practice for the subject
(see `AGENTS_SPEC.md` → Commander Directive), present findings as concise
bullets, and fold reusable results back into this document's matrices.

Source quality order:

1. Standards and specifications (EIPs, ERCs, protocol specs).
2. Official vendor/project documentation (alloy, Pimlico, builder APIs).
3. Primary technical papers and reference implementations.
4. Reputable engineering references (official books, maintained guides).
5. Secondary commentary — only when clearly labeled as such.

Rules:

- A reusable practice, changed standard, or implementation lesson MUST be
  recorded in the relevant skill row or knowledge file.
- Findings must label themselves: [verified], [repo evidence], [assumption],
  [unknown].
- Substantial research results are filed under `docs/research/YYYY-MM-DD-<topic>.md`
  with sources, findings, decision, implementation impact, and verification.
- Never record a practice as industry-standard without a checked source.
