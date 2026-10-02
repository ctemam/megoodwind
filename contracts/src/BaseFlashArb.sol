// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BaseFlashArb
 * @notice Cross-DEX arbitrage on Base targeting Aerodrome (volatile + stable + Slipstream),
 *         Uniswap V2/V3/V4, SushiSwap V3, BaseSwap V2, and Algebra-style CLMMs.
 *
 * Flash-loan source: Uniswap V4 PoolManager unlock/take pattern.
 * Aerodrome integration: Solidly-fork V2 (volatile & stable) via direct pool calls,
 *                        plus Slipstream (CL) via Algebra-compatible callback.
 */

import {IERC20} from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

// ============ V4 Interfaces ============

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

type BalanceDelta is int256;

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData) external returns (BalanceDelta delta);
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function sync(address currency) external;
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

interface IV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256, int256);
}

interface IV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;
}

interface IUniswapV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

// ============ Aerodrome Interfaces ============

interface IAerodromePool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IAerodromeSlipstream {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256 amount0, int256 amount1);
}

interface IAerodromeSlipstreamCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

interface IAlgebraPool {
    function swap(address recipient, bool zeroToOne, int256 amountSpecified,
                  uint160 limitSqrtPrice, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IAlgebraSwapCallback {
    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

// ============ Main Contract ============


// Balancer Vault flash loan — 0% borrow fee (allbrightA spec: Liquidity Sourcing).
interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

// Aave V3 Pool — identical flashLoanSimple/executeOperation interface on
// every chain Aave V3 deploys to (premium set per-pool via FLASHLOAN_PREMIUM_TOTAL).
interface IAaveV3Pool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

contract BaseFlashArb is
    IUnlockCallback,
    IUniswapV3SwapCallback,
    IAlgebraSwapCallback,
    IFlashLoanRecipient
{
    using SafeERC20 for IERC20;

    address public immutable OWNER;
    address public immutable POOL_MANAGER;
    uint256 public immutable CHAIN_ID;

    bool public paused;
    uint256 public maxGasPrice;
    uint256 public minProfitBasisPoints;
    mapping(address => bool) public supportedTokens;

    uint256 public totalExecutions;
    uint256 public totalProfit;

    address private _currentAsset;
    uint256 private _currentAmount;
    uint256 private _gasStart;
    address private _expectedV3SwapPool;
    /// Balancer Vault address while a Vault flash loan is in flight; 0 otherwise.
    address private _balancerVault;
    /// Aave V3 Pool address while an Aave flash loan is in flight; 0 otherwise.
    address private _aavePool;

    struct PoolMeta {
        bool registered;
        uint8 indexI;
        uint8 indexJ;
        address tokenIn;
        address tokenOut;
    }
    mapping(bytes32 => PoolMeta) public poolMeta;

    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    error Unauthorized();
    error ContractPaused();
    error GasPriceTooHigh(uint256 current, uint256 max);
    error InvalidAmount();
    error UnsupportedToken(address token);
    error SwapFailed(string reason);
    error InsufficientProfit(uint256 actual, uint256 required);
    error InvalidProtocol(uint8 protocol);

    event ArbitrageExecuted(address indexed asset, uint256 amount, uint256 profit, uint256 gasUsed, uint8 protocol);
    event TokenSupportUpdated(address indexed token, bool supported);
    event ConfigUpdated(string param, uint256 value);

    enum Protocol { V3, V4, V2, AERO_V2, AERO_SLIPSTREAM, ALGEBRA, BALANCER, AAVE_V3 }

    struct SwapInstruction {
        Protocol protocol;
        address pool;
        PoolKey poolKey;
        address tokenIn;
        address tokenOut;
        uint256 minOut;
    }

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier checkGasPrice() {
        if (tx.gasprice > maxGasPrice) revert GasPriceTooHigh(tx.gasprice, maxGasPrice);
        _;
    }

    constructor(
        address _poolManager,
        uint256 _maxGasPrice,
        uint256 _minProfitBps,
        address[] memory _supportedTokens
    ) {
        require(_maxGasPrice > 0, "Invalid max gas price");
        OWNER = msg.sender;
        POOL_MANAGER = _poolManager;
        CHAIN_ID = block.chainid;
        maxGasPrice = _maxGasPrice;
        minProfitBasisPoints = _minProfitBps;
        for (uint256 i = 0; i < _supportedTokens.length; i++) {
            supportedTokens[_supportedTokens[i]] = true;
            emit TokenSupportUpdated(_supportedTokens[i], true);
        }
    }

    // ============ V4 Execution (unlock pattern) ============

    function executeV4Arbitrage(
        address asset,
        uint256 amount,
        SwapInstruction[] calldata swapInstructions,
        uint256 deadline
    ) external onlyOwner whenNotPaused checkGasPrice {
        if (block.timestamp > deadline) revert SwapFailed("Transaction expired");
        if (!supportedTokens[asset]) revert UnsupportedToken(asset);
        if (amount == 0) revert InvalidAmount();
        if (swapInstructions.length == 0) revert SwapFailed("No swaps");

        _currentAsset = asset;
        _currentAmount = amount;
        _gasStart = gasleft();

        bytes memory callbackData = abi.encode(asset, amount, swapInstructions);
        IPoolManager(POOL_MANAGER).unlock(callbackData);

        _currentAsset = address(0);
        _currentAmount = 0;
        _gasStart = 0;
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != POOL_MANAGER) revert Unauthorized();

        (
            address asset,
            uint256 amount,
            SwapInstruction[] memory swapInstructions
        ) = abi.decode(data, (address, uint256, SwapInstruction[]));

        uint256 gasStart = _gasStart;
        bool isNativeETH = asset == address(0);

        uint256 balanceBefore;
        if (isNativeETH) {
            balanceBefore = address(this).balance;
        } else {
            balanceBefore = IERC20(asset).balanceOf(address(this));
        }

        IPoolManager(POOL_MANAGER).take(asset, address(this), amount);

        uint256 balanceAfterTake;
        if (isNativeETH) {
            balanceAfterTake = address(this).balance;
        } else {
            balanceAfterTake = IERC20(asset).balanceOf(address(this));
        }
        if (balanceAfterTake < balanceBefore + amount) {
            revert SwapFailed("Take failed");
        }

        for (uint256 i = 0; i < swapInstructions.length; i++) {
            _dispatchSwap(swapInstructions[i]);
        }

        uint256 balanceAfter;
        if (isNativeETH) {
            balanceAfter = address(this).balance;
        } else {
            balanceAfter = IERC20(asset).balanceOf(address(this));
        }

        if (balanceAfter <= amount) {
            revert InsufficientProfit(0, minProfitBasisPoints);
        }

        uint256 grossProfit = balanceAfter - amount;
        uint256 requiredProfit = (amount * minProfitBasisPoints) / 10000;

        if (grossProfit < requiredProfit) {
            revert InsufficientProfit(grossProfit, requiredProfit);
        }

        if (isNativeETH) {
            IPoolManager(POOL_MANAGER).settle{value: amount}();
        } else {
            IPoolManager(POOL_MANAGER).sync(asset);
            IERC20(asset).safeTransfer(POOL_MANAGER, amount);
            IPoolManager(POOL_MANAGER).settle();
        }

        totalExecutions++;
        totalProfit += grossProfit;

        uint256 gasUsed = gasStart - gasleft();
        emit ArbitrageExecuted(asset, amount, grossProfit, gasUsed, uint8(Protocol.V4));

        return "";
    }

    // ============ Swap Dispatcher ============


    // ============ Balancer Vault Flash Loan (0% borrow) ============

    /// Entry: borrow `amount` of `asset` from the Balancer Vault and replay the
    /// swap plan inside the callback. Vault is canonical on BSC and Base
    /// (0xBA12222222228d8Ba445958a75a0704d566BF2C8).
    function executeBalancerArbitrage(
        address balancerVault,
        address asset,
        uint256 amount,
        SwapInstruction[] calldata swapInstructions,
        uint256 deadline
    ) external onlyOwner whenNotPaused checkGasPrice {
        if (block.timestamp > deadline) revert SwapFailed("Transaction expired");
        if (!supportedTokens[asset]) revert UnsupportedToken(asset);
        if (amount == 0) revert InvalidAmount();
        if (swapInstructions.length == 0) revert SwapFailed("No swaps");

        _balancerVault = balancerVault;
        _gasStart = gasleft();

        address[] memory tokens = new address[](1);
        tokens[0] = asset;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        IBalancerVault(balancerVault).flashLoan(
            address(this), tokens, amounts,
            abi.encode(asset, amount, swapInstructions)
        );

        _balancerVault = address(0);
        _gasStart = 0;
    }

    /// Balancer Vault callback: runs the swap plan, then repays amount+fee
    /// (fee is 0 on the Vault) back to the Vault.
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        if (_balancerVault == address(0) || msg.sender != _balancerVault) revert Unauthorized();
        uint256 gasStart = _gasStart;

        (
            address asset,
            uint256 amount,
            SwapInstruction[] memory swapInstructions
        ) = abi.decode(userData, (address, uint256, SwapInstruction[]));

        if (tokens.length != 1 || amounts.length != 1 || feeAmounts.length != 1) {
            revert SwapFailed("Bad flash params");
        }
        if (address(tokens[0]) != asset || amounts[0] != amount) {
            revert SwapFailed("Flash params mismatch");
        }

        // Vault has already transferred the borrowed tokens; balanceBefore
        // includes them, so profit = gain over the repay obligation.
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));

