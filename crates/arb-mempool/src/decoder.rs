use alloy_primitives::{Address, U256};
use tracing::trace;

pub struct TxDecoder {
    known_selectors: Vec<([u8; 4], &'static str)>,
}

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
    pub pools_touched: Vec<Address>,
}

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

fn decode_v2_swap(data: &[u8]) -> Option<DecodedRoute> {
    if data.len() < 5 * 32 { return None; }
    let amount_in = read_u256(data, 0)?;
    let path_offset = read_u256(data, 2)?.try_into().ok().unwrap_or(0usize);
    let path_len_offset = path_offset / 32;
    let path_len: usize = read_u256(data, path_len_offset)?.try_into().ok()?;
    if path_len < 2 { return None; }
    let mut path = Vec::with_capacity(path_len);
    for i in 0..path_len {
        path.push(read_addr(data, path_len_offset + 1 + i)?);
    }
    Some(DecodedRoute { path, first_hop_fee: None, hop_fees: Vec::new(), amount_in })
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

/// swapTokensForExactTokens/ETH(amountOut, amountInMax, path, to, deadline) —
/// the max bounds the real input, good enough for a price-impact screen.
fn decode_v2_exact_out(data: &[u8]) -> Option<DecodedRoute> {
    if data.len() < 5 * 32 { return None; }
    let amount_in_max = read_u256(data, 1)?;
    let path_offset = read_u256(data, 2)?.try_into().ok().unwrap_or(0usize);
    let path_len_offset = path_offset / 32;
    let path_len: usize = read_u256(data, path_len_offset)?.try_into().ok()?;
    if path_len < 2 { return None; }
    let mut path = Vec::with_capacity(path_len);
    for i in 0..path_len {
        path.push(read_addr(data, path_len_offset + 1 + i)?);
    }
    Some(DecodedRoute { path, first_hop_fee: None, hop_fees: Vec::new(), amount_in: amount_in_max })
}

/// swapExactETHForTokens(amountOutMin, path, to, deadline) — the input amount
/// is `msg.value`, carried separately from calldata.
fn decode_v2_eth_in(data: &[u8], value: U256) -> Option<DecodedRoute> {
    if data.len() < 4 * 32 { return None; }
    let path_offset: usize = read_u256(data, 1)?.try_into().ok()?;
    let path_len_offset = path_offset / 32;
    let path_len: usize = read_u256(data, path_len_offset)?.try_into().ok()?;
    if path_len < 2 { return None; }
    let mut path = Vec::with_capacity(path_len);
    for i in 0..path_len {
        path.push(read_addr(data, path_len_offset + 1 + i)?);
    }
    Some(DecodedRoute { path, first_hop_fee: None, hop_fees: Vec::new(), amount_in: value })
}

/// Two SwapRouter layouts exist in the wild: UniV3 SwapRouter puts `deadline`
/// between `recipient` and `amountIn`; SwapRouter02-style (and the PCS V3
/// routers that forked it) omit it. The deadline slot always holds a unix
/// timestamp (~1e9..1e10) while a sub-gwei swap amount would be dust — so the
/// value range disambiguates the layouts without knowing the router.
/// `word` = the slot after `recipient` in the params.
fn v3_amount_after_recipient(data: &[u8], word: usize) -> Option<U256> {
    let w = read_u256(data, word)?;
    if w >= U256::from(1_000_000_000u64) && w <= U256::from(10_000_000_000u64) {
        read_u256(data, word + 1)
    } else {
        Some(w)
    }
}

/// exactInputSingle ships both as `exactInputSingle(ExactInputSingleParams)`
/// (tuple-wrapped: word0 is the struct offset) and as flat args (tokenIn at
/// word0). A wrapped offset is small and lands on a word boundary pointing at
/// an address; a bare address does not satisfy that.
fn decode_v3_exact_input_single(data: &[u8]) -> Option<DecodedRoute> {
    if data.len() < 7 * 32 { return None; }
    // Flat form puts tokenIn at word0 — a 160-bit address that does not fit
    // usize, so the offset parse itself must be allowed to fail.
    let base = read_u256(data, 0)
        .and_then(|w| usize::try_from(w).ok())
        .filter(|&off| {
            off % 32 == 0 && off >= 32 && off + 32 <= data.len()
                && read_u256(data, off / 32)
                    .map_or(false, |w| w >> 160 == U256::ZERO)
        })
        .map(|off| off / 32)
        .unwrap_or(0);
    let token_in = read_addr(data, base)?;
    let token_out = read_addr(data, base + 1)?;
    let fee: u32 = read_u256(data, base + 2)?.try_into().ok()?;
    // Params: (tokenIn, tokenOut, fee, recipient, [deadline], amountIn, ...)
    let amount_in = v3_amount_after_recipient(data, base + 4)?;
    Some(DecodedRoute {
        path: vec![token_in, token_out],
        first_hop_fee: Some(fee),
        hop_fees: vec![fee],
        amount_in,
    })
}

/// Decode `exactInput` params whose first field is a packed `bytes path`,
/// starting at tuple base `base` (0 for the flat-arg form).
fn v3_exact_input_params(data: &[u8], base: usize) -> Option<DecodedRoute> {
    let path_bytes_offset: usize = read_u256(data, base)?.try_into().ok()?;
    let path_len_off = base + path_bytes_offset / 32;
    let path_len: usize = read_u256(data, path_len_off)?.try_into().ok()?;
    let path_start = path_len_off * 32 + 32;
    if data.len() < path_start + path_len { return None; }
    let (tokens, hop_fees) = unpack_v3_path(&data[path_start..path_start + path_len])?;
    if tokens.len() < 2 { return None; }
    // After the path field: recipient, [deadline], amountIn, amountOutMin
    let amount_in = v3_amount_after_recipient(data, base + 2)?;
    Some(DecodedRoute {
        path: tokens,
        first_hop_fee: hop_fees.first().copied(),
        hop_fees,
        amount_in,
    })
}

fn decode_v3_exact_input(data: &[u8]) -> Option<DecodedRoute> {
    if data.len() < 6 * 32 { return None; }
    let offset: usize = read_u256(data, 0)?.try_into().ok()?;
    // Tuple-wrapped form: word0 -> params struct whose first field is itself
    // a 32-aligned byte offset to the packed path. Flat-arg form puts the path
    // offset at word0; try the tuple interpretation first, then flat.
    if offset % 32 == 0 && offset >= 32 && offset + 32 <= data.len()
        && read_u256(data, offset / 32).map_or(false, |w| {
            let v: usize = w.try_into().unwrap_or(usize::MAX);
            v % 32 == 0 && v >= 32
        })
    {
        if let Some(r) = v3_exact_input_params(data, offset / 32) {
            return Some(r);
        }
    }
    v3_exact_input_params(data, 0)
}

/// Decode Universal Router `execute(bytes commands, bytes[] inputs, uint256 deadline)`.
/// Commands: 0x00/0x01 = V3_SWAP_EXACT_IN/OUT, 0x08/0x09 = V2_SWAP_EXACT_IN/OUT.
/// A UR tx may chain several commands; the first swap command carries the
/// entry leg we project (0x01/0x09 pay amountInMax — close enough for a
/// price-impact screen).
fn decode_universal_router(data: &[u8]) -> Option<DecodedRoute> {
    if data.len() < 4 * 32 { return None; }

    let commands_offset: usize = read_u256(data, 0)?.try_into().ok()?;
    let inputs_offset: usize = read_u256(data, 1)?.try_into().ok()?;

    let cmd_len_offset = commands_offset / 32;
    let cmd_len: usize = read_u256(data, cmd_len_offset)?.try_into().ok()?;
    if cmd_len == 0 { return None; }

    let cmd_data_start = commands_offset + 32;
    if data.len() < cmd_data_start + cmd_len { return None; }

    let inputs_len_offset = inputs_offset / 32;
    let inputs_len: usize = read_u256(data, inputs_len_offset)?.try_into().ok()?;
    if inputs_len == 0 { return None; }

    let first_input_ptr_offset = inputs_offset + 32;
    for i in 0..cmd_len.min(inputs_len).min(16) {
        let cmd = data[cmd_data_start + i] & 0x1f;
        if !matches!(cmd, 0x00 | 0x01 | 0x08 | 0x09) {
            continue;
        }
        let exact_out = matches!(cmd, 0x01 | 0x09);

        if data.len() < first_input_ptr_offset + 32 * (i + 1) { return None; }
        let input_rel: usize = read_u256(data, inputs_len_offset + 1 + i)?.try_into().ok()?;
        let input_abs = inputs_offset + 32 + input_rel;

        if data.len() < input_abs + 32 { return None; }
        let input_len: usize = U256::from_be_slice(
            &data[input_abs..input_abs + 32]
        ).try_into().ok()?;
        let input_data_start = input_abs + 32;
        if data.len() < input_data_start + input_len { return None; }
        let input_data = &data[input_data_start..input_data_start + input_len];

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

/// Decode 1inch/OpenOcean style swap with SwapDescription struct.
/// Layout: (address executor/caller, (address srcToken, address dstToken, address srcReceiver,
///          address dstReceiver, uint256 amount, ...) desc, bytes permit/data, bytes data)
fn decode_swap_description(data: &[u8]) -> Option<DecodedRoute> {
    if data.len() < 7 * 32 { return None; }
    let desc_offset: usize = read_u256(data, 1)?.try_into().ok()?;
    let base = desc_offset / 32;
    let src_token = read_addr(data, base)?;
    let dst_token = read_addr(data, base + 1)?;
    let amount = read_u256(data, base + 4)?;
    // Aggregators pick their own route — the in/out pair is all we know.
    Some(DecodedRoute { path: vec![src_token, dst_token], first_hop_fee: None, hop_fees: Vec::new(), amount_in: amount })
}

/// Decode 1inch unoswapTo: (address to, address srcToken, uint256 amount, uint256 minReturn, uint256[] pools)
fn decode_unoswap(data: &[u8]) -> Option<DecodedRoute> {
    if data.len() < 5 * 32 { return None; }
    let src_token = read_addr(data, 1)?;
    let amount = read_u256(data, 2)?;
    Some(DecodedRoute { path: vec![src_token], first_hop_fee: None, hop_fees: Vec::new(), amount_in: amount })
}

impl TxDecoder {
    pub fn new() -> Self {
        Self {
            known_selectors: vec![
                // V2-style routers
                ([0x38, 0xed, 0x17, 0x39], "UniV2_swapExactTokensForTokens"),
                ([0x7f, 0xf3, 0x6a, 0xb5], "UniV2_swapExactETHForTokens"),
                ([0x18, 0xcb, 0xaf, 0xe5], "UniV2_swapExactTokensForETH"),
                ([0xfb, 0x3b, 0xdb, 0x41], "UniV2_swapETHForExactTokens"),
                ([0x88, 0x03, 0xdb, 0xee], "UniV2_swapTokensForExactTokens"),
                ([0x4a, 0x25, 0xd9, 0x4a], "UniV2_swapTokensForExactETH"),
                ([0x79, 0x1a, 0xc9, 0x47], "UniV2_swapExactTokensForETH_FOT"),
                ([0xb6, 0xf9, 0xde, 0x95], "UniV2_swapExactETHForTokens_FOT"),
                ([0x62, 0x58, 0xf5, 0xf0], "Aero_swapExactTokensForTokens"),
                // V3 routers
                ([0x41, 0x4b, 0xf3, 0x89], "UniV3_exactInputSingle"),
                ([0xb8, 0x58, 0x18, 0x3f], "UniV3_exactInput"),
                // Universal Router
                ([0x35, 0x93, 0x56, 0x4c], "UniversalRouter_execute"),
                ([0x3f, 0x62, 0x19, 0x2f], "UniversalRouter_execute_deadline"),
                // PancakeSwap SmartRouter
                ([0x5c, 0x11, 0xd7, 0x95], "PCS_swap"),
                // 1inch v5/v6
                ([0x12, 0xaa, 0x3c, 0xaf], "1inch_swap"),
                ([0xf7, 0x8d, 0xc2, 0x53], "1inch_unoswapTo"),
                ([0xe2, 0xc9, 0x51, 0x59], "1inch_unoswap"),
                ([0x07, 0xed, 0x23, 0x79], "1inch_v6_swap"),
                // KyberSwap
                ([0xe2, 0x1f, 0xd0, 0xe9], "KyberSwap_swap"),
                // OpenOcean
                ([0x90, 0x41, 0x1a, 0x32], "OpenOcean_swap"),
                // OKX DEX
                ([0x36, 0xb1, 0xa1, 0xbc], "OKX_swap"),
            ],
        }
    }

    pub fn decode(&self, to: Address, value: U256, input: &[u8]) -> Option<DecodedSwap> {
        if input.len() < 4 {
            return None;
        }

        let selector: [u8; 4] = input[..4].try_into().ok()?;

        let router_name = self
            .known_selectors
            .iter()
            .find(|(sel, _)| sel == &selector)
            .map(|(_, name)| *name)?;

        trace!(router = router_name, to = %to, "Decoded pending swap tx");

        let data = &input[4..];
        let route = match router_name {
            "UniV2_swapExactETHForTokens" | "UniV2_swapETHForExactTokens" |
            "UniV2_swapExactETHForTokens_FOT" => decode_v2_eth_in(data, value),
            "UniV2_swapTokensForExactTokens" | "UniV2_swapTokensForExactETH" =>
                decode_v2_exact_out(data),
            // These all share the V2-style layout (amountIn, amountOutMin,
            // address[] path, to, deadline) — 0x5c11d795 is the canonical
            // swapExactTokensForTokensSupportingFeeOnTransferTokens selector.
            "UniV2_swapExactTokensForTokens" | "UniV2_swapExactTokensForETH" |
            "UniV2_swapExactTokensForETH_FOT" |
            "Aero_swapExactTokensForTokens" | "PCS_swap" => decode_v2_swap(data),
            "UniV3_exactInputSingle" => decode_v3_exact_input_single(data),
            "UniV3_exactInput" => decode_v3_exact_input(data),
            "UniversalRouter_execute" | "UniversalRouter_execute_deadline" =>
                decode_universal_router(data),
            "1inch_swap" | "1inch_v6_swap" | "OpenOcean_swap" | "OKX_swap" | "KyberSwap_swap" =>
                decode_swap_description(data),
            "1inch_unoswapTo" | "1inch_unoswap" => decode_unoswap(data),
            _ => None,
        };

        let (path, first_hop_fee, hop_fees, amount_in) = match route {
            Some(r) => (r.path, r.first_hop_fee, r.hop_fees, Some(r.amount_in)),
            None => (Vec::new(), None, Vec::new(), None),
        };
        let token_in = path.first().copied();
        let token_out = if path.len() >= 2 { path.last().copied() } else { None };

        Some(DecodedSwap {
            router: router_name,
            token_in,
            token_out,
            amount_in,
            path,
            first_hop_fee,
            hop_fees,
            pools_touched: vec![],
        })
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
        let bytes: [u8; 32] = val.to_be_bytes();
        bytes
    }

    fn pad_addr(addr: Address) -> [u8; 32] {
        let mut word = [0u8; 32];
        word[12..32].copy_from_slice(addr.as_slice());
        word
    }

    #[test]
    fn test_decode_known_v2_selector() {
        let decoder = TxDecoder::new();
        let selector = [0x38, 0xed, 0x17, 0x39];
        let token_in = address!("1111111111111111111111111111111111111111");
        let token_out = address!("2222222222222222222222222222222222222222");
        let amount_in = U256::from(1000u64);

        let mut data = Vec::new();
        data.extend_from_slice(&selector);
        data.extend_from_slice(&pad_u256(amount_in));                // word 0: amountIn
        data.extend_from_slice(&pad_u256(U256::from(1u64)));         // word 1: amountOutMin
        data.extend_from_slice(&pad_u256(U256::from(160u64)));       // word 2: path offset = 5*32
        data.extend_from_slice(&pad_addr(Address::ZERO));            // word 3: to
        data.extend_from_slice(&pad_u256(U256::from(9999999u64)));   // word 4: deadline
        data.extend_from_slice(&pad_u256(U256::from(2u64)));         // word 5: path length
        data.extend_from_slice(&pad_addr(token_in));                 // word 6: path[0]
        data.extend_from_slice(&pad_addr(token_out));                // word 7: path[1]

        let decoded = decoder.decode(Address::ZERO, U256::ZERO, &data).unwrap();
        assert_eq!(decoded.router, "UniV2_swapExactTokensForTokens");
        assert_eq!(decoded.token_in, Some(token_in));
        assert_eq!(decoded.token_out, Some(token_out));
        assert_eq!(decoded.amount_in, Some(amount_in));
    }

    #[test]
    fn test_decode_unknown_selector() {
        let decoder = TxDecoder::new();
        let input = [0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x00, 0x00, 0x00];
        assert!(decoder.decode(Address::ZERO, U256::ZERO, &input).is_none());
    }

    #[test]
    fn test_decode_too_short() {
        let decoder = TxDecoder::new();
        assert!(decoder.decode(Address::ZERO, U256::ZERO, &[0x38, 0xed]).is_none());
        assert!(decoder.decode(Address::ZERO, U256::ZERO, &[]).is_none());
    }

    #[test]
    fn test_decode_v3_selector() {
        let decoder = TxDecoder::new();
        let selector = [0x41, 0x4b, 0xf3, 0x89];
        let token_in = address!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let token_out = address!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        let amount_in = U256::from(5000u64);

        let mut data = Vec::new();
        data.extend_from_slice(&selector);
        data.extend_from_slice(&pad_u256(U256::from(32u64)));  // word 0: offset to struct = 32
        data.extend_from_slice(&pad_addr(token_in));           // word 1: tokenIn
        data.extend_from_slice(&pad_addr(token_out));          // word 2: tokenOut
        data.extend_from_slice(&pad_u256(U256::from(3000u64)));// word 3: fee
        data.extend_from_slice(&pad_addr(Address::ZERO));      // word 4: recipient
        data.extend_from_slice(&pad_u256(amount_in));          // word 5: amountIn
        data.extend_from_slice(&pad_u256(U256::from(1u64)));   // word 6: amountOutMin
        data.extend_from_slice(&pad_u256(U256::ZERO));         // word 7: sqrtPriceLimitX96

        let decoded = decoder.decode(Address::ZERO, U256::ZERO, &data).unwrap();
        assert_eq!(decoded.router, "UniV3_exactInputSingle");
        assert_eq!(decoded.token_in, Some(token_in));
        assert_eq!(decoded.token_out, Some(token_out));
        assert_eq!(decoded.amount_in, Some(amount_in));
    }

    #[test]
    fn test_decode_v3_exact_input_tuple_form() {
        let decoder = TxDecoder::new();
        let selector = [0xb8, 0x58, 0x18, 0x3f];
        let t_in = address!("1111111111111111111111111111111111111111");
        let t_out = address!("2222222222222222222222222222222222222222");
        let amount_in = U256::from(7000u64);

        // packed path: t_in(20) fee(3) t_out(20) = 43 bytes; 3000 = 0x0BB8
        let mut pb = Vec::new();
        pb.extend_from_slice(t_in.as_slice());
        pb.extend_from_slice(&[0x00, 0x0b, 0xb8]);
        pb.extend_from_slice(t_out.as_slice());
        assert_eq!(pb.len(), 43);

        // tuple params at offset 0x20: [path_off=0x20*4=0x80, recipient, amountIn, amountOutMin]
        // layout: word0=0x20 (tuple), tuple@word1: [0x80, recip, amtIn, amtOutMin], bytes@word5: len=43, data@word6..8
        let mut data = Vec::new();
        data.extend_from_slice(&selector);
        data.extend_from_slice(&pad_u256(U256::from(32u64)));   // word0: tuple offset
        data.extend_from_slice(&pad_u256(U256::from(128u64)));  // word1: path offset (from tuple base: 4*32)
        data.extend_from_slice(&pad_addr(Address::ZERO));        // word2: recipient
        data.extend_from_slice(&pad_u256(amount_in));            // word3: amountIn
        data.extend_from_slice(&pad_u256(U256::from(1u64)));     // word4: amountOutMin
        data.extend_from_slice(&pad_u256(U256::from(43u64)));    // word5: path len
        let mut w = [0u8; 64];
        w[..43].copy_from_slice(&pb);
        data.extend_from_slice(&w);                              // word6-7: path bytes

        let decoded = decoder.decode(Address::ZERO, U256::ZERO, &data).unwrap();
        assert_eq!(decoded.router, "UniV3_exactInput");
        assert_eq!(decoded.token_in, Some(t_in));
        assert_eq!(decoded.token_out, Some(t_out));
        assert_eq!(decoded.amount_in, Some(amount_in));
        assert_eq!(decoded.first_hop_fee, Some(3000));
        assert_eq!(decoded.path, vec![t_in, t_out]);
    }

    #[test]
    fn test_decode_v3_exact_input_flat_form() {
        let decoder = TxDecoder::new();
        let selector = [0xb8, 0x58, 0x18, 0x3f];
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
        let selector = [0x35, 0x93, 0x56, 0x4c];
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
        data.extend_from_slice(&pad_u256(U256::from(160u64)));   // word14: path offset (5*32)
        data.extend_from_slice(&pad_u256(U256::from(1u64)));     // word15: payerIsUser
        data.extend_from_slice(&pad_u256(U256::from(2u64)));     // word16: path len
        data.extend_from_slice(&pad_addr(t_in));                 // word17: path[0]
        data.extend_from_slice(&pad_addr(t_out));                // word18: path[1]

        let decoded = decoder.decode(Address::ZERO, U256::ZERO, &data).unwrap();
        assert_eq!(decoded.router, "UniversalRouter_execute");
        assert_eq!(decoded.amount_in, Some(amount_in));
        assert_eq!(decoded.path, vec![t_in, t_out]);
    }

    #[test]
    fn test_decode_fot_selector() {
        let decoder = TxDecoder::new();
        let selector = [0x5c, 0x11, 0xd7, 0x95];
        let t_in = address!("3333333333333333333333333333333333333333");
        let t_out = address!("4444444444444444444444444444444444444444");
        let amount_in = U256::from(2000u64);

        let mut data = Vec::new();
        data.extend_from_slice(&selector);
        data.extend_from_slice(&pad_u256(amount_in));
        data.extend_from_slice(&pad_u256(U256::from(1u64)));
        data.extend_from_slice(&pad_u256(U256::from(160u64)));
        data.extend_from_slice(&pad_addr(Address::ZERO));
        data.extend_from_slice(&pad_u256(U256::from(999u64)));
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
    fn test_decoder_default() {
        let d1 = TxDecoder::new();
        let d2 = TxDecoder::default();
        assert_eq!(d1.known_selectors.len(), d2.known_selectors.len());
        for (a, b) in d1.known_selectors.iter().zip(d2.known_selectors.iter()) {
            assert_eq!(a.0, b.0);
            assert_eq!(a.1, b.1);
        }
    }
}
