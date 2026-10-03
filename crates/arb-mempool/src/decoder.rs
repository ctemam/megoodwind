//! Pending-transaction decoder.
//!
//! Every standard ABI signature is decoded by generated `sol!` bindings that
//! self-select on the 4-byte selector — one declaration per real on-chain
//! signature (tuple vs flat params, with vs without deadline), so no manual
//! offset probing is needed and adding a router variant is one line.
//!
//! Manual byte parsing survives only where the payload is NOT a plain ABI
//! call: packed V3 `bytes path`, Universal Router command streams, and
//! opaque aggregator blobs (KyberSwap/OKX/OpenOcean).

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use tracing::trace;

// ── ABI bindings ────────────────────────────────────────────────────────────

/// swap() called directly on a pool contract — `to` IS the pool.
mod pool_v2 {
    alloy::sol! {
        function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data);
    }
}
mod pool_v3 {
    alloy::sol! {
        function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes data);
    }
}

/// multicall wrappers — PCS V3 SwapRouter & friends batch their calls.
mod mc {
    alloy::sol! {
        function multicall(bytes[] data) external payable returns (bytes[] memory);
        function multicall(uint256 deadline, bytes[] data) external payable returns (bytes[] memory);
        function multicall(bytes32 previousBlockHash, bytes[] data) external payable returns (bytes[] memory);
    }
}

/// Canonical Uniswap V2 router family — every V2 fork (Pancake, Biswap,
/// Sushi, PCS `swap`) shares these signatures. Aerodrome's router carries a
/// `Route[]` struct instead of `address[]`.
mod v2r {
    alloy::sol! {
        function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline);
        function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline);
        function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline);
        function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline);
        function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable;
        function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline) payable;
        function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline);
        function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline);
        function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable;
    }
}
mod pcs_smart {
    alloy::sol! {
        function swap(uint256 amountIn, uint256 amountOutMin, address[] path, address to);
    }
}
mod aero_router {
    alloy::sol! {
        struct Route { address from; address to; bool stable; address factory; }
        function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] routes, address to, uint256 deadline);
        function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, Route[] routes, address to, uint256 deadline);
        function swapExactETHForTokens(uint256 amountOutMin, Route[] routes, address to, uint256 deadline) payable;
    }
}

/// Uniswap V3 router family. Four real variants of each call: params shipped
/// as a tuple or as flat args, with or without `deadline` in the params
/// (SwapRouter has it; SwapRouter02/PCS forks dropped it). All eight are
/// overloads of the same names — declared here, sol! numbers them and
/// abi_decode_validate self-selects on the selector.
mod v3 {
    alloy::sol! {
        // exactInputSingle — tuple + deadline (SwapRouter)
        function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160) params) external payable returns (uint256);
        // exactInputSingle — tuple, no deadline (SwapRouter02 / PCS V3)
        function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160) params) external payable returns (uint256);
        // exactInputSingle — flat + deadline
        function exactInputSingle(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) external payable returns (uint256);
        // exactInputSingle — flat, no deadline
        function exactInputSingle(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) external payable returns (uint256);
        // exactInput — tuple + deadline
        function exactInput((bytes,address,uint256,uint256,uint256) params) external payable returns (uint256);
        // exactInput — tuple, no deadline
        function exactInput((bytes,address,uint256,uint256) params) external payable returns (uint256);
        // exactInput — flat + deadline
        function exactInput(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) external payable returns (uint256);
        // exactInput — flat, no deadline
        function exactInput(bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) external payable returns (uint256);
    }
}

/// Universal Router execute().
mod ur {
    alloy::sol! {
        function execute(bytes commands, bytes[] inputs) external payable;
        function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable;
    }
}

/// 1inch AggregationRouter v5/v6 `swap` — the SwapDescription struct IS a
/// canonical ABI type, generated decoding is exact.
mod inch5 {
    alloy::sol! {
        struct SwapDescription {
            address srcToken; address dstToken; address srcReceiver; address dstReceiver;
            uint256 amount; uint256 minReturnAmount; uint256 flags;
        }
        function swap(address caller, SwapDescription desc, bytes permit, bytes data) external payable returns (uint256, uint256);
    }
}
mod inch6 {
    alloy::sol! {
        struct SwapDescription {
            address srcToken; address dstToken; address srcReceiver; address dstReceiver;
            uint256 amount; uint256 minReturnAmount; uint256 flags;
        }
        function swap(address executor, SwapDescription desc, bytes data) external payable returns (uint256, uint256);
    }
}
mod inch_uno {
    alloy::sol! {
        function unoswapTo(address to, address token, uint256 amount, uint256 minReturn, uint256[] pools) external payable returns (uint256);
        function unoswapTo(address to, address token, uint256 amount, uint256 minReturn, bytes32[] pools) external payable returns (uint256);
        function unoswap(address srcToken, uint256 amount, uint256 minReturn, bytes32[] pools) external payable returns (uint256);
        function unoswap(address srcToken, uint256 amount, uint256 minReturn, uint256[] pools) external payable returns (uint256);
    }
}

