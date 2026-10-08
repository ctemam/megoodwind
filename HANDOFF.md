# allbrightA fleet — operator handoff

Date: 2026-10-04. Session: https://app.devin.ai/sessions/4d1b6cbade5d4df7907005ca15a2c814

## What is running, right now

All processes run on this box, watchdog-managed (`/home/ubuntu/watchdog.sh`,
30s cycle: restarts dead processes, kills + restarts runners with frozen
evals or dead metrics ports for >90s, logs to `/home/ubuntu/watchdog.log`).

| Process | Config | Metrics | Log |
|---|---|---|---|
| arb-runner (BSC, LIVE) | `~/run-configs/bsc.toml` | :9100 | `repos/megoodwind/logs/bsc.log` |
| arb-runner (Ethereum, LIVE) | `~/run-configs/ethereum.toml` | :9102 | `logs/eth.log` (check filename) |
| arb-runner (Polygon, LIVE) | `~/run-configs/polygon.toml` | :9103 | `logs/polygon.log` |
| leader_scan --loop (BSC, Polygon) | same | — | `logs/scan-*.log` |
| profit_profile (BSC, Polygon) | same | — | `logs/profprofile-*.log` |
| dashboard API+static | `apps/dashboard` | :9200 | via nohup |

Dashboard: https://9200--4d1b6cbade5d4df7907005ca15a2c814.preview.devinapps.com/
(only while this VM is awake)

Mode: `dry_run=false` on all three chains — REAL submissions attempted.
`arb_dry_run` gauge = 0 on each metrics port. Confirm anytime:
`curl -s localhost:9100/metrics | grep arb_dry_run`

## Keys and secrets

- `/home/ubuntu/run-configs/secrets.env` (chmod 600): `PRIVATE_KEY`,
  `PIMLICO_API_KEY`, `PROFIT_WALLET`, `PROFIT_TRANSFER_MODE=AUTO`,
  `PROFIT_TRANSFER_MIN_USD=100`. Sourced by watchdog.sh (`set -a`).
- Executor wallet `0x2eF34d88EC4EBBd5543fFF2784D5AdbC01f14D56` (= PROFIT_WALLET).
  **0 native balance** — workable only because execution is sponsored ERC-4337
  (Pimlico pays gas from the account's Pimlico balance). Watch that balance.
- The wallet's 0x-prefixed private key also still sits in
  `~/run-configs/bsc.toml` `signer_key_envs` fallback — sanitize if the file
  leaves this box.
- Org-secret saves for PRIVATE_KEY + PIMLICO_API_KEY were requested;
  approval state unknown in the Devin UI.

## Code state

Repo `/home/ubuntu/repos/megoodwind`, branch
`devin/1791013932-backrun-projection` (PR #2, open, not merged).
Latest commit `e27ac7c`. Built: `cargo build --release` (binary in
`target/release/`). **Never run rustfmt** — the repo is not formatted to
stable rustfmt and it will trash diffs.

Key recent changes (all on that branch):
- `arb_backrun_stage_total{stage}` — per-terminal-stage counter
  (recheck_dead, exec_probe_dead, bundle_fail, venue_accept/reject/error).
  Dashboard Strategies page shows it as "Backrun kill stages".
- Feed records (`data/leaders/<Chain>/_opportunities.jsonl`) are written
  ONLY for candidates surviving the real-state re-check.
- `profit_profile` no longer stamps `execution_status=ready` —
  replay-positive is scoring evidence, not a live opportunity.
- Dashboard "Actionable" = `execution_status=ready` rows only.
- Dust floor: backrun victims < $25 skipped (was producing 949 phantom
  accepts/day from ~$1 txs).
- Net-of-gas gate, targeted backrun refresh, V3 over-liquidity guard,
  V4 pool support (extsload reads), `[leaders]` discovery on all chains,
  leader_scan/profit_profile `--loop`, multicall timeout tuning.

## Verified system truth (measured, not guessed)

1. **Backrun edges are transient.** 949 gate-accepts → 0 submits. Real
   victims' accepts all die at the post-refresh re-check ("Backrun edge
   gone on re-check", now info-level) — the dislocation is captured
   in-block by faster bots.
2. **strict_4337 is structurally slow.** Executor contract's onlyOwner is
   the Pimlico smart account → all execution is sponsored standalone
   UserOps landing NEXT block. No `[victim, ours]` in-block bundle is
   possible. Only dislocations persisting ≥1 block are capturable.
   `arb_backrun_no_venue_total` counts bundle drops if non-4337 paths try.
3. **Resting arb finds near-nothing** on free public RPC: sim-positive
   candidates die at `below_min_usd` / `below_safety_margin` (mean edge
   ≈ −$0.011 net of gas). The gate is working correctly; the edges are
   noise-thin at this latency.
4. **Leaders bank real money**: decoded BSC leader trades $104–$7,001
   each (~$17.4k in the first 10 decoded). Their routes merge into
   `config/bsc.toml` pools every 15 min via leader_scan --merge
   (pool count grew 111→124+).
5. **StateReader on BSC is an old deployment** lacking `readV*` — every
   refresh uses per-protocol Multicall3 fan-out (~600-700ms). Redeploying
   `contracts/src/StateReader.sol` and updating `state_reader` in
   `~/run-configs/bsc.toml` (and `config/bsc.toml`) is the single biggest
   staleness cut available. Needs a funded deployer key.
6. Free-RPC fragility: aggregate3 batches >~60 calls timed out →
   `MC3_MAX_CALLS=30` (compiled-in); timeouts fell ~97%.

## What still blocks profit (honest list)

- Speed. Public RPC + next-block UserOps cannot win in-block MEV. The
  edge class this stack CAN capture (persistent multi-block
  dislocations, leader-route replays) is rare — maybe a few per hour.
- BSC StateReader redeploy (above) — do this first on any box with keys.
- The deployed executor can also do owner-signed txs if a NON-4337 path
  is configured (`strict_4337=false` + funded wallet) enabling real
  bundle backruns — but that changes the sponsorship model and needs
  gas funding + venue config. Decision required.
- `_opportunities.jsonl` grows unbounded — rotate/prune periodically.

## Ops cheat sheet

- Watchdog control: `pgrep -af "bash watchdog"` → kill by PID, then
  `cd ~ && nohup bash watchdog.sh > watchdog.log 2>&1 &`
- Kill pattern gotcha: `pkill -f arb-runner` can self-match; use
  `pkill -f "arb-runner .*run-configs/bsc.toml"` from a shell that
  doesn't contain that pattern in its own cmdline.
- Config edits to `~/run-configs/*.toml` need runner restart:
  `pkill -f "arb-runner .*run-configs/<chain>.toml"` (watchdog relaunches).
- Secrets CRLF: if a .env value ever ends in `\r`, TOML parse breaks —
  `sed -i 's/\r$//' file`.
- Dashboard rebuild: `cd apps/dashboard &&
  PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH npm run build`, then kill
  the node server (watchdog restarts it).
- Build: `cargo build --release -p arb-runner` ~1-2 min; warnings are
  pre-existing, ignore.

## If the next operator is a Devin session

It inherits this VM only if the org keeps this session's box; otherwise
the repo (PR #2) + this file carry the state. secrets.env must be
re-provisioned — values came from the user's ENV.txt attachment
(`~/attachments/38d58e64-83d0-4f44-9ccd-f0ce50fe725b/ENV.txt`).
