// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {
    IBalancerVault,
    IFlashLoanRecipient,
    IAavePool,
    IFlashLoanSimpleReceiver,
    IMorphoFlash,
    IMorphoFlashCallback,
    IERC3156FlashBorrower,
    IERC3156FlashLender
} from "./interfaces/IFlash.sol";
import {ISwapRouter, IUniswapV2Pair, IUniswapV3Pool, ISelfQuotingPair} from "./interfaces/IDex.sol";

/// @title AllBrightExecutor — flash-loan arbitrage executor.
/// @notice Item #5 (Balancer V2 primary, 0% fee) + Item #6 (Aave V3 fallback,
///         0.09% fee) + Item #7 (UniV3/V2 leg execution) + Item #9 (OZ guards).
///         Atomicity law (Item #1): every leg lives inside one flash callback —
///         the whole loop succeeds or the whole tx reverts. Last-hop minOut is
///         the repay amount so a decayed spread reverts instead of losing money.
///         Owner = ERC-4337 smart account (Kernel); entries arrive via UserOp.
contract AllBrightExecutor is IFlashLoanRecipient, IFlashLoanSimpleReceiver, IMorphoFlashCallback, IERC3156FlashBorrower, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    /// Fee ladder: BALANCER 0% | MORPHO 0% | ERC3156 0% (Maker DssFlash) | AAVE 0.09%
    enum FlashSource { BALANCER, AAVE, MORPHO, ERC3156 }
    /// WO-9: V3_POOL = direct pool.swap (router-free, works on SwapRouter02
    /// chains); V2_SELFQUOTE = pool's own getAmountOut (velodrome/aerodrome
    /// real fee+curve — fixes WO-8 30-vs-100bps K() reverts).
    enum DexKind { V2_PAIR, V3_ROUTER, V3_POOL, V2_SELFQUOTE }

    struct Hop {
        DexKind kind;
        address venue;      // V2: pair address. V3: ISwapRouter address.
        address tokenIn;
        address tokenOut;
        uint24 fee;         // V3 fee tier (100/500/3000/10000)
        uint16 feeBps;      // V2 swap fee in bps (30 = 0.3%)
    }

    struct ArbPlan {
        FlashSource source;
        address borrowToken;
        uint256 borrowAmount;
        Hop[] hops;
        uint256 minOut;     // last-hop floor — set = repay amount by caller
        uint256 minProfit;  // post-repay profit floor in borrowToken units
    }

    address public balancerVault;   // 0 on chains without Balancer V2 (e.g. BSC)
    address public aavePool;        // Aave V3 Pool
    address public morpho;          // Morpho Blue — 0% fee, pull-repay
    address public erc3156Lender;   // Maker DssFlash — 0% fee, DAI only (eth)
    bool private _inFlash;
    address private _expectedV3Pool; // V3_POOL callback auth — cleared after each leg

    event ArbSettled(address indexed borrowToken, uint256 borrowed, uint256 profit);
    event LiquidationSettled(address indexed protocol, address indexed user, uint256 profit);
    event VenuesUpdated(address balancerVault, address aavePool);
    event ZeroFeeVenuesUpdated(address morpho, address erc3156Lender);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error NotFlashProvider();
    error VenueUnset(FlashSource source);
    error BadPlan();
    error ProfitFloor(uint256 got, uint256 want);

    constructor(address _balancerVault, address _aavePool) Ownable(msg.sender) {
        balancerVault = _balancerVault;
        aavePool = _aavePool;
    }

    function setVenues(address _balancerVault, address _aavePool) external onlyOwner {
        balancerVault = _balancerVault;
        aavePool = _aavePool;
        emit VenuesUpdated(_balancerVault, _aavePool);
    }

    /// Zero-fee venue wiring — post-construction so existing deployments
    /// upgrade without redeploying the whole contract.
    function setZeroFeeVenues(address _morpho, address _erc3156Lender) external onlyOwner {
        morpho = _morpho;
        erc3156Lender = _erc3156Lender;
        emit ZeroFeeVenuesUpdated(_morpho, _erc3156Lender);
    }

    /// @notice Owner entry — decode plan and pull capital from the chosen engine.
    function exec(bytes calldata planBytes) external onlyOwner nonReentrant {
        ArbPlan memory plan = abi.decode(planBytes, (ArbPlan));
        if (plan.borrowToken == address(0) || plan.borrowAmount == 0 || plan.hops.length == 0) {
            revert BadPlan();
        }
        _inFlash = true;
        if (plan.source == FlashSource.BALANCER) {
            if (balancerVault == address(0)) revert VenueUnset(plan.source);
            address[] memory t = new address[](1);
            uint256[] memory a = new uint256[](1);
            t[0] = plan.borrowToken;
            a[0] = plan.borrowAmount;
            IBalancerVault(balancerVault).flashLoan(address(this), t, a, planBytes);
        } else if (plan.source == FlashSource.MORPHO) {
            if (morpho == address(0)) revert VenueUnset(plan.source);
            IMorphoFlash(morpho).flashLoan(plan.borrowToken, plan.borrowAmount, planBytes);
        } else if (plan.source == FlashSource.ERC3156) {
            if (erc3156Lender == address(0)) revert VenueUnset(plan.source);
            IERC3156FlashLender(erc3156Lender).flashLoan(
                IERC3156FlashBorrower(address(this)),
                plan.borrowToken,
                plan.borrowAmount,
                planBytes
            );
        } else {
            if (aavePool == address(0)) revert VenueUnset(plan.source);
            IAavePool(aavePool).flashLoanSimple(address(this), plan.borrowToken, plan.borrowAmount, planBytes, 0);
        }
        _inFlash = false;
    }

    /// Item #5 — Balancer V2 callback (0% fee: feeAmounts[0] == 0 on most pools).
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        if (msg.sender != balancerVault || !_inFlash) revert NotFlashProvider();
        if (_inLiq) {
            LiqPlan memory lp = abi.decode(userData, (LiqPlan));
            uint256 pre = IERC20(lp.debtAsset).balanceOf(address(this)) - amounts[0];
            _runLiq(lp);
            IERC20(tokens[0]).safeTransfer(balancerVault, amounts[0] + feeAmounts[0]);
            _checkLiqProfit(lp, pre);
            return;
        }
        ArbPlan memory plan = abi.decode(userData, (ArbPlan));
        uint256 pre = IERC20(plan.borrowToken).balanceOf(address(this)) - amounts[0];
        _runHops(plan);
        uint256 repay = amounts[0] + feeAmounts[0];
        IERC20(tokens[0]).safeTransfer(balancerVault, repay);
        _checkProfit(plan, pre);
    }

    /// Item #6 — Aave V3 callback. Pool pulls repay via allowance.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != aavePool || initiator != address(this) || !_inFlash) revert NotFlashProvider();
        if (_inLiq) {
            LiqPlan memory lp = abi.decode(params, (LiqPlan));
            uint256 pre = IERC20(asset).balanceOf(address(this)) - amount;
            _runLiq(lp);
            IERC20(asset).forceApprove(aavePool, amount + premium);
            _checkLiqProfitPull(lp, pre, amount + premium);
            return true;
        }
        ArbPlan memory plan = abi.decode(params, (ArbPlan));
        uint256 pre = IERC20(asset).balanceOf(address(this)) - amount;
        _runHops(plan);
        IERC20(asset).forceApprove(aavePool, amount + premium);
        _checkProfitAfterPull(plan, pre, amount + premium);
        return true;
    }

    /// Morpho Blue callback — 0% fee. Morpho pulls repay via allowance
    /// after this returns; identical accounting shape to the Aave path.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external override {
        if (msg.sender != morpho || !_inFlash) revert NotFlashProvider();
        if (_inLiq) {
            LiqPlan memory lp = abi.decode(data, (LiqPlan));
            uint256 pre = IERC20(lp.debtAsset).balanceOf(address(this)) - assets;
            _runLiq(lp);
            IERC20(lp.debtAsset).forceApprove(morpho, assets);
            _checkLiqProfitPull(lp, pre, assets);
            return;
        }
        ArbPlan memory plan = abi.decode(data, (ArbPlan));
        uint256 pre = IERC20(plan.borrowToken).balanceOf(address(this)) - assets;
        _runHops(plan);
        IERC20(plan.borrowToken).forceApprove(morpho, assets);
        _checkProfitAfterPull(plan, pre, assets);
    }

    /// ERC-3156 callback — Maker DssFlash (0% fee, DAI). Lender pulls
    /// amount+fee via allowance; return magic confirms the callback.
    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        if (msg.sender != erc3156Lender || initiator != address(this) || !_inFlash) revert NotFlashProvider();
        if (_inLiq) {
            LiqPlan memory lp = abi.decode(data, (LiqPlan));
            uint256 pre = IERC20(token).balanceOf(address(this)) - amount;
            _runLiq(lp);
            IERC20(token).forceApprove(erc3156Lender, amount + fee);
            _checkLiqProfitPull(lp, pre, amount + fee);
            return keccak256("ERC3156FlashBorrower.onFlashLoan");
        }
        ArbPlan memory plan = abi.decode(data, (ArbPlan));
        uint256 pre = IERC20(token).balanceOf(address(this)) - amount;
        _runHops(plan);
        IERC20(token).forceApprove(erc3156Lender, amount + fee);
        _checkProfitAfterPull(plan, pre, amount + fee);
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }

    function _runHops(ArbPlan memory plan) internal {
        uint256 n = plan.hops.length;
        for (uint256 i; i < n; i++) {
            Hop memory h = plan.hops[i];
            uint256 amountIn = IERC20(h.tokenIn).balanceOf(address(this));
            bool last = i == n - 1;
            if (h.kind == DexKind.V2_PAIR) {
                _swapV2(h, amountIn, last ? plan.minOut : 0);
            } else if (h.kind == DexKind.V3_POOL) {
                _swapV3Pool(h, amountIn, last ? plan.minOut : 0);
            } else if (h.kind == DexKind.V2_SELFQUOTE) {
                _swapV2SelfQuote(h, amountIn, last ? plan.minOut : 0);
            } else {
                _swapV3(h, amountIn, last ? plan.minOut : 0);
            }
        }
    }

    function _swapV2(Hop memory h, uint256 amountIn, uint256 minOut) internal {
        IUniswapV2Pair pair = IUniswapV2Pair(h.venue);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool zeroForOne = pair.token0() == h.tokenIn;
        (uint256 rIn, uint256 rOut) = zeroForOne ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 inAfterFee = amountIn * (10_000 - h.feeBps);
        uint256 out = (inAfterFee * rOut) / (rIn * 10_000 + inAfterFee);
        require(out >= minOut, "V2_MINOUT");
        IERC20(h.tokenIn).safeTransfer(h.venue, amountIn);
        pair.swap(zeroForOne ? 0 : out, zeroForOne ? out : 0, address(this), "");
    }

    function _swapV3(Hop memory h, uint256 amountIn, uint256 minOut) internal {
        IERC20(h.tokenIn).forceApprove(h.venue, amountIn);
        ISwapRouter(h.venue).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: h.tokenIn,
                tokenOut: h.tokenOut,
                fee: h.fee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// WO-9 — direct pool.swap: pool calls back `uniswapV3SwapCallback`,
    /// we pay tokenIn there; out measured as balance delta (curve-agnostic).
    function _swapV3Pool(Hop memory h, uint256 amountIn, uint256 minOut) internal {
        IUniswapV3Pool pool = IUniswapV3Pool(h.venue);
        bool zeroForOne = pool.token0() == h.tokenIn;
        uint160 limit = zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341; // MIN_SQRT+1 / MAX_SQRT-1
        uint256 before = IERC20(h.tokenOut).balanceOf(address(this));
        _expectedV3Pool = h.venue;
        pool.swap(address(this), zeroForOne, int256(amountIn), limit, abi.encode(h.tokenIn));
        _expectedV3Pool = address(0);
        uint256 out = IERC20(h.tokenOut).balanceOf(address(this)) - before;
        require(out >= minOut, "V3_MINOUT");
    }

    /// WO-9 — the pool's own getAmountOut decides (real per-pool fee +
    /// curve incl. stable pools) — the executor never models the fee.
    /// Measured on aerodrome V1 (base, fork): the pool's quote exceeds its
    /// own K-passing max by ~1e-9 relative — getAmountOut rounding is NOT
    /// K-safe. SELFQUOTE_SHAVE (1bps, ~10^4x headroom, negligible to net)
    /// keeps the requested out inside the invariant.
    function _swapV2SelfQuote(Hop memory h, uint256 amountIn, uint256 minOut) internal {
        ISelfQuotingPair pair = ISelfQuotingPair(h.venue);
        uint256 out = (pair.getAmountOut(amountIn, h.tokenIn) * 9_999) / 10_000;
        require(out >= minOut, "V2_MINOUT");
        IERC20(h.tokenIn).safeTransfer(h.venue, amountIn);
        bool zeroForOne = pair.token0() == h.tokenIn;
        pair.swap(zeroForOne ? 0 : out, zeroForOne ? out : 0, address(this), "");
    }

    /// UniV3-class swap callback — only the pool we just called may pull.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != _expectedV3Pool || _expectedV3Pool == address(0)) revert NotFlashProvider();
        int256 owed = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (owed <= 0) revert BadPlan();
        IERC20(abi.decode(data, (address))).safeTransfer(msg.sender, uint256(owed));
    }

    function _checkProfit(ArbPlan memory plan, uint256 pre) internal {
        uint256 post = IERC20(plan.borrowToken).balanceOf(address(this));
        if (post < pre + plan.minProfit) revert ProfitFloor(post - pre, plan.minProfit);
        emit ArbSettled(plan.borrowToken, plan.borrowAmount, post - pre);
    }

    /// Aave pulls repay after callback returns — measure against expected post-pull balance.
    function _checkProfitAfterPull(ArbPlan memory plan, uint256 pre, uint256 repay) internal {
        uint256 bal = IERC20(plan.borrowToken).balanceOf(address(this));
        if (bal < repay) revert ProfitFloor(0, repay);
        uint256 post = bal - repay;
        if (post < pre + plan.minProfit) revert ProfitFloor(post - pre, plan.minProfit);
        emit ArbSettled(plan.borrowToken, plan.borrowAmount, post - pre);
    }

    // ---------- WO-10 liquidation lane ----------

    struct LiqPlan {
        FlashSource source;
        address protocol;      // Aave V3 Pool (liquidationCall lives there)
        address user;          // borrower being liquidated
        address collateralAsset;
        address debtAsset;     // also the flash-borrowed token
        uint256 debtToCover;   // <= close-factor-max, computed off-chain per R5
        Hop[] hops;            // sells seized collateral -> debtAsset
        uint256 minProfit;     // post-repay profit floor in debtAsset units
    }

    /// Owner entry — flash-fund a liquidation, sell collateral, keep bonus.
    function liquidate(bytes calldata planBytes) external onlyOwner nonReentrant {
        LiqPlan memory lp = abi.decode(planBytes, (LiqPlan));
        if (lp.user == address(0) || lp.debtAsset == address(0) || lp.debtToCover == 0) revert BadPlan();
        _inFlash = true;
        _inLiq = true;
        if (lp.source == FlashSource.BALANCER) {
            if (balancerVault == address(0)) revert VenueUnset(lp.source);
            address[] memory t = new address[](1);
            uint256[] memory a = new uint256[](1);
            t[0] = lp.debtAsset; a[0] = lp.debtToCover;
            IBalancerVault(balancerVault).flashLoan(address(this), t, a, planBytes);
        } else if (lp.source == FlashSource.MORPHO) {
            if (morpho == address(0)) revert VenueUnset(lp.source);
            IMorphoFlash(morpho).flashLoan(lp.debtAsset, lp.debtToCover, planBytes);
        } else if (lp.source == FlashSource.ERC3156) {
            if (erc3156Lender == address(0)) revert VenueUnset(lp.source);
            IERC3156FlashLender(erc3156Lender).flashLoan(
                IERC3156FlashBorrower(address(this)), lp.debtAsset, lp.debtToCover, planBytes);
        } else {
            if (aavePool == address(0)) revert VenueUnset(lp.source);
            IAavePool(aavePool).flashLoanSimple(address(this), lp.debtAsset, lp.debtToCover, planBytes, 0);
        }
        _inFlash = false; _inLiq = false;
    }

    bool private _inLiq;

    /// Runs inside every flash callback (liquidate path): liquidationCall
    /// seizes collateral at the protocol bonus, hops sell it back to the
    /// debt asset, repay+profit accounting follows the arb path exactly.
    function _runLiq(LiqPlan memory lp) internal {
        IERC20(lp.debtAsset).forceApprove(lp.protocol, lp.debtToCover);
        IAavePool(lp.protocol).liquidationCall(lp.collateralAsset, lp.debtAsset, lp.user, lp.debtToCover, false);
        ArbPlan memory fake;
        fake.borrowToken = lp.debtAsset;
        fake.hops = lp.hops;
        fake.minOut = 0;
        fake.minProfit = lp.minProfit;
        _runHops(fake);
    }

    function _checkLiqProfit(LiqPlan memory lp, uint256 pre) internal {
        uint256 post = IERC20(lp.debtAsset).balanceOf(address(this));
        if (post < pre + lp.minProfit) revert ProfitFloor(post - pre, lp.minProfit);
        emit LiquidationSettled(lp.protocol, lp.user, post - pre);
    }
    function _checkLiqProfitPull(LiqPlan memory lp, uint256 pre, uint256 repay) internal {
        uint256 bal = IERC20(lp.debtAsset).balanceOf(address(this));
        if (bal < repay) revert ProfitFloor(0, repay);
        uint256 post = bal - repay;
        if (post < pre + lp.minProfit) revert ProfitFloor(post - pre, lp.minProfit);
        emit LiquidationSettled(lp.protocol, lp.user, post - pre);
    }

    /// @notice Profit sweep to PROFIT_WALLET (owner decides recipient).
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }

    function sweepEth(address payable to) external onlyOwner {
        to.transfer(address(this).balance);
    }

    receive() external payable {}
}
