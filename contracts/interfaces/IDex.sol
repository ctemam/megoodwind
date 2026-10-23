// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Item #7 — Uniswap V3 execution engine interfaces.
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params)
        external payable returns (uint256 amountOut);
}

/// UniV3 quoter (off-chain / eth_call use).
interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams calldata params)
        external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

/// Uniswap V2-style pair (direct-pool swaps, no router skim).
interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// WO-9 — Uniswap V3-style pool, direct swap (no router ABI dependence).
/// SwapRouter02 vs V1 SwapRouter differ in calldata shape; pool.swap is
/// identical on every chain and cheaper per leg. The callback pays tokenIn.
interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 oi, uint16 oc, uint16 on, uint8 fp, bool unlocked);
    function liquidity() external view returns (uint128);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
}

/// WO-9 — Velodrome/Aerodrome-style pool that self-quotes via getAmountOut.
/// Curve + fee live inside the pool/factory (volatile CP, stable x³y+y³x,
/// per-pool fee bps) — asking the pool itself removes every fee/curve
/// assumption from the executor (WO-8: 30bps assumed vs 100bps real → K()).
interface ISelfQuotingPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint256 r0, uint256 r1, uint256 ts);
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}
