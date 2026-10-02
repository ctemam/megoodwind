#!/usr/bin/env python3
"""Generate the validated rpc_https_pool arrays for allbrightA.

Pulls the public endpoint registry (chainid.network/chains.json — the same
source Chainlist uses), handshakes every HTTPS node with eth_chainId in
parallel, keeps nodes that answer with the correct chain id, sorts them by
handshake latency, and emits a TOML `rpc_https_pool` array per chain.

Spec target: 200+ distinct nodes split across read/write topology. The public
registry won't always yield that many verified HTTPS endpoints; the script
emits everything that passes validation and reports the count.

Usage:
    python3 ops/gen_rpc_pool.py              # probe both chains, print TOML
    python3 ops/gen_rpc_pool.py --write      # also rewrite config/*.toml pools
    python3 ops/gen_rpc_pool.py --source rpcs.json  # offline registry file
"""

import argparse
import concurrent.futures
import json
import re
import sys
import time
import urllib.request

REGISTRY_URL = "https://chainid.network/chains.json"
# DefiLlama's extra RPCs — the much larger maintained list Chainlist renders.
EXTRA_RPCS_URL = "https://raw.githubusercontent.com/DefiLlama/chainlist/main/constants/extraRpcs.js"
# Community-maintained provider directory (arddluma/awesome-list-rpc-nodes-providers).
AWESOME_URL = "https://raw.githubusercontent.com/arddluma/awesome-list-rpc-nodes-providers/master/README.md"

# Curated public load-balancer/mirror families per chain. These are known
# public endpoint patterns from the community directories — each generated
# variant is still handshake-verified before entering the pool.
MIRROR_FAMILIES = {
    56: [
        "https://bsc-dataseed.binance.org",
        "https://bsc-dataseed{1,2}.binance.org",
        "https://bsc-dataseed{1,2,3,4}.bnbchain.org",
        "https://bsc-dataseed{1,2,3,4}.ninicoin.io",
        "https://bsc-dataseed{1,2,3,4}.defibit.io",
        "https://bsc.publicnode.com",
        "https://bsc-rpc.publicnode.com",
        "https://binance.llamarpc.com",
        "https://binance.nodereal.io",
        "https://bsc.drpc.org",
        "https://bsc.rpc.blxrbdn.com",
        "https://bsc.blockpi.network/v1/rpc/public",
        "https://bsc.api.onfinality.io/public",
        "https://bnb.api.onfinality.io/public",
        "https://bsc-mainnet.public.blastapi.io",
        "https://bsc.meowrpc.com",
        "https://1rpc.io/bnb",
        "https://rpc.ankr.com/bsc",
        "https://endpoints.omniatech.io/v1/bsc/mainnet/public",
        "https://bsc-mainnet.gateway.tatum.io",
        "https://api.zan.top/bsc-mainnet",
        "https://bsc.api.pocket.network",
        "https://bscrpc.com",
        "https://bsc.rpcgator.com",
        "https://public.stackup.sh/api/v1/node/bsc-mainnet",
        "https://0.48.club",
        "https://rpc-bsc.48.club",
        "https://xrpc.cl/bsc",
        "https://rpc.swiftnodes.io/rpc/bsc",
        "https://bsc-mainnet.gateway.pokt.network/v1/lb/6136201a7bad1500343e248d",
        "https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3",
        "https://api-bsc-mainnet-full.n.dwellir.com/2ccf18bf-2916-4198-8856-42172854353c",
        "https://bsc.chainnodes.org",
        "https://bnb.rpc.subquery.network/public",
    ],
    8453: [
        "https://mainnet.base.org",
        "https://base.publicnode.com",
        "https://base-rpc.publicnode.com",
        "https://base.llamarpc.com",
        "https://base.drpc.org",
        "https://base.rpc.blxrbdn.com",
        "https://base.blockpi.network/v1/rpc/public",
        "https://base.api.onfinality.io/public",
        "https://base-mainnet.public.blastapi.io",
        "https://base.meowrpc.com",
        "https://1rpc.io/base",
        "https://rpc.ankr.com/base",
        "https://endpoints.omniatech.io/v1/base/mainnet/public",
        "https://base.gateway.tenderly.co",
        "https://base.gateway.tatum.io",
        "https://api.zan.top/base-mainnet",
        "https://base.api.pocket.network",
        "https://base.nodies.app",
        "https://base-pokt.nodies.app",
        "https://public.stackup.sh/api/v1/node/base-mainnet",
        "https://base.rpc.subquery.network/public",
        "https://base.chainnodes.org",
        "https://xrpc.cl/base",
        "https://api.developer.coinbase.com/rpc/v1/base/Ajyky1REgqRiNiKzsV8GbqWnLFMqaNBL",
    ],
}