// ── Public types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct DecodedSwap {
    pub router: &'static str,
    pub token_in: Option<Address>,
    pub token_out: Option<Address>,
    pub amount_in: Option<U256>,
    /// Full token path the swap will traverse (empty when the calldata does not
    /// carry an explicit path, e.g. aggregator descriptions). `path[0] ->
    /// path[1]` is the first hop — the pool that receives the full `amount_in`
    /// price impact and therefore the pool a backrun must project.
    pub path: Vec<Address>,
    /// First-hop pool fee in UniswapV3 fee units (1e-6), when the calldata
    /// carries it. Used to disambiguate same-pair pools.
    pub first_hop_fee: Option<u32>,
    /// Per-hop pool fees in UniswapV3 fee units (1e-6) when the calldata packs
    /// them (V3 packed paths); `hop_fees[i]` is the fee of `path[i] -> path[i+1]`.
    /// Empty for V2/aggregator decodes.
    pub hop_fees: Vec<u32>,
    /// Set when the tx calls `swap()` directly on a pool contract instead of
    /// going through a router — `to` IS the pool, so projection needs no
    /// pair/fee matching at all.
    pub direct: Option<DirectSwap>,
    pub pools_touched: Vec<Address>,
}

/// A swap() call made directly on a pool contract (bots and aggregator
/// executors routinely skip the router). The callee is the pool itself.
#[derive(Debug, Clone)]
pub enum DirectSwap {
    /// swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data) —
    /// UniswapV2-family pools (Pancake/Biswap/Aero volatile). The calldata
    /// carries the exact OUTPUT; the input is recovered via `get_amount_in`
    /// against the pool's current reserves — fully precise either way.
    V2 {
        pool: Address,
        amount0_out: U256,
        amount1_out: U256,
    },
    /// swap(address recipient, bool zeroForOne, int256 amountSpecified,
    /// uint160 sqrtPriceLimitX96, bytes data) — UniswapV3-family pools
    /// (incl. Algebra & Slipstream, same signature). Only exact-input calls
    /// (amountSpecified > 0) are decodable without a quoter.
    V3 {
        pool: Address,
        zero_for_one: bool,
        amount_in: U256,
    },
}

pub struct TxDecoder;

fn read_u256(data: &[u8], word: usize) -> Option<U256> {
    let start = word * 32;
    if data.len() < start + 32 { return None; }
    Some(U256::from_be_slice(&data[start..start + 32]))
}

fn read_addr(data: &[u8], word: usize) -> Option<Address> {
    let start = word * 32 + 12;
    if data.len() < start + 20 { return None; }
    Some(Address::from_slice(&data[start..start + 20]))
}

/// Result of decoding a swap calldata: the full token path (when present), the
/// first-hop V3 fee (when present), and the input amount.
struct DecodedRoute {
    path: Vec<Address>,
    first_hop_fee: Option<u32>,
    hop_fees: Vec<u32>,
    amount_in: U256,
}

/// Tokenize a packed V3 path (`token[20] fee[3] token[20] ...`).
/// Returns (tokens, hop_fees) or None when the encoding is malformed;
/// `hop_fees[i]` is the fee tier of `tokens[i] -> tokens[i+1]`.
fn unpack_v3_path(path_bytes: &[u8]) -> Option<(Vec<Address>, Vec<u32>)> {
    let len = path_bytes.len();
    if len < 20 || (len - 20) % 23 != 0 { return None; }
    let n_tokens = (len - 20) / 23 + 1; // hops + 1
    let mut tokens = Vec::with_capacity(n_tokens);
    let mut fees = Vec::with_capacity(n_tokens.saturating_sub(1));
    for i in 0..n_tokens {
        let off = i * 23;
        tokens.push(Address::from_slice(&path_bytes[off..off + 20]));
        if i + 1 < n_tokens {
            let f = off + 20;
            fees.push(u32::from_be_bytes([0, path_bytes[f], path_bytes[f + 1], path_bytes[f + 2]]));
        }
    }
    Some((tokens, fees))
}

/// Walk a Universal Router command stream for the first V2/V3 swap command.
/// Commands: 0x00/0x01 = V3_SWAP_EXACT_IN/OUT, 0x08/0x09 = V2_SWAP_EXACT_IN/OUT.
/// The command byte stream and per-command input blob are UR-internal formats
/// (not ABI calls) — the surrounding `execute(bytes,bytes[])` envelope was
/// already ABI-decoded by the caller.
/// A UR tx may chain several commands; the first swap command carries the
/// entry leg we project (0x01/0x09 pay amountInMax — close enough for a
/// price-impact screen).
fn decode_ur_commands(commands: &[u8], inputs: &[alloy_primitives::Bytes]) -> Option<DecodedRoute> {
    for (i, &b) in commands.iter().enumerate().take(16) {
        let cmd = b & 0x1f;
        if !matches!(cmd, 0x00 | 0x01 | 0x08 | 0x09) {
            continue;
        }
        let exact_out = matches!(cmd, 0x01 | 0x09);
        let Some(input_data) = inputs.get(i).map(|b| b.as_ref()) else { continue };
        let input_data: &[u8] = input_data;

        // (recipient, amountIn|amountOut, amountOutMin|amountInMax, path, payerIsUser)
        if input_data.len() < 4 * 32 { continue; }
        // EXACT_OUT orders (amountOut, amountInMax): the max bounds the input.
        let amount_in = read_u256(input_data, if exact_out { 2 } else { 1 })?;
        let path_offset: usize = read_u256(input_data, 3)?.try_into().ok()?;
        let path_len_off = path_offset / 32;
        let path_len: usize = read_u256(input_data, path_len_off)?.try_into().ok()?;

        match cmd {
            0x00 | 0x01 => {
                if path_len < 43 { continue; } // min: 20 + 3 + 20
                let path_start = path_offset + 32;
                if input_data.len() < path_start + path_len { continue; }
                if let Some((tokens, hop_fees)) =
                    unpack_v3_path(&input_data[path_start..path_start + path_len])
                {
                    if tokens.len() >= 2 {
                        return Some(DecodedRoute {
                            path: tokens,
                            first_hop_fee: hop_fees.first().copied(),
                            hop_fees,
                            amount_in,
                        });
                    }
                }
            }
            _ => {
                if path_len < 2 { continue; }
                let mut path = Vec::with_capacity(path_len);
                let mut ok = true;
                for j in 0..path_len {
                    match read_addr(input_data, path_len_off + 1 + j) {
                        Some(a) => path.push(a),
                        None => { ok = false; break; }
                    }
                }
                if ok {
                    return Some(DecodedRoute { path, first_hop_fee: None, hop_fees: Vec::new(), amount_in });
                }
            }
        }
    }
    None
}