        for (uint256 i = 0; i < swapInstructions.length; i++) {
            _dispatchSwap(swapInstructions[i]);
        }

        uint256 fee = feeAmounts[0];
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        if (balanceAfter <= balanceBefore + fee) {
            revert InsufficientProfit(0, minProfitBasisPoints);
        }
        uint256 grossProfit = balanceAfter - balanceBefore - fee;
        uint256 requiredProfit = (amount * minProfitBasisPoints) / 10000;
        if (grossProfit < requiredProfit) {
            revert InsufficientProfit(grossProfit, requiredProfit);
        }

        IERC20(asset).safeTransfer(msg.sender, amount + fee);

        totalExecutions++;
        totalProfit += grossProfit;

        uint256 gasUsed = gasStart - gasleft();
        emit ArbitrageExecuted(asset, amount, grossProfit, gasUsed, uint8(Protocol.BALANCER));
    }

    // ============ Aave V3 Flash Loan ============

    /// Entry: borrow `amount` of `asset` via Aave V3 flashLoanSimple and
    /// replay the swap plan inside executeOperation. Premium is charged by
    /// the pool (typically 5-9 bps vs Balancer's 0%) — the identical
    /// interface makes it the portable fallback on chains without Balancer
    /// liquidity for the asset.
    function executeAaveArbitrage(
        address aavePool,
        address asset,
        uint256 amount,
        SwapInstruction[] calldata swapInstructions,
        uint256 deadline
    ) external onlyOwner whenNotPaused checkGasPrice {
        if (block.timestamp > deadline) revert SwapFailed("Transaction expired");
        if (!supportedTokens[asset]) revert UnsupportedToken(asset);
        if (amount == 0) revert InvalidAmount();
        if (swapInstructions.length == 0) revert SwapFailed("No swaps");

        _aavePool = aavePool;
        _gasStart = gasleft();

        IAaveV3Pool(aavePool).flashLoanSimple(
            address(this), asset, amount,
            abi.encode(swapInstructions), 0
        );

        _aavePool = address(0);
        _gasStart = 0;
    }

    /// Aave V3 callback: run the swap plan, then approve the pool to pull
    /// back amount+premium (Aave pulls via transferFrom, unlike Balancer
    /// where we transfer to the Vault).
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (_aavePool == address(0) || msg.sender != _aavePool) revert Unauthorized();
        if (initiator != address(this)) revert Unauthorized();
        uint256 gasStart = _gasStart;

        SwapInstruction[] memory swapInstructions =
            abi.decode(params, (SwapInstruction[]));

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));

        for (uint256 i = 0; i < swapInstructions.length; i++) {
            _dispatchSwap(swapInstructions[i]);
        }

        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        if (balanceAfter <= balanceBefore + premium) {
            revert InsufficientProfit(0, minProfitBasisPoints);
        }
        uint256 grossProfit = balanceAfter - balanceBefore - premium;
        uint256 requiredProfit = (amount * minProfitBasisPoints) / 10000;
        if (grossProfit < requiredProfit) {
            revert InsufficientProfit(grossProfit, requiredProfit);
        }

        // Aave pulls amount+premium via transferFrom after callback returns.
        IERC20(asset).approve(_aavePool, amount + premium);

        totalExecutions++;
        totalProfit += grossProfit;

        uint256 gasUsed = gasStart - gasleft();
        emit ArbitrageExecuted(asset, amount, grossProfit, gasUsed, uint8(Protocol.AAVE_V3));
        return true;
    }

    function _dispatchSwap(SwapInstruction memory instr) internal {
        if (instr.protocol == Protocol.V3) {
            _executeV3Swap(instr);
        } else if (instr.protocol == Protocol.V4) {
            _executeV4Swap(instr);
        } else if (instr.protocol == Protocol.V2) {
            _executeV2Swap(instr);
        } else if (instr.protocol == Protocol.AERO_V2) {
            _executeAeroV2Swap(instr);
        } else if (instr.protocol == Protocol.AERO_SLIPSTREAM) {
            _executeAeroSlipstreamSwap(instr);
        } else if (instr.protocol == Protocol.ALGEBRA) {
            _executeAlgebraSwap(instr);
        } else {
            revert InvalidProtocol(uint8(instr.protocol));
        }
    }

    // ============ V4 Swap ============

    function _executeV4Swap(SwapInstruction memory instr) internal {
        bool isNativeETH = instr.tokenIn == address(0);

        uint256 amountIn;
        if (isNativeETH) {
            amountIn = address(this).balance;
        } else {
            amountIn = IERC20(instr.tokenIn).balanceOf(address(this));
        }
        if (amountIn == 0) revert InvalidAmount();

        bool zeroForOne = instr.tokenIn == instr.poolKey.currency0;
        uint160 sqrtPriceLimit = zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;

        SwapParams memory params = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: sqrtPriceLimit
        });

        BalanceDelta delta = IPoolManager(POOL_MANAGER).swap(instr.poolKey, params, "");

        int256 amount0Delta = int128(int256(BalanceDelta.unwrap(delta) >> 128));
        int256 amount1Delta = int128(int256(BalanceDelta.unwrap(delta)));

        if (amount0Delta < 0) {
            uint256 amountOwed = uint256(-amount0Delta);
            address currency = instr.poolKey.currency0;
            if (currency == address(0)) {
                IPoolManager(POOL_MANAGER).settle{value: amountOwed}();
            } else {
                IPoolManager(POOL_MANAGER).sync(currency);
                IERC20(currency).safeTransfer(POOL_MANAGER, amountOwed);
                IPoolManager(POOL_MANAGER).settle();
            }
        }
        if (amount1Delta < 0) {
            uint256 amountOwed = uint256(-amount1Delta);
            address currency = instr.poolKey.currency1;
            if (currency == address(0)) {
                IPoolManager(POOL_MANAGER).settle{value: amountOwed}();
            } else {
                IPoolManager(POOL_MANAGER).sync(currency);
                IERC20(currency).safeTransfer(POOL_MANAGER, amountOwed);
                IPoolManager(POOL_MANAGER).settle();
            }
        }

        uint256 outputAmount = 0;
        if (amount0Delta > 0) {
            outputAmount = uint256(amount0Delta);
            IPoolManager(POOL_MANAGER).take(instr.poolKey.currency0, address(this), outputAmount);
        }
        if (amount1Delta > 0) {
            outputAmount = uint256(amount1Delta);
            IPoolManager(POOL_MANAGER).take(instr.poolKey.currency1, address(this), outputAmount);
        }

        if (outputAmount == 0) revert SwapFailed("V4 zero output");
        if (outputAmount < instr.minOut) revert SwapFailed("V4 slippage");
    }

    // ============ V3 Swap ============

    function _executeV3Swap(SwapInstruction memory instr) internal {
        uint256 amountIn = IERC20(instr.tokenIn).balanceOf(address(this));
        if (amountIn == 0) revert InvalidAmount();

        address poolToken0 = IV3Pool(instr.pool).token0();
        bool zeroForOne = instr.tokenIn == poolToken0;

        uint160 sqrtPriceLimit = zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;
        bytes memory callbackData = abi.encode(instr.pool, instr.tokenIn);

        _expectedV3SwapPool = instr.pool;

        IV3Pool(instr.pool).swap(
            address(this), zeroForOne, int256(amountIn), sqrtPriceLimit, callbackData
        );

        _expectedV3SwapPool = address(0);

        uint256 outputBalance = IERC20(instr.tokenOut).balanceOf(address(this));
        if (outputBalance < instr.minOut) revert SwapFailed("V3 slippage");
    }

    // ============ V2 Swap (Uniswap V2, BaseSwap, SushiSwap V2, etc.) ============

    function _executeV2Swap(SwapInstruction memory instr) internal {
        uint256 amountIn = IERC20(instr.tokenIn).balanceOf(address(this));
        if (amountIn == 0) revert InvalidAmount();

        address token0 = IV2Pair(instr.pool).token0();
        (uint112 reserve0, uint112 reserve1, ) = IV2Pair(instr.pool).getReserves();

        bool isToken0In = (instr.tokenIn == token0);
        uint256 reserveIn = isToken0In ? uint256(reserve0) : uint256(reserve1);
        uint256 reserveOut = isToken0In ? uint256(reserve1) : uint256(reserve0);

        uint256 amountInWithFee = amountIn * 997;
        uint256 amountOut = (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);

        if (amountOut == 0) revert SwapFailed("V2 zero output");

        IERC20(instr.tokenIn).safeTransfer(instr.pool, amountIn);

        uint256 amount0Out = isToken0In ? uint256(0) : amountOut;
        uint256 amount1Out = isToken0In ? amountOut : uint256(0);
        IV2Pair(instr.pool).swap(amount0Out, amount1Out, address(this), "");

        if (amountOut < instr.minOut) revert SwapFailed("V2 slippage");
    }

    // ============ Aerodrome V2 (Solidly-fork volatile + stable) ============

    function _executeAeroV2Swap(SwapInstruction memory instr) internal {
        uint256 amountIn = IERC20(instr.tokenIn).balanceOf(address(this));
        if (amountIn == 0) revert InvalidAmount();

        uint256 amountOut = IAerodromePool(instr.pool).getAmountOut(amountIn, instr.tokenIn);
        if (amountOut == 0) revert SwapFailed("AERO_V2 zero output");

        IERC20(instr.tokenIn).safeTransfer(instr.pool, amountIn);

        address token0 = IAerodromePool(instr.pool).token0();
        bool isToken0In = (instr.tokenIn == token0);
        uint256 amount0Out = isToken0In ? uint256(0) : amountOut;
        uint256 amount1Out = isToken0In ? amountOut : uint256(0);
        IAerodromePool(instr.pool).swap(amount0Out, amount1Out, address(this), "");

        if (amountOut < instr.minOut) revert SwapFailed("AERO_V2 slippage");
    }

    // ============ Aerodrome Slipstream (concentrated liquidity) ============

    function _executeAeroSlipstreamSwap(SwapInstruction memory instr) internal {
        uint256 amountIn = IERC20(instr.tokenIn).balanceOf(address(this));
        if (amountIn == 0) revert InvalidAmount();

        address t0 = IAerodromeSlipstream(instr.pool).token0();
        bool zeroForOne = (instr.tokenIn == t0);

        uint160 sqrtLimit = zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;
        bytes memory cbData = abi.encode(instr.pool, instr.tokenIn);

        _expectedV3SwapPool = instr.pool;
        IAerodromeSlipstream(instr.pool).swap(
            address(this), zeroForOne, int256(amountIn), sqrtLimit, cbData
        );
        _expectedV3SwapPool = address(0);

        uint256 outBal = IERC20(instr.tokenOut).balanceOf(address(this));
        if (outBal < instr.minOut) revert SwapFailed("SLIPSTREAM slippage");
    }

    // ============ Algebra Swap ============

    function _executeAlgebraSwap(SwapInstruction memory instr) internal {
        uint256 amountIn = IERC20(instr.tokenIn).balanceOf(address(this));
        if (amountIn == 0) revert InvalidAmount();

        address t0 = IAlgebraPool(instr.pool).token0();
        bool zeroForOne = (instr.tokenIn == t0);

        uint160 sqrtLimit = zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;
        bytes memory cbData = abi.encode(instr.pool, instr.tokenIn);

        _expectedV3SwapPool = instr.pool;
        IAlgebraPool(instr.pool).swap(address(this), zeroForOne, int256(amountIn), sqrtLimit, cbData);
        _expectedV3SwapPool = address(0);

        uint256 outBal = IERC20(instr.tokenOut).balanceOf(address(this));
        if (outBal < instr.minOut) revert SwapFailed("ALGEBRA slippage");
    }

    // ============ Swap Callbacks ============

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external override {
        _handleSwapCallback(amount0Delta, amount1Delta, data);
    }

    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external override {
        _handleSwapCallback(amount0Delta, amount1Delta, data);
    }

    function _handleSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        if (msg.sender != _expectedV3SwapPool || _expectedV3SwapPool == address(0)) {
            revert Unauthorized();
        }

        (, address tokenIn) = abi.decode(data, (address, address));

        uint256 amountToPay;
        if (amount0Delta > 0) {
            amountToPay = uint256(amount0Delta);
        } else if (amount1Delta > 0) {
            amountToPay = uint256(amount1Delta);
        } else {
            revert SwapFailed("Invalid callback deltas");
        }

        IERC20(tokenIn).safeTransfer(msg.sender, amountToPay);
    }

    // ============ Admin ============

    function setPoolMeta(
        address pool, address tokenIn, address tokenOut,
        uint8 i, uint8 j
    ) external onlyOwner {
        bytes32 key = keccak256(abi.encodePacked(pool, tokenIn));
        poolMeta[key] = PoolMeta({
            registered: true,
            indexI: i,
            indexJ: j,
            tokenIn: tokenIn,
            tokenOut: tokenOut
        });
    }

    function approveToken(address token, address spender, uint256 amount) external onlyOwner {
        IERC20(token).forceApprove(spender, amount);
    }

    function pause() external onlyOwner { paused = true; emit ConfigUpdated("paused", 1); }
    function unpause() external onlyOwner { paused = false; emit ConfigUpdated("paused", 0); }

    function setMaxGasPrice(uint256 _maxGasPrice) external onlyOwner {
        require(_maxGasPrice > 0, "Invalid value");
        maxGasPrice = _maxGasPrice;
        emit ConfigUpdated("maxGasPrice", _maxGasPrice);
    }

    function setMinProfitBasisPoints(uint256 _minProfitBps) external onlyOwner {
        require(_minProfitBps <= 1000, "Max 10%");
        minProfitBasisPoints = _minProfitBps;
        emit ConfigUpdated("minProfitBasisPoints", _minProfitBps);
    }

    function setTokenSupport(address token, bool supported) external onlyOwner {
        supportedTokens[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    function addTokens(address[] calldata tokens) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; i++) {
            supportedTokens[tokens[i]] = true;
            emit TokenSupportUpdated(tokens[i], true);
        }
    }

    function emergencyWithdraw(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    function emergencyWithdrawETH(address payable to) external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = to.call{value: balance}("");
            require(success, "ETH transfer failed");
        }
    }

    function getStats() external view returns (
        uint256 executions, uint256 profit, bool isPaused,
        uint256 gasLimit, uint256 minProfit
    ) {
        return (totalExecutions, totalProfit, paused, maxGasPrice, minProfitBasisPoints);
    }

    receive() external payable {}
}
