// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "@aave/core-v3/contracts/dependencies/openzeppelin/contracts/IERC20.sol";

// Uniswap V2 Router Interface
interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function getAmountsOut(uint amountIn, address[] calldata path)
        external
        view
        returns (uint[] memory amounts);
}

// Uniswap V3 Router Interface
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
        external
        payable
        returns (uint256 amountOut);
}

// Uniswap V3 Quoter Interface
interface IQuoter {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut);
}

// Uniswap V3 Pool Interface (for Flash Swaps)
interface IUniswapV3Pool {
    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;

    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

// Balancer Vault Interface (for Flash Loans)
interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

// Balancer Flash Loan Recipient Interface (callback)
interface IFlashLoanRecipient {
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

/**
 * @title FlashLoanArbitrage
 * @notice Flash loan arbitrage contract with DEX integration
 * @dev Executes arbitrage trades between Uniswap V2 and V3
 */
contract FlashLoanArbitrage is IFlashLoanRecipient {
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    IPool public immutable POOL;
    IBalancerVault public immutable BALANCER_VAULT;
    address public owner;

    // Flash loan provider options
    enum FlashProvider {
        AAVE_V3,      // Aave V3 flash loan (0.09% fee)
        UNISWAP_V3,   // Uniswap V3 flash swap (0.05% fee for 500 bps pools)
        BALANCER      // Balancer flash loan (0% fee)
    }

    struct ArbitrageParams {
        address tokenA;           // Token to borrow and return
        address tokenB;           // Intermediate token
        address dexBuy;           // DEX to buy tokenB (sell tokenA)
        address dexSell;          // DEX to sell tokenB (buy tokenA)
        uint24 feeBuy;            // Fee tier for buy (V3 only, 0 for V2)
        uint24 feeSell;           // Fee tier for sell (V3 only, 0 for V2)
        uint256 minProfit;        // Minimum profit required
        uint16 maxSlippageBps;    // Max slippage in basis points (e.g., 50 = 0.5%)
        bool isV3Buy;             // true if dexBuy is V3, false if V2
        bool isV3Sell;            // true if dexSell is V3, false if V2
        FlashProvider flashProvider; // Flash loan provider to use
    }

    event FlashLoanExecuted(
        address indexed asset,
        uint256 amount,
        uint256 premium
    );

    event ArbitrageExecuted(
        address indexed tokenA,
        address indexed tokenB,
        uint256 amountIn,
        uint256 amountOut,
        uint256 profit
    );

    event ArbitrageFailed(
        address indexed tokenA,
        uint256 amountIn,
        string reason
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _addressesProvider, address _balancerVault) {
        ADDRESSES_PROVIDER = IPoolAddressesProvider(_addressesProvider);
        POOL = IPool(ADDRESSES_PROVIDER.getPool());
        BALANCER_VAULT = IBalancerVault(_balancerVault);
        owner = msg.sender;
    }

    /**
     * @notice Request a Balancer flash loan and execute arbitrage
     * @param asset The address of the token to borrow
     * @param amount The amount to borrow
     * @param params Arbitrage parameters encoded as bytes
     */
    function requestBalancerFlashLoan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        address[] memory tokens = new address[](1);
        tokens[0] = asset;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        // Balancer flash loan - 0% fee
        BALANCER_VAULT.flashLoan(
            address(this),
            tokens,
            amounts,
            params
        );
    }

    /**
     * @notice Request an Aave V3 flash loan and execute arbitrage
     * @param asset The address of the token to borrow
     * @param amount The amount to borrow
     * @param params Arbitrage parameters encoded as bytes
     */
    function requestAaveFlashLoan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        address receiverAddress = address(this);
        address[] memory assets = new address[](1);
        assets[0] = asset;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        uint256[] memory modes = new uint256[](1);
        modes[0] = 0; // Flash loan mode

        address onBehalfOf = address(this);
        uint16 referralCode = 0;

        POOL.flashLoan(
            receiverAddress,
            assets,
            amounts,
            modes,
            onBehalfOf,
            params,
            referralCode
        );
    }