/// Heuristic for the aggregator blobs we can't fully decode (KyberSwap, OKX,
/// OpenOcean): their calldata embeds a SwapDescription-shaped tuple; grab
/// srcToken/dstToken/amount at the desc offsets. In/out pair + amount is all
/// a backrun screen needs — the venue stays unknown.
fn decode_swap_description(data: &[u8]) -> Option<DecodedRoute> {
    if data.len() < 7 * 32 { return None; }
    let desc_offset: usize = read_u256(data, 1)?.try_into().ok()?;
    let base = desc_offset / 32;
    let src_token = read_addr(data, base)?;
    let dst_token = read_addr(data, base + 1)?;
    let amount = read_u256(data, base + 4)?;
    Some(DecodedRoute { path: vec![src_token, dst_token], first_hop_fee: None, hop_fees: Vec::new(), amount_in: amount })
}

fn mk_route(path: Vec<Address>, amount_in: U256) -> Option<DecodedRoute> {
    if path.len() < 2 {
        return None;
    }
    Some(DecodedRoute { path, first_hop_fee: None, hop_fees: Vec::new(), amount_in })
}

fn mk_v3_single(token_in: Address, token_out: Address, fee: u32, amount_in: U256) -> Option<DecodedRoute> {
    Some(DecodedRoute {
        path: vec![token_in, token_out],
        first_hop_fee: Some(fee),
        hop_fees: vec![fee],
        amount_in,
    })
}

fn mk_v3_multi(path_bytes: &[u8], amount_in: U256) -> Option<DecodedRoute> {
    let (tokens, hop_fees) = unpack_v3_path(path_bytes)?;
    if tokens.len() < 2 {
        return None;
    }
    Some(DecodedRoute {
        path: tokens,
        first_hop_fee: hop_fees.first().copied(),
        hop_fees,
        amount_in,
    })
}

fn fee_u32(fee: alloy_primitives::Uint<24, 1>) -> u32 {
    fee.as_limbs()[0] as u32
}

