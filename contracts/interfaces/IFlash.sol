// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Item #5 — Balancer V2 Vault (primary engine, 0% fee on most pools).
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
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

/// Item #6 — Aave V3 (fallback engine, 0.09% fee).
interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/// Morpho Blue — 0% fee flash loan. Lender transfers assets, invokes
/// onMorphoFlashLoan on the initiator, then pulls repay via allowance.
interface IMorphoFlash {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IMorphoFlashCallback {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}

/// ERC-3156 standard — MakerDAO DssFlash is the 0% fee instance
/// (DAI only, ~500M ceiling). flashFee is read live; currently zero.
interface IERC3156FlashBorrower {
    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external returns (bytes32);
}

interface IERC3156FlashLender {
    function flashLoan(
        IERC3156FlashBorrower receiver,
        address token,
        uint256 amount,
        bytes calldata data
    ) external returns (bool);
}