    /**
     * @notice Request a flash loan and execute arbitrage (backwards compatibility)
     * @dev Defaults to Aave V3 flash loan
     * @param asset The address of the token to borrow
     * @param amount The amount to borrow
     * @param params Arbitrage parameters encoded as bytes
     */
    function requestFlashLoan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        this.requestAaveFlashLoan(asset, amount, params);
    }

    /**
     * @notice Request Uniswap V3 flash swap
     * @param pool Uniswap V3 pool address
     * @param asset Token to borrow
     * @param amount Amount to borrow
     * @param params Encoded arbitrage parameters
     */
    function requestUniswapV3FlashSwap(
        address pool,
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        IUniswapV3Pool v3Pool = IUniswapV3Pool(pool);
        address token0 = v3Pool.token0();
        address token1 = v3Pool.token1();

        // Determine which token is being borrowed
        uint256 amount0 = asset == token0 ? amount : 0;
        uint256 amount1 = asset == token1 ? amount : 0;

        require(amount0 > 0 || amount1 > 0, "Invalid asset for this pool");

        // Call flash function
        v3Pool.flash(address(this), amount0, amount1, params);
    }

    /**
     * @notice Uniswap V3 flash swap callback
     * @dev Called by Uniswap V3 pool after transferring tokens
     * @param fee0 Fee for token0
     * @param fee1 Fee for token1
     * @param data Encoded arbitrage parameters
     */
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external {
        // Decode params
        ArbitrageParams memory params = abi.decode(data, (ArbitrageParams));

        // Verify caller is a valid Uniswap V3 pool
        // In production, you should maintain a whitelist of pools
        require(msg.sender != address(0), "Invalid pool");

        // Determine borrowed amount and fee
        uint256 borrowed = fee0 > 0 ? fee0 : fee1;
        uint256 fee = fee0 > 0 ? fee0 : fee1;

        // Calculate amount owed (borrowed amount is already in our balance)
        // We need to calculate actual borrowed amount from fee
        // For 0.05% fee tier: borrowed = fee / 0.0005
        uint256 feePercent = IUniswapV3Pool(msg.sender).fee();
        uint256 actualBorrowed = (fee * 1000000) / feePercent;
        uint256 amountOwed = actualBorrowed + fee;

        emit FlashLoanExecuted(params.tokenA, actualBorrowed, fee);

        // Execute arbitrage
        try this.executeArbitrageInternal(params, actualBorrowed) returns (uint256 finalAmount) {
            // Check profitability
            require(finalAmount >= amountOwed, "Unprofitable arbitrage");

            uint256 profit = finalAmount - amountOwed;
            emit ArbitrageExecuted(params.tokenA, params.tokenB, actualBorrowed, finalAmount, profit);

            // Repay flash swap
            IERC20(params.tokenA).transfer(msg.sender, amountOwed);
        } catch Error(string memory reason) {
            emit ArbitrageFailed(params.tokenA, actualBorrowed, reason);

            // Must repay even if arbitrage fails
            uint256 contractBalance = IERC20(params.tokenA).balanceOf(address(this));
            require(contractBalance >= amountOwed, "Insufficient funds to repay");

            IERC20(params.tokenA).transfer(msg.sender, amountOwed);
        }
    }

    /**
     * @notice Balancer flash loan callback - executes arbitrage
     * @dev This function is called by Balancer Vault after transferring the borrowed amount
     * @dev Balancer has 0% flash loan fee, so feeAmounts will be all zeros
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        require(msg.sender == address(BALANCER_VAULT), "Caller must be Balancer Vault");

        address asset = tokens[0];
        uint256 amount = amounts[0];
        uint256 feeAmount = feeAmounts[0]; // Should be 0 for Balancer

        emit FlashLoanExecuted(asset, amount, feeAmount);

        // Decode arbitrage parameters from userData
        if (userData.length > 0) {
            ArbitrageParams memory arbParams = abi.decode(userData, (ArbitrageParams));

            try this.executeArbitrageInternal(arbParams, amount) returns (uint256 finalAmount) {
                // Check if profitable after repaying flash loan
                uint256 amountOwed = amount + feeAmount; // feeAmount is 0 for Balancer
                require(finalAmount >= amountOwed, "Unprofitable arbitrage");

                uint256 profit = finalAmount - amountOwed;
                emit ArbitrageExecuted(arbParams.tokenA, arbParams.tokenB, amount, finalAmount, profit);

                // Repay flash loan by transferring tokens back to Vault
                IERC20(asset).transfer(address(BALANCER_VAULT), amountOwed);
            } catch Error(string memory reason) {
                emit ArbitrageFailed(asset, amount, reason);

                // Even if arbitrage fails, we must repay the flash loan
                uint256 contractBalance = IERC20(asset).balanceOf(address(this));
                uint256 amountOwed = amount + feeAmount;
                require(contractBalance >= amountOwed, "Insufficient funds to repay");

                IERC20(asset).transfer(address(BALANCER_VAULT), amountOwed);
            }
        } else {
            // No arbitrage, just test flash loan
            uint256 amountOwed = amount + feeAmount;
            IERC20(asset).transfer(address(BALANCER_VAULT), amountOwed);
        }
    }

    /**
     * @notice Aave V3 flash loan callback - executes arbitrage
     * @dev This function is called by Aave after transferring the borrowed amount
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(POOL), "Caller must be Pool");
        require(initiator == address(this), "Initiator must be this contract");

        address asset = assets[0];
        uint256 amount = amounts[0];
        uint256 premium = premiums[0];

        emit FlashLoanExecuted(asset, amount, premium);

        // If params are provided, execute arbitrage
        if (params.length > 0) {
            ArbitrageParams memory arbParams = abi.decode(params, (ArbitrageParams));

            try this.executeArbitrageInternal(arbParams, amount) returns (uint256 finalAmount) {
                // Check if profitable after repaying flash loan
                uint256 amountOwed = amount + premium;
                require(finalAmount >= amountOwed, "Unprofitable arbitrage");

                uint256 profit = finalAmount - amountOwed;
                emit ArbitrageExecuted(arbParams.tokenA, arbParams.tokenB, amount, finalAmount, profit);

                // Approve repayment (Gas Optimized)
                _ensureAllowance(asset, address(POOL), amountOwed);

                return true;
            } catch Error(string memory reason) {
                emit ArbitrageFailed(asset, amount, reason);

                // Even if arbitrage fails, we must repay the flash loan
                // Use contract's existing balance if available
                uint256 contractBalance = IERC20(asset).balanceOf(address(this));
                uint256 amountOwed = amount + premium;
                require(contractBalance >= amountOwed, "Insufficient funds to repay");

                _ensureAllowance(asset, address(POOL), amountOwed);
                return true;
            }
        } else {
            // No arbitrage, just test flash loan
            uint256 amountOwed = amount + premium;
            _ensureAllowance(asset, address(POOL), amountOwed);
            return true;
        }
    }

    /**
     * @notice Execute the actual arbitrage logic
     * @dev External function to allow try-catch in executeOperation
     */
    function executeArbitrageInternal(
        ArbitrageParams memory params,
        uint256 amountIn
    ) external returns (uint256) {
        require(msg.sender == address(this), "Only self");

        // Step 1: Buy tokenB with tokenA on dexBuy (cheaper DEX)
        uint256 amountB = _executeSwap(
            params.tokenA,
            params.tokenB,
            amountIn,
            params.dexBuy,
            params.feeBuy,
            params.isV3Buy,
            params.maxSlippageBps
        );

        require(amountB > 0, "Buy swap failed");

        // Step 2: Sell tokenB for tokenA on dexSell (expensive DEX)
        uint256 finalAmountA = _executeSwap(
            params.tokenB,
            params.tokenA,
            amountB,
            params.dexSell,
            params.feeSell,
            params.isV3Sell,
            params.maxSlippageBps
        );

        require(finalAmountA > 0, "Sell swap failed");

        return finalAmountA;
    }

    /**
     * @notice Ensure sufficient allowance for DEX (Gas Optimized)
     * @dev Only approves if current allowance is insufficient
     * @param token Token to approve
     * @param spender Spender address (DEX router)
     * @param amount Required amount
     */
    function _ensureAllowance(
        address token,
        address spender,
        uint256 amount
    ) internal {
        uint256 currentAllowance = IERC20(token).allowance(address(this), spender);

        if (currentAllowance < amount) {
            // If allowance is not 0, reset to 0 first (some tokens require this)
            if (currentAllowance > 0) {
                IERC20(token).approve(spender, 0);
            }

            // Approve infinite amount to save gas on future transactions
            // Using max uint256 instead of exact amount
            IERC20(token).approve(spender, type(uint256).max);
        }
    }

    /**
     * @notice Execute a swap on either Uniswap V2 or V3 with slippage protection
     * @param tokenIn Input token
     * @param tokenOut Output token
     * @param amountIn Amount to swap
     * @param dex DEX router address
     * @param fee Fee tier (for V3 only)
     * @param isV3 True if Uniswap V3, false if V2
     * @param maxSlippageBps Maximum slippage in basis points (e.g., 50 = 0.5%)
     */
    function _executeSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address dex,
        uint24 fee,
        bool isV3,
        uint16 maxSlippageBps
    ) internal returns (uint256) {
        // Gas Optimization: Only approve if allowance is insufficient
        _ensureAllowance(tokenIn, dex, amountIn);

        if (isV3) {
            // Uniswap V3 swap with slippage protection
            // Calculate minimum output: amountIn * (10000 - slippage - fee) / 10000
            // This is a simplified calculation; production should use Quoter
            uint256 amountOutMinimum = _calculateMinAmountOut(amountIn, maxSlippageBps, fee);

            ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter
                .ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: address(this),
                    deadline: block.timestamp + 300, // 5 minutes
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMinimum,
                    sqrtPriceLimitX96: 0
                });

            return ISwapRouter(dex).exactInputSingle(swapParams);
        } else {
            // Uniswap V2 swap with slippage protection
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;

            // Get expected output from V2
            uint[] memory expectedAmounts = IUniswapV2Router(dex).getAmountsOut(amountIn, path);
            uint256 expectedOut = expectedAmounts[expectedAmounts.length - 1];

            // Apply slippage: expectedOut * (10000 - slippage) / 10000
            uint256 minAmountOut = (expectedOut * (10000 - maxSlippageBps)) / 10000;

            uint[] memory amounts = IUniswapV2Router(dex).swapExactTokensForTokens(
                amountIn,
                minAmountOut,
                path,
                address(this),
                block.timestamp + 300 // 5 minutes
            );

            return amounts[amounts.length - 1];
        }
    }

    /**
     * @notice Calculate minimum amount out for V3 swaps (simplified)
     * @dev Production should use Uniswap V3 Quoter for accurate quotes
     * @param amountIn Input amount
     * @param slippageBps Slippage in basis points
     * @param feeTier Fee tier in hundredths of a bip (e.g., 3000 = 0.3%)
     */
    function _calculateMinAmountOut(
        uint256 amountIn,
        uint16 slippageBps,
        uint24 feeTier
    ) internal pure returns (uint256) {
        // Convert fee tier to basis points: 3000 -> 30 bps
        uint256 feeBps = uint256(feeTier) / 100;

        // Calculate: amountIn * (10000 - slippage - fee) / 10000
        uint256 totalDeductionBps = uint256(slippageBps) + feeBps;
        require(totalDeductionBps < 10000, "Slippage + fee too high");

        return (amountIn * (10000 - totalDeductionBps)) / 10000;
    }

    /**
     * @notice Simulate arbitrage profit without executing
     * @dev View function to check if arbitrage is profitable
     */
    function simulateArbitrage(
        address tokenA,
        address tokenB,
        uint256 amountIn,
        address dexBuy,
        address dexSell,
        uint256 flashLoanPremium
    ) external view returns (uint256 profit, bool isProfitable) {
        // This is a simplified simulation
        // In production, you'd query actual DEX prices

        // Simulate: assume we get same amount back (breakeven scenario)
        uint256 estimatedReturn = amountIn;
        uint256 totalCost = amountIn + flashLoanPremium;

        if (estimatedReturn > totalCost) {
            profit = estimatedReturn - totalCost;
            isProfitable = true;
        } else {
            profit = 0;
            isProfitable = false;
        }

        return (profit, isProfitable);
    }

    /**
     * @notice Withdraw tokens from the contract
     * @param token The token address to withdraw (use address(0) for ETH)
     * @param amount The amount to withdraw
     */
    function withdraw(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            payable(owner).transfer(amount);
        } else {
            IERC20(token).transfer(owner, amount);
        }
    }

    /**
     * @notice Withdraw all tokens
     * @param token The token address
     */
    function withdrawAll(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(owner, balance);
    }

    /**
     * @notice Emergency function to approve tokens
     * @dev Useful for manual recovery
     */
    function emergencyApprove(
        address token,
        address spender,
        uint256 amount
    ) external onlyOwner {
        IERC20(token).approve(spender, amount);
    }

    /**
     * @notice Batch approve multiple tokens (Gas optimization)
     * @dev Approve multiple tokens to multiple spenders in one transaction
     * @param tokens Array of token addresses
     * @param spenders Array of spender addresses
     * @param amounts Array of amounts to approve
     */
    function batchApprove(
        address[] calldata tokens,
        address[] calldata spenders,
        uint256[] calldata amounts
    ) external onlyOwner {
        require(
            tokens.length == spenders.length && tokens.length == amounts.length,
            "Array length mismatch"
        );

        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20(tokens[i]).approve(spenders[i], amounts[i]);
        }
    }

    /**
     * @notice Execute multiple calls in a single transaction (Multicall pattern)
     * @dev Allows batching multiple operations atomically
     * @param data Array of encoded function calls
     * @return results Array of return data from each call
     *
     * Example usage:
     * bytes[] memory calls = new bytes[](2);
     * calls[0] = abi.encodeWithSelector(this.withdraw.selector, token, amount);
     * calls[1] = abi.encodeWithSelector(this.emergencyApprove.selector, token, spender, amount);
     * multicall(calls);
     */
    function multicall(bytes[] calldata data)
        external
        onlyOwner
        returns (bytes[] memory results)
    {
        results = new bytes[](data.length);

        for (uint256 i = 0; i < data.length; i++) {
            (bool success, bytes memory result) = address(this).delegatecall(data[i]);

            if (!success) {
                // Bubble up the revert reason
                if (result.length > 0) {
                    assembly {
                        let resultSize := mload(result)
                        revert(add(32, result), resultSize)
                    }
                } else {
                    revert("Multicall: call failed");
                }
            }

            results[i] = result;
        }
    }

    /**
     * @notice Execute multiple approvals and swaps atomically
     * @dev Optimized function for arbitrage execution with batch approvals
     * @param tokens Tokens to approve
     * @param spenders Spenders to approve
     * @param amounts Amounts to approve
     * @param arbParams Arbitrage parameters
     * @param flashLoanAmount Flash loan amount
     */
    function executeArbitrageWithBatchApprove(
        address[] calldata tokens,
        address[] calldata spenders,
        uint256[] calldata amounts,
        ArbitrageParams calldata arbParams,
        uint256 flashLoanAmount
    ) external onlyOwner {
        // Step 1: Batch approve
        require(
            tokens.length == spenders.length && tokens.length == amounts.length,
            "Array length mismatch"
        );

        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20(tokens[i]).approve(spenders[i], amounts[i]);
        }

        // Step 2: Execute flash loan with arbitrage
        bytes memory params = abi.encode(arbParams);

        address receiverAddress = address(this);
        address[] memory assets = new address[](1);
        assets[0] = arbParams.tokenA;

        uint256[] memory flashAmounts = new uint256[](1);
        flashAmounts[0] = flashLoanAmount;

        uint256[] memory modes = new uint256[](1);
        modes[0] = 0; // Flash loan mode

        address onBehalfOf = address(this);
        uint16 referralCode = 0;

        POOL.flashLoan(
            receiverAddress,
            assets,
            flashAmounts,
            modes,
            onBehalfOf,
            params,
            referralCode
        );
    }

    /**
     * @notice Receive ETH
     */
    receive() external payable {}

    /**
     * @notice Fallback function
     */
    fallback() external payable {}
}