# Public WSS candidates for the mempool stream pool (unverified here — the
# watcher fast-fails dead entries and cycles to the next provider).
# WSS seeds verified live against eth_subscribe newPendingTransactions
# (2026-10-02): BSC publicnode endpoints stream FULL tx objects; onfinality
# public-ws streams full txs on Base. Base publicnode/tenderly accept the
# sub but emit no events — kept as backups only.
WSS_SEEDS = {
    56: [
        "wss://bsc-rpc.publicnode.com",
        "wss://bsc.publicnode.com",
        "wss://bsc.drpc.org",
    ],
    8453: [
        "wss://base.api.onfinality.io/public-ws",
        "wss://base-rpc.publicnode.com",
        "wss://base.publicnode.com",
        "wss://base.gateway.tenderly.co",
    ],
}
# Spec budget for the failover switch; endpoints slower than this at startup
# are still kept (they're bench candidates) but sorted to the back.
PROBE_TIMEOUT_S = 6
MAX_WORKERS = 64

CHAINS = {
    "bsc": (56, "config/bsc.toml"),
    "base": (8453, "config/base.toml"),
}

ENV_URL_RE = re.compile(r"\$\{[^}]+\}")


def fetch_registry(path: str | None) -> list:
    if path:
        with open(path) as f:
            return json.load(f)
    req = urllib.request.Request(REGISTRY_URL, headers={"User-Agent": "allbrightA-rpcgen/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def candidate_urls(registry: list, chain_id: int) -> list[str]:
    urls = []
    for chain in registry:
        if chain.get("chainId") != chain_id:
            continue
        for entry in chain.get("rpc", []):
            url = entry.get("url", "") if isinstance(entry, dict) else entry
            if not isinstance(url, str) or not url.startswith("https://"):
                continue
            if ENV_URL_RE.search(url):  # needs an API key we don't have
                continue
            url = url.rstrip("/")
            if url not in urls:
                urls.append(url)
    return urls


def extra_rpcs_urls(chain_id: int) -> list[str]:
    """Scrape https URLs for this chain from DefiLlama's extraRpcs.js.
    It's a JS module, not JSON — we take every https url that appears within
    the block for the requested chainId."""
    req = urllib.request.Request(EXTRA_RPCS_URL, headers={"User-Agent": "allbrightA-rpcgen/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode()
    except Exception as e:
        print(f"extraRpcs fetch failed: {e}", file=sys.stderr)
        return []
    urls = []
    # Each entry looks like: 56: { rpcs: [ "https://...", {url: "..."}, ... ] }
    m = re.search(rf"\b{chain_id}\s*:\s*{{", text)
    if not m:
        return urls
    block = text[m.start():]
    nxt = re.search(r"\n  \d+\s*:", block[1:])  # next top-level chain entry (2-space indent)
    block = block[: (1 + nxt.start()) if nxt else 100_000]
    for url in re.findall(r'url:\s*[\'"`](https?://[^\'"`]+)|["\'`](https?://[^"\'`]+)["\'`]', block):
        u = next((x for x in url if x), "")
        if not u.startswith("https://") or ENV_URL_RE.search(u):
            continue
        u = u.rstrip("/")
        if u not in urls:
            urls.append(u)
    return urls


def registry_wss(registry: list, chain_id: int) -> list[str]:
    urls = []
    for chain in registry:
        if chain.get("chainId") != chain_id:
            continue
        for entry in chain.get("rpc", []):
            url = entry.get("url", "") if isinstance(entry, dict) else entry
            if isinstance(url, str) and url.startswith("wss://") and url not in urls:
                urls.append(url.rstrip("/"))
    return urls


_AWESOME_HINTS = {56: ("bsc", "binance", "bnb"), 8453: ("base",)}


def awesome_urls(chain_id: int) -> list[str]:
    """Extract public endpoints for the chain from the awesome-list README."""
    req = urllib.request.Request(AWESOME_URL, headers={"User-Agent": "allbrightA-rpcgen/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode()
    except Exception as e:
        print(f"awesome-list fetch failed: {e}", file=sys.stderr)
        return []
    hints = _AWESOME_HINTS.get(chain_id, ())
    urls = []
    for raw in re.findall(r'https?://[^\s)"|<>,\]]+', text):
        u = raw.rstrip("/")
        if not u.startswith("https://") or ENV_URL_RE.search(u):
            continue
        # keep only urls whose host/path names the chain (bsc/binance/bnb, base)
        low = u.lower()
        if any(h in low for h in hints) and u not in urls:
            urls.append(u)
    return urls


def expand_mirrors(pattern: str) -> list[str]:
    """'https://x{1,2,4}.y' -> ['https://x1.y', 'https://x2.y', 'https://x4.y']"""
    m = re.search(r"\{([\d,]+)\}", pattern)
    if not m:
        return [pattern]
    return [pattern[: m.start()] + n + pattern[m.end():] for n in m.group(1).split(",")]


def write_wss_pool(path: str, urls: list[str]) -> None:
    with open(path) as f:
        text = f.read()
    # Strip any existing rpc_wss_pool wherever it landed, then insert inside
    # the [chain] table, right after the rpc_wss line.
    text = re.sub(r'\n?# WSS pool for mempool stream[^\n]*\n?rpc_wss_pool\s*=\s*\[[^\]]*\]\n?|rpc_wss_pool\s*=\s*\[[^\]]*\]\n?',
                  '', text, flags=re.S)
    block = ("# WSS pool for mempool stream — cycled on failure/backpressure\n"
             + "rpc_wss_pool = [\n" + "\n".join(f'    "{u}",' for u in urls) + "\n]\n")
    m = re.search(r'^rpc_wss\s*=.*$', text, flags=re.M)
    if m:
        text = text[:m.end()] + "\n" + block + text[m.end():]
    else:
        raise RuntimeError(f"no rpc_wss anchor in {path}")
    with open(path, "w") as f:
        f.write(text)


def probe(url: str, chain_id: int) -> tuple[str, float | None]:
    """POST eth_chainId; return (url, latency_s) if it answers correctly."""
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []}
    ).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}
    )
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT_S) as r:
            resp = json.loads(r.read())
        if int(resp.get("result", "0x0"), 16) == chain_id:
            return url, time.monotonic() - t0
    except Exception:
        pass
    return url, None


def toml_array(urls: list[str]) -> str:
    lines = [f'    "{u}",' for u in urls]
    return "rpc_https_pool = [\n" + "\n".join(lines) + "\n]"


def rewrite_toml(path: str, urls: list[str]) -> None:
    with open(path) as f:
        text = f.read()
    new_block = toml_array(urls)
    if "rpc_https_pool" in text:
        text = re.sub(
            r'rpc_https_pool\s*=\s*\[[^\]]*\]', new_block, text, count=1, flags=re.S
        )
    else:
        text = text.rstrip() + "\n\n# Validated read pool — generated by ops/gen_rpc_pool.py\n" + new_block + "\n"
    with open(path, "w") as f:
        f.write(text)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="rewrite config/*.toml pools")
    ap.add_argument("--source", help="local chains.json instead of live fetch")
    ap.add_argument("--keep-existing", action="store_true",
                    help="merge generated list with any rpc_https_pool already in config")
    args = ap.parse_args()

    registry = fetch_registry(args.source)
    rc = 0

    for name, (chain_id, cfg_path) in CHAINS.items():
        cands = candidate_urls(registry, chain_id)
        for u in extra_rpcs_urls(chain_id):
            if u not in cands:
                cands.append(u)
        for u in awesome_urls(chain_id):
            if u not in cands:
                cands.append(u)
        for pattern in MIRROR_FAMILIES.get(chain_id, []):
            for u in expand_mirrors(pattern):
                if u not in cands:
                    cands.append(u)
        print(f"[{name}] chain {chain_id}: {len(cands)} candidate HTTPS endpoints", file=sys.stderr)

        verified: list[tuple[str, float]] = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            for url, lat in ex.map(lambda u: probe(u, chain_id), cands):
                if lat is not None:
                    verified.append((url, lat))
        verified.sort(key=lambda x: x[1])
        urls = [u for u, _ in verified]

        if args.keep_existing:
            try:
                with open(cfg_path) as f:
                    existing = re.findall(r'"(https?://[^"]+)"',
                                          re.search(r'rpc_https_pool\s*=\s*\[([^\]]*)\]', f.read(), re.S).group(1))
                for u in existing:
                    if u not in urls:
                        urls.insert(0, u)  # env-provided endpoints lead the pool
            except Exception:
                pass

        print(f"[{name}] {len(verified)} verified (handshake+chainId ok), "
              f"fastest {verified[0][1]*1000:.0f}ms {verified[0][0] if verified else ''}", file=sys.stderr)
        if len(verified) < 100:
            print(f"[{name}] WARNING: only {len(verified)} public endpoints verified — "
                  f"spec target 200+ needs private/paid nodes too", file=sys.stderr)
            rc = 2

        if args.write:
            rewrite_toml(cfg_path, urls)
            wss = WSS_SEEDS.get(chain_id, []) + registry_wss(registry, chain_id)
            wss = list(dict.fromkeys(wss))  # dedupe, keep seed order first
            write_wss_pool(cfg_path, wss)
            print(f"[{name}] wrote {len(urls)} urls -> {cfg_path}", file=sys.stderr)
        else:
            print(f"# {name} (chain {chain_id}) — {len(urls)} verified endpoints")
            print(toml_array(urls))
    return rc


if __name__ == "__main__":
    sys.exit(main())