/// Decode the router-level call (anything whose `to` is a router/aggregator,
/// not a pool). Returns the router label + route on success.
fn decode_router(input: &[u8], value: U256) -> Option<(&'static str, DecodedRoute)> {
    // ── V2-family exact-input calls ─────────────────────────────────────
    if let Ok(c) = v2r::swapExactTokensForTokensCall::abi_decode_validate(input) {
        return mk_route(c.path, c.amountIn).map(|r| ("UniV2_swapExactTokensForTokens", r));
    }
    if let Ok(c) = v2r::swapExactTokensForTokensSupportingFeeOnTransferTokensCall::abi_decode_validate(input) {
        return mk_route(c.path, c.amountIn).map(|r| ("PCS_swap", r));
    }
    if let Ok(c) = v2r::swapExactTokensForETHCall::abi_decode_validate(input) {
        return mk_route(c.path, c.amountIn).map(|r| ("UniV2_swapExactTokensForETH", r));
    }
    if let Ok(c) = v2r::swapExactTokensForETHSupportingFeeOnTransferTokensCall::abi_decode_validate(input) {
        return mk_route(c.path, c.amountIn).map(|r| ("UniV2_swapExactTokensForETH_FOT", r));
    }
    // ── V2-family exact-output calls — amountInMax bounds the input ──────
    if let Ok(c) = v2r::swapTokensForExactTokensCall::abi_decode_validate(input) {
        return mk_route(c.path, c.amountInMax).map(|r| ("UniV2_swapTokensForExactTokens", r));
    }
    if let Ok(c) = v2r::swapTokensForExactETHCall::abi_decode_validate(input) {
        return mk_route(c.path, c.amountInMax).map(|r| ("UniV2_swapTokensForExactETH", r));
    }
    // ── V2 ETH-in calls — the input is msg.value ─────────────────────────
    if let Ok(c) = v2r::swapExactETHForTokensCall::abi_decode_validate(input) {
        return mk_route(c.path, value).map(|r| ("UniV2_swapExactETHForTokens", r));
    }
    if let Ok(c) = v2r::swapExactETHForTokensSupportingFeeOnTransferTokensCall::abi_decode_validate(input) {
        return mk_route(c.path, value).map(|r| ("UniV2_swapExactETHForTokens_FOT", r));
    }
    if let Ok(c) = v2r::swapETHForExactTokensCall::abi_decode_validate(input) {
        return mk_route(c.path, value).map(|r| ("UniV2_swapETHForExactTokens", r));
    }
    // ── PCS Smart Router `swap` (V2 arg layout, no deadline) ─────────────
    if let Ok(c) = pcs_smart::swapCall::abi_decode_validate(input) {
        return mk_route(c.path, c.amountIn).map(|r| ("PCS_swap", r));
    }
    // ── Aerodrome router — Route[] instead of address[] path ─────────────
    if let Ok(c) = aero_router::swapExactTokensForTokensCall::abi_decode_validate(input) {
        return aero_route_path(&c.routes, c.amountIn)
            .map(|r| ("Aero_swapExactTokensForTokens", r));
    }
    if let Ok(c) = aero_router::swapExactTokensForETHCall::abi_decode_validate(input) {
        return aero_route_path(&c.routes, c.amountIn)
            .map(|r| ("Aero_swapExactTokensForETH", r));
    }
    if let Ok(c) = aero_router::swapExactETHForTokensCall::abi_decode_validate(input) {
        return aero_route_path(&c.routes, value)
            .map(|r| ("Aero_swapExactETHForTokens", r));
    }
    // ── V3 exactInputSingle — all four layouts ───────────────────────────
    if let Ok(c) = v3::exactInputSingle_0Call::abi_decode_validate(input) {
        let p = &c.params;
        return mk_v3_single(p.0, p.1, fee_u32(p.2), p.5)
            .map(|r| ("UniV3_exactInputSingle", r));
    }
    if let Ok(c) = v3::exactInputSingle_1Call::abi_decode_validate(input) {
        let p = &c.params;
        return mk_v3_single(p.0, p.1, fee_u32(p.2), p.4)
            .map(|r| ("UniV3_exactInputSingle", r));
    }
    if let Ok(c) = v3::exactInputSingle_2Call::abi_decode_validate(input) {
        return mk_v3_single(c.tokenIn, c.tokenOut, fee_u32(c.fee), c.amountIn)
            .map(|r| ("UniV3_exactInputSingle", r));
    }
    if let Ok(c) = v3::exactInputSingle_3Call::abi_decode_validate(input) {
        return mk_v3_single(c.tokenIn, c.tokenOut, fee_u32(c.fee), c.amountIn)
            .map(|r| ("UniV3_exactInputSingle", r));
    }
    // ── V3 exactInput — all four layouts ─────────────────────────────────
    if let Ok(c) = v3::exactInput_0Call::abi_decode_validate(input) {
        return mk_v3_multi(&c.params.0, c.params.3)
            .map(|r| ("UniV3_exactInput", r));
    }
    if let Ok(c) = v3::exactInput_1Call::abi_decode_validate(input) {
        return mk_v3_multi(&c.params.0, c.params.2)
            .map(|r| ("UniV3_exactInput", r));
    }
    if let Ok(c) = v3::exactInput_2Call::abi_decode_validate(input) {
        return mk_v3_multi(&c.path, c.amountIn)
            .map(|r| ("UniV3_exactInput", r));
    }
    if let Ok(c) = v3::exactInput_3Call::abi_decode_validate(input) {
        return mk_v3_multi(&c.path, c.amountIn)
            .map(|r| ("UniV3_exactInput", r));
    }
    // ── Universal Router ─────────────────────────────────────────────────
    if let Ok(c) = ur::execute_0Call::abi_decode_validate(input) {
        return decode_ur_commands(&c.commands, &c.inputs)
            .map(|r| ("UniversalRouter_execute", r));
    }
    if let Ok(c) = ur::execute_1Call::abi_decode_validate(input) {
        return decode_ur_commands(&c.commands, &c.inputs)
            .map(|r| ("UniversalRouter_execute_deadline", r));
    }
    // ── 1inch (canonical SwapDescription) ────────────────────────────────
    if let Ok(c) = inch5::swapCall::abi_decode_validate(input) {
        return mk_route(vec![c.desc.srcToken, c.desc.dstToken], c.desc.amount)
            .map(|r| ("1inch_swap", r));
    }
    if let Ok(c) = inch6::swapCall::abi_decode_validate(input) {
        return mk_route(vec![c.desc.srcToken, c.desc.dstToken], c.desc.amount)
            .map(|r| ("1inch_v6_swap", r));
    }
    if let Ok(c) = inch_uno::unoswapTo_0Call::abi_decode_validate(input) {
        return mk_route(vec![c.token], c.amount).map(|r| ("1inch_unoswapTo", r));
    }
    if let Ok(c) = inch_uno::unoswapTo_1Call::abi_decode_validate(input) {
        return mk_route(vec![c.token], c.amount).map(|r| ("1inch_unoswapTo", r));
    }
    if let Ok(c) = inch_uno::unoswap_0Call::abi_decode_validate(input) {
        return mk_route(vec![c.srcToken], c.amount).map(|r| ("1inch_unoswap", r));
    }
    if let Ok(c) = inch_uno::unoswap_1Call::abi_decode_validate(input) {
        return mk_route(vec![c.srcToken], c.amount).map(|r| ("1inch_unoswap", r));
    }
    // ── Aggregators with non-canonical blobs — heuristic only ────────────
    let data = &input[4..];
    match &input[..4] {
        [0xe2, 0x1f, 0xd0, 0xe9] => {
            return decode_swap_description(data).map(|r| ("KyberSwap_swap", r));
        }
        [0x90, 0x41, 0x1a, 0x32] => {
            return decode_swap_description(data).map(|r| ("OpenOcean_swap", r));
        }
        [0x36, 0xb1, 0xa1, 0xbc] => {
            return decode_swap_description(data).map(|r| ("OKX_swap", r));
        }
        _ => {}
    }
    None
}

/// Flatten an Aerodrome `Route[]` into a token path.
fn aero_route_path(routes: &[aero_router::Route], amount_in: U256) -> Option<DecodedRoute> {
    if routes.is_empty() {
        return None;
    }
    let mut path = Vec::with_capacity(routes.len() + 1);
    path.push(routes[0].from);
    for r in routes {
        path.push(r.to);
    }
    mk_route(path, amount_in)
}

impl TxDecoder {
    pub fn new() -> Self {
        Self
    }

    pub fn decode(&self, to: Address, value: U256, input: &[u8]) -> Option<DecodedSwap> {
        self.decode_inner(to, value, input, 0)
    }

    fn decode_inner(&self, to: Address, value: U256, input: &[u8], depth: usize) -> Option<DecodedSwap> {
        if input.len() < 4 {
            return None;
        }

        // Direct pool swap() calls: `to` is the pool — no pair guessing.
        if let Ok(c) = pool_v2::swapCall::abi_decode_validate(input) {
            if c.amount0Out.is_zero() == c.amount1Out.is_zero() {
                return None;
            }
            return Some(DecodedSwap {
                router: "V2Pool_swap",
                token_in: None,
                token_out: None,
                amount_in: None,
                path: Vec::new(),
                first_hop_fee: None,
                hop_fees: Vec::new(),
                direct: Some(DirectSwap::V2 {
                    pool: to,
                    amount0_out: c.amount0Out,
                    amount1_out: c.amount1Out,
                }),
                pools_touched: vec![to],
            });
        }
        if let Ok(c) = pool_v3::swapCall::abi_decode_validate(input) {
            // int256 amountSpecified: positive = exact input; negative
            // (exact-out) carries no decodable input — skip.
            if c.amountSpecified.is_zero() || c.amountSpecified.is_negative() {
                return None;
            }
            let amount_in = c.amountSpecified.into_raw();
            return Some(DecodedSwap {
                router: "V3Pool_swap",
                token_in: None,
                token_out: None,
                amount_in: Some(amount_in),
                path: Vec::new(),
                first_hop_fee: None,
                hop_fees: Vec::new(),
                direct: Some(DirectSwap::V3 {
                    pool: to,
                    zero_for_one: c.zeroForOne,
                    amount_in,
                }),
                pools_touched: vec![to],
            });
        }

        // multicall(bytes[]) wrappers — unwrap one level, take the first
        // element that decodes as a swap.
        if depth == 0 {
            if let Ok(c) = mc::multicall_0Call::abi_decode_validate(input) {
                return self.decode_elements(to, value, &c.data);
            }
            if let Ok(c) = mc::multicall_1Call::abi_decode_validate(input) {
                return self.decode_elements(to, value, &c.data);
            }
            if let Ok(c) = mc::multicall_2Call::abi_decode_validate(input) {
                return self.decode_elements(to, value, &c.data);
            }
        }

        let (router, route) = decode_router(input, value)?;
        trace!(router, to = %to, "Decoded pending swap tx");

        let token_in = route.path.first().copied();
        let token_out = if route.path.len() >= 2 { route.path.last().copied() } else { None };
        Some(DecodedSwap {
            router,
            token_in,
            token_out,
            amount_in: Some(route.amount_in),
            path: route.path,
            first_hop_fee: route.first_hop_fee,
            hop_fees: route.hop_fees,
            direct: None,
            pools_touched: vec![],
        })
    }

    /// Decode each element of a decoded multicall payload; first swap wins.
    fn decode_elements(
        &self,
        to: Address,
        value: U256,
        elements: &[alloy_primitives::Bytes],
    ) -> Option<DecodedSwap> {
        for el in elements.iter().take(8) {
            if let Some(swap) = self.decode_inner(to, value, el.as_ref(), 1) {
                return Some(swap);
            }
        }
        None
    }
}

impl Default for TxDecoder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::address;

    fn pad_u256(val: U256) -> [u8; 32] {
        val.to_be_bytes()
    }

    fn pad_addr(addr: Address) -> [u8; 32] {
        let mut buf = [0u8; 32];
        buf[12..].copy_from_slice(addr.as_slice());
        buf
    }

    #[test]
    fn test_decode_known_v2_selector() {
        let decoder = TxDecoder::new();
        let selector = [0x38, 0xed, 0x17, 0x39];
        let t_in = address!("1111111111111111111111111111111111111111");
        let t_out = address!("2222222222222222222222222222222222222222");
        let amount_in = U256::from(1000u64);

        let mut data = Vec::new();
        data.extend_from_slice(&selector);
        data.extend_from_slice(&pad_u256(amount_in));
        data.extend_from_slice(&pad_u256(U256::from(1u64)));
        data.extend_from_slice(&pad_u256(U256::from(160u64)));
        data.extend_from_slice(&pad_addr(Address::ZERO));
        data.extend_from_slice(&pad_u256(U256::from(1234567890u64)));
        data.extend_from_slice(&pad_u256(U256::from(2u64)));
        data.extend_from_slice(&pad_addr(t_in));
        data.extend_from_slice(&pad_addr(t_out));

        let decoded = decoder.decode(Address::ZERO, U256::ZERO, &data).unwrap();
        assert_eq!(decoded.router, "UniV2_swapExactTokensForTokens");
        assert_eq!(decoded.amount_in, Some(amount_in));
        assert_eq!(decoded.token_in, Some(t_in));
        assert_eq!(decoded.token_out, Some(t_out));
    }

    #[test]
    fn test_decode_too_short() {
        let decoder = TxDecoder::new();
        let input = [0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x00, 0x00, 0x00];
        assert!(decoder.decode(Address::ZERO, U256::ZERO, &input).is_none());
        let input2 = [0x38, 0xed];
        assert!(decoder.decode(Address::ZERO, U256::ZERO, &input2).is_none());
    }

    #[test]
    fn test_decode_v3_selector() {
        let decoder = TxDecoder::new();
        let selector = [0x41, 0x4b, 0xf3, 0x89]; // tuple + deadline
        let t_in = address!("1111111111111111111111111111111111111111");
        let t_out = address!("2222222222222222222222222222222222222222");
        let amount_in = U256::from(5000u64);

        // All-static tuple param encodes inline — params start at word0.
        let mut data = Vec::new();
        data.extend_from_slice(&selector);
        data.extend_from_slice(&pad_addr(t_in));
        data.extend_from_slice(&pad_addr(t_out));
        data.extend_from_slice(&pad_u256(U256::from(3000u64)));
        data.extend_from_slice(&pad_addr(Address::ZERO));
        data.extend_from_slice(&pad_u256(U256::from(1_800_000_000u64))); // deadline
        data.extend_from_slice(&pad_u256(amount_in));
        data.extend_from_slice(&pad_u256(U256::from(1u64)));
        data.extend_from_slice(&pad_u256(U256::ZERO));

        let decoded = decoder.decode(Address::ZERO, U256::ZERO, &data).unwrap();
        assert_eq!(decoded.router, "UniV3_exactInputSingle");
        assert_eq!(decoded.amount_in, Some(amount_in));
        assert_eq!(decoded.first_hop_fee, Some(3000));
    }

    #[test]
    fn test_decode_v3_exact_input_tuple_form() {
        let decoder = TxDecoder::new();
        let selector = [0xc0, 0x4b, 0x8d, 0x59]; // exactInput tuple + deadline
        let t_in = address!("1111111111111111111111111111111111111111");
        let t_out = address!("2222222222222222222222222222222222222222");
        let amount_in = U256::from(9000u64);

        let mut pb = Vec::new();
        pb.extend_from_slice(t_in.as_slice());
        pb.extend_from_slice(&[0x00, 0x0b, 0xb8]);
        pb.extend_from_slice(t_out.as_slice());

        // tuple-wrapped: word0=tuple offset; tuple: [path_off=0xa0, recipient, deadline, amountIn, amountOutMin]
        let mut data = Vec::new();
        data.extend_from_slice(&selector);
        data.extend_from_slice(&pad_u256(U256::from(32u64)));       // tuple offset
        data.extend_from_slice(&pad_u256(U256::from(160u64)));      // word1: path offset (rel to tuple base)
        data.extend_from_slice(&pad_addr(Address::ZERO));           // recipient
        data.extend_from_slice(&pad_u256(U256::from(1_800_000_000u64))); // deadline
        data.extend_from_slice(&pad_u256(amount_in));               // amountIn
        data.extend_from_slice(&pad_u256(U256::from(1u64)));        // amountOutMin
        data.extend_from_slice(&pad_u256(U256::from(43u64)));       // path len
        let mut w = [0u8; 64];
        w[..43].copy_from_slice(&pb);
        data.extend_from_slice(&w);

        let decoded = decoder.decode(Address::ZERO, U256::ZERO, &data).unwrap();
        assert_eq!(decoded.token_in, Some(t_in));
        assert_eq!(decoded.token_out, Some(t_out));
        assert_eq!(decoded.amount_in, Some(amount_in));
        assert_eq!(decoded.first_hop_fee, Some(3000));
    }

    #[test]
    fn test_decode_v3_exact_input_flat_form() {
        let decoder = TxDecoder::new();
        let selector = [0x41, 0xf9, 0xad, 0x65]; // exactInput flat + deadline
        let t_in = address!("1111111111111111111111111111111111111111");
        let t_out = address!("2222222222222222222222222222222222222222");
        let amount_in = U256::from(9000u64);

        let mut pb = Vec::new();
        pb.extend_from_slice(t_in.as_slice());
        pb.extend_from_slice(&[0x00, 0x01, 0xf4]); // fee 500
        pb.extend_from_slice(t_out.as_slice());

        // flat: word0=path offset(0xa0), recipient, deadline, amountIn, amountOutMin, len, data
        let mut data = Vec::new();
        data.extend_from_slice(&selector);
        data.extend_from_slice(&pad_u256(U256::from(160u64)));       // word0: path offset 5*32
        data.extend_from_slice(&pad_addr(Address::ZERO));             // word1: recipient
        data.extend_from_slice(&pad_u256(U256::from(1_800_000_000u64))); // word2: deadline
        data.extend_from_slice(&pad_u256(amount_in));                 // word3: amountIn
        data.extend_from_slice(&pad_u256(U256::from(1u64)));          // word4: amountOutMin
        data.extend_from_slice(&pad_u256(U256::from(43u64)));         // word5: len
        let mut w = [0u8; 64];
        w[..43].copy_from_slice(&pb);
        data.extend_from_slice(&w);

        let decoded = decoder.decode(Address::ZERO, U256::ZERO, &data).unwrap();
        assert_eq!(decoded.token_in, Some(t_in));
        assert_eq!(decoded.amount_in, Some(amount_in)); // deadline skipped
        assert_eq!(decoded.first_hop_fee, Some(500));
    }

    #[test]
    fn test_decode_ur_second_command_is_swap() {
        let decoder = TxDecoder::new();
        let selector = [0x35, 0x93, 0x56, 0x4c]; // execute(bytes,bytes[],uint256)
        let t_in = address!("1111111111111111111111111111111111111111");
        let t_out = address!("2222222222222222222222222222222222222222");
        let amount_in = U256::from(4000u64);

        // commands: [0x0b WRAP_ETH, 0x08 V2_SWAP_EXACT_IN], inputs = [input0, input1]
        let mut data = Vec::new();
        data.extend_from_slice(&selector);
        data.extend_from_slice(&pad_u256(U256::from(96u64)));   // word0: commands offset
        data.extend_from_slice(&pad_u256(U256::from(160u64)));  // word1: inputs offset
        data.extend_from_slice(&pad_u256(U256::from(999u64)));  // word2: deadline
        // word3: commands len = 2
        data.extend_from_slice(&pad_u256(U256::from(2u64)));
        let mut cmds = [0u8; 32];
        cmds[0] = 0x0b; cmds[1] = 0x08; // packed command bytes, left-aligned
        data.extend_from_slice(&cmds); // word4
        // inputs at word5: len=2, then two element offsets (rel to word6)
        data.extend_from_slice(&pad_u256(U256::from(2u64)));    // word5: inputs len
        data.extend_from_slice(&pad_u256(U256::from(64u64)));   // word6: input[0] rel offset
        data.extend_from_slice(&pad_u256(U256::from(128u64)));  // word7: input[1] rel offset
        // input[0] at word8: len=4, data (wrap_eth: recipient+amount=64b... any content)
        data.extend_from_slice(&pad_u256(U256::from(4u64)));
        data.extend_from_slice(&pad_u256(U256::ZERO));
        // input[1] at word10: len=256 (8 words), then V2 params
        data.extend_from_slice(&pad_u256(U256::from(256u64)));  // word10: input1 len
        // V2_SWAP_EXACT_IN input: recipient, amountIn, amountOutMin, path_off=0xa0, payerIsUser
        data.extend_from_slice(&pad_addr(Address::ZERO));        // word11: recipient
        data.extend_from_slice(&pad_u256(amount_in));            // word12: amountIn
        data.extend_from_slice(&pad_u256(U256::from(1u64)));     // word13: amountOutMin
        data.extend_from_slice(&pad_u256(U256::from(160u64)));   // word14: path offset
        data.extend_from_slice(&pad_u256(U256::from(0u64)));     // word15: payerIsUser
        // path at word16: len=2, t_in, t_out
        data.extend_from_slice(&pad_u256(U256::from(2u64)));
        data.extend_from_slice(&pad_addr(t_in));
        data.extend_from_slice(&pad_addr(t_out));

        let decoded = decoder.decode(Address::ZERO, U256::ZERO, &data).unwrap();
        assert_eq!(decoded.path, vec![t_in, t_out]);
        assert_eq!(decoded.amount_in, Some(amount_in));
    }

    #[test]
    fn test_decode_pcs_swap() {
        let decoder = TxDecoder::new();
        let selector = [0x5c, 0x11, 0xd7, 0x95]; // swapExactTokensForTokensSupportingFeeOnTransferTokens
        let t_in = address!("1111111111111111111111111111111111111111");
        let t_out = address!("2222222222222222222222222222222222222222");
        let amount_in = U256::from(7777u64);

        let mut data = Vec::new();
        data.extend_from_slice(&selector);
        data.extend_from_slice(&pad_u256(amount_in));
        data.extend_from_slice(&pad_u256(U256::from(1u64)));
        data.extend_from_slice(&pad_u256(U256::from(160u64)));
        data.extend_from_slice(&pad_addr(Address::ZERO));
        data.extend_from_slice(&pad_u256(U256::from(1234567890u64)));
        data.extend_from_slice(&pad_u256(U256::from(2u64)));
        data.extend_from_slice(&pad_addr(t_in));
        data.extend_from_slice(&pad_addr(t_out));

        let decoded = decoder.decode(Address::ZERO, U256::ZERO, &data).unwrap();
        assert_eq!(decoded.router, "PCS_swap");
        assert_eq!(decoded.path, vec![t_in, t_out]);
        assert_eq!(decoded.amount_in, Some(amount_in));
    }

    #[test]
    fn test_read_u256_basic() {
        let val = U256::from(42u64);
        let buf = pad_u256(val);
        let mut data = vec![0u8; 32];
        data.extend_from_slice(&buf);
        assert_eq!(read_u256(&data, 0), Some(U256::ZERO));
        assert_eq!(read_u256(&data, 1), Some(val));
        assert_eq!(read_u256(&data, 2), None);
    }

    #[test]
    fn test_read_addr_basic() {
        let addr = address!("1234567890abcdef1234567890abcdef12345678");
        let buf = pad_addr(addr);
        let result = read_addr(&buf, 0).unwrap();
        assert_eq!(result, addr);
    }

    #[test]
    fn test_decode_v2_pool_swap() {
        let decoder = TxDecoder::new();
        let pool = address!("3333333333333333333333333333333333333333");
        let mut data = Vec::new();
        data.extend_from_slice(&[0x02, 0x2c, 0x0d, 0x9f]);           // swap(uint256,uint256,address,bytes)
        data.extend_from_slice(&pad_u256(U256::ZERO));               // amount0Out = 0
        data.extend_from_slice(&pad_u256(U256::from(777u64)));       // amount1Out
        data.extend_from_slice(&pad_addr(Address::ZERO));            // to
        data.extend_from_slice(&pad_u256(U256::from(128u64)));       // data offset
        data.extend_from_slice(&pad_u256(U256::ZERO));               // data len

        let decoded = decoder.decode(pool, U256::ZERO, &data).unwrap();
        assert_eq!(decoded.router, "V2Pool_swap");
        match decoded.direct {
            Some(DirectSwap::V2 { pool: p, amount0_out, amount1_out }) => {
                assert_eq!(p, pool);
                assert_eq!(amount0_out, U256::ZERO);
                assert_eq!(amount1_out, U256::from(777u64));
            }
            _ => panic!("expected direct V2 swap"),
        }
    }

    #[test]
    fn test_decode_v3_pool_swap_exact_in() {
        let decoder = TxDecoder::new();
        let pool = address!("4444444444444444444444444444444444444444");
        let mut data = Vec::new();
        data.extend_from_slice(&[0x12, 0x8a, 0xcb, 0x08]);           // swap(address,bool,int256,uint160,bytes)
        data.extend_from_slice(&pad_addr(Address::ZERO));            // recipient
        data.extend_from_slice(&pad_u256(U256::from(1u64)));         // zeroForOne
        data.extend_from_slice(&pad_u256(U256::from(4242u64)));      // amountSpecified > 0
        data.extend_from_slice(&pad_u256(U256::from(1u64)));         // sqrtPriceLimitX96
        data.extend_from_slice(&pad_u256(U256::from(160u64)));       // data offset
        data.extend_from_slice(&pad_u256(U256::ZERO));               // data len

        let decoded = decoder.decode(pool, U256::ZERO, &data).unwrap();
        assert_eq!(decoded.amount_in, Some(U256::from(4242u64)));
        match decoded.direct {
            Some(DirectSwap::V3 { pool: p, zero_for_one, amount_in }) => {
                assert_eq!(p, pool);
                assert!(zero_for_one);
                assert_eq!(amount_in, U256::from(4242u64));
            }
            _ => panic!("expected direct V3 swap"),
        }

        // Negative amountSpecified (exact-out) must not decode.
        let mut neg = Vec::new();
        neg.extend_from_slice(&[0x12, 0x8a, 0xcb, 0x08]);
        neg.extend_from_slice(&pad_addr(Address::ZERO));
        neg.extend_from_slice(&pad_u256(U256::from(1u64)));
        neg.extend_from_slice(&pad_u256(U256::MAX));                 // -1 as int256
        neg.extend_from_slice(&pad_u256(U256::from(1u64)));
        neg.extend_from_slice(&pad_u256(U256::from(160u64)));
        neg.extend_from_slice(&pad_u256(U256::ZERO));
        assert!(decoder.decode(pool, U256::ZERO, &neg).is_none());
    }

    #[test]
    fn test_decode_multicall_unwraps_inner_swap() {
        let decoder = TxDecoder::new();
        let t_in = address!("1111111111111111111111111111111111111111");
        let t_out = address!("2222222222222222222222222222222222222222");
        let amount_in = U256::from(1234u64);

        // Inner call: swapExactTokensForTokens(amountIn, minOut, path, to, deadline)
        let mut inner = Vec::new();
        inner.extend_from_slice(&[0x38, 0xed, 0x17, 0x39]);
        inner.extend_from_slice(&pad_u256(amount_in));               // amountIn
        inner.extend_from_slice(&pad_u256(U256::from(1u64)));        // amountOutMin
        inner.extend_from_slice(&pad_u256(U256::from(160u64)));      // path offset
        inner.extend_from_slice(&pad_addr(Address::ZERO));           // to
        inner.extend_from_slice(&pad_u256(U256::from(1_800_000_000u64))); // deadline
        inner.extend_from_slice(&pad_u256(U256::from(2u64)));        // path len
        inner.extend_from_slice(&pad_addr(t_in));
        inner.extend_from_slice(&pad_addr(t_out));

        // multicall(bytes[] data)
        let mut data = Vec::new();
        data.extend_from_slice(&[0xac, 0x96, 0x50, 0xd8]);
        data.extend_from_slice(&pad_u256(U256::from(32u64)));        // array offset
        data.extend_from_slice(&pad_u256(U256::from(1u64)));         // array len
        data.extend_from_slice(&pad_u256(U256::from(32u64)));        // elem offset (rel to array head)
        data.extend_from_slice(&pad_u256(U256::from(inner.len() as u64))); // elem len
        data.extend_from_slice(&inner);
        // pad elem to 32-byte boundary not needed for decode

        let decoded = decoder.decode(Address::ZERO, U256::ZERO, &data).unwrap();
        assert_eq!(decoded.router, "UniV2_swapExactTokensForTokens");
        assert_eq!(decoded.path, vec![t_in, t_out]);
        assert_eq!(decoded.amount_in, Some(amount_in));
    }
}
